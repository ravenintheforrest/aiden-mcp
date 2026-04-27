import { FellowClient, FellowApiError } from "./fellow-api.js";
import { Env, getAccessToken } from "./oauth/kv.js";

/**
 * Per-request auth for the /mcp resource endpoint.
 *
 * Three credential paths supported, in priority order:
 *
 *   1. Authorization: Bearer <oauth-access-token>
 *      — issued by our own /oauth/token endpoint after the user signed in
 *        via /oauth/authorize. The access token maps to a Fellow JWT in KV.
 *        This is what Claude.ai web and Claude iOS use.
 *
 *   2. X-Fellow-Email / X-Fellow-Password headers
 *      — direct credential pass-through. Used by Claude Desktop with
 *        custom-headers config and by curl tests. Not used by web Claude.
 *
 *   3. Authorization: Basic base64(email:password)
 *      — same idea as (2) but in standard HTTP Basic format. Some clients
 *        prefer this.
 *
 * Credentials are NEVER persisted from path 2 or 3 — they live only inside
 * the FellowClient instance for the duration of one MCP request.
 */
export async function clientFromHeaders(headers: Headers, env: Env): Promise<FellowClient> {
  // 1. Try Bearer token (the OAuth path)
  const auth = headers.get("Authorization") ?? headers.get("authorization");
  if (auth?.startsWith("Bearer ")) {
    const token = auth.slice(7).trim();
    const record = await getAccessToken(env, token);
    if (record) {
      return FellowClient.fromJwt(record.fellow_jwt);
    }
    // Bearer token present but not valid — we want a 401 with WWW-Authenticate
    // so the client knows to re-do the OAuth flow.
    throw new FellowApiError(
      "Access token invalid or expired. Re-authenticate via the OAuth flow.",
      401,
    );
  }

  // 2. Try X-Fellow-* headers
  let email = headers.get("X-Fellow-Email") ?? headers.get("x-fellow-email");
  let password = headers.get("X-Fellow-Password") ?? headers.get("x-fellow-password");

  // 3. Try Authorization: Basic
  if (!email || !password) {
    if (auth?.startsWith("Basic ")) {
      try {
        const decoded = atob(auth.slice(6).trim());
        const colon = decoded.indexOf(":");
        if (colon > 0) {
          email = decoded.slice(0, colon);
          password = decoded.slice(colon + 1);
        }
      } catch {
        // base64 decode failed
      }
    }
  }

  if (!email || !password) {
    throw new FellowApiError(
      "No credentials. Use OAuth (recommended for Claude.ai), or send X-Fellow-Email + X-Fellow-Password headers.",
      401,
    );
  }
  const client = new FellowClient(email, password);
  await client.authenticate();
  return client;
}
