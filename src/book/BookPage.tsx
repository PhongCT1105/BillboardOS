import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { CheckIcon, WarningIcon } from "@phosphor-icons/react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { HOLD_TTL_MS } from "../../convex/lib/constants";
import { dayLabel, errorMessage, money, shortDate, timeOfDay, timeRange } from "../lib/format";
import { useHashParams, useNow } from "../lib/hooks";
import { BidPanel } from "../auctions/BidPanel";
import { explorerTxUrl, networkName, PaymentCard } from "./checkout";

type Quote = FunctionReturnType<typeof api.quotes.create>;
type Hold = FunctionReturnType<typeof api.holds.create>;
type TermsBooking = FunctionReturnType<typeof api.bookings.confirmOnTerms>;
type Campaign = FunctionReturnType<typeof api.campaigns.list>[number];
type Billboard = FunctionReturnType<typeof api.billboards.list>[number];
type Slot = FunctionReturnType<typeof api.slots.listForBillboard>[number];
type LiveAuction = FunctionReturnType<typeof api.auctions.live>[number];
type ReceiptPayment = NonNullable<FunctionReturnType<typeof api.holds.receipt>>["payments"][number];
type PaymentException = NonNullable<ReceiptPayment["exception"]>;

const QUARTER_HOUR = 15 * 60 * 1000;
const WINDOW_MS = 12 * 60 * 60 * 1000;
const MAX_SLOTS = 4;
const STEPS = ["Choose slots", "Hold", "Pay", "Booked"];
/** A slot in one of these states has been sold. */
const SOLD = new Set<Slot["state"]>(["booked", "scheduled", "played", "failed_delivery"]);

export function BookPage() {
  const campaigns = useQuery(api.campaigns.list, {});
  const billboards = useQuery(api.billboards.list);
  const advertisers = useQuery(api.advertisers.list);
  // Deep link from an alert: #/book?billboard=..&campaign=..&slots=a,b
  const params = useHashParams();
  const [campaignId, setCampaignId] = useState<Id<"campaigns"> | null>(() => (params.get("campaign") as Id<"campaigns"> | null) ?? null);
  const [billboardId, setBillboardId] = useState<Id<"billboards"> | null>(() => (params.get("billboard") as Id<"billboards"> | null) ?? null);
  const [initialSlots] = useState<Id<"slots">[]>(() =>
    (params.get("slots") ?? "")
      .split(",")
      .filter(Boolean)
      .slice(0, MAX_SLOTS) as Id<"slots">[],
  );
  const [creating, setCreating] = useState(false);
  const activeCampaign = campaigns?.find((c) => c._id === campaignId) ?? campaigns?.[0];
  const billboard = billboards?.find((b) => b._id === billboardId) ?? billboards?.[0];

  if (campaigns === undefined || billboards === undefined) {
    return <main className="mx-auto max-w-[1200px] px-4 pt-8 md:px-6"><div className="h-64 animate-pulse rounded bg-panel" /></main>;
  }
  if (!billboard) {
    return (
      <main className="mx-auto max-w-[1200px] px-4 py-16 md:px-6">
        <p className="text-muted">No screens are on the marketplace yet.</p>
      </main>
    );
  }
  if (!activeCampaign || creating) {
    return (
      <main className="mx-auto max-w-[1200px] px-4 pt-8 pb-16 md:px-6">
        <h1 className="text-2xl font-semibold tracking-tight">{activeCampaign ? "New campaign" : "Start your first campaign"}</h1>
        <p className="mt-2 text-[15px] text-muted">Quotes, holds and bookings belong to a campaign. Only your company sees it.</p>
        <NewCampaignForm
          onCreated={(id) => {
            setCampaignId(id);
            setCreating(false);
          }}
          onCancel={activeCampaign ? () => setCreating(false) : undefined}
        />
      </main>
    );
  }
  const terms = advertisers?.find((a) => a._id === activeCampaign.advertiserId)?.paymentTerms;

  return (
    <main className="mx-auto max-w-[1200px] px-4 pt-8 pb-32 md:px-6 lg:pb-16">
      <BookingFlow
        key={`${activeCampaign._id}:${billboard._id}`}
        billboard={billboard}
        billboards={billboards}
        campaign={activeCampaign}
        campaigns={campaigns}
        initialSlots={billboard._id === billboardId ? initialSlots : []}
        onBillboardChange={setBillboardId}
        onCampaignChange={setCampaignId}
        onNewCampaign={() => setCreating(true)}
        onTerms={terms === "net15"}
      />
    </main>
  );
}

function NewCampaignForm(props: { onCreated: (id: Id<"campaigns">) => void; onCancel?: () => void }) {
  const create = useMutation(api.campaigns.create);
  const [brief, setBrief] = useState("");
  const [budget, setBudget] = useState("300");
  const [city, setCity] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const id = await create({
        brief,
        budgetMinor: Math.round(Number.parseFloat(budget) * 100),
        targetCity: city.trim() || undefined,
      });
      props.onCreated(id);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <form onSubmit={submit} className="mt-6 flex max-w-xl flex-col gap-4">
      <label className="flex flex-col gap-2 text-sm">
        <span className="text-muted">What are you promoting, and to whom?</span>
        <textarea
          required
          rows={3}
          value={brief}
          onChange={(e) => setBrief(e.target.value)}
          className="rounded-md border border-line bg-panel px-3 py-2 text-fg"
        />
      </label>
      <div className="grid grid-cols-2 gap-4">
        <label className="flex flex-col gap-2 text-sm">
          <span className="text-muted">Budget (USD)</span>
          <input
            inputMode="decimal"
            value={budget}
            onChange={(e) => setBudget(e.target.value)}
            className="min-h-11 rounded-md border border-line bg-panel px-3 py-2 tabular text-fg"
          />
        </label>
        <label className="flex flex-col gap-2 text-sm">
          <span className="text-muted">Target city (optional)</span>
          <input value={city} onChange={(e) => setCity(e.target.value)} className="min-h-11 rounded-md border border-line bg-panel px-3 py-2 text-fg" />
        </label>
      </div>
      {error && <p role="alert" className="text-sm text-danger">{error}</p>}
      <div className="flex gap-2">
        <button
          type="submit"
          disabled={busy || !brief.trim()}
          className="min-h-11 rounded-full bg-fg px-5 text-sm font-semibold text-ink hover:bg-white active:scale-[0.98] disabled:opacity-50"
        >
          Create campaign
        </button>
        {props.onCancel && (
          <button type="button" onClick={props.onCancel} className="min-h-11 px-3 text-sm text-muted hover:text-fg">
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}

function BookingFlow(props: {
  billboard: Billboard;
  billboards: Billboard[];
  campaign: Campaign;
  campaigns: Campaign[];
  /** Slots preselected by an alert's deep link. */
  initialSlots: Id<"slots">[];
  onBillboardChange: (id: Id<"billboards">) => void;
  onCampaignChange: (id: Id<"campaigns">) => void;
  onNewCampaign: () => void;
  onTerms: boolean;
}) {
  const { billboard, campaign } = props;
  const minuteNow = useNow(60_000);
  const now = useNow(1000);
  const from = Math.floor(minuteNow / QUARTER_HOUR) * QUARTER_HOUR;
  const slots = useQuery(api.slots.listForBillboard, { billboardId: billboard._id, from, to: from + WINDOW_MS });
  const estimates = useQuery(api.quotes.estimates, {
    billboardId: billboard._id,
    from,
    to: from + WINDOW_MS,
    now: minuteNow,
    campaignId: campaign._id,
  });
  const createQuote = useMutation(api.quotes.create);
  const createHold = useMutation(api.holds.create);
  const releaseHold = useMutation(api.holds.release);
  const confirmOnTerms = useMutation(api.bookings.confirmOnTerms);

  const auctions = useQuery(api.auctions.live, { billboardId: billboard._id, now: minuteNow });
  const auctionSlotIds = useMemo(
    () => new Set((auctions ?? []).filter((a) => a.status === "open").flatMap((a) => a.slots.map((s) => s.slotId))),
    [auctions],
  );
  const estimateBySlot = useMemo(
    () => new Map<Id<"slots">, number>((estimates ?? []).map((e) => [e.slotId, e.amountMinor])),
    [estimates],
  );
  const [auctionSlot, setAuctionSlot] = useState<Id<"slots"> | null>(null);
  const [selected, setSelected] = useState<Id<"slots">[]>(props.initialSlots);
  const [preselectNote, setPreselectNote] = useState<string | null>(null);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [hold, setHold] = useState<Hold | null>(null);
  const [holdKey, setHoldKey] = useState<string | null>(null);
  const [invoice, setInvoice] = useState<TermsBooking | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** A slot that turned into an auction under the buyer; `moved` = it was taken out of their selection. */
  const [notice, setNotice] = useState<{ slotId: Id<"slots">; moved: boolean } | null>(null);
  // Only the holder (with its key) can read this: every payment reported against the hold and its outcome.
  const receipt = useQuery(api.holds.receipt, hold && holdKey ? { holdId: hold.holdId, idempotencyKey: holdKey } : "skip");

  const upcoming = useMemo(() => (slots ?? []).filter((s) => s.startAt > minuteNow), [slots, minuteNow]);
  const available = useMemo(() => upcoming.filter((s) => s.state === "available"), [upcoming]);
  // Live view of the held slots: a payment from x402 or the console flips them to booked.
  const heldSlots = useMemo(() => (hold ? (slots ?? []).filter((s) => hold.slotIds.includes(s._id)) : []), [slots, hold]);
  const booked =
    hold !== null &&
    (invoice !== null ||
      receipt?.holdStatus === "converted" ||
      (heldSlots.length === hold.slotIds.length && heldSlots.every((s) => s.holdId === hold.holdId && SOLD.has(s.state))));
  // A payment that arrived but couldn't book (late, wrong amount or asset) waits for the operator.
  const flagged = booked ? null : (receipt?.payments.find((p) => p.exception !== null) ?? null);
  const expired = hold !== null && !booked && now >= hold.expiresAt;
  const step = booked ? 4 : hold ? 3 : 1;

  // Slots preselected from an alert: drop any that sold meanwhile; auctioned ones go to the bid panel.
  const reconciled = useRef(props.initialSlots.length === 0);
  useEffect(() => {
    if (reconciled.current || slots === undefined || auctions === undefined) return;
    reconciled.current = true;
    const open = new Set(available.map((s) => s._id));
    const still = props.initialSlots.filter((id) => open.has(id));
    const hot = still.find((id) => auctionSlotIds.has(id));
    if (hot) {
      setSelected([]);
      setAuctionSlot(hot);
    } else {
      setSelected(still);
    }
    const gone = props.initialSlots.length - still.length;
    setPreselectNote(
      still.length === 0
        ? "The slots from your alert are no longer available. Pick others below."
        : gone > 0
          ? `${gone} slot${gone === 1 ? " from your alert has" : "s from your alert have"} sold since; the rest are selected.`
          : hot
            ? "This slot is in a live auction: bid below."
            : "Slots from your alert are selected. Hold them to lock today's price.",
    );
  }, [slots, auctions, available, auctionSlotIds, props.initialSlots]);

  // The seller agent can auction a slot while it sits in the selection: take it out and offer the auction.
  // Only slots that turn hot after the first load count; the alert check above handles the first load.
  const seenAuctionSlots = useRef<Set<Id<"slots">> | null>(null);
  useEffect(() => {
    if (auctions === undefined) return;
    const before = seenAuctionSlots.current;
    seenAuctionSlots.current = auctionSlotIds;
    if (before === null || hold) return;
    const moved = selected.find((id) => auctionSlotIds.has(id) && !before.has(id));
    if (!moved) return;
    setSelected((cur) => cur.filter((id) => !auctionSlotIds.has(id)));
    setQuote(null);
    setNotice({ slotId: moved, moved: true });
  }, [auctions, auctionSlotIds, selected, hold]);

  function toggle(id: Id<"slots">) {
    setNotice(null);
    setQuote(null);
    if (auctionSlotIds.has(id)) {
      // Hot slot: no posted price, bid instead.
      setSelected([]);
      setAuctionSlot((cur) => (cur === id ? null : id));
      return;
    }
    setAuctionSlot(null);
    setSelected((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : cur.length >= MAX_SLOTS ? cur : [...cur, id]));
  }

  async function run<T>(fn: () => Promise<T>): Promise<T | undefined> {
    setBusy(true);
    setError(null);
    try {
      return await fn();
    } catch (err) {
      setError(errorMessage(err));
      return undefined;
    } finally {
      setBusy(false);
    }
  }

  function startOver() {
    setHold(null);
    setHoldKey(null);
    setQuote(null);
    setInvoice(null);
    setSelected([]);
    setAuctionSlot(null);
    setError(null);
    setNotice(null);
  }

  /** Switch to the bid panel for `slotId`; `explain` says why when the switch wasn't the buyer's click. */
  function bidOn(slotId: Id<"slots">, explain: boolean) {
    setSelected([]);
    setQuote(null);
    setAuctionSlot(slotId);
    setError(null);
    setNotice(explain ? { slotId, moved: false } : null);
  }

  // Holding is free and short, so one click quotes and holds: the exact price arrives with the hold.
  const holdSelected = () =>
    run(async () => {
      try {
        const fresh = await createQuote({ campaignId: campaign._id, slotIds: selected, actor: "buyer:web" });
        setQuote(fresh);
        const key = crypto.randomUUID();
        setHold(await createHold({ quoteId: fresh.quoteId, idempotencyKey: key, actor: "buyer:web" }));
        setHoldKey(key);
      } catch (err) {
        const slotId = auctionSlotFrom(err, auctions);
        if (!slotId) throw err;
        bidOn(slotId, true);
      }
    });

  function clearSelection() {
    setSelected([]);
    setQuote(null);
    setNotice(null);
    setPreselectNote(null);
  }

  const cancelHold = () =>
    run(async () => {
      if (!hold || !holdKey) return;
      await releaseHold({ holdId: hold.holdId, idempotencyKey: holdKey });
      startOver();
    });

  const bookOnTerms = () =>
    run(async () => {
      if (!hold || !holdKey) return;
      setInvoice(await confirmOnTerms({ holdId: hold.holdId, idempotencyKey: holdKey }));
    });

  const selectedSlots = upcoming.filter((s) => selected.includes(s._id));
  const selectionEstimate = selectedSlots.every((s) => estimateBySlot.has(s._id))
    ? selectedSlots.reduce((sum, s) => sum + Math.round((estimateBySlot.get(s._id) ?? 0) / 100) * 100, 0)
    : null;

  // The screen's finding: where today's price peaks and bottoms out, from the live estimates.
  const priced = available.filter((s) => estimateBySlot.has(s._id));
  const priceOf = (s: Slot) => estimateBySlot.get(s._id) ?? 0;
  const peak = priced.reduce<Slot | null>((best, s) => (!best || priceOf(s) > priceOf(best) ? s : best), null);
  const low = priced.reduce<Slot | null>((best, s) => (!best || priceOf(s) < priceOf(best) ? s : best), null);

  const noticeSlot = notice ? (slots ?? []).find((s) => s._id === notice.slotId) : undefined;
  const noticeTime = noticeSlot ? timeOfDay(noticeSlot.startAt) : "That slot";

  if (hold && booked) {
    return (
      <div className="flex flex-col gap-7">
        <Stepper current={4} />
        <BookedView
          billboard={billboard}
          campaign={campaign}
          hold={hold}
          slots={heldSlots}
          invoice={invoice}
          payments={receipt?.payments}
          onBookMore={startOver}
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-7">
      <Stepper current={step} />
      {/* On a phone the selection card sits below the whole grid, so its action rides along at the bottom. */}
      {!hold && !auctionSlot && selectedSlots.length > 0 && (
        <div className="fixed inset-x-0 bottom-0 z-20 border-t border-line bg-panel px-4 py-3 lg:hidden">
          <div className="mx-auto flex max-w-[1200px] flex-col gap-2">
            {error && <p role="alert" className="text-sm text-danger">{error}</p>}
            <div className="flex items-center justify-between gap-3">
              <p className="text-sm">
                <span className="font-medium">
                  {selectedSlots.length} {selectedSlots.length === 1 ? "slot" : "slots"}
                </span>
                {selectionEstimate !== null && <span className="tabular text-muted">, about ${selectionEstimate / 100}</span>}
              </p>
              <button type="button" onClick={holdSelected} disabled={busy} className={PRIMARY_BUTTON}>
                {holdLabel(selectedSlots.length, busy)}
              </button>
            </div>
          </div>
        </div>
      )}
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">
          {!hold ? `Book ${billboard.name}` : flagged ? "Payment under review" : expired ? "Hold expired" : "Slots held for you"}
        </h1>
        <p className="max-w-[640px] text-[15px] leading-relaxed text-muted">
          {!hold
            ? `${billboard.locationLabel}. Pick up to ${MAX_SLOTS} 15-minute slots. Prices follow live foot traffic and nearby events.`
            : flagged
              ? "A payment arrived, but it couldn't book the slots automatically."
              : expired
                ? "The slots went back on sale."
                : "Nobody else can buy them until the hold runs out. Pay before then to book."}
        </p>
        {!hold && peak && low && peak._id !== low._id && (
          <p className="text-[15px]">
            Busiest at <span className="tabular">{timeOfDay(peak.startAt)} ({estimateLabel(estimateBySlot.get(peak._id) ?? 0)})</span>
            {"; "}cheapest at <span className="tabular">{timeOfDay(low.startAt)} ({estimateLabel(estimateBySlot.get(low._id) ?? 0)})</span>
          </p>
        )}
      </header>

      <div className="grid grid-cols-1 gap-10 lg:grid-cols-[minmax(0,1fr)_400px]">
        <section className="flex min-w-0 flex-col gap-5" aria-label={hold ? "Held slots" : "Available slots"}>
          {hold ? (
            <HeldSlots hold={hold} quote={quote} slots={heldSlots} />
          ) : (
            <>
              <Pickers
                billboard={billboard}
                billboards={props.billboards}
                campaign={campaign}
                campaigns={props.campaigns}
                onBillboardChange={props.onBillboardChange}
                onCampaignChange={props.onCampaignChange}
                onNewCampaign={props.onNewCampaign}
              />
              <SlotPicker
                slots={slots === undefined ? undefined : upcoming}
                estimates={estimateBySlot}
                selected={selected}
                auctionSlot={auctionSlot}
                auctionSlotIds={auctionSlotIds}
                onToggle={toggle}
              />
            </>
          )}
        </section>

        <aside className="flex flex-col gap-6 lg:sticky lg:top-6 lg:self-start">
          {!hold && notice && (
            <div role="status" className="flex flex-col gap-3 rounded-2xl bg-raised p-4 text-sm">
              <p>
                {noticeTime} just went to auction
                {notice.moved ? ", so we took it out of your selection." : ". Bid on it below, or pick other slots."}
              </p>
              {notice.moved && (
                <button
                  type="button"
                  onClick={() => bidOn(notice.slotId, false)}
                  className="min-h-11 self-start rounded-full border border-line px-4 text-sm font-medium hover:border-muted active:scale-[0.98]"
                >
                  Bid on it
                </button>
              )}
            </div>
          )}
          {preselectNote && !hold && !quote && !notice && <p role="status" className="text-sm text-muted">{preselectNote}</p>}
          {error && <p role="alert" className="text-sm text-danger">{error}</p>}
          {hold ? (
            flagged?.exception ? (
              <FlaggedCard payment={flagged} exception={flagged.exception} traceId={hold.traceId} onStartOver={startOver} />
            ) : expired ? (
              <ExpiredCard onStartOver={startOver} />
            ) : (
              <PaymentCard
                hold={hold}
                now={now}
                onTerms={props.onTerms}
                busy={busy}
                onBookOnTerms={bookOnTerms}
                onRelease={cancelHold}
              />
            )
          ) : auctionSlot ? (
            <BidPanel slotId={auctionSlot} campaignId={campaign._id} onTerms={props.onTerms} />
          ) : (
            <SelectionCard
              selectedSlots={selectedSlots}
              estimates={estimateBySlot}
              busy={busy}
              onHold={holdSelected}
              onClear={clearSelection}
            />
          )}
          <CreativeCard campaign={campaign} />
        </aside>
      </div>
    </div>
  );
}

/** The slot an AUCTION_OPEN error points at: quotes name the slot, holds name the auction. */
function auctionSlotFrom(err: unknown, auctions: LiveAuction[] | undefined): Id<"slots"> | null {
  if (!err || typeof err !== "object" || !("data" in err)) return null;
  const data: unknown = (err as { data: unknown }).data;
  if (!data || typeof data !== "object") return null;
  const { code, slotId, auctionId } = data as { code?: unknown; slotId?: unknown; auctionId?: unknown };
  if (code !== "AUCTION_OPEN") return null;
  if (typeof slotId === "string") return slotId as Id<"slots">;
  return auctions?.find((a) => a.auctionId === auctionId)?.slots[0]?.slotId ?? null;
}

function Stepper({ current }: { current: number }) {
  return (
    <ol aria-label="Checkout progress" className="flex flex-wrap items-center gap-x-7 gap-y-2.5 text-[13px]">
      {STEPS.map((label, i) => {
        const n = i + 1;
        const isCurrent = n === current;
        const done = n < current || current === STEPS.length;
        return (
          <li
            key={label}
            aria-current={isCurrent ? "step" : undefined}
            className={`flex items-center gap-1.5 ${isCurrent ? "font-medium text-fg" : done ? "text-muted" : "text-faint"}`}
          >
            {done && <CheckIcon size={12} weight="bold" aria-hidden="true" />}
            {label}
          </li>
        );
      })}
    </ol>
  );
}

type MarkKind = "done" | "active" | "todo" | "problem";

function Mark({ mark }: { mark: MarkKind }) {
  if (mark === "done") {
    return (
      <span role="img" aria-label="Done" className="flex size-[22px] flex-none items-center justify-center rounded-full border border-ok/40 bg-ok/15">
        <CheckIcon size={12} weight="bold" className="text-ok" />
      </span>
    );
  }
  if (mark === "active") {
    return (
      <span role="img" aria-label="In progress" className="flex size-[22px] flex-none items-center justify-center rounded-full border-2 border-fg">
        <span className="size-1.5 rounded-full bg-fg" />
      </span>
    );
  }
  if (mark === "problem") {
    return (
      <span role="img" aria-label="Needs attention" className="flex size-[22px] flex-none items-center justify-center rounded-full border border-danger/40 bg-danger/15">
        <WarningIcon size={12} weight="bold" className="text-danger" />
      </span>
    );
  }
  return <span role="img" aria-label="Not started" className="size-[22px] flex-none rounded-full border border-line" />;
}

function Pickers(props: {
  billboard: Billboard;
  billboards: Billboard[];
  campaign: Campaign;
  campaigns: Campaign[];
  onBillboardChange: (id: Id<"billboards">) => void;
  onCampaignChange: (id: Id<"campaigns">) => void;
  onNewCampaign: () => void;
}) {
  return (
    <div className="flex flex-wrap items-end gap-4">
      <label className="flex min-w-[240px] flex-1 flex-col gap-2 text-sm">
        <span className="text-muted">Screen</span>
        <select
          className="min-h-11 rounded-md border border-line bg-panel px-3 py-2 text-fg"
          value={props.billboard._id}
          onChange={(e) => props.onBillboardChange(e.target.value as Id<"billboards">)}
        >
          {props.billboards.map((b) => (
            <option key={b._id} value={b._id}>
              {b.name}, {b.city}
            </option>
          ))}
        </select>
      </label>
      <label className="flex min-w-[240px] flex-1 flex-col gap-2 text-sm">
        <span className="text-muted">Booking for</span>
        <select
          className="min-h-11 rounded-md border border-line bg-panel px-3 py-2 text-fg"
          value={props.campaign._id}
          onChange={(e) => props.onCampaignChange(e.target.value as Id<"campaigns">)}
        >
          {props.campaigns.map((c) => (
            <option key={c._id} value={c._id}>
              {c.advertiserName}: {c.brief.slice(0, 48)}
            </option>
          ))}
        </select>
      </label>
      <button
        type="button"
        onClick={props.onNewCampaign}
        className="min-h-11 rounded-full border border-line px-4 text-sm text-muted hover:border-muted hover:text-fg"
      >
        New campaign
      </button>
    </div>
  );
}

function groupByDay(slots: Slot[]): { label: string; slots: Slot[] }[] {
  const groups: { label: string; slots: Slot[] }[] = [];
  for (const slot of slots) {
    const label = dayLabel(slot.startAt);
    const last = groups[groups.length - 1];
    if (last?.label === label) last.slots.push(slot);
    else groups.push({ label, slots: [slot] });
  }
  return groups;
}

/** "~$48": a live screen-price estimate, rounded to the dollar. */
const estimateLabel = (minor: number) => `~$${Math.round(minor / 100)}`;

function SlotPicker(props: {
  slots: Slot[] | undefined;
  estimates: Map<Id<"slots">, number>;
  selected: Id<"slots">[];
  auctionSlot: Id<"slots"> | null;
  auctionSlotIds: Set<Id<"slots">>;
  onToggle: (id: Id<"slots">) => void;
}) {
  const { slots } = props;
  if (slots === undefined) return <div className="h-40 animate-pulse rounded bg-panel" />;
  const anyOpen = slots.some((s) => s.state === "available");
  const anyAuction = slots.some((s) => s.state === "available" && props.auctionSlotIds.has(s._id));
  const maxEstimate = Math.max(0, ...props.estimates.values());

  return (
    <div className="flex flex-col gap-5 border-t border-line pt-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-[17px] font-semibold">Next 12 hours</h2>
        <ul aria-label="Legend" className="flex flex-wrap gap-x-4 gap-y-1.5 text-xs text-muted">
          <li className="flex items-center gap-1.5"><span aria-hidden="true" className="size-2.5 rounded-[3px] border border-line bg-panel" />Open</li>
          <li className="flex items-center gap-1.5"><span aria-hidden="true" className="size-2.5 rounded-[3px] bg-raised ring-1 ring-fg" />Selected</li>
          <li className="flex items-center gap-1.5"><span aria-hidden="true" className="size-2.5 rounded-[3px] border border-line bg-ink" />Taken</li>
          <li className="flex items-center gap-1.5"><span aria-hidden="true" className="size-2.5 rounded-[3px] border border-dashed border-muted bg-panel" />Auction</li>
          <li className="flex items-center gap-1.5"><span aria-hidden="true" className="h-[3px] w-3 rounded-full bg-accent" />Live price</li>
        </ul>
      </div>
      {!anyOpen && <p className="text-muted">Every slot in the next 12 hours is taken.</p>}
      {groupByDay(slots).map((group) => (
        <div key={group.label} className="flex flex-col gap-2">
          <h3 className="text-sm text-muted">{group.label}</h3>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(104px,1fr))] gap-2">
            {group.slots.map((s) => (
              <SlotCell
                key={s._id}
                slot={s}
                estimate={props.estimates.get(s._id)}
                maxEstimate={maxEstimate}
                selected={props.selected.includes(s._id) || props.auctionSlot === s._id}
                auction={props.auctionSlotIds.has(s._id)}
                onToggle={() => props.onToggle(s._id)}
              />
            ))}
          </div>
        </div>
      ))}
      <p className="text-[13px] leading-relaxed text-muted">
        {props.selected.length} of {MAX_SLOTS} selected. Prices marked ~ are live estimates; holding shows your exact price.
      </p>
      {anyAuction && (
        <p className="text-[13px] leading-relaxed text-muted">
          Slots marked Auction are in demand, so they sell by live bidding instead of a fixed price. Select one to bid.
        </p>
      )}
    </div>
  );
}

/** One 15-minute slot. Its live price is the orange bar along the foot, scaled to the day's highest, so the grid reads as the day's price curve. */
function SlotCell(props: {
  slot: Slot;
  estimate: number | undefined;
  maxEstimate: number;
  selected: boolean;
  auction: boolean;
  onToggle: () => void;
}) {
  const { slot } = props;
  if (slot.state !== "available") {
    const held = slot.state === "held";
    return (
      <div className="flex min-h-16 flex-col gap-1 rounded-lg border border-line px-3 py-2.5 text-faint">
        <span className={`tabular text-[15px] ${held ? "" : "line-through"}`}>{timeOfDay(slot.startAt)}</span>
        <span className="text-xs">{held ? "On hold" : "Taken"}</span>
      </div>
    );
  }
  const share = props.estimate !== undefined && props.maxEstimate > 0 ? props.estimate / props.maxEstimate : 0;
  return (
    <button
      type="button"
      onClick={props.onToggle}
      aria-pressed={props.selected}
      className={`relative flex min-h-16 flex-col gap-1 rounded-lg px-3 pt-2.5 pb-4 text-left transition-[transform,background-color] active:scale-[0.97] ${
        props.selected
          ? "bg-raised ring-1 ring-fg"
          : props.auction
            ? "bg-panel outline-1 -outline-offset-1 outline-muted outline-dashed hover:bg-raised"
            : "bg-panel hover:bg-raised"
      }`}
    >
      <span className="tabular text-[15px] font-medium">{timeOfDay(slot.startAt)}</span>
      <span className={`tabular text-xs ${props.auction || props.selected ? "text-fg" : "text-muted"}`}>
        {props.auction
          ? props.selected
            ? "Bidding"
            : "Auction · bid"
          : props.estimate !== undefined
            ? estimateLabel(props.estimate)
            : "Open"}
      </span>
      {!props.auction && share > 0 && (
        <span
          aria-hidden="true"
          className="absolute bottom-2 left-3 h-[3px] rounded-full bg-accent"
          style={{ width: `calc((100% - 24px) * ${share.toFixed(3)})` }}
        />
      )}
    </button>
  );
}

/** The screen's one primary button: inverted, so it is the only white fill on the page. */
const PRIMARY_BUTTON =
  "flex min-h-11 items-center justify-center rounded-full bg-fg px-5 text-[15px] font-semibold text-ink transition-[transform,background-color] hover:bg-white active:scale-[0.98] disabled:opacity-50";

const holdLabel = (count: number, busy: boolean) => (busy ? "Holding" : count === 1 ? "Hold this slot" : `Hold these ${count} slots`);

/** Before holding: the picked slots with their live estimates. One click then holds them and fixes the exact price. */
function SelectionCard(props: {
  selectedSlots: Slot[];
  estimates: Map<Id<"slots">, number>;
  busy: boolean;
  onHold: () => void;
  onClear: () => void;
}) {
  const { selectedSlots } = props;
  const estimated = selectedSlots.map((s) => props.estimates.get(s._id));
  // Summed from the whole-dollar estimates as shown, so the total matches the rows above it.
  const estimatedTotal = estimated.every((e) => e !== undefined)
    ? estimated.reduce<number>((sum, e) => sum + Math.round((e ?? 0) / 100) * 100, 0)
    : null;
  const count = selectedSlots.length;

  return (
    <section aria-label="Your selection" className="flex flex-col gap-4 rounded-2xl bg-panel p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-[17px] font-semibold">Your selection</h2>
        {count > 0 && (
          <button type="button" onClick={props.onClear} className="min-h-8 text-sm text-muted underline-offset-[3px] hover:text-fg hover:underline">
            Clear
          </button>
        )}
      </div>
      {count === 0 ? (
        <p className="text-sm leading-relaxed text-muted">Pick up to {MAX_SLOTS} slots in the grid. Each one shows its live price.</p>
      ) : (
        <>
          <ul className="flex flex-col gap-2 text-sm">
            {selectedSlots.map((s, i) => (
              <li key={s._id} className="flex justify-between gap-3">
                <span className="tabular">{timeRange(s.startAt, s.endAt)}</span>
                {estimated[i] !== undefined && <span className="tabular text-muted">{estimateLabel(estimated[i])}</span>}
              </li>
            ))}
          </ul>
          {estimatedTotal !== null && (
            <div className="flex flex-wrap items-baseline justify-between gap-3 border-t border-line pt-3.5">
              <span className="text-sm text-muted">Estimated total</span>
              <span className="tabular text-[28px] font-medium tracking-tight">{estimateLabel(estimatedTotal)}</span>
            </div>
          )}
          <button type="button" onClick={props.onHold} disabled={props.busy} className={PRIMARY_BUTTON}>
            {holdLabel(count, props.busy)}
          </button>
          <p className="text-[13px] leading-relaxed text-faint">
            Holding is free for {HOLD_TTL_MS / 60_000} minutes and keeps the slots for you only. You see the exact price next; nothing is
            charged until you pay.
          </p>
        </>
      )}
    </section>
  );
}

function HeldSlots({ hold, quote, slots }: { hold: Hold; quote: Quote | null; slots: Slot[] }) {
  const ordered = [...slots].sort((a, b) => a.startAt - b.startAt);
  const priceOf = new Map(quote?.priceBreakdown.map((p) => [p.slotId, p.screenMinor]) ?? []);
  const accountLine = quote?.pricingBasis.find((l) => l.startsWith("Price for your account"));
  return (
    <section className="flex flex-col gap-3.5 rounded-2xl bg-panel p-5">
      <h2 className="text-[17px] font-semibold">Held slots</h2>
      <ul className="flex flex-col text-sm">
        {ordered.map((s) => (
          <li key={s._id} className="flex flex-wrap items-baseline justify-between gap-3 border-t border-line py-2.5">
            <span>
              {dayLabel(s.startAt)}, <span className="tabular">{timeRange(s.startAt, s.endAt)}</span>
            </span>
            {priceOf.has(s._id) && <span className="tabular">{money(priceOf.get(s._id) ?? 0)}</span>}
          </li>
        ))}
        <li className="flex items-baseline justify-between gap-3 border-t border-line pt-3">
          <span className="text-muted">Total</span>
          <span className="tabular text-[17px] font-medium">{money(hold.amountMinor)}</span>
        </li>
      </ul>
      {accountLine && <p className="text-[13px] text-muted">{accountLine}</p>}
      <p className="text-[13px] text-faint">This is your exact price, locked while the hold lasts.</p>
      {quote && (
        <details className="border-t border-line pt-3.5">
          <summary className="cursor-pointer text-sm font-medium">Why this price</summary>
          <PriceBreakdown quote={quote} />
        </details>
      )}
    </section>
  );
}

function ExpiredCard({ onStartOver }: { onStartOver: () => void }) {
  return (
    <section className="flex flex-col gap-3 rounded-2xl bg-panel p-5">
      <p className="text-sm leading-relaxed text-muted">Pick slots again to get a fresh quote.</p>
      <p className="text-[13px] leading-relaxed text-faint">
        Already paid? A payment that lands after the hold ends is never booked automatically. The operator reviews it, then holds equivalent
        slots for you or refunds it.
      </p>
      <button
        type="button"
        onClick={onStartOver}
        className="min-h-11 self-start rounded-full border border-line px-4 text-sm font-medium hover:border-muted"
      >
        Start over
      </button>
    </section>
  );
}

/** What the buyer is told about a payment the system recorded but would not book. */
function flagCopy(kind: PaymentException["kind"]): { title: string; body: string; next: string[] } {
  switch (kind) {
    case "payment_after_hold_expired":
      return {
        title: "We received your payment, but your hold had run out",
        body: "The slots may have gone back on sale, so we didn't book them automatically. Your payment is recorded.",
        next: [
          "An operator reviews this in their finance queue.",
          "If the same or equivalent slots are free, they hold them for you again.",
          "If not, you get a full refund.",
        ],
      };
    case "amount_mismatch":
      return {
        title: "Your payment didn't match the price",
        body: "The amount differs from your quote, so we didn't book the slots. Your payment is recorded.",
        next: ["An operator reviews this in their finance queue.", "They either collect the difference or refund your payment."],
      };
    case "asset_mismatch":
      return {
        title: "Your payment was in a currency we don't accept",
        body: "This quote is paid in USDC or US dollars, so we didn't book the slots. Your payment is recorded.",
        next: ["An operator reviews this in their finance queue.", "They refund the payment or convert it under their policy."],
      };
    case "duplicate_payment":
      return {
        title: "We received a second payment for these slots",
        body: "Your slots were already booked by an earlier payment.",
        next: ["An operator reviews this and refunds the extra payment."],
      };
    default:
      return {
        title: "Your payment needs a review",
        body: "We didn't book the slots automatically. Your payment is recorded.",
        next: ["An operator reviews this in their finance queue and follows up."],
      };
  }
}

/** One line describing how a booked payment was made. */
function paymentLabel(payment: ReceiptPayment): string {
  if (payment.provider === "x402") {
    return `${(payment.amountMinor / 100).toFixed(2)} USDC${payment.network ? ` on ${networkName(payment.network)}` : ""}`;
  }
  if (payment.provider === "manual") return "Simulated manual payment, recorded by the operator";
  return `Bank payment of ${money(payment.amountMinor)}`;
}

function TransactionLink({ payment }: { payment: ReceiptPayment }) {
  const url = explorerTxUrl(payment.network ?? undefined, payment.externalRef);
  return (
    <span className="flex flex-wrap gap-x-3 gap-y-1">
      <span className="font-mono break-all">{payment.externalRef}</span>
      {url && (
        <a href={url} target="_blank" rel="noreferrer">
          View on BaseScan
        </a>
      )}
    </span>
  );
}

function FlaggedCard(props: { payment: ReceiptPayment; exception: PaymentException; traceId: string; onStartOver: () => void }) {
  const { payment, exception } = props;
  const copy = flagCopy(exception.kind);
  return (
    <section className="flex flex-col gap-5 rounded-2xl bg-panel p-[22px]">
      <div className="flex items-start gap-3">
        <Mark mark="problem" />
        <div className="flex min-w-0 flex-col gap-1.5">
          <h2 className="text-[17px] leading-snug font-semibold">{copy.title}</h2>
          <p className="text-sm leading-relaxed text-muted">{copy.body}</p>
        </div>
      </div>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-5 gap-y-2.5 border-t border-line pt-4 text-[13px]">
        <dt className="text-muted">Received</dt>
        <dd className="tabular">{money(payment.amountMinor)}</dd>
        <dt className="text-muted">Payment</dt>
        <dd>{payment.provider === "x402" ? <TransactionLink payment={payment} /> : paymentLabel(payment)}</dd>
        <dt className="text-muted">Status</dt>
        <dd>{exception.status === "resolved" ? "Resolved by the operator" : "Under review"}</dd>
        <dt className="text-muted">Reference</dt>
        <dd className="font-mono break-all">{props.traceId}</dd>
      </dl>
      <div className="flex flex-col gap-2 border-t border-line pt-4">
        <h3 className="text-sm font-semibold">What happens next</h3>
        <ol className="list-decimal pl-5 text-sm leading-relaxed text-muted">
          {copy.next.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ol>
      </div>
      <p className="text-[13px] leading-relaxed text-faint">You don't need to do anything. Keep the reference if you contact the operator.</p>
      <button
        type="button"
        onClick={props.onStartOver}
        className="min-h-11 self-start rounded-full border border-line px-4 text-sm font-medium hover:border-muted"
      >
        Back to slots
      </button>
    </section>
  );
}

function BookedView(props: {
  billboard: Billboard;
  campaign: Campaign;
  hold: Hold;
  slots: Slot[];
  invoice: TermsBooking | null;
  payments: ReceiptPayment[] | undefined;
  onBookMore: () => void;
}) {
  const { billboard, hold, invoice } = props;
  const slots = [...props.slots].sort((a, b) => a.startAt - b.startAt);
  const first = slots[0];
  const last = slots[slots.length - 1];
  const bookingIds = [...new Set(slots.flatMap((s) => (s.bookingId ? [s.bookingId] : [])))];
  if (bookingIds.length === 0 && invoice) bookingIds.push(invoice.bookingId);
  const payment = props.payments?.find((p) => p.bookingId !== null) ?? null;
  const duplicate = props.payments?.some((p) => p.exception?.kind === "duplicate_payment") ?? false;

  return (
    <div className="flex flex-col gap-7">
      <header className="flex items-start gap-4">
        <span className="flex size-11 flex-none items-center justify-center rounded-full border border-ok/40 bg-ok/15">
          <CheckIcon size={22} weight="bold" className="text-ok" />
        </span>
        <div className="flex min-w-0 flex-col gap-1.5">
          <h1 className="text-2xl font-semibold tracking-tight">You're booked on {billboard.name}</h1>
          {first && last && (
            <p className="text-[15px] text-muted">
              {dayLabel(first.startAt)} · {timeRange(first.startAt, last.endAt)} · {slots.length} {slots.length === 1 ? "slot" : "slots"}
            </p>
          )}
        </div>
      </header>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_400px]">
        <section aria-label="Receipt" className="flex min-w-0 flex-col gap-4 rounded-2xl bg-panel p-[22px]">
          <h2 className="text-[17px] font-semibold">Receipt</h2>
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-5 gap-y-3 text-sm">
            <dt className="text-muted">Booking</dt>
            <dd className="font-mono break-all">{bookingIds.join(", ") || "Recording"}</dd>
            <dt className="text-muted">Slots</dt>
            <dd className="tabular">{slots.map((s) => timeOfDay(s.startAt)).join(", ")}</dd>
            <dt className="text-muted">Amount</dt>
            <dd className="tabular">{money(hold.amountMinor)}</dd>
            <dt className="text-muted">Payment</dt>
            <dd>
              {invoice
                ? `Invoice ${invoice.invoiceNumber}, due ${shortDate(invoice.dueAt)}`
                : payment
                  ? paymentLabel(payment)
                  : props.payments === undefined
                    ? "Loading"
                    : "Booked on account terms"}
            </dd>
            {payment?.provider === "x402" && (
              <>
                <dt className="text-muted">Transaction</dt>
                <dd>
                  <TransactionLink payment={payment} />
                </dd>
              </>
            )}
            <dt className="text-muted">Reference</dt>
            <dd className="font-mono break-all">{hold.traceId}</dd>
          </dl>
          {duplicate && (
            <p className="text-sm text-danger">We also received a second payment for these slots. The operator will refund it.</p>
          )}
          <p className="border-t border-line pt-3.5 text-[13px] leading-relaxed text-faint">
            Quote the reference if you contact the operator about this booking.
          </p>
        </section>
        <AdProgress campaign={props.campaign} slots={slots} />
      </div>

      <div className="flex flex-wrap gap-3">
        <a
          href={`#/player/${billboard._id}`}
          target="_blank"
          rel="noreferrer"
          className="inline-flex min-h-11 items-center rounded-full bg-fg px-5 text-[15px] font-semibold text-ink hover:bg-white"
        >
          Watch the screen
        </a>
        <button type="button" onClick={props.onBookMore} className="min-h-11 rounded-full border border-line px-5 text-[15px] font-medium hover:border-muted">
          Book more time
        </button>
      </div>
    </div>
  );
}

/** Where the campaign's ad is on its way to the screen. */
function AdProgress({ campaign, slots }: { campaign: Campaign; slots: Slot[] }) {
  const status = campaign.creativeStatus;
  const scheduled = slots.some((s) => s.state === "scheduled" || s.state === "played");
  const played = slots.length > 0 && slots.every((s) => s.state === "played");
  const steps: { label: string; detail: string; mark: MarkKind }[] = [
    {
      label: "Uploaded",
      detail: status === "none" ? "Upload an image or video below." : "Your ad is in.",
      mark: status === "none" ? "active" : "done",
    },
    {
      label: status === "rejected" ? "Turned down" : "Operator review",
      detail:
        status === "rejected"
          ? (campaign.creativeReviewReason ?? "Upload a new version below.")
          : "The operator checks every ad before it plays.",
      mark: status === "approved" ? "done" : status === "pending_review" ? "active" : status === "rejected" ? "problem" : "todo",
    },
    { label: "Scheduled", detail: "Happens automatically after approval.", mark: scheduled ? "done" : "todo" },
    {
      label: "Plays on screen",
      detail: slots.map((s) => timeOfDay(s.startAt)).join(", "),
      mark: played ? "done" : scheduled ? "active" : "todo",
    },
  ];

  return (
    <section aria-label="Your ad" className="flex min-w-0 flex-col gap-4 rounded-2xl bg-panel p-[22px]">
      <h2 className="text-[17px] font-semibold">Your ad</h2>
      <ol className="flex flex-col">
        {steps.map((s) => (
          <li key={s.label} className="flex gap-3 border-t border-line py-3">
            <Mark mark={s.mark} />
            <div className="flex min-w-0 flex-col gap-0.5">
              <span className={`text-sm font-medium ${s.mark === "todo" ? "text-faint" : "text-fg"}`}>{s.label}</span>
              <span className={`text-[13px] ${s.mark === "todo" ? "text-faint" : "text-muted"}`}>{s.detail}</span>
            </div>
          </li>
        ))}
      </ol>
      {status !== "approved" && <CreativeUploadField campaign={campaign} />}
    </section>
  );
}

const CREATIVE_CHIP: Record<Campaign["creativeStatus"], { label: string; className: string }> = {
  none: { label: "Not uploaded", className: "border-line text-muted" },
  pending_review: { label: "Waiting for review", className: "border-info/40 text-info" },
  approved: { label: "Approved", className: "border-ok/40 text-ok" },
  rejected: { label: "Turned down", className: "border-danger/40 text-danger" },
};

function CreativeCard({ campaign }: { campaign: Campaign }) {
  const chip = CREATIVE_CHIP[campaign.creativeStatus];
  return (
    <section aria-label="Your ad" className="flex flex-col gap-4 rounded-2xl bg-panel p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-[17px] font-semibold">Your ad</h2>
        <span className={`rounded-full border px-2.5 py-1 text-xs font-medium ${chip.className}`}>{chip.label}</span>
      </div>
      {campaign.creativeStatus === "rejected" && campaign.creativeReviewReason && (
        <p className="text-sm text-muted">Operator's note: {campaign.creativeReviewReason}</p>
      )}
      {campaign.creativeStatus === "approved" ? (
        <p className="text-[13px] text-muted">Approved ads are locked, so this one can't be replaced.</p>
      ) : (
        <CreativeUploadField campaign={campaign} />
      )}
      <p className="text-[13px] leading-relaxed text-muted">
        The operator checks every ad before it can play. You can pay first. Once the ad is approved, booked slots are scheduled
        automatically.
      </p>
    </section>
  );
}

function CreativeUploadField({ campaign }: { campaign: Campaign }) {
  const generateUploadUrl = useMutation(api.creatives.generateUploadUrl);
  const attach = useMutation(api.creatives.attach);
  const [status, setStatus] = useState<string | null>(null);

  async function upload(file: File) {
    if (!file.type.startsWith("image/") && !file.type.startsWith("video/")) {
      setStatus("Use an image or video file.");
      return;
    }
    setStatus("Uploading");
    try {
      const url = await generateUploadUrl();
      const res = await fetch(url, { method: "POST", headers: { "Content-Type": file.type }, body: file });
      if (!res.ok) throw new Error(`Upload failed (${res.status})`);
      const { storageId } = (await res.json()) as { storageId: Id<"_storage"> };
      await attach({ campaignId: campaign._id, storageId, contentType: file.type });
      setStatus("Uploaded. The operator reviews it before it can play.");
    } catch (err) {
      setStatus(errorMessage(err));
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <label className="flex flex-col gap-2 text-[13px]">
        <span className="text-muted">{campaign.creativeStatus === "none" ? "Upload an image or video" : "Replace with another image or video"}</span>
        <input
          type="file"
          accept="image/*,video/*"
          onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])}
          className="min-h-11 rounded-lg border border-line bg-ink px-3 py-2 text-fg file:mr-3 file:rounded file:border-0 file:bg-raised file:px-3 file:py-1 file:text-fg"
        />
      </label>
      {status && <p role="status" className="text-sm text-muted">{status}</p>}
    </div>
  );
}

const STAGE_LABEL: Record<Quote["priceBreakdown"][number]["stages"][number]["key"], string> = {
  crowd: "Crowd",
  time: "Time of day",
  event: "Nearby event",
  scarcity: "Scarcity",
  market: "Recent sales",
};

/** Screen-price stages per slot. The account price (if any) is a single line above; its reasoning stays with the operator. */
function PriceBreakdown({ quote }: { quote: Quote }) {
  return (
    <div className="mt-3 flex flex-col gap-4">
      {quote.priceBreakdown.map((slot) => (
        <div key={slot.slotId}>
          <div className="flex items-baseline justify-between text-sm">
            <span className="font-medium">Slot at {timeOfDay(slot.slotStartAt)}</span>
            <span className="tabular">{money(slot.screenMinor)}</span>
          </div>
          <ul className="mt-2 flex flex-col gap-1.5 text-[13px]">
            {slot.stages.map((st) => (
              <li key={st.key} className="grid grid-cols-[96px_56px_minmax(0,1fr)] gap-2">
                <span className="text-muted">{STAGE_LABEL[st.key]}</span>
                <span className={`tabular ${st.effective === 1 ? "text-faint" : "text-fg"}`}>x{st.effective.toFixed(2)}</span>
                <span className={st.effective === 1 ? "text-faint" : "text-muted"}>{st.explanation}</span>
              </li>
            ))}
          </ul>
          {(slot.floorApplied || slot.ceilingApplied) && (
            <p className="mt-1 text-xs text-faint">{slot.floorApplied ? "Raised to the screen's price floor." : "Capped at the screen's price ceiling."}</p>
          )}
        </div>
      ))}
    </div>
  );
}
