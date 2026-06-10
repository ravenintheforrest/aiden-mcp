/**
 * Grind-setting conversions for common grinders.
 *
 * The brewing heuristics are calibrated against a Baratza Encore (40-step
 * dial), so the Encore number is the canonical scale. Each supported grinder
 * maps linearly from two anchor points (Encore 12 and Encore 20 — the band
 * the recipes actually use). Anchors come from manufacturer brew guides and
 * community conversion charts, sanity-checked against pourover ranges.
 *
 * These are STARTING POINTS. Burr wear, unit variance, and zero-point
 * calibration (hand grinders count clicks from burrs touching) all shift
 * the real number — the warnings returned alongside say so.
 */

export interface GrinderMatch {
  name: string;
  setting: string;
  note?: string;
}

interface GrinderSpec {
  name: string;
  match: RegExp;
  /** value at Encore 12 */
  lo: number;
  /** value at Encore 20 */
  hi: number;
  format: (v: number) => string;
  note?: string;
}

const intSetting = (v: number) => `${Math.round(v)}`;
const clicks = (v: number) => `~${Math.round(v)} clicks from zero (burrs touching)`;

/** Ode dials move in 1/3 steps — render 5.33 as "5⅓". */
function thirds(v: number): string {
  const whole = Math.floor(v + 1 / 6);
  const frac = Math.round((v - whole) * 3);
  if (frac <= 0) return `${whole}`;
  if (frac >= 3) return `${whole + 1}`;
  return `${whole}${frac === 1 ? "⅓" : "⅔"}`;
}

/** Opus dial moves in 1/4 steps. */
function quarters(v: number): string {
  const snapped = Math.round(v * 4) / 4;
  const whole = Math.floor(snapped);
  const frac = snapped - whole;
  if (frac === 0) return `${whole}`;
  return `${whole}${frac === 0.25 ? "¼" : frac === 0.5 ? "½" : "¾"}`;
}

/**
 * Order matters: more specific patterns (Encore ESP, Ode + SSP) must come
 * before the generic ones they'd otherwise false-match (Encore, Ode).
 */
const GRINDERS: GrinderSpec[] = [
  {
    name: "Baratza Encore ESP",
    match: /encore\s*esp/i,
    lo: 23,
    hi: 33,
    format: intSetting,
    note: "The ESP's brew range lives in the upper half of the dial (21–40).",
  },
  {
    name: "Baratza Encore",
    match: /encore|baratza(?!.*(virtuoso|vario|sette))/i,
    lo: 12,
    hi: 20,
    format: intSetting,
  },
  {
    name: "Baratza Virtuoso+",
    match: /virtuoso/i,
    lo: 12,
    hi: 20,
    format: intSetting,
    note: "Tracks the Encore scale closely — same number is the right starting point.",
  },
  {
    name: "Fellow Ode + SSP MP burrs",
    match: /(ssp|spp)/i,
    lo: 6.5,
    hi: 9.5,
    format: thirds,
    note: "SSP multi-purpose burrs trade body for clarity — you can run finer than stock-burr equivalents without muddying the cup.",
  },
  {
    name: "Fellow Ode Gen 2",
    match: /ode\s*(gen\s*)?2/i,
    lo: 4,
    hi: 7,
    format: thirds,
  },
  {
    name: "Fellow Ode Gen 1",
    match: /ode/i,
    lo: 2.5,
    hi: 5.5,
    format: thirds,
    note: "Gen 1 grinds coarser than Gen 2 at the same number.",
  },
  {
    name: "Fellow Opus",
    match: /opus/i,
    lo: 6,
    hi: 8.5,
    format: quarters,
  },
  {
    name: "Comandante C40",
    match: /comandante|c40/i,
    lo: 18,
    hi: 26,
    format: clicks,
  },
  {
    name: "1Zpresso J/JX",
    match: /1\s*z\s*presso|1z|jx\b/i,
    lo: 66,
    hi: 90,
    format: (v) => `~${Math.round(v)} clicks (${(Math.round(v) / 30).toFixed(1)} rotations, 30 clicks/turn)`,
  },
  {
    name: "Timemore C2/C3",
    match: /timemore|\bc2\b|\bc3\b/i,
    lo: 16,
    hi: 24,
    format: clicks,
  },
  {
    name: "DF64",
    match: /df\s*64/i,
    lo: 55,
    hi: 75,
    format: intSetting,
  },
  {
    name: "Niche Zero",
    match: /niche/i,
    lo: 50,
    hi: 72,
    format: intSetting,
  },
];

export const SUPPORTED_GRINDERS = GRINDERS.map((g) => g.name);

/**
 * Convert an Encore setting to the user's grinder. Returns null when the
 * grinder string doesn't match anything we know — callers should fall back
 * to the Encore number and list SUPPORTED_GRINDERS.
 */
export function convertGrind(encoreSetting: number, grinder: string): GrinderMatch | null {
  const spec = GRINDERS.find((g) => g.match.test(grinder));
  if (!spec) return null;
  // Linear interpolation between the Encore-12 and Encore-20 anchors;
  // extrapolates safely for the 10–22 band the recipes stay inside.
  const t = (encoreSetting - 12) / 8;
  const value = spec.lo + t * (spec.hi - spec.lo);
  return { name: spec.name, setting: spec.format(value), note: spec.note };
}
