/**
 * Company knowledge base (ADR 0007 section 4): pure helpers for the
 * knowledge card. No Convex functions here.
 *
 * Privacy rule: the card's `summary`, `category` and `stage` are PUBLIC,
 * company-level facts (searchable by any signed-in account). They never quote
 * campaign briefs, budgets or the operator-only valuation reasoning. Audience
 * tags, sources and video titles are shown only to the company's own members
 * and to hosts (see knowledge.ts).
 */
import { v } from "convex/values";
import { BUSINESS_CATEGORIES, SENSITIVE_CATEGORIES, categoryHits } from "./lib/creativeReview";
import { normalizeTags } from "./lib/match";

export const STAGES = ["startup", "growth", "established", "enterprise", "unknown"] as const;
export type Stage = (typeof STAGES)[number];

/** Audience vocabulary (same keys as the advertiser's profile picker). */
export const AUDIENCE_TAGS = ["startups", "software", "investors", "students", "tourists", "office", "families"] as const;

export const CARD_CATEGORIES = [...BUSINESS_CATEGORIES, ...SENSITIVE_CATEGORIES, "general"] as const;

export type KnowledgeInputs = {
  displayName: string;
  website: string | null;
  size: string | null;
  briefs: string[];
  targetAudiences: Record<string, number>[];
  /** The company's ad videos: the strongest signal for who the ads are for. */
  videos: { title: string; author: string | null; url: string; description?: string | null; keywords?: string[] }[];
  /** Latest platform assessment (company analyst, ADR 0003), if any. */
  research: { brandTier: string; reasoning: string; sources: string[]; method: string } | null;
};

/** Validator for `KnowledgeInputs` (action and query arguments). */
export const knowledgeInputs = v.object({
  displayName: v.string(),
  website: v.union(v.string(), v.null()),
  size: v.union(v.string(), v.null()),
  briefs: v.array(v.string()),
  targetAudiences: v.array(v.record(v.string(), v.number())),
  videos: v.array(
    v.object({
      title: v.string(),
      author: v.union(v.string(), v.null()),
      url: v.string(),
      description: v.optional(v.union(v.string(), v.null())),
      keywords: v.optional(v.array(v.string())),
    }),
  ),
  research: v.union(
    v.null(),
    v.object({ brandTier: v.string(), reasoning: v.string(), sources: v.array(v.string()), method: v.string() }),
  ),
});

export type Card = {
  summary: string;
  category: string;
  stage: Stage;
  audienceTags: Record<string, number>;
};

/** Default audience per category when the company hasn't said who it targets. */
const CATEGORY_AUDIENCE: Record<string, Record<string, number>> = {
  "developer tools": { software: 0.6, startups: 0.4 },
  ai: { software: 0.5, startups: 0.3, investors: 0.2 },
  fintech: { startups: 0.4, office: 0.4, investors: 0.2 },
  crypto: { software: 0.4, investors: 0.4, startups: 0.2 },
  "food & beverage": { office: 0.4, tourists: 0.3, families: 0.3 },
  health: { office: 0.5, families: 0.5 },
  education: { students: 0.7, families: 0.3 },
  retail: { tourists: 0.4, families: 0.3, office: 0.3 },
  travel: { tourists: 0.8, families: 0.2 },
  media: { students: 0.4, tourists: 0.3, office: 0.3 },
  "real estate": { families: 0.6, office: 0.4 },
  events: { startups: 0.4, software: 0.3, investors: 0.3 },
};

const SIZE_STAGE: Record<string, Stage> = {
  "1-10": "startup",
  "11-50": "startup",
  "51-200": "growth",
  "201-1000": "established",
  "1000+": "enterprise",
};

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Merge campaign target audiences (average of normalised weights), top 6, rounded. */
export function mergeAudiences(list: Record<string, number>[]): Record<string, number> {
  const sum: Record<string, number> = {};
  let n = 0;
  for (const raw of list) {
    const tags = normalizeTags(raw);
    if (Object.keys(tags).length === 0) continue;
    n++;
    for (const [k, v] of Object.entries(tags)) sum[k] = (sum[k] ?? 0) + v;
  }
  if (n === 0) return {};
  const top = Object.entries(sum)
    .map(([k, v]) => [k, v / n] as const)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6);
  return Object.fromEntries(top.map(([k, v]) => [k, round2(v)]));
}

/** Validate untrusted audience tags into a bounded, normalised record. */
export function cleanAudienceTags(raw: unknown): Record<string, number> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const entries = Object.entries(raw as Record<string, unknown>).filter(
    (e): e is [string, number] => /^[a-z0-9_-]{1,32}$/.test(e[0]) && typeof e[1] === "number" && Number.isFinite(e[1]) && e[1] > 0,
  );
  const tags = normalizeTags(Object.fromEntries(entries.slice(0, 12)));
  return Object.fromEntries(
    Object.entries(tags)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([k, v]) => [k, round2(v)]),
  );
}

/** Everything the videos say about themselves: title, description, keywords. */
function videoTexts(inputs: KnowledgeInputs): string[] {
  return inputs.videos.flatMap((v) => [v.title, v.description ?? "", (v.keywords ?? []).join(" ")]);
}

export function stageFrom(inputs: KnowledgeInputs): Stage {
  const tier = inputs.research?.brandTier;
  if (tier === "startup" || tier === "growth" || tier === "established" || tier === "enterprise") return tier;
  if (inputs.size && SIZE_STAGE[inputs.size]) return SIZE_STAGE[inputs.size];
  const text = [...inputs.briefs, ...videoTexts(inputs)].join(" ").toLowerCase();
  if (/\b(startup|seed|pre-seed|launch|launching|yc|founders?)\b/.test(text)) return "startup";
  return "unknown";
}

/** Most-mentioned category across name, briefs, video titles and research; "general" if none. */
export function categoryFrom(inputs: KnowledgeInputs): string {
  const hits = categoryHits([
    inputs.displayName,
    inputs.website,
    ...inputs.briefs,
    ...videoTexts(inputs),
    inputs.research?.reasoning,
  ]);
  let best = "general";
  let bestCount = 0;
  for (const [category, { count }] of hits) {
    if (count > bestCount) {
      best = category;
      bestCount = count;
    }
  }
  return best;
}

function hostOf(website: string | null): string | null {
  if (!website) return null;
  try {
    return new URL(website).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

const AUDIENCE_LABEL: Record<string, string> = {
  startups: "startup founders",
  software: "developers",
  investors: "investors",
  students: "students",
  tourists: "tourists",
  office: "office workers",
  families: "families",
};

/** Public one-paragraph summary. Built from public facts and labels only (no brief text). */
export function summaryFrom(inputs: KnowledgeInputs, card: Omit<Card, "summary">): string {
  const host = hostOf(inputs.website);
  const stage = card.stage === "unknown" ? "" : `${card.stage} `;
  const what = card.category === "general" ? "company" : `${card.category} company`;
  const parts = [`${inputs.displayName} is a ${stage}${what}${host ? ` (${host})` : ""}.`];
  const audience = Object.keys(card.audienceTags)
    .slice(0, 3)
    .map((k) => AUDIENCE_LABEL[k] ?? k);
  if (audience.length > 0) parts.push(`Its ads target ${audience.join(", ")}.`);
  const titles = inputs.videos.map((v) => v.title).slice(0, 2);
  if (titles.length > 0) parts.push(`YouTube ads: ${titles.map((t) => `"${t}"`).join(", ")}.`);
  return parts.join(" ").slice(0, 1000);
}

/** Deterministic card when Claude isn't configured or fails. */
export function heuristicCard(inputs: KnowledgeInputs): Card {
  const category = categoryFrom(inputs);
  const stage = stageFrom(inputs);
  const merged = mergeAudiences(inputs.targetAudiences);
  const audienceTags = Object.keys(merged).length > 0 ? merged : (CATEGORY_AUDIENCE[category] ?? {});
  return { summary: summaryFrom(inputs, { category, stage, audienceTags }), category, stage, audienceTags };
}

/** Public sources for the card: research URLs plus the company's YouTube videos. */
export function sourcesFrom(inputs: KnowledgeInputs): string[] {
  const out = new Set<string>();
  if (inputs.website) out.add(inputs.website);
  for (const s of inputs.research?.sources ?? []) out.add(s);
  for (const v of inputs.videos) out.add(v.url);
  return [...out].filter((u) => /^https?:\/\//.test(u) && u.length <= 500).slice(0, 12);
}

/** JSON schema for Claude's structured card (re-validated by `parseCard`). */
export const CARD_JSON_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string", description: "2-4 plain sentences of public, company-level facts" },
    category: { type: "string", enum: [...CARD_CATEGORIES] },
    stage: { type: "string", enum: [...STAGES] },
    audience: {
      type: "array",
      description: "Who the company's ads are for, with weights 0..1",
      items: {
        type: "object",
        properties: {
          tag: { type: "string", enum: [...AUDIENCE_TAGS] },
          weight: { type: "number" },
        },
        required: ["tag", "weight"],
        additionalProperties: false,
      },
    },
  },
  required: ["summary", "category", "stage", "audience"],
  additionalProperties: false,
} as const;

/** Validate untrusted model output. Returns null if unusable. */
export function parseCard(raw: unknown): Card | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.summary !== "string" || o.summary.trim().length < 10) return null;
  const category =
    typeof o.category === "string" && (CARD_CATEGORIES as readonly string[]).includes(o.category) ? o.category : "general";
  const stage = typeof o.stage === "string" && (STAGES as readonly string[]).includes(o.stage) ? (o.stage as Stage) : "unknown";
  return {
    summary: o.summary.replace(/\s+/g, " ").trim().slice(0, 1000),
    category,
    stage,
    audienceTags: cleanAudienceTags(
      Array.isArray(o.audience)
        ? Object.fromEntries(
            o.audience
              .filter((a): a is { tag: string; weight: number } => !!a && typeof a === "object" && typeof (a as { tag?: unknown }).tag === "string")
              .filter((a) => (AUDIENCE_TAGS as readonly string[]).includes(a.tag))
              .map((a) => [a.tag, a.weight]),
          )
        : o.audienceTags,
    ),
  };
}
