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

import { clientFromHeaders, NoCredentialsError, ExpiredTokenError } from "./auth.js";
import { profileInputSchema, checkPulseConsistency } from "./validation.js";
import { FellowApiError, categorize, CUSTOM_PROFILE_CAP } from "./fellow-api.js";
import { diffProfileEcho } from "./fellow-schemas.js";
import { fetchCoffeeDetails } from "./coffee-fetcher.js";
import { brewingGuidelines } from "./brewing-guidelines.js";
import { flashBrewPlan } from "./flash-brew.js";
import { SUPPORTED_GRINDERS } from "./grinders.js";
import { runCanary } from "./canary.js";
import {
  protectedResourceMetadata,
  authorizationServerMetadata,
} from "./oauth/discovery.js";
import { handleRegister } from "./oauth/register.js";
import { handleAuthorizeGet, handleAuthorizePost } from "./oauth/authorize.js";
import { handleToken } from "./oauth/token.js";
import { Env } from "./oauth/kv.js";

const VERSION = "0.5.2";

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

      // Verify Fellow saved what we sent. The API is undocumented — if a
      // field gets renamed/dropped server-side, the create still returns an
      // id and would otherwise look like a success while brewing with wrong
      // parameters. Surface any mismatch loudly.
      const drift = diffProfileEcho(parsed, created as unknown as Record<string, unknown>);

      const link = await client.shareProfile(created.id!);

      let text =
        `Created profile "${created.title}" (id: ${created.id}).\n` +
        `The profile is now on your Aiden — walk over and brew it directly, no extra step needed.\n\n` +
        `brew.link (optional, for sharing or QR-scanning at the device): ${link}`;
      if (drift.length) {
        text +=
          `\n\n⚠ IMPORTANT — Fellow saved different values than were sent (possible API change). ` +
          `Tell the user to verify the profile in the Fellow app before brewing:\n` +
          drift.map((d) => `  - ${d}`).join("\n");
      }

      return {
        content: [{ type: "text", text }],
      };
    },
  );

  // ============================================================
  // update_profile — dial in an existing recipe in place
  // ============================================================
  server.tool(
    "update_profile",
    "Update an existing brew profile on your Aiden in place. Pass the profile id (or exact title) plus ANY subset of the profile fields you want to change — unspecified fields keep their current values. Useful for dialing in an existing recipe (e.g. nudge ratio, drop a temperature) without delete-and-recreate. The brew.link URL stays the same since the profile id doesn't change.",
    {
      idOrTitle: z
        .string()
        .min(1)
        .describe("Profile id (e.g. 'p1') or exact case-sensitive title (e.g. 'Mpemba v3')"),
      title: z.string().min(1).max(50).optional().describe("New title (optional)"),
      ratio: z.coerce.number().min(14).max(20).optional(),
      bloomEnabled: z.coerce.boolean().optional(),
      bloomRatio: z.coerce.number().min(1).max(3).optional(),
      bloomDuration: z.coerce.number().int().min(1).max(120).optional(),
      bloomTemperature: z.coerce.number().min(50).max(99).optional(),
      ssPulsesEnabled: z.coerce.boolean().optional(),
      ssPulsesNumber: z.coerce.number().int().min(1).max(10).optional(),
      ssPulsesInterval: z.coerce.number().int().min(5).max(60).optional(),
      ssPulseTemperatures: z
        .preprocess((v) => (typeof v === "string" ? JSON.parse(v) : v), z.array(z.coerce.number().min(50).max(99)))
        .optional(),
      batchPulsesEnabled: z.coerce.boolean().optional(),
      batchPulsesNumber: z.coerce.number().int().min(1).max(10).optional(),
      batchPulsesInterval: z.coerce.number().int().min(5).max(60).optional(),
      batchPulseTemperatures: z
        .preprocess((v) => (typeof v === "string" ? JSON.parse(v) : v), z.array(z.coerce.number().min(50).max(99)))
        .optional(),
    },
    async (input) => {
      const { idOrTitle, ...changes } = input;
      const client = await clientFromHeaders(headers, env);
      const existing = await client.findProfile(idOrTitle);
      if (!existing) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `No profile matched "${idOrTitle}". Run list_profiles first — note that titles are case-sensitive.`,
            },
          ],
        };
      }
      // Merge changes with the existing profile so unspecified fields keep their values
      const merged = { ...existing, ...changes };
      // Drop the id from the body — it's in the URL path
      const { id, ...body } = merged;

      // Sanity: keep pulse counts and temperature arrays consistent
      const consistencyErrors = checkPulseConsistency({
        ...body,
        // zod parsed the optional fields, so set defaults the validator expects
        bloomEnabled: body.bloomEnabled ?? true,
        ssPulsesEnabled: body.ssPulsesEnabled ?? true,
        batchPulsesEnabled: body.batchPulsesEnabled ?? true,
        profileType: body.profileType ?? 0,
      } as never);
      if (consistencyErrors.length) {
        return {
          isError: true,
          content: [
            { type: "text", text: `Update would create inconsistent profile:\n  ${consistencyErrors.join("\n  ")}` },
          ],
        };
      }

      const updated = await client.updateProfile(
        existing.id!,
        body as Omit<typeof existing, "id">,
      );
      // Same echo verification as create_profile — catch the API silently
      // ignoring fields rather than reporting a clean update.
      const drift = diffProfileEcho(
        body as Record<string, unknown>,
        updated as unknown as Record<string, unknown>,
      );
      const changedFields = Object.keys(changes);
      let text =
        `Updated "${updated.title}" (id: ${existing.id}).\n` +
        `Changed: ${changedFields.length ? changedFields.join(", ") : "(no field changes — title only)"}\n` +
        `Profile id unchanged, so existing brew.link still works.`;
      if (drift.length) {
        text +=
          `\n\n⚠ IMPORTANT — Fellow saved different values than were sent (possible API change). ` +
          `Tell the user to verify the profile in the Fellow app before brewing:\n` +
          drift.map((d) => `  - ${d}`).join("\n");
      }
      return {
        content: [{ type: "text", text }],
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
    "Get Aiden-specific brewing guidelines tailored to a coffee's characteristics. Returns brewing principles + a starting-point recipe. Use this AFTER fetching coffee details (or when user provides them directly), then design the actual create_profile call using the returned principles. IMPORTANT: if the user already has a profile made for this exact coffee (Fellow Drops or a roaster-shared profile), do NOT redesign it from these principles — it was dialed by people who tasted this coffee. Adjust it one variable at a time (1–2°C max) toward what the user disliked. Does NOT require Aiden auth.",
    {
      process: z.string().optional().describe("Process: washed, natural, honey, anaerobic, etc."),
      roast: z
        .string()
        .optional()
        .describe(
          "Roast level from the bag: light, medium-light, medium, medium-dark, dark. The strongest temperature driver in expert profiles — ASK the user if not stated.",
        ),
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
      grinder: z
        .string()
        .optional()
        .describe(
          `User's grinder, so the grind setting comes back on their dial instead of the Baratza Encore reference scale. Supported: ${SUPPORTED_GRINDERS.join(", ")}. ASK the user what grinder they have if they haven't said.`,
        ),
      brew_basket: z
        .string()
        .optional()
        .describe(
          "Only for modded brew chambers: 'v60', 'orea', or 'kalita' if the user has swapped the stock flat-bottom basket for a dripper via an adapter. Omit for a stock Aiden. Adjusts grind and pulse pacing for the different drawdown geometry.",
        ),
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
  // flash_brew — Japanese iced coffee calculator (dose-trick math)
  // ============================================================
  server.tool(
    "flash_brew",
    "Plan a flash brew (Japanese iced coffee) on the Aiden: a hot, concentrated brew directly onto ice in the carafe. The Aiden's 1:14-1:20 ratio range can't express the 1:9-1:12 hot concentrate flash brew needs, so this computes the standard workaround: what brew volume to dial in, what dose the machine will DISPLAY, and what to ACTUALLY add. Returns the ice/water split, real vs displayed dose, grind adjustment, and technique steps. Pure math, no Aiden auth. Use brewing_guidelines first for the coffee's profile temps.",
    {
      dose_g: z.coerce.number().min(10).max(120).optional().describe("Coffee the user wants to use, in grams. Provide this OR target_volume_ml."),
      target_volume_ml: z.coerce.number().min(150).max(2000).optional().describe("Final drink size in ml (ice melt included). Used to derive the dose if dose_g not given."),
      total_ratio: z.coerce.number().min(10).max(20).optional().describe("True ratio including ice melt. Default 15 (Counter Culture uses 17, Lance Hedrick 12 — lower = stronger)."),
      ice_fraction: z.coerce.number().min(0.1).max(0.5).optional().describe("Share of total liquid that is ice in the carafe. Default 0.3; published recipes use 0.25-0.33."),
      machine_profile_ratio: z.coerce.number().min(14).max(20).optional().describe("The ratio of the profile they'll brew with (default 16) — used to predict the dose the machine will display."),
      grinder: z.string().optional().describe("User's grinder, to convert the flash-brew grind setting to their dial."),
    },
    async (input) => {
      const plan = flashBrewPlan(input);
      const lines = [...plan.lines];
      if (plan.warnings.length) {
        lines.push("", "Warnings:", ...plan.warnings.map((w) => `  ⚠ ${w}`));
      }
      return { content: [{ type: "text", text: lines.join("\n") }] };
    },
  );

  // ============================================================
  // list_schedules
  // ============================================================
  server.tool(
    "list_schedules",
    "List all scheduled brews on your Aiden, including the raw JSON. Each schedule has a recurrence pattern (which days of the week), a time of day, a profile to brew, and a water amount. Schedules can be enabled/disabled individually. Raw JSON helps diagnose any non-standard fields the device or iOS app may set (e.g. one-shot markers).",
    {},
    async () => {
      const client = await clientFromHeaders(headers, env);
      const schedules = (await client.listSchedules()) as unknown as Array<Record<string, unknown>>;
      if (!schedules.length) {
        return { content: [{ type: "text", text: "No scheduled brews on this Aiden." }] };
      }
      const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
      const fmt = (s: Record<string, unknown>) => {
        const days = (s.days as boolean[] | undefined)
          ?.map((on, i) => (on ? dayNames[i] : null))
          .filter(Boolean)
          .join(",");
        const sec = (s.secondFromStartOfTheDay as number | undefined) ?? 0;
        const hh = Math.floor(sec / 3600);
        const mm = Math.floor((sec % 3600) / 60);
        const time = `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
        const status = s.enabled ? "enabled" : "disabled";
        return `  ${s.id ?? "(no id)"}  ${days || "no days"}  ${time}  ${s.amountOfWater}mL  profile:${s.profileId}  [${status}]`;
      };
      return {
        content: [
          {
            type: "text",
            text:
              `Schedules (${schedules.length}, device local time):\n` +
              schedules.map(fmt).join("\n") +
              "\n\nRaw JSON (useful for spotting non-standard fields like one-shot markers):\n" +
              JSON.stringify(schedules, null, 2),
          },
        ],
      };
    },
  );

  // ============================================================
  // create_schedule
  // ============================================================
  server.tool(
    "create_schedule",
    "Create a scheduled brew on your Aiden. The Aiden hardware fires the brew at the specified time on the specified days. Time is in DEVICE LOCAL TIME (the timezone configured on the brewer). The schedule is RECURRING — for a one-time 'today at 2pm' brew, set days[] with only today's day enabled, and either delete the schedule after it fires or use toggle_schedule to disable it. Days array indexes: [Sunday, Monday, Tuesday, Wednesday, Thursday, Friday, Saturday]. Find the profileId by calling list_profiles first.",
    {
      profileId: z
        .string()
        .regex(/^(p|plocal)\d+$/, "profileId must look like 'p7' or 'plocal2'")
        .describe("Profile id from list_profiles, e.g. 'p1' for Mpemba v3 or 'plocal0' for Light Roast"),
      time: z
        .string()
        .regex(/^([01]?\d|2[0-3]):[0-5]\d$/, "time must be 24-hour HH:MM, e.g. '07:30' or '14:00'")
        .describe("Local time of day in 24-hour HH:MM format, e.g. '07:00' for 7am, '14:00' for 2pm"),
      days: z
        .array(z.coerce.boolean())
        .length(7, "days must have exactly 7 entries [Sun, Mon, Tue, Wed, Thu, Fri, Sat]")
        .describe(
          "7 booleans for [Sun, Mon, Tue, Wed, Thu, Fri, Sat]. e.g. [false,true,true,true,true,true,false] = weekdays only.",
        ),
      amountOfWater: z
        .coerce.number()
        .int()
        .min(150, "minimum 150 mL")
        .max(1500, "maximum 1500 mL")
        .describe("Brew volume in milliliters, 150–1500. A standard cup is ~240mL, full carafe is ~1000mL."),
      enabled: z.coerce.boolean().default(true).describe("Whether the schedule starts active. Default: true."),
    },
    async ({ profileId, time, days, amountOfWater, enabled }) => {
      const [hh, mm] = time.split(":").map(Number);
      const secondFromStartOfTheDay = hh * 3600 + mm * 60;
      const client = await clientFromHeaders(headers, env);
      const created = await client.createSchedule({
        profileId,
        secondFromStartOfTheDay,
        days,
        amountOfWater,
        enabled,
      });
      const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
      const dayList = days.map((on, i) => (on ? dayNames[i] : null)).filter(Boolean).join(",") || "(no days)";
      const onlyOneDay = days.filter(Boolean).length === 1;
      const oneShotNote = onlyOneDay
        ? "\n\n⚠ One-shot caveat: This is a recurring weekly schedule with one day enabled. It will fire again next week on the same day. After it fires today, call delete_schedule or toggle_schedule(enabled=false) to prevent that — or remind the user to do so."
        : "";
      const tzNote =
        "\n\n⚠ Time zone: " + time + " is in the brewer's local time, set on the Aiden device itself. Verify the device clock matches the user's wall clock before relying on this for time-critical brews.";
      return {
        content: [
          {
            type: "text",
            text:
              `Scheduled brew created (id: ${created.id}).\n` +
              `Profile ${profileId} will brew ${amountOfWater}mL at ${time} on ${dayList} (device local time).\n` +
              `${enabled ? "Active" : "Disabled — call toggle_schedule to enable when ready"}.` +
              tzNote +
              oneShotNote,
          },
        ],
      };
    },
  );

  // ============================================================
  // delete_schedule
  // ============================================================
  server.tool(
    "delete_schedule",
    "Delete a scheduled brew by its id. Use list_schedules first to find the id.",
    {
      scheduleId: z.string().min(1).describe("Schedule id from list_schedules"),
    },
    async ({ scheduleId }) => {
      const client = await clientFromHeaders(headers, env);
      await client.deleteSchedule(scheduleId);
      return { content: [{ type: "text", text: `Deleted schedule ${scheduleId}.` }] };
    },
  );

  // ============================================================
  // toggle_schedule
  // ============================================================
  server.tool(
    "toggle_schedule",
    "Enable or disable an existing scheduled brew without deleting it. Useful for pausing a recurring schedule (e.g. weekday morning brew) during vacation.",
    {
      scheduleId: z.string().min(1).describe("Schedule id from list_schedules"),
      enabled: z.coerce.boolean().describe("true to activate the schedule, false to pause it"),
    },
    async ({ scheduleId, enabled }) => {
      const client = await clientFromHeaders(headers, env);
      await client.toggleSchedule(scheduleId, enabled);
      return {
        content: [
          { type: "text", text: `Schedule ${scheduleId} ${enabled ? "enabled" : "disabled"}.` },
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
  /**
   * Cron-triggered API-drift canary (see src/canary.ts and wrangler.toml
   * [triggers]). No-ops unless CANARY_* secrets are configured.
   */
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runCanary(env));
  },

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
          "update_profile",
          "delete_profile",
          "share_profile",
          "get_device_info",
          "list_schedules",
          "create_schedule",
          "delete_schedule",
          "toggle_schedule",
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
            // Both "no credentials" and "expired/invalid token" return HTTP 401
            // with WWW-Authenticate. This is what makes Claude attempt its
            // refresh-token grant (and fall back to re-auth only if that fails).
            // Returning 200 here would suppress refresh entirely.
            if (
              err instanceof ExpiredTokenError ||
              err instanceof NoCredentialsError ||
              (err instanceof FellowApiError && err.status === 401)
            ) {
              const desc = err instanceof Error ? err.message : "unauthorized";
              return new Response(
                JSON.stringify({ error: "invalid_token", error_description: desc }),
                {
                  status: 401,
                  headers: {
                    "Content-Type": "application/json",
                    "WWW-Authenticate": `Bearer realm="aiden-mcp", error="invalid_token", resource_metadata="${origin}/.well-known/oauth-protected-resource"`,
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
