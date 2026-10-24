import { useMemo, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { countdown, errorMessage, money, timeOfDay } from "../lib/format";
import { useNow } from "../lib/hooks";
import { BidPanel } from "../auctions/BidPanel";

type Quote = FunctionReturnType<typeof api.quotes.create>;
type Hold = FunctionReturnType<typeof api.holds.create>;

const QUARTER_HOUR = 15 * 60 * 1000;
const MAX_SLOTS = 4;

export function BookPage() {
  const campaigns = useQuery(api.campaigns.list, {});
  const billboards = useQuery(api.billboards.list);
  const [campaignId, setCampaignId] = useState<Id<"campaigns"> | null>(null);
  const activeCampaign = campaigns?.find((c) => c._id === campaignId) ?? campaigns?.[0];
  const billboard = billboards?.[0];

  if (campaigns === undefined || billboards === undefined) {
    return <main className="mx-auto max-w-[1100px] px-4 pt-8 md:px-6"><div className="h-64 animate-pulse rounded bg-panel" /></main>;
  }
  if (!activeCampaign || !billboard) {
    return (
      <main className="mx-auto max-w-[1100px] px-4 py-16 md:px-6">
        <p className="text-muted">No campaigns or billboards yet. Run <code className="font-mono text-fg">npm run seed</code>.</p>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-[1200px] px-4 pt-8 pb-16 md:px-6">
      <h1 className="text-2xl font-semibold tracking-tight">Book {billboard.name}</h1>
      <p className="mt-1 text-sm text-muted">Pick up to four 15-minute slots. Prices move with live foot traffic.</p>
      <label className="mt-6 flex max-w-sm flex-col gap-2 text-sm">
        <span className="text-muted">Campaign</span>
        <select
          className="rounded-md border border-line bg-panel px-3 py-2 text-fg"
          value={activeCampaign._id}
          onChange={(e) => setCampaignId(e.target.value as Id<"campaigns">)}
        >
          {campaigns.map((c) => (
            <option key={c._id} value={c._id}>
              {c.advertiserName}: {c.brief.slice(0, 48)}
            </option>
          ))}
        </select>
      </label>
      <BookingFlow
        key={activeCampaign._id}
        campaignId={activeCampaign._id}
        billboardId={billboard._id}
        aside={<CreativeUpload campaign={activeCampaign} />}
      />
    </main>
  );
}

function BookingFlow(props: { campaignId: Id<"campaigns">; billboardId: Id<"billboards">; aside: React.ReactNode }) {
  const minuteNow = useNow(60_000);
  const from = Math.floor(minuteNow / QUARTER_HOUR) * QUARTER_HOUR;
  const slots = useQuery(api.slots.listForBillboard, {
    billboardId: props.billboardId,
    from,
    to: from + 12 * 60 * 60 * 1000,
  });
  const createQuote = useMutation(api.quotes.create);
  const createHold = useMutation(api.holds.create);
  const releaseHold = useMutation(api.holds.release);

  const auctions = useQuery(api.auctions.live, { billboardId: props.billboardId });
  const auctionSlotIds = useMemo(
    () => new Set((auctions ?? []).filter((a) => a.status === "open").flatMap((a) => a.slots.map((s) => s.slotId))),
    [auctions],
  );
  const [auctionSlot, setAuctionSlot] = useState<Id<"slots"> | null>(null);
  const [selected, setSelected] = useState<Id<"slots">[]>([]);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [hold, setHold] = useState<Hold | null>(null);
  const [holdKey, setHoldKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const now = useNow(1000);

  const available = useMemo(() => (slots ?? []).filter((s) => s.state === "available" && s.startAt > minuteNow), [slots, minuteNow]);

  function toggle(id: Id<"slots">) {
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

  const getQuote = () =>
    run(async () => setQuote(await createQuote({ campaignId: props.campaignId, slotIds: selected, actor: "buyer:web" })));

  const placeHold = () =>
    run(async () => {
      if (!quote) return;
      const key = crypto.randomUUID();
      setHold(await createHold({ quoteId: quote.quoteId, idempotencyKey: key, actor: "buyer:web" }));
      setHoldKey(key);
    });

  const cancelHold = () =>
    run(async () => {
      if (!hold || !holdKey) return;
      await releaseHold({ holdId: hold.holdId, idempotencyKey: holdKey });
      setHold(null);
      setQuote(null);
      setSelected([]);
    });

  const holdPanel = hold && (
    <section className="fade-in rounded-lg border border-accent/60 bg-panel p-5">
      <h2 className="text-lg font-semibold">{now >= hold.expiresAt ? "Hold expired" : "Slots held for you"}</h2>
      <p className="mt-1 text-sm text-muted">
        {now >= hold.expiresAt
          ? "The slots went back on sale. Get a fresh quote to try again."
          : "Nobody else can buy these slots until the hold runs out."}
      </p>
      <div className="mt-4 flex flex-wrap items-end gap-8">
        <Stat label="Total" value={money(hold.amountMinor)} />
        <Stat label="Hold expires in" value={countdown(hold.expiresAt, now)} />
      </div>
      <div className="mt-5 flex flex-wrap gap-2">
        <button type="button" disabled className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-ink opacity-50" title="x402 checkout lands in build step 3">
          Pay with x402
        </button>
        {now < hold.expiresAt ? (
          <button type="button" onClick={cancelHold} disabled={busy} className="rounded-md border border-line px-4 py-2 text-sm text-muted hover:text-fg">
            Release hold
          </button>
        ) : (
          <button type="button" onClick={() => { setHold(null); setQuote(null); setSelected([]); }} className="rounded-md border border-line px-4 py-2 text-sm text-muted hover:text-fg">
            Start over
          </button>
        )}
      </div>
      <p className="mt-3 text-xs text-faint">
        Agent checkout over x402 is not wired yet. Until then the operator can record a simulated manual payment from the console.
      </p>
    </section>
  );

  const quotePanel = !hold && quote && (
    <section className="fade-in rounded-lg border border-line bg-panel p-5">
      <div className="flex flex-wrap items-end gap-8">
        <Stat label="Quoted price" value={money(quote.amountMinor)} />
        <Stat label="Valid for" value={countdown(quote.expiresAt, now)} />
        <Stat label="Confidence" value={quote.confidence} />
      </div>
      <PriceBreakdown quote={quote} />
      <button
        type="button"
        onClick={placeHold}
        disabled={busy || now >= quote.expiresAt}
        className="mt-4 rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-ink active:scale-[0.98] disabled:opacity-50"
      >
        Hold these slots
      </button>
    </section>
  );

  return (
    <div className="mt-8 grid grid-cols-1 gap-10 lg:grid-cols-[minmax(0,1fr)_380px]">
      <section className="flex flex-col gap-5" aria-label="Available slots">
        {slots === undefined ? (
          <div className="h-40 animate-pulse rounded bg-panel" />
        ) : available.length === 0 ? (
          <p className="text-muted">Every slot in the next 12 hours is taken.</p>
        ) : (
          <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
            {available.map((s) => {
              const on = selected.includes(s._id) || auctionSlot === s._id;
              const hot = auctionSlotIds.has(s._id);
              return (
                <button
                  key={s._id}
                  type="button"
                  onClick={() => toggle(s._id)}
                  aria-pressed={on}
                  disabled={!!hold}
                  className={`rounded-md border px-2 py-2 text-left text-sm transition-transform active:scale-[0.97] disabled:opacity-50 ${
                    on ? "border-accent bg-accent/15" : "border-line bg-panel hover:border-muted"
                  }`}
                >
                  <span className="tabular font-mono">{timeOfDay(s.startAt)}</span>
                  {hot && <span className="mt-0.5 block text-[11px] font-medium text-accent">Auction</span>}
                </button>
              );
            })}
          </div>
        )}
      </section>

      <aside className="flex flex-col gap-6 lg:sticky lg:top-6 lg:self-start">
        {auctionSlot && !hold && <BidPanel slotId={auctionSlot} campaignId={props.campaignId} />}
        {!hold && !auctionSlot && (
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={getQuote}
              disabled={busy || selected.length === 0}
              className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-ink transition-transform active:scale-[0.98] disabled:opacity-50"
            >
              Get quote
            </button>
            <span className="text-sm text-muted">
              {selected.length === 0 ? "Select at least one slot" : `${selected.length} of ${MAX_SLOTS} selected`}
            </span>
          </div>
        )}
        {error && <p role="alert" className="text-sm text-danger">{error}</p>}
        {holdPanel}
        {quotePanel}
        {props.aside}
      </aside>
    </div>
  );
}

type CampaignRow = FunctionReturnType<typeof api.campaigns.list>[number];

function CreativeUpload({ campaign }: { campaign: CampaignRow }) {
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
    <div className="flex flex-col gap-3 border-t border-line pt-6">
      <h2 className="text-lg font-semibold">Creative</h2>
      <p className="text-sm text-muted">
        Status: <span className="text-fg">{campaign.creativeStatus?.replaceAll("_", " ") ?? "none uploaded"}</span>
      </p>
      <label className="flex flex-col gap-2 text-sm">
        <span className="text-muted">Upload an image or video</span>
        <input
          type="file"
          accept="image/*,video/*"
          onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])}
          className="rounded-md border border-line bg-panel px-3 py-2 text-fg file:mr-3 file:rounded file:border-0 file:bg-raised file:px-3 file:py-1 file:text-fg"
        />
      </label>
      {status && <p role="status" className="text-sm text-muted">{status}</p>}
    </div>
  );
}

function Stat(props: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs text-muted">{props.label}</p>
      <p className="tabular font-mono text-xl">{props.value}</p>
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

/** Screen-price stages per slot. The account price (if any) is a single line; its reasoning stays with the operator. */
function PriceBreakdown({ quote }: { quote: Quote }) {
  const accountLine = quote.pricingBasis.find((l) => l.startsWith("Price for your account"));
  return (
    <div className="mt-4 flex flex-col gap-4">
      {quote.priceBreakdown.map((slot) => (
        <div key={slot.slotId} className="border-t border-line pt-3">
          <div className="flex items-baseline justify-between text-sm">
            <span className="font-medium">Slot at {timeOfDay(slot.slotStartAt)}</span>
            <span className="tabular font-mono">{money(slot.screenMinor)}</span>
          </div>
          <ul className="mt-2 flex flex-col gap-1.5 text-sm">
            {slot.stages.map((st) => (
              <li key={st.key} className="grid grid-cols-[96px_56px_minmax(0,1fr)] gap-2">
                <span className="text-muted">{STAGE_LABEL[st.key]}</span>
                <span className={`tabular font-mono ${st.effective === 1 ? "text-faint" : "text-fg"}`}>x{st.effective.toFixed(2)}</span>
                <span className={st.effective === 1 ? "text-faint" : "text-muted"}>{st.explanation}</span>
              </li>
            ))}
          </ul>
          {(slot.floorApplied || slot.ceilingApplied) && (
            <p className="mt-1 text-xs text-faint">{slot.floorApplied ? "Raised to the screen's price floor." : "Capped at the screen's price ceiling."}</p>
          )}
        </div>
      ))}
      {accountLine && <p className="border-t border-line pt-3 text-sm text-fg">{accountLine}</p>}
    </div>
  );
}
