/**
 * Company agents, the fast path (spec "How company agents bid", Ruling R25).
 * Announce, bid and counter run in the default (V8) runtime, so a Node cold
 * start can't make an agent miss the 2 s join window. Each agent talks to
 * BillboardOS only over its public HTTP API, like a customer's own service:
 *   flash_offer         -> onAnnounce -> POST /api/agent/offers/{id}/reply
 *   auction_* events    -> onUpdate   -> POST /api/agent/offers/{id}/bid
 *   negotiation_counter -> onCounter  -> POST /api/agent/offers/{id}/reply
 *   flash_won           -> companyAgentsNode.pay (Node: the CDP wallet signs the x402 payment)
 * Its cap never exceeds its max per spot, what is left of its daily budget, or
 * its wallet balance; with the balance not read yet it sits out and says so.
 */
import { v } from "convex/values";
import { internalAction, type ActionCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { decryptSecret } from "./lib/demoCrypto";
import { agentCap, agentSiteUrl, bidDelayMs, onAnnounce, onCounter, onUpdate, type AgentPayload } from "./lib/companyAgent";

const usd = (minor: number) => `$${(minor / 100).toFixed(2)}`;
const errText = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 150);

function logger(ctx: ActionCtx, advertiserId: Id<"advertisers">) {
  return (action: string) => ctx.runMutation(internal.companyAgents.logAction, { advertiserId, action });
}

/** The agent reacts to one of our webhooks (already verified), over the public agent API. */
export const act = internalAction({
  args: { advertiserId: v.id("advertisers"), payload: v.any() },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const payload = (args.payload ?? {}) as AgentPayload;
    const type = payload.type ?? "unknown";
    if (type === "flash_won") {
      // Paying needs the CDP SDK (Node); it re-checks everything itself.
      await ctx.scheduler.runAfter(0, internal.companyAgentsNode.pay, { advertiserId: args.advertiserId, payload: args.payload });
      return null;
    }
    const me = await ctx.runQuery(internal.companyAgents.forAct, {
      advertiserId: args.advertiserId,
      now: Date.now(),
      offerId: typeof payload.offerId === "string" ? payload.offerId : undefined,
    });
    if (!me) return null;
    const log = logger(ctx, args.advertiserId);
    if (!me.enabled) {
      await log(`${type}: agent is off`);
      return null;
    }
    if (type === "flash_lost") {
      await log("flash_lost: another company won the spot");
      return null;
    }
    const secret = process.env.INTERNAL_API_SECRET;
    if (!secret) {
      await log(`${type}: cannot act: INTERNAL_API_SECRET missing (key store locked)`);
      return null;
    }
    let key: string;
    try {
      key = await decryptSecret(secret, me.keyCiphertext, me.keyIv);
    } catch (error) {
      await log(`${type}: cannot act: the stored key can't be decrypted (${errText(error)}); set the agent up again`);
      return null;
    }
    /** POST to our own agent API; the outcome (or the network error) goes to lastAction, never thrown. */
    const post = async (path: string, body: Record<string, unknown>): Promise<string> => {
      try {
        const res = await fetch(`${agentSiteUrl()}${path}`, {
          method: "POST",
          headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const json = (await res.json().catch(() => ({}))) as { error?: { code?: string } };
        return `HTTP ${res.status}${json.error?.code ? ` ${json.error.code}` : ""}`;
      } catch (error) {
        return `request failed: ${errText(error)}`;
      }
    };
    const standing = me.standing;
    const balanceUnknown = me.balanceMinor === null;
    // The private cap: never above the max per spot, the budget left today, or the wallet balance.
    const cap = (valueMinor: number | null | undefined, matchScore: number | undefined) =>
      standing
        ? agentCap({
            valueMinor: valueMinor ?? 0,
            matchScore: matchScore ?? 0,
            maxPerSpotMinor: standing.maxPricePerSpotMinor,
            budgetLeftMinor: standing.dailyBudgetMinor - me.spentTodayMinor,
            balanceMinor: me.balanceMinor ?? 0,
          })
        : 0;

    if (type === "flash_offer") {
      if (!payload.links?.reply) return null;
      const opening = payload.openingMinor ?? payload.priceMinor ?? 0;
      const decision = onAnnounce({
        openingMinor: opening,
        minimumMinor: payload.minimumMinor ?? opening,
        relevantViewers: payload.relevantViewers ?? 0,
        minRelevantViewers: standing?.minRelevantViewers ?? Number.MAX_SAFE_INTEGER,
        cap: cap(payload.valueMinor, payload.audienceMatch),
        balanceUnknown,
      });
      // The cap stays private: the host sees the decision, not our reasoning.
      const result = await post(payload.links.reply, {
        decision: decision.decision,
        amountMinor: decision.decision === "pass" ? undefined : decision.amountMinor,
        reasoning: `Company agent: ${decision.decision}`,
      });
      await log(`flash_offer: ${decision.decision}${decision.amountMinor ? ` ${usd(decision.amountMinor)}` : ""} (${decision.reasoning}) -> ${result}`);
      return null;
    }

    if (type === "auction_started" || type === "auction_update") {
      if (!payload.links?.bid && !payload.offerId) return null;
      const next = onUpdate({
        youLead: payload.youLead === true,
        bidsLeft: payload.bidsLeft ?? 0,
        minNextMinor: payload.minNextMinor ?? Number.MAX_SAFE_INTEGER,
        cap: cap(me.offer?.valueMinor, me.offer?.matchScore),
      });
      if (!next) {
        await log(`${type}: ${payload.youLead ? "leading" : balanceUnknown ? "holding (wallet balance unknown)" : "holding"}`);
        return null;
      }
      const delayMs = process.env.COMPANY_AGENT_DELAY_MS === "0" ? 0 : bidDelayMs(Math.random());
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
      const result = await post(payload.links?.bid ?? `/api/agent/offers/${payload.offerId}/bid`, {
        amountMinor: next.bidMinor,
        reasoning: "Outbid: raising by the minimum step",
      });
      await log(`${type}: bid ${usd(next.bidMinor)} -> ${result}`);
      return null;
    }

    if (type === "negotiation_counter") {
      if (!payload.links?.reply || payload.sellerMinor === undefined) return null;
      const decision = onCounter({
        sellerMinor: payload.sellerMinor,
        lastOfferMinor: payload.yourLastOfferMinor ?? 0,
        cap: cap(me.offer?.valueMinor, me.offer?.matchScore),
        balanceUnknown,
      });
      const result = await post(payload.links.reply, {
        decision: decision.decision,
        amountMinor: decision.decision === "pass" ? undefined : decision.amountMinor,
        reasoning: `Company agent: ${decision.decision}`,
      });
      await log(`negotiation_counter: ${decision.decision}${decision.amountMinor ? ` ${usd(decision.amountMinor)}` : ""} (${decision.reasoning}) -> ${result}`);
      return null;
    }

    return null;
  },
});
