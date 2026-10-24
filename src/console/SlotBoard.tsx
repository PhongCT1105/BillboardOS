import { useState } from "react";
import { useMutation } from "convex/react";
import type { Doc, Id } from "../../convex/_generated/dataModel";
import { api } from "../../convex/_generated/api";
import { errorMessage, timeOfDay, timeRange } from "../lib/format";

type SlotState = Doc<"slots">["state"];

const STATE_STYLE: Record<SlotState, string> = {
  available: "border border-line bg-panel hover:border-muted",
  held: "border border-accent stripes",
  booked: "border border-fg/80 bg-fg/80",
  scheduled: "border border-accent bg-accent",
  played: "border border-line bg-raised",
  failed_delivery: "border border-danger bg-danger/25",
};

/** Time label colors chosen per tile background so the time stays readable. */
const LABEL_STYLE: Record<SlotState, string> = {
  available: "text-muted",
  held: "bg-ink/85 text-fg",
  booked: "text-ink",
  scheduled: "text-accent-ink",
  played: "text-faint",
  failed_delivery: "text-fg",
};

const STATE_LABEL: Record<SlotState, string> = {
  available: "Available",
  held: "Held",
  booked: "Booked",
  scheduled: "Scheduled",
  played: "Played",
  failed_delivery: "Failed delivery",
};

export function SlotBoard({ slots }: { slots: Doc<"slots">[] | undefined }) {
  const [selectedId, setSelectedId] = useState<Id<"slots"> | null>(null);
  const selected = slots?.find((s) => s._id === selectedId) ?? null;

  return (
    <section aria-labelledby="slots-heading">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 id="slots-heading" className="text-lg font-semibold">
          Next 12 hours
        </h2>
        <Legend />
      </div>

      {slots === undefined ? (
        <div className="mt-4 grid grid-cols-8 gap-1.5 sm:grid-cols-12">
          {Array.from({ length: 48 }, (_, i) => (
            <div key={i} className="h-11 animate-pulse rounded bg-panel" />
          ))}
        </div>
      ) : slots.length === 0 ? (
        <p className="mt-4 text-muted">No slots in this window. The inventory cron tops them up every 15 minutes.</p>
      ) : (
        <div className="mt-4 grid grid-cols-8 gap-1.5 sm:grid-cols-12">
          {slots.map((slot) => (
            <button
              key={slot._id}
              type="button"
              onClick={() => setSelectedId(slot._id === selectedId ? null : slot._id)}
              aria-pressed={slot._id === selectedId}
              aria-label={`${timeRange(slot.startAt, slot.endAt)}, ${STATE_LABEL[slot.state]}`}
              className={`relative h-11 rounded text-left transition-transform active:scale-[0.97] ${
                STATE_STYLE[slot.state]
              } ${slot._id === selectedId ? "ring-2 ring-fg ring-offset-2 ring-offset-ink" : ""}`}
            >
              <span className={`absolute bottom-1 left-1.5 rounded-sm px-0.5 font-mono text-[10px] ${LABEL_STYLE[slot.state]}`}>
                {timeOfDay(slot.startAt)}
              </span>
            </button>
          ))}
        </div>
      )}

      {selected && <SlotDetail slot={selected} onClose={() => setSelectedId(null)} />}
    </section>
  );
}

function SlotDetail({ slot, onClose }: { slot: Doc<"slots">; onClose: () => void }) {
  const recordManual = useMutation(api.payments.recordManual);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

  async function markPaid() {
    if (!slot.holdId) return;
    setBusy(true);
    setMessage(null);
    try {
      const result = await recordManual({ holdId: slot.holdId, note: "Operator console" });
      setMessage(
        result.outcome === "booked"
          ? { tone: "ok", text: "Recorded as a simulated manual payment. Slot booked." }
          : result.outcome === "exception"
            ? { tone: "error", text: `Payment opened a finance exception: ${result.kind.replaceAll("_", " ")}.` }
            : { tone: "error", text: result.message },
      );
    } catch (err) {
      setMessage({ tone: "error", text: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fade-in mt-4 flex flex-col gap-3 rounded-lg border border-line bg-panel p-4 sm:flex-row sm:items-center sm:justify-between">
      <div>
        <p className="font-medium">{timeRange(slot.startAt, slot.endAt)}</p>
        <p className="text-sm text-muted">{STATE_LABEL[slot.state]}</p>
        {message && (
          <p role="status" className={`mt-1 text-sm ${message.tone === "ok" ? "text-fg" : "text-danger"}`}>
            {message.text}
          </p>
        )}
      </div>
      <div className="flex gap-2">
        {slot.state === "held" && slot.holdId && (
          <button
            type="button"
            disabled={busy}
            onClick={markPaid}
            className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-ink transition-transform active:scale-[0.98] disabled:opacity-60"
          >
            {busy ? "Recording" : "Record manual payment"}
          </button>
        )}
        <button
          type="button"
          onClick={onClose}
          className="rounded-md border border-line px-4 py-2 text-sm text-muted hover:text-fg"
        >
          Close
        </button>
      </div>
    </div>
  );
}

function Legend() {
  const items: SlotState[] = ["available", "held", "booked", "scheduled", "played", "failed_delivery"];
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
      {items.map((s) => (
        <li key={s} className="flex items-center gap-1.5">
          <span className={`inline-block h-3 w-4 rounded-sm ${STATE_STYLE[s]}`} aria-hidden />
          {STATE_LABEL[s]}
        </li>
      ))}
    </ul>
  );
}
