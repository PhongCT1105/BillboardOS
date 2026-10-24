import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { api } from "../../convex/_generated/api";
import { ago, errorMessage } from "../lib/format";
import { useNow } from "../lib/hooks";

type Row = FunctionReturnType<typeof api.valuation.list>[number];

const METHOD_LABEL: Record<NonNullable<Row["assessment"]>["method"], string> = {
  claude: "Claude research",
  heuristic: "Heuristic (no model)",
  override: "Operator override",
};

/**
 * Operator-only: each advertiser's hidden willingness-to-pay multiplier, why,
 * and from which sources. Buyers never see any of this; they see the final price.
 */
export function CompanyValuations() {
  const rows = useQuery(api.valuation.list, {});
  return (
    <section aria-labelledby="valuations-heading">
      <h2 id="valuations-heading" className="text-lg font-semibold">
        Company pricing
      </h2>
      <p className="mt-1 max-w-[70ch] text-sm text-muted">
        The company analyst sets a hidden multiplier on posted quotes (x0.75 to x1.5, cached 24 h). Auctions ignore it: every bidder
        faces the same reserve.
      </p>
      {rows === undefined ? (
        <div className="mt-4 h-40 animate-pulse rounded bg-panel" />
      ) : (
        <ul className="mt-4 flex flex-col gap-3">
          {rows.map((r) => (
            <ValuationRow key={r.advertiserId} row={r} />
          ))}
        </ul>
      )}
    </section>
  );
}

function ValuationRow({ row }: { row: Row }) {
  const now = useNow(60_000);
  const override = useMutation(api.valuation.override);
  const reassess = useMutation(api.valuation.reassess);
  const [editing, setEditing] = useState(false);
  const [multiplier, setMultiplier] = useState("1.00");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const a = row.assessment;

  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      setEditing(false);
      setReason("");
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="rounded-lg border border-line bg-panel p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <p className="font-medium">{row.displayName}</p>
          <p className="text-xs text-muted">
            {a ? `${a.brandTier} · ${METHOD_LABEL[a.method]}${a.model ? ` (${a.model})` : ""} · ${ago(a.assessedAt, now)}` : "Not assessed yet"}
            {a && !a.fresh && " · stale, refresh scheduled on next quote"}
          </p>
        </div>
        <div className="text-right">
          <p className="tabular font-mono text-xl">{a ? `x${a.multiplier.toFixed(2)}` : "x1.00"}</p>
          {a && <p className="text-xs text-muted">confidence {Math.round(a.confidence * 100)}%</p>}
        </div>
      </div>
      {a && <p className="mt-2 text-sm text-muted">{a.reasoning}</p>}
      {a && a.sources.length > 0 && (
        <ul className="mt-2 flex flex-col gap-0.5 text-xs">
          {a.sources.map((src) => (
            <li key={src} className="truncate">
              <a href={src} target="_blank" rel="noreferrer" className="text-muted underline underline-offset-2 hover:text-fg">
                {src}
              </a>
            </li>
          ))}
        </ul>
      )}
      {editing ? (
        <div className="mt-3 flex flex-wrap items-end gap-2">
          <label className="flex flex-col gap-2 text-sm">
            <span className="text-muted">Multiplier (0.75 to 1.5)</span>
            <input
              inputMode="decimal"
              value={multiplier}
              onChange={(e) => setMultiplier(e.target.value)}
              className="w-28 rounded-md border border-line bg-ink px-3 py-2 font-mono text-fg"
            />
          </label>
          <label className="flex min-w-[220px] flex-1 flex-col gap-2 text-sm">
            <span className="text-muted">Reason (audited)</span>
            <input value={reason} onChange={(e) => setReason(e.target.value)} className="rounded-md border border-line bg-ink px-3 py-2 text-fg" />
          </label>
          <button
            type="button"
            disabled={busy || reason.trim() === ""}
            onClick={() => run(() => override({ advertiserId: row.advertiserId, multiplier: Number.parseFloat(multiplier), reason }))}
            className="rounded-md bg-accent px-3 py-2 text-sm font-medium text-accent-ink disabled:opacity-50"
          >
            Pin multiplier
          </button>
          <button type="button" onClick={() => setEditing(false)} className="px-3 py-2 text-sm text-muted hover:text-fg">
            Cancel
          </button>
        </div>
      ) : (
        <div className="mt-3 flex gap-2">
          <button
            type="button"
            onClick={() => {
              setMultiplier((a?.multiplier ?? 1).toFixed(2));
              setEditing(true);
            }}
            className="rounded-md border border-line px-3 py-1.5 text-sm text-muted hover:text-fg"
          >
            Override
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => run(() => reassess({ advertiserId: row.advertiserId }))}
            className="rounded-md border border-line px-3 py-1.5 text-sm text-muted hover:text-fg disabled:opacity-50"
          >
            Re-assess now
          </button>
        </div>
      )}
      {error && (
        <p role="alert" className="mt-2 text-sm text-danger">
          {error}
        </p>
      )}
    </li>
  );
}
