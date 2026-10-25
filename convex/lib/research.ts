import type { AudienceTags } from "./match";

/**
 * Pure helpers for the research agents (research.ts / researchNode.ts):
 * the shared audience segments, cleaning what the model returns, and the
 * rule-based fallbacks used when Claude isn't available.
 */

/** Who can be in front of a screen, and who a company sells to: one shared vocabulary. */
export const SEGMENT_KEYS = ["startups", "software", "investors", "finance", "students", "office", "tourists", "families"] as const;

export const PRICE_FACTOR_MIN = 0.8;
export const PRICE_FACTOR_MAX = 1.5;

export function clampFactor(f: number): number {
  if (!Number.isFinite(f)) return 1;
  return Math.round(Math.min(PRICE_FACTOR_MAX, Math.max(PRICE_FACTOR_MIN, f)) * 100) / 100;
}

/** Keep known segments with positive weight, scaled to sum 1 (2 decimals). Null when nothing is left. */
export function cleanTags(tags: Record<string, number>): AudienceTags | null {
  const known = SEGMENT_KEYS.map((k) => [k, tags[k]] as const).filter(([, w]) => typeof w === "number" && Number.isFinite(w) && w > 0);
  const sum = known.reduce((s, [, w]) => s + w, 0);
  if (sum <= 0) return null;
  return Object.fromEntries(known.map(([k, w]) => [k, Math.round((w / sum) * 100) / 100]));
}

/** The last {...} object in a model's text reply, parsed; null if there is none. */
export function lastJsonObject(text: string): Record<string, unknown> | null {
  for (let end = text.lastIndexOf("}"); end >= 0; end = text.lastIndexOf("}", end - 1)) {
    for (let start = text.lastIndexOf("{", end); start >= 0; start = text.lastIndexOf("{", start - 1)) {
      try {
        const value: unknown = JSON.parse(text.slice(start, end + 1));
        if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
      } catch {
        // Not a complete object yet: widen.
      }
    }
  }
  return null;
}

const PLACE_RULES: { pattern: RegExp; tags: AudienceTags; who: string }[] = [
  { pattern: /hack|conference|expo|moscone|summit|demo day|startup|accelerator|incubator/i, tags: { software: 0.45, startups: 0.3, investors: 0.15, students: 0.1 }, who: "developers and founders at a tech event" },
  { pattern: /wall st|financial district|bank|exchange|trading|fidi/i, tags: { finance: 0.5, office: 0.3, investors: 0.2 }, who: "finance professionals" },
  { pattern: /university|campus|college|school|library/i, tags: { students: 0.6, software: 0.2, office: 0.2 }, who: "students" },
  { pattern: /office|tower|cowork|tech park|soma/i, tags: { office: 0.5, software: 0.3, startups: 0.2 }, who: "office workers" },
  { pattern: /airport|station|square|pier|museum|park|times sq|union sq/i, tags: { tourists: 0.5, families: 0.3, office: 0.2 }, who: "visitors and families" },
];

/** No Claude: guess the crowd from words in the place and any event. */
export function rulesAudience(i: { locationLabel: string; city: string; events: string[] }): { tags: AudienceTags; summary: string } {
  const text = [i.locationLabel, ...i.events].join(" ");
  const rule = PLACE_RULES.find((r) => r.pattern.test(text));
  if (rule) return { tags: rule.tags, summary: `Rules (no Claude): "${text}" suggests ${rule.who}.` };
  return { tags: { office: 0.4, tourists: 0.3, families: 0.3 }, summary: `Rules (no Claude): a general downtown crowd in ${i.city}.` };
}

/** No Claude: the company's own campaign audience (or a tech default) at the average price. */
export function rulesCompany(i: { name: string; targetAudience: Record<string, number> | null }): {
  summary: string;
  category: string;
  audienceTags: AudienceTags;
  priceFactor: number;
  reasoning: string;
} {
  return {
    summary: `${i.name} (not researched yet).`,
    category: "unknown",
    audienceTags: (i.targetAudience && cleanTags(i.targetAudience)) ?? { software: 0.5, startups: 0.5 },
    priceFactor: 1,
    reasoning: "Rules (no Claude): average price until the company is researched.",
  };
}
