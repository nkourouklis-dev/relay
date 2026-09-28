import {
  createMcpHandler,
  McpServer,
  OAuthError,
  OAuthErrorCode,
  requireBearerAuth,
} from "@modelcontextprotocol/server";
import { createRemoteJWKSet, jwtVerify } from "jose";
import * as z from "zod/v4";

const MCP_SCOPE = "relay.access";
const jwksByTenant = new Map();
const mcpRateBuckets = new Map();
const MCP_IP_RATE_LIMIT = { limit: 60, windowMs: 60 * 1000 };
const MCP_ACTOR_RATE_LIMIT = { limit: 120, windowMs: 60 * 1000 };

function getJwks(tenantId) {
  if (!jwksByTenant.has(tenantId)) {
    jwksByTenant.set(
      tenantId,
      createRemoteJWKSet(new URL(`https://login.microsoftonline.com/${tenantId}/discovery/v2.0/keys`))
    );
  }
  return jwksByTenant.get(tenantId);
}

function emailFromClaims(payload) {
  for (const claim of [payload.email, payload.preferred_username, payload.upn]) {
    if (typeof claim === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(claim)) {
      return claim.trim().toLowerCase();
    }
  }
  return "";
}

function publicMcpOrigin(env, request) {
  if (env.BETTER_AUTH_URL) return new URL(env.BETTER_AUTH_URL).origin;
  return new URL(request.url).origin;
}

function validateRequestOrigin(request, env) {
  const expectedOrigin = publicMcpOrigin(env, request);
  const expectedHost = new URL(expectedOrigin).host;
  const localHost = ["localhost", "127.0.0.1"].includes(new URL(request.url).hostname);
  const requestHost = request.headers.get("host");

  if (!localHost && requestHost !== expectedHost) {
    return new Response("Invalid Host header", { status: 403 });
  }

  const origin = request.headers.get("origin");
  if (origin && origin !== expectedOrigin && !(localHost && origin === `http://${requestHost}`)) {
    return new Response("Invalid Origin header", { status: 403 });
  }
  return null;
}

function rateLimitKey(request) {
  return request.headers.get("cf-connecting-ip") ||
    request.headers.get("x-forwarded-for")?.split(",", 1)[0].trim() ||
    "unknown";
}

function consumeRateLimit(key, { limit, windowMs }) {
  const now = Date.now();
  const cutoff = now - windowMs;
  const recent = (mcpRateBuckets.get(key) || []).filter((timestamp) => timestamp > cutoff);
  if (recent.length >= limit) {
    mcpRateBuckets.set(key, recent);
    return Math.max(1, Math.ceil((recent[0] + windowMs - now) / 1000));
  }

  recent.push(now);
  mcpRateBuckets.set(key, recent);
  if (mcpRateBuckets.size > 10000) {
    for (const [bucketKey, timestamps] of mcpRateBuckets) {
      if (!timestamps.some((timestamp) => timestamp > cutoff)) mcpRateBuckets.delete(bucketKey);
    }
  }
  return 0;
}

function rateLimitResponse(retryAfter) {
  return Response.json(
    { error: "Too many MCP requests. Try again later." },
    { status: 429, headers: { "retry-after": String(retryAfter) } }
  );
}

function textResult(value, isError = false) {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    structuredContent: value,
    ...(isError ? { isError: true } : {}),
  };
}

async function runTool(callback) {
  try {
    return textResult(await callback());
  } catch (error) {
    return textResult({ error: error instanceof Error ? error.message : String(error) }, true);
  }
}

function createRelayMcpServer(actor, operations) {
  const server = new McpServer({ name: "kafkas-relay", version: "1.0.0" });

  server.registerTool(
    "relay_list_projects",
    {
      title: "List Relay projects",
      description: "List only projects the signed-in Relay user can access.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    () => runTool(() => operations.listProjects(actor))
  );

  server.registerTool(
    "relay_list_asks",
    {
      title: "List project asks",
      description: "List asks in a project the signed-in Relay user can access. Optionally filter by status.",
      inputSchema: z.object({
        projectId: z.string().min(1),
        status: z.enum(["open", "accepted", "done", "overdue"]).optional(),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ projectId, status }) => runTool(() => operations.listAsks(actor, projectId, status))
  );

  server.registerTool(
    "relay_preview_capture",
    {
      title: "Preview asks from text or a meeting transcript",
      description: "Extract candidate asks and return a draft for review. Does not create or assign tasks and does not save the full source text.",
      inputSchema: z.object({
        projectId: z.string().min(1),
        sourceText: z.string().min(1).max(100000),
        sourceTitle: z.string().max(240).optional(),
        sourceUrl: z.string().url().max(2000).optional(),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    ({ projectId, sourceText, sourceTitle, sourceUrl }) =>
      runTool(() => operations.previewCapture(actor, { projectId, sourceText, sourceTitle, sourceUrl }))
  );

  server.registerTool(
    "relay_commit_capture",
    {
      title: "Create reviewed asks in Relay",
      description: "Create only a draft that the same user has approved on the authenticated Relay review page. Never claim approval based only on model interpretation of the conversation.",
      inputSchema: z.object({
        draftId: z.string().uuid(),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    ({ draftId }) => runTool(() => operations.commitCapture(actor, { draftId }))
  );

  server.registerTool(
    "relay_update_capture_draft",
    {
      title: "Set proposed owners and dates",
      description: "Save proposed assignments for a pending preview. This does not create tasks; return the Relay approval link for the user to review and approve.",
      inputSchema: z.object({
        draftId: z.string().uuid(),
        assignments: z.array(z.object({
          index: z.number().int().min(0).max(99),
          ownerEmail: z.string().email().nullable().optional(),
          dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
        })).min(1).max(100),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    ({ draftId, assignments }) =>
      runTool(() => operations.updateCaptureDraft(actor, { draftId, assignments }))
  );

  return server;
}

export async function handleRelayMcpRequest(request, env, operations) {
  const originError = validateRequestOrigin(request, env);
  if (originError) return originError;

  const tenantId = String(env.ENTRA_TENANT_ID || "").trim().toLowerCase();
  const audience = String(env.ENTRA_API_AUDIENCE || "").trim();
  const allowedClientIds = String(env.ENTRA_ALLOWED_CLIENT_IDS || "")
    .split(",").map((value) => value.trim().toLowerCase()).filter(Boolean);
  if (!tenantId || !audience || !allowedClientIds.length) {
    return Response.json({ error: "Microsoft Entra MCP authentication is not configured." }, { status: 503 });
  }

  const ipRetryAfter = consumeRateLimit(`ip:${rateLimitKey(request)}`, MCP_IP_RATE_LIMIT);
  if (ipRetryAfter) return rateLimitResponse(ipRetryAfter);

  const publicOrigin = publicMcpOrigin(env, request);
  const resource = `${publicOrigin}/mcp`;
  const resourceMetadataUrl = `${publicOrigin}/.well-known/oauth-protected-resource/mcp`;
  const verifier = {
    async verifyAccessToken(token) {
      try {
        const issuer = `https://login.microsoftonline.com/${tenantId}/v2.0`;
        const { payload } = await jwtVerify(token, getJwks(tenantId), {
          issuer,
          audience,
          algorithms: ["RS256"],
        });
        if (String(payload.tid || "").toLowerCase() !== tenantId.toLowerCase() ||
            typeof payload.oid !== "string" ||
            !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(payload.oid)) {
          throw new Error("Token tenant or user identity is invalid.");
        }
        const clientId = String(payload.azp || "").toLowerCase();
        if (!allowedClientIds.includes(clientId)) throw new Error("Token client is not allowed.");
        const email = emailFromClaims(payload);
        if (!email) throw new Error("Token does not contain a usable email claim.");
        const scopes = typeof payload.scp === "string" ? payload.scp.split(/\s+/).filter(Boolean) : [];
        return {
          token,
          clientId,
          scopes,
          expiresAt: payload.exp,
          resource,
          extra: {
            email,
            name: typeof payload.name === "string" ? payload.name : "",
            tenantId,
            objectId: payload.oid,
          },
        };
      } catch {
        throw new OAuthError(OAuthErrorCode.InvalidToken, "Invalid Microsoft Entra access token");
      }
    },
  };

  const gate = requireBearerAuth({ verifier, requiredScopes: [MCP_SCOPE], resourceMetadataUrl });
  const authInfo = await gate(request);
  if (authInfo instanceof Response) return authInfo;

  const actorKey = authInfo.extra?.objectId && authInfo.clientId
    ? `${authInfo.extra.tenantId}:${authInfo.extra.objectId}:${authInfo.clientId}`
    : "unknown";
  const actorRetryAfter = consumeRateLimit(`actor:${actorKey}`, MCP_ACTOR_RATE_LIMIT);
  if (actorRetryAfter) return rateLimitResponse(actorRetryAfter);

  const email = authInfo.extra?.email;
  const actor = await operations.resolveActor(
    email,
    authInfo.extra?.name || "",
    authInfo.extra?.tenantId,
    authInfo.extra?.objectId
  );
  if (!actor) return Response.json({ error: "This Microsoft account is not enabled for Relay." }, { status: 403 });

  const handler = createMcpHandler(() => createRelayMcpServer(actor, operations), { legacy: "stateless" });
  return handler.fetch(request, { authInfo });
}

export function relayOAuthMetadata(env, request) {
  const tenantId = String(env.ENTRA_TENANT_ID || "").trim();
  const audience = String(env.ENTRA_API_AUDIENCE || "").trim();
  if (!tenantId || !audience) {
    return Response.json({ error: "Microsoft Entra MCP authentication is not configured." }, { status: 503 });
  }

  const origin = publicMcpOrigin(env, request);
  return Response.json({
    resource: `${origin}/mcp`,
    authorization_servers: [`https://login.microsoftonline.com/${tenantId}/v2.0`],
    scopes_supported: [MCP_SCOPE],
    bearer_methods_supported: ["header"],
    resource_documentation: "https://learn.microsoft.com/en-us/microsoft-copilot-studio/mcp-add-existing-server-to-agent",
  }, { headers: { "cache-control": "public, max-age=300" } });
}