/**
 * aiden-mcp — Cloudflare Worker hosting an MCP server for the Fellow Aiden coffee brewer.
 *
 * Unofficial — not affiliated with or endorsed by Fellow Industries.
 * Uses the same private API the Fellow iOS app uses; could break without notice.
 *
 * Architecture:
 *   - Streamable HTTP MCP transport at /mcp
 *   - OAuth 2.0 (auth code + PKCE, RFC 6749 + 7636) at /oauth/*
 *   - Discovery metadata at /.well-known/* (RFC 9728 + 8414)
 *   - Per-user Fellow auth: user signs in once, JWT cached for 1 hour
 *   - Stateless beyond short-lived KV records (codes ≤10min, tokens ≤1h)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";

import { clientFromHeaders } from "./auth.js";
import { profileInputSchema, checkPulseConsistency } from "./validation.js";
import { FellowApiError, categorize, CUSTOM_PROFILE_CAP } from "./fellow-api.js";
import { fetchCoffeeDetails } from "./coffee-fetcher.js";
import { brewingGuidelines } from "./brewing-guidelines.js";
import {
  protectedResourceMetadata,
  authorizationServerMetadata,
} from "./oauth/discovery.js";
import { handleRegister } from "./oauth/register.js";
import { handleAuthorizeGet, handleAuthorizePost } from "./oauth/authorize.js";
import { handleToken } from "./oauth/token.js";
import { Env } from "./oauth/kv.js";

const VERSION = "0.2.0";

function makeServer(headers: Headers, env: Env): McpServer {
  const server = new McpServer({
    name: "aiden-mcp",
    version: VERSION,
  });

  // ============================================================
  // list_profiles
  // ============================================================
  server.tool(
    "list_profiles",
    "List all brew profiles currently on your Fellow Aiden, grouped by category (custom, stock, shared). The 14-profile cap applies only to user-created custom profiles.",
    {},
    async () => {
      const client = await clientFromHeaders(headers, env);
      const device = await client.getDevice();
      const profiles = await client.listProfiles();

      const grouped = { custom: [], stock: [], shared: [], unknown: [] } as Record<
        ReturnType<typeof categorize>,
        typeof profiles
      >;
      for (const p of profiles) grouped[categorize(p)].push(p);

      // Stock and shared profiles can have null/missing fields, so be defensive.
      const fmt = (p: (typeof profiles)[number]) => {
        const id = p.id ?? "(no id)";
        const title = p.title ?? "(untitled)";
        const ratioPart = p.ratio != null ? `1:${p.ratio} ratio` : "";
        const bloomPart = p.bloomTemperature != null ? `${p.bloomTemperature}°C bloom` : "";
        const ss = Array.isArray(p.ssPulseTemperatures) ? p.ssPulseTemperatures : [];
        const ssPart = ss.length ? `SS ${ss.join("/")}°C` : "";
        const details = [ratioPart, bloomPart, ssPart].filter(Boolean).join(", ");
        return details ? `  ${id}  ${title}  —  ${details}` : `  ${id}  ${title}`;
      };

      const lines: string[] = [
        `Aiden: ${device.displayName ?? "Aiden"}`,
        `Custom slots: ${grouped.custom.length}/${CUSTOM_PROFILE_CAP} used`,
        "",
        `Custom profiles (${grouped.custom.length}):`,
        ...grouped.custom.map(fmt),
      ];
      if (grouped.stock.length) {
        lines.push("", `Stock profiles (${grouped.stock.length}, can't delete):`, ...grouped.stock.map(fmt));
      }
      if (grouped.shared.length) {
        lines.push("", `Shared/community profiles (${grouped.shared.length}):`, ...grouped.shared.map(fmt));
      }

      return {
        content: [{ type: "text", text: lines.join("\n") }],
      };
    },
  );

  // ============================================================
  // create_profile
  // ============================================================
  server.tool(
    "create_profile",
    "Create a new brew profile on your Aiden and return a brew.link URL. The profile will appear in the Fellow iOS app immediately. If the device is at its 14-profile cap, you'll get an error — call delete_profile first to free a slot.",
    profileInputSchema.shape,
    async (input) => {
      const parsed = profileInputSchema.parse(input);
      const consistencyErrors = checkPulseConsistency(parsed);
      if (consistencyErrors.length) {
        return {
          isError: true,
          content: [
            { type: "text", text: `Profile validation failed:\n  ${consistencyErrors.join("\n  ")}` },
          ],
        };
      }

      const client = await clientFromHeaders(headers, env);
      const created = await client.createProfile(parsed);
      const link = await client.shareProfile(created.id!);

      return {
        content: [
          {
            type: "text",
            text:
              `Created profile "${created.title}" (id: ${created.id}).\n` +
              `brew.link: ${link}\n\n` +
              `Tap the link in the Fellow iOS app to load the profile.`,
          },
        ],
      };
    },
  );

  // ============================================================
  // delete_profile
  // ============================================================
  server.tool(
    "delete_profile",
    "Delete a brew profile from your Aiden. Pass either the profile id (e.g. 'p10') or the exact title (e.g. 'Mpemba v2'). Use list_profiles first if you don't know the id.",
    {
      idOrTitle: z
        .string()
        .min(1)
        .describe("Either the profile id (e.g. 'p10') or the exact case-sensitive title"),
    },
    async ({ idOrTitle }) => {
      const client = await clientFromHeaders(headers, env);
      const profile = await client.findProfile(idOrTitle);
      if (!profile) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `No profile matched "${idOrTitle}". Run list_profiles to see what's available — note that titles are case-sensitive.`,
            },
          ],
        };
      }
      await client.deleteProfile(profile.id!);
      return {
        content: [{ type: "text", text: `Deleted profile "${profile.title}" (id: ${profile.id}).` }],
      };
    },
  );

  // ============================================================
  // share_profile
  // ============================================================
  server.tool(
    "share_profile",
    "Generate a brew.link URL for an existing profile on your Aiden. Use this to re-share a profile you already have. (create_profile already returns a brew.link, so you only need this for profiles created via the Fellow app or another tool.)",
    {
      idOrTitle: z
        .string()
        .min(1)
        .describe("Profile id (e.g. 'p10') or exact case-sensitive title"),
    },
    async ({ idOrTitle }) => {
      const client = await clientFromHeaders(headers, env);
      const profile = await client.findProfile(idOrTitle);
      if (!profile) {
        return {
          isError: true,
          content: [
            { type: "text", text: `No profile matched "${idOrTitle}". Run list_profiles first.` },
          ],
        };
      }
      const link = await client.shareProfile(profile.id!);
      return {
        content: [{ type: "text", text: `brew.link for "${profile.title}": ${link}` }],
      };
    },
  );

  // ============================================================
  // fetch_coffee_details — scrape a roaster product page
  // ============================================================
  server.tool(
    "fetch_coffee_details",
    "Fetch a coffee from a roaster's product page (Counter Culture, Onyx, Sey, Heart, etc. — any Shopify-based roaster) and return structured details: name, varieties, process, elevation, country, tasting notes, story. Use this when the user pastes a URL and wants you to design a brew profile from it. Does NOT require Aiden auth — works on URLs alone.",
    {
      url: z
        .string()
        .url()
        .describe("Roaster product page URL, e.g. https://counterculturecoffee.com/products/mpemba"),
    },
    async ({ url }) => {
      const details = await fetchCoffeeDetails(url);

      // Format as readable text — easier for the LLM to reason over than raw JSON
      const lines: string[] = [
        details.coffee_name ? `Coffee: ${details.coffee_name}` : "Coffee: (name not found)",
        details.roaster ? `Roaster: ${details.roaster}` : "",
        details.country ? `Country: ${details.country}` : "",
        details.region ? `Region: ${details.region}` : "",
        details.producer ? `Producer: ${details.producer}` : "",
        details.elevation ? `Elevation: ${details.elevation}` : "",
        details.varieties?.length ? `Varieties: ${details.varieties.join(", ")}` : "",
        details.process ? `Process: ${details.process}` : "",
        details.tasting_notes?.length ? `Tasting notes: ${details.tasting_notes.join(", ")}` : "",
        "",
      ];
      if (details.description) {
        lines.push(`Description:\n${details.description.slice(0, 600)}${details.description.length > 600 ? "…" : ""}`);
      }
      if (details.story) {
        lines.push("", `Story:\n${details.story.slice(0, 800)}${details.story.length > 800 ? "…" : ""}`);
      }
      if (details.warnings.length) {
        lines.push("", `⚠ Warnings:`, ...details.warnings.map((w) => `  - ${w}`));
      }
      lines.push("", `Source: ${details.source} | URL: ${details.url}`);

      return {
        content: [{ type: "text", text: lines.filter((l) => l !== "").join("\n") || "(no details extracted)" }],
      };
    },
  );

  // ============================================================
  // brewing_guidelines — encoded heuristics for designing profiles
  // ============================================================
  server.tool(
    "brewing_guidelines",
    "Get Aiden-specific brewing guidelines tailored to a coffee's characteristics. Returns brewing principles + a starting-point recipe. Use this AFTER fetching coffee details (or when user provides them directly), then design the actual create_profile call using the returned principles. Does NOT require Aiden auth.",
    {
      process: z.string().optional().describe("Process: washed, natural, honey, anaerobic, etc."),
      varieties: z.array(z.string()).optional().describe("Varietal names, e.g. ['Bourbon', 'SL28']"),
      elevation: z.string().optional().describe("Elevation, e.g. '1,800–2,000 masl' or '1750m'"),
      tasting_notes: z.array(z.string()).optional().describe("Notes on the bag, e.g. ['fig', 'strawberry', 'honey']"),
      flavor_goal: z
        .string()
        .optional()
        .describe(
          "What the user is trying to achieve, e.g. 'more fruit', 'less acidity', 'bolder body'. Drives explicit recipe adjustments.",
        ),
      user_preference_ratio: z
        .number()
        .optional()
        .describe("User's typical ratio (e.g. 15 for 1:15). Defaults to 1:15 washed, 1:16 natural."),
    },
    async (input) => {
      const guidelines = brewingGuidelines(input);
      const lines = [
        guidelines.summary,
        "",
        "Principles:",
        ...guidelines.principles.map((p, i) => `  ${i + 1}. ${p}`),
        "",
        "Starting-point recipe (adjust based on principles above):",
        `  Ratio:   ${guidelines.starting_recipe.ratio}`,
        `  Bloom:   ${guidelines.starting_recipe.bloom}`,
        `  SS:      ${guidelines.starting_recipe.ss_pulses}`,
        `  Batch:   ${guidelines.starting_recipe.batch_pulses}`,
        `  Grind:   ${guidelines.starting_recipe.grind_setting}`,
      ];
      if (guidelines.warnings.length) {
        lines.push("", "Warnings:", ...guidelines.warnings.map((w) => `  ⚠ ${w}`));
      }
      return {
        content: [{ type: "text", text: lines.join("\n") }],
      };
    },
  );

  // ============================================================
  // get_device_info
  // ============================================================
  server.tool(
    "get_device_info",
    "Get info about your connected Aiden brewer (name, profile count, slot usage). Lightweight call useful for verifying credentials work before doing heavier operations.",
    {},
    async () => {
      const client = await clientFromHeaders(headers, env);
      const device = await client.getDevice();
      const profiles = await client.listProfiles();
      const customCount = profiles.filter((p) => categorize(p) === "custom").length;
      return {
        content: [
          {
            type: "text",
            text:
              `Device: ${device.displayName ?? "Aiden"}\n` +
              `ID: ${device.id}\n` +
              `Custom profile slots: ${customCount}/${CUSTOM_PROFILE_CAP}\n` +
              `Total profiles visible (incl. stock + shared): ${profiles.length}`,
          },
        ],
      };
    },
  );

  return server;
}

// ============================================================
// Worker entry — route dispatch
// ============================================================
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const origin = `${url.protocol}//${url.host}`;
    const pathname = url.pathname;

    try {
      // ---- Discovery (no auth) ----
      if (request.method === "GET" && pathname === "/.well-known/oauth-protected-resource") {
        return protectedResourceMetadata(origin);
      }
      if (request.method === "GET" && pathname === "/.well-known/oauth-authorization-server") {
        return authorizationServerMetadata(origin);
      }

      // ---- OAuth endpoints ----
      if (request.method === "POST" && pathname === "/oauth/register") {
        return handleRegister(request, env);
      }
      if (request.method === "GET" && pathname === "/oauth/authorize") {
        return handleAuthorizeGet(url, env);
      }
      if (request.method === "POST" && pathname === "/oauth/authorize") {
        return handleAuthorizePost(request, env);
      }
      if (request.method === "POST" && pathname === "/oauth/token") {
        return handleToken(request, env);
      }

      // ---- Health / root ----
      if (request.method === "GET" && (pathname === "/" || pathname === "/health")) {
        return Response.json({
          name: "aiden-mcp",
          version: VERSION,
          description:
            "MCP server for Fellow Aiden brewer. Unofficial — not affiliated with Fellow Industries.",
          transport: "streamable-http",
          mcp_endpoint: "/mcp",
          oauth: {
            metadata: `${origin}/.well-known/oauth-authorization-server`,
            authorize: `${origin}/oauth/authorize`,
            token: `${origin}/oauth/token`,
            register: `${origin}/oauth/register`,
          },
          docs: "https://github.com/ravenintheforrest/aiden-mcp",
        });
      }

      // ---- MCP resource endpoint ----
      if (pathname === "/mcp" || pathname === "/sse") {
        // Tools split by whether they need Fellow credentials.
        // Pure-compute / pure-fetch tools work for anyone — no Fellow account needed.
        const FELLOW_AUTH_TOOLS = new Set([
          "list_profiles",
          "create_profile",
          "delete_profile",
          "share_profile",
          "get_device_info",
        ]);

        // Inspect the JSON-RPC method without consuming the body
        let needsAuth = false;
        if (request.method === "POST") {
          try {
            const cloned = request.clone();
            const body = (await cloned.json()) as { method?: string; params?: { name?: string } };
            // tools/list and initialize are public so clients can discover capabilities
            if (body.method === "tools/call" && FELLOW_AUTH_TOOLS.has(body.params?.name ?? "")) {
              needsAuth = true;
            }
          } catch {
            // Couldn't parse — let transport handle the error
          }
        }

        if (needsAuth) {
          try {
            await clientFromHeaders(request.headers, env);
          } catch (err) {
            if (err instanceof FellowApiError && err.status === 401) {
              return new Response(
                JSON.stringify({ error: "unauthorized", error_description: err.message }),
                {
                  status: 401,
                  headers: {
                    "Content-Type": "application/json",
                    "WWW-Authenticate": `Bearer realm="aiden-mcp", resource_metadata="${origin}/.well-known/oauth-protected-resource"`,
                  },
                },
              );
            }
            throw err;
          }
        }

        const transport = new WebStandardStreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
          enableJsonResponse: true,
        });
        const server = makeServer(request.headers, env);
        await server.connect(transport);
        return await transport.handleRequest(request);
      }

      return new Response("Not Found", { status: 404 });
    } catch (err) {
      if (err instanceof FellowApiError) {
        const headers: Record<string, string> = { "Content-Type": "application/json" };
        if (err.status === 401) {
          // RFC 6750: tell the client where to authenticate
          headers["WWW-Authenticate"] = `Bearer realm="aiden-mcp", resource_metadata="${origin}/.well-known/oauth-protected-resource"`;
        }
        return new Response(JSON.stringify({ error: err.message, status: err.status }), {
          status: err.status ?? 500,
          headers,
        });
      }
      const message = err instanceof Error ? err.message : "Unknown error";
      return new Response(JSON.stringify({ error: message }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }
  },
};
