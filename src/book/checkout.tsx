import { useEffect, useState } from "react";
import { CheckIcon, CopyIcon } from "@phosphor-icons/react";
import type { Id } from "../../convex/_generated/dataModel";
import { HOLD_TTL_MS } from "../../convex/lib/constants";
import { countdown, money } from "../lib/format";

/** Shared by the booking page and auction winners: everything needed to pay a hold. */

/** Convex serves the x402 purchase route on the deployment's site URL (`npx convex dev` writes it to .env.local). */
const SITE_URL = (
  (import.meta.env.VITE_CONVEX_SITE_URL as string | undefined) ||
  (import.meta.env.VITE_CONVEX_URL as string).replace(/\.cloud\/?$/, ".site")
).replace(/\/$/, "");
const NETWORK_NAMES: Record<string, string> = { "eip155:84532": "Base Sepolia", "eip155:8453": "Base" };

export function networkName(network: string): string {
  return NETWORK_NAMES[network] ?? network;
}

/** Block explorer link for a settlement transaction, when we know the network. */
export function explorerTxUrl(network: string | undefined, tx: string): string | null {
  if (!/^0x[0-9a-fA-F]{64}$/.test(tx)) return null;
  if (network === "eip155:84532") return `https://sepolia.basescan.org/tx/${tx}`;
  if (network === "eip155:8453") return `https://basescan.org/tx/${tx}`;
  return null;
}

export type PayableHold = { holdId: Id<"holds">; amountMinor: number; expiresAt: number };

export function PaymentCard(props: {
  hold: PayableHold;
  now: number;
  onTerms: boolean;
  busy: boolean;
  onBookOnTerms: () => void;
  /** Omitted for auction wins: giving the slot back counts as a default. */
  onRelease?: () => void;
}) {
  const { hold, now } = props;
  const left = Math.max(0, hold.expiresAt - now);

  return (
    <section aria-label="Payment" className="flex flex-col gap-[18px] rounded-2xl bg-panel p-[22px]">
      <div className="flex flex-col gap-2.5">
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-[13px] text-muted">Hold expires in</span>
          <span className="tabular text-[28px] font-medium">{countdown(hold.expiresAt, now)}</span>
        </div>
        <div
          role="progressbar"
          aria-label="Time left on hold"
          aria-valuemin={0}
          aria-valuemax={HOLD_TTL_MS / 1000}
          aria-valuenow={Math.round(left / 1000)}
          className="h-1 overflow-hidden rounded-full bg-line"
        >
          <div className="h-full bg-accent transition-[width] duration-1000 ease-linear" style={{ width: `${Math.min(100, (left / HOLD_TTL_MS) * 100)}%` }} />
        </div>
      </div>

      <div className="flex flex-col gap-1.5 border-t border-line pt-[18px]">
        <span className="text-[13px] text-muted">You pay</span>
        <span className="tabular text-[34px] font-medium tracking-tight">
          {(hold.amountMinor / 100).toFixed(2)} <span className="text-lg text-muted">USDC</span>
        </span>
        <span className="text-[13px] leading-relaxed text-muted">Exactly {money(hold.amountMinor)}. 1 USDC is 1 US dollar, and nothing is rounded.</span>
      </div>

      <dl className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-4 gap-y-2.5 text-[13px]">
        <dt className="text-muted">Paid in</dt>
        <dd>USDC</dd>
        <dt className="text-muted">Checkout</dt>
        <dd>x402, verified by Coinbase</dd>
      </dl>

      <p role="status" className="flex items-center gap-2 text-sm">
        <span aria-hidden="true" className="size-2 flex-none rounded-full bg-fg" />
        Waiting for payment. This page updates by itself when it arrives.
      </p>

      <div className="flex flex-col gap-2.5 border-t border-line pt-[18px]">
        <h3 className="text-sm font-semibold">Pay with x402</h3>
        <p className="text-[13px] leading-relaxed text-muted">
          Your buying agent pays this hold with its agent key (Dashboard, Agent keys, with the pay scope). The request answers with a 402
          naming the price, network and receiving address; the agent signs and sends it again. Money moves only after Coinbase verifies the
          payment and the hold is checked once more.
        </p>
        <CopyField
          value={`curl -X POST ${SITE_URL}/purchases/${hold.holdId} -H "Authorization: Bearer $BILLBOARDOS_AGENT_KEY"`}
          label="Copy payment request"
        />
      </div>

      {props.onTerms && (
        <div className="flex flex-col gap-2.5">
          <button
            type="button"
            onClick={props.onBookOnTerms}
            disabled={props.busy}
            className="min-h-11 rounded-full border border-line px-4 text-[15px] font-medium hover:border-muted disabled:opacity-50"
          >
            Book now, pay by invoice
          </button>
          <p className="text-[13px] leading-relaxed text-faint">Your account is on net-15 terms. We'll issue an invoice due in 15 days.</p>
        </div>
      )}

      {props.onRelease && (
        <button
          type="button"
          onClick={props.onRelease}
          disabled={props.busy}
          className="min-h-11 self-start text-sm text-muted underline underline-offset-[3px] hover:text-fg disabled:opacity-50"
        >
          Release hold
        </button>
      )}
    </section>
  );
}

export function CopyField({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return undefined;
    const id = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(id);
  }, [copied]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
    } catch {
      // Clipboard blocked: the text stays selectable.
    }
  }

  return (
    <div className="flex items-center gap-2 rounded-lg border border-line bg-ink py-1 pr-1 pl-3">
      <code className="min-w-0 flex-1 overflow-x-auto font-mono text-xs whitespace-nowrap">{value}</code>
      <button
        type="button"
        onClick={() => void copy()}
        aria-label={copied ? "Copied" : label}
        className="flex size-11 flex-none items-center justify-center rounded-md bg-raised text-muted hover:text-fg"
      >
        {copied ? <CheckIcon size={16} className="text-ok" /> : <CopyIcon size={16} />}
      </button>
    </div>
  );
}
