/**
 * Flash brew (Japanese iced coffee) calculator for the Aiden.
 *
 * Flash brew = hot, concentrated brew directly onto ice. The Aiden can't do
 * it natively: profile ratios clamp to 1:14-1:20, and the machine doses
 * water from the profile ratio, so the 1:9-1:12 hot concentrate flash brew
 * needs is out of reach honestly. The workaround every owner uses is to
 * under-report the dose: dial in the hot-water volume, ignore the coffee
 * amount the machine displays, and add more than it asked for. This tool
 * does that arithmetic so the numbers land right on the first try.
 *
 * Grounded in two published recipes:
 *   - Counter Culture flash brew guide: 1:17 total, ~27% ice, grind slightly
 *     finer than hot, keep brew time normal
 *   - Lance Hedrick's ultimate flash brew: 1:12 total, 25% ice, medium-fine
 *     grind, 93°C
 * Consensus encoded: 25-33% of total liquid as ice, grind ~2 settings finer
 * than the hot recipe, profile temps stay on the hot end for the roast (ice
 * halts extraction instantly, so bitterness risk is low).
 */

import { convertGrind } from "./grinders.js";

export interface FlashBrewInput {
  dose_g?: number;
  target_volume_ml?: number;
  total_ratio?: number; // true ratio incl. ice melt; default 15
  ice_fraction?: number; // share of total liquid that is ice; default 0.3
  machine_profile_ratio?: number; // the profile's ratio, to predict the displayed dose; default 16
  grinder?: string;
}

export interface FlashBrewPlan {
  lines: string[];
  warnings: string[];
}

const round5 = (v: number) => Math.round(v / 5) * 5;

export function flashBrewPlan(input: FlashBrewInput): FlashBrewPlan {
  const warnings: string[] = [];
  const totalRatio = input.total_ratio ?? 15;
  const iceFraction = input.ice_fraction ?? 0.3;
  const machineRatio = input.machine_profile_ratio ?? 16;

  if (!input.dose_g && !input.target_volume_ml) {
    return {
      lines: ["Need either dose_g (coffee you want to use) or target_volume_ml (final drink size) to plan a flash brew."],
      warnings: [],
    };
  }

  const dose = input.dose_g ?? (input.target_volume_ml ?? 0) / totalRatio;
  const total = dose * totalRatio;
  const ice = round5(total * iceFraction);
  const hot = round5(total - ice);
  const displayedDose = hot / machineRatio;
  const effectiveHotRatio = hot / dose;

  if (iceFraction < 0.2 || iceFraction > 0.4) {
    warnings.push(
      `Ice fraction ${Math.round(iceFraction * 100)}% is outside the 25-33% band the published recipes use. Less ice risks a lukewarm drink; more dilutes the concentrate past what the tighter ratio compensates for.`,
    );
  }
  if (hot < 150) {
    warnings.push(
      `Hot water volume (${hot}ml) is below the Aiden's 150ml minimum. Raise the dose, raise total_ratio, or lower ice_fraction.`,
    );
  }
  if (hot > 1500) {
    warnings.push(`Hot water volume (${hot}ml) exceeds the Aiden's 1500ml max. Split into two brews.`);
  }
  if (effectiveHotRatio < 8) {
    warnings.push(
      `Effective hot ratio 1:${effectiveHotRatio.toFixed(1)} is very concentrated. Below ~1:8 the bed can stall with a fine grind; consider lowering ice_fraction or opening total_ratio.`,
    );
  }
  if (dose > 40) {
    warnings.push(
      `${Math.round(dose)}g will crowd the single-serve basket. Use the batch basket (and batch pulse settings) for doses this size.`,
    );
  }

  // Grind: hot pourover reference is Encore 15; flash brew goes ~2 finer.
  const flashEncore = 13;
  let grindLine = `Grind: ~${flashEncore} on the Baratza Encore scale (about 2 settings finer than your hot recipe). Cold mutes aromatics, so the extra extraction is what keeps the cup from tasting hollow.`;
  if (input.grinder) {
    const converted = convertGrind(flashEncore, input.grinder);
    if (converted && converted.name !== "Baratza Encore") {
      grindLine = `Grind: ${converted.name} ${converted.setting} (≈ Encore ${flashEncore}, about 2 settings finer than your hot recipe). Cold mutes aromatics, so the extra extraction keeps the cup from tasting hollow.`;
    }
  }

  const lines = [
    `Flash brew plan (${Math.round(dose)}g coffee, 1:${totalRatio} true ratio, ${Math.round(iceFraction * 100)}% ice):`,
    "",
    `1. Put ${ice}g of ice in the carafe BEFORE brewing. The Aiden brews straight onto it, Japanese style, and the melt is part of your brew water.`,
    `2. Dial the brew volume to ${hot}ml on the machine.`,
    `3. The machine will say to add ~${displayedDose.toFixed(1)}g of coffee (based on your 1:${machineRatio} profile). Ignore it. Add your actual ${Math.round(dose)}g.`,
    `4. ${grindLine}`,
    `5. Profile setup: keep temps on the hot end for the roast (or +1°C) and set bloomRatio to 3. The machine sizes bloom water from the dose it BELIEVES (${displayedDose.toFixed(1)}g), not your real ${Math.round(dose)}g, so without the max multiplier the bloom won't saturate the bed. Setting the profile ratio to 1:14 also keeps the displayed dose closest to reality. Ice stops extraction the moment coffee hits it, so the usual bitterness worry doesn't apply.`,
    `6. Swirl the carafe when it finishes and serve over fresh ice.`,
    "",
    `What the machine thinks: ${hot}ml at 1:${machineRatio} = a normal brew.`,
    `What you actually get: ${hot}ml over ${Math.round(dose)}g = a 1:${effectiveHotRatio.toFixed(1)} hot concentrate, melting out to ~${Math.round(total)}g total = your 1:${totalRatio} drink.`,
  ];

  return { lines, warnings };
}
