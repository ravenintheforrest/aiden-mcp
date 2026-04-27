import { z } from "zod";

/**
 * Aiden profile schema. Ranges are from the Fellow Aiden hardware spec
 * (also see: https://github.com/9b/fellow-aiden).
 *
 * Most values use 0.5 increments. We don't enforce stepping at the schema
 * level (Fellow rounds), but we enforce min/max so users get clear errors
 * client-side rather than a generic 400 from Fellow.
 */

const tempSchema = z
  .number()
  .min(50, "Temperature must be ≥ 50°C")
  .max(99, "Temperature must be ≤ 99°C");

export const profileInputSchema = z.object({
  title: z
    .string()
    .min(1, "Title required")
    .max(50, "Title max 50 characters")
    .regex(/^[A-Za-z0-9 _\-.,'’()&!]+$/, "Title contains unsupported characters"),

  ratio: z
    .number()
    .min(14, "Ratio must be ≥ 14 (1:14)")
    .max(20, "Ratio must be ≤ 20 (1:20)"),

  bloomEnabled: z.boolean().default(true),
  bloomRatio: z.number().min(1).max(3),
  bloomDuration: z.number().int().min(1).max(120),
  bloomTemperature: tempSchema,

  ssPulsesEnabled: z.boolean().default(true),
  ssPulsesNumber: z.number().int().min(1).max(10),
  ssPulsesInterval: z.number().int().min(5).max(60),
  ssPulseTemperatures: z
    .array(tempSchema)
    .min(1, "Need at least one SS pulse temperature")
    .max(10, "Max 10 SS pulses"),

  batchPulsesEnabled: z.boolean().default(true),
  batchPulsesNumber: z.number().int().min(1).max(10),
  batchPulsesInterval: z.number().int().min(5).max(60),
  batchPulseTemperatures: z
    .array(tempSchema)
    .min(1, "Need at least one batch pulse temperature")
    .max(10, "Max 10 batch pulses"),

  profileType: z.number().int().default(0),
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
