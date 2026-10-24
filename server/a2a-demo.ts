/**
 * Agent-to-agent demo (ADR 0005): Nvidia's buying agent negotiates with a
 * host's seller agent and pays it over x402.
 *
 *   npm run a2a:demo                     # newest unacknowledged non-auction alert
 *   npm run a2a:demo -- --slot <slotId>  # skip the alert, negotiate for this slot
 *   options: --slots <n> (1..4, default 2)  --server <x402 url>  --no-ack
 *
 * Steps:
 *   1. alert       GET  /api/agent/alerts (Convex agent API)
 *   2. agent card  GET  {server}/a2a/hosts/{workspaceId}/agent.json
 *   3. report      GET  {server}/a2a/hosts/{workspaceId}/reports/audience  -> 402, pay $0.05 (x402)
 *   4. valuation   deterministic, from the report (or alert prices if unpaid)
 *   5. negotiate   POST {server}/a2a/hosts/{workspaceId}/negotiations (+ /messages)
 *   6. purchase    POST {server}/a2a/hosts/{workspaceId}/purchases/{holdId} -> 402, pay the hold (x402)
 *   7. ack alert   POST /api/agent/alerts/{id}/ack
 *
 * Env: AUCTION_NVIDIA_AGENT_KEY (agent key: quote, hold, pay), CONVEX_SITE_URL,
 * wallet AUCTION_NVIDIA_WALLET or BUYER_WALLET_NAME (CDP account name) and
 * CDP_API_KEY_ID / CDP_API_KEY_SECRET / CDP_WALLET_SECRET to sign payments.
 * Without CDP_WALLET_SECRET the agent stops at each 402 and prints the
 * challenge. It never says "paid" unless settlement succeeded.
 */
import { CdpX402Client } from "@coinbase/cdp-sdk/x402";
import { wrapFetchWithPayment, decodePaymentResponseHeader } from "@x402/fetch";
import { decodePaymentRequiredHeader } from "@x402/core/http";
import { atomicToCents, centsToAtomic, centsToUsd, env, explorerTxUrl, presence, requireEnv, agentApi, AgentApiError } from "./lib.ts";

// ---------------------------------------------------------------- args & env

const argv = process.argv.slice(2);
const opt = (name: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : undefined;
};
const NETWORK = env("X402_NETWORK") ?? "eip155:84532";
const ENVIRONMENT = env("X402_ENVIRONMENT") === "production" ? "production" : "development";
const SERVER = (opt("server") ?? env("X402_PUBLIC_URL") ?? `http://localhost:${env("X402_SERVER_PORT") ?? 4021}`).replace(/\/$/, "");
const WALLET_NAME = env("AUCTION_NVIDIA_WALLET") ?? env("BUYER_WALLET_NAME") ?? "nvidia-buyer-agent";
const KEY = requireEnv("AUCTION_NVIDIA_AGENT_KEY", "Nvidia's agent key: npx convex run seed:demoAgentKeys");
const api = agentApi(requireEnv("CONVEX_SITE_URL", "Convex HTTP actions base URL (agent API)"), KEY);
const CAN_PAY = Boolean(env("CDP_WALLET_SECRET") && env("CDP_API_KEY_ID") && env("CDP_API_KEY_SECRET"));
const SLOT_COUNT = Math.max(1, Math.min(4, Number(opt("slots") ?? 2) || 2));

// ---------------------------------------------------------------- transcript

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const step = (n: number, title: string) => console.log(`\n${bold(`[${n}] ${title}`)}`);
const line = (who: string, msg: string) => console.log(`    ${who.padEnd(8)} ${msg}`);
const note = (msg: string) => console.log(`    ${dim(msg)}`);
const stop = (msg: string, code = 1): never => {
  console.log(`\n✗ ${msg}`);
  process.exit(code);
};
const usd = (minor: number) => `$${(minor / 100).toFixed(2)}`;
const time = (ts: number) => new Date(ts).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });

function apiMessage(error: unknown) {
  if (error instanceof AgentApiError) return `${error.code}: ${error.message.replace(/^[A-Z_]+: /, "")}`;
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------- x402 helpers

type Paid = { ok: true; status: number; body: Record<string, unknown>; tx: string; network: string } | { ok: false; reason: string };

let payingFetch: typeof fetch | null = null;
async function payer(maxMinor: number): Promise<typeof fetch> {
  if (payingFetch) return payingFetch;
  const client = new CdpX402Client({
    environment: ENVIRONMENT,
    walletConfig: { type: "eoa", accountName: WALLET_NAME },
    // Defense in depth: the SDK refuses to sign above this agent's budget or on another network.
    spendControls: { maxAmountPerPayment: { atomic: centsToAtomic(maxMinor) }, allowedNetworks: [NETWORK as `${string}:${string}`] },
  });
  const { evmAddress } = await client.getAddresses();
  note(`wallet "${WALLET_NAME}" ${evmAddress}`);
  payingFetch = wrapFetchWithPayment(globalThis.fetch, client) as typeof fetch;
  return payingFetch;
}

/** Probe for the 402, check the amount, then pay if we can. Prints the challenge either way. */
async function payX402(url: string, init: RequestInit, expectedMinor: number, maxMinor: number, label: string): Promise<Paid> {
  const probe = await fetch(url, init);
  if (probe.status !== 402) {
    return { ok: false, reason: `expected 402, got HTTP ${probe.status}: ${(await probe.text()).slice(0, 300)}` };
  }
  const header = probe.headers.get("PAYMENT-REQUIRED");
  if (!header) return { ok: false, reason: "402 without a PAYMENT-REQUIRED header" };
  const required = decodePaymentRequiredHeader(header);
  const offer = required.accepts.find((a) => a.network === NETWORK);
  if (!offer) return { ok: false, reason: `no payment option on ${NETWORK}` };
  const askedMinor = atomicToCents(offer.amount);
  line("seller", `402 Payment Required: ${centsToUsd(askedMinor)} USDC (${offer.amount} atomic) to ${offer.payTo} on ${offer.network}`);
  if (askedMinor !== expectedMinor) return { ok: false, reason: `REFUSED: asked ${usd(askedMinor)} but ${label} is ${usd(expectedMinor)}` };
  if (askedMinor > maxMinor) return { ok: false, reason: `REFUSED: ${usd(askedMinor)} is over the agent's limit ${usd(maxMinor)}` };
  if (!CAN_PAY) {
    return { ok: false, reason: `no wallet configured (CDP_WALLET_SECRET ${presence("CDP_WALLET_SECRET")}); stopping at the 402 for ${label}. Nothing was paid.` };
  }
  let response: Response;
  try {
    response = await (await payer(maxMinor))(url, init);
  } catch (error) {
    return { ok: false, reason: `payment failed: ${error instanceof Error ? error.message : String(error)} (empty wallet? npm run buyer -- --faucet with BUYER_WALLET_NAME=${WALLET_NAME})` };
  }
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  const settleHeader = response.headers.get("PAYMENT-RESPONSE") ?? response.headers.get("X-PAYMENT-RESPONSE");
  if (!settleHeader) return { ok: false, reason: `no settlement (HTTP ${response.status}): ${JSON.stringify(body).slice(0, 300)}` };
  const settled = decodePaymentResponseHeader(settleHeader);
  if (!settled.success || !settled.transaction) return { ok: false, reason: `settlement failed: ${settled.errorReason ?? "unknown"}` };
  return { ok: true, status: response.status, body, tx: settled.transaction, network: settled.network };
}

// ---------------------------------------------------------------- types

type Me = {
  company: { advertiserId: string; displayName: string };
  key: { name: string; prefix: string; scopes: string[]; budgetCapMinor: number; committedMinor: number };
  campaigns: { campaignId: string; brief: string; status: string; targetAudience: Record<string, number> | null }[];
};
type AlertSlot = { slotId: string; startAt: number; endAt: number; screenPriceMinor: number };
type Alert = {
  alertId: string;
  trigger: string;
  campaignId: string;
  workspaceId?: string;
  billboard: { billboardId: string; name: string; city: string };
  slots: AlertSlot[];
  reason: string;
  createdAt: number;
};
type Card = {
  name: string;
  host: { workspaceId: string; name: string };
  payment: { network: string; payTo: string };
  negotiation: { maxRounds: number; offerValiditySeconds: number };
  services: { id: string; price: string }[];
  screens: { billboardId: string; name: string; audienceTags: Record<string, number> | null }[];
};
type Report = {
  billboard: { name: string; audienceTags: Record<string, number> | null; normalTrafficPer15Min: number };
  crowd: { averagePer15Min: number | null; peakInView: number | null; vsNormal: number | null; buckets: unknown[] };
  upcomingEvents: { name: string; startsAt: number; endsAt: number; upliftMultiplier: number }[];
  recentClearingPrices: { unitPriceMinor: number }[];
};
type Negotiation = {
  negotiationId: string;
  status: "open" | "agreed" | "rejected" | "expired" | "failed";
  sellerMinor: number;
  rounds: number;
  maxRounds: number;
  agreedMinor: number | null;
  holdId: string | null;
  holdExpiresAt: number | null;
  closedReason: string | null;
  messages: { from: string; kind: string; amountMinor: number | null; reasoning: string }[];
};

// ---------------------------------------------------------------- 1. alert

console.log(bold("BillboardOS agent-to-agent demo") + dim("  (TEST FUNDS ONLY: Base Sepolia USDC)"));
note(`x402 server ${SERVER} · wallet "${WALLET_NAME}" · payments ${CAN_PAY ? "enabled" : "disabled (no CDP_WALLET_SECRET): stops at each 402"}`);

step(1, "Buyer agent wakes up on a watch-rule alert");
let me: Me;
try {
  me = await api.get<Me>("me");
} catch (error) {
  stop(`Agent key rejected: ${apiMessage(error)}. Issue demo keys: npx convex run seed:demoAgentKeys`);
}
me = me!;
const budgetLeft = me.key.budgetCapMinor - me.key.committedMinor;
note(`${me.company.displayName} · key ${me.key.prefix} (${me.key.scopes.join(", ")}) · budget left ${usd(budgetLeft)} of ${usd(me.key.budgetCapMinor)}`);

let alert: Alert | null = null;
let workspaceId: string;
let billboardId: string;
let billboardName: string;
let campaignId: string;
let chosen: AlertSlot[];
const slotArg = opt("slot");
if (slotArg) {
  const inv = await api.get<{ screens: { billboardId: string; workspaceId: string | null; name: string; slots: (AlertSlot & { auction: unknown })[] }[] }>("inventory?hours=24");
  const screen = inv.screens.find((s) => s.slots.some((x) => x.slotId === slotArg));
  const slot = screen?.slots.find((x) => x.slotId === slotArg);
  if (!screen || !slot || !screen.workspaceId) stop(`Slot ${slotArg} is not in the next 24h of available inventory.`);
  if (slot!.auction) stop("That slot is in a live auction; use npm run auction:demo instead.");
  workspaceId = screen!.workspaceId!;
  billboardId = screen!.billboardId;
  billboardName = screen!.name;
  const open = me.campaigns.find((c) => c.status === "active" || c.status === "draft");
  if (!open) stop("No open campaign for this company.");
  campaignId = open!.campaignId;
  chosen = [slot!];
  line("buyer", `negotiating for slot ${slotArg} (--slot) on ${billboardName}`);
} else {
  const { alerts } = await api.get<{ alerts: Alert[] }>("alerts");
  const usable = alerts.filter((a) => a.trigger !== "auction_open" && a.workspaceId && a.slots.some((s) => s.startAt > Date.now() + 10 * 60_000));
  alert = usable.at(-1) ?? null;
  if (!alert) {
    stop(
      `No unacknowledged non-auction alerts for ${me.company.displayName} (${alerts.length} total).\n` +
        "  Create one: npx convex run seed:demoWatchRules (Nvidia watches software-heavy SF screens), wait for the 5-min sweep,\n" +
        "  or pass --slot <slotId> from GET /api/agent/inventory.",
    );
  }
  alert = alert!;
  workspaceId = alert.workspaceId!;
  billboardId = alert.billboard.billboardId;
  billboardName = alert.billboard.name;
  campaignId = alert.campaignId;
  chosen = alert.slots.filter((s) => s.startAt > Date.now() + 10 * 60_000).slice(0, SLOT_COUNT);
  line("platform", `alert ${alert.alertId} (${alert.trigger}): ${alert.reason}`);
}
const campaign = me.campaigns.find((c) => c.campaignId === campaignId);
line("buyer", `wants ${chosen.length} slot(s) on ${billboardName}: ${chosen.map((s) => `${time(s.startAt)} ${usd(s.screenPriceMinor)}`).join(", ")}`);

// ---------------------------------------------------------------- 2. agent card

step(2, "Reads the seller agent's card");
const cardRes = await fetch(`${SERVER}/a2a/hosts/${workspaceId}/agent.json`).catch((e: unknown) => stop(`x402 server unreachable at ${SERVER}: ${String(e)}. Start it: npm run server`));
if (!cardRes.ok) stop(`agent card: HTTP ${cardRes.status} ${await cardRes.text()}`);
const card = (await cardRes.json()) as Card;
line("seller", `${card.name} · pays to ${card.payment.payTo} on ${card.payment.network}`);
note(`services: ${card.services.map((s) => `${s.id} (${s.price})`).join(", ")}`);
note(`negotiation: up to ${card.negotiation.maxRounds} offers, each position valid ${card.negotiation.offerValiditySeconds}s`);

// ---------------------------------------------------------------- 3. audience report (x402)

step(3, "Buys the audience report (x402)");
const reportUrl = `${SERVER}/a2a/hosts/${workspaceId}/reports/audience?billboardId=${billboardId}`;
const reportPrice = card.services.find((s) => s.id === "audience-report")?.price ?? "$0.05";
const reportMinor = Math.round(Number(reportPrice.replace("$", "")) * 100);
const authInit = { headers: { Authorization: `Bearer ${KEY}` } };
const reportPaid = await payX402(reportUrl, { method: "GET", ...authInit }, reportMinor, Math.min(100, budgetLeft), "the report");
let report: Report | null = null;
if (reportPaid.ok) {
  report = (reportPaid.body.report ?? null) as Report | null;
  line("buyer", `paid ${usd(reportMinor)} for the report · tx ${reportPaid.tx}`);
  const url = explorerTxUrl(reportPaid.network, reportPaid.tx);
  if (url) note(url);
} else {
  line("buyer", reportPaid.reason);
}

// ---------------------------------------------------------------- 4. valuation

step(4, "Values the slots");
function match(screen: Record<string, number> | null | undefined, target: Record<string, number> | null | undefined): number | null {
  if (!screen || !target) return null;
  const norm = (t: Record<string, number>) => {
    const sum = Object.values(t).reduce((a, b) => a + Math.max(0, b), 0);
    return sum > 0 ? Object.fromEntries(Object.entries(t).map(([k, v]) => [k, Math.max(0, v) / sum])) : {};
  };
  const s = norm(screen);
  const t = norm(target);
  const top = Math.max(0, ...Object.values(t));
  if (top === 0 || Object.keys(s).length === 0) return null;
  return Math.min(1, Object.entries(s).reduce((acc, [k, share]) => acc + share * ((t[k] ?? 0) / top), 0));
}
const screenTotal = chosen.reduce((sum, s) => sum + s.screenPriceMinor, 0);
let factor = 1;
const reasons: string[] = [`screen prices total ${usd(screenTotal)}`];
if (report) {
  const crowd = report.crowd.vsNormal === null ? 1 : Math.max(0.8, Math.min(1.3, report.crowd.vsNormal));
  factor *= crowd;
  reasons.push(report.crowd.vsNormal === null ? "no recent crowd readings" : `crowd ${report.crowd.vsNormal.toFixed(2)}x normal`);
  const event = report.upcomingEvents.find((e) => chosen.some((s) => s.startAt < e.endsAt && s.endAt > e.startsAt));
  if (event) {
    factor *= 1.1;
    reasons.push(`${event.name} overlaps the slots`);
  }
  const m = match(report.billboard.audienceTags, campaign?.targetAudience ?? null);
  if (m !== null) {
    factor *= 0.8 + 0.4 * m;
    reasons.push(`audience match ${Math.round(m * 100)}%`);
  }
} else {
  reasons.push("no report bought, so valued at screen price");
}
const valuation = Math.round(screenTotal * factor);
const maxMinor = Math.max(1, Math.min(valuation, budgetLeft));
const openingMinor = Math.max(1, Math.round(valuation * 0.75));
line("buyer", `valuation ${usd(valuation)} (${reasons.join("; ")})`);
line("buyer", `will open at ${usd(openingMinor)} (75%), never above ${usd(maxMinor)} = min(valuation, budget left)`);

// ---------------------------------------------------------------- 5. negotiate

step(5, "Negotiates with the seller agent");
const negUrl = `${SERVER}/a2a/hosts/${workspaceId}/negotiations`;
async function a2aPost(url: string, body: unknown): Promise<Negotiation> {
  const res = await fetch(url, { method: "POST", headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const json = (await res.json().catch(() => ({}))) as Negotiation & { error?: { code: string; message: string } };
  if (!res.ok) stop(`seller agent refused (HTTP ${res.status}): ${json.error?.code ?? ""} ${json.error?.message ?? ""}`);
  return json;
}
let printed = 0;
function printMessages(n: Negotiation) {
  for (const m of n.messages.slice(printed)) {
    const amount = m.amountMinor === null ? "" : `${bold(usd(m.amountMinor))}  `;
    line(m.from, `${m.kind.toUpperCase().padEnd(9)} ${amount}${dim(m.reasoning)}`);
  }
  printed = n.messages.length;
}
const CONCEDE = [0, 0.45, 0.75, 1];
let n = await a2aPost(negUrl, {
  campaignId,
  slotIds: chosen.map((s) => s.slotId),
  amountMinor: openingMinor,
  reasoning: `Opening at 75% of our ${usd(valuation)} valuation (${reasons.join("; ")}).`,
});
printMessages(n);
while (n.status === "open") {
  if (n.sellerMinor <= maxMinor) {
    n = await a2aPost(`${negUrl}/${n.negotiationId}/messages`, {
      kind: "accept",
      reasoning: `${usd(n.sellerMinor)} is within our ${usd(maxMinor)} limit.`,
    });
  } else if (n.rounds >= n.maxRounds) {
    break;
  } else {
    const next = Math.min(maxMinor, Math.round(openingMinor + (maxMinor - openingMinor) * CONCEDE[Math.min(n.rounds, CONCEDE.length - 1)]));
    n = await a2aPost(`${negUrl}/${n.negotiationId}/messages`, {
      kind: "offer",
      amountMinor: next,
      reasoning: n.rounds + 1 >= n.maxRounds ? `Final offer: ${usd(next)} is our limit.` : `Moving to ${usd(next)}; our limit is set by the report and budget.`,
    });
  }
  printMessages(n);
}
if (n.status !== "agreed" || !n.holdId || n.agreedMinor === null) {
  if (alert && !argv.includes("--no-ack")) await api.post(`alerts/${alert.alertId}/ack`, {}).catch(() => undefined);
  stop(`No deal: negotiation ${n.status}${n.closedReason ? ` (${n.closedReason})` : ""}. Nothing held or paid.`, 2);
}
line("buyer", `agreed ${bold(usd(n.agreedMinor!))} for ${chosen.length} slot(s) (screen price ${usd(screenTotal)}); hold ${n.holdId} until ${time(n.holdExpiresAt ?? Date.now())}`);

// ---------------------------------------------------------------- 6. pay the hold (x402)

step(6, "Pays the seller for the hold (x402)");
const purchaseUrl = `${SERVER}/a2a/hosts/${workspaceId}/purchases/${n.holdId}`;
const holdPaid = await payX402(purchaseUrl, { method: "POST", ...authInit }, n.agreedMinor!, maxMinor, "the agreed hold");
let booked = false;
if (holdPaid.ok) {
  booked = holdPaid.status === 200 && holdPaid.body.outcome === "booked";
  line("buyer", `${booked ? "paid and booked" : `settled but NOT booked (${String(holdPaid.body.outcome ?? holdPaid.status)}; the host's finance desk has an exception)`} · tx ${holdPaid.tx}`);
  const url = explorerTxUrl(holdPaid.network, holdPaid.tx);
  if (url) note(url);
} else {
  line("buyer", holdPaid.reason);
  note(`retry: curl -i -X POST -H "Authorization: Bearer $AUCTION_NVIDIA_AGENT_KEY" ${purchaseUrl}`);
}

// ---------------------------------------------------------------- 7. ack

step(7, "Acknowledges the alert");
if (alert && !argv.includes("--no-ack")) {
  await api.post(`alerts/${alert.alertId}/ack`, {});
  line("buyer", `ack ${alert.alertId}`);
} else {
  note(alert ? "--no-ack: left unacknowledged" : "no alert (ran with --slot)");
}

console.log(
  `\n${booked ? "✓" : "•"} ${me.company.displayName} ↔ ${card.host.name}: report ${reportPaid.ok ? `paid ${usd(reportMinor)}` : "not paid"} · deal ${usd(n.agreedMinor!)} · hold ${booked ? "paid and booked" : "not paid"}`,
);
process.exit(booked || !CAN_PAY ? 0 : 3);
