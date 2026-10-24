import type { QueryCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import { AUDIENCE_BUCKET_MS, trailingAudience, type AudienceSample } from "./pricing";

/**
 * Load the current and previous 15-minute audience buckets for a billboard
 * and combine them into a trailing-window sample for pricing.
 * `newest` is the most recent bucket used (provenance for quotes).
 */
export async function loadTrailingAudience(
  db: QueryCtx["db"],
  billboardId: Id<"billboards">,
  now: number,
): Promise<{ sample: AudienceSample | null; newest: Doc<"audienceAggregates"> | null }> {
  const currentStart = now - (now % AUDIENCE_BUCKET_MS);
  const buckets = await db
    .query("audienceAggregates")
    .withIndex("by_billboard_and_bucketStart", (q) =>
      q
        .eq("billboardId", billboardId)
        .gte("bucketStart", currentStart - AUDIENCE_BUCKET_MS)
        .lte("bucketStart", now),
    )
    .order("desc")
    .take(2);
  return {
    sample: trailingAudience(
      buckets.map((b) => ({
        bucketStart: b.bucketStart,
        countEstimate: b.countEstimate,
        source: b.source,
        confidence: b.confidence,
      })),
      now,
    ),
    newest: buckets[0] ?? null,
  };
}
