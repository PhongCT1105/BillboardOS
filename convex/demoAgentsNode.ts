"use node";
/**
 * Hosted demo customer agents, the "external" half (ADR 0006). Labeled
 * "simulated customer agent". They talk to BillboardOS only over its public
 * HTTP API, exactly like a customer's own service would:
 *   flash_offer -> standing instructions decide -> POST /api/agent/offers/{id}/reply
 *   flash_won   -> POST the x402 purchase URL -> 402 -> pay from wallet demo-<slug>
 * If payments are unavailable (no CDP env on this deployment, or no wallet),
 * the agent records "payment blocked" and stops. Nothing is faked as paid.
 */
import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { decryptSecret } from "./lib/demoCrypto";
import { standingDecision, type Standing } from "./lib/moment";
import { centsToAtomic } from "./lib/x402/money";

function siteUrl(): string {
  return (process.env.CONVEX_SITE_URL ?? "https://billboardos.invalid").replace(/\/$/, "");
}

const canPay = () => Boolean(process.env.CDP_API_KEY_ID && process.env.CDP_API_KEY_SECRET && process.env.CDP_WALLET_SECRET);

type OfferPayload = {
  type: "flash_offer";
  offerId: string;
  priceMinor: number;
  relevantViewers: number;
  standingInstructions: Standing | null;
  links: { base: string; reply: string };
};
type WonPayload = { type: "flash_won"; offerId: string; holdId: string; amountMinor: number; purchaseUrl: string };

export const act = internalAction({
  args: { advertiserId: v.id("advertisers"), payload: v.any() },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const me = await ctx.runQuery(internal.demoAgents.forAct, { advertiserId: args.advertiserId });
    if (!me) return null;
    const log = (action: string) => ctx.runMutation(internal.demoAgents.logAction, { advertiserId: args.advertiserId, action });
    const secret = process.env.INTERNAL_API_SECRET;
    if (!secret) {
      await log("cannot act: INTERNAL_API_SECRET missing (key store locked)");
      return null;
    }
    const key = await decryptSecret(secret, me.keyCiphertext, me.keyIv);
    const payload = args.payload as { type?: string };

    if (payload.type === "flash_offer") {
      const offer = payload as OfferPayload;
      // A little "think time" so replies arrive in a realistic order.
      const thinkMs = process.env.DEMO_AGENT_THINK_MS !== undefined ? Number(process.env.DEMO_AGENT_THINK_MS) : me.thinkMs;
      if (thinkMs > 0) await new Promise((r) => setTimeout(r, thinkMs));
      const standing = offer.standingInstructions;
      const decision = standing
        ? standingDecision(standing, { priceMinor: offer.priceMinor, relevantViewers: offer.relevantViewers })
        : { decision: "pass" as const, reasoning: "No standing instructions." };
      const res = await fetch(`${siteUrl()}${offer.links.reply}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ decision: decision.decision, amountMinor: decision.amountMinor, reasoning: `[simulated customer agent] ${decision.reasoning}` }),
      });
      await log(`flash_offer ${offer.offerId}: ${decision.decision}${decision.amountMinor ? ` ${decision.amountMinor}` : ""} -> HTTP ${res.status}`);
      return null;
    }

    if (payload.type === "flash_won") {
      const won = payload as WonPayload;
      const init = { method: "POST", headers: { Authorization: `Bearer ${key}` } };
      const probe = await fetch(won.purchaseUrl, init);
      const probeBody = (await probe.json().catch(() => ({}))) as { error?: string | { code?: string } };
      const code = typeof probeBody.error === "string" ? probeBody.error : probeBody.error?.code;
      if (probe.status !== 402) {
        const reason = code ?? `HTTP ${probe.status}`;
        await ctx.runMutation(internal.moments.paymentBlocked, { holdId: won.holdId as Id<"holds">, reason });
        await log(`flash_won ${won.holdId}: payment blocked: ${reason}`);
        return null;
      }
      if (!canPay()) {
        await ctx.runMutation(internal.moments.paymentBlocked, { holdId: won.holdId as Id<"holds">, reason: "no wallet (CDP_WALLET_SECRET not set)" });
        await log(`flash_won ${won.holdId}: got 402, payment blocked: no wallet`);
        return null;
      }
      try {
        const { CdpX402Client } = await import("@coinbase/cdp-sdk/x402");
        const { wrapFetchWithPayment, decodePaymentResponseHeader } = await import("@x402/fetch");
        const network = (process.env.X402_NETWORK || "eip155:84532") as `${string}:${string}`;
        const client = new CdpX402Client({
          environment: process.env.X402_ENVIRONMENT === "production" ? "production" : "development",
          walletConfig: { type: "eoa", accountName: me.walletName },
          spendControls: { maxAmountPerPayment: { atomic: centsToAtomic(won.amountMinor) }, allowedNetworks: [network] },
        });
        const paidFetch = wrapFetchWithPayment(globalThis.fetch, client);
        const res = await paidFetch(won.purchaseUrl, init);
        const header = res.headers.get("PAYMENT-RESPONSE") ?? res.headers.get("X-PAYMENT-RESPONSE");
        const settled = header ? decodePaymentResponseHeader(header) : null;
        if (res.status === 200 && settled?.success) {
          await log(`flash_won ${won.holdId}: paid, tx ${settled.transaction}`);
        } else {
          const reason = `payment failed (HTTP ${res.status}${settled?.errorReason ? `, ${settled.errorReason}` : ""})`;
          await ctx.runMutation(internal.moments.paymentBlocked, { holdId: won.holdId as Id<"holds">, reason });
          await log(`flash_won ${won.holdId}: ${reason}`);
        }
      } catch (error) {
        const reason = `payment failed: ${error instanceof Error ? error.message.slice(0, 150) : String(error)} (empty wallet? run demoAgentsNode:fundWallets)`;
        await ctx.runMutation(internal.moments.paymentBlocked, { holdId: won.holdId as Id<"holds">, reason });
        await log(`flash_won ${won.holdId}: ${reason}`);
      }
      return null;
    }

    if (payload.type === "flash_lost") await log("flash_lost: another agent won");
    return null;
  },
});

/** Request Base Sepolia test USDC for each demo agent's wallet (needs CDP env). */
export const fundWallets = internalAction({
  args: {},
  returns: v.array(v.object({ walletName: v.string(), address: v.union(v.string(), v.null()), result: v.string() })),
  handler: async (ctx): Promise<{ walletName: string; address: string | null; result: string }[]> => {
    const agents: { walletName: string }[] = await ctx.runQuery(internal.demoAgents.listDemo, {});
    if (!canPay()) {
      return agents.map((a) => ({ walletName: a.walletName, address: null, result: "skipped: set CDP_API_KEY_ID, CDP_API_KEY_SECRET and CDP_WALLET_SECRET" }));
    }
    const { CdpClient } = await import("@coinbase/cdp-sdk");
    const cdp = new CdpClient();
    const out = [];
    for (const a of agents) {
      try {
        const account = await cdp.evm.getOrCreateAccount({ name: a.walletName });
        const { transactionHash } = await cdp.evm.requestFaucet({ address: account.address, network: "base-sepolia", token: "usdc" });
        out.push({ walletName: a.walletName, address: account.address, result: `faucet tx ${transactionHash}` });
      } catch (error) {
        out.push({ walletName: a.walletName, address: null, result: `failed: ${error instanceof Error ? error.message.slice(0, 150) : String(error)}` });
      }
    }
    return out;
  },
});
