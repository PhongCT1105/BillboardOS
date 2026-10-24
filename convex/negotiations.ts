import { ConvexError, v, type Infer } from "convex/values";
import { internalMutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { negotiationMessageKind, negotiationParty, negotiationStatus } from "./schema";
import { recordAudit } from "./lib/audit";
import { assertWithinBudget, authenticateAgent, requireAgentCampaign, type AgentContext } from "./lib/agentKeys";
import {
  MAX_NEGOTIATION_SLOTS,
  negotiationFloor,
  openingAsk,
  policyOf,
  sellerRespond,
  usd,
} from "./lib/negotiation";
import { createQuoteCore, priceForCampaign } from "./quotes";
import { createHoldCore } from "./holds";
import { requireCustomer, resolveWorkspace } from "./lib/tenancy";

/**
 * Seller agent (ADR 0005): each host workspace negotiates with customers'
 * buying agents. Code decides every number (lib/negotiation.ts); messages
 * carry the reasoning. Slots are not held while talking; an agreement
 * atomically creates a quote at the agreed amount and a hold for the buyer's
 * key (budget cap applies). Reached by the x402 server over /internal/a2a/*.
 */

const MIN_LEAD_MS = 5 * 60_000;
const MAX_AMOUNT_MINOR = 10_000_000;
const MAX_REASONING = 1000;
const MAX_MESSAGES = 60;

function fail(code: string, message: string, extra: Record<string, string | number> = {}): never {
  throw new ConvexError({ code, message, ...extra });
}

function idOf<T extends "workspaces" | "campaigns" | "slots" | "negotiations">(ctx: QueryCtx, table: T, value: string, label: string): Id<T> {
  const id = ctx.db.normalizeId(table, value);
  if (!id) fail("NOT_FOUND", `${label} not found`);
  return id;
}

function sellerActor(workspace: Doc<"workspaces">) {
  return `seller-agent:${workspace.name}`;
}

function cleanReasoning(text: string | undefined, fallback: string) {
  const t = (text ?? "").trim().slice(0, MAX_REASONING);
  return t.length > 0 ? t : fallback;
}

function assertAmount(amountMinor: number | undefined): number {
  if (amountMinor === undefined || !Number.isSafeInteger(amountMinor) || amountMinor <= 0 || amountMinor > MAX_AMOUNT_MINOR) {
    fail("INVALID_INPUT", "amountMinor must be a whole number of US cents in (0, 10000000]");
  }
  return amountMinor;
}

/** Buyer keys must be able to quote and hold (an agreement creates a hold). */
async function authBuyer(ctx: MutationCtx, token: string): Promise<AgentContext> {
  const agent = await authenticateAgent(ctx, token, "quote");
  if (!agent.key.scopes.includes("hold")) fail("SCOPE_MISSING", 'Negotiating needs the "quote" and "hold" scopes');
  return agent;
}

async function addMessage(
  ctx: MutationCtx,
  n: Doc<"negotiations">,
  msg: { from: "buyer" | "seller" | "system"; actor: string; kind: Infer<typeof negotiationMessageKind>; amountMinor?: number; reasoning: string },
) {
  const now = Date.now();
  await ctx.db.insert("negotiationMessages", {
    negotiationId: n._id,
    workspaceId: n.workspaceId,
    advertiserId: n.advertiserId,
    from: msg.from,
    actor: msg.actor,
    kind: msg.kind,
    amountMinor: msg.amountMinor,
    reasoning: msg.reasoning,
    createdAt: now,
  });
  await recordAudit(ctx, {
    workspaceId: n.workspaceId,
    traceId: n.traceId,
    actor: msg.actor,
    type: "negotiation.message",
    subjectId: n._id,
    reason: `${msg.from} ${msg.kind}${msg.amountMinor !== undefined ? ` ${usd(msg.amountMinor)}` : ""}: ${msg.reasoning}`.slice(0, 1000),
    data: { kind: msg.kind, amountMinor: msg.amountMinor ?? null },
  });
}

async function close(
  ctx: MutationCtx,
  n: Doc<"negotiations">,
  status: "rejected" | "expired" | "failed",
  actor: string,
  reason: string,
) {
  await ctx.db.patch(n._id, { status, closedReason: reason.slice(0, 300), updatedAt: Date.now() });
  await recordAudit(ctx, {
    workspaceId: n.workspaceId,
    traceId: n.traceId,
    actor,
    type: "negotiation.closed",
    subjectId: n._id,
    reason: `Negotiation ${status}: ${reason}`.slice(0, 1000),
  });
}

/** Load slots for a negotiation on this workspace's screens; refuse hot (auctioned) or unsellable slots. */
async function sellableSlots(ctx: MutationCtx, workspaceId: Id<"workspaces">, slotIds: Id<"slots">[], now: number) {
  if (slotIds.length === 0 || slotIds.length > MAX_NEGOTIATION_SLOTS) {
    fail("INVALID_INPUT", `A negotiation covers 1..${MAX_NEGOTIATION_SLOTS} slots`);
  }
  if (new Set(slotIds).size !== slotIds.length) fail("INVALID_INPUT", "Duplicate slot ids");
  const slots: Doc<"slots">[] = [];
  for (const id of slotIds) {
    const s = await ctx.db.get(id);
    if (!s) fail("NOT_FOUND", "Slot not found");
    slots.push(s);
  }
  const billboardId = slots[0].billboardId;
  if (slots.some((s) => s.billboardId !== billboardId)) fail("INVALID_INPUT", "All slots must be on the same screen");
  const billboard = await ctx.db.get(billboardId);
  if (!billboard || billboard.workspaceId !== workspaceId) fail("NOT_FOUND", "Those slots are not on this host's screens");
  if (billboard.deviceStatus !== "online") fail("BILLBOARD_OFFLINE", "Screen is offline; not selling airtime");
  for (const s of slots) {
    if (s.auctionId) {
      const auction = await ctx.db.get(s.auctionId);
      if (auction?.status === "open") {
        fail("AUCTION_OPEN", "This slot is in a live auction; join the auction instead of negotiating", {
          auctionId: auction._id,
          slotId: s._id,
        });
      }
    }
    if (s.state !== "available" || s.startAt <= now + MIN_LEAD_MS) {
      fail("SLOT_UNAVAILABLE", "One or more slots are not available", { slotId: s._id });
    }
  }
  return { slots, billboard };
}

export const negotiationView = v.object({
  negotiationId: v.id("negotiations"),
  workspaceId: v.id("workspaces"),
  billboardId: v.id("billboards"),
  campaignId: v.id("campaigns"),
  slotIds: v.array(v.id("slots")),
  status: negotiationStatus,
  /** Seller's current price (ask or counter). */
  sellerMinor: v.number(),
  buyerMinor: v.union(v.number(), v.null()),
  offerExpiresAt: v.number(),
  rounds: v.number(),
  maxRounds: v.number(),
  agreedMinor: v.union(v.number(), v.null()),
  quoteId: v.union(v.id("quotes"), v.null()),
  holdId: v.union(v.id("holds"), v.null()),
  holdExpiresAt: v.union(v.number(), v.null()),
  closedReason: v.union(v.string(), v.null()),
  traceId: v.string(),
  messages: v.array(
    v.object({
      from: negotiationParty,
      actor: v.string(),
      kind: negotiationMessageKind,
      amountMinor: v.union(v.number(), v.null()),
      reasoning: v.string(),
      createdAt: v.number(),
    }),
  ),
});

async function viewOf(ctx: QueryCtx, n: Doc<"negotiations">): Promise<Infer<typeof negotiationView>> {
  const messages = await ctx.db
    .query("negotiationMessages")
    .withIndex("by_negotiation", (q) => q.eq("negotiationId", n._id))
    .take(MAX_MESSAGES);
  const hold = n.holdId ? await ctx.db.get(n.holdId) : null;
  return {
    negotiationId: n._id,
    workspaceId: n.workspaceId,
    billboardId: n.billboardId,
    campaignId: n.campaignId,
    slotIds: n.slotIds,
    status: n.status,
    sellerMinor: n.sellerMinor,
    buyerMinor: n.buyerMinor ?? null,
    offerExpiresAt: n.offerExpiresAt,
    rounds: n.rounds,
    maxRounds: n.maxRounds,
    agreedMinor: n.agreedMinor ?? null,
    quoteId: n.quoteId ?? null,
    holdId: n.holdId ?? null,
    holdExpiresAt: hold?.expiresAt ?? null,
    closedReason: n.closedReason ?? null,
    traceId: n.traceId,
    messages: messages.map((m) => ({
      from: m.from,
      actor: m.actor,
      kind: m.kind,
      amountMinor: m.amountMinor ?? null,
      reasoning: m.narration ?? m.reasoning,
      createdAt: m.createdAt,
    })),
  };
}

/**
 * Agreement: atomically quote at the agreed amount and hold for the buyer's
 * key. If the slots sold meanwhile, the negotiation fails cleanly (no hold).
 * Over the key's budget cap -> BUDGET_CAP (nothing changes).
 */
async function agree(ctx: MutationCtx, n: Doc<"negotiations">, agent: AgentContext, amountMinor: number, sellerName: string) {
  const now = Date.now();
  for (const id of n.slotIds) {
    const s = await ctx.db.get(id);
    let hot = false;
    if (s?.auctionId) hot = (await ctx.db.get(s.auctionId))?.status === "open";
    if (!s || s.state !== "available" || s.startAt <= now || hot) {
      await addMessage(ctx, n, {
        from: "system",
        actor: "system",
        kind: "failed",
        reasoning: hot ? "The slot went to auction before the agreement; no hold was taken." : "The slots sold before the agreement; no hold was taken.",
      });
      await close(ctx, n, "failed", "system", "slots no longer available at agreement");
      return;
    }
  }
  await assertWithinBudget(ctx, agent.key, amountMinor);
  const quote = await createQuoteCore(ctx, {
    campaignId: n.campaignId,
    slotIds: n.slotIds,
    actor: agent.actor,
    agentKeyId: agent.key._id,
  });
  const posted = quote.amountMinor;
  await ctx.db.patch(quote.quoteId, {
    amountMinor: amountMinor,
    pricingBasis: [
      ...quote.pricingBasis,
      `Negotiated by agents with ${sellerName}: ${usd(amountMinor)} (posted ${usd(posted)}, negotiation ${n._id})`,
    ],
  });
  const hold = await createHoldCore(ctx, {
    quoteId: quote.quoteId,
    idempotencyKey: `negotiation:${n._id}`,
    actor: agent.actor,
    agentKeyId: agent.key._id,
  });
  await ctx.db.patch(n._id, {
    status: "agreed",
    agreedMinor: amountMinor,
    quoteId: quote.quoteId,
    holdId: hold.holdId,
    updatedAt: now,
  });
  await addMessage(ctx, n, {
    from: "system",
    actor: "system",
    kind: "agreement",
    amountMinor,
    reasoning: `Agreed at ${usd(amountMinor)}. Hold ${hold.holdId} reserves the slots until ${new Date(hold.expiresAt).toISOString()}; pay it over x402 at /a2a/hosts/${n.workspaceId}/purchases/${hold.holdId}.`,
  });
  await recordAudit(ctx, {
    workspaceId: n.workspaceId,
    traceId: n.traceId,
    actor: agent.actor,
    type: "negotiation.agreed",
    subjectId: n._id,
    reason: `Agents agreed ${usd(amountMinor)} for ${n.slotIds.length} slot(s) (posted ${usd(posted)}); hold ${hold.holdId}`,
    data: { amountMinor, postedMinor: posted, quoteId: quote.quoteId, holdId: hold.holdId },
  });
}

/** Buyer offer -> deterministic seller response (accept / counter / reject). */
async function handleOffer(
  ctx: MutationCtx,
  n: Doc<"negotiations">,
  agent: AgentContext,
  workspace: Doc<"workspaces">,
  amountMinor: number,
  reasoning: string | undefined,
) {
  const now = Date.now();
  const round = n.rounds + 1;
  if (round > n.maxRounds) fail("MAX_ROUNDS", `This negotiation allows ${n.maxRounds} offers`);
  await addMessage(ctx, n, {
    from: "buyer",
    actor: agent.actor,
    kind: "offer",
    amountMinor,
    reasoning: cleanReasoning(reasoning, `Offer ${usd(amountMinor)} (round ${round} of ${n.maxRounds}).`),
  });
  const decision = sellerRespond(
    { floorMinor: n.floorMinor, sellerMinor: n.sellerMinor, bestBuyerMinor: n.buyerMinor ?? null, round, maxRounds: n.maxRounds },
    amountMinor,
  );
  const best = Math.max(amountMinor, n.buyerMinor ?? 0);
  await ctx.db.patch(n._id, { rounds: round, buyerMinor: best, updatedAt: now });
  const seller = sellerActor(workspace);
  const fresh = (await ctx.db.get(n._id))!;
  if (decision.kind === "accept") {
    await addMessage(ctx, fresh, { from: "seller", actor: seller, kind: "accept", amountMinor: decision.amountMinor, reasoning: decision.reasoning });
    await agree(ctx, fresh, agent, decision.amountMinor, workspace.name);
  } else if (decision.kind === "reject") {
    await addMessage(ctx, fresh, { from: "seller", actor: seller, kind: "reject", reasoning: decision.reasoning });
    await close(ctx, fresh, "rejected", seller, "final offer below policy");
  } else {
    const offerExpiresAt = now + n.offerTtlMs;
    await ctx.db.patch(n._id, { sellerMinor: decision.amountMinor, offerExpiresAt });
    await addMessage(ctx, fresh, { from: "seller", actor: seller, kind: "counter", amountMinor: decision.amountMinor, reasoning: decision.reasoning });
    await ctx.scheduler.runAt(offerExpiresAt, internal.negotiations.expire, { negotiationId: n._id });
  }
}

/** POST /a2a/hosts/{workspaceId}/negotiations (x402 server -> /internal/a2a/negotiations). */
export const open = internalMutation({
  args: {
    token: v.string(),
    workspaceId: v.string(),
    campaignId: v.string(),
    slotIds: v.array(v.string()),
    amountMinor: v.optional(v.number()),
    reasoning: v.optional(v.string()),
  },
  returns: negotiationView,
  handler: async (ctx, args) => {
    const agent = await authBuyer(ctx, args.token);
    const workspaceId = idOf(ctx, "workspaces", args.workspaceId, "Host");
    const workspace = await ctx.db.get(workspaceId);
    if (!workspace) fail("NOT_FOUND", "Host not found");
    const campaign = await requireAgentCampaign(ctx, agent, idOf(ctx, "campaigns", args.campaignId, "Campaign"));
    if (campaign.status === "completed" || campaign.status === "cancelled") fail("CAMPAIGN_CLOSED", `Campaign is ${campaign.status}`);
    const slotIds = args.slotIds.map((s) => idOf(ctx, "slots", s, "Slot"));
    const opening = args.amountMinor === undefined ? undefined : assertAmount(args.amountMinor);
    const now = Date.now();
    const { slots, billboard } = await sellableSlots(ctx, workspaceId, slotIds, now);

    const policy = policyOf(workspace);
    const priced = await priceForCampaign(ctx, campaign, billboard, slots, now);
    const screenMinor = priced.price.amountMinor;
    const floorMinor = negotiationFloor(screenMinor, billboard.reserveFloorMinor, slots.length, policy.floorRatio);
    const askMinor = openingAsk(priced.finalAmountMinor, floorMinor);
    const offerExpiresAt = now + policy.offerTtlMs;
    const traceId = `a2a_${crypto.randomUUID()}`;
    const negotiationId = await ctx.db.insert("negotiations", {
      workspaceId,
      billboardId: billboard._id,
      advertiserId: agent.key.advertiserId,
      campaignId: campaign._id,
      agentKeyId: agent.key._id,
      slotIds,
      status: "open",
      screenMinor,
      askMinor,
      floorMinor,
      sellerMinor: askMinor,
      rounds: 0,
      maxRounds: policy.maxRounds,
      offerTtlMs: policy.offerTtlMs,
      offerExpiresAt,
      traceId,
      updatedAt: now,
    });
    const n = (await ctx.db.get(negotiationId))!;
    await recordAudit(ctx, {
      workspaceId,
      traceId,
      actor: agent.actor,
      type: "negotiation.opened",
      subjectId: negotiationId,
      reason: `${agent.actor} opened a negotiation with ${sellerActor(workspace)} for ${slots.length} slot(s) on ${billboard.name}; ask ${usd(askMinor)} (screen ${usd(screenMinor)})`,
      data: { campaignId: campaign._id, slotIds, askMinor, screenMinor, floorMinor, maxRounds: policy.maxRounds },
    });
    const stages = priced.screenBreakdown[0]?.stages
      .filter((s) => s.effective !== 1)
      .map((s) => `${s.key} x${s.effective.toFixed(2)}`)
      .join(", ");
    await addMessage(ctx, n, {
      from: "seller",
      actor: sellerActor(workspace),
      kind: "ask",
      amountMinor: askMinor,
      reasoning: `Our price for ${slots.length} slot(s) on ${billboard.name} is ${usd(askMinor)}${stages ? ` (screen pricing: ${stages})` : ""}. Each position is valid for ${Math.round(policy.offerTtlMs / 1000)}s; up to ${policy.maxRounds} offers.`,
    });
    await ctx.scheduler.runAt(offerExpiresAt, internal.negotiations.expire, { negotiationId });
    if (opening !== undefined) await handleOffer(ctx, n, agent, workspace, opening, args.reasoning);
    return await viewOf(ctx, (await ctx.db.get(negotiationId))!);
  },
});

/** POST /a2a/hosts/{workspaceId}/negotiations/{id}/messages: offer | accept | reject. */
export const post = internalMutation({
  args: {
    token: v.string(),
    workspaceId: v.string(),
    negotiationId: v.string(),
    kind: v.union(v.literal("offer"), v.literal("accept"), v.literal("reject")),
    amountMinor: v.optional(v.number()),
    reasoning: v.optional(v.string()),
  },
  returns: negotiationView,
  handler: async (ctx, args) => {
    const agent = await authBuyer(ctx, args.token);
    const n = await ctx.db.get(idOf(ctx, "negotiations", args.negotiationId, "Negotiation"));
    if (!n || n.workspaceId !== args.workspaceId || n.advertiserId !== agent.key.advertiserId) fail("NOT_FOUND", "Negotiation not found");
    if (n.agentKeyId !== agent.key._id) fail("FORBIDDEN", "Only the agent key that opened this negotiation can continue it");
    if (n.status !== "open") fail("NEGOTIATION_CLOSED", `Negotiation is ${n.status}`, { status: n.status });
    const workspace = (await ctx.db.get(n.workspaceId))!;
    const now = Date.now();
    if (now >= n.offerExpiresAt) {
      await addMessage(ctx, n, {
        from: "system",
        actor: "system",
        kind: "expired",
        reasoning: `The seller's ${usd(n.sellerMinor)} position expired at ${new Date(n.offerExpiresAt).toISOString()} before a reply.`,
      });
      await close(ctx, n, "expired", "system", "offer expired");
      return await viewOf(ctx, (await ctx.db.get(n._id))!);
    }
    if (args.kind === "offer") {
      await handleOffer(ctx, n, agent, workspace, assertAmount(args.amountMinor), args.reasoning);
    } else if (args.kind === "accept") {
      await addMessage(ctx, n, {
        from: "buyer",
        actor: agent.actor,
        kind: "accept",
        amountMinor: n.sellerMinor,
        reasoning: cleanReasoning(args.reasoning, `Accept ${usd(n.sellerMinor)}.`),
      });
      await agree(ctx, n, agent, n.sellerMinor, workspace.name);
    } else {
      await addMessage(ctx, n, {
        from: "buyer",
        actor: agent.actor,
        kind: "reject",
        reasoning: cleanReasoning(args.reasoning, "No deal."),
      });
      await close(ctx, n, "rejected", agent.actor, "buyer walked away");
    }
    return await viewOf(ctx, (await ctx.db.get(n._id))!);
  },
});

/** GET a negotiation (the buyer key that opened it). */
export const get = internalMutation({
  args: { token: v.string(), workspaceId: v.string(), negotiationId: v.string() },
  returns: negotiationView,
  handler: async (ctx, args) => {
    const agent = await authenticateAgent(ctx, args.token, null);
    const n = await ctx.db.get(idOf(ctx, "negotiations", args.negotiationId, "Negotiation"));
    if (!n || n.workspaceId !== args.workspaceId || n.advertiserId !== agent.key.advertiserId) fail("NOT_FOUND", "Negotiation not found");
    return await viewOf(ctx, n);
  },
});

/** Scheduled at each seller position's expiry. */
export const expire = internalMutation({
  args: { negotiationId: v.id("negotiations") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const n = await ctx.db.get(args.negotiationId);
    if (!n || n.status !== "open" || Date.now() < n.offerExpiresAt) return null;
    await addMessage(ctx, n, {
      from: "system",
      actor: "system",
      kind: "expired",
      reasoning: `No reply before the seller's ${usd(n.sellerMinor)} position expired.`,
    });
    await close(ctx, n, "expired", "system", "offer expired");
    return null;
  },
});

// ---------------------------------------------------------------- timelines (UI)

export const timelineItem = v.object({
  negotiation: negotiationView,
  billboardName: v.string(),
  companyName: v.string(),
  campaignBrief: v.string(),
  createdAt: v.number(),
  payment: v.union(
    v.object({
      status: v.string(),
      amountMinor: v.number(),
      externalRef: v.string(),
      network: v.union(v.string(), v.null()),
      recordedAt: v.number(),
    }),
    v.null(),
  ),
});

async function timeline(ctx: QueryCtx, rows: Doc<"negotiations">[]) {
  const out = [];
  for (const n of rows) {
    const payment = n.holdId
      ? await ctx.db
          .query("payments")
          .withIndex("by_hold", (q) => q.eq("holdId", n.holdId!))
          .first()
      : null;
    out.push({
      negotiation: await viewOf(ctx, n),
      billboardName: (await ctx.db.get(n.billboardId))?.name ?? "Unknown screen",
      companyName: (await ctx.db.get(n.advertiserId))?.displayName ?? "Unknown company",
      campaignBrief: (await ctx.db.get(n.campaignId))?.brief ?? "",
      createdAt: n._creationTime,
      payment: payment
        ? {
            status: payment.status,
            amountMinor: payment.amountMinor,
            externalRef: payment.externalRef,
            network: payment.network ?? null,
            recordedAt: payment._creationTime,
          }
        : null,
    });
  }
  return out;
}

/** Host console: this workspace's seller-agent conversations, newest first. */
export const forWorkspace = query({
  args: { workspaceId: v.optional(v.id("workspaces")) },
  returns: v.array(timelineItem),
  handler: async (ctx, args) => {
    const me = await resolveWorkspace(ctx, args.workspaceId);
    const rows = await ctx.db
      .query("negotiations")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", me.workspaceId))
      .order("desc")
      .take(20);
    return await timeline(ctx, rows);
  },
});

/** Customer dashboard: their own agents' negotiations, newest first. */
export const mine = query({
  args: { advertiserId: v.optional(v.id("advertisers")) },
  returns: v.array(timelineItem),
  handler: async (ctx, args) => {
    const customer = await requireCustomer(ctx, args.advertiserId);
    const rows = await ctx.db
      .query("negotiations")
      .withIndex("by_advertiser", (q) => q.eq("advertiserId", customer.advertiserId))
      .order("desc")
      .take(20);
    return await timeline(ctx, rows);
  },
});
