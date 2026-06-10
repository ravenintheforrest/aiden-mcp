/**
 * Brewing guidelines for the Aiden brewer.
 *
 * Returns brewing principles tailored to a coffee's characteristics. The
 * actual recipe design is left to the LLM — this tool just gives it the
 * domain knowledge it needs to make consistent, informed choices.
 *
 * Provenance: temperature and ratio priors are derived from the community
 * spreadsheet of Fellow Drops profiles (vendored at
 * data/fellow-drops-profiles.csv, analysis script at scripts/drops-stats.py,
 * 69 profiles as of June 2026). Patterns encoded:
 *   - Roast level is the strongest temperature driver in expert profiles:
 *     median bloom 96°C light / 94°C medium / 92.5°C dark.
 *   - Elevation is second: profiles for >=1800m coffee run ~1-2.5°C hotter.
 *   - Washed vs natural shows NO temperature split (both median ~96°C),
 *     contrary to pour-over folk wisdom. Naturals do bloom shorter.
 *   - Anaerobic/co-ferment is the one process experts run cooler (~93.5-94°C).
 *   - Expert ratios cluster at 1:16 across processes.
 * Plus field feedback from Aiden owners (e.g. the floral-cap bug, where a
 * Fellow Drops profile at 97°C beat a floral-capped 94°C rework in the cup).
 *
 * Not gospel: every coffee is its own thing. Starting points, not endpoints.
 */

import { convertGrind, SUPPORTED_GRINDERS } from "./grinders.js";

export interface GuidelineInput {
  process?: string;
  roast?: string; // light | medium-light | medium | medium-dark | dark
  varieties?: string[];
  elevation?: string;
  tasting_notes?: string[];
  flavor_goal?: string; // e.g. "bolder fruit", "less acidity", "more body"
  user_preference_ratio?: number; // user's typical ratio
  grinder?: string; // e.g. "Baratza Encore", "Ode Gen 2", "Comandante C40"
  brew_basket?: string; // stock (default) | v60 | orea | kalita — for modded brew chambers
}

export interface BrewingGuidelines {
  summary: string;
  principles: string[];
  starting_recipe: {
    ratio: string;
    bloom: string;
    ss_pulses: string;
    batch_pulses: string;
    grind_setting: string;
  };
  warnings: string[];
}

const round05 = (v: number) => Math.round(v * 2) / 2;

export function brewingGuidelines(input: GuidelineInput): BrewingGuidelines {
  const principles: string[] = [];
  const warnings: string[] = [];

  // Detect process category
  const proc = (input.process ?? "").toLowerCase();
  const isAnaerobic = /anaerobic|carbonic|co-?ferment/i.test(proc);
  const isNatural = !isAnaerobic && /natural|sundried|dry/i.test(proc);
  const isHoney = !isAnaerobic && !isNatural && /honey|semi/i.test(proc);
  const isWashed = !isNatural && !isHoney && !isAnaerobic && /washed|fully washed/i.test(proc);
  const processKnown = isNatural || isHoney || isAnaerobic || isWashed;

  // Detect roast tier — the strongest temperature driver in the Drops data
  const roastStr = (input.roast ?? "").toLowerCase();
  const roastKnown = /light|medium|dark/.test(roastStr);
  let roastBase = 95; // unknown: split the difference between light and medium
  if (/medium[\s-]?light/.test(roastStr)) roastBase = 95;
  else if (/medium[\s-]?dark/.test(roastStr)) roastBase = 93;
  else if (/light/.test(roastStr)) roastBase = 96;
  else if (/dark/.test(roastStr)) roastBase = 92.5;
  else if (/medium/.test(roastStr)) roastBase = 94;

  // Detect elevation tier
  const elevMatch = (input.elevation ?? "").replace(/,/g, "").match(/\d{3,4}/g);
  const peakElev = elevMatch ? Math.max(...elevMatch.map((s) => parseInt(s, 10))) : 0;
  const isDenseElev = peakElev >= 1800;
  const isVeryHighElev = peakElev >= 1900;
  const isLowElev = peakElev > 0 && peakElev <= 1400;

  // Detect dense varietals (Bourbon, SL28, Geisha tend to be more dense at altitude)
  const varieties = input.varieties ?? [];
  const hasDenseVariety = varieties.some((v) =>
    /bourbon|sl28|sl34|geisha|gesha|pink bourbon|yellow bourbon|red bourbon/i.test(v),
  );

  // Tasting note classifications
  const notes = (input.tasting_notes ?? []).map((n) => n.toLowerCase());
  const hasFruitNotes = notes.some((n) =>
    /berry|berries|fruit|peach|cherry|plum|fig|strawberry|raspberry|blackberry|blueberry|stone fruit|tropical|citrus|orange|lemon|lime|clementine|grapefruit/.test(
      n,
    ),
  );
  const hasFloralNotes = notes.some((n) => /floral|jasmine|rose|bergamot|tea-like|tea/.test(n));
  const hasChocolateNotes = notes.some((n) =>
    /chocolate|cocoa|caramel|nut|nutty|hazelnut|almond|toffee|brown sugar/.test(n),
  );

  // Basket mods: some owners drop a V60 / Orea / Kalita into the chamber via
  // a printed adapter instead of the stock flat-bottom basket. Geometry, not
  // temperature, is what changes: drawdown speed and bed depth.
  const basket = (input.brew_basket ?? "").toLowerCase();
  const isV60 = /v-?60|conical|cone/.test(basket);
  const isOrea = /orea/.test(basket);
  const isKalita = /kalita|wave/.test(basket);
  const basketGiven = basket !== "" && !/stock|standard|default|flat/.test(basket);
  const basketKnown = isV60 || isOrea || isKalita;

  // Goal detection. Strength (stronger/bolder) is deliberately separate from
  // body: strength is the ratio's job, and conflating it with body used to
  // make "bolder fruit" fire opposing temperature instructions.
  const goal = (input.flavor_goal ?? "").toLowerCase();
  const wantsMoreFruit = /fruit|berry|bright|aromatic|floral/.test(goal);
  const wantsLessAcid = /less acid|low acid|smoother|softer|sweeter/.test(goal);
  const wantsMoreBody = /body|fuller|full[\s-]?bodied|richer|heavier|syrupy/.test(goal);
  const wantsStronger = /\b(stronger|bolder|intense)\b/.test(goal);

  // ============================================================
  // Apply principles
  // ============================================================

  // Baseline discipline first. Lesson from the field: a profile dialed by
  // people who actually brewed and tasted the exact coffee beats a first-pass
  // redesign from general principles (a Fellow Drops profile won a head-to-head
  // against a from-principles rework). Generic principles are for designing
  // from scratch, not for second-guessing a coffee-specific baseline.
  principles.push(
    "BASELINE RULE: if a profile made for this exact coffee already exists (Fellow Drops, a roaster's shared profile), treat it as the baseline — it was dialed by people who brewed and tasted this coffee. Don't redesign it from the principles below. Change ONE variable at a time, 1–2°C max, aimed at what the user specifically disliked, then re-taste. Design from scratch only when no coffee-specific profile exists.",
  );

  // Roast: the primary temperature driver
  if (roastKnown) {
    principles.push(
      `Roast sets the temperature baseline. Across 69 expert Fellow Drops profiles, median bloom temp is 96°C for light roasts, 94°C for medium, 92.5°C for dark. Roast level predicts what experts run better than process does.`,
    );
  } else {
    warnings.push(
      "Roast level not provided. Assuming light-to-medium (95°C baseline). Ask the user for the roast on the bag — it's the strongest temperature driver in expert profiles.",
    );
  }

  // Process
  if (isNatural) {
    principles.push(
      "Natural process: beans fermented in the cherry, so they degas faster than washed. Bloom can be shorter (30–40s).",
      "Temperature for naturals: folk wisdom says brew them several degrees cooler, but expert Drops profiles run naturals as hot as washed (median ~96°C bloom). The recipe starts 1°C under the roast baseline as a nod to the fruit; if the cup turns boozy or flat, step down 1–2°C on the NEXT brew rather than starting low.",
      "Coarser grind helps aromatic clarity on naturals. Encore reference: 16–18.",
    );
  } else if (isWashed) {
    principles.push(
      "Washed process: cleaner cup, forgiving across the temperature range. Let roast and elevation set the temps.",
      "Washed acidity tends to be sharper (citric, malic). To tame brightness, drop the LAST pulse temp by 1–2°C while keeping early pulses high.",
    );
  } else if (isHoney) {
    principles.push(
      "Honey process: between washed and natural in body and acidity. Recipe runs a touch under the roast baseline; go slightly coarser on grind than you would for washed.",
    );
  } else if (isAnaerobic) {
    principles.push(
      "Anaerobic / carbonic / co-ferment: the one process experts consistently run cooler — median first steep 93.5–94°C in the Drops data (about 2°C under comparable washed profiles). Tame funk intensity with ratio (1:16) before reaching for temperature.",
    );
  }

  if (!processKnown) {
    warnings.push(
      "Process not specified or recognized — temps follow roast and elevation (which matter more anyway). If this is an anaerobic or co-ferment, drop temps ~2°C.",
    );
  }

  // Elevation
  if (isVeryHighElev) {
    principles.push(
      `Very high elevation (~${peakElev}m): bean is dense and slow to degas. Push bloom to 50s minimum, keep bloom temp at or 1°C above your pulse temps. Expert profiles for 1800m+ coffee run ~1–2.5°C hotter than low-grown.`,
    );
  } else if (isDenseElev && hasDenseVariety) {
    principles.push(
      `High elevation (~${peakElev}m) + Bourbon-family varietal: dense, structured. Long bloom (45s+), full water in bloom (3x ratio).`,
    );
  } else if (isLowElev) {
    principles.push(
      `Low-grown (~${peakElev}m): softer bean, extracts quickly. Recipe runs ~1°C under the roast baseline; avoid going finer than the recipe grind or harshness creeps in.`,
    );
  }

  // Basket mods
  if (isV60) {
    principles.push(
      "V60 basket mod: conical bed with a single exit drains faster than the stock flat-bottom basket, cutting contact time. The recipe compensates with a finer grind (2 settings) and tighter pulse spacing to keep the cone saturated. Temps don't change; geometry is a grind-and-pacing problem. If drawdown still races and the cup turns weak or sour, go another step finer.",
    );
    warnings.push(
      "Basket mods ride on printed adapters and paper choice (Hario 02 papers flow fast), so unit-to-unit variance is real. Calibrate by total drawdown time first, taste second.",
    );
  } else if (isOrea) {
    principles.push(
      "Orea basket mod: flat bed but a fast-flow body, quicker than stock. The recipe goes 1 setting finer; keep pulse spacing standard. If the bed dries between pulses, shorten the interval before touching grind again.",
    );
    warnings.push(
      "Basket mods ride on printed adapters and paper choice, so unit-to-unit variance is real. Calibrate by total drawdown time first, taste second.",
    );
  } else if (isKalita) {
    principles.push(
      "Kalita basket mod: flat bed with restricted flow, the closest geometry to the stock basket. Brew the stock recipe as-is and adjust only if drawdown says otherwise.",
    );
  } else if (basketGiven && !basketKnown) {
    warnings.push(
      `Brew basket "${input.brew_basket}" not recognized — recipe assumes the stock flat-bottom basket. Supported mods: v60, orea, kalita.`,
    );
  }

  // Tasting note guidance
  if (hasFruitNotes && !isNatural) {
    principles.push(
      "Fruit notes in cup: aromatic compounds that benefit from controlled heat. Keep top pulse 1–2°C below bloom temp.",
    );
  }
  if (hasFloralNotes) {
    if (isWashed && (hasDenseVariety || isDenseElev)) {
      // Field-tested: a dense washed high-grown coffee (Pink Bourbon, 1950m)
      // tasted better at Fellow's 97°C first steep than at a floral-capped
      // 94°C. Density wins — extract first, protect florals by iteration.
      principles.push(
        "Floral notes on a dense washed bean: extraction comes first. Dense high-grown coffee holds its florals at high temps better than expected — Fellow's own profiles for coffees like this run 96–97°C first steep. Brew at the recipe temps; only drop 1–2°C on the NEXT brew if the florals come out buried.",
      );
    } else {
      principles.push(
        "Floral / tea-like notes are heat-sensitive on lighter-bodied coffees. Staying a degree or two under the roast baseline keeps them prominent.",
      );
    }
  }
  if (hasChocolateNotes) {
    principles.push(
      "Chocolate / nutty notes ride overall extraction and roast level more than temperature. Don't go too coarse on grind, and follow the roast baseline temps.",
    );
  }

  // Goal-driven adjustments. These are deltas from the recipe below, never
  // absolute targets — and each goal gets its own variable so combined goals
  // (e.g. "bolder fruit") don't issue opposing instructions.
  if (wantsMoreFruit) {
    principles.push(
      "GOAL — more fruit: drop bloom and SS pulse temps 1–2°C from the recipe, coarsen grind 1–2 settings, and open ratio toward 1:16 if the cup feels heavy.",
    );
  }
  if (wantsLessAcid) {
    principles.push(
      "GOAL — less acidity: lower the LAST pulse temp by 2°C while keeping early pulses high. Slightly tighter ratio (1:14.5–15) concentrates body and dampens perceived acidity.",
    );
  }
  if (wantsMoreBody) {
    principles.push(
      "GOAL — more body: tighten ratio (1:14–14.5) and grind 1 setting finer. Raise temps only if the cup is also sour or under-extracted.",
    );
  }
  if (wantsStronger) {
    principles.push(
      "GOAL — stronger/bolder: strength is the ratio's job, not temperature's. Tighten 0.5–1 ratio point (e.g. 1:16 → 1:15) and leave the temps alone.",
    );
  }
  if (wantsMoreFruit && (wantsMoreBody || wantsStronger)) {
    principles.push(
      "COMBINED GOAL (fruit + strength/body): use different variables for each — fruit comes from temperature and grind (drop 1–2°C, coarsen), strength comes from ratio (tighten 0.5–1 point). Don't chase both with the same dial.",
    );
  }

  // ============================================================
  // Starting recipe
  // ============================================================

  const ratio = input.user_preference_ratio ?? (isNatural || isAnaerobic ? 16.0 : 15.0);

  // Temperature model: roast baseline, elevation up, process down.
  let base = roastBase;
  if (isDenseElev) base += 1;
  else if (isLowElev) base -= 1;
  if (isNatural) base -= 1;
  if (isHoney) base -= 0.5;
  if (isAnaerobic) base -= 2;
  base = Math.min(99, Math.max(85, base));

  const bloomTemp = round05(base);
  const pulseHigh = round05(base - 1);
  let pulseSpread = 2; // pulseLow = pulseHigh - spread
  let grindEncore = isNatural || isAnaerobic ? 17 : 15;
  let bloomDuration = isNatural ? 35 : 45;
  if (isVeryHighElev) bloomDuration = 50;
  if (isWashed && hasDenseVariety && isVeryHighElev) {
    grindEncore = 14;
    pulseSpread = 3; // longer descent for the dense, structured cup
    bloomDuration = 50;
  }
  const pulseLow = round05(pulseHigh - pulseSpread);

  // Basket geometry: faster-draining beds get finer grind and (for V60)
  // tighter pulse spacing so the bed stays saturated between pulses.
  let ssInterval = 20;
  let batchInterval = 25;
  if (isV60) {
    grindEncore -= 2;
    ssInterval = 15;
    batchInterval = 20;
  } else if (isOrea) {
    grindEncore -= 1;
  }

  // Grind: internal scale is Baratza Encore; convert if we know the grinder
  let grindSetting = `${grindEncore} (Baratza Encore scale)`;
  if (input.grinder) {
    const converted = convertGrind(grindEncore, input.grinder);
    if (converted) {
      grindSetting = `${converted.name}: ${converted.setting} (≈ Encore ${grindEncore})`;
      if (converted.note) principles.push(`Grinder — ${converted.note}`);
      warnings.push(
        "Grinder conversions are starting points, not gospel — burr wear, unit variance, and zero-point calibration all shift the real number. Verify by drawdown time and taste, then adjust 1–2 steps at a time.",
      );
    } else {
      warnings.push(
        `Grinder "${input.grinder}" not recognized — setting shown on the Baratza Encore scale. Supported grinders: ${SUPPORTED_GRINDERS.join(", ")}.`,
      );
    }
  }

  // ============================================================
  // Summary
  // ============================================================

  const procName = isNatural
    ? "natural"
    : isWashed
      ? "washed"
      : isHoney
        ? "honey-process"
        : isAnaerobic
          ? "anaerobic"
          : "process unknown";
  const roastDescr = roastKnown ? `${roastStr.trim()} roast ` : "";
  const elevDescr = peakElev ? ` at ~${peakElev}m` : "";
  const varietyDescr = varieties.length ? ` (${varieties.slice(0, 2).join(", ")})` : "";
  const basketDescr = isV60 ? ", V60 basket mod" : isOrea ? ", Orea basket mod" : isKalita ? ", Kalita basket mod" : "";
  const summary = `Brewing guidelines for ${roastDescr}${procName} coffee${elevDescr}${varietyDescr}${basketDescr}. ${principles.length} principles to apply.`;

  return {
    summary,
    principles,
    starting_recipe: {
      ratio: `1:${ratio}`,
      bloom: `${bloomTemp}°C, ${bloomDuration}s, 3x water ratio`,
      ss_pulses: `3 pulses at ${pulseHigh}/${round05(pulseHigh - 1)}/${pulseLow}°C, ${ssInterval}s interval`,
      batch_pulses: `2 pulses at ${round05(pulseHigh - 1)}/${pulseLow}°C, ${batchInterval}s interval`,
      grind_setting: grindSetting,
    },
    warnings,
  };
}
