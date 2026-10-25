import { useLayoutEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { money } from "../lib/format";
import { useNow } from "../lib/hooks";
import { ErrorLine, useAction } from "../customer/ui";

type Live = FunctionReturnType<typeof api.rounds.live>;
type Round = NonNullable<Live["screens"][number]["round"]>;
type Bid = Round["bids"][number];

const ROW_H = 56;
const WINDOW_MS = 30_000;
const MOVE_MS = 720;

const pillPrimary =
  "inline-flex min-h-11 items-center justify-center rounded-full bg-accent px-[22px] text-[17px] font-normal text-accent-ink transition-transform active:scale-95 disabled:opacity-50";

/** Where a company stands: agreed price, else latest counter; unanswered and passed sink. */
function standing(b: Bid): { value: number | null; tier: number } {
  if (b.status === "won") return { value: b.amountMinor, tier: 0 };
  if (b.status === "bid") return { value: b.amountMinor, tier: 1 };
  if (b.status === "invited" && b.amountMinor !== null) return { value: b.amountMinor, tier: 2 };
  if (b.status === "invited") return { value: null, tier: 3 };
  return { value: b.amountMinor, tier: 4 };
}

function ranked(bids: Bid[]): Bid[] {
  return [...bids].sort((x, y) => {
    const a = standing(x);
    const b = standing(y);
    if (a.tier <= 2 && b.tier <= 2)
      return (b.value ?? 0) - (a.value ?? 0) || (x.agreedAt ?? Infinity) - (y.agreedAt ?? Infinity) || a.tier - b.tier;
    return a.tier - b.tier || (y.offerMinor ?? 0) - (x.offerMinor ?? 0);
  });
}

const STATE: Record<Bid["status"], string> = {
  invited: "Thinking",
  bid: "Agreed",
  passed: "Passed",
  won: "Won",
  lost: "Lost",
  defaulted: "Unpaid",
};

/** Live 30-second sale: controls, status strip, and a quiet bid list. */
export function RoundsPanel({ billboardId }: { billboardId: Id<"billboards"> }) {
  const live = useQuery(api.rounds.live, {});
  const sellNow = useMutation(api.rounds.sellNow);
  const setAutoSell = useMutation(api.rounds.setAutoSell);
  const sell = useAction();
  const toggle = useAction();
  const [note, setNote] = useState<string | null>(null);
  const now = useNow(250);

  if (live === undefined) return <div className="h-56 animate-pulse rounded-[18px] bg-panel" />;

  const screen = live.screens.find((s) => s.billboardId === billboardId);
  const round = screen?.round ?? null;
  const previous = screen?.previous ?? null;
  const onAir =
    [previous, round].find((r) => r && r.status !== "bidding" && r.spotStartAt <= now && now < r.spotEndAt) ?? null;

  async function start() {
    setNote(null);
    const r = await sell.run(() => sellNow({ billboardId }));
    if (r?.reason) setNote(r.reason);
  }

  const playingLabel =
    !onAir || onAir.status === "unsold"
      ? "House ad"
      : onAir.winner
        ? onAir.winner
        : "—";
  const playingPrice =
    onAir && onAir.status !== "unsold" && onAir.priceMinor != null ? money(onAir.priceMinor) : "—";

  return (
    <section className="live-card live-sale">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <h2 className="text-[21px] font-semibold tracking-[0.23px] text-fg">Live Sales</h2>
        <div className="flex flex-wrap items-center gap-4">
          <label className="dashboard-switch">
            <input
              type="checkbox"
              checked={live.autoSell}
              disabled={toggle.busy}
              onChange={(e) => toggle.run(() => setAutoSell({ enabled: e.target.checked }))}
            />
            Auto-sell
          </label>
          <button
            type="button"
            className={pillPrimary}
            disabled={sell.busy || round?.status === "bidding"}
            onClick={start}
          >
            {round?.status === "bidding" ? "Selling…" : "Start selling"}
          </button>
        </div>
      </div>

      <ErrorLine error={sell.error ?? toggle.error} />
      {note && <p className="mt-2 text-sm text-amber-400">{note}</p>}

      <dl className="live-stats">
        <div>
          <dt>Now playing</dt>
          <dd>{playingLabel}</dd>
        </div>
        <div>
          <dt>Price</dt>
          <dd className="tabular font-mono">{playingPrice}</dd>
        </div>
        <div>
          <dt>{round?.status === "bidding" ? "Closes in" : "Window"}</dt>
          <dd className="tabular font-mono">
            {round?.status === "bidding" ? (
              <Countdown closesAt={round.closesAt} now={now} />
            ) : round ? (
              "Closed"
            ) : (
              "—"
            )}
          </dd>
        </div>
      </dl>

      {!round ? (
        <p className="mt-6 text-[17px] text-faint">No sale yet. Press Start selling.</p>
      ) : round.status === "bidding" ? (
        <Bidding round={round} now={now} />
      ) : (
        <Closed round={round} />
      )}
    </section>
  );
}

function Countdown({ closesAt, now }: { closesAt: number; now: number }) {
  return <span aria-live="polite">{Math.ceil(Math.max(0, closesAt - now) / 1000)}s</span>;
}

function Bidding({ round, now }: { round: Round; now: number }) {
  const order = ranked(round.bids);
  const left = Math.max(0, round.closesAt - now);
  return (
    <div className="mt-2">
      <div className="live-progress" aria-hidden>
        <i style={{ width: `${(left / WINDOW_MS) * 100}%` }} />
      </div>
      {round.bids.length === 0 ? (
        <p className="mt-5 text-[17px] text-faint">{round.outcome ?? "No offers this window."}</p>
      ) : (
        <Leaderboard order={order} />
      )}
    </div>
  );
}

function Closed({ round }: { round: Round }) {
  const order = ranked(round.bids);
  return (
    <div className="mt-2">
      {order.length > 0 ? (
        <Leaderboard order={order} />
      ) : (
        <p className="mt-5 text-[17px] text-faint">{round.outcome ?? "Unsold."}</p>
      )}
    </div>
  );
}

function Leaderboard({ order }: { order: Bid[] }) {
  const rankOf = new Map(order.map((b, i) => [b.advertiserId, i]));
  // Stable DOM order so React keeps the same node; rank only moves via transform.
  const byName = [...order].sort((a, b) => a.company.localeCompare(b.company));

  return (
    <ol className="live-board relative mt-5" style={{ height: order.length * ROW_H }} aria-label="Bids">
      {byName.map((b) => {
        const rank = rankOf.get(b.advertiserId) ?? 0;
        const { value, tier } = standing(b);
        const lead = rank === 0 && tier <= 2;
        const statusLabel = b.status === "invited" && b.amountMinor !== null ? "Countered" : STATE[b.status];
        return (
          <BidRow
            key={b.advertiserId}
            rank={rank}
            lead={lead}
            company={b.company}
            status={b.status}
            statusLabel={statusLabel}
            value={value}
          />
        );
      })}
    </ol>
  );
}

/** One company card: the whole frame slides to its new rank instead of swapping text in place. */
function BidRow({
  rank,
  lead,
  company,
  status,
  statusLabel,
  value,
}: {
  rank: number;
  lead: boolean;
  company: string;
  status: Bid["status"];
  statusLabel: string;
  value: number | null;
}) {
  const ref = useRef<HTMLLIElement>(null);
  const prevRank = useRef(rank);
  const [moving, setMoving] = useState(false);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const from = prevRank.current;
    if (from === rank) return;
    prevRank.current = rank;
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduceMotion) return;
    // FLIP: hold the old slot for one frame, then ease the whole card to the new rank.
    el.style.transition = "none";
    el.style.transform = `translate3d(0, ${from * ROW_H}px, 0)`;
    void el.offsetHeight;
    el.style.transition = "";
    el.style.transform = `translate3d(0, ${rank * ROW_H}px, 0)`;
    setMoving(true);
    const done = window.setTimeout(() => setMoving(false), MOVE_MS);
    return () => window.clearTimeout(done);
  }, [rank]);

  return (
    <li
      ref={ref}
      className={`live-bid ${lead ? "is-lead" : ""} ${moving ? "is-moving" : ""}`}
      style={{
        top: 0,
        height: ROW_H - 8,
        transform: `translate3d(0, ${rank * ROW_H}px, 0)`,
        zIndex: moving ? 4 : lead ? 2 : 1,
      }}
    >
      <span className="live-bid-rank tabular w-6 text-sm text-faint">{rank + 1}</span>
      <strong className="min-w-0 flex-1 truncate text-[17px] font-semibold tracking-[-0.37px]">
        {company}
      </strong>
      <span className={`live-badge live-badge-${status}`}>{statusLabel}</span>
      <span className={`live-bid-price tabular font-mono text-[17px] ${value === null ? "text-faint" : "text-fg"}`}>
        {value === null ? "…" : money(value)}
      </span>
    </li>
  );
}
