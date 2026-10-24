import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import { money, words } from "../lib/format";
import { hashHref } from "../lib/hooks";
import { Card, Empty, ErrorLine, Field, Pill, Section, Skeleton, inputCls, parseUsd, primaryBtn, secondaryBtn, useAction } from "./ui";

const SUGGESTED_TAGS = ["software", "ai", "startups", "tourists", "students", "commuters", "press", "families", "finance", "design"];

type TagRow = { tag: string; weight: number };

export function CampaignsPanel() {
  const campaigns = useQuery(api.campaigns.list, {});
  const [creating, setCreating] = useState(false);
  return (
    <Section
      title="Campaigns"
      lead="Each campaign has a budget and a target audience. Screens are matched against the audience; quotes, holds, bookings and watch rules belong to a campaign."
      action={
        !creating && (
          <button type="button" className={primaryBtn} onClick={() => setCreating(true)}>
            New campaign
          </button>
        )
      }
    >
      {creating && <NewCampaign onDone={() => setCreating(false)} />}
      {campaigns === undefined ? (
        <Skeleton />
      ) : campaigns.length === 0 ? (
        <Empty>No campaigns yet. Create one to start booking or watching for deals.</Empty>
      ) : (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {campaigns.map((c) => (
            <Card key={c._id} className="flex flex-col gap-3">
              <div className="flex items-start justify-between gap-3">
                <p className="text-sm text-fg">{c.brief}</p>
                <Pill tone={c.status === "active" ? "ok" : "muted"}>{words(c.status)}</Pill>
              </div>
              <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
                <span className="text-muted">
                  Budget <span className="tabular font-mono text-fg">{money(c.budgetMinor)}</span>
                </span>
                {c.targetCity && <span className="text-muted">City <span className="text-fg">{c.targetCity}</span></span>}
                <span className="text-muted">
                  Creative <span className="text-fg">{words(c.creativeStatus ?? "none")}</span>
                </span>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {c.targetAudience && Object.keys(c.targetAudience).length > 0 ? (
                  Object.entries(c.targetAudience)
                    .sort((a, b) => b[1] - a[1])
                    .map(([tag, w]) => (
                      <Pill key={tag} tone="accent">
                        {tag} {Math.round(w * 100)}%
                      </Pill>
                    ))
                ) : (
                  <span className="text-xs text-faint">No target audience: screens can't be ranked by match.</span>
                )}
              </div>
              <div className="flex gap-2">
                <a href={hashHref("/book", { campaign: c._id })} className={secondaryBtn}>
                  Book for this campaign
                </a>
              </div>
            </Card>
          ))}
        </div>
      )}
    </Section>
  );
}

function NewCampaign({ onDone }: { onDone: () => void }) {
  const create = useMutation(api.campaigns.create);
  const [brief, setBrief] = useState("");
  const [budget, setBudget] = useState("300");
  const [city, setCity] = useState("San Francisco");
  const [tags, setTags] = useState<TagRow[]>([{ tag: "software", weight: 60 }, { tag: "startups", weight: 40 }]);
  const { busy, error, setError, run } = useAction();

  const total = tags.reduce((s, t) => s + (t.tag.trim() ? t.weight : 0), 0);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const budgetMinor = parseUsd(budget);
    if (budgetMinor === null) return setError("Budget must be a positive dollar amount");
    const clean = tags.filter((t) => t.tag.trim() && t.weight > 0);
    const keys = clean.map((t) => t.tag.trim().toLowerCase());
    if (new Set(keys).size !== keys.length) return setError("Each audience tag can appear once");
    const targetAudience =
      clean.length > 0 && total > 0 ? Object.fromEntries(clean.map((t) => [t.tag.trim().toLowerCase(), t.weight / total])) : undefined;
    const ok = await run(() => create({ brief, budgetMinor, targetCity: city.trim() || undefined, targetAudience }));
    if (ok) onDone();
  }

  return (
    <Card>
      <form onSubmit={submit} className="flex flex-col gap-4">
        <Field label="What are you promoting, and to whom?">
          <textarea required rows={3} value={brief} onChange={(e) => setBrief(e.target.value)} className={inputCls} />
        </Field>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Budget (USD)">
            <input inputMode="decimal" value={budget} onChange={(e) => setBudget(e.target.value)} className={`${inputCls} font-mono`} />
          </Field>
          <Field label="Target city (optional)">
            <input value={city} onChange={(e) => setCity(e.target.value)} className={inputCls} />
          </Field>
        </div>
        <fieldset className="flex flex-col gap-2">
          <legend className="text-sm text-muted">Target audience (weights are normalized)</legend>
          {tags.map((t, i) => (
            <div key={i} className="grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)_48px_auto] items-center gap-3">
              <input
                aria-label="Audience tag"
                list="audience-tags"
                value={t.tag}
                onChange={(e) => setTags(tags.map((x, j) => (j === i ? { ...x, tag: e.target.value } : x)))}
                className={inputCls}
              />
              <input
                aria-label={`Weight for ${t.tag || "tag"}`}
                type="range"
                min={0}
                max={100}
                step={5}
                value={t.weight}
                onChange={(e) => setTags(tags.map((x, j) => (j === i ? { ...x, weight: Number(e.target.value) } : x)))}
                className="accent-[var(--color-accent)]"
              />
              <span className="tabular text-right font-mono text-sm text-muted">{total > 0 ? Math.round((t.weight / total) * 100) : 0}%</span>
              <button type="button" className="text-sm text-faint hover:text-fg" onClick={() => setTags(tags.filter((_, j) => j !== i))}>
                Remove
              </button>
            </div>
          ))}
          <datalist id="audience-tags">
            {SUGGESTED_TAGS.map((t) => (
              <option key={t} value={t} />
            ))}
          </datalist>
          {tags.length < 12 && (
            <button type="button" className={`${secondaryBtn} self-start`} onClick={() => setTags([...tags, { tag: "", weight: 20 }])}>
              Add tag
            </button>
          )}
        </fieldset>
        <ErrorLine error={error} />
        <div className="flex gap-2">
          <button type="submit" disabled={busy || !brief.trim()} className={primaryBtn}>
            Create campaign
          </button>
          <button type="button" onClick={onDone} className="px-3 py-2 text-sm text-muted hover:text-fg">
            Cancel
          </button>
        </div>
      </form>
    </Card>
  );
}
