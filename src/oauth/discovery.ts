/**
 * OAuth 2.0 / RFC 9728 / RFC 8414 discovery endpoints.
 *
 * MCP clients (including Claude) probe these to learn how to authenticate
 * before initiating the authorization flow.
 */

export function protectedResourceMetadata(origin: string): Response {
  return Response.json({
    resource: origin,
    authorization_servers: [origin],
    bearer_methods_supported: ["header"],
    resource_documentation: `${origin}/`,
  });
}

export function authorizationServerMetadata(origin: string): Response {
  return Response.json({
    issuer: origin,
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/oauth/token`,
    registration_endpoint: `${origin}/oauth/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_basic"],
    scopes_supported: ["aiden"],
    service_documentation: `${origin}/`,
  });
}
