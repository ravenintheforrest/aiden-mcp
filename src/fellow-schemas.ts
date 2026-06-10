/**
 * Response-shape contracts for Fellow's private API.
 *
 * The API is undocumented and has no changelog, so we defend two ways:
 *
 *  1. diffProfileEcho() — on every create/update, compare what Fellow says
 *     it saved against what we sent. Catches the nastiest failure mode:
 *     Fellow renames/drops a field, keeps returning an id, the push
 *     "succeeds", and the user brews with wrong parameters. The diff turns
 *     that into a loud warning instead of a silent bad brew.
 *
 *  2. Strict Zod schemas — used by the scheduled canary (src/canary.ts) to
 *     detect shape drift on a schedule, before users hit it. These are
 *     intentionally NOT enforced on the user request path: extra strictness
 *     there would itself be a fragility (a harmless additive change
 *     shouldn't break brews).
 */

import { z } from "zod";

// ============================================================
// Echo verification (request path, create/update)
// ============================================================

/** Fellow rounds scalars to 0.5 increments — max legitimate delta is 0.25. */
const ECHO_TOLERANCE = 0.3;

function show(v: unknown): string {
  if (v === undefined) return "(field missing)";
  if (v === null) return "null";
  return JSON.stringify(v);
}

function numbersMatch(sent: number, got: unknown): boolean {
  return typeof got === "number" && Math.abs(got - sent) <= ECHO_TOLERANCE;
}

/**
 * The fields a user can taste — the contract we hold Fellow to on echo.
 * Anything outside this list (profileType, server timestamps, fields we
 * merely round-trip on update) is server-managed and excluded so it can't
 * generate false drift warnings.
 */
const PROFILE_ECHO_KEYS = [
  "title",
  "ratio",
  "bloomEnabled",
  "bloomRatio",
  "bloomDuration",
  "bloomTemperature",
  "ssPulsesEnabled",
  "ssPulsesNumber",
  "ssPulsesInterval",
  "ssPulseTemperatures",
  "batchPulsesEnabled",
  "batchPulsesNumber",
  "batchPulsesInterval",
  "batchPulseTemperatures",
];

/**
 * Compare the profile we sent against the one Fellow echoed back.
 * Returns human-readable mismatch lines; empty array means the echo matches.
 *
 * If the response stops echoing profile fields entirely (structural drift),
 * returns a single structural warning instead of one line per field.
 */
export function diffProfileEcho(
  sent: Record<string, unknown>,
  received: Record<string, unknown>,
): string[] {
  const keys = PROFILE_ECHO_KEYS.filter((k) => sent[k] != null);

  const echoedCount = keys.filter((k) => received[k] !== undefined).length;
  if (echoedCount < 3) {
    return [
      "Fellow's response no longer echoes the saved profile fields (possible API change) — can't verify the push landed with the right values. Check the profile in the Fellow app.",
    ];
  }

  const issues: string[] = [];
  for (const key of keys) {
    const sentVal = sent[key];
    const got = received[key];

    if (typeof sentVal === "number") {
      if (!numbersMatch(sentVal, got)) {
        issues.push(`${key}: sent ${sentVal}, Fellow saved ${show(got)}`);
      }
    } else if (typeof sentVal === "boolean") {
      if (got !== sentVal) {
        issues.push(`${key}: sent ${sentVal}, Fellow saved ${show(got)}`);
      }
    } else if (Array.isArray(sentVal)) {
      const ok =
        Array.isArray(got) &&
        got.length === sentVal.length &&
        sentVal.every((v, i) => (typeof v === "number" ? numbersMatch(v, got[i]) : got[i] === v));
      if (!ok) {
        issues.push(`${key}: sent ${JSON.stringify(sentVal)}, Fellow saved ${show(got)}`);
      }
    } else if (typeof sentVal === "string") {
      if (typeof got !== "string" || got.trim() !== sentVal.trim()) {
        issues.push(`${key}: sent ${show(sentVal)}, Fellow saved ${show(got)}`);
      }
    }
  }
  return issues;
}

// ============================================================
// Strict canary schemas
// ============================================================

const num = z.number();
const bool = z.boolean();

export const loginResponseSchema = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1),
});

export const deviceSchema = z.object({
  id: z.string().min(1),
});

/**
 * Full contract for user-created (p*) profiles. Stock/shared profiles are
 * known to carry null fields, so the canary only strict-checks custom ones.
 *
 * Values carry plausibility bounds, not just types — custom profiles are
 * written through our own validation (validation.ts ranges), so anything
 * stored outside those ranges means the server re-scaled the data (e.g. a
 * °C→°F unit migration). Shape-stable semantic drift is the class plain
 * schema checks can't see; bounds catch the migrated-data half of it.
 */
const temp = z.number().min(50).max(99); // °C — a °F migration lands at 122+
export const customProfileSchema = z.object({
  id: z.string().regex(/^p\d+$/),
  title: z.string(),
  ratio: z.number().min(14).max(20),
  bloomEnabled: bool,
  bloomRatio: z.number().min(1).max(3),
  bloomDuration: z.number().min(1).max(120),
  bloomTemperature: temp,
  ssPulsesEnabled: bool,
  ssPulsesNumber: z.number().min(1).max(10),
  ssPulsesInterval: z.number().min(5).max(60),
  ssPulseTemperatures: z.array(temp).min(1),
  batchPulsesEnabled: bool,
  batchPulsesNumber: z.number().min(1).max(10),
  batchPulsesInterval: z.number().min(5).max(60),
  batchPulseTemperatures: z.array(temp).min(1),
});

export const scheduleSchema = z.object({
  id: z.string().min(1),
  days: z.array(bool).length(7),
  secondFromStartOfTheDay: num.min(0).max(86399), // a ms migration lands at 86400+
  enabled: bool,
  amountOfWater: num.min(150).max(1500), // ml — an oz/l migration leaves this band
  profileId: z.string().min(1),
});

/** Flatten a Zod error into "path: message" lines for canary reports. */
export function zodIssues(prefix: string, error: z.ZodError): string[] {
  return error.issues.map((i) => `${prefix}${i.path.length ? "." + i.path.join(".") : ""}: ${i.message}`);
}
