import { useState, type FormEvent } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import { errorMessage } from "../lib/format";

/** Console panel: who can run the desk, and granting a teammate's account access by email. */
export function OperatorAccess() {
  const operators = useQuery(api.operators.list);
  const me = useQuery(api.operators.me);
  const grant = useMutation(api.operators.grant);
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      const result = await grant({ email });
      setMessage({
        ok: true,
        text: result.alreadyOperator
          ? `${result.email} is already an operator.`
          : `${result.email} can now use the console, finance desk and sensor.`,
      });
      setEmail("");
    } catch (err) {
      setMessage({ ok: false, text: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby="operators-heading">
      <h2 id="operators-heading" className="text-lg font-semibold">
        Operators
      </h2>
      <p className="mt-1 text-sm text-muted">
        People who can run the console, finance desk and sensor. A teammate creates an account first, then you grant access here.
      </p>
      {operators === undefined ? (
        <div className="mt-4 h-20 animate-pulse rounded bg-panel" />
      ) : (
        <ul className="mt-4 flex flex-col divide-y divide-line rounded-lg border border-line bg-panel">
          {operators.map((op) => (
            <li key={op.userId} className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 px-3 py-2.5 text-sm">
              <span className="min-w-0 break-all">
                {op.email}
                {me?.userId === op.userId && <span className="ml-2 text-xs text-faint">(you)</span>}
              </span>
              <span className="text-xs text-faint">
                {op.grantedBy === "system:first-user" ? "First account" : `Granted by ${op.grantedBy.replace(/^operator:/, "")}`}
              </span>
            </li>
          ))}
        </ul>
      )}
      <form onSubmit={submit} className="mt-4 flex flex-wrap items-end gap-2">
        <label className="flex min-w-0 flex-1 flex-col gap-2 text-sm">
          <span className="text-muted">Teammate's account email</span>
          <input
            type="email"
            required
            autoComplete="off"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="name@example.com"
            className="min-h-11 rounded-md border border-line bg-ink px-3 py-2 text-fg"
          />
        </label>
        <button
          type="submit"
          disabled={busy || email.trim() === ""}
          className="min-h-11 rounded-md bg-accent px-4 text-sm font-medium text-accent-ink active:scale-[0.98] disabled:opacity-50"
        >
          Grant access
        </button>
      </form>
      {message && (
        <p role={message.ok ? "status" : "alert"} className={`mt-2 text-sm ${message.ok ? "text-ok" : "text-danger"}`}>
          {message.text}
        </p>
      )}
      <p className="mt-3 text-xs text-faint">
        Each operator signs in as themselves, so the activity log shows who approved what.
      </p>
    </section>
  );
}
