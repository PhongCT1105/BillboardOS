"use node";
/**
 * Company agents, the acting half (spec "How company agents bid"). Each one
 * talks to BillboardOS only over its public HTTP API, like a customer's own
 * service would, and pays from its own Base Sepolia CDP wallet:
 *   flash_offer         -> onAnnounce -> POST /api/agent/offers/{id}/reply
 *   auction_* events    -> onUpdate   -> POST /api/agent/offers/{id}/bid
 *   negotiation_counter -> onCounter  -> POST /api/agent/offers/{id}/reply
 *   flash_won           -> POST the x402 purchase URL -> 402 -> pay from wallet co-<advertiserId>
 * Its cap never exceeds its max per spot, what is left of its daily budget, or
 * its wallet balance. If it can't pay (no CDP keys on this deployment, an empty
 * wallet, x402 refused) the moment records "payment blocked" and the spot goes
 * to the runner-up. Nothing is faked as paid.
 */
import { v } from "convex/values";
import { internalAction, type ActionCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { decryptSecret } from "./lib/demoCrypto";
import { agentCap, bidDelayMs, onAnnounce, onCounter, onUpdate } from "./lib/companyAgent";
import { centsToAtomic } from "./lib/x402/money";

const NETWORK = "base-sepolia";
const USDC_FAUCET_BELOW_MINOR = 100;
/** Gas for the operator's USDC transfers: claim faucet ETH under 0.00002 ETH. */
const MIN_OPERATOR_WEI = 20_000_000_000_000n;
const ATOMIC_PER_CENT = 10_000n;
/** Faucet and transfer transactions take a few seconds to land: read the balance again after this. */
const BALANCE_RECHECK_MS = 15_000;

function siteUrl(): string {
  return (process.env.CONVEX_SITE_URL ?? "https://billboardos.invalid").replace(/\/$/, "");
}

const canPay = () => Boolean(process.env.CDP_API_KEY_ID && process.env.CDP_API_KEY_SECRET && process.env.CDP_WALLET_SECRET);
const usd = (minor: number) => `$${(minor / 100).toFixed(2)}`;
const errText = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 150);

type Payload = {
  type?: string;
  offerId?: string;
  // flash_offer
  valueMinor?: number | null;
  openingMinor?: number;
  priceMinor?: number;
  minimumMinor?: number;
  relevantViewers?: number;
  audienceMatch?: number;
  // auction_started / auction_update
  minNextMinor?: number;
  youLead?: boolean;
  bidsLeft?: number;
  // negotiation_counter
  sellerMinor?: number;
  yourLastOfferMinor?: number | null;
  roundsLeft?: number;
  // flash_won
  holdId?: string;
  amountMinor?: number;
  purchaseUrl?: string;
  links?: { reply?: string; bid?: string };
};

async function cdpClient() {
  const { CdpClient } = await import("@coinbase/cdp-sdk");
  return new CdpClient();
}
type Cdp = Awaited<ReturnType<typeof cdpClient>>;

/** USDC (in cents, rounded down) and ETH (in wei) held by an address on Base Sepolia. */
async function balancesOf(cdp: Cdp, address: string): Promise<{ usdcMinor: number; ethWei: bigint }> {
  const { balances } = await cdp.evm.listTokenBalances({ address: address as `0x${string}`, network: NETWORK });
  const usdc = balances.find((b) => b.token.symbol?.toUpperCase() === "USDC");
  const eth = balances.find((b) => b.token.symbol?.toUpperCase() === "ETH");
  const usdcMinor = usdc ? Number((usdc.amount.amount * 100n) / 10n ** BigInt(usdc.amount.decimals)) : 0;
  const ethWei = eth ? (eth.amount.amount * 10n ** 18n) / 10n ** BigInt(eth.amount.decimals) : 0n;
  return { usdcMinor, ethWei };
}

/** Read the company wallet's USDC and save it (cents). Returns the balance, or null when it can't be read. */
async function saveBalance(ctx: ActionCtx, advertiserId: Id<"advertisers">, cdp?: Cdp): Promise<number | null> {
  const me = await ctx.runQuery(internal.companyAgents.forAct, { advertiserId, now: Date.now() });
  if (!me || !canPay()) return null;
  const client = cdp ?? (await cdpClient());
  const account = await client.evm.getOrCreateAccount({ name: me.walletName });
  const { usdcMinor } = await balancesOf(client, account.address);
  await ctx.runMutation(internal.companyAgents.setWallet, { advertiserId, walletAddress: account.address, balanceMinor: usdcMinor });
  return usdcMinor;
}

function logger(ctx: ActionCtx, advertiserId: Id<"advertisers">) {
  return (action: string) => ctx.runMutation(internal.companyAgents.logAction, { advertiserId, action });
}

/** Create the company's wallet on first use; claim faucet USDC once when it holds under $1. */
export const ensureWallet = internalAction({
  args: { advertiserId: v.id("advertisers") },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const me = await ctx.runQuery(internal.companyAgents.forAct, { advertiserId: args.advertiserId, now: Date.now() });
    if (!me) return null;
    const log = logger(ctx, args.advertiserId);
    if (!canPay()) {
      await log("wallet: no CDP keys on this deployment (set CDP_API_KEY_ID, CDP_API_KEY_SECRET, CDP_WALLET_SECRET)");
      return null;
    }
    try {
      const cdp = await cdpClient();
      const account = await cdp.evm.getOrCreateAccount({ name: me.walletName });
      const { usdcMinor } = await balancesOf(cdp, account.address);
      let note = "";
      if (usdcMinor < USDC_FAUCET_BELOW_MINOR) {
        const { transactionHash } = await cdp.evm.requestFaucet({ address: account.address, network: NETWORK, token: "usdc" });
        note = `; faucet USDC requested, tx ${transactionHash}`;
        await ctx.scheduler.runAfter(BALANCE_RECHECK_MS, internal.companyAgentsNode.refreshBalance, { advertiserId: args.advertiserId });
      }
      await ctx.runMutation(internal.companyAgents.setWallet, { advertiserId: args.advertiserId, walletAddress: account.address, balanceMinor: usdcMinor });
      await log(`wallet ${account.address}: ${usd(usdcMinor)} USDC${note}`);
    } catch (error) {
      await log(`wallet: failed: ${errText(error)}`);
    }
    return null;
  },
});

/** Read the wallet's on-chain USDC balance and save it as cents. */
export const refreshBalance = internalAction({
  args: { advertiserId: v.id("advertisers") },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    if (!canPay()) return null;
    try {
      await saveBalance(ctx, args.advertiserId);
    } catch (error) {
      await logger(ctx, args.advertiserId)(`balance: failed: ${errText(error)}`);
    }
    return null;
  },
});

/**
 * Top up the company wallet: a real USDC transfer from the operator's
 * receiving wallet when it holds enough (claiming faucet ETH for gas first if
 * needed), otherwise faucet USDC straight to the company wallet.
 */
export const topUp = internalAction({
  args: { advertiserId: v.id("advertisers"), amountMinor: v.number() },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const me = await ctx.runQuery(internal.companyAgents.forAct, { advertiserId: args.advertiserId, now: Date.now() });
    if (!me) return null;
    const log = logger(ctx, args.advertiserId);
    if (!canPay()) {
      await log("top up: no CDP keys on this deployment");
      return null;
    }
    try {
      const cdp = await cdpClient();
      const company = await cdp.evm.getOrCreateAccount({ name: me.walletName });
      const operator = await cdp.evm.getOrCreateAccount({ name: process.env.X402_RECEIVER_WALLET_NAME || "billboardos-operator" });
      const op = await balancesOf(cdp, operator.address);
      if (op.usdcMinor >= args.amountMinor) {
        if (op.ethWei < MIN_OPERATOR_WEI) {
          await cdp.evm.requestFaucet({ address: operator.address, network: NETWORK, token: "eth" });
          // Wait (briefly) for the gas to land before sending.
          for (let i = 0; i < 10; i++) {
            await new Promise((r) => setTimeout(r, 2_000));
            if ((await balancesOf(cdp, operator.address)).ethWei >= MIN_OPERATOR_WEI) break;
          }
        }
        const { transactionHash } = await operator.transfer({
          to: company.address,
          amount: BigInt(args.amountMinor) * ATOMIC_PER_CENT,
          token: "usdc",
          network: NETWORK,
        });
        await log(`top up: ${usd(args.amountMinor)} USDC from the operator wallet, tx ${transactionHash}`);
      } else {
        const { transactionHash } = await cdp.evm.requestFaucet({ address: company.address, network: NETWORK, token: "usdc" });
        await log(`top up: operator wallet short, faucet USDC requested, tx ${transactionHash}`);
      }
      await saveBalance(ctx, args.advertiserId, cdp);
      await ctx.scheduler.runAfter(BALANCE_RECHECK_MS, internal.companyAgentsNode.refreshBalance, { advertiserId: args.advertiserId });
    } catch (error) {
      await log(`top up: failed: ${errText(error)}`);
    }
    return null;
  },
});

/** The agent reacts to one of our webhooks (already verified), over the public agent API. */
export const act = internalAction({
  args: { advertiserId: v.id("advertisers"), payload: v.any() },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const payload = (args.payload ?? {}) as Payload;
    const me = await ctx.runQuery(internal.companyAgents.forAct, {
      advertiserId: args.advertiserId,
      now: Date.now(),
      offerId: typeof payload.offerId === "string" ? payload.offerId : undefined,
    });
    if (!me) return null;
    const log = logger(ctx, args.advertiserId);
    const type = payload.type ?? "unknown";
    if (!me.enabled) {
      await log(`${type}: agent is off`);
      return null;
    }
    const secret = process.env.INTERNAL_API_SECRET;
    if (!secret) {
      await log(`${type}: cannot act: INTERNAL_API_SECRET missing (key store locked)`);
      return null;
    }
    const key = await decryptSecret(secret, me.keyCiphertext, me.keyIv);
    const post = async (path: string, body: Record<string, unknown>) => {
      const res = await fetch(`${siteUrl()}${path}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = (await res.json().catch(() => ({}))) as { error?: { code?: string } };
      return `HTTP ${res.status}${json.error?.code ? ` ${json.error.code}` : ""}`;
    };
    const standing = me.standing;
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
        await log(`${type}: ${payload.youLead ? "leading" : "holding"}`);
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
      });
      const result = await post(payload.links.reply, {
        decision: decision.decision,
        amountMinor: decision.decision === "pass" ? undefined : decision.amountMinor,
        reasoning: `Company agent: ${decision.decision}`,
      });
      await log(`negotiation_counter: ${decision.decision}${decision.amountMinor ? ` ${usd(decision.amountMinor)}` : ""} (${decision.reasoning}) -> ${result}`);
      return null;
    }

    if (type === "flash_won") {
      if (!payload.holdId || !payload.purchaseUrl || !payload.amountMinor) return null;
      const holdId = payload.holdId as Id<"holds">;
      const blocked = async (reason: string) => {
        await ctx.runMutation(internal.moments.paymentBlocked, { holdId, reason });
        await ctx.runMutation(internal.liveAuction.paymentFailed, { holdId, reason });
        await log(`flash_won: payment blocked: ${reason}`);
      };
      if (!canPay()) {
        await blocked("no CDP keys on this deployment, so the company wallet can't sign");
        return null;
      }
      const init = { method: "POST", headers: { Authorization: `Bearer ${key}` } };
      try {
        const probe = await fetch(payload.purchaseUrl, init);
        if (probe.status !== 402) {
          const body = (await probe.json().catch(() => ({}))) as { error?: string | { code?: string } };
          const code = typeof body.error === "string" ? body.error : body.error?.code;
          await blocked(code ?? `HTTP ${probe.status}`);
          return null;
        }
        const { CdpX402Client } = await import("@coinbase/cdp-sdk/x402");
        const { wrapFetchWithPayment, decodePaymentResponseHeader } = await import("@x402/fetch");
        const network = (process.env.X402_NETWORK || "eip155:84532") as `${string}:${string}`;
        const client = new CdpX402Client({
          environment: process.env.X402_ENVIRONMENT === "production" ? "production" : "development",
          walletConfig: { type: "eoa", accountName: me.walletName },
          spendControls: { maxAmountPerPayment: { atomic: centsToAtomic(payload.amountMinor) }, allowedNetworks: [network] },
        });
        const paidFetch = wrapFetchWithPayment(globalThis.fetch, client);
        const res = await paidFetch(payload.purchaseUrl, init);
        const header = res.headers.get("PAYMENT-RESPONSE") ?? res.headers.get("X-PAYMENT-RESPONSE");
        const settled = header ? decodePaymentResponseHeader(header) : null;
        if (res.status === 200 && settled?.success) {
          await log(`flash_won: paid ${usd(payload.amountMinor)}, tx ${settled.transaction}`);
          await saveBalance(ctx, args.advertiserId).catch(() => null);
        } else {
          await blocked(`payment failed (HTTP ${res.status}${settled?.errorReason ? `, ${settled.errorReason}` : ""})`);
        }
      } catch (error) {
        await blocked(`payment failed: ${errText(error)} (empty wallet? top it up)`);
      }
      return null;
    }

    if (type === "flash_lost") await log("flash_lost: another company won the spot");
    return null;
  },
});
