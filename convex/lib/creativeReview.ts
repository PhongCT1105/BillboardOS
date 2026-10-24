/**
 * Creative review agent (ADR 0007, AI-native approvals): pure rules shared by
 * the review action, the knowledge base and tests. A host sets a policy
 * (auto-approve on/off, blocked categories); the agent classifies each
 * creative once and applies every workspace's policy to that verdict.
 */

export const REVIEW_ACTOR = "agent:creative-review";

export const DEFAULT_BLOCKED_CATEGORIES = ["alcohol", "gambling", "political", "adult", "tobacco"] as const;

/** Content categories the agent may report. Sensitive ones first. */
export const SENSITIVE_CATEGORIES = ["alcohol", "gambling", "political", "adult", "tobacco", "cannabis", "weapons"] as const;

export const BUSINESS_CATEGORIES = [
  "developer tools",
  "ai",
  "fintech",
  "crypto",
  "food & beverage",
  "health",
  "education",
  "retail",
  "travel",
  "media",
  "real estate",
  "events",
] as const;

export const REVIEW_CATEGORIES = [...SENSITIVE_CATEGORIES, ...BUSINESS_CATEGORIES] as const;

export type Policy = { autoApprove: boolean; blockedCategories: string[] };

export const DEFAULT_POLICY: Policy = { autoApprove: true, blockedCategories: [...DEFAULT_BLOCKED_CATEGORIES] };

/** Keyword rules (whole words, case-insensitive). Deliberately conservative. */
const KEYWORDS: Record<string, string[]> = {
  alcohol: ["beer", "beers", "wine", "wines", "vodka", "whiskey", "whisky", "liquor", "brewery", "tequila", "rum", "gin", "cocktail", "cocktails", "spirits", "ipa", "hard seltzer"],
  gambling: ["casino", "casinos", "betting", "sportsbook", "poker", "slot machine", "lottery", "jackpot", "roulette", "blackjack", "wager", "bet now"],
  political: ["election", "elections", "vote for", "ballot", "senator", "congressman", "congresswoman", "political", "democrat", "democrats", "republican", "republicans", "super pac", "campaign for mayor", "reelect", "re-elect"],
  adult: ["porn", "porno", "xxx", "nsfw", "onlyfans", "escort", "escorts", "strip club", "adult entertainment", "sex toys"],
  tobacco: ["cigarette", "cigarettes", "cigar", "cigars", "tobacco", "vape", "vapes", "vaping", "nicotine", "juul", "e-cig"],
  cannabis: ["cannabis", "marijuana", "dispensary", "thc", "weed"],
  weapons: ["gun", "guns", "firearm", "firearms", "rifle", "ammo", "ammunition"],
  "developer tools": ["developer", "developers", "devtools", "api", "apis", "sdk", "open source", "github", "deploy", "backend", "database", "engineers", "engineering", "code", "coding", "cloud"],
  ai: ["ai", "llm", "machine learning", "gpu", "gpus", "agents", "agent", "neural", "inference", "robotics", "robot", "robots"],
  fintech: ["payments", "fintech", "banking", "invoices", "invoicing", "card", "cards", "lending"],
  crypto: ["crypto", "blockchain", "usdc", "web3", "ethereum", "bitcoin", "onchain", "wallet"],
  "food & beverage": ["coffee", "cafe", "café", "restaurant", "pizza", "bakery", "food", "tea", "burger", "tacos", "brunch", "smoothie"],
  health: ["health", "fitness", "gym", "clinic", "wellness", "yoga", "medical", "dental"],
  education: ["course", "courses", "bootcamp", "university", "school", "learn", "tutoring", "students"],
  retail: ["shop", "store", "sale", "fashion", "apparel", "sneakers", "boutique"],
  travel: ["travel", "hotel", "hotels", "flights", "tours", "tourists", "airbnb"],
  media: ["podcast", "newsletter", "magazine", "film", "music", "festival", "album", "streaming"],
  "real estate": ["real estate", "apartments", "condos", "realtor", "homes for sale"],
  events: ["conference", "meetup", "hackathon", "demo day"],
};

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const RULES: { category: string; re: RegExp }[] = Object.entries(KEYWORDS).map(([category, words]) => ({
  category,
  re: new RegExp(`(?:^|[^a-z0-9])(?:${words.map(escape).join("|")})(?=$|[^a-z0-9])`, "gi"),
}));

/** Count keyword hits per category in the given texts. */
export function categoryHits(texts: (string | null | undefined)[]): Map<string, { count: number; words: string[] }> {
  const text = texts.filter((t): t is string => typeof t === "string" && t.length > 0).join(" \n ").slice(0, 20_000);
  const out = new Map<string, { count: number; words: string[] }>();
  for (const { category, re } of RULES) {
    const matches = text.match(re);
    if (!matches || matches.length === 0) continue;
    const words = [...new Set(matches.map((m) => m.replace(/^[^a-z0-9]/i, "").toLowerCase()))].slice(0, 3);
    out.set(category, { count: matches.length, words });
  }
  return out;
}

/** Categories found in the texts (sensitive ones always reported). */
export function classifyText(texts: (string | null | undefined)[]): string[] {
  return [...categoryHits(texts).keys()];
}

/** Normalise a policy's category list (lowercase, trimmed, unique, bounded). */
export function normalizeCategories(list: string[]): string[] {
  const out: string[] = [];
  for (const raw of list) {
    const c = raw.trim().toLowerCase().slice(0, 40);
    if (c.length > 0 && !out.includes(c)) out.push(c);
    if (out.length >= 20) break;
  }
  return out;
}

export type ContentVerdict = {
  safe: boolean;
  categories: string[];
  reason: string;
  method: "claude" | "heuristic";
  model?: string;
};

/**
 * Deterministic review on text only (titles, channel, brief, knowledge
 * category): used when Claude isn't configured or fails. Adult content is
 * never "safe"; other sensitive categories are left to each host's policy.
 */
export function heuristicVerdict(input: {
  texts: (string | null | undefined)[];
  knowledgeCategory?: string | null;
  describe: string;
}): ContentVerdict {
  const hits = categoryHits(input.texts);
  const categories = [...hits.keys()];
  if (input.knowledgeCategory && !categories.includes(input.knowledgeCategory)) categories.push(input.knowledgeCategory);
  const sensitive = categories.filter((c) => (SENSITIVE_CATEGORIES as readonly string[]).includes(c));
  const safe = !categories.includes("adult");
  const evidence = sensitive
    .map((c) => {
      const h = hits.get(c);
      return h ? `${c} ("${h.words.join('", "')}")` : `${c} (company category)`;
    })
    .join(", ");
  const reason =
    sensitive.length > 0
      ? `Text check of ${input.describe} found ${evidence}.`
      : `Text check of ${input.describe} found nothing sensitive${categories.length > 0 ? ` (looks like ${categories.slice(0, 2).join(", ")})` : ""}.`;
  return { safe, categories, reason, method: "heuristic" };
}

export type WorkspaceDecision = { verdict: "approved" | "flagged" | "held"; reason: string };

/** Apply one workspace's policy to the content verdict. */
export function decideForWorkspace(content: ContentVerdict, policy: Policy): WorkspaceDecision {
  const blocked = content.categories.filter((c) => policy.blockedCategories.includes(c));
  if (!content.safe) return { verdict: "flagged", reason: `Flagged as unsafe: ${content.reason}` };
  if (blocked.length > 0) {
    return { verdict: "flagged", reason: `Flagged: ${blocked.join(", ")} ${blocked.length === 1 ? "is" : "are"} blocked on your screens. ${content.reason}` };
  }
  if (!policy.autoApprove) return { verdict: "held", reason: `Auto-approve is off; the agent found it safe. ${content.reason}` };
  return { verdict: "approved", reason: content.reason };
}

/** JSON schema for Claude's verdict (constraints re-checked in `parseVerdict`). */
export const VERDICT_JSON_SCHEMA = {
  type: "object",
  properties: {
    safe: { type: "boolean", description: "true if fine for a public street screen seen by all ages" },
    categories: {
      type: "array",
      items: { type: "string", enum: [...REVIEW_CATEGORIES, "other"] },
      description: "Every category that applies, sensitive ones included",
    },
    reason: { type: "string", description: "One or two plain sentences a host can audit" },
  },
  required: ["safe", "categories", "reason"],
  additionalProperties: false,
} as const;

/** Validate untrusted model output. Returns null if unusable. */
export function parseVerdict(raw: unknown): { safe: boolean; categories: string[]; reason: string } | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.safe !== "boolean") return null;
  if (typeof o.reason !== "string" || o.reason.trim().length === 0) return null;
  const categories = Array.isArray(o.categories)
    ? normalizeCategories(o.categories.filter((c): c is string => typeof c === "string")).filter(
        (c) => (REVIEW_CATEGORIES as readonly string[]).includes(c) || c === "other",
      )
    : [];
  return { safe: o.safe, categories, reason: o.reason.trim().slice(0, 600) };
}

/** Image types Claude vision accepts. */
export const VISION_MEDIA_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;
export const MAX_VISION_BYTES = 4 * 1024 * 1024;
