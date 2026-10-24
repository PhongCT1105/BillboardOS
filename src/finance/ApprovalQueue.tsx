import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { api } from "../../convex/_generated/api";
import { errorMessage, money, words } from "../lib/format";

type Approval = FunctionReturnType<typeof api.approvals.pending>[number];

export function ApprovalQueue({ approvals }: { approvals: Approval[] | undefined }) {
  const pending = approvals?.filter((a) => a.status === "pending");
  return (
    <section aria-labelledby="approvals-heading">
      <h2 id="approvals-heading" className="text-lg font-semibold">
        Waiting for your approval
      </h2>
      <p className="mt-1 text-sm text-muted">Agents can ask. Only you can approve, and never your own request.</p>
      {pending === undefined ? (
        <div className="mt-4 h-32 animate-pulse rounded bg-panel" />
      ) : pending.length === 0 ? (
        <p className="mt-4 text-muted">Nothing to approve.</p>
      ) : (
        <ul className="mt-4 flex flex-col gap-3">
          {pending.map((a) => (
            <ApprovalItem key={a._id} approval={a} />
          ))}
        </ul>
      )}
    </section>
  );
}

function ApprovalItem({ approval }: { approval: Approval }) {
  const decide = useMutation(api.approvals.decide);
  // The approver is whoever is signed in; the server enforces this too.
  const me = useQuery(api.operators.me);
  const ownRequest = me?.email != null && approval.requestedBy === `operator:${me.email}`;
  const [rejecting, setRejecting] = useState(false);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(decision: "approved" | "rejected") {
    setBusy(true);
    setError(null);
    try {
      await decide({
        approvalId: approval._id,
        decision,
        note: decision === "approved" ? note || "Approved" : note,
      });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="fade-in rounded-lg border border-line bg-panel p-4">
      <div className="flex items-baseline justify-between gap-3">
        <span className="font-medium capitalize">{words(approval.action)}</span>
        <span className="tabular font-mono">{money(approval.amountMinor)}</span>
      </div>
      <p className="mt-1 text-sm text-muted">{approval.subjectLabel}</p>
      <p className="mt-2 text-sm">{approval.reason}</p>
      <p className="mt-1 text-xs text-faint">Requested by {approval.requestedBy}</p>
      {ownRequest && (
        <p className="mt-2 text-xs text-muted">You requested this, so another operator has to decide it.</p>
      )}

      {rejecting && (
        <label className="mt-3 flex flex-col gap-2 text-sm">
          <span className="text-muted">Reason for rejecting</span>
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            className="rounded-md border border-line bg-ink px-3 py-2 text-fg"
          />
        </label>
      )}
      {error && (
        <p role="alert" className="mt-2 text-sm text-danger">
          {error}
        </p>
      )}
      <div className="mt-3 flex gap-2">
        {rejecting ? (
          <>
            <button
              type="button"
              disabled={busy || note.trim() === ""}
              onClick={() => submit("rejected")}
              className="rounded-md border border-danger px-3 py-1.5 text-sm text-danger disabled:opacity-50"
            >
              Confirm reject
            </button>
            <button type="button" onClick={() => setRejecting(false)} className="px-3 py-1.5 text-sm text-muted hover:text-fg">
              Cancel
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              disabled={busy || ownRequest}
              onClick={() => submit("approved")}
              className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-ink active:scale-[0.98] disabled:opacity-50"
            >
              Approve
            </button>
            <button
              type="button"
              onClick={() => setRejecting(true)}
              className="rounded-md border border-line px-3 py-1.5 text-sm text-muted hover:text-fg"
            >
              Reject
            </button>
          </>
        )}
      </div>
    </li>
  );
}
