import { z } from "zod";

/**
 * Aiden profile schema. Ranges are from the Fellow Aiden hardware spec
 * (also see: https://github.com/9b/fellow-aiden).
 *
 * Most values use 0.5 increments. We don't enforce stepping at the schema
 * level (Fellow rounds), but we enforce min/max so users get clear errors
 * client-side rather than a generic 400 from Fellow.
 */

// Use z.coerce so scalars submitted as strings (some MCP clients normalize that
// way) get converted before validation. Booleans coerce strings "true"/"false"
// loosely — Boolean("false") would be true, so we handle string-form explicitly.
const tempSchema = z.coerce
  .number()
  .min(50, "Temperature must be ≥ 50°C")
  .max(99, "Temperature must be ≤ 99°C");

const boolish = z.preprocess(
  (v) => (typeof v === "string" ? v.toLowerCase() !== "false" && v !== "0" && v !== "" : v),
  z.boolean(),
);

const tempArray = z.preprocess(
  (v) => (typeof v === "string" ? JSON.parse(v) : v),
  z.array(tempSchema),
);

export const profileInputSchema = z.object({
  title: z
    .string()
    .min(1, "Title required")
    .max(50, "Title max 50 characters")
    .regex(/^[A-Za-z0-9 _\-.,'’()&!]+$/, "Title contains unsupported characters"),

  ratio: z.coerce.number().min(14, "Ratio must be ≥ 14 (1:14)").max(20, "Ratio must be ≤ 20 (1:20)"),

  bloomEnabled: boolish.default(true),
  bloomRatio: z.coerce.number().min(1).max(3),
  bloomDuration: z.coerce.number().int().min(1).max(120),
  bloomTemperature: tempSchema,

  ssPulsesEnabled: boolish.default(true),
  ssPulsesNumber: z.coerce.number().int().min(1).max(10),
  ssPulsesInterval: z.coerce.number().int().min(5).max(60),
  ssPulseTemperatures: tempArray.refine((a) => a.length >= 1 && a.length <= 10, {
    message: "1–10 SS pulse temperatures",
  }),

  batchPulsesEnabled: boolish.default(true),
  batchPulsesNumber: z.coerce.number().int().min(1).max(10),
  batchPulsesInterval: z.coerce.number().int().min(5).max(60),
  batchPulseTemperatures: tempArray.refine((a) => a.length >= 1 && a.length <= 10, {
    message: "1–10 batch pulse temperatures",
  }),

  profileType: z.coerce.number().int().default(0),
});

export type ProfileInput = z.infer<typeof profileInputSchema>;

/**
 * Validate that pulse counts match temperature array lengths.
 * Fellow's API will accept mismatches but the brewer can behave oddly.
 */
export function checkPulseConsistency(p: ProfileInput): string[] {
  const errors: string[] = [];
  if (p.ssPulsesNumber !== p.ssPulseTemperatures.length) {
    errors.push(
      `ssPulsesNumber (${p.ssPulsesNumber}) must match ssPulseTemperatures length (${p.ssPulseTemperatures.length})`,
    );
  }
  if (p.batchPulsesNumber !== p.batchPulseTemperatures.length) {
    errors.push(
      `batchPulsesNumber (${p.batchPulsesNumber}) must match batchPulseTemperatures length (${p.batchPulseTemperatures.length})`,
    );
  }
  return errors;
}
