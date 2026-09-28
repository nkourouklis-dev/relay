import assert from "node:assert/strict";
import test from "node:test";
import { handleRelayMcpRequest } from "../src/relay-mcp.js";

const origin = "https://relay.example.com";
const configuredEnv = {
  BETTER_AUTH_URL: origin,
  ENTRA_TENANT_ID: "11111111-1111-4111-8111-111111111111",
  ENTRA_API_AUDIENCE: "22222222-2222-4222-8222-222222222222",
  ENTRA_ALLOWED_CLIENT_IDS: "33333333-3333-4333-8333-333333333333",
};

test("MCP endpoint fails closed when Entra configuration is missing", async () => {
  const response = await handleRelayMcpRequest(
    new Request(`${origin}/mcp`, { headers: { Host: "relay.example.com" } }),
    { BETTER_AUTH_URL: origin },
    {}
  );
  assert.equal(response.status, 503);
});

test("MCP endpoint requires a delegated bearer token", async () => {
  const response = await handleRelayMcpRequest(
    new Request(`${origin}/mcp`, { headers: { Host: "relay.example.com" } }),
    configuredEnv,
    {}
  );
  assert.equal(response.status, 401);
  assert.match(response.headers.get("www-authenticate") || "", /Bearer/);
});

test("MCP endpoint rejects foreign Origins and Hosts", async () => {
  const originResponse = await handleRelayMcpRequest(
    new Request(`${origin}/mcp`, { headers: { Host: "relay.example.com", Origin: "https://untrusted.example" } }),
    configuredEnv,
    {}
  );
  assert.equal(originResponse.status, 403);

  const hostResponse = await handleRelayMcpRequest(
    new Request("https://untrusted.example/mcp", { headers: { Host: "untrusted.example" } }),
    configuredEnv,
    {}
  );
  assert.equal(hostResponse.status, 403);
});