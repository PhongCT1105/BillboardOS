import type { FunctionReturnType } from "convex/server";
import { api } from "../../convex/_generated/api";
import { ago, money, shortDate, timeOfDay } from "../lib/format";
import { useNow } from "../lib/hooks";

type Item = FunctionReturnType<typeof api.negotiations.forWorkspace>[number];
type Sale = FunctionReturnType<typeof api.a2a.dataSalesForWorkspace>["recent"][number];

const KIND_LABEL: Record<string, string> = {
  ask: "Ask",
  offer: "Offer",
  counter: "Counter",
  accept: "Accept",
  reject: "Reject",
  agreement: "Agreement",
  expired: "Expired",
  failed: "Failed",
};

const STATUS_TONE: Record<string, string> = {
  open: "border-line text-muted",
  agreed: "border-emerald-400/50 text-emerald-300",
  rejected: "border-danger/60 text-danger",
  expired: "border-line text-faint",
  failed: "border-danger/60 text-danger",
};

/** Basescan link for a settlement tx (Base Sepolia / Base), else null. */
export function txUrl(network: string | null, tx: string): string | null {
  if (!/^0x[0-9a-fA-F]{64}$/.test(tx)) return null;
  if (network === "eip155:84532") return `https://sepolia.basescan.org/tx/${tx}`;
  if (network === "eip155:8453") return `https://basescan.org/tx/${tx}`;
  return null;
}

function TxLink({ network, tx }: { network: string | null; tx: string }) {
  const url = txUrl(network, tx);
  const short = tx.length > 14 ? `${tx.slice(0, 8)}…${tx.slice(-4)}` : tx;
  return url ? (
    <a href={url} target="_blank" rel="noreferrer" className="font-mono text-accent underline-offset-4 hover:underline">
      {short}
    </a>
  ) : (
    <span className="font-mono">{short}</span>
  );
}

/**
 * Agent-to-agent conversations (ADR 0005): every message with its amount,
 * who said it and why; the x402 payment for the agreed hold when it lands.
 * `perspective` decides whose name labels the counterparty.
 */
export function NegotiationTimeline(props: {
  items: Item[] | undefined;
  perspective: "host" | "customer";
  sales?: Sale[];
  empty: string;
}) {
  const now = useNow(30_000);
  const { items, sales } = props;
  if (items === undefined) return <div className="h-40 animate-pulse rounded-lg bg-panel" />;
  if (items.length === 0 && (!sales || sales.length === 0)) {
    return <p className="rounded-lg border border-dashed border-line px-5 py-8 text-center text-sm text-muted">{props.empty}</p>;
  }
  return (
    <div className="flex flex-col gap-4">
      {sales && sales.length > 0 && (
        <div className="rounded-lg border border-line bg-panel p-4">
          <p className="text-sm font-medium">Audience reports sold over x402</p>
          <ul className="mt-2 flex flex-col gap-1.5 text-sm">
            {sales.slice(0, 6).map((s) => (
              <li key={s.dataSaleId} className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="text-muted">
                  {props.perspective === "host" ? s.companyName : "You"} bought the {s.billboardName} report · {ago(s.recordedAt, now)}
                </span>
                <span className="flex items-baseline gap-3">
                  <span className="tabular font-mono">{money(s.amountMinor)}</span>
                  <TxLink network={s.network} tx={s.txHash} />
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {items.map(({ negotiation: n, billboardName, companyName, campaignBrief, createdAt, payment }) => (
        <article key={n.negotiationId} className="rounded-lg border border-line bg-panel p-4">
          <header className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="font-medium">
                {props.perspective === "host" ? `${companyName}'s agent` : "Your agent"} · {billboardName}
              </p>
              <p className="mt-0.5 truncate text-xs text-faint">
                {n.slotIds.length} slot{n.slotIds.length === 1 ? "" : "s"} · {campaignBrief.slice(0, 70)} · {ago(createdAt, now)}
              </p>
            </div>
            <span className={`rounded-full border px-2 py-0.5 text-xs font-medium ${STATUS_TONE[n.status] ?? STATUS_TONE.open}`}>
              {n.status === "agreed" && n.agreedMinor !== null ? `agreed ${money(n.agreedMinor)}` : n.status}
            </span>
          </header>
          <ol className="mt-3 flex flex-col gap-2 border-l border-line pl-4">
            {n.messages.map((m, i) => (
              <li key={i} className="relative text-sm">
                <span
                  aria-hidden
                  className={`absolute top-1.5 -left-[21px] size-2 rounded-full ${
                    m.from === "buyer" ? "bg-sky-400" : m.from === "seller" ? "bg-accent" : "bg-muted"
                  }`}
                />
                <div className="flex flex-wrap items-baseline gap-x-2">
                  <span className="text-xs font-medium tracking-wide text-muted uppercase">
                    {m.from === "buyer" ? "Buyer" : m.from === "seller" ? "Seller" : "System"} · {KIND_LABEL[m.kind] ?? m.kind}
                  </span>
                  {m.amountMinor !== null && <span className="tabular font-mono">{money(m.amountMinor)}</span>}
                  <span className="text-xs text-faint">{timeOfDay(m.createdAt)}</span>
                </div>
                <p className="text-muted">{m.reasoning}</p>
              </li>
            ))}
            {payment && (
              <li className="relative text-sm">
                <span aria-hidden className="absolute top-1.5 -left-[21px] size-2 rounded-full bg-emerald-400" />
                <div className="flex flex-wrap items-baseline gap-x-2">
                  <span className="text-xs font-medium tracking-wide text-emerald-300 uppercase">Payment · x402</span>
                  <span className="tabular font-mono">{money(payment.amountMinor)}</span>
                  <span className="text-xs text-faint">
                    {shortDate(payment.recordedAt)} {timeOfDay(payment.recordedAt)}
                  </span>
                </div>
                <p className="text-muted">
                  {payment.status === "exception" ? "Settled, held for finance review" : "Settled onchain"} · tx <TxLink network={payment.network} tx={payment.externalRef} />
                </p>
              </li>
            )}
          </ol>
          {n.status === "agreed" && !payment && n.holdExpiresAt !== null && (
            <p className="mt-3 text-xs text-muted">
              {now < n.holdExpiresAt ? `Hold waiting for x402 payment until ${timeOfDay(n.holdExpiresAt)}.` : "Hold lapsed without payment."}
            </p>
          )}
        </article>
      ))}
    </div>
  );
}
