/**
 * Audience match (ADR 0003): what share of a screen's audience a campaign
 * cares about. Used to RECOMMEND screens and to compute buyer-agent bids;
 * never part of the posted screen price.
 */
export type AudienceTags = Record<string, number>;

/** Unknown audience match (no screen or campaign profile) counts as this: it scales value, never blocks a sale. */
export const NEUTRAL_MATCH = 0.5;

const MAX_TAGS = 12;

/** Keep finite, non-negative weights with sane keys; scale to sum 1. Empty -> {}. */
export function normalizeTags(tags: AudienceTags | undefined | null): AudienceTags {
  if (!tags) return {};
  const entries = Object.entries(tags)
    .filter(([k, v]) => /^[a-z0-9_-]{1,32}$/.test(k) && Number.isFinite(v) && v > 0)
    .slice(0, MAX_TAGS);
  const sum = entries.reduce((s, [, v]) => s + v, 0);
  if (sum <= 0) return {};
  return Object.fromEntries(entries.map(([k, v]) => [k, v / sum]));
}

/** Validate user-supplied tags; returns an error message or null. */
export function validateTags(tags: AudienceTags): string | null {
  const entries = Object.entries(tags);
  if (entries.length === 0 || entries.length > MAX_TAGS) return `Give 1..${MAX_TAGS} audience tags`;
  for (const [k, v] of entries) {
    if (!/^[a-z0-9_-]{1,32}$/.test(k)) return `Tag "${k}" must be lowercase letters, digits, - or _ (max 32)`;
    if (!Number.isFinite(v) || v < 0 || v > 1) return `Weight for "${k}" must be between 0 and 1`;
  }
  return null;
}

/**
 * Score 0..1 = share of the screen's audience in the campaign's target,
 * weighted by how much the campaign cares about each segment (relative to its
 * top segment). Unknown on either side -> null.
 */
export function matchScore(screenTags: AudienceTags | undefined, targetTags: AudienceTags | undefined): number | null {
  const screen = normalizeTags(screenTags);
  const target = normalizeTags(targetTags);
  if (Object.keys(screen).length === 0 || Object.keys(target).length === 0) return null;
  const top = Math.max(...Object.values(target));
  let score = 0;
  for (const [k, share] of Object.entries(screen)) {
    score += share * ((target[k] ?? 0) / top);
  }
  return Math.round(Math.min(1, Math.max(0, score)) * 1000) / 1000;
}

/** Plain-language description of the overlap, e.g. "software 60%, startups 20%". */
export function describeOverlap(screenTags: AudienceTags | undefined, targetTags: AudienceTags | undefined): string {
  const screen = normalizeTags(screenTags);
  const target = normalizeTags(targetTags);
  const shared = Object.keys(target)
    .filter((k) => screen[k] !== undefined)
    .sort((a, b) => (screen[b] ?? 0) - (screen[a] ?? 0))
    .map((k) => `${k} ${Math.round((screen[k] ?? 0) * 100)}%`);
  return shared.length > 0 ? `Shared audience: ${shared.join(", ")}` : "No overlap with this screen's audience";
}
