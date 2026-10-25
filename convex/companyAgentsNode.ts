"use node";
/**
 * Company agents, the wallet half (spec "How company agents bid"). Everything
 * here needs the CDP SDK, so it runs on Node: the company's Base Sepolia
 * wallet (`co-<advertiserId>`), its balance, top-ups and the x402 payment
 * for a won spot. Announce, bid and counter run in V8 (companyAgentsAct.ts,
 * Ruling R25) so a cold start never costs an agent the join window.
 *   flash_won -> POST the x402 purchase URL -> 402 -> pay from wallet co-<advertiserId>
 * If it can't pay (no CDP keys on this deployment, an empty wallet, x402
 * refused) the moment records "payment blocked" and the spot goes to the
 * runner-up. Nothing is faked as paid.
 */
import { v } from "convex/values";
import { internalAction, type ActionCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { decryptSecret } from "./lib/demoCrypto";
import { agentSiteUrl, type AgentPayload } from "./lib/companyAgent";
import { centsToAtomic } from "./lib/x402/money";

const NETWORK = "base-sepolia";
const USDC_FAUCET_BELOW_MINOR = 100;
/** Gas for the operator's USDC transfers: claim faucet ETH under 0.00002 ETH. */
const MIN_OPERATOR_WEI = 20_000_000_000_000n;
const ATOMIC_PER_CENT = 10_000n;
/** Faucet and transfer transactions take a few seconds to land: read the balance again after this. */
const BALANCE_RECHECK_MS = 15_000;

const canPay = () => Boolean(process.env.CDP_API_KEY_ID && process.env.CDP_API_KEY_SECRET && process.env.CDP_WALLET_SECRET);
const usd = (minor: number) => `$${(minor / 100).toFixed(2)}`;
const errText = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 150);
/** The operator's CDP account: the x402 receiver when X402_PAY_TO is empty, and the source of host top-ups. */
const operatorWalletName = () => process.env.X402_RECEIVER_WALLET_NAME || "billboardos-operator";

/**
 * Winners pay X402_PAY_TO when it is set; host top-ups send from the operator
 * account. If they differ, the money never comes back to the top-up wallet.
 */
function payToMismatch(operatorAddress: string): string | null {
  const payTo = process.env.X402_PAY_TO?.trim();
  if (!payTo || payTo.toLowerCase() === operatorAddress.toLowerCase()) return null;
  return `X402_PAY_TO (${payTo}) is not the operator wallet ${operatorAddress} (${operatorWalletName()}): winners pay one, top-ups drain the other. Leave X402_PAY_TO empty or set it to ${operatorAddress}.`;
}

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
        // One automatic claim per company per 24 h; top-ups (5 a day) are the way to ask for more.
        if (await ctx.runMutation(internal.companyAgents.claimFaucetSlot, { advertiserId: args.advertiserId })) {
          const { transactionHash } = await cdp.evm.requestFaucet({ address: account.address, network: NETWORK, token: "usdc" });
          note = `; faucet USDC requested, tx ${transactionHash}`;
          await ctx.scheduler.runAfter(BALANCE_RECHECK_MS, internal.companyAgentsNode.refreshBalance, { advertiserId: args.advertiserId });
        } else {
          note = "; faucet already claimed in the last 24 h (use top up)";
        }
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

const topUpResult = v.union(v.null(), v.object({ message: v.string(), warning: v.union(v.string(), v.null()) }));

/**
 * Top up the company wallet. "faucet" (the company's own request, R26): free
 * test USDC from the CDP faucet straight to the company wallet; the operator
 * wallet is never touched. "operator" (the host's top-up): a real USDC
 * transfer from the operator account when it holds enough (claiming faucet
 * ETH for gas first if needed), otherwise the faucet. Warns when X402_PAY_TO
 * isn't the operator account (payments wouldn't come back to it).
 */
export const topUp = internalAction({
  args: { advertiserId: v.id("advertisers"), amountMinor: v.number(), source: v.union(v.literal("faucet"), v.literal("operator")) },
  returns: topUpResult,
  handler: async (ctx, args): Promise<{ message: string; warning: string | null } | null> => {
    const me = await ctx.runQuery(internal.companyAgents.forAct, { advertiserId: args.advertiserId, now: Date.now() });
    if (!me) return null;
    const log = logger(ctx, args.advertiserId);
    if (!canPay()) {
      await log("top up: no CDP keys on this deployment");
      return { message: "no CDP keys on this deployment", warning: null };
    }
    try {
      const cdp = await cdpClient();
      const company = await cdp.evm.getOrCreateAccount({ name: me.walletName });
      if (args.source === "faucet") {
        const { transactionHash } = await cdp.evm.requestFaucet({ address: company.address, network: NETWORK, token: "usdc" });
        const message = `top up: free test USDC claimed from the faucet, tx ${transactionHash}`;
        await log(message);
        await saveBalance(ctx, args.advertiserId, cdp);
        await ctx.scheduler.runAfter(BALANCE_RECHECK_MS, internal.companyAgentsNode.refreshBalance, { advertiserId: args.advertiserId });
        return { message, warning: null };
      }
      const operator = await cdp.evm.getOrCreateAccount({ name: operatorWalletName() });
      const warning = payToMismatch(operator.address);
      const op = await balancesOf(cdp, operator.address);
      let message: string;
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
        message = `top up: ${usd(args.amountMinor)} USDC from the operator wallet, tx ${transactionHash}`;
      } else {
        const { transactionHash } = await cdp.evm.requestFaucet({ address: company.address, network: NETWORK, token: "usdc" });
        message = `top up: operator wallet short, faucet USDC requested, tx ${transactionHash}`;
      }
      await log(warning ? `${message}. WARNING: ${warning}` : message);
      if (warning) console.warn(`[top up] ${warning}`);
      await saveBalance(ctx, args.advertiserId, cdp);
      await ctx.scheduler.runAfter(BALANCE_RECHECK_MS, internal.companyAgentsNode.refreshBalance, { advertiserId: args.advertiserId });
      return { message, warning };
    } catch (error) {
      await log(`top up: failed: ${errText(error)}`);
      return { message: `failed: ${errText(error)}`, warning: null };
    }
  },
});

/**
 * The operator account's address and balance, and whether X402_PAY_TO
 * matches it (it must be empty or equal). For the runbook:
 *   npx convex run companyAgentsNode:operatorWallet --prod
 */
export const operatorWallet = internalAction({
  args: {},
  returns: v.object({
    walletName: v.string(),
    address: v.union(v.string(), v.null()),
    usdcMinor: v.union(v.number(), v.null()),
    payTo: v.union(v.string(), v.null()),
    warning: v.union(v.string(), v.null()),
  }),
  handler: async () => {
    const payTo = process.env.X402_PAY_TO?.trim() || null;
    if (!canPay()) return { walletName: operatorWalletName(), address: null, usdcMinor: null, payTo, warning: "no CDP keys on this deployment" };
    const cdp = await cdpClient();
    const operator = await cdp.evm.getOrCreateAccount({ name: operatorWalletName() });
    const { usdcMinor } = await balancesOf(cdp, operator.address);
    return { walletName: operatorWalletName(), address: operator.address, usdcMinor, payTo, warning: payToMismatch(operator.address) };
  },
});

/**
 * Pay for a won spot (flash_won, scheduled by companyAgentsAct.act): POST the
 * x402 purchase URL, answer the 402 from the company's CDP wallet. A 409
 * PURCHASE_IN_PROGRESS means another attempt for this hold is already paying:
 * logged, never reported as blocked.
 */
export const pay = internalAction({
  args: { advertiserId: v.id("advertisers"), payload: v.any() },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const payload = (args.payload ?? {}) as AgentPayload;
    if (!payload.holdId || !payload.purchaseUrl || !payload.amountMinor) return null;
    const me = await ctx.runQuery(internal.companyAgents.forAct, {
      advertiserId: args.advertiserId,
      now: Date.now(),
      offerId: typeof payload.offerId === "string" ? payload.offerId : undefined,
      holdId: payload.holdId,
    });
    if (!me) return null;
    const log = logger(ctx, args.advertiserId);
    if (!me.enabled) {
      await log("flash_won: agent is off");
      return null;
    }
    const holdId = payload.holdId as Id<"holds">;
    // Idempotent: a retried webhook (or a late one) for a hold that is paid, released or expired does nothing.
    if (me.holdActive !== true) {
      await log(`flash_won: hold ${payload.holdId} is no longer payable; nothing to do`);
      return null;
    }
    const blocked = async (reason: string) => {
      await ctx.runMutation(internal.moments.paymentBlocked, { holdId, reason });
      await ctx.runMutation(internal.liveAuction.paymentFailed, { holdId, reason });
      await ctx.runMutation(internal.rounds.paymentFailed, { holdId, reason });
      await log(`flash_won: payment blocked: ${reason}`);
    };
    const secret = process.env.INTERNAL_API_SECRET;
    if (!secret) {
      await blocked("INTERNAL_API_SECRET missing, so the agent key can't be read");
      return null;
    }
    let key: string;
    try {
      key = await decryptSecret(secret, me.keyCiphertext, me.keyIv);
    } catch (error) {
      await blocked(`the stored agent key can't be decrypted (${errText(error)})`);
      return null;
    }
    // The bearer key only ever goes to our own deployment.
    if (!payload.purchaseUrl.startsWith(`${agentSiteUrl()}/`)) {
      await blocked("the purchase URL is not on this deployment; the agent key was not sent");
      return null;
    }
    if (!canPay()) {
      await blocked("no CDP keys on this deployment, so the company wallet can't sign");
      return null;
    }
    const inProgress = async (res: Response) =>
      res.status === 409 && ((await res.clone().json().catch(() => ({}))) as { error?: unknown }).error === "PURCHASE_IN_PROGRESS";
    const init = { method: "POST", headers: { Authorization: `Bearer ${key}` } };
    try {
      const probe = await fetch(payload.purchaseUrl, init);
      if (await inProgress(probe)) {
        await log("flash_won: another payment for this hold is already settling; not paying twice");
        return null;
      }
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
      if (await inProgress(res)) {
        await log("flash_won: another payment for this hold is already settling; not paying twice");
        return null;
      }
      const header = res.headers.get("PAYMENT-RESPONSE") ?? res.headers.get("X-PAYMENT-RESPONSE");
      const settled = header ? decodePaymentResponseHeader(header) : null;
      if (res.status === 200 && settled?.success) {
        await log(`flash_won: paid ${usd(payload.amountMinor)}, tx ${settled.transaction}`);
        await saveBalance(ctx, args.advertiserId).catch(() => null);
        // The transfer may not show in the balance yet: read it again once it lands.
        await ctx.scheduler.runAfter(BALANCE_RECHECK_MS, internal.companyAgentsNode.refreshBalance, { advertiserId: args.advertiserId });
      } else {
        await blocked(`payment failed (HTTP ${res.status}${settled?.errorReason ? `, ${settled.errorReason}` : ""})`);
      }
    } catch (error) {
      await blocked(`payment failed: ${errText(error)} (empty wallet? top it up)`);
    }
    return null;
  },
});
