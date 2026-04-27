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
    /* Single explicit color scheme that's readable in any host context.
       The OAuth flow opens in a new tab so we control the rendering, but
       some clients embed it — solid colors are more predictable than
       prefers-color-scheme. */
    * { box-sizing: border-box; }
    html, body {
      margin: 0;
      padding: 0;
      font-family: ui-sans-serif, system-ui, -apple-system, "SF Pro Text", sans-serif;
      background: #0f1115;
      color: #f5f5f5;
      min-height: 100vh;
      -webkit-font-smoothing: antialiased;
    }
    .wrap {
      max-width: 30rem;
      margin: 0 auto;
      padding: 3rem 1.25rem 2rem;
    }
    .card {
      background: #1a1d23;
      border: 1px solid #2a2e36;
      border-radius: 14px;
      padding: 2rem;
      box-shadow: 0 4px 24px rgba(0,0,0,0.35);
    }
    h1 {
      margin: 0 0 .35rem;
      font-size: 1.45rem;
      font-weight: 600;
      letter-spacing: -0.01em;
      color: #f5f5f5;
    }
    .sub {
      color: #b8bcc4;
      font-size: .92rem;
      margin: 0 0 1.75rem;
      line-height: 1.4;
    }
    label {
      display: block;
      font-size: .85rem;
      font-weight: 500;
      color: #e0e3ea;
      margin: 1.25rem 0 .4rem;
    }
    input[type="email"],
    input[type="password"] {
      width: 100%;
      padding: .75rem .85rem;
      font-size: 1rem;
      font-family: inherit;
      color: #f5f5f5;
      background: #0f1115;
      border: 1px solid #3a3f48;
      border-radius: 8px;
      outline: none;
      transition: border-color .15s ease;
    }
    input[type="email"]:focus,
    input[type="password"]:focus {
      border-color: #c97f4a;
      box-shadow: 0 0 0 3px rgba(201, 127, 74, 0.18);
    }
    input::placeholder { color: #5b606b; }
    button {
      margin-top: 1.75rem;
      width: 100%;
      padding: .85rem;
      font-size: 1rem;
      font-weight: 600;
      font-family: inherit;
      color: white;
      background: #c97f4a;
      border: 0;
      border-radius: 8px;
      cursor: pointer;
      transition: background .15s ease;
    }
    button:hover { background: #b8703f; }
    button:active { background: #a86638; }
    .error {
      background: rgba(220, 60, 60, 0.12);
      border: 1px solid rgba(220, 60, 60, 0.35);
      color: #ff8c8c;
      padding: .8rem 1rem;
      border-radius: 8px;
      margin-bottom: 1.25rem;
      font-size: .9rem;
      line-height: 1.4;
    }
    .note {
      margin-top: 1.75rem;
      padding-top: 1.25rem;
      border-top: 1px solid #2a2e36;
      color: #9ba0a8;
      font-size: .8rem;
      line-height: 1.55;
    }
    .note a { color: #d99a6a; text-decoration: none; }
    .note a:hover { text-decoration: underline; }
    .badge {
      display: inline-block;
      font-size: .7rem;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      color: #9ba0a8;
      background: #0f1115;
      border: 1px solid #2a2e36;
      padding: .15rem .45rem;
      border-radius: 4px;
      margin-bottom: 1rem;
    }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="card">
      <div class="badge">aiden-mcp</div>
      <h1>Sign in to Fellow</h1>
      <p class="sub">An MCP client is requesting access to your Aiden brewer. Sign in with your Fellow account to authorize.</p>
      ${error}
      <form method="post" action="/oauth/authorize" autocomplete="on">
        ${fields}
        <label for="fellow_email">Fellow email</label>
        <input id="fellow_email" name="fellow_email" type="email" required autocomplete="username" autofocus placeholder="you@example.com" />
        <label for="fellow_password">Fellow password</label>
        <input id="fellow_password" name="fellow_password" type="password" required autocomplete="current-password" placeholder="••••••••" />
        <button type="submit">Sign in &amp; authorize</button>
      </form>
      <div class="note">
        Your password reaches this server exactly once — it's used to sign in to Fellow's API and is then discarded.
        Only the resulting Fellow JWT (which Fellow itself issues) is briefly cached so this server can call Fellow on your behalf.
        <br /><br />
        Unofficial — not affiliated with Fellow Industries.
        <a href="https://github.com/ravenintheforrest/aiden-mcp">View source</a>.
      </div>
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
