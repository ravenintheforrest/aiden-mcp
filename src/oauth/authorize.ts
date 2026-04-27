/**
 * Authorization endpoint (RFC 6749 §3.1).
 *
 * Two phases:
 *   GET  /oauth/authorize?... → renders sign-in form
 *   POST /oauth/authorize     → validates Fellow creds, issues auth code, redirects
 *
 * On the POST, the user's Fellow email + password reach the server exactly
 * once. We validate them against Fellow's API, get back a JWT, store the
 * JWT (NOT the password) keyed by an auth code, and redirect Claude with
 * that code. The password is never written to KV, never logged.
 */

import { FellowClient } from "../fellow-api.js";
import {
  Env,
  putAuthCode,
  getClient,
  generateRandomToken,
  sha256Hex,
} from "./kv.js";

interface AuthorizeQuery {
  response_type?: string;
  client_id?: string;
  redirect_uri?: string;
  scope?: string;
  state?: string;
  code_challenge?: string;
  code_challenge_method?: string;
}

function parseQuery(url: URL): AuthorizeQuery {
  const q: AuthorizeQuery = {};
  for (const [k, v] of url.searchParams) {
    (q as Record<string, string>)[k] = v;
  }
  return q;
}

async function validateAuthorizeRequest(
  q: AuthorizeQuery,
  env: Env,
): Promise<{ ok: true } | { ok: false; status: number; message: string }> {
  if (q.response_type !== "code") {
    return { ok: false, status: 400, message: "Only response_type=code is supported" };
  }
  if (!q.client_id) {
    return { ok: false, status: 400, message: "client_id is required" };
  }
  const client = await getClient(env, q.client_id);
  if (!client) {
    return { ok: false, status: 400, message: `Unknown client_id (register first): ${q.client_id}` };
  }
  if (!q.redirect_uri || !client.redirect_uris.includes(q.redirect_uri)) {
    return {
      ok: false,
      status: 400,
      message: "redirect_uri must match a registered URI for this client",
    };
  }
  if (!q.code_challenge || q.code_challenge_method !== "S256") {
    return {
      ok: false,
      status: 400,
      message: "PKCE required: code_challenge with code_challenge_method=S256",
    };
  }
  return { ok: true };
}

// ============================================================
// GET /oauth/authorize — render sign-in HTML
// ============================================================
export async function handleAuthorizeGet(url: URL, env: Env): Promise<Response> {
  const q = parseQuery(url);
  const validation = await validateAuthorizeRequest(q, env);
  if (!validation.ok) {
    return new Response(validation.message, { status: validation.status });
  }
  return new Response(renderSignInHtml(q), {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

// ============================================================
// POST /oauth/authorize — validate creds, issue code, redirect
// ============================================================
export async function handleAuthorizePost(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const formData = await request.formData();

  const q: AuthorizeQuery = {
    response_type: formData.get("response_type")?.toString(),
    client_id: formData.get("client_id")?.toString(),
    redirect_uri: formData.get("redirect_uri")?.toString(),
    scope: formData.get("scope")?.toString() ?? undefined,
    state: formData.get("state")?.toString() ?? undefined,
    code_challenge: formData.get("code_challenge")?.toString(),
    code_challenge_method: formData.get("code_challenge_method")?.toString(),
  };
  const email = formData.get("fellow_email")?.toString() ?? "";
  const password = formData.get("fellow_password")?.toString() ?? "";

  const validation = await validateAuthorizeRequest(q, env);
  if (!validation.ok) {
    return new Response(validation.message, { status: validation.status });
  }

  if (!email || !password) {
    return renderSignInError(q, "Email and password are both required.");
  }

  // Validate Fellow credentials by attempting to authenticate
  const fellow = new FellowClient(email, password);
  try {
    await fellow.authenticate();
  } catch {
    return renderSignInError(q, "Sign in failed. Check your Fellow email and password.");
  }

  // The FellowClient now holds a JWT internally. We reach for it via a
  // small accessor we add to FellowClient.
  const jwt = fellow.getToken();
  if (!jwt) {
    return renderSignInError(q, "Sign in succeeded but no token was returned. Try again.");
  }

  // Store auth code with the Fellow JWT (NOT the password)
  const code = generateRandomToken(32);
  const fellow_email_hash = await sha256Hex(email.toLowerCase().trim());
  await putAuthCode(env, code, {
    client_id: q.client_id!,
    redirect_uri: q.redirect_uri!,
    code_challenge: q.code_challenge!,
    code_challenge_method: "S256",
    scope: q.scope,
    fellow_jwt: jwt,
    fellow_email_hash,
    created_at: Date.now(),
  });

  // Redirect back to Claude with the code
  const redirect = new URL(q.redirect_uri!);
  redirect.searchParams.set("code", code);
  if (q.state) redirect.searchParams.set("state", q.state);

  // Note: never log the redirect URL — it contains the auth code.
  // Use a 303 so the browser POSTs are converted to GETs cleanly.
  return new Response(null, {
    status: 303,
    headers: { Location: redirect.toString() },
  });
}

// ============================================================
// HTML rendering
// ============================================================

function renderSignInHtml(q: AuthorizeQuery, errorMessage?: string): string {
  const fields = ["response_type", "client_id", "redirect_uri", "scope", "state", "code_challenge", "code_challenge_method"]
    .map((k) => {
      const v = (q as Record<string, string | undefined>)[k] ?? "";
      return `<input type="hidden" name="${k}" value="${escapeHtml(v)}" />`;
    })
    .join("\n      ");

  const error = errorMessage
    ? `<div class="error" role="alert">${escapeHtml(errorMessage)}</div>`
    : "";

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Sign in — aiden-mcp</title>
  <style>
    :root { color-scheme: light dark; }
    body {
      font-family: ui-sans-serif, system-ui, -apple-system, sans-serif;
      margin: 0;
      padding: 2rem 1rem;
      background: #f7f5f2;
      color: #1a1a1a;
    }
    @media (prefers-color-scheme: dark) {
      body { background: #1a1a1a; color: #f0f0f0; }
      .card { background: #2a2a2a; border-color: #3a3a3a; }
      input { background: #1a1a1a; color: #f0f0f0; border-color: #444; }
    }
    .card {
      max-width: 28rem;
      margin: 2rem auto;
      padding: 2rem;
      background: white;
      border: 1px solid #ddd;
      border-radius: 12px;
      box-shadow: 0 1px 4px rgba(0,0,0,0.05);
    }
    h1 { margin: 0 0 .25rem; font-size: 1.4rem; }
    .sub { color: #777; font-size: .9rem; margin-bottom: 1.5rem; }
    label { display: block; font-size: .85rem; margin: 1rem 0 .35rem; font-weight: 500; }
    input[type="email"], input[type="password"] {
      width: 100%;
      box-sizing: border-box;
      padding: .65rem .75rem;
      font-size: 1rem;
      border: 1px solid #bbb;
      border-radius: 6px;
    }
    button {
      margin-top: 1.5rem;
      width: 100%;
      padding: .75rem;
      font-size: 1rem;
      font-weight: 500;
      background: #c97f4a;
      color: white;
      border: 0;
      border-radius: 6px;
      cursor: pointer;
    }
    button:hover { background: #b56e3d; }
    .error {
      background: #fee2e2;
      color: #991b1b;
      padding: .75rem 1rem;
      border-radius: 6px;
      margin-bottom: 1rem;
      font-size: .9rem;
    }
    .note {
      margin-top: 1.5rem;
      padding-top: 1rem;
      border-top: 1px solid #eee;
      color: #777;
      font-size: .8rem;
      line-height: 1.5;
    }
    .note a { color: #c97f4a; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Sign in to Fellow</h1>
    <p class="sub">aiden-mcp is requesting access to your Aiden brewer.</p>
    ${error}
    <form method="post" action="/oauth/authorize" autocomplete="on">
      ${fields}
      <label for="fellow_email">Fellow email</label>
      <input id="fellow_email" name="fellow_email" type="email" required autocomplete="username" autofocus />
      <label for="fellow_password">Fellow password</label>
      <input id="fellow_password" name="fellow_password" type="password" required autocomplete="current-password" />
      <button type="submit">Sign in &amp; authorize</button>
    </form>
    <div class="note">
      Your password reaches this server exactly once — it's used to sign in to Fellow's API and is then discarded.
      Only the resulting Fellow JWT (which Fellow itself issues) is briefly cached so this server can call Fellow on your behalf.
      <br /><br />
      Unofficial — not affiliated with Fellow Industries.
      <a href="https://github.com/ravenintheforrest/aiden-mcp">Source</a>.
    </div>
  </div>
</body>
</html>`;
}

function renderSignInError(q: AuthorizeQuery, message: string): Response {
  return new Response(renderSignInHtml(q, message), {
    status: 401,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
