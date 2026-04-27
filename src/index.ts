/**
 * aiden-mcp — Cloudflare Worker hosting an MCP server for the Fellow Aiden coffee brewer.
 *
 * Unofficial — not affiliated with or endorsed by Fellow Industries.
 * Uses the same private API the Fellow iOS app uses; could break without notice.
 *
 * Architecture:
 *   - Streamable HTTP transport (works with desktop and mobile Claude clients)
 *   - Per-request auth via X-Fellow-Email / X-Fellow-Password headers
 *   - No state persisted server-side
 *   - Profile schema validated client-side before calling Fellow's API
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";

import { clientFromHeaders } from "./auth.js";
import { profileInputSchema, checkPulseConsistency } from "./validation.js";
import { FellowApiError } from "./fellow-api.js";

const VERSION = "0.1.0";

function makeServer(headers: Headers): McpServer {
  const server = new McpServer({
    name: "aiden-mcp",
    version: VERSION,
  });

  // ============================================================
  // list_profiles
  // ============================================================
  server.tool(
    "list_profiles",
    "List all brew profiles currently on your Fellow Aiden. Returns profile id, title, and key brew parameters. Use this to find a profile to delete or share.",
    {},
    async () => {
      const client = clientFromHeaders(headers);
      await client.authenticate();
      const device = await client.getDevice();
      const profiles = await client.listProfiles();

      const lines = [
        `Aiden: ${device.displayName ?? "Aiden"} (${profiles.length}/14 profile slots used)`,
        "",
        ...profiles.map(
          (p) =>
            `  ${p.id ?? "(no id)"}  ${p.title}  —  1:${p.ratio} ratio, ${p.bloomTemperature}°C bloom, SS ${p.ssPulseTemperatures.join("/")}°C`,
        ),
      ];

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
      // Re-validate (zod has already enforced ranges, but double-check pulse consistency)
      const parsed = profileInputSchema.parse(input);
      const consistencyErrors = checkPulseConsistency(parsed);
      if (consistencyErrors.length) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Profile validation failed:\n  ${consistencyErrors.join("\n  ")}`,
            },
          ],
        };
      }

      const client = clientFromHeaders(headers);
      await client.authenticate();
      const created = await client.createProfile(parsed);
      const link = await client.shareProfile(created.id!);

      return {
        content: [
          {
            type: "text",
            text:
              `Created profile "${created.title}" (id: ${created.id}).\n` +
              `brew.link: ${link}\n\n` +
              `Tap the link in the Fellow iOS app to load the profile, or scan the QR code Fellow generates.`,
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
      const client = clientFromHeaders(headers);
      await client.authenticate();
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
        content: [
          {
            type: "text",
            text: `Deleted profile "${profile.title}" (id: ${profile.id}).`,
          },
        ],
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
      const client = clientFromHeaders(headers);
      await client.authenticate();
      const profile = await client.findProfile(idOrTitle);
      if (!profile) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `No profile matched "${idOrTitle}". Run list_profiles first.`,
            },
          ],
        };
      }
      const link = await client.shareProfile(profile.id!);
      return {
        content: [
          {
            type: "text",
            text: `brew.link for "${profile.title}": ${link}`,
          },
        ],
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
      const client = clientFromHeaders(headers);
      await client.authenticate();
      const device = await client.getDevice();
      const profiles = await client.listProfiles();
      return {
        content: [
          {
            type: "text",
            text:
              `Device: ${device.displayName ?? "Aiden"}\n` +
              `ID: ${device.id}\n` +
              `Profiles: ${profiles.length}/14`,
          },
        ],
      };
    },
  );

  return server;
}

// ============================================================
// Worker entry point — Streamable HTTP transport
// ============================================================
export default {
  async fetch(request: Request, env: unknown, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // Health check / root
    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
      return new Response(
        JSON.stringify(
          {
            name: "aiden-mcp",
            version: VERSION,
            description:
              "MCP server for Fellow Aiden brewer. Unofficial — not affiliated with Fellow Industries.",
            transport: "streamable-http",
            mcp_endpoint: "/mcp",
            docs: "https://github.com/ravenintheforrest/aiden-mcp",
          },
          null,
          2,
        ),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    // MCP endpoint
    if (url.pathname === "/mcp" || url.pathname === "/sse") {
      try {
        const transport = new WebStandardStreamableHTTPServerTransport({
          sessionIdGenerator: undefined, // stateless mode
          enableJsonResponse: true, // simpler for one-shot tool calls
        });
        const server = makeServer(request.headers);
        await server.connect(transport);

        return await transport.handleRequest(request);
      } catch (err) {
        if (err instanceof FellowApiError) {
          return new Response(
            JSON.stringify({ error: err.message, status: err.status }),
            { status: err.status ?? 500, headers: { "Content-Type": "application/json" } },
          );
        }
        const message = err instanceof Error ? err.message : "Unknown error";
        return new Response(JSON.stringify({ error: message }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        });
      }
    }

    return new Response("Not Found", { status: 404 });
  },
};
