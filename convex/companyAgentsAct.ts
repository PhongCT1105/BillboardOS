/**
 * Company agents, the fast path. Each agent talks to BillboardOS only over its
 * public HTTP API, like a customer's own service. The model call has a short
 * timeout so a slow response falls back to local rules during the auction:
 *   round_offer / round_counter -> Bitdeer Model Studio or the rules -> POST /api/agent/rounds/{id}/bid
 *   round_won                   -> companyAgentsNode.pay (Node: the CDP wallet signs the x402 payment)
 *   round_lost                  -> logged
 * It never offers more than its max per spot, what is left of its daily
 * budget, or its wallet balance; with the balance not read yet it passes and
 * says so.
 */
import { v } from "convex/values";
import { env, internalAction, type ActionCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { decryptSecret } from "./lib/demoCrypto";
import { agentSiteUrl, type AgentPayload } from "./lib/companyAgent";
import { clampAnswer, ruleBasedStrategy } from "./lib/rounds";

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
    if (type === "round_won") {
      // Paying needs the CDP SDK (Node); it re-checks everything itself.
      await ctx.scheduler.runAfter(0, internal.companyAgentsNode.pay, { advertiserId: args.advertiserId, payload: args.payload });
      return null;
    }
    const me = await ctx.runQuery(internal.companyAgents.forAct, { advertiserId: args.advertiserId, now: Date.now() });
    if (!me) return null;
    const log = logger(ctx, args.advertiserId);
    if (!me.enabled) {
      await log(`${type}: agent is off`);
      return null;
    }
    if (type === "round_lost") {
      await log("round_lost: another company took the spot");
      return null;
    }
    if (type !== "round_offer" && type !== "round_counter") return null;
    if (!payload.links?.bid || payload.floorMinor === undefined) return null;
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
    const standing = me.standing;
    const priceMinor = payload.priceMinor ?? payload.askingMinor ?? payload.floorMinor;
    const limits = {
      floorMinor: payload.floorMinor,
      priceMinor,
      maxPerSpotMinor: standing?.maxPricePerSpotMinor ?? 0,
      budgetLeftMinor: standing ? standing.dailyBudgetMinor - me.spentTodayMinor : 0,
      balanceMinor: me.balanceMinor,
    };
    let decision = ruleBasedStrategy(limits);
    // Bitdeer handles repeated buyer decisions; the local rules still enforce every spending limit.
    if (env.BITDEER_API_KEY && me.balanceMinor !== null) {
      const capMinor = Math.max(0, Math.min(limits.maxPerSpotMinor, limits.budgetLeftMinor, me.balanceMinor));
      const brain = await ctx
        .runAction(internal.bitdeerBrain.decide, { company: me.company, research: me.research, capMinor, payload: args.payload })
        .catch(() => null);
      if (brain) decision = clampAnswer({ ...brain, priceMinor, floorMinor: payload.floorMinor, capMinor });
    }
    let result: string;
    try {
      const res = await fetch(`${agentSiteUrl()}${payload.links.bid}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ amountMinor: decision.amountMinor, reasoning: decision.reasoning }),
      });
      const json = (await res.json().catch(() => ({}))) as { error?: { code?: string }; status?: string };
      result = `HTTP ${res.status}${json.error?.code ? ` ${json.error.code}` : json.status ? ` ${json.status}` : ""}`;
    } catch (error) {
      result = `request failed: ${errText(error)}`;
    }
    await log(`${type}: ${decision.amountMinor === null ? "pass" : `offer ${usd(decision.amountMinor)}`} (${decision.reasoning}) -> ${result}`);
    return null;
  },
});
