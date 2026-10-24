import { useEffect, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { errorMessage, money } from "../lib/format";
import { useNow } from "../lib/hooks";
import { PaymentCard } from "../book/checkout";
import { AuctionCard } from "./AuctionCard";

/** Bidder keys live in this browser only: the campaign's proof that it is the one bidding. */
function storedKey(auctionId: string, campaignId: string): string | null {
  try {
    return localStorage.getItem(`bidder:${auctionId}:${campaignId}`);
  } catch {
    return null;
  }
}
function storeKey(auctionId: string, campaignId: string, key: string) {
  try {
    localStorage.setItem(`bidder:${auctionId}:${campaignId}`, key);
  } catch {
    // Private mode: the key lives in memory for this page only.
  }
}

const dollarsToMinor = (s: string) => Math.round(Number.parseFloat(s) * 100);

/** Booking page: bid on an auctioned slot with the selected campaign, then pay for it if it wins. */
export function BidPanel({
  slotId,
  campaignId,
  onTerms = false,
}: {
  slotId: Id<"slots">;
  campaignId: Id<"campaigns">;
  /** The campaign's advertiser books on net-15 terms (invoice instead of payment). */
  onTerms?: boolean;
}) {
  const auction = useQuery(api.auctions.forSlot, { slotId });
  const join = useMutation(api.auctions.join);
  const bid = useMutation(api.auctions.bid);
  const setAutoBid = useMutation(api.auctions.setAutoBid);
  const confirmOnTerms = useMutation(api.bookings.confirmOnTerms);
  const now = useNow(1000);
  const [key, setKey] = useState<string | null>(null);
  const [amount, setAmount] = useState("");
  const [maxAmount, setMaxAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (auction) setKey(storedKey(auction.auctionId, campaignId));
  }, [auction?.auctionId, campaignId]); // eslint-disable-line react-hooks/exhaustive-deps

  const mine = useQuery(
    api.auctions.myStatus,
    auction && key ? { auctionId: auction.auctionId, campaignId, bidderKey: key } : "skip",
  );

  if (auction === undefined) return <div className="h-40 animate-pulse rounded bg-panel" />;
  if (auction === null) return null;

  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const doJoin = () =>
    run(async () => {
      const clientKey = `${crypto.randomUUID()}${crypto.randomUUID()}`.replace(/-/g, "");
      storeKey(auction.auctionId, campaignId, clientKey);
      await join({ auctionId: auction.auctionId, campaignId, clientKey });
      setKey(clientKey);
    });

  const doBid = () =>
    run(async () => {
      const value = dollarsToMinor(amount || String(auction.minNextBidMinor / 100));
      await bid({ auctionId: auction.auctionId, campaignId, bidderKey: key!, amountMinor: value });
      setAmount("");
    });

  const doAuto = () =>
    run(async () => {
      await setAutoBid({ auctionId: auction.auctionId, campaignId, bidderKey: key!, maxMinor: dollarsToMinor(maxAmount) });
    });

  const open = auction.status === "open";
  // The winner (or the runner-up after a default) pays its hold here, before it runs out.
  const award =
    mine &&
    mine.outcome === "won" &&
    mine.status === "closed" &&
    mine.holdId &&
    mine.holdKey &&
    mine.holdExpiresAt !== null &&
    mine.amountMinor !== null &&
    now < mine.holdExpiresAt
      ? { holdId: mine.holdId, holdKey: mine.holdKey, expiresAt: mine.holdExpiresAt, amountMinor: mine.amountMinor }
      : null;

  return (
    <div className="flex flex-col gap-4">
      <AuctionCard auction={auction} />
      {open && !key && (
        <button
          type="button"
          onClick={doJoin}
          disabled={busy}
          className="self-start rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-ink active:scale-[0.98] disabled:opacity-50"
        >
          Join this auction
        </button>
      )}
      {mine && <MyStatus mine={mine} />}
      {award && (
        <PaymentCard
          hold={award}
          now={now}
          onTerms={onTerms}
          busy={busy}
          onBookOnTerms={() => run(() => confirmOnTerms({ holdId: award.holdId, idempotencyKey: award.holdKey }))}
        />
      )}
      {open && key && (
        <div className="flex flex-col gap-4 rounded-lg border border-line bg-panel p-4">
          <div className="flex flex-wrap items-end gap-2">
            <label className="flex flex-col gap-2 text-sm">
              <span className="text-muted">Your bid (USD)</span>
              <input
                inputMode="decimal"
                placeholder={(auction.minNextBidMinor / 100).toFixed(2)}
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                className="w-36 rounded-md border border-line bg-ink px-3 py-2 font-mono text-fg"
              />
            </label>
            <button
              type="button"
              onClick={doBid}
              disabled={busy || mine?.outcome === "leading"}
              className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-ink active:scale-[0.98] disabled:opacity-50"
            >
              Bid
            </button>
          </div>
          <div className="flex flex-wrap items-end gap-2">
            <label className="flex flex-col gap-2 text-sm">
              <span className="text-muted">Auto-bid up to (USD, private)</span>
              <input
                inputMode="decimal"
                value={maxAmount}
                onChange={(e) => setMaxAmount(e.target.value)}
                className="w-36 rounded-md border border-line bg-ink px-3 py-2 font-mono text-fg"
              />
            </label>
            <button
              type="button"
              onClick={doAuto}
              disabled={busy || maxAmount.trim() === ""}
              className="rounded-md border border-line px-4 py-2 text-sm text-fg hover:border-muted disabled:opacity-50"
            >
              Set auto-bid
            </button>
          </div>
          <p className="text-xs text-faint">
            The system bids for you one step at a time, up to your maximum. Other bidders never see it. Bids can't exceed your campaign
            budget.
          </p>
        </div>
      )}
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

type Mine = FunctionReturnType<typeof api.auctions.myStatus>;

function MyStatus({ mine }: { mine: Mine }) {
  const text: Record<Mine["outcome"], string> = {
    leading: "You're leading.",
    outbid: "You've been outbid.",
    not_bidding: "You've joined but haven't bid yet.",
    won:
      mine.status === "settled"
        ? "You won, and the slot is booked."
        : "You won. The slot is held for you at the winning price; pay below to book it.",
    lost: "Another bidder won.",
    defaulted: "Your hold lapsed unpaid; the slot went to the next bidder.",
    failed: "The auction ended without a sale.",
  };
  return (
    <div role="status" className="rounded-lg border border-accent/60 bg-panel p-4 text-sm">
      <p className="font-medium">
        {mine.bidderLabel}: {text[mine.outcome]}
      </p>
      {mine.myMaxMinor > 0 && <p className="mt-1 text-muted">Your maximum: {money(mine.myMaxMinor)} (only you see this)</p>}
    </div>
  );
}
