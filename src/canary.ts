/**
 * Scheduled API-drift canary.
 *
 * Fellow's API is undocumented with no changelog — when they ship an app
 * update, an endpoint can quietly change shape and the first signal would
 * otherwise be a user's GitHub issue weeks later. So on a cron schedule the
 * Worker logs into a dedicated canary account, exercises every endpoint the
 * MCP tools depend on, and strict-validates each response against the
 * contracts in fellow-schemas.ts.
 *
 * Findings are fingerprinted in KV so the webhook only fires on CHANGE
 * (new drift, or recovery) — not every 6 hours forever.
 *
 * Configuration (all optional — canary no-ops if creds are unset):
 *   wrangler secret put CANARY_FELLOW_EMAIL      # dedicated Fellow account
 *   wrangler secret put CANARY_FELLOW_PASSWORD
 *   wrangler secret put CANARY_WEBHOOK_URL       # Slack/Discord-compatible
 *   wrangler secret put CANARY_WRITE             # "true" → also test create/delete
 *
 * The write check creates a profile named "Canary (auto-delete)", verifies
 * the echo, and deletes it. It is skipped when the account is at the
 * 14-profile cap, and a failed cleanup is itself reported as a finding.
 */

import { FellowClient, FellowProfile, categorize } from "./fellow-api.js";
import {
  loginResponseSchema,
  deviceSchema,
  customProfileSchema,
  scheduleSchema,
  diffProfileEcho,
  zodIssues,
} from "./fellow-schemas.js";
import type { Env } from "./oauth/kv.js";

const FINGERPRINT_KEY = "canary:fingerprint";
const LAST_REPORT_KEY = "canary:last";

const CANARY_PROFILE: Omit<FellowProfile, "id"> = {
  profileType: 0,
  title: "Canary (auto-delete)",
  ratio: 15,
  bloomEnabled: true,
  bloomRatio: 2,
  bloomDuration: 45,
  bloomTemperature: 93,
  ssPulsesEnabled: true,
  ssPulsesNumber: 3,
  ssPulsesInterval: 20,
  ssPulseTemperatures: [93, 92, 91],
  batchPulsesEnabled: true,
  batchPulsesNumber: 2,
  batchPulsesInterval: 25,
  batchPulseTemperatures: [92, 91],
};

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function runCanary(env: Env): Promise<void> {
  if (!env.CANARY_FELLOW_EMAIL || !env.CANARY_FELLOW_PASSWORD) {
    console.log("canary: skipped (CANARY_FELLOW_EMAIL/PASSWORD not set)");
    return;
  }

  const findings: string[] = [];
  const client = new FellowClient(env.CANARY_FELLOW_EMAIL, env.CANARY_FELLOW_PASSWORD);

  // ---- login ----
  try {
    await client.authenticate();
    const parsed = loginResponseSchema.safeParse({
      accessToken: client.getToken(),
      refreshToken: client.refreshToken,
    });
    if (!parsed.success) findings.push(...zodIssues("login", parsed.error));
  } catch (err) {
    findings.push(`login: ${errMsg(err)}`);
    await report(env, findings); // nothing else can run without auth
    return;
  }

  // ---- devices ----
  let haveDevice = false;
  try {
    const device = await client.getDevice();
    const parsed = deviceSchema.safeParse(device);
    if (!parsed.success) findings.push(...zodIssues("devices", parsed.error));
    else haveDevice = true;
  } catch (err) {
    findings.push(`devices: ${errMsg(err)}`);
  }

  // ---- profiles (read) ----
  let customCount = 0;
  if (haveDevice) {
    try {
      const profiles = await client.listProfiles();
      if (!Array.isArray(profiles) || profiles.length === 0) {
        findings.push("profiles: expected a non-empty array (stock profiles should always exist)");
      } else {
        const custom = profiles.filter((p) => categorize(p) === "custom");
        customCount = custom.length;
        for (const p of custom) {
          const parsed = customProfileSchema.safeParse(p);
          if (!parsed.success) findings.push(...zodIssues(`profiles[${p.id}]`, parsed.error));
        }
      }
    } catch (err) {
      findings.push(`profiles: ${errMsg(err)}`);
    }

    // ---- schedules (read) ----
    try {
      const schedules = await client.listSchedules();
      if (!Array.isArray(schedules)) {
        findings.push("schedules: expected an array");
      } else {
        for (const s of schedules) {
          const parsed = scheduleSchema.safeParse(s);
          if (!parsed.success) findings.push(...zodIssues(`schedules[${s.id}]`, parsed.error));
        }
      }
    } catch (err) {
      findings.push(`schedules: ${errMsg(err)}`);
    }

    // ---- write path (opt-in) ----
    if (env.CANARY_WRITE === "true") {
      if (customCount >= 14) {
        console.log("canary: write check skipped (account at profile cap)");
      } else {
        await checkWritePath(client, findings);
      }
    }
  }

  await report(env, findings);
}

async function checkWritePath(client: FellowClient, findings: string[]): Promise<void> {
  let createdId: string | undefined;
  try {
    const created = await client.createProfile(CANARY_PROFILE);
    createdId = created.id;
    const drift = diffProfileEcho(
      CANARY_PROFILE as unknown as Record<string, unknown>,
      created as unknown as Record<string, unknown>,
    );
    findings.push(...drift.map((d) => `create echo — ${d}`));
  } catch (err) {
    findings.push(`create: ${errMsg(err)}`);
  }
  if (createdId) {
    try {
      await client.deleteProfile(createdId);
    } catch (err) {
      findings.push(`delete: ${errMsg(err)} — canary profile "${CANARY_PROFILE.title}" (${createdId}) left behind, remove manually`);
    }
  }
}

async function report(env: Env, findings: string[]): Promise<void> {
  const fingerprint = findings.length ? findings.join("|") : "ok";
  const previous = await env.AIDEN_OAUTH.get(FINGERPRINT_KEY);

  await env.AIDEN_OAUTH.put(
    LAST_REPORT_KEY,
    JSON.stringify({ at: new Date().toISOString(), ok: findings.length === 0, findings }),
  );

  if (findings.length) {
    console.error(`canary: ${findings.length} finding(s)\n${findings.map((f) => `  - ${f}`).join("\n")}`);
  } else {
    console.log("canary: ok — Fellow API matches expected contracts");
  }

  if (previous === fingerprint) return; // no change since last run — stay quiet
  await env.AIDEN_OAUTH.put(FINGERPRINT_KEY, fingerprint);
  // First-ever run with no drift: record the baseline silently.
  if (previous === null && fingerprint === "ok") return;

  const message =
    fingerprint === "ok"
      ? "✅ aiden-mcp canary: recovered — Fellow API back to expected shape"
      : `🚨 aiden-mcp canary: Fellow API drift detected (${findings.length} finding(s))\n${findings
          .map((f) => `• ${f}`)
          .join("\n")}`;

  if (env.CANARY_WEBHOOK_URL) {
    try {
      // `text` is read by Slack, `content` by Discord; each ignores the other.
      await fetch(env.CANARY_WEBHOOK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: message, content: message }),
      });
    } catch (err) {
      console.error(`canary: webhook delivery failed: ${errMsg(err)}`);
    }
  }
}
