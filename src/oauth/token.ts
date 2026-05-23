/**
 * Token endpoint (RFC 6749 §3.2).
 *
 * Two grants:
 *   - authorization_code (+ PKCE): exchange a code for access + refresh tokens.
 *   - refresh_token: exchange our refresh token for a fresh access token.
 *     We use Fellow's own refresh token (stored, never the password) to mint a
 *     new Fellow JWT via POST /auth/refresh-token. This makes re-auth seamless:
 *     Claude refreshes silently in the background.
 */

import {
  Env,
  consumeAuthCode,
  putAccessToken,
  putRefreshToken,
  getRefreshToken,
  deleteRefreshToken,
  generateRandomToken,
  base64UrlEncode,
} from "./kv.js";
import { FellowClient } from "../fellow-api.js";

// Access tokens are capped at 30 days but in practice track the Fellow JWT,
// which lives only ~15 minutes — so Claude refreshes roughly every 15 min via
// the refresh grant. That's invisible to the user once refresh tokens work.
const MAX_TTL_SEC = 60 * 60 * 24 * 30; // 30 days cap
const FALLBACK_TTL_SEC = 60 * 60 * 24; // 24h if JWT exp not parseable

export async function handleToken(request: Request, env: Env): Promise<Response> {
  const ct = request.headers.get("Content-Type") ?? "";
  if (!ct.includes("application/x-www-form-urlencoded")) {
    return jsonError("invalid_request", "Token endpoint expects application/x-www-form-urlencoded", 400);
  }

  const body = await request.formData();
  const grant_type = body.get("grant_type")?.toString();

  if (grant_type === "authorization_code") {
    return handleAuthCodeGrant(body, env);
  }
  if (grant_type === "refresh_token") {
    return handleRefreshGrant(body, env);
  }
  return jsonError("unsupported_grant_type", "Supported grants: authorization_code, refresh_token", 400);
}

// ============================================================
// authorization_code grant
// ============================================================
async function handleAuthCodeGrant(body: FormData, env: Env): Promise<Response> {
  const code = body.get("code")?.toString();
  const redirect_uri = body.get("redirect_uri")?.toString();
  const client_id = body.get("client_id")?.toString();
  const code_verifier = body.get("code_verifier")?.toString();

  if (!code || !redirect_uri || !client_id || !code_verifier) {
    return jsonError(
      "invalid_request",
      "code, redirect_uri, client_id, and code_verifier are all required",
      400,
    );
  }

  const codeRecord = await consumeAuthCode(env, code);
  if (!codeRecord) {
    return jsonError("invalid_grant", "Authorization code is invalid, expired, or already used", 400);
  }
  if (codeRecord.client_id !== client_id) {
    return jsonError("invalid_grant", "Authorization code was issued to a different client", 400);
  }
  if (codeRecord.redirect_uri !== redirect_uri) {
    return jsonError("invalid_grant", "redirect_uri does not match the one used at authorization", 400);
  }

  const challengeFromVerifier = await s256(code_verifier);
  if (challengeFromVerifier !== codeRecord.code_challenge) {
    return jsonError("invalid_grant", "PKCE verifier does not match the code_challenge", 400);
  }

  return issueTokens(env, {
    client_id,
    fellow_jwt: codeRecord.fellow_jwt,
    fellow_refresh: codeRecord.fellow_refresh,
    fellow_email_hash: codeRecord.fellow_email_hash,
    scope: codeRecord.scope,
  });
}

// ============================================================
// refresh_token grant
// ============================================================
async function handleRefreshGrant(body: FormData, env: Env): Promise<Response> {
  const refresh_token = body.get("refresh_token")?.toString();
  const client_id = body.get("client_id")?.toString();

  if (!refresh_token) {
    return jsonError("invalid_request", "refresh_token is required", 400);
  }

  const record = await getRefreshToken(env, refresh_token);
  if (!record) {
    return jsonError("invalid_grant", "Refresh token is invalid or expired. Re-authorize.", 400);
  }
  if (client_id && record.client_id !== client_id) {
    return jsonError("invalid_grant", "Refresh token was issued to a different client", 400);
  }

  // Use the stored (expired) access JWT + Fellow's refresh token to mint a fresh JWT
  let fresh;
  try {
    console.log("Refresh grant: calling Fellow /auth/refresh-token");
    fresh = await FellowClient.refresh(record.fellow_jwt, record.fellow_refresh);
    console.log("Refresh grant: SUCCESS — new Fellow JWT issued");
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown";
    console.log("Refresh grant: FAILED —", msg);
    // Fellow rejected the refresh — it's dead. Drop ours and force re-auth.
    await deleteRefreshToken(env, refresh_token);
    return jsonError("invalid_grant", "Fellow session expired. Re-authorize.", 400);
  }

  // Rotate our refresh token; clean up the old one
  await deleteRefreshToken(env, refresh_token);

  return issueTokens(env, {
    client_id: record.client_id,
    fellow_jwt: fresh.accessToken,
    fellow_refresh: fresh.refreshToken,
    fellow_email_hash: record.fellow_email_hash,
    scope: undefined,
  });
}

// ============================================================
// Shared token issuance
// ============================================================
async function issueTokens(
  env: Env,
  params: {
    client_id: string;
    fellow_jwt: string;
    fellow_refresh?: string;
    fellow_email_hash: string;
    scope?: string;
  },
): Promise<Response> {
  const access_token = generateRandomToken(32);
  const now = Date.now();

  const jwtExp = FellowClient.jwtExpiry(params.fellow_jwt);
  const ttlSec = jwtExp
    ? Math.max(60, Math.min(MAX_TTL_SEC, jwtExp - Math.floor(now / 1000)))
    : FALLBACK_TTL_SEC;

  await putAccessToken(env, access_token, {
    client_id: params.client_id,
    fellow_jwt: params.fellow_jwt,
    fellow_refresh: params.fellow_refresh,
    fellow_email_hash: params.fellow_email_hash,
    scope: params.scope,
    created_at: now,
    expires_at: now + ttlSec * 1000,
  });

  const response: Record<string, unknown> = {
    access_token,
    token_type: "Bearer",
    expires_in: ttlSec,
    scope: params.scope,
  };

  // Only issue a refresh token if we have a Fellow refresh token to back it.
  if (params.fellow_refresh) {
    const refresh_token = generateRandomToken(32);
    await putRefreshToken(env, refresh_token, {
      client_id: params.client_id,
      fellow_refresh: params.fellow_refresh,
      fellow_jwt: params.fellow_jwt, // carry the access JWT for the next refresh's Authorization header
      fellow_email_hash: params.fellow_email_hash,
      created_at: now,
    });
    response.refresh_token = refresh_token;
  }

  return Response.json(response, {
    status: 200,
    headers: { "Cache-Control": "no-store", Pragma: "no-cache" },
  });
}

async function s256(verifier: string): Promise<string> {
  const buf = new TextEncoder().encode(verifier);
  const hash = await crypto.subtle.digest("SHA-256", buf);
  return base64UrlEncode(new Uint8Array(hash));
}

function jsonError(error: string, error_description: string, status = 400): Response {
  return Response.json(
    { error, error_description },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}
