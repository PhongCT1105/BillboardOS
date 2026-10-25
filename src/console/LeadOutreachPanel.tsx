import { useMutation, useQuery } from "convex/react";
import { useState, type FormEvent } from "react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { ago } from "../lib/format";
import { useNow } from "../lib/hooks";

/** Draft-only agency outreach for companies outside the Cal Hacks network. Never sends mail. */
export function LeadOutreachPanel() {
  const leads = useQuery(api.agencyLeads.list, {});
  const draft = useMutation(api.agencyLeads.draft);
  const markCopied = useMutation(api.agencyLeads.markCopied);
  const dismiss = useMutation(api.agencyLeads.dismiss);
  const now = useNow(15_000);
  const [companyName, setCompanyName] = useState("");
  const [website, setWebsite] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<Id<"agencyLeads"> | null>(null);

  async function onDraft(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await draft({
        companyName,
        website: website.trim() || undefined,
        notes: notes.trim() || undefined,
      });
      setCompanyName("");
      setWebsite("");
      setNotes("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not draft outreach");
    } finally {
      setBusy(false);
    }
  }

  async function copyLead(lead: { _id: Id<"agencyLeads">; subject: string; body: string }) {
    const text = `Subject: ${lead.subject}\n\n${lead.body}`;
    await navigator.clipboard.writeText(text);
    await markCopied({ leadId: lead._id });
    setCopiedId(lead._id);
  }

  return (
    <section aria-labelledby="lead-outreach-heading" className="flex flex-col gap-3">
      <div>
        <h2 id="lead-outreach-heading" className="text-base font-semibold">
          Agency outreach drafts
        </h2>
        <p className="text-sm text-muted">
          For companies outside the Cal Hacks network. BillboardOS only drafts the email — you copy it
          into your own inbox. Nothing is sent from here.
        </p>
      </div>

      <form onSubmit={onDraft} className="flex flex-col gap-2 text-sm">
        <label className="flex flex-col gap-1">
          <span className="text-muted">Company</span>
          <input
            className="rounded-md border border-line bg-panel px-3 py-2 text-fg"
            value={companyName}
            onChange={(e) => setCompanyName(e.target.value)}
            placeholder="Acme Robotics"
            required
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-muted">Website (optional)</span>
          <input
            className="rounded-md border border-line bg-panel px-3 py-2 text-fg"
            value={website}
            onChange={(e) => setWebsite(e.target.value)}
            placeholder="https://acme.example"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-muted">Notes (optional)</span>
          <textarea
            className="min-h-[4rem] rounded-md border border-line bg-panel px-3 py-2 text-fg"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Why they might fit a street screen"
          />
        </label>
        {error && <p className="text-sm text-danger">{error}</p>}
        <button
          type="submit"
          disabled={busy || companyName.trim().length < 2}
          className="self-start rounded-md border border-line bg-panel px-3 py-2 disabled:opacity-50"
        >
          {busy ? "Drafting…" : "Draft outreach"}
        </button>
      </form>

      {leads === undefined ? (
        <div className="h-16 animate-pulse rounded bg-panel" />
      ) : leads.length === 0 ? (
        <p className="text-sm text-muted">No drafts yet.</p>
      ) : (
        <ul className="flex flex-col gap-4">
          {leads.map((lead) => (
            <li key={lead._id} className="border-t border-line pt-3 text-sm">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <p className="font-medium">{lead.companyName}</p>
                <p className="text-xs text-muted">
                  {lead.status === "copied" ? "Copied" : "Draft"} · {ago(lead.createdAt, now)}
                </p>
              </div>
              <p className="mt-1 text-muted">{lead.subject}</p>
              <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap rounded-md border border-line bg-panel p-3 text-xs text-fg">
                {lead.body}
              </pre>
              <div className="mt-2 flex flex-wrap gap-2">
                <button
                  type="button"
                  className="rounded-md border border-line bg-panel px-3 py-1.5"
                  onClick={() => void copyLead(lead)}
                >
                  {copiedId === lead._id ? "Copied" : "Copy draft"}
                </button>
                <button
                  type="button"
                  className="rounded-md border border-line px-3 py-1.5 text-muted"
                  onClick={() => void dismiss({ leadId: lead._id })}
                >
                  Dismiss
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
