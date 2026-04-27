/**
 * Coffee page fetcher.
 *
 * Given a roaster product URL, scrape the page and return structured
 * coffee details that Claude can use to design a brew profile.
 *
 * Supports: any Shopify-based roaster (Counter Culture, Onyx, Sey, Heart,
 * Verve, Sweet Bloom, etc.) by parsing the JSON-LD product schema and
 * Shopify-specific markup. Falls back to Open Graph for non-Shopify sites.
 */

export interface CoffeeDetails {
  url: string;
  source: "shopify-jsonld" | "shopify-html" | "open-graph" | "generic";
  coffee_name?: string;
  roaster?: string;
  description?: string;
  product_image?: string;
  tasting_notes?: string[];
  varieties?: string[];
  process?: string;
  elevation?: string;
  country?: string;
  region?: string;
  producer?: string;
  story?: string;
  warnings: string[];
}

export async function fetchCoffeeDetails(url: string): Promise<CoffeeDetails> {
  // Validate URL
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid URL: ${url}`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`URL must use http or https: ${url}`);
  }

  // Fetch page (with sensible timeout via Cloudflare's default)
  const r = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
      Accept: "text/html,application/xhtml+xml",
    },
    redirect: "follow",
  });
  if (!r.ok) {
    throw new Error(`Failed to fetch page: HTTP ${r.status}`);
  }
  const html = await r.text();

  // Try parsers in priority order
  const result: CoffeeDetails = {
    url,
    source: "generic",
    warnings: [],
  };

  // 1. JSON-LD structured data (best when available)
  const jsonLdMatches = html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/g);
  for (const m of jsonLdMatches) {
    try {
      const data = JSON.parse(m[1]);
      const product = findProduct(data);
      if (product) {
        result.source = "shopify-jsonld";
        if (product.name) result.coffee_name = String(product.name).trim();
        if (product.description) result.description = String(product.description).trim();
        if (product.image) {
          const img = Array.isArray(product.image) ? product.image[0] : product.image;
          if (typeof img === "string") {
            result.product_image = img;
          } else if (img && typeof img === "object" && "url" in img) {
            result.product_image = String((img as { url: unknown }).url);
          }
        }
        if (product.brand) {
          const brand = product.brand;
          if (typeof brand === "string") {
            result.roaster = brand;
          } else if (brand && typeof brand === "object" && "name" in brand) {
            result.roaster = String((brand as { name: unknown }).name);
          }
        }
        break;
      }
    } catch {
      // bad JSON, try next block
    }
  }

  // 2. Open Graph tags as a baseline (always extract — fills gaps)
  const og = extractOpenGraph(html);
  if (!result.coffee_name && og.title) result.coffee_name = og.title;
  if (!result.product_image && og.image) result.product_image = og.image;
  if (!result.description && og.description) result.description = og.description;
  if (!result.roaster && og.site_name) result.roaster = og.site_name;
  if (result.source === "generic" && og.title) result.source = "open-graph";

  // 3. Shopify-specific extraction (description block, product images)
  const shopifyDesc = extractShopifyDescription(html);
  if (shopifyDesc) {
    if (!result.description || result.description.length < shopifyDesc.length) {
      result.description = shopifyDesc;
    }
    if (result.source === "open-graph") result.source = "shopify-html";
  }

  // 4. Parse tasting notes from likely sources (h2 immediately under coffee name, or product subtitle)
  const tastingNotes = extractTastingNotes(html, result.coffee_name);
  if (tastingNotes.length) result.tasting_notes = tastingNotes;

  // 5. Extract structured details from the description prose
  // (Counter Culture and many roasters embed elevation/process/varieties in narrative form.)
  if (result.description) {
    const inferred = inferFromProse(result.description);
    if (inferred.varieties?.length) result.varieties = inferred.varieties;
    if (inferred.process) result.process = inferred.process;
    if (inferred.elevation) result.elevation = inferred.elevation;
    if (inferred.country) result.country = inferred.country;
    if (inferred.region) result.region = inferred.region;
    if (inferred.producer) result.producer = inferred.producer;
  }

  // 6. Pull richer story text if present (Counter Culture has a "Story" panel)
  const story = extractStoryText(html);
  if (story) result.story = story;

  // Sanity warnings — let the LLM know what's missing so it can ask follow-up questions or use defaults
  if (!result.coffee_name) result.warnings.push("Could not extract coffee name from page");
  if (!result.process) result.warnings.push("Process (washed/natural/honey) not detected — ask user");
  if (!result.varieties?.length) result.warnings.push("Varieties not detected");
  if (!result.tasting_notes?.length) result.warnings.push("Tasting notes not detected");

  return result;
}

// ============================================================
// Helpers
// ============================================================

function findProduct(data: unknown): Record<string, unknown> | null {
  if (!data) return null;
  if (Array.isArray(data)) {
    for (const item of data) {
      const p = findProduct(item);
      if (p) return p;
    }
    return null;
  }
  if (typeof data !== "object") return null;
  const obj = data as Record<string, unknown>;
  if (obj["@type"] === "Product") return obj;
  if (Array.isArray(obj["@graph"])) return findProduct(obj["@graph"]);
  return null;
}

function extractOpenGraph(html: string): {
  title?: string;
  description?: string;
  image?: string;
  site_name?: string;
} {
  const result: Record<string, string> = {};
  const re = /<meta[^>]+property=["']og:([^"']+)["'][^>]+content=["']([^"']*)["']/gi;
  for (const m of html.matchAll(re)) {
    if (!result[m[1]]) result[m[1]] = decodeHtmlEntities(m[2]);
  }
  return {
    title: result.title,
    description: result.description,
    image: result.image,
    site_name: result.site_name,
  };
}

function extractShopifyDescription(html: string): string | null {
  // Shopify product description is usually in a div with class "product-single__description"
  // or "product__description" or "rte" — these are the canonical Shopify theme patterns.
  const patterns = [
    /<div[^>]+class="[^"]*product-single__description[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
    /<div[^>]+class="[^"]*product__description[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
    /<div[^>]+class="[^"]*rte[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m) {
      const text = stripHtml(m[1]).trim();
      if (text.length > 50) return text;
    }
  }
  return null;
}

function extractStoryText(html: string): string | null {
  // Counter Culture's "Story" / "Harvest" / "Partnership" expandable panels live in
  // <details> or accordion blocks. We try both forms.
  const m = html.match(/<details[^>]*>[\s\S]*?<summary[^>]*>\s*Story\s*<\/summary>([\s\S]*?)<\/details>/i);
  if (m) return stripHtml(m[1]).trim();
  return null;
}

function extractTastingNotes(html: string, coffeeName?: string): string[] {
  // Look for short pipe/comma-separated text that reads as tasting notes.
  // Filter out subtitle lines that are really geography/category breadcrumbs.
  const locationKeywords = new Set([
    "single-origin",
    "single origin",
    "blend",
    "decaf",
    "espresso",
    "filter",
    "burundi",
    "rwanda",
    "ethiopia",
    "kenya",
    "tanzania",
    "uganda",
    "colombia",
    "peru",
    "brazil",
    "bolivia",
    "ecuador",
    "costa rica",
    "guatemala",
    "honduras",
    "el salvador",
    "nicaragua",
    "panama",
    "mexico",
    "indonesia",
    "yemen",
    "kayanza",
    "yirgacheffe",
    "huila",
    "nariño",
    "cajamarca",
    "antioquia",
    "san agustin",
    "light roast",
    "medium roast",
    "dark roast",
  ]);

  const candidates: string[][] = [];

  const tagRe = /<(h2|h3|p|span|div)[^>]*>([^<]{5,80})<\/\1>/gi;
  for (const m of html.matchAll(tagRe)) {
    const text = decodeHtmlEntities(m[2]).trim();
    if (!(text.includes("|") || (text.includes(",") && !text.includes(".")))) continue;
    const parts = text
      .split(/[|,]/)
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s.length > 1 && s.length < 30 && !/[0-9]/.test(s));
    if (parts.length < 2 || parts.length > 5) continue;

    // Reject if any part is a known location/category — those are breadcrumbs, not tasting notes
    if (parts.some((p) => locationKeywords.has(p))) continue;

    candidates.push(parts);
  }

  // Prefer the LAST candidate (CCC puts tasting notes after the breadcrumb subtitle)
  return candidates.length ? candidates[candidates.length - 1] : [];
}

function inferFromProse(text: string): {
  varieties?: string[];
  process?: string;
  elevation?: string;
  country?: string;
  region?: string;
  producer?: string;
} {
  const result: ReturnType<typeof inferFromProse> = {};
  const lower = text.toLowerCase();

  // Process: looks for known terms
  const processes = [
    /\bnatural[- ]sundried\b/i,
    /\bnatural\b/i,
    /\bwashed\b/i,
    /\bhoney\b/i,
    /\banaerobic\b/i,
    /\bcarbonic[- ]?maceration\b/i,
    /\bsemi[- ]washed\b/i,
    /\bdry[- ]processed?\b/i,
  ];
  for (const re of processes) {
    const m = text.match(re);
    if (m) {
      result.process = m[0].toLowerCase().replace(/-/g, " ");
      break;
    }
  }

  // Elevation: "1,800–2,000 meters" or "1800m" or "1500-1800 masl"
  const elev =
    text.match(/\b\d{3,4}[-–—]\d{3,4}\s*(?:meters?|masl|m\b)/i) ??
    text.match(/\b\d{1,2},\d{3}[-–—]\d{1,2},\d{3}\s*(?:meters?|masl|m\b)/i) ??
    text.match(/\b\d{3,4}\s*(?:meters? above sea level|masl|m\b)/i);
  if (elev) result.elevation = elev[0];

  // Varieties: scan for known coffee variety names
  const varietalNames = [
    "Bourbon",
    "Mbirizi",
    "Jackson",
    "Typica",
    "Caturra",
    "Catuai",
    "Catuaí",
    "SL28",
    "SL34",
    "Geisha",
    "Gesha",
    "Pacamara",
    "Pacas",
    "Maragogype",
    "Mundo Novo",
    "Heirloom",
    "Pink Bourbon",
    "Yellow Bourbon",
    "Red Bourbon",
    "Bourbon de Colasay",
    "Castillo",
    "Colombia",
    "Tabi",
    "Wush Wush",
    "Ruiru 11",
    "Batian",
    "Java",
    "Kent",
  ];
  const found = new Set<string>();
  for (const v of varietalNames) {
    const re = new RegExp(`\\b${v.replace(/\s+/g, "\\s+")}\\b`, "i");
    if (re.test(text)) found.add(v);
  }
  if (found.size) result.varieties = Array.from(found);

  // Country: a few common coffee-producing countries
  const countries = [
    "Burundi",
    "Rwanda",
    "Ethiopia",
    "Kenya",
    "Tanzania",
    "Uganda",
    "Colombia",
    "Peru",
    "Brazil",
    "Bolivia",
    "Ecuador",
    "Costa Rica",
    "Guatemala",
    "Honduras",
    "El Salvador",
    "Nicaragua",
    "Panama",
    "Mexico",
    "Indonesia",
    "Yemen",
    "India",
    "Vietnam",
  ];
  for (const c of countries) {
    if (new RegExp(`\\b${c}\\b`).test(text)) {
      result.country = c;
      break;
    }
  }

  return result;
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'");
}
