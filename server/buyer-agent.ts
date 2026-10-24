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
 *   --server <url>   x402 payment server (default: the Convex deployment, CONVEX_SITE_URL; or X402_SERVER_URL)
 */
import { randomUUID } from "node:crypto";
import { CdpClient } from "@coinbase/cdp-sdk";
import { CdpX402Client } from "@coinbase/cdp-sdk/x402";
import { wrapFetchWithPayment, decodePaymentResponseHeader } from "@x402/fetch";
import { decodePaymentRequiredHeader } from "@x402/core/http";
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
  agentApi,
  AgentApiError,
  paymentServerUrl,
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
const SERVER = paymentServerUrl(flag("server"));
const SLOT_MS = 15 * 60 * 1000;
const CANDIDATE_SETS = 4;

const step = (n: number | string, msg: string) => console.log(`\n[${n}] ${msg}`);
const info = (msg: string) => console.log(`    ${msg}`);
const fail = (msg: string, code = 1): never => {
  console.error(`\n✗ ${msg}`);
  process.exit(code);
};


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

// The agent acts for its customer company with a scoped agent key (ADR 0004).
const AGENT_KEY = requireEnv("BUYER_AGENT_KEY", "agent key from the customer dashboard or `npx convex run seed:demoAgentKeys`");
const agent = agentApi(requireEnv("CONVEX_SITE_URL", "Convex HTTP actions base URL (agent API)"), AGENT_KEY);

function apiErrorMessage(error: unknown): string {
  if (error instanceof AgentApiError) return `${error.code}: ${error.message.replace(/^[A-Z_]+: /, "")}`;
  return error instanceof Error ? error.message : String(error);
}

type Me = {
  company: { advertiserId: string; displayName: string };
  key: { name: string; prefix: string; scopes: string[]; budgetCapMinor: number; committedMinor: number; expiresAt: number };
  campaigns: { campaignId: string; brief: string; budgetMinor: number; status: string }[];
};
type Inventory = {
  screens: {
    billboardId: string;
    name: string;
    city: string;
    explanation: string;
    slots: { slotId: string; startAt: number; endAt: number; screenPriceMinor: number; auction: unknown }[];
  }[];
};
type Quote = { quoteId: string; amountMinor: number; confidence: string; traceId: string; pricingBasis: string[] };
type Hold = { holdId: string; amountMinor: number; expiresAt: number; traceId: string; replayed: boolean };

// ---------------------------------------------------------------- 1. campaign

step(1, "Checking the agent key and choosing a campaign");
let me: Me;
try {
  me = await agent.get<Me>("me");
} catch (error) {
  fail(`Agent key rejected: ${apiErrorMessage(error)}\n  Issue demo keys with: npx convex run seed:demoAgentKeys`);
}
me = me!;
info(
  `${me.company.displayName} · key "${me.key.name}" (${me.key.prefix}) · scopes ${me.key.scopes.join(", ")} · committed ${centsToUsd(Math.max(1, me.key.committedMinor))} of ${centsToUsd(me.key.budgetCapMinor)} cap`,
);
const campaignArg = flag("campaign") ?? positional[0];
const open = me.campaigns.filter((c) => c.status === "active" || c.status === "draft");
let campaign = campaignArg
  ? (open.find((c) => c.campaignId === campaignArg) ??
    open.find((c) => c.brief.toLowerCase().includes(campaignArg.toLowerCase())))
  : open[0];
if (!campaign) {
  fail(
    campaignArg
      ? `No open campaign matches "${campaignArg}". Open campaigns:\n${open.map((c) => `      ${c.campaignId}  ${c.brief.slice(0, 60)}`).join("\n")}`
      : "This key has no open campaigns. Seed demo data with `npm run seed`.",
  );
}
campaign = campaign!;
info(`"${campaign.brief.slice(0, 80)}" (${campaign.campaignId})`);
const remainingCap = me.key.budgetCapMinor - me.key.committedMinor;
if (remainingCap < budgetMinor) {
  info(`key cap leaves ${centsToUsd(Math.max(1, remainingCap))}; using that as the budget`);
  budgetMinor = Math.max(1, remainingCap);
}
info(`budget cap for this purchase: ${centsToUsd(budgetMinor)} USDC`);

// ---------------------------------------------------------------- 2. inventory

step(2, `Finding ${slotCount} upcoming available slot(s) (GET /api/agent/inventory)`);
const query = new URLSearchParams({ campaignId: campaign.campaignId, hours: "24" });
if (flag("billboard")) query.set("billboardId", flag("billboard")!);
const inventory = await agent.get<Inventory>(`inventory?${query}`);
if (inventory.screens.length === 0) fail("No screens on the marketplace.");

type Candidate = { billboard: Inventory["screens"][number]; slotIds: string[]; startAt: number; screenMinor: number };
const candidates: Candidate[] = [];
for (const billboard of inventory.screens) {
  // Auctioned slots can't be bought at a posted price.
  const available = billboard.slots.filter((s) => !s.auction);
  const runs: Candidate[] = [];
  for (let i = 0; i + slotCount <= available.length; i++) {
    const run = available.slice(i, i + slotCount);
    const contiguous = run.every((s, j) => j === 0 || s.startAt - run[j - 1].startAt === SLOT_MS);
    if (contiguous) {
      runs.push({
        billboard,
        slotIds: run.map((s) => s.slotId),
        startAt: run[0].startAt,
        screenMinor: run.reduce((sum, s) => sum + s.screenPriceMinor, 0),
      });
    }
  }
  // Cheapest screen-price runs first, then a few spread across the day.
  runs.sort((a, b) => a.screenMinor - b.screenMinor);
  candidates.push(...runs.slice(0, CANDIDATE_SETS));
  info(`${billboard.name}: ${available.length} available slot(s) · ${billboard.explanation}`);
}
if (candidates.length === 0) fail(`No run of ${slotCount} consecutive available slot(s) found.`);

// ---------------------------------------------------------------- 3. quotes

step(3, `Requesting ${candidates.length} quote(s) and picking the cheapest (POST /api/agent/quotes)`);
let best: { quote: Quote; candidate: Candidate } | null = null;
for (const candidate of candidates) {
  try {
    const quote = await agent.post<Quote>("quotes", { campaignId: campaign.campaignId, slotIds: candidate.slotIds });
    info(
      `${new Date(candidate.startAt).toISOString()}  ${candidate.billboard.name}  ${centsToUsd(quote.amountMinor)}  (${quote.confidence})`,
    );
    if (!best || quote.amountMinor < best.quote.amountMinor) best = { quote, candidate };
  } catch (error) {
    info(`${new Date(candidate.startAt).toISOString()}  quote failed: ${apiErrorMessage(error)}`);
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

step(4, "Placing exclusive hold (POST /api/agent/holds)");
const idempotencyKey = `agent:${WALLET_NAME}:${randomUUID()}`;
let hold: Hold;
try {
  hold = await agent.post<Hold>("holds", { quoteId: quote.quoteId, idempotencyKey });
} catch (error) {
  fail(`Hold failed: ${apiErrorMessage(error)}`);
}
hold = hold!;
info(`hold ${hold.holdId} · ${centsToUsd(hold.amountMinor)} · expires ${new Date(hold.expiresAt).toISOString()}`);
info(`idempotencyKey ${idempotencyKey}`);

const purchaseUrl = `${SERVER}/purchases/${hold.holdId}`;
if (flags.has("hold-only") || !env("CDP_WALLET_SECRET")) {
  if (!env("CDP_WALLET_SECRET")) {
    info("CDP_WALLET_SECRET is not set, so the agent cannot sign a payment. Stopping after the hold.");
  }
  info(`See the x402 challenge: curl -i -X POST -H "Authorization: Bearer $BUYER_AGENT_KEY" ${purchaseUrl}`);
  process.exit(0);
}

// ---------------------------------------------------------------- 5. challenge

step(5, `Requesting ${purchaseUrl} (expect HTTP 402)`);
// The x402 server checks that this agent key has the "pay" scope for the hold's company.
const purchaseInit = { method: "POST", headers: { Authorization: `Bearer ${AGENT_KEY}` } };
const probe = await fetch(purchaseUrl, purchaseInit);
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
  response = await fetchWithPayment(purchaseUrl, purchaseInit);
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
