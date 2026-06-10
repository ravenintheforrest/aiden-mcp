/**
 * KV storage helpers for OAuth state.
 *
 * Three categories of records, each with appropriate TTLs:
 *   client:<client_id>   → registered client metadata (90 days)
 *   code:<code>          → auth-code state pre-token-exchange (10 minutes)
 *   token:<access_token> → access-token state with Fellow JWT (1 hour)
 *
 * IMPORTANT: We never store Fellow passwords. Only the JWT Fellow itself
 * issues after we successfully authenticate the user is persisted, and
 * only for the lifetime of the access token.
 */

export interface Env {
  AIDEN_OAUTH: KVNamespace;
  /**
   * API-drift canary (all optional — see src/canary.ts). These are the
   * MAINTAINER's own dedicated Fellow account, set via `wrangler secret put`,
   * never a user credential.
   */
  CANARY_FELLOW_EMAIL?: string;
  CANARY_FELLOW_PASSWORD?: string;
  CANARY_WEBHOOK_URL?: string;
  CANARY_WRITE?: string;
}

// ============================================================
// Client (registered MCP clients — Claude registers itself)
// ============================================================

export interface ClientRecord {
  client_id: string;
  client_name?: string;
  redirect_uris: string[];
  token_endpoint_auth_method: string;
  created_at: number;
}

const CLIENT_TTL_SECONDS = 60 * 60 * 24 * 90; // 90 days

export async function putClient(env: Env, client: ClientRecord): Promise<void> {
  await env.AIDEN_OAUTH.put(`client:${client.client_id}`, JSON.stringify(client), {
    expirationTtl: CLIENT_TTL_SECONDS,
  });
}

export async function getClient(env: Env, clientId: string): Promise<ClientRecord | null> {
  const raw = await env.AIDEN_OAUTH.get(`client:${clientId}`);
  return raw ? (JSON.parse(raw) as ClientRecord) : null;
}

// ============================================================
// Auth code (short-lived, exchanged for access token)
// ============================================================

export interface AuthCodeRecord {
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  code_challenge_method: "S256";
  scope?: string;
  fellow_jwt: string;
  fellow_refresh?: string; // Fellow's own refresh token, if it issued one
  fellow_email_hash: string; // sha256(email) — for support/debugging only, never the email itself
  created_at: number;
}

const CODE_TTL_SECONDS = 600; // 10 minutes

export async function putAuthCode(env: Env, code: string, record: AuthCodeRecord): Promise<void> {
  await env.AIDEN_OAUTH.put(`code:${code}`, JSON.stringify(record), {
    expirationTtl: CODE_TTL_SECONDS,
  });
}

export async function consumeAuthCode(env: Env, code: string): Promise<AuthCodeRecord | null> {
  const key = `code:${code}`;
  const raw = await env.AIDEN_OAUTH.get(key);
  if (!raw) return null;
  // Single-use: delete on read
  await env.AIDEN_OAUTH.delete(key);
  return JSON.parse(raw) as AuthCodeRecord;
}

// ============================================================
// Access token (carries Fellow JWT for use against Fellow API)
// ============================================================

export interface AccessTokenRecord {
  client_id: string;
  fellow_jwt: string;
  fellow_refresh?: string;
  scope?: string;
  fellow_email_hash: string;
  created_at: number;
  expires_at: number;
}

// Long default — coffee profiles aren't a security-sensitive resource.
// Capped here; the actual TTL used is min(this, Fellow JWT exp), so we
// never outlive the Fellow JWT inside the access token.
const MAX_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days
const MIN_TOKEN_TTL_SECONDS = 60; // KV minimum

export async function putAccessToken(
  env: Env,
  token: string,
  record: AccessTokenRecord,
): Promise<void> {
  const remainingMs = record.expires_at - Date.now();
  const remainingSec = Math.floor(remainingMs / 1000);
  const ttl = Math.max(
    MIN_TOKEN_TTL_SECONDS,
    Math.min(MAX_TOKEN_TTL_SECONDS, remainingSec),
  );
  await env.AIDEN_OAUTH.put(`token:${token}`, JSON.stringify(record), {
    expirationTtl: ttl,
  });
}

export async function getAccessToken(env: Env, token: string): Promise<AccessTokenRecord | null> {
  const raw = await env.AIDEN_OAUTH.get(`token:${token}`);
  if (!raw) return null;
  const record = JSON.parse(raw) as AccessTokenRecord;
  if (record.expires_at < Date.now()) {
    await env.AIDEN_OAUTH.delete(`token:${token}`);
    return null;
  }
  return record;
}

// ============================================================
// Refresh token
// ============================================================
//
// Carries Fellow's OWN refresh token, not the user's password. When Claude's
// access token expires, it presents our refresh token; we exchange Fellow's
// refresh token for a new Fellow JWT (via POST /auth/refresh-token) and mint a
// new access token. The user re-authorizes only when Fellow's refresh token
// itself expires or they change their Fellow password. No credentials stored.

export interface RefreshTokenRecord {
  client_id: string;
  fellow_refresh: string; // Fellow's refresh token (stable — Fellow doesn't rotate it)
  fellow_jwt: string; // last access JWT — needed in the Authorization header to refresh
  fellow_email_hash: string;
  created_at: number;
}

const REFRESH_TTL_SECONDS = 60 * 60 * 24 * 90; // 90 days

export async function putRefreshToken(
  env: Env,
  token: string,
  record: RefreshTokenRecord,
): Promise<void> {
  await env.AIDEN_OAUTH.put(`refresh:${token}`, JSON.stringify(record), {
    expirationTtl: REFRESH_TTL_SECONDS,
  });
}

export async function getRefreshToken(env: Env, token: string): Promise<RefreshTokenRecord | null> {
  const raw = await env.AIDEN_OAUTH.get(`refresh:${token}`);
  return raw ? (JSON.parse(raw) as RefreshTokenRecord) : null;
}

export async function deleteRefreshToken(env: Env, token: string): Promise<void> {
  await env.AIDEN_OAUTH.delete(`refresh:${token}`);
}

// ============================================================
// Crypto helpers
// ============================================================

export async function sha256Hex(input: string): Promise<string> {
  const buf = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function generateRandomToken(bytes = 32): string {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return base64UrlEncode(arr);
}

export function base64UrlEncode(arr: Uint8Array): string {
  const b64 = btoa(String.fromCharCode(...arr));
  return b64.replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
