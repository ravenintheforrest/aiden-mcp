import { FellowClient, FellowApiError } from "./fellow-api.js";

/**
 * Per-request auth: pull Fellow credentials from request headers.
 *
 * Two header conventions accepted (clients vary):
 *   - X-Fellow-Email / X-Fellow-Password
 *   - x-fellow-email / x-fellow-password (lowercase, some clients normalize)
 *
 * Credentials are NEVER persisted, NEVER logged. They live only inside
 * the FellowClient instance for the duration of one MCP request.
 */
export function clientFromHeaders(headers: Headers): FellowClient {
  const email =
    headers.get("X-Fellow-Email") ??
    headers.get("x-fellow-email") ??
    headers.get("X-Fellow-Email".toLowerCase());
  const password =
    headers.get("X-Fellow-Password") ??
    headers.get("x-fellow-password");

  if (!email || !password) {
    throw new FellowApiError(
      "Missing Fellow credentials. Add X-Fellow-Email and X-Fellow-Password headers in your MCP client config.",
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
