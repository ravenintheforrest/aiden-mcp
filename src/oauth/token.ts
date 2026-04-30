/**
 * Token endpoint (RFC 6749 §3.2).
 *
 * Exchanges an authorization code (plus PKCE verifier) for an access token.
 * The access token is an opaque random string; on the resource side we look
 * up the Fellow JWT it represents in KV.
 */

import {
  Env,
  consumeAuthCode,
  putAccessToken,
  generateRandomToken,
  base64UrlEncode,
} from "./kv.js";
import { FellowClient } from "../fellow-api.js";

export async function handleToken(request: Request, env: Env): Promise<Response> {
  const ct = request.headers.get("Content-Type") ?? "";
  if (!ct.includes("application/x-www-form-urlencoded")) {
    return jsonError("invalid_request", "Token endpoint expects application/x-www-form-urlencoded", 400);
  }

  const body = await request.formData();
  const grant_type = body.get("grant_type")?.toString();
  const code = body.get("code")?.toString();
  const redirect_uri = body.get("redirect_uri")?.toString();
  const client_id = body.get("client_id")?.toString();
  const code_verifier = body.get("code_verifier")?.toString();

  if (grant_type !== "authorization_code") {
    return jsonError("unsupported_grant_type", "Only authorization_code is supported", 400);
  }
  if (!code || !redirect_uri || !client_id || !code_verifier) {
    return jsonError(
      "invalid_request",
      "code, redirect_uri, client_id, and code_verifier are all required",
      400,
    );
  }

  // Single-use: consume the code (delete on read)
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

  // Verify PKCE
  const challengeFromVerifier = await s256(code_verifier);
  if (challengeFromVerifier !== codeRecord.code_challenge) {
    return jsonError("invalid_grant", "PKCE verifier does not match the code_challenge", 400);
  }

  // Issue access token. Lifetime tracks the Fellow JWT inside it, capped at
  // 30 days. If the JWT has no exp claim or it's far in the future, we still
  // cap to 30d so KV records eventually clean themselves up.
  const access_token = generateRandomToken(32);
  const now = Date.now();
  const MAX_TTL_SEC = 60 * 60 * 24 * 30; // 30 days
  const FALLBACK_TTL_SEC = 60 * 60 * 24; // 24h if JWT exp not parseable

  const jwtExp = FellowClient.jwtExpiry(codeRecord.fellow_jwt); // seconds-since-epoch or null
  let ttlSec: number;
  if (jwtExp) {
    const remaining = jwtExp - Math.floor(now / 1000);
    ttlSec = Math.max(60, Math.min(MAX_TTL_SEC, remaining));
  } else {
    ttlSec = FALLBACK_TTL_SEC;
  }

  await putAccessToken(env, access_token, {
    client_id,
    fellow_jwt: codeRecord.fellow_jwt,
    fellow_email_hash: codeRecord.fellow_email_hash,
    scope: codeRecord.scope,
    created_at: now,
    expires_at: now + ttlSec * 1000,
  });

  return Response.json(
    {
      access_token,
      token_type: "Bearer",
      expires_in: ttlSec,
      scope: codeRecord.scope,
    },
    {
      status: 200,
      headers: { "Cache-Control": "no-store", Pragma: "no-cache" },
    },
  );
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
