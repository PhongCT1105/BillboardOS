import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { ago, money, shortDate } from "../lib/format";
import { useNow } from "../lib/hooks";
import { Card, CopyButton, Empty, ErrorLine, Field, Pill, Section, Skeleton, dangerBtn, inputCls, parseUsd, primaryBtn, secondaryBtn, useAction } from "./ui";

type Issued = FunctionReturnType<typeof api.agentKeys.create>;
type Key = FunctionReturnType<typeof api.agentKeys.list>[number];
type Scope = "quote" | "hold" | "bid" | "pay";

const SCOPES: { value: Scope; hint: string }[] = [
  { value: "quote", hint: "See prices and get quotes" },
  { value: "hold", hint: "Hold slots for 5 minutes" },
  { value: "bid", hint: "Join and bid in auctions" },
  { value: "pay", hint: "Pay holds over x402" },
];

export function AgentKeysPanel() {
  const keys = useQuery(api.agentKeys.list, {});
  const [creating, setCreating] = useState(false);
  const [issued, setIssued] = useState<Issued | null>(null);
  return (
    <Section
      title="Agent keys"
      lead="Let your own buying agent act for your company over the agent API, inside a budget cap. Keys are shown once."
      action={
        !creating &&
        !issued && (
          <button type="button" className={primaryBtn} onClick={() => setCreating(true)}>
            New agent key
          </button>
        )
      }
    >
      {issued && <IssuedKey issued={issued} onDone={() => setIssued(null)} />}
      {creating && (
        <NewKey
          onCancel={() => setCreating(false)}
          onIssued={(k) => {
            setCreating(false);
            setIssued(k);
          }}
        />
      )}
      {keys === undefined ? (
        <Skeleton />
      ) : keys.length === 0 ? (
        <Empty>No agent keys yet.</Empty>
      ) : (
        <div className="flex flex-col gap-3">
          {keys.map((k) => (
            <KeyRow key={k.agentKeyId} k={k} />
          ))}
        </div>
      )}
    </Section>
  );
}

function IssuedKey({ issued, onDone }: { issued: Issued; onDone: () => void }) {
  return (
    <Card className="flex flex-col gap-4 border-accent/60">
      <div>
        <h3 className="font-semibold">Copy these now</h3>
        <p className="mt-1 text-sm text-muted">
          BillboardOS stores only a hash of the key. You won't see the key or the webhook secret again; if you lose them, revoke this key and
          make a new one.
        </p>
      </div>
      <SecretLine label="Agent key (Authorization: Bearer ...)" value={issued.key} />
      <SecretLine label="Webhook signing secret (verify X-BillboardOS-Signature)" value={issued.webhookSecret} />
      <button type="button" className={`${secondaryBtn} self-start`} onClick={onDone}>
        I saved them
      </button>
    </Card>
  );
}

function SecretLine({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs text-muted">{label}</span>
      <div className="flex items-center gap-2">
        <code className="min-w-0 flex-1 overflow-x-auto rounded-md border border-line bg-ink px-3 py-2 font-mono text-sm whitespace-nowrap text-fg">{value}</code>
        <CopyButton value={value} />
      </div>
    </div>
  );
}

function NewKey({ onCancel, onIssued }: { onCancel: () => void; onIssued: (k: Issued) => void }) {
  const create = useMutation(api.agentKeys.create);
  const campaigns = useQuery(api.campaigns.list, {});
  const [name, setName] = useState("buyer-agent");
  const [scopes, setScopes] = useState<Scope[]>(["quote", "hold"]);
  const [budget, setBudget] = useState("200");
  const [days, setDays] = useState("30");
  const [webhookUrl, setWebhookUrl] = useState("");
  const [campaignIds, setCampaignIds] = useState<Id<"campaigns">[]>([]);
  const { busy, error, setError, run } = useAction();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const budgetCapMinor = parseUsd(budget);
    if (budgetCapMinor === null) return setError("Budget cap must be a positive dollar amount");
    const expiresInDays = Number(days);
    const issued = await run(() =>
      create({
        name,
        scopes,
        budgetCapMinor,
        expiresInDays,
        webhookUrl: webhookUrl.trim() || undefined,
        campaignIds: campaignIds.length ? campaignIds : undefined,
      }),
    );
    if (issued) onIssued(issued);
  }

  const toggle = <T,>(list: T[], v: T) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);

  return (
    <Card>
      <form onSubmit={submit} className="flex flex-col gap-4">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <Field label="Name">
            <input required value={name} onChange={(e) => setName(e.target.value)} className={inputCls} />
          </Field>
          <Field label="Budget cap (USD)" hint="Holds, bookings and leading bids count against it">
            <input inputMode="decimal" value={budget} onChange={(e) => setBudget(e.target.value)} className={`${inputCls} font-mono`} />
          </Field>
          <Field label="Expires after">
            <select value={days} onChange={(e) => setDays(e.target.value)} className={inputCls}>
              {["1", "7", "30", "90", "365"].map((d) => (
                <option key={d} value={d}>
                  {d} day{d === "1" ? "" : "s"}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <fieldset className="flex flex-col gap-2">
          <legend className="text-sm text-muted">What it may do</legend>
          <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
            {SCOPES.map((s) => (
              <button
                key={s.value}
                type="button"
                aria-pressed={scopes.includes(s.value)}
                onClick={() => setScopes(toggle(scopes, s.value))}
                className={`flex flex-col gap-0.5 rounded-md border px-3 py-2 text-left text-sm ${
                  scopes.includes(s.value) ? "border-accent bg-accent/10" : "border-line bg-ink hover:border-muted"
                }`}
              >
                <span className="font-mono text-fg">{s.value}</span>
                <span className="text-xs text-muted">{s.hint}</span>
              </button>
            ))}
          </div>
        </fieldset>
        <Field label="Webhook URL (optional)" hint="https, or http://localhost for development. Needed for watch-rule delivery to your agent.">
          <input value={webhookUrl} onChange={(e) => setWebhookUrl(e.target.value)} placeholder="https://my-agent.example.com/alerts" className={inputCls} />
        </Field>
        {campaigns && campaigns.length > 1 && (
          <fieldset className="flex flex-col gap-2">
            <legend className="text-sm text-muted">Campaigns (none selected = all of them)</legend>
            <div className="flex flex-wrap gap-2">
              {campaigns.map((c) => (
                <button
                  key={c._id}
                  type="button"
                  aria-pressed={campaignIds.includes(c._id)}
                  onClick={() => setCampaignIds(toggle(campaignIds, c._id))}
                  className={`rounded-full border px-3 py-1 text-sm ${
                    campaignIds.includes(c._id) ? "border-accent bg-accent/15 text-fg" : "border-line text-muted hover:text-fg"
                  }`}
                >
                  {c.brief.slice(0, 40)}
                </button>
              ))}
            </div>
          </fieldset>
        )}
        <ErrorLine error={error} />
        <div className="flex gap-2">
          <button type="submit" disabled={busy || scopes.length === 0 || !name.trim()} className={primaryBtn}>
            Create key
          </button>
          <button type="button" onClick={onCancel} className="px-3 py-2 text-sm text-muted hover:text-fg">
            Cancel
          </button>
        </div>
      </form>
    </Card>
  );
}

function KeyRow({ k }: { k: Key }) {
  const revoke = useMutation(api.agentKeys.revoke);
  const now = useNow(60_000);
  const { busy, error, run } = useAction();
  const [confirming, setConfirming] = useState(false);
  const used = k.budgetCapMinor > 0 ? Math.min(1, k.committedMinor / k.budgetCapMinor) : 0;
  return (
    <Card className={`flex flex-col gap-3 ${k.status === "active" ? "" : "opacity-70"}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{k.name}</span>
            <code className="font-mono text-xs text-muted">{k.prefix}_...</code>
            <Pill tone={k.status === "active" ? "ok" : "danger"}>{k.status}</Pill>
          </div>
          <p className="mt-1 text-xs text-muted">
            Scopes {k.scopes.join(", ")} · {k.status === "expired" ? "expired" : "expires"} {shortDate(k.expiresAt)} ·{" "}
            {k.lastUsedAt ? `last used ${ago(k.lastUsedAt, now)}` : "never used"}
            {k.campaignIds && ` · ${k.campaignIds.length} campaign${k.campaignIds.length === 1 ? "" : "s"} only`}
          </p>
          <p className="mt-1 truncate text-xs text-faint">{k.webhookUrl ? `Webhook ${k.webhookUrl}` : "No webhook"}</p>
        </div>
        <div className="min-w-[180px] text-right">
          <p className="text-xs text-muted">Committed of cap</p>
          <p className="tabular font-mono text-sm">
            {money(k.committedMinor)} / {money(k.budgetCapMinor)}
          </p>
          <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-raised">
            <div className="h-full bg-accent" style={{ width: `${Math.round(used * 100)}%` }} />
          </div>
        </div>
      </div>
      <StandingInstructions k={k} />
      {k.status === "active" && (
        <div className="flex gap-2">
          {confirming ? (
            <>
              <button type="button" className={dangerBtn} disabled={busy} onClick={() => run(() => revoke({ agentKeyId: k.agentKeyId }))}>
                Revoke now
              </button>
              <button type="button" className="px-2 text-sm text-muted hover:text-fg" onClick={() => setConfirming(false)}>
                Keep it
              </button>
            </>
          ) : (
            <button type="button" className={secondaryBtn} onClick={() => setConfirming(true)}>
              Revoke
            </button>
          )}
        </div>
      )}
      <ErrorLine error={error} />
    </Card>
  );
}

/** Standing instructions (ADR 0006): what the agent may do with live-moment flash offers. Enforced server-side too. */
function StandingInstructions({ k }: { k: Key }) {
  const save = useMutation(api.moments.setStanding);
  const [editing, setEditing] = useState(false);
  const s = k.standing;
  const [max, setMax] = useState(s ? String(s.maxPricePerSpotMinor / 100) : "50");
  const [minViewers, setMinViewers] = useState(s ? String(s.minRelevantViewers) : "10");
  const [daily, setDaily] = useState(s ? String(s.dailyBudgetMinor / 100) : "200");
  const [policy, setPolicy] = useState<"auto_accept" | "counter" | "pass">(s?.policy ?? "auto_accept");
  const [ratio, setRatio] = useState(s?.counterRatio ? String(Math.round(s.counterRatio * 100)) : "85");
  const { busy, error, setError, run } = useAction();
  const summary = s
    ? `${s.policy === "auto_accept" ? "Auto-accept" : s.policy === "counter" ? `Counter at ${Math.round((s.counterRatio ?? 0.85) * 100)}%` : "Pass"} · max ${money(s.maxPricePerSpotMinor)}/spot · ${s.minRelevantViewers}+ relevant viewers · ${money(s.dailyBudgetMinor)}/day`
    : "No standing instructions: this key gets no flash offers.";
  if (!editing) {
    return (
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-line bg-ink px-3 py-2 text-sm">
        <span className="text-muted">
          <span className="text-fg">Flash offers:</span> {summary}
        </span>
        {k.status === "active" && (
          <button type="button" className="text-sm text-accent hover:underline" onClick={() => setEditing(true)}>
            {s ? "Edit" : "Set up"}
          </button>
        )}
      </div>
    );
  }
  return (
    <form
      className="grid grid-cols-2 gap-3 rounded-md border border-line bg-ink p-3 md:grid-cols-5"
      onSubmit={async (e) => {
        e.preventDefault();
        const maxMinor = parseUsd(max);
        const dailyMinor = parseUsd(daily);
        if (maxMinor === null || dailyMinor === null) return setError("Prices must be positive dollar amounts");
        const ok = await run(async () => {
          await save({
            agentKeyId: k.agentKeyId,
            standing: {
              maxPricePerSpotMinor: maxMinor,
              minRelevantViewers: Number(minViewers),
              dailyBudgetMinor: dailyMinor,
              policy,
              counterRatio: policy === "counter" ? Number(ratio) / 100 : undefined,
            },
          });
          return true;
        });
        if (ok) setEditing(false);
      }}
    >
      <Field label="Policy">
        <select value={policy} onChange={(e) => setPolicy(e.target.value as typeof policy)} className={inputCls}>
          <option value="auto_accept">Auto-accept</option>
          <option value="counter">Counter</option>
          <option value="pass">Pass</option>
        </select>
      </Field>
      <Field label="Max per spot (USD)">
        <input value={max} onChange={(e) => setMax(e.target.value)} inputMode="decimal" className={`${inputCls} font-mono`} />
      </Field>
      <Field label="Min relevant viewers">
        <input value={minViewers} onChange={(e) => setMinViewers(e.target.value)} inputMode="numeric" className={`${inputCls} font-mono`} />
      </Field>
      <Field label="Daily budget (USD)">
        <input value={daily} onChange={(e) => setDaily(e.target.value)} inputMode="decimal" className={`${inputCls} font-mono`} />
      </Field>
      {policy === "counter" && (
        <Field label="Counter at (% of ask)">
          <input value={ratio} onChange={(e) => setRatio(e.target.value)} inputMode="numeric" className={`${inputCls} font-mono`} />
        </Field>
      )}
      <div className="col-span-full flex items-center gap-2">
        <button type="submit" disabled={busy} className={primaryBtn}>
          Save
        </button>
        <button type="button" className="px-2 text-sm text-muted hover:text-fg" onClick={() => setEditing(false)}>
          Cancel
        </button>
        {s && (
          <button type="button" className="ml-auto text-sm text-muted hover:text-fg" onClick={() => run(() => save({ agentKeyId: k.agentKeyId, standing: null }))}>
            Clear
          </button>
        )}
      </div>
      <div className="col-span-full">
        <ErrorLine error={error} />
      </div>
    </form>
  );
}
