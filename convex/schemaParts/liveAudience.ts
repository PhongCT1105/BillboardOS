import { defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * Live audience: what a screen's camera sees, without the image. The live
 * view is boxes only (people in view, who faces the screen), and every
 * 30-second window gets a count when it ends. Spread into `schema.ts` as one line.
 */

/** One person in the live view: position and size as fractions of the camera frame; looking = facing the screen. */
export const liveBox = v.object({ x: v.number(), y: v.number(), w: v.number(), h: v.number(), looking: v.boolean() });

export const liveAudienceFields = {
  billboardId: v.id("billboards"),
  boxes: v.array(liveBox),
  inView: v.number(),
  /** People facing the screen now (null: the face model isn't running). */
  looking: v.union(v.number(), v.null()),
  /** Server time the frame arrived: a payer only sees frames from inside its own paid window. */
  at: v.number(),
};

export const windowAudienceFields = {
  roundId: v.id("rounds"),
  billboardId: v.id("billboards"),
  workspaceId: v.id("workspaces"),
  /** The company that paid for the window (null: house ad, nobody paid). */
  advertiserId: v.union(v.id("advertisers"), v.null()),
  spotStartAt: v.number(),
  spotEndAt: v.number(),
  /** Unique people in view during the window, and their average time in view. */
  people: v.number(),
  avgInViewMs: v.number(),
  /** People who faced the screen for at least a second, and their average time facing it (null: not measured). */
  lookers: v.union(v.number(), v.null()),
  avgLookingMs: v.union(v.number(), v.null()),
  reportedAt: v.number(),
};

export const liveAudienceTables = {
  /** One per screen, rewritten a few times a second, only while someone has the live view open. */
  liveViews: defineTable(liveAudienceFields).index("by_billboard", ["billboardId"]),
  /** Someone has the live view open: the screen sends boxes until `until`. Its own table so viewers and the device never write the same document. */
  liveViewRequests: defineTable({ billboardId: v.id("billboards"), until: v.number() }).index("by_billboard", ["billboardId"]),
  /** What the camera saw during one 30-second window, reported by the screen when the window ends. */
  windowAudiences: defineTable(windowAudienceFields)
    .index("by_round", ["roundId"])
    .index("by_billboard_and_spotStartAt", ["billboardId", "spotStartAt"])
    .index("by_workspace_and_spotStartAt", ["workspaceId", "spotStartAt"])
    .index("by_advertiser_and_spotStartAt", ["advertiserId", "spotStartAt"]),
};
