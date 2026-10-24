import type { FunctionReturnType } from "convex/server";
import type { api } from "../../convex/_generated/api";
import { countdown, money, timeOfDay } from "../lib/format";
import { useNow } from "../lib/hooks";

export type AuctionView = NonNullable<FunctionReturnType<typeof api.auctions.forSlot>>;

const STATUS_LABEL: Record<AuctionView["status"], string> = {
  open: "Live",
  closed: "Closed, awaiting payment",
  settled: "Sold",
  failed: "No sale",
};

/** One auction: price, leader, countdown and the public bid ladder (auto-bid maxima are never shown). */
export function AuctionCard({ auction, ladderSize = 8 }: { auction: AuctionView; ladderSize?: number }) {
  const now = useNow(1000);
  const live = auction.status === "open";
  const extended = auction.extensions > 0;
  return (
    <article className="fade-in rounded-lg border border-line bg-panel p-4" aria-label={`Auction for ${auction.billboardName}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="font-medium">
          {auction.slots.map((s) => timeOfDay(s.startAt)).join(", ")} on {auction.billboardName}
        </p>
        <span
          className={`rounded px-2 py-0.5 text-xs font-medium ${
            live ? "bg-accent text-accent-ink" : auction.status === "settled" ? "bg-fg text-ink" : "bg-raised text-muted"
          }`}
        >
          {STATUS_LABEL[auction.status]}
        </span>
      </div>
      <div className="mt-3 flex flex-wrap items-end gap-6">
        <Figure label={live ? "Current price" : "Final price"} value={money(auction.winningBidMinor ?? auction.currentMinor)} />
        <Figure label="Reserve" value={money(auction.reserveMinor)} />
        <Figure label={live ? "Leader" : "Winner"} value={(live ? auction.leaderLabel : auction.winnerLabel) ?? "None yet"} />
        {live && (
          <Figure
            label={extended ? `Time left (extended ${auction.extensions}x)` : "Time left"}
            value={countdown(auction.endsAt, now)}
          />
        )}
      </div>
      {live && (
        <p className="mt-2 text-xs text-faint">
          Next bid at least {money(auction.minNextBidMinor)}. A bid in the last 30 s adds 30 s, up to {timeOfDay(auction.hardEndsAt)}.
        </p>
      )}
      {auction.outcomeNote && <p className="mt-2 text-sm text-muted">{auction.outcomeNote}</p>}
      <p className="mt-2 text-xs text-faint">{auction.openReason}</p>
      {auction.ladder.length > 0 ? (
        <ol className="mt-3 flex flex-col divide-y divide-line border-t border-line text-sm" aria-label="Bid ladder">
          {auction.ladder.slice(0, ladderSize).map((b, i) => (
            <li key={`${b.createdAt}-${i}`} className="flex items-center justify-between py-1.5">
              <span className={i === 0 ? "text-fg" : "text-muted"}>
                {b.bidderLabel}
                {b.isAuto && <span className="ml-2 text-xs text-faint">auto</span>}
              </span>
              <span className={`tabular font-mono ${i === 0 ? "text-fg" : "text-muted"}`}>{money(b.amountMinor)}</span>
            </li>
          ))}
        </ol>
      ) : (
        <p className="mt-3 text-sm text-muted">{auction.bidders} bidder{auction.bidders === 1 ? "" : "s"} joined. No bids yet.</p>
      )}
    </article>
  );
}

function Figure(props: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs text-muted">{props.label}</p>
      <p className="tabular font-mono text-lg">{props.value}</p>
    </div>
  );
}
