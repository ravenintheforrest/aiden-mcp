import { FellowClient, FellowApiError } from "./fellow-api.js";

/**
 * Per-request auth: pull Fellow credentials from headers.
 *
 * Three conventions accepted (different MCP clients use different ones):
 *
 *   1. X-Fellow-Email / X-Fellow-Password
 *      — explicit, used when the client config supports custom headers
 *
 *   2. Authorization: Basic base64(email:password)
 *      — what Claude Desktop's "Custom Connector" UI sends when you fill in
 *        username + password fields. Standard HTTP Basic Auth.
 *
 *   3. Authorization: Bearer email:password
 *      — fallback some clients send when treating password as a token
 *
 * Credentials are NEVER persisted, NEVER logged. They live only inside
 * the FellowClient instance for the duration of one MCP request.
 */
export function clientFromHeaders(headers: Headers): FellowClient {
  // 1. Try explicit X-Fellow-* headers
  let email = headers.get("X-Fellow-Email") ?? headers.get("x-fellow-email");
  let password = headers.get("X-Fellow-Password") ?? headers.get("x-fellow-password");

  // 2. Try Authorization: Basic ...
  if (!email || !password) {
    const auth = headers.get("Authorization") ?? headers.get("authorization");
    if (auth?.startsWith("Basic ")) {
      try {
        const decoded = atob(auth.slice(6).trim());
        const colon = decoded.indexOf(":");
        if (colon > 0) {
          email = decoded.slice(0, colon);
          password = decoded.slice(colon + 1);
        }
      } catch {
        // base64 decode failed — fall through
      }
    } else if (auth?.startsWith("Bearer ")) {
      // Some clients send "Bearer email:password" as a fallback
      const token = auth.slice(7).trim();
      const colon = token.indexOf(":");
      if (colon > 0) {
        email = token.slice(0, colon);
        password = token.slice(colon + 1);
      }
    }
  }

  if (!email || !password) {
    throw new FellowApiError(
      "Missing Fellow credentials. Send them either as X-Fellow-Email + X-Fellow-Password headers, or as HTTP Basic Auth (username = Fellow email, password = Fellow password).",
      401,
    );
  }
  return new FellowClient(email, password);
}

/**
 * Wrap a tool handler so credential errors come back as MCP-friendly text
 * rather than uncaught exceptions.
 */
export function withAuth<T>(
  handler: (client: FellowClient) => Promise<T>,
): (headers: Headers) => Promise<T> {
  return async (headers: Headers) => {
    const client = clientFromHeaders(headers);
    await client.authenticate();
    return handler(client);
  };
}
