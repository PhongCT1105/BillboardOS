import { useState, type ReactNode } from "react";
import { errorMessage } from "../lib/format";

/** Shared form and layout bits for the customer dashboard and workspace settings. */

export const inputCls = "rounded-md border border-line bg-ink px-3 py-2 text-fg outline-none focus:border-muted";
export const primaryBtn =
  "rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-ink transition-transform active:scale-[0.98] disabled:opacity-50";
export const secondaryBtn =
  "rounded-md border border-line px-3 py-1.5 text-sm text-muted transition-colors hover:border-muted hover:text-fg disabled:opacity-50";
export const dangerBtn =
  "rounded-md border border-danger/50 px-3 py-1.5 text-sm text-danger transition-colors hover:bg-danger/10 disabled:opacity-50";

export function Section(props: { title: string; lead?: ReactNode; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="fade-in flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">{props.title}</h2>
          {props.lead && <p className="mt-1 max-w-[70ch] text-sm text-muted">{props.lead}</p>}
        </div>
        {props.action}
      </div>
      {props.children}
    </section>
  );
}

export function Card(props: { children: ReactNode; className?: string }) {
  return <div className={`rounded-lg border border-line bg-panel p-5 ${props.className ?? ""}`}>{props.children}</div>;
}

export function Empty(props: { children: ReactNode }) {
  return <p className="rounded-lg border border-dashed border-line px-5 py-8 text-center text-sm text-muted">{props.children}</p>;
}

export function Skeleton(props: { h?: string }) {
  return <div className={`${props.h ?? "h-32"} animate-pulse rounded-lg bg-panel`} />;
}

export function ErrorLine({ error }: { error: string | null }) {
  return error ? (
    <p role="alert" className="text-sm text-danger">
      {error}
    </p>
  ) : null;
}

export function Field(props: { label: string; hint?: string; children: ReactNode; className?: string }) {
  return (
    <label className={`flex flex-col gap-1.5 text-sm ${props.className ?? ""}`}>
      <span className="text-muted">{props.label}</span>
      {props.children}
      {props.hint && <span className="text-xs text-faint">{props.hint}</span>}
    </label>
  );
}

export function Pill(props: { tone?: "accent" | "danger" | "muted" | "ok"; children: ReactNode }) {
  const tone = {
    accent: "border-accent/60 text-accent",
    danger: "border-danger/60 text-danger",
    muted: "border-line text-muted",
    ok: "border-emerald-400/50 text-emerald-300",
  }[props.tone ?? "muted"];
  return <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${tone}`}>{props.children}</span>;
}

/** Run an async action with busy/error state. */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
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
  return { busy, error, setError, run };
}

export function CopyButton(props: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className={secondaryBtn}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(props.value);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          setCopied(false);
        }
      }}
    >
      {copied ? "Copied" : (props.label ?? "Copy")}
    </button>
  );
}

/** Dollars typed by a person -> integer cents, or null when not a positive amount. */
export function parseUsd(value: string): number | null {
  const n = Number.parseFloat(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n * 100);
}
