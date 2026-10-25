import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import { COMPANY_KNOWLEDGE } from "./fixtures/companyKnowledge";

const hydratedPassage = v.object({
  _id: v.id("companyKnowledgePassages"), advertiserId: v.id("advertisers"),
  title: v.string(), url: v.string(), text: v.string(),
  sourceKind: v.union(v.literal("official_site"), v.literal("official_video")),
  verifiedAt: v.number(),
});

/** Deterministic change marker; it is not used as a security digest. */
export function passageHash(text: string): string {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
  return `${text.length}:${(hash >>> 0).toString(16)}`;
}

function sortedRecord(record: Record<string, number>): string {
  return JSON.stringify(Object.entries(record).sort(([a], [b]) => a.localeCompare(b)));
}

export const seedSponsors = internalMutation({
  args: {},
  returns: v.object({ profiles: v.number(), passages: v.number(), changed: v.number() }),
  handler: async (ctx) => {
    let profiles = 0;
    let passages = 0;
    let changed = 0;
    const now = Date.now();
    for (const profile of COMPANY_KNOWLEDGE) {
      const advertiser = await ctx.db.query("advertisers")
        .withIndex("by_displayName", (q) => q.eq("displayName", profile.name)).first();
      if (!advertiser) continue;
      profiles++;
      const card = await ctx.db.query("knowledgeCards")
        .withIndex("by_advertiser", (q) => q.eq("advertiserId", advertiser._id)).first();
      const fields = {
        summary: profile.summary, category: profile.category, stage: profile.stage,
        audienceTags: profile.audienceTags, sources: [...new Set(profile.passages.map((p) => p.url))],
        videoTitles: [profile.videoTitle], method: "curated" as const, updatedAt: now,
        derivedFieldsNote: "Stage and audience weights are demo inferences, not claims from the cited sources.",
      };
      if (card) {
        if (card.method !== "curated" || card.summary !== fields.summary || card.category !== fields.category ||
          card.stage !== fields.stage || card.derivedFieldsNote !== fields.derivedFieldsNote ||
          sortedRecord(card.audienceTags) !== sortedRecord(fields.audienceTags) ||
          JSON.stringify(card.sources) !== JSON.stringify(fields.sources) ||
          JSON.stringify(card.videoTitles) !== JSON.stringify(fields.videoTitles)) {
          await ctx.db.patch(card._id, fields);
          changed++;
        }
      } else {
        await ctx.db.insert("knowledgeCards", { advertiserId: advertiser._id, ...fields });
        changed++;
      }
      const currentKeys = new Set(profile.passages.map((p) => p.key));
      const existing = await ctx.db.query("companyKnowledgePassages")
        .withIndex("by_advertiser_and_active", (q) => q.eq("advertiserId", advertiser._id).eq("active", true)).take(32);
      for (const old of existing) {
        if (!currentKeys.has(old.passageKey)) {
          await ctx.db.patch(old._id, { active: false, embedding: undefined,
            embeddingModel: undefined, embeddingHash: undefined, embeddedAt: undefined });
          changed++;
        }
      }
      for (const passage of profile.passages) {
        passages++;
        const contentHash = passageHash(`${passage.title}\n${passage.text}\n${passage.url}`);
        const old = await ctx.db.query("companyKnowledgePassages")
          .withIndex("by_advertiser_and_passageKey", (q) => q.eq("advertiserId", advertiser._id).eq("passageKey", passage.key)).first();
        const fields = { advertiserId: advertiser._id, passageKey: passage.key, title: passage.title,
          url: passage.url, text: passage.text, sourceKind: passage.sourceKind,
          verifiedAt: passage.verifiedAt, contentHash, active: true };
        if (!old) {
          await ctx.db.insert("companyKnowledgePassages", { ...fields, embeddingStatus: "pending" });
          changed++;
        } else if (old.contentHash !== contentHash || !old.active) {
          await ctx.db.patch(old._id, { ...fields, embeddingStatus: "pending", embedding: undefined, embeddingModel: undefined,
            embeddingHash: undefined, embeddedAt: undefined });
          changed++;
        }
      }
    }
    return { profiles, passages, changed };
  },
});

export const missingEmbeddings = internalQuery({
  args: { limit: v.number() },
  returns: v.array(v.any()),
  handler: async (ctx, { limit }) => {
    const rows = await ctx.db.query("companyKnowledgePassages")
      .withIndex("by_active_and_embeddingStatus", (q) => q.eq("active", true).eq("embeddingStatus", "pending"))
      .take(Math.max(1, Math.min(limit, 16)));
    return rows;
  },
});

export const hydrate = internalQuery({
  args: { ids: v.array(v.id("companyKnowledgePassages")) },
  returns: v.array(hydratedPassage),
  handler: async (ctx, { ids }) => {
    const rows = await Promise.all(ids.slice(0, 16).map((id) => ctx.db.get(id)));
    return rows.filter((row): row is NonNullable<typeof row> => !!row && row.active && row.embeddingHash === row.contentHash)
      .map(({ _id, advertiserId, title, url, text, sourceKind, verifiedAt }) =>
        ({ _id, advertiserId, title, url, text, sourceKind, verifiedAt }));
  },
});

export const context = internalQuery({
  args: { advertiserId: v.id("advertisers") },
  returns: v.any(),
  handler: async (ctx, { advertiserId }) => {
    const card = await ctx.db.query("knowledgeCards").withIndex("by_advertiser", (q) => q.eq("advertiserId", advertiserId)).first();
    const research = await ctx.db.query("companyResearch").withIndex("by_advertiser", (q) => q.eq("advertiserId", advertiserId)).first();
    const passages = await ctx.db.query("companyKnowledgePassages")
      .withIndex("by_advertiser_and_active", (q) => q.eq("advertiserId", advertiserId).eq("active", true)).take(8);
    return {
      card: card && { summary: card.summary, category: card.category, stage: card.stage,
        audienceTags: card.audienceTags, sources: card.sources, videoTitles: card.videoTitles, method: card.method,
        derivedFieldsNote: card.derivedFieldsNote },
      research: research && { audienceTags: research.audienceTags, priceFactor: research.priceFactor,
        method: research.method,
        provenance: "Legacy research for simulated sponsor matching; price factor is a project estimate." },
      passages: passages.map(({ passageKey, title, url, text, sourceKind, verifiedAt }) =>
        ({ passageKey, title, url, text, sourceKind, verifiedAt })),
    };
  },
});
