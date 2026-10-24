/**
 * Advertiser buying agent (CLI).
 *
 * Shops for the cheapest upcoming slot(s) on a BillboardOS billboard, refuses
 * anything over its budget, takes an exclusive hold, then pays the hold over
 * x402 from its own CDP-managed wallet (Base Sepolia test USDC).
 *
 *   npm run buyer -- [campaign] [maxBudgetUsdc] [slots] [options]
 *
 *   campaign         campaign id, or text matched against brief / advertiser
 *                    (default: newest active campaign)
 *   maxBudgetUsdc    hard cap for this purchase (default BUYER_MAX_BUDGET_USDC)
 *   slots            consecutive 15-min slots to buy (default 1)
 *
 *   --billboard <id> restrict to one billboard
 *   --hold-only      stop after placing the hold (prints a curl for the 402 challenge)
 *   --faucet         request Base Sepolia test USDC for the buyer wallet, then exit
 *   --server <url>   x402 server (default http://localhost:$X402_SERVER_PORT)
 */
import { randomUUID } from "node:crypto";
import { ConvexHttpClient } from "convex/browser";
import { ConvexError } from "convex/values";
import { CdpClient } from "@coinbase/cdp-sdk";
import { CdpX402Client } from "@coinbase/cdp-sdk/x402";
import { wrapFetchWithPayment, decodePaymentResponseHeader } from "@x402/fetch";
import { decodePaymentRequiredHeader } from "@x402/core/http";
import { api } from "../convex/_generated/api.js";
import type { Doc, Id } from "../convex/_generated/dataModel.js";
import {
  atomicToCents,
  cdpNetworkName,
  centsToAtomic,
  centsToUsd,
  decimalToCents,
  env,
  explorerTxUrl,
  presence,
  requireEnv,
} from "./lib.ts";

// ---------------------------------------------------------------- args

const argv = process.argv.slice(2);
const flags = new Map<string, string | true>();
const positional: string[] = [];
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i];
  if (arg.startsWith("--")) {
    const name = arg.slice(2);
    const next = argv[i + 1];
    if (["billboard", "server", "campaign", "budget", "slots"].includes(name) && next !== undefined) {
      flags.set(name, next);
      i++;
    } else {
      flags.set(name, true);
    }
  } else {
    positional.push(arg);
  }
}
const flag = (name: string) => {
  const v = flags.get(name);
  return typeof v === "string" ? v : undefined;
};

const NETWORK = env("X402_NETWORK") ?? "eip155:84532";
const ENVIRONMENT = env("X402_ENVIRONMENT") === "production" ? "production" : "development";
const WALLET_NAME = env("BUYER_WALLET_NAME") ?? "advertiser-agent-1";
const SERVER = (flag("server") ?? `http://localhost:${env("X402_SERVER_PORT") ?? 4021}`).replace(/\/$/, "");
const SLOT_MS = 15 * 60 * 1000;
const CANDIDATE_SETS = 4;

const step = (n: number | string, msg: string) => console.log(`\n[${n}] ${msg}`);
const info = (msg: string) => console.log(`    ${msg}`);
const fail = (msg: string, code = 1): never => {
  console.error(`\n✗ ${msg}`);
  process.exit(code);
};

function convexErrorMessage(error: unknown): string {
  if (error instanceof ConvexError) {
    const data = error.data as { code?: string; message?: string } | string;
    return typeof data === "string" ? data : `${data.code ?? "ERROR"}: ${data.message ?? ""}`;
  }
  return error instanceof Error ? error.message : String(error);
}

function makeCdpClient(): CdpX402Client {
  return new CdpX402Client({
    environment: ENVIRONMENT,
    walletConfig: { type: "eoa", accountName: WALLET_NAME },
    spendControls: {
      // Defense in depth: the SDK refuses to sign anything above the agent's budget
      // or on another network, even if the server asked for more.
      maxAmountPerPayment: { atomic: centsToAtomic(budgetMinor) },
      allowedNetworks: [NETWORK as `${string}:${string}`],
    },
  });
}

async function usdcBalance(address: `0x${string}`): Promise<string> {
  try {
    const cdp = new CdpClient();
    const { balances } = await cdp.evm.listTokenBalances({
      address,
      network: cdpNetworkName(NETWORK),
    });
    const usdc = balances.find((b) => b.token.symbol?.toUpperCase() === "USDC");
    if (!usdc) return "0 USDC";
    const raw = usdc.amount.amount.toString().padStart(usdc.amount.decimals + 1, "0");
    const whole = raw.slice(0, raw.length - usdc.amount.decimals);
    const frac = raw.slice(raw.length - usdc.amount.decimals).replace(/0+$/, "");
    return `${whole}${frac ? `.${frac}` : ""} USDC`;
  } catch (error) {
    return `unknown (${error instanceof Error ? error.message : String(error)})`;
  }
}

// ---------------------------------------------------------------- setup

console.log("BillboardOS advertiser buying agent  (TEST FUNDS ONLY: Base Sepolia USDC)");
info(`wallet "${WALLET_NAME}" · network ${NETWORK} · server ${SERVER}`);
info(
  `CDP_API_KEY_ID ${presence("CDP_API_KEY_ID")} · CDP_API_KEY_SECRET ${presence("CDP_API_KEY_SECRET")} · CDP_WALLET_SECRET ${presence("CDP_WALLET_SECRET")}`,
);

const budgetArg = flag("budget") ?? positional[1] ?? env("BUYER_MAX_BUDGET_USDC") ?? "50";
let budgetMinor: number;
try {
  budgetMinor = decimalToCents(budgetArg);
} catch (error) {
  fail(`Invalid budget: ${error instanceof Error ? error.message : String(error)}`);
}
budgetMinor = budgetMinor!;

// ---------------------------------------------------------------- --faucet

if (flags.has("faucet")) {
  requireEnv("CDP_WALLET_SECRET", "required to create/use the buyer's CDP wallet");
  step("faucet", `Requesting Base Sepolia test USDC for wallet "${WALLET_NAME}"`);
  const client = makeCdpClient();
  const { evmAddress } = await client.getAddresses();
  info(`buyer address ${evmAddress}`);
  info(`balance before ${await usdcBalance(evmAddress)}`);
  const cdp = new CdpClient();
  const { transactionHash } = await cdp.evm.requestFaucet({
    address: evmAddress,
    network: "base-sepolia",
    token: "usdc",
  });
  info(`faucet tx ${transactionHash}`);
  info(`explorer  ${explorerTxUrl("eip155:84532", transactionHash) ?? "-"}`);
  info("Wait ~10s for confirmation, then run the buyer again.");
  process.exit(0);
}

const slotCount = Number(flag("slots") ?? positional[2] ?? 1);
if (!Number.isInteger(slotCount) || slotCount < 1 || slotCount > 16) {
  fail("slots must be an integer 1..16");
}

const convex = new ConvexHttpClient(requireEnv("CONVEX_URL", "public Convex API URL"));

// ---------------------------------------------------------------- 1. campaign

step(1, "Choosing campaign");
const campaignArg = flag("campaign") ?? positional[0];
const campaigns = await convex.query(api.campaigns.list, {});
const open = campaigns.filter((c) => c.status === "active" || c.status === "draft");
let campaign = campaignArg
  ? (campaigns.find((c) => c._id === campaignArg) ??
    open.find((c) =>
      `${c.brief} ${c.advertiserName}`.toLowerCase().includes(campaignArg.toLowerCase()),
    ))
  : (open.find((c) => c.status === "active") ?? open[0]);
if (!campaign) {
  fail(
    campaignArg
      ? `No open campaign matches "${campaignArg}". Open campaigns:\n${open.map((c) => `      ${c._id}  ${c.advertiserName}: ${c.brief.slice(0, 60)}`).join("\n")}`
      : "No open campaigns. Seed demo data with `npm run seed`.",
  );
}
campaign = campaign!;
info(`${campaign.advertiserName}: "${campaign.brief.slice(0, 80)}" (${campaign._id})`);
info(`budget cap for this purchase: ${centsToUsd(budgetMinor)} USDC`);

// ---------------------------------------------------------------- 2. inventory

step(2, `Finding ${slotCount} upcoming available slot(s)`);
const billboards = (await convex.query(api.billboards.list, {})).filter(
  (b) => b.deviceStatus === "online" && (!flag("billboard") || b._id === flag("billboard")),
);
if (billboards.length === 0) fail("No online billboards.");

const now = Date.now();
type Candidate = { billboard: Doc<"billboards">; slotIds: Id<"slots">[]; startAt: number };
const candidates: Candidate[] = [];
for (const billboard of billboards) {
  const slots = await convex.query(api.slots.listForBillboard, {
    billboardId: billboard._id,
    from: now + 60_000,
    to: now + 24 * 60 * 60 * 1000,
  });
  const available = slots.filter((s) => s.state === "available");
  // Runs of `slotCount` back-to-back available slots; sample a few spread across the day.
  const runs: Candidate[] = [];
  for (let i = 0; i + slotCount <= available.length; i++) {
    const run = available.slice(i, i + slotCount);
    const contiguous = run.every((s, j) => j === 0 || s.startAt - run[j - 1].startAt === SLOT_MS);
    if (contiguous) runs.push({ billboard, slotIds: run.map((s) => s._id), startAt: run[0].startAt });
  }
  const stride = Math.max(1, Math.floor(runs.length / CANDIDATE_SETS));
  for (let i = 0, n = 0; i < runs.length && n < CANDIDATE_SETS; i += stride, n++) {
    candidates.push(runs[i]);
  }
  info(`${billboard.name}: ${available.length} available slot(s) in the next 24h`);
}
if (candidates.length === 0) fail(`No run of ${slotCount} consecutive available slot(s) found.`);

// ---------------------------------------------------------------- 3. quotes

step(3, `Requesting ${candidates.length} quote(s) and picking the cheapest`);
type Quote = Awaited<ReturnType<typeof convex.mutation<typeof api.quotes.create>>>;
let best: { quote: Quote; candidate: Candidate } | null = null;
for (const candidate of candidates) {
  try {
    const quote = await convex.mutation(api.quotes.create, {
      campaignId: campaign._id,
      slotIds: candidate.slotIds,
      actor: `agent:${WALLET_NAME}`,
    });
    info(
      `${new Date(candidate.startAt).toISOString()}  ${candidate.billboard.name}  ${centsToUsd(quote.amountMinor)}  (${quote.confidence})`,
    );
    if (!best || quote.amountMinor < best.quote.amountMinor) best = { quote, candidate };
  } catch (error) {
    info(`${new Date(candidate.startAt).toISOString()}  quote failed: ${convexErrorMessage(error)}`);
  }
}
if (!best) fail("Could not obtain any quote.");
const { quote, candidate } = best!;
info(`cheapest: ${centsToUsd(quote.amountMinor)} for ${slotCount} slot(s) starting ${new Date(candidate.startAt).toISOString()} on ${candidate.billboard.name}`);
info(`quote ${quote.quoteId} · trace ${quote.traceId}`);
for (const line of quote.pricingBasis.slice(0, 4)) info(`  basis: ${line}`);

if (quote.amountMinor > budgetMinor) {
  fail(
    `REFUSED: cheapest quote ${centsToUsd(quote.amountMinor)} exceeds budget ${centsToUsd(budgetMinor)}. Nothing held, nothing paid.`,
    2,
  );
}
info(`within budget (${centsToUsd(quote.amountMinor)} <= ${centsToUsd(budgetMinor)})`);

// ---------------------------------------------------------------- 4. hold

step(4, "Placing exclusive hold");
const idempotencyKey = `agent:${WALLET_NAME}:${randomUUID()}`;
let hold;
try {
  hold = await convex.mutation(api.holds.create, {
    quoteId: quote.quoteId,
    idempotencyKey,
    actor: `agent:${WALLET_NAME}`,
  });
} catch (error) {
  fail(`Hold failed: ${convexErrorMessage(error)}`);
}
hold = hold!;
info(`hold ${hold.holdId} · ${centsToUsd(hold.amountMinor)} · expires ${new Date(hold.expiresAt).toISOString()}`);
info(`idempotencyKey ${idempotencyKey}`);

const purchaseUrl = `${SERVER}/purchases/${hold.holdId}`;
if (flags.has("hold-only") || !env("CDP_WALLET_SECRET")) {
  if (!env("CDP_WALLET_SECRET")) {
    info("CDP_WALLET_SECRET is not set, so the agent cannot sign a payment. Stopping after the hold.");
  }
  info(`See the x402 challenge: curl -i -X POST ${purchaseUrl}`);
  process.exit(0);
}

// ---------------------------------------------------------------- 5. challenge

step(5, `Requesting ${purchaseUrl} (expect HTTP 402)`);
const probe = await fetch(purchaseUrl, { method: "POST" });
if (probe.status !== 402) fail(`Expected 402, got ${probe.status}: ${await probe.text()}`);
const requiredHeader = probe.headers.get("PAYMENT-REQUIRED");
if (!requiredHeader) fail("402 without a PAYMENT-REQUIRED header");
const required = decodePaymentRequiredHeader(requiredHeader!);
const offer = required.accepts.find((a) => a.network === NETWORK);
if (!offer) fail(`Server offers no payment option on ${NETWORK}`);
const offeredMinor = atomicToCents(offer!.amount);
info(`402 Payment Required: ${offer!.amount} atomic USDC (${centsToUsd(offeredMinor)}) to ${offer!.payTo} on ${offer!.network}`);
if (offeredMinor !== hold.amountMinor) {
  fail(`REFUSED: server asks ${centsToUsd(offeredMinor)} but the hold is ${centsToUsd(hold.amountMinor)}.`, 2);
}
if (offeredMinor > budgetMinor) fail(`REFUSED: ${centsToUsd(offeredMinor)} exceeds budget.`, 2);

// ---------------------------------------------------------------- 6. pay

step(6, `Paying from CDP wallet "${WALLET_NAME}" via x402`);
const client = makeCdpClient();
const { evmAddress } = await client.getAddresses();
info(`payer ${evmAddress} · balance ${await usdcBalance(evmAddress)}`);
const fetchWithPayment = wrapFetchWithPayment(globalThis.fetch, client);
let response: Response;
try {
  response = await fetchWithPayment(purchaseUrl, { method: "POST" });
} catch (error) {
  fail(
    `Payment failed: ${error instanceof Error ? error.message : String(error)}\n` +
      `  If the wallet is empty, run: npm run buyer -- --faucet`,
  );
}
response = response!;
const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
const settleHeader = response.headers.get("PAYMENT-RESPONSE") ?? response.headers.get("X-PAYMENT-RESPONSE");
if (settleHeader) {
  const settled = decodePaymentResponseHeader(settleHeader);
  info(`settled tx ${settled.transaction} on ${settled.network} (payer ${settled.payer ?? "?"})`);
  const url = explorerTxUrl(settled.network, settled.transaction);
  if (url) info(`explorer   ${url}`);
}

step(7, `Result: HTTP ${response.status}`);
console.log(JSON.stringify(body, null, 2).replace(/^/gm, "    "));
if (response.status === 200 && body.outcome === "booked") {
  console.log(`\n✓ Booked ${slotCount} slot(s) for ${centsToUsd(hold.amountMinor)} (trace ${hold.traceId}).`);
  process.exit(0);
}
if (body.outcome === "exception") {
  fail("Payment settled but was NOT booked; a finance exception is open for the operator.", 3);
}
fail(`Purchase did not complete (HTTP ${response.status}).`);
