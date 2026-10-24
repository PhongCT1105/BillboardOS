import { useMemo, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { summarizeRule, type WatchTrigger } from "../../convex/lib/watch";
import { Card, Empty, ErrorLine, Field, Pill, Section, Skeleton, dangerBtn, inputCls, parseUsd, primaryBtn, secondaryBtn, useAction } from "./ui";

type Rule = FunctionReturnType<typeof api.watchRules.list>[number];
type Delivery = "inbox" | "agent";

const TRIGGERS: { value: WatchTrigger; label: string; hint: string }[] = [
  { value: "available", label: "Available", hint: "A slot that fits is on sale under your max" },
  { value: "price_drop", label: "Price drop", hint: "A slot that was above your max drops under it" },
  { value: "last_minute", label: "Last minute", hint: "Unsold slot inside the hour, discounted" },
  { value: "auction_open", label: "Auction opens", hint: "A hot slot goes to auction under your max" },
];
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const HOURS = Array.from({ length: 25 }, (_, h) => h);

function hourLabel(h: number) {
  if (h === 0 || h === 24) return "12 AM";
  if (h === 12) return "12 PM";
  return h < 12 ? `${h} AM` : `${h - 12} PM`;
}

export function WatchRulesPanel() {
  const rules = useQuery(api.watchRules.list, {});
  const [editing, setEditing] = useState<Rule | "new" | null>(null);
  return (
    <Section
      title="Watch rules"
      lead="Tell BillboardOS what a good spot looks like. Matching slots land in your alerts inbox, and optionally at your agent's webhook."
      action={
        editing === null && (
          <button type="button" className={primaryBtn} onClick={() => setEditing("new")}>
            New watch rule
          </button>
        )
      }
    >
      {editing !== null && (
        <RuleForm key={editing === "new" ? "new" : editing.ruleId} rule={editing === "new" ? null : editing} onDone={() => setEditing(null)} />
      )}
      {rules === undefined ? (
        <Skeleton />
      ) : rules.length === 0 ? (
        <Empty>No watch rules yet. Create one and matching slots show up in Alerts within minutes.</Empty>
      ) : (
        <div className="flex flex-col gap-3">
          {rules.map((r) => (
            <RuleRow key={r.ruleId} rule={r} onEdit={() => setEditing(r)} />
          ))}
        </div>
      )}
    </Section>
  );
}

function RuleRow({ rule, onEdit }: { rule: Rule; onEdit: () => void }) {
  const pause = useMutation(api.watchRules.pause);
  const remove = useMutation(api.watchRules.remove);
  const { busy, error, run } = useAction();
  const [confirming, setConfirming] = useState(false);
  return (
    <Card className={`flex flex-col gap-3 ${rule.active ? "" : "opacity-70"}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-medium">{rule.name}</p>
          <p className="mt-1 text-sm text-fg">{rule.summary}</p>
          <p className="mt-1 text-xs text-faint">Campaign: {rule.campaignBrief.slice(0, 80)}</p>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <Pill tone={rule.active ? "ok" : "muted"}>{rule.active ? "Watching" : "Paused"}</Pill>
          {rule.delivery.includes("agent") && (
            <Pill tone={rule.agentKey?.status === "active" ? "accent" : "danger"}>
              Agent {rule.agentKey ? `${rule.agentKey.name} (${rule.agentKey.status})` : "key missing"}
            </Pill>
          )}
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        <button type="button" className={secondaryBtn} onClick={onEdit} disabled={busy}>
          Edit
        </button>
        <button type="button" className={secondaryBtn} disabled={busy} onClick={() => run(() => pause({ ruleId: rule.ruleId, paused: rule.active }))}>
          {rule.active ? "Pause" : "Resume"}
        </button>
        {confirming ? (
          <>
            <button type="button" className={dangerBtn} disabled={busy} onClick={() => run(() => remove({ ruleId: rule.ruleId }))}>
              Delete rule
            </button>
            <button type="button" className="px-2 text-sm text-muted hover:text-fg" onClick={() => setConfirming(false)}>
              Keep it
            </button>
          </>
        ) : (
          <button type="button" className={secondaryBtn} onClick={() => setConfirming(true)}>
            Delete
          </button>
        )}
      </div>
      <ErrorLine error={error} />
    </Card>
  );
}

function RuleForm({ rule, onDone }: { rule: Rule | null; onDone: () => void }) {
  const campaigns = useQuery(api.campaigns.list, {});
  const screens = useQuery(api.billboards.list);
  const keys = useQuery(api.agentKeys.list, {});
  const create = useMutation(api.watchRules.create);
  const update = useMutation(api.watchRules.update);
  const { busy, error, setError, run } = useAction();

  const [campaignId, setCampaignId] = useState<Id<"campaigns"> | "">(rule?.campaignId ?? "");
  const [name, setName] = useState(rule?.name ?? "");
  const [maxPrice, setMaxPrice] = useState(rule ? String(rule.maxPriceMinor / 100) : "60");
  const [cities, setCities] = useState((rule?.cities ?? []).join(", "));
  const [billboardIds, setBillboardIds] = useState<Id<"billboards">[]>(rule?.billboardIds ?? []);
  const [minMatch, setMinMatch] = useState(Math.round((rule?.minMatch ?? 0) * 100));
  const [hourStart, setHourStart] = useState<number | "">(rule?.hourStart ?? "");
  const [hourEnd, setHourEnd] = useState<number | "">(rule?.hourEnd ?? "");
  const [days, setDays] = useState<number[]>(rule?.daysOfWeek ?? []);
  const [triggers, setTriggers] = useState<WatchTrigger[]>(rule?.triggers ?? ["available", "price_drop", "last_minute"]);
  const [delivery, setDelivery] = useState<Delivery[]>(rule?.delivery ?? ["inbox"]);
  const [agentKeyId, setAgentKeyId] = useState<Id<"agentKeys"> | "">(rule?.agentKey?.agentKeyId ?? "");

  const webhookKeys = (keys ?? []).filter((k) => k.status === "active" && k.webhookUrl);
  const chosenCampaign = campaignId || campaigns?.[0]?._id || "";
  const maxPriceMinor = parseUsd(maxPrice);

  const preview = useMemo(() => {
    const names = Object.fromEntries((screens ?? []).map((s) => [s._id, s.name]));
    return summarizeRule(
      {
        maxPriceMinor: maxPriceMinor ?? 0,
        cities: splitCities(cities),
        billboardIds,
        minMatch: minMatch > 0 ? minMatch / 100 : undefined,
        hourStart: hourStart === "" ? undefined : hourStart,
        hourEnd: hourEnd === "" ? undefined : hourEnd,
        daysOfWeek: days,
        triggers: triggers.length ? triggers : ["available"],
        delivery,
      },
      names,
    );
  }, [screens, maxPriceMinor, cities, billboardIds, minMatch, hourStart, hourEnd, days, triggers, delivery]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!chosenCampaign) return setError("Create a campaign first");
    if (maxPriceMinor === null) return setError("Max price must be a positive dollar amount");
    const input = {
      campaignId: chosenCampaign as Id<"campaigns">,
      name: name.trim() || undefined,
      cities: splitCities(cities),
      billboardIds: billboardIds.length ? billboardIds : undefined,
      minMatch: minMatch > 0 ? minMatch / 100 : undefined,
      maxPriceMinor,
      daysOfWeek: days.length ? days : undefined,
      hourStart: hourStart === "" ? undefined : hourStart,
      hourEnd: hourEnd === "" ? undefined : hourEnd,
      // Date windows are API-only for now; keep whatever the rule already has.
      dateFrom: rule?.dateFrom ?? undefined,
      dateTo: rule?.dateTo ?? undefined,
      triggers,
      delivery,
      agentKeyId: delivery.includes("agent") && agentKeyId ? agentKeyId : undefined,
    };
    const ok = await run(() => (rule ? update({ ruleId: rule.ruleId, ...input }) : create(input)));
    if (ok) onDone();
  }

  if (campaigns === undefined || screens === undefined) return <Skeleton />;
  if (campaigns.length === 0) return <Empty>Create a campaign first; watch rules alert on behalf of a campaign.</Empty>;

  const toggle = <T,>(list: T[], v: T) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);

  return (
    <Card>
      <form onSubmit={submit} className="flex flex-col gap-5">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <Field label="Campaign" className="md:col-span-2">
            <select value={chosenCampaign} onChange={(e) => setCampaignId(e.target.value as Id<"campaigns">)} className={inputCls}>
              {campaigns.map((c) => (
                <option key={c._id} value={c._id}>
                  {c.brief.slice(0, 70)}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Rule name (optional)">
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Morning SF deals" className={inputCls} />
          </Field>
        </div>

        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <Field label="Max price per slot (USD)">
            <input inputMode="decimal" value={maxPrice} onChange={(e) => setMaxPrice(e.target.value)} className={`${inputCls} font-mono`} />
          </Field>
          <Field label="Cities (comma separated, optional)">
            <input value={cities} onChange={(e) => setCities(e.target.value)} placeholder="San Francisco" className={inputCls} />
          </Field>
          <Field label={`Audience match at least ${minMatch === 0 ? "(any)" : `${minMatch}%`}`} hint="Uses the campaign's target audience">
            <input
              type="range"
              min={0}
              max={100}
              step={5}
              value={minMatch}
              onChange={(e) => setMinMatch(Number(e.target.value))}
              className="mt-2 accent-[var(--color-accent)]"
            />
          </Field>
        </div>

        <fieldset className="flex flex-col gap-2">
          <legend className="text-sm text-muted">Screens (none selected = any screen)</legend>
          <div className="flex flex-wrap gap-2">
            {screens.map((s) => (
              <ToggleChip key={s._id} on={billboardIds.includes(s._id)} onClick={() => setBillboardIds(toggle(billboardIds, s._id))}>
                {s.name} <span className="text-faint">{s.city}</span>
              </ToggleChip>
            ))}
          </div>
        </fieldset>

        <div className="grid grid-cols-1 gap-4 md:grid-cols-[auto_auto_minmax(0,1fr)]">
          <Field label="From (screen's local time)">
            <select value={hourStart} onChange={(e) => setHourStart(e.target.value === "" ? "" : Number(e.target.value))} className={inputCls}>
              <option value="">Any time</option>
              {HOURS.slice(0, 24).map((h) => (
                <option key={h} value={h}>
                  {hourLabel(h)}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Until">
            <select value={hourEnd} onChange={(e) => setHourEnd(e.target.value === "" ? "" : Number(e.target.value))} className={inputCls}>
              <option value="">Any time</option>
              {HOURS.slice(1).map((h) => (
                <option key={h} value={h}>
                  {h === 24 ? "Midnight" : hourLabel(h)}
                </option>
              ))}
            </select>
          </Field>
          <fieldset className="flex flex-col gap-1.5">
            <legend className="text-sm text-muted">Days (none = every day)</legend>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {DAYS.map((d, i) => (
                <ToggleChip key={d} on={days.includes(i)} onClick={() => setDays(toggle(days, i).sort())}>
                  {d}
                </ToggleChip>
              ))}
            </div>
          </fieldset>
        </div>

        <fieldset className="flex flex-col gap-2">
          <legend className="text-sm text-muted">Alert me when</legend>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
            {TRIGGERS.map((t) => (
              <CheckCard key={t.value} on={triggers.includes(t.value)} onClick={() => setTriggers(toggle(triggers, t.value))} title={t.label} hint={t.hint} />
            ))}
          </div>
        </fieldset>

        <fieldset className="flex flex-col gap-2">
          <legend className="text-sm text-muted">Deliver to</legend>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <CheckCard on={delivery.includes("inbox")} onClick={() => setDelivery(toggle(delivery, "inbox"))} title="My inbox" hint="Live in Alerts, with an unread badge" />
            <CheckCard
              on={delivery.includes("agent")}
              onClick={() => setDelivery(toggle(delivery, "agent"))}
              title="My agent's webhook"
              hint="Signed POST to an agent key's webhook URL"
            />
          </div>
          {delivery.includes("agent") &&
            (webhookKeys.length === 0 ? (
              <p className="text-sm text-muted">No active agent key has a webhook URL. Create one under Agent keys first.</p>
            ) : (
              <Field label="Agent key" className="max-w-md">
                <select value={agentKeyId} onChange={(e) => setAgentKeyId(e.target.value as Id<"agentKeys">)} className={inputCls}>
                  <option value="">Choose a key</option>
                  {webhookKeys.map((k) => (
                    <option key={k.agentKeyId} value={k.agentKeyId}>
                      {k.name} ({k.prefix}) to {k.webhookUrl}
                    </option>
                  ))}
                </select>
              </Field>
            ))}
        </fieldset>

        <div className="rounded-md border border-accent/40 bg-accent/5 px-4 py-3 text-sm">
          <span className="text-faint">In plain words: </span>
          <span className="text-fg">{preview}</span>
        </div>

        <ErrorLine error={error} />
        <div className="flex gap-2">
          <button type="submit" disabled={busy || triggers.length === 0 || delivery.length === 0} className={primaryBtn}>
            {rule ? "Save changes" : "Start watching"}
          </button>
          <button type="button" onClick={onDone} className="px-3 py-2 text-sm text-muted hover:text-fg">
            Cancel
          </button>
        </div>
      </form>
    </Card>
  );
}

function splitCities(value: string): string[] | undefined {
  const list = value
    .split(",")
    .map((c) => c.trim())
    .filter(Boolean);
  return list.length ? list : undefined;
}

function ToggleChip(props: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={props.on}
      onClick={props.onClick}
      className={`rounded-full border px-3 py-1 text-sm transition-colors ${
        props.on ? "border-accent bg-accent/15 text-fg" : "border-line text-muted hover:border-muted hover:text-fg"
      }`}
    >
      {props.children}
    </button>
  );
}

function CheckCard(props: { on: boolean; onClick: () => void; title: string; hint: string }) {
  return (
    <button
      type="button"
      aria-pressed={props.on}
      onClick={props.onClick}
      className={`flex flex-col gap-0.5 rounded-md border px-3 py-2 text-left text-sm transition-colors ${
        props.on ? "border-accent bg-accent/10" : "border-line bg-ink hover:border-muted"
      }`}
    >
      <span className="font-medium text-fg">{props.title}</span>
      <span className="text-xs text-muted">{props.hint}</span>
    </button>
  );
}
