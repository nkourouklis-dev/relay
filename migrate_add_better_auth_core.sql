-- Phase 1B: Better Auth 1.7.1 core schema for the configured relay_* models.
-- Source: getSchema({ user/session/account/verification modelName, magicLink })
-- from node_modules/better-auth@1.7.1/dist/db/get-schema.mjs.
-- Dates use TEXT because the D1/Kysely adapter serializes Date values as ISO-8601 strings.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS relay_users (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  email         TEXT NOT NULL UNIQUE,
  emailVerified INTEGER NOT NULL DEFAULT 0,
  image         TEXT,
  createdAt     TEXT NOT NULL,
  updatedAt     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS relay_sessions (
  id        TEXT PRIMARY KEY,
  expiresAt TEXT NOT NULL,
  token     TEXT NOT NULL UNIQUE,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  ipAddress TEXT,
  userAgent TEXT,
  userId    TEXT NOT NULL REFERENCES relay_users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS relay_accounts (
  id                     TEXT PRIMARY KEY,
  issuer                 TEXT NOT NULL,
  accountId              TEXT NOT NULL,
  providerId             TEXT NOT NULL,
  userId                 TEXT NOT NULL REFERENCES relay_users(id) ON DELETE CASCADE,
  accessToken            TEXT,
  refreshToken           TEXT,
  idToken                TEXT,
  accessTokenExpiresAt   TEXT,
  refreshTokenExpiresAt  TEXT,
  scope                  TEXT,
  password               TEXT,
  createdAt              TEXT NOT NULL,
  updatedAt              TEXT NOT NULL,
  UNIQUE (issuer, accountId)
);

CREATE TABLE IF NOT EXISTS relay_verifications (
  id         TEXT PRIMARY KEY,
  identifier TEXT NOT NULL,
  value      TEXT NOT NULL,
  expiresAt  TEXT NOT NULL,
  createdAt  TEXT NOT NULL,
  updatedAt  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS relay_sessions_userId_idx ON relay_sessions(userId);
CREATE INDEX IF NOT EXISTS relay_accounts_userId_idx ON relay_accounts(userId);
CREATE INDEX IF NOT EXISTS relay_verifications_identifier_idx ON relay_verifications(identifier);