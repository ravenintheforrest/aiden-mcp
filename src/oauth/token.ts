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

  // Issue access token
  const access_token = generateRandomToken(32);
  const now = Date.now();
  const expires_in_seconds = 3600;
  await putAccessToken(env, access_token, {
    client_id,
    fellow_jwt: codeRecord.fellow_jwt,
    fellow_email_hash: codeRecord.fellow_email_hash,
    scope: codeRecord.scope,
    created_at: now,
    expires_at: now + expires_in_seconds * 1000,
  });

  return Response.json(
    {
      access_token,
      token_type: "Bearer",
      expires_in: expires_in_seconds,
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
