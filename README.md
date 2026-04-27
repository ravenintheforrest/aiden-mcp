# aiden-mcp

An MCP server for the [Fellow Aiden](https://fellowproducts.com/products/aiden) coffee brewer. Lets Claude (and other MCP clients) brew good coffee with you — list, create, delete, and share profiles on your Aiden through natural language, scrape coffee details from any roaster's product page, and apply Aiden-specific brewing heuristics to design a recipe.

> **Unofficial.** Not affiliated with or endorsed by Fellow Industries. Uses the same private API the Fellow iOS app uses; could break without notice.

## What it does

| Tool | Auth | What |
|---|---|---|
| `fetch_coffee_details` | none | Scrape any Shopify roaster product page — Counter Culture, Onyx, Sey, Heart, Verve — and return structured data (varieties, process, elevation, notes, story) |
| `brewing_guidelines` | none | Return Aiden-specific brewing principles tailored to a coffee's process, elevation, varietals, and your flavor goal |
| `list_profiles` | OAuth | List the brew profiles on your Aiden, grouped by category (custom / stock / shared) |
| `create_profile` | OAuth | Push a new profile, get back a `brew.link` URL |
| `delete_profile` | OAuth | Free up a slot (Aiden has a 14-profile cap) |
| `share_profile` | OAuth | Generate a `brew.link` for any existing profile |
| `get_device_info` | OAuth | Verify connection + show slot usage |

## Example session

> **You:** I picked up [this coffee from Counter Culture](https://counterculturecoffee.com/products/mpemba-natural-sundried). My old profile tasted thin and sour — I want to actually taste the fig and strawberry. Make me a new profile and push it to my Aiden.

Claude calls:

1. `fetch_coffee_details(url)` → returns `{ coffee_name: "Mpemba — Natural Sundried", process: "natural sundried", country: "Burundi", elevation: "1800–2000m", tasting_notes: ["fig", "strawberry", "bright"], … }`
2. `brewing_guidelines({process: "natural sundried", elevation: "1800-2000m", flavor_goal: "more fruit"})` → returns principles ("naturals lose volatile aromatics above 93°C", "coarsen grind for aromatic clarity", "open ratio to 1:16") + a starting recipe
3. `create_profile({title: "Mpemba v3", ratio: 16, bloomTemperature: 92, …})` → pushes to Aiden, returns `brew.link/p/o3nZ`

> **Claude:** I pushed `Mpemba v3` to your Aiden. Three changes from your old profile: dropped temps ~4°C across the board (96/95/94 → 92/91/90 SS) to preserve the fig and strawberry esters that high heat was driving off, opened ratio from 1:15 → 1:16 to give the aromatics room, and went coarser on grind (Encore 13 → 17). brew.link: https://brew.link/p/o3nZ

## Hosted endpoint

```
https://aidenmcp.ravenhoward.org/mcp
```

Or self-host (5 minutes, see below) — recommended if you'd rather not send your Fellow password to a server you don't run.

## Setup

### Claude.ai web / Claude iOS

1. Open Claude.ai → Settings → **Connectors** → **Add custom connector**
2. Fill in:
   - **Name:** `Aiden`
   - **URL:** `https://aidenmcp.ravenhoward.org/mcp`
   - Leave **OAuth Client ID** and **OAuth Client Secret** **empty** — Claude auto-registers via dynamic client registration
3. Click **Connect**. Claude opens a sign-in page. Enter your **Fellow** email + password (the same ones you use for the Fellow iOS app). The page validates with Fellow and redirects you back.
4. Try: *"List my Aiden profiles."*

### Claude Desktop

Same as web — use Settings → Connectors. The OAuth flow opens in your browser.

If you'd rather skip OAuth and use header auth instead, edit `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or equivalent:

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

### Other MCP clients

Streamable HTTP transport at `/mcp`. Auth via OAuth 2.0 (auth code + PKCE) or `X-Fellow-Email` / `X-Fellow-Password` headers.

## How auth handles your Fellow password

Your password reaches the server **exactly once** during OAuth sign-in. The server:

1. Receives your email + password on the `/oauth/authorize` page
2. Calls Fellow's `/auth/login` to validate them — gets back a JWT
3. Stores **only the JWT** in Cloudflare KV (encrypted at rest, 1-hour TTL)
4. Discards the password

No persistent storage of credentials. No logging of credentials. The JWT is what the server uses to call Fellow's API on your behalf.

You can verify all of this by reading [`src/oauth/authorize.ts`](src/oauth/authorize.ts) and [`src/auth.ts`](src/auth.ts). If you'd rather not trust me as the operator, [self-host](#self-hosting).

## Self-hosting

```bash
git clone https://github.com/ravenintheforrest/aiden-mcp
cd aiden-mcp
npm install
npx wrangler login

# Create the OAuth state KV namespace
npx wrangler kv namespace create AIDEN_OAUTH
# Copy the id from the output into wrangler.toml under [[kv_namespaces]]

# Deploy
npx wrangler deploy
```

Cloudflare's free tier covers 100k requests/day and 1k KV writes/day — plenty for personal or small-group use. The Worker is stateless beyond short-lived KV records, so no database to manage.

To attach a custom domain after deploy: CF dashboard → Workers & Pages → `aiden-mcp` → Settings → Domains & Routes → Add Custom Domain.

### Local development

```bash
npx wrangler dev
```

Worker runs at `http://localhost:8787`. The `/mcp` endpoint, OAuth endpoints, and `/health` all work locally.

## Profile schema

The Aiden brewer accepts profiles with these constraints:

| Field | Range | Notes |
|---|---|---|
| `ratio` | 14–20 | Coffee:water ratio (e.g. 15 = 1:15) |
| `bloomRatio` | 1–3 | Water multiple for the bloom |
| `bloomDuration` | 1–120 | Seconds |
| `bloomTemperature` | 50–99 | °C |
| `ssPulsesNumber` | 1–10 | Single-serve pulses |
| `ssPulsesInterval` | 5–60 | Seconds between pulses |
| `ssPulseTemperatures` | array of 50–99 | Length must equal `ssPulsesNumber` |
| `batchPulsesNumber` | 1–10 | Same idea, batch mode |
| `batchPulsesInterval` | 5–60 | |
| `batchPulseTemperatures` | array of 50–99 | |
| `title` | 1–50 chars | Alphanumeric + basic punctuation |

The MCP validates client-side before calling Fellow's API, so you'll get clear error messages instead of generic 400s.

## Caveats

- **The 14-profile cap.** Aiden hardware limits you to 14 custom profiles. `create_profile` will return a clear error if you're at the cap; use `delete_profile` first.
- **Fellow's API is private.** Endpoints discovered from the iOS app's network traffic. Fellow could change them at any time and break this. Open an issue if the API drift catches you.
- **One device per account assumed.** If your Fellow account has multiple Aidens, the MCP currently picks the first returned. Open an issue if you need multi-device.
- **OAuth tokens expire after 1 hour.** You'll be prompted to re-authorize. The server doesn't store refresh tokens — you re-enter your Fellow password. This is intentional (less to leak if KV ever gets compromised).

## Architecture

- **Cloudflare Worker** at `aidenmcp.ravenhoward.org`
- **Streamable HTTP** MCP transport (web standards, works in Workers)
- **OAuth 2.0** authorization code grant with PKCE (RFC 6749 + RFC 7636)
- **Dynamic client registration** (RFC 7591)
- **Discovery metadata** at `/.well-known/oauth-protected-resource` and `/.well-known/oauth-authorization-server` (RFC 9728 + RFC 8414)
- **No persistent state** beyond short-lived KV records (auth codes ≤10min, access tokens ≤1hr, client registrations ≤90 days)

## License

MIT — fork it, ship it, change the brewing heuristics to match your taste.

## Related

- [9b/fellow-aiden](https://github.com/9b/fellow-aiden) — Python library that originally documented the Aiden profile schema
- [Brew Studio](https://brew.studio/) — Fellow's official AI-recipe builder (web)
- [brew.link](https://brew.link) — Fellow's profile-sharing URL service
- [Counter Culture Brew Guides](https://counterculturecoffee.com/pages/how-to-brew) — much of the brewing intuition encoded in `brewing_guidelines`

## Contributing

PRs welcome — particularly for:

- Roasters whose product pages don't parse cleanly via `fetch_coffee_details` (Sey, Heart, Tim Wendelboe pages I haven't tested)
- Brewing heuristics in `brewing_guidelines` that disagree with what the tool currently returns
- Multi-device Aiden support
- Refresh token flow for OAuth so users don't re-auth every hour
