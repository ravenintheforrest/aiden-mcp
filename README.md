# aiden-mcp

An MCP server for the [Fellow Aiden](https://fellowproducts.com/products/aiden) coffee brewer. Lets Claude (or any MCP client) list, create, delete, and share brew profiles on your Aiden using natural language.

> **Unofficial.** Not affiliated with or endorsed by Fellow Industries. Uses the same private API the Fellow iOS app uses; could break without notice.

## What it does

- **`list_profiles`** — see what's on your Aiden
- **`create_profile`** — push a new brew profile, get back a `brew.link` URL
- **`delete_profile`** — free up a slot (14-profile cap)
- **`share_profile`** — generate a `brew.link` for any existing profile
- **`get_device_info`** — quick credential / connection check

## Hosted endpoint

```
https://aidenmcp.ravenhoward.org/mcp
```

You can self-host the same code (see "Self-hosting" below) — recommended if you'd rather not send your Fellow password to a server you don't own.

## How it handles your Fellow password

Per-request, never stored. Each MCP tool call:

1. Reads `X-Fellow-Email` and `X-Fellow-Password` from request headers
2. Exchanges them for a JWT against Fellow's `/auth/login` endpoint
3. Uses the JWT for that one request, discards everything

Nothing is persisted server-side. No KV, no database, no logs of credentials. You can verify this by reading [`src/auth.ts`](src/auth.ts) and [`src/fellow-api.ts`](src/fellow-api.ts).

That said: any time you give a third-party MCP server your password, you're trusting the operator. **If you don't know the operator, self-host.** Forking and deploying your own copy takes about 5 minutes (steps below).

## Setup — Claude Desktop

Add to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "aiden": {
      "url": "https://aidenmcp.ravenhoward.org/mcp",
      "headers": {
        "X-Fellow-Email": "you@example.com",
        "X-Fellow-Password": "your-fellow-password"
      }
    }
  }
}
```

Restart Claude Desktop. The Aiden tools will appear in the tools menu.

## Setup — Claude iOS

iOS uses a slightly different connector flow. Add the URL `https://aidenmcp.ravenhoward.org/mcp` as a custom MCP connector. Header support on iOS is currently more limited — if you can't pass credentials via headers, **self-host with credentials baked into env vars** (see Self-hosting below).

## Setup — other MCP clients

The transport is **Streamable HTTP** at `/mcp`. Pass `X-Fellow-Email` and `X-Fellow-Password` as headers. Stateless — no session management.

## Example prompts

> "List my Aiden profiles."

> "Delete the Mpemba v2 profile."

> "Create a new Aiden profile called 'Onyx Geisha' with 1:16 ratio, 95°C bloom for 40s, 3 single-serve pulses at 95/94/93°C, 2 batch pulses at 94/93°C, 20s SS interval, 25s batch interval. Then give me the brew.link."

## Self-hosting

```bash
git clone https://github.com/ravenintheforrest/aiden-mcp
cd aiden-mcp
npm install
npx wrangler login
npx wrangler deploy
```

Cloudflare Workers free tier covers 100k requests/day — plenty for personal use. The Worker is stateless, so no KV / database setup needed.

To attach a custom domain after deploy: CF dashboard → Workers & Pages → `aiden-mcp` → Settings → Domains & Routes → Add Custom Domain.

### Local development

```bash
npx wrangler dev
```

Worker runs at `http://localhost:8787`. Pass headers via `curl` or your MCP client's local config. The MCP endpoint is `/mcp`; `/health` returns server info.

## Profile schema

The Aiden brewer accepts profiles with these constraints:

| Field | Range | Notes |
|---|---|---|
| `ratio` | 14-20 | Coffee:water ratio (e.g. 15 = 1:15) |
| `bloomRatio` | 1-3 | Water multiple for the bloom |
| `bloomDuration` | 1-120 | Seconds |
| `bloomTemperature` | 50-99 | °C |
| `ssPulsesNumber` | 1-10 | Single-serve pulses |
| `ssPulsesInterval` | 5-60 | Seconds between pulses |
| `ssPulseTemperatures` | array of 50-99 | Length must equal `ssPulsesNumber` |
| `batchPulsesNumber` | 1-10 | Same idea, batch mode |
| `batchPulsesInterval` | 5-60 | |
| `batchPulseTemperatures` | array of 50-99 | |
| `title` | 1-50 chars | Alphanumeric + basic punctuation |

The MCP validates all of this client-side before calling Fellow's API, so you'll get clear error messages instead of generic 400s.

## Caveats

- **The 14-profile cap.** Aiden hardware limits you to 14 custom profiles. `create_profile` will fail with a clear error if you're at the cap; use `delete_profile` first.
- **Fellow's API is private.** Endpoints discovered from the iOS app's network traffic. Fellow could change them; this would stop working until updated.
- **One device assumption.** If your Fellow account has multiple Aidens, the MCP currently picks the first one returned. Open an issue if you need multi-device support.
- **No use-at-your-own-risk small print needed.** It's a coffee maker. Worst case is a bad cup.

## License

MIT — fork, modify, deploy, share.

## Related

- [9b/fellow-aiden](https://github.com/9b/fellow-aiden) — Python library that originally documented the Aiden profile schema
- [Brew Studio](https://brew.studio/) — Fellow's official AI-recipe Brew Studio (web)
- [brew.link](https://brew.link) — Fellow's profile-sharing URL service
