/**
 * Brewing guidelines for the Aiden brewer.
 *
 * Returns brewing principles tailored to a coffee's characteristics. The
 * actual recipe design is left to the LLM — this tool just gives it the
 * domain knowledge it needs to make consistent, informed choices.
 *
 * Heuristics encoded here are pulled from:
 *   - Counter Culture, Onyx, Sey, Tim Wendelboe brew guides
 *   - Fellow's own Brew Studio recommendations
 *   - Hands-on iterations on this brewer (esp. for naturals vs washed)
 *
 * Not gospel — every coffee is its own thing. These are starting points,
 * not endpoints.
 */

export interface GuidelineInput {
  process?: string;
  varieties?: string[];
  elevation?: string;
  tasting_notes?: string[];
  flavor_goal?: string; // e.g. "bolder fruit", "less acidity", "more body"
  user_preference_ratio?: number; // user's typical ratio
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

export function brewingGuidelines(input: GuidelineInput): BrewingGuidelines {
  const principles: string[] = [];
  const warnings: string[] = [];

  // Detect process category
  const proc = (input.process ?? "").toLowerCase();
  const isNatural = /natural|sundried|dry/i.test(proc);
  const isHoney = /honey|semi/i.test(proc);
  const isAnaerobic = /anaerobic|carbonic/i.test(proc);
  const isWashed = !isNatural && !isHoney && !isAnaerobic && /washed|fully washed/i.test(proc);
  const processKnown = isNatural || isHoney || isAnaerobic || isWashed;

  // Detect elevation tier
  const elevMatch = (input.elevation ?? "").match(/\d{3,4}/g);
  const peakElev = elevMatch ? Math.max(...elevMatch.map((s) => parseInt(s, 10))) : 0;
  const isHighElev = peakElev >= 1700;
  const isVeryHighElev = peakElev >= 1900;

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

  const goal = (input.flavor_goal ?? "").toLowerCase();
  const wantsMoreFruit = /fruit|berry|bright|aromatic/.test(goal);
  const wantsLessAcid = /less acid|low acid|smoother|softer|sweeter/.test(goal);
  const wantsMoreBody = /body|full|bolder|stronger|richer|heavier/.test(goal);

  // ============================================================
  // Apply principles
  // ============================================================

  if (isNatural) {
    principles.push(
      "Natural process: fruit notes live in volatile aromatic compounds. KEEP HEAT MODERATE — 90–93°C across all stages. High temps (95°C+) drive off the volatiles you're trying to extract.",
      "Natural beans have already partially fermented in the cherry, so they degas faster than washed. Bloom can be shorter (30–40s).",
      "Coarser grind helps preserve aromatic clarity. Aiden Encore equivalent: 16–18.",
    );
  } else if (isWashed) {
    principles.push(
      "Washed process: cleaner cup, more forgiving of higher temps. 93–96°C is the working range.",
      "Washed Bourbon at 1800m+ is dense — needs longer bloom (45–55s) to fully degas before pulses start extracting solubles.",
      "Acidity tends to be sharper (citric, malic). To tame brightness, drop the LAST pulse temp by 1–2°C while keeping early pulses high.",
    );
  } else if (isHoney) {
    principles.push(
      "Honey process: between washed and natural in body and acidity. Start with washed-style temps (93–95°C) but go a touch coarser on grind.",
    );
  } else if (isAnaerobic) {
    principles.push(
      "Anaerobic / carbonic maceration: amplified fruit, often boozy or wine-like. Treat like a natural — moderate temps to preserve volatiles, slightly more open ratio (1:16) to dial back intensity.",
    );
  }

  if (!processKnown) {
    warnings.push(
      "Process not specified or recognized — defaulting to washed-process heuristics. If this is a natural or honey, drop temps ~3–4°C across the board.",
    );
  }

  // Elevation
  if (isVeryHighElev) {
    principles.push(
      `Very high elevation (~${peakElev}m): bean is dense and slow to degas. Push bloom to 50s minimum, raise bloom temp 1°C above your pulse temps.`,
    );
  } else if (isHighElev && hasDenseVariety) {
    principles.push(
      `High elevation (~${peakElev}m) + Bourbon-family varietal: dense, structured. Long bloom (45s+), full water in bloom (3x ratio).`,
    );
  }

  // Tasting note guidance
  if (hasFruitNotes && !isNatural) {
    principles.push(
      "Fruit notes in cup: aromatic compounds that benefit from controlled heat. Keep top pulse 1–2°C below bloom temp.",
    );
  }
  if (hasFloralNotes) {
    principles.push(
      "Floral / tea-like notes are extremely heat-sensitive. Stay under 94°C across pulses; consider 92–93°C if you want them prominent.",
    );
  }
  if (hasChocolateNotes) {
    principles.push(
      "Chocolate / nutty notes need extraction. Don't go too coarse on grind, and keep pulse temps in the 93–95°C band — they show up in mid-extraction.",
    );
  }

  // Goal-driven adjustments
  if (wantsMoreFruit) {
    principles.push(
      "GOAL — more fruit: drop bloom and SS pulse temps 2–3°C from baseline. Coarsen grind 1–2 settings. Open ratio to 1:16.",
    );
  }
  if (wantsLessAcid) {
    principles.push(
      "GOAL — less acidity: lower the LAST pulse temp by 2°C while keeping early pulses high. Slightly tighter ratio (1:14.5–15) concentrates body and dampens perceived acidity.",
    );
  }
  if (wantsMoreBody) {
    principles.push(
      "GOAL — more body: tighten ratio (1:14–14.5) and finer grind (1 setting tighter). Raise SS pulse temps 1°C across the board.",
    );
  }

  // ============================================================
  // Starting recipe
  // ============================================================

  const ratio = input.user_preference_ratio ?? (isNatural ? 16.0 : 15.0);

  let bloomTemp = 95;
  let pulseHigh = 94;
  let pulseLow = 92;
  let grindSetting = "15 (Encore)";
  let bloomDuration = 45;

  if (isNatural) {
    bloomTemp = 92;
    pulseHigh = 92;
    pulseLow = 90;
    grindSetting = "17 (Encore)";
    bloomDuration = 35;
  }
  if (isVeryHighElev) {
    bloomTemp += 1;
    bloomDuration = 50;
  }
  if (isWashed && hasDenseVariety && isVeryHighElev) {
    bloomTemp = 97;
    pulseHigh = 96;
    pulseLow = 93;
    grindSetting = "14 (Encore)";
    bloomDuration = 50;
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
  const elevDescr = peakElev ? ` at ~${peakElev}m` : "";
  const varietyDescr = varieties.length ? ` (${varieties.slice(0, 2).join(", ")})` : "";
  const summary = `Brewing guidelines for ${procName} coffee${elevDescr}${varietyDescr}. ${principles.length} principles to apply.`;

  return {
    summary,
    principles,
    starting_recipe: {
      ratio: `1:${ratio}`,
      bloom: `${bloomTemp}°C, ${bloomDuration}s, 3x water ratio`,
      ss_pulses: `3 pulses at ${pulseHigh}/${pulseHigh - 1}/${pulseLow}°C, 20s interval`,
      batch_pulses: `2 pulses at ${pulseHigh - 1}/${pulseLow}°C, 25s interval`,
      grind_setting: grindSetting,
    },
    warnings,
  };
}
