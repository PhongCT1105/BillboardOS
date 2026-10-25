import { useState } from "react";
import type { FunctionReturnType } from "convex/server";
import type { Id } from "../../convex/_generated/dataModel";
import { api } from "../../convex/_generated/api";
import { money, timeOfDay, timeRange } from "../lib/format";

type Outlook = FunctionReturnType<typeof api.autopilot.outlook>;
type Slot = Outlook["slots"][number];
type Zone = "past" | "now" | "future";

const zoneOf = (s: Slot, now: number): Zone => (s.endAt <= now ? "past" : s.startAt <= now ? "now" : "future");

const PAST_LABEL: Record<NonNullable<Slot["outcome"]>, string> = {
  played: "Played",
  failed: "Failed",
  unsold: "Unsold",
  sold: "Sold",
};

/** What a future slot is doing right now, in a few words. */
function futureStatus(s: Slot, now: number): { text: string; tone: "sold" | "held" | "offer" | "auction" | "open" } {
  if (s.state === "booked" || s.state === "scheduled") return { text: s.bookedBy ? `Booked · ${s.bookedBy}` : "Booked", tone: "sold" };
  if (s.state === "held") return { text: s.bookedBy ? `Paying · ${s.bookedBy}` : "Held, paying", tone: "held" };
  if (s.inAuction) return { text: "Auction", tone: "auction" };
  if (s.firstLookUntil !== null && s.firstLookUntil > now) return { text: "Agents deciding", tone: "auction" };
  if (s.offerStatus === "open") return { text: s.offeredTo > 0 ? `Offered to ${s.offeredTo}` : "Published", tone: "offer" };
  if (s.startAt - now < 15 * 60_000) return { text: "Live auction", tone: "offer" };
  return { text: "Open", tone: "open" };
}

const FUTURE_STYLE = {
  sold: "border-fg/70 bg-fg/85 text-ink",
  held: "border-accent stripes text-fg",
  offer: "border-line bg-panel text-fg hover:border-muted",
  auction: "border-accent bg-accent/15 text-fg",
  open: "border-line bg-panel text-fg hover:border-muted",
} as const;

/**
 * Host slot board: past (greyed, what happened), now (highlighted, with
 * progress through the slot) and the next 12 hours (price, forecast people,
 * and what the autopilot is doing with it, or who booked it).
 */
export function SlotBoard({ outlook, now }: { outlook: Outlook | undefined; now: number }) {
  const [selectedId, setSelectedId] = useState<Id<"slots"> | null>(null);
  const slots = outlook?.slots;
  const selected = slots?.find((s) => s.slotId === selectedId) ?? null;

  return (
    <section aria-labelledby="slots-heading">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <h2 id="slots-heading" className="text-lg font-semibold">
            Slots: earlier, now, next 12 hours
          </h2>
          <p className="mt-1 text-sm text-muted">The seller agent prices and offers every future slot; the live auction sells the current one when the camera sees people.</p>
        </div>
        <Legend />
      </div>

      {slots === undefined ? (
        <div className="mt-4 grid grid-cols-3 gap-1.5 sm:grid-cols-6 lg:grid-cols-8">
          {Array.from({ length: 32 }, (_, i) => (
            <div key={i} className="h-[68px] animate-pulse rounded bg-panel" />
          ))}
        </div>
      ) : slots.length === 0 ? (
        <p className="mt-4 text-muted">No slots in this window. The inventory cron tops them up every 15 minutes.</p>
      ) : (
        <div className="mt-4 grid grid-cols-3 gap-1.5 sm:grid-cols-6 lg:grid-cols-8">
          {slots.map((slot) => {
            const zone = zoneOf(slot, now);
            if (zone === "past") return <PastTile key={slot.slotId} slot={slot} />;
            if (zone === "now") return <NowTile key={slot.slotId} slot={slot} now={now} selected={slot.slotId === selectedId} onSelect={() => setSelectedId(slot.slotId === selectedId ? null : slot.slotId)} />;
            const st = futureStatus(slot, now);
            return (
              <button
                key={slot.slotId}
                type="button"
                onClick={() => setSelectedId(slot.slotId === selectedId ? null : slot.slotId)}
                aria-pressed={slot.slotId === selectedId}
                aria-label={`${timeRange(slot.startAt, slot.endAt)}, ${st.text}`}
                className={`flex h-[68px] flex-col justify-between rounded border px-2 py-1.5 text-left transition-transform active:scale-[0.97] ${FUTURE_STYLE[st.tone]} ${
                  slot.slotId === selectedId ? "ring-2 ring-fg ring-offset-2 ring-offset-ink" : ""
                }`}
              >
                <span className="flex items-baseline justify-between gap-1">
                  <span className={`tabular font-mono text-[11px] ${st.tone === "sold" ? "" : "text-muted"}`}>{timeOfDay(slot.startAt)}</span>
                  {slot.priceMinor !== null && st.tone !== "sold" && st.tone !== "held" && <span className="tabular font-mono text-[11px]">{money(slot.priceMinor)}</span>}
                </span>
                <span className="truncate text-[11px] font-medium">{st.text}</span>
                <span className={`text-[10px] ${st.tone === "sold" ? "text-ink/70" : "text-faint"}`}>
                  {slot.expectedPeople !== null ? `~${Math.round(slot.expectedPeople)} ${Math.round(slot.expectedPeople) === 1 ? "person" : "people"}` : " "}
                </span>
              </button>
            );
          })}
        </div>
      )}

      {selected && zoneOf(selected, now) !== "past" && <SlotDetail slot={selected} now={now} onClose={() => setSelectedId(null)} />}
    </section>
  );
}

function PastTile({ slot }: { slot: Slot }) {
  const label = PAST_LABEL[slot.outcome ?? "unsold"];
  return (
    <div
      aria-label={`${timeRange(slot.startAt, slot.endAt)}, ${label}`}
      className={`flex h-[68px] flex-col justify-between rounded border border-line/60 bg-ink px-2 py-1.5 opacity-60 ${slot.outcome === "failed" ? "border-danger/50" : ""}`}
    >
      <span className="tabular font-mono text-[11px] text-faint line-through">{timeOfDay(slot.startAt)}</span>
      <span className={`text-[11px] ${slot.outcome === "failed" ? "text-danger" : slot.outcome === "played" ? "text-muted" : "text-faint"}`}>{label}</span>
      <span className="truncate text-[10px] text-faint">{slot.bookedBy ?? " "}</span>
    </div>
  );
}

function NowTile(props: { slot: Slot; now: number; selected: boolean; onSelect: () => void }) {
  const { slot, now } = props;
  const progress = Math.min(1, Math.max(0, (now - slot.startAt) / (slot.endAt - slot.startAt)));
  const minutesLeft = Math.max(0, Math.ceil((slot.endAt - now) / 60_000));
  const sold = slot.state === "booked" || slot.state === "scheduled" || slot.state === "played";
  return (
    <button
      type="button"
      onClick={props.onSelect}
      aria-pressed={props.selected}
      aria-label={`Now: ${timeRange(slot.startAt, slot.endAt)}, ${minutesLeft} minutes left`}
      className={`relative flex h-[68px] flex-col justify-between overflow-hidden rounded border-2 border-accent bg-accent/10 px-2 py-1.5 text-left ${props.selected ? "ring-2 ring-fg ring-offset-2 ring-offset-ink" : ""}`}
    >
      <span className="flex items-baseline justify-between gap-1">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-accent">Now</span>
        <span className="tabular font-mono text-[11px] text-muted">{minutesLeft} min left</span>
      </span>
      <span className="truncate text-[11px] font-medium text-fg">
        {sold ? (slot.bookedBy ? `Playing · ${slot.bookedBy}` : "Playing") : slot.state === "held" ? "Winner paying" : "Live auction sells it"}
      </span>
      <span className="absolute inset-x-0 bottom-0 h-1 bg-line" aria-hidden>
        <span className="block h-full bg-accent transition-[width] duration-1000" style={{ width: `${Math.round(progress * 100)}%` }} />
      </span>
    </button>
  );
}

function SlotDetail({ slot, now, onClose }: { slot: Slot; now: number; onClose: () => void }) {
  const zone = zoneOf(slot, now);
  const st = zone === "future" ? futureStatus(slot, now) : null;
  return (
    <div className="fade-in mt-4 flex flex-col gap-3 rounded-lg border border-line bg-panel p-4 sm:flex-row sm:items-start sm:justify-between">
      <div className="flex flex-col gap-1">
        <p className="font-medium">
          {timeRange(slot.startAt, slot.endAt)} {zone === "now" ? <span className="text-accent">· on air now</span> : st ? <span className="text-muted">· {st.text}</span> : null}
        </p>
        <p className="text-sm text-muted">
          {slot.priceMinor !== null ? `Price ${money(slot.priceMinor)}` : "No price published"}
          {slot.expectedPeople !== null ? ` · forecast ~${Math.round(slot.expectedPeople)} people in view` : ""}
          {slot.confidence !== null ? ` · ${Math.round(slot.confidence * 100)}% confidence` : ""}
          {slot.band ? ` · ${slot.band === "ahead" ? "selling ahead (decays toward the floor)" : "early-booking price"}` : ""}
        </p>
        {slot.reasoning && <p className="max-w-[90ch] text-sm text-faint">{slot.reasoning}</p>}
        {zone === "now" && <p className="text-sm text-faint">The current spot is the live auction's: it announces to company agents when the camera sees people.</p>}
      </div>
      <button type="button" onClick={onClose} className="self-start rounded-md border border-line px-4 py-2 text-sm text-muted hover:text-fg">
        Close
      </button>
    </div>
  );
}

function Legend() {
  const items: { label: string; cls: string }[] = [
    { label: "Past", cls: "border border-line/60 bg-ink opacity-60" },
    { label: "Now", cls: "border-2 border-accent bg-accent/10" },
    { label: "Offered", cls: "border border-line bg-panel" },
    { label: "Auction / deciding", cls: "border border-accent bg-accent/15" },
    { label: "Held, paying", cls: "border border-accent stripes" },
    { label: "Booked", cls: "border border-fg/70 bg-fg/85" },
  ];
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
      {items.map((i) => (
        <li key={i.label} className="flex items-center gap-1.5">
          <span className={`inline-block h-3 w-4 rounded-sm ${i.cls}`} aria-hidden />
          {i.label}
        </li>
      ))}
    </ul>
  );
}
