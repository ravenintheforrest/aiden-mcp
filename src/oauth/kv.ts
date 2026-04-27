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
  scope?: string;
  fellow_email_hash: string;
  created_at: number;
  expires_at: number;
}

const TOKEN_TTL_SECONDS = 60 * 60; // 1 hour — matches typical Fellow JWT lifetime

export async function putAccessToken(
  env: Env,
  token: string,
  record: AccessTokenRecord,
): Promise<void> {
  await env.AIDEN_OAUTH.put(`token:${token}`, JSON.stringify(record), {
    expirationTtl: TOKEN_TTL_SECONDS,
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
// Refresh token (longer-lived, exchanges for fresh access token by re-auth)
// ============================================================
//
// We do NOT support refresh tokens in v1: when an access token expires,
// the user re-authenticates via the standard authorize flow. This avoids
// having to persist Fellow credentials anywhere — even encrypted.
//
// If we add refresh later, the right model is: refresh tokens carry a
// reference that lets us call Fellow's own refresh endpoint, not ours.

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
