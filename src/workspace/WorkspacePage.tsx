import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { api } from "../../convex/_generated/api";
import { money, timeOfDay } from "../lib/format";
import { useNow } from "../lib/hooks";
import type { Id } from "../../convex/_generated/dataModel";
import { AddScreenForm } from "../auth/Onboarding";
import { Card, CopyButton, Empty, ErrorLine, Field, Pill, Section, Skeleton, inputCls, primaryBtn, secondaryBtn, useAction } from "../customer/ui";

type Workspace = FunctionReturnType<typeof api.workspaces.get>;

/** Host workspace settings: #/workspace. */
export function WorkspacePage() {
  const workspace = useQuery(api.workspaces.get, {});
  if (workspace === undefined) {
    return (
      <main className="mx-auto max-w-[1100px] px-4 pt-8 md:px-6">
        <Skeleton h="h-64" />
      </main>
    );
  }
  return (
    <main className="mx-auto flex max-w-[1100px] flex-col gap-12 px-4 pt-8 pb-20 md:px-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{workspace.name}</h1>
        <p className="mt-1 text-sm text-muted">
          Workspace settings · {workspace.city} · you are {workspace.myRole === "owner" ? "an owner" : "an operator"}
        </p>
      </div>
      <AutopilotControls workspace={workspace} />
      <Screens />
      <ReadyCreatives />
      <SellerPolicy workspace={workspace} />
      <Team workspace={workspace} />
      <Payout workspace={workspace} />
    </main>
  );
}

function urlFor(path: string) {
  return `${window.location.origin}${window.location.pathname}#${path}`;
}

function Screens() {
  const screens = useQuery(api.billboards.mine, {});
  const [adding, setAdding] = useState(false);
  return (
    <Section
      title="Screens"
      lead="Open the player URL full-screen on the display. The sensor URL runs the people counter on a laptop or phone facing the street."
      action={
        !adding && (
          <button type="button" className={primaryBtn} onClick={() => setAdding(true)}>
            Add screen
          </button>
        )
      }
    >
      {adding && (
        <div className="flex flex-col gap-2">
          <AddScreenForm />
          <button type="button" className="self-start px-1 text-sm text-muted hover:text-fg" onClick={() => setAdding(false)}>
            Done
          </button>
        </div>
      )}
      {screens === undefined ? (
        <Skeleton />
      ) : screens.length === 0 ? (
        <Empty>No screens yet. Add one and 12 hours of 15-minute slots go on sale.</Empty>
      ) : (
        <div className="flex flex-col gap-3">
          {screens.map((s) => (
            <Card key={s._id} className="flex flex-col gap-3">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="font-medium">{s.name}</p>
                  <p className="text-sm text-muted">
                    {s.city} · {s.locationLabel}
                  </p>
                </div>
                <div className="flex items-center gap-3 text-sm">
                  <span className="text-muted">
                    Base <span className="tabular font-mono text-fg">{money(s.baseRateMinor)}</span>
                  </span>
                  <span className="text-muted">
                    Floor <span className="tabular font-mono text-fg">{money(s.reserveFloorMinor)}</span>
                  </span>
                  <Pill tone={s.deviceStatus === "online" ? "ok" : "danger"}>{s.deviceStatus}</Pill>
                </div>
              </div>
              <UrlLine label="Player" url={urlFor(`/player/${s._id}`)} />
              <UrlLine label="Sensor" url={urlFor(`/sensor/${s._id}`)} />
            </Card>
          ))}
        </div>
      )}
    </Section>
  );
}

function UrlLine({ label, url }: { label: string; url: string }) {
  return (
    <div className="grid grid-cols-[64px_minmax(0,1fr)_auto_auto] items-center gap-2 text-sm">
      <span className="text-muted">{label}</span>
      <code className="truncate rounded-md border border-line bg-ink px-2.5 py-1.5 font-mono text-xs text-fg">{url}</code>
      <CopyButton value={url} />
      <a href={url} target="_blank" rel="noreferrer" className={secondaryBtn}>
        Open
      </a>
    </div>
  );
}

function Team({ workspace }: { workspace: Workspace }) {
  const invite = useMutation(api.workspaces.invite);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"operator" | "owner">("operator");
  const [note, setNote] = useState<string | null>(null);
  const { busy, error, run } = useAction();
  const owner = workspace.myRole === "owner";
  return (
    <Section title="Team" lead="Members run the console, finance desk and sensors for this workspace's screens.">
      <div className="overflow-hidden rounded-lg border border-line">
        {workspace.members.map((m, i) => (
          <div key={m.userId} className={`flex items-center justify-between px-4 py-2.5 text-sm ${i ? "border-t border-line" : ""}`}>
            <span>{m.email}</span>
            <Pill tone={m.role === "owner" ? "accent" : "muted"}>{m.role}</Pill>
          </div>
        ))}
      </div>
      {owner ? (
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={async (e) => {
            e.preventDefault();
            setNote(null);
            const res = await run(() => invite({ workspaceId: workspace.workspaceId, email, role }));
            if (res) {
              setNote(res.alreadyMember ? `${email} is already a member.` : `${email} added as ${role}.`);
              setEmail("");
            }
          }}
        >
          <Field label="Invite by sign-up email (they need an account first)" className="min-w-[260px] flex-1">
            <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} className={inputCls} />
          </Field>
          <Field label="Role">
            <select value={role} onChange={(e) => setRole(e.target.value as typeof role)} className={inputCls}>
              <option value="operator">Operator</option>
              <option value="owner">Owner</option>
            </select>
          </Field>
          <button type="submit" disabled={busy || !email.trim()} className={primaryBtn}>
            Add member
          </button>
        </form>
      ) : (
        <p className="text-sm text-muted">Only owners can add members.</p>
      )}
      <ErrorLine error={error} />
      {note && <p role="status" className="text-sm text-muted">{note}</p>}
    </Section>
  );
}

function Payout({ workspace }: { workspace: Workspace }) {
  const save = useMutation(api.workspaces.setPayoutAddress);
  const [address, setAddress] = useState(workspace.payoutAddress ?? "");
  const [saved, setSaved] = useState(false);
  const { busy, error, run } = useAction();
  const owner = workspace.myRole === "owner";
  const dirty = address.trim() !== (workspace.payoutAddress ?? "");
  return (
    <Section title="Payouts" lead="x402 payments for this workspace's screens settle in USDC to this address (Base).">
      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={async (e) => {
          e.preventDefault();
          setSaved(false);
          const ok = await run(async () => {
            await save({ workspaceId: workspace.workspaceId, payoutAddress: address.trim() || null });
            return true;
          });
          if (ok) setSaved(true);
        }}
      >
        <Field label="EVM payout address" className="min-w-[320px] flex-1">
          <input
            value={address}
            disabled={!owner}
            onChange={(e) => {
              setAddress(e.target.value);
              setSaved(false);
            }}
            placeholder="0x..."
            className={`${inputCls} font-mono`}
          />
        </Field>
        {owner && (
          <button type="submit" disabled={busy || !dirty} className={primaryBtn}>
            Save
          </button>
        )}
      </form>
      {!workspace.payoutAddress && <p className="text-xs text-faint">Not set: payments go to the platform's default address.</p>}
      {!owner && <p className="text-sm text-muted">Only owners can change the payout address.</p>}
      <ErrorLine error={error} />
      {saved && <p role="status" className="text-sm text-muted">Saved.</p>}
    </Section>
  );
}

/** Seller agent negotiation policy (ADR 0005). Owners edit; everyone sees it. */
function SellerPolicy({ workspace }: { workspace: Workspace }) {
  const policy = useQuery(api.a2a.negotiationPolicy, { workspaceId: workspace.workspaceId });
  if (policy === undefined) return <Skeleton h="h-40" />;
  return <SellerPolicyForm key={`${policy.floorRatio}:${policy.maxRounds}:${policy.offerTtlSeconds}`} workspace={workspace} policy={policy} />;
}

function SellerPolicyForm({
  workspace,
  policy,
}: {
  workspace: Workspace;
  policy: { floorRatio: number; maxRounds: number; offerTtlSeconds: number; isDefault: boolean };
}) {
  const save = useMutation(api.a2a.setNegotiationPolicy);
  const [floor, setFloor] = useState(Math.round(policy.floorRatio * 100));
  const [rounds, setRounds] = useState(String(policy.maxRounds));
  const [ttl, setTtl] = useState(String(policy.offerTtlSeconds));
  const [saved, setSaved] = useState(false);
  const { busy, error, run } = useAction();
  const owner = workspace.myRole === "owner";
  const dirty = floor !== Math.round(policy.floorRatio * 100) || rounds !== String(policy.maxRounds) || ttl !== String(policy.offerTtlSeconds);
  return (
    <Section
      title="Seller agent"
      lead="Your seller agent negotiates with customers' buying agents. It never agrees below the floor (a share of the live screen price, and never below each screen's price floor); its concessions shrink every round."
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={async (e) => {
          e.preventDefault();
          setSaved(false);
          const ok = await run(async () => {
            await save({ workspaceId: workspace.workspaceId, floorRatio: floor / 100, maxRounds: Number(rounds), offerTtlSeconds: Number(ttl) });
            return true;
          });
          if (ok) setSaved(true);
        }}
      >
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <Field label={`Floor: ${floor}% of screen price`}>
            <input
              type="range"
              min={50}
              max={100}
              step={1}
              value={floor}
              disabled={!owner}
              onChange={(e) => {
                setFloor(Number(e.target.value));
                setSaved(false);
              }}
              className="mt-2 accent-[var(--color-accent)]"
            />
          </Field>
          <Field label="Max offers per negotiation">
            <select value={rounds} disabled={!owner} onChange={(e) => setRounds(e.target.value)} className={inputCls}>
              {Array.from({ length: 10 }, (_, i) => String(i + 1)).map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Each position valid for">
            <select value={ttl} disabled={!owner} onChange={(e) => setTtl(e.target.value)} className={inputCls}>
              {["30", "60", "120", "300", "600", "1800"].map((s) => (
                <option key={s} value={s}>
                  {Number(s) < 60 ? `${s} seconds` : `${Number(s) / 60} minute${s === "60" ? "" : "s"}`}
                </option>
              ))}
            </select>
          </Field>
        </div>
        {owner && (
          <button type="submit" disabled={busy || !dirty} className={`${primaryBtn} self-start`}>
            Save policy
          </button>
        )}
      </form>
      <p className="text-xs text-faint">
        {policy.isDefault ? "Using defaults (90%, 4 offers, 2 minutes). " : ""}Buyer agents see the round limit and offer validity on your agent card; the floor stays private.
      </p>
      {!owner && <p className="text-sm text-muted">Only owners can change the seller agent's policy.</p>}
      <ErrorLine error={error} />
      {saved && <p role="status" className="text-sm text-muted">Saved. New negotiations use it.</p>}
    </Section>
  );
}

/** Ready creatives (ADR 0006): approve a campaign's creative for this host's screens once; flash spots can then play it instantly. */
function ReadyCreatives() {
  const rows = useQuery(api.creatives.readyForWorkspace, {});
  const setReady = useMutation(api.creatives.setReady);
  const { busy, error, run } = useAction();
  return (
    <Section
      title="Ready creatives"
      lead="Creatives you've approved for your screens. Only campaigns with a ready creative get flash offers from your seller agent, and the player preloads them."
    >
      {rows === undefined ? (
        <Skeleton />
      ) : rows.length === 0 ? (
        <Empty>No creatives to review yet.</Empty>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {rows.map((r) => (
            <Card key={r.campaignId} className="flex flex-col gap-3 p-4">
              <div className="aspect-video overflow-hidden rounded-md border border-line bg-ink">
                {r.creativeUrl &&
                  (r.contentType.startsWith("video/") ? (
                    <video src={r.creativeUrl} muted playsInline className="h-full w-full object-cover" />
                  ) : (
                    <img src={r.creativeUrl} alt={`${r.advertiserName} creative`} className="h-full w-full object-cover" />
                  ))}
              </div>
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="font-medium">{r.advertiserName}</p>
                  <p className="truncate text-xs text-faint">{r.brief}</p>
                  {r.agentNote && <p className="text-xs text-muted">{r.agentNote}</p>}
                </div>
                <Pill tone={r.ready ? "ok" : "muted"}>{r.ready ? "ready" : "not ready"}</Pill>
              </div>
              <button
                type="button"
                disabled={busy}
                onClick={() => run(() => setReady({ campaignId: r.campaignId, ready: !r.ready }))}
                className={r.ready ? secondaryBtn : primaryBtn}
              >
                {r.ready ? "Remove from my screens" : "Approve for my screens"}
              </button>
            </Card>
          ))}
        </div>
      )}
      <ErrorLine error={error} />
    </Section>
  );
}

/**
 * Autopilot emergency controls (ADR 0007): pause the seller agent, or sell one
 * slot right now at the fully decayed price. Owners only; operators see the state.
 */
function AutopilotControls({ workspace }: { workspace: Workspace }) {
  const minute = Math.floor(useNow(60_000) / 60_000) * 60_000;
  const status = useQuery(api.autopilot.status, { workspaceId: workspace.workspaceId, atMinute: minute });
  const screens = useQuery(api.billboards.mine, {});
  const setEnabled = useMutation(api.autopilot.setEnabled);
  const sellNow = useMutation(api.autopilot.sellNow);
  const [screenId, setScreenId] = useState<Id<"billboards"> | null>(null);
  const [slotId, setSlotId] = useState<Id<"slots"> | "">("");
  const [note, setNote] = useState<string | null>(null);
  const { busy, error, run } = useAction();
  const owner = workspace.myRole === "owner";
  const billboardId = screenId ?? screens?.[0]?._id ?? null;
  const outlook = useQuery(
    api.autopilot.outlook,
    billboardId ? { billboardId, from: minute, to: minute + 12 * 60 * 60_000, atMinute: minute } : "skip",
  );
  const sellable = (outlook?.slots ?? []).filter((s) => s.state === "available" && !s.inAuction && s.startAt > minute + 60_000);

  if (status === undefined) return <Skeleton h="h-40" />;
  return (
    <Section
      title="Autopilot"
      lead="On by default: every minute the seller agent prices the next 12 hours from its forecast and offers each unsold slot to the company agents that fit. These are emergency controls."
    >
      <Card className="flex flex-col gap-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-col gap-1">
            <div className="flex items-center gap-2">
              <span className="font-medium">Seller agent</span>
              {status.enabled ? <Pill tone="ok">On</Pill> : <Pill tone="danger">Paused</Pill>}
            </div>
            <p className="text-sm text-muted">{status.doing}</p>
          </div>
          {owner && (
            <button
              type="button"
              disabled={busy}
              className={status.enabled ? secondaryBtn : primaryBtn}
              onClick={async () => {
                setNote(null);
                const ok = await run(async () => {
                  await setEnabled({ workspaceId: workspace.workspaceId, enabled: !status.enabled });
                  return true;
                });
                if (ok) setNote(status.enabled ? "Paused: open offers were withdrawn." : "Back on: planning the next 12 hours now.");
              }}
            >
              {status.enabled ? "Pause autopilot" : "Turn autopilot back on"}
            </button>
          )}
        </div>

        <div className="flex flex-col gap-3 border-t border-line pt-5">
          <div>
            <p className="font-medium">Sell this slot now</p>
            <p className="text-sm text-muted">
              Offers one slot right away to every company agent that fits, at the lowest price the autopilot would reach (never below the screen's floor). First agent to accept gets it. Works while paused.
            </p>
          </div>
          {owner ? (
            <form
              className="flex flex-wrap items-end gap-3"
              onSubmit={async (e) => {
                e.preventDefault();
                if (!slotId) return;
                setNote(null);
                const r = await run(() => sellNow({ slotId }));
                if (r) {
                  setNote(`Offered at ${money(r.priceMinor)} to ${r.companies} compan${r.companies === 1 ? "y" : "ies"}.`);
                  setSlotId("");
                }
              }}
            >
              {screens && screens.length > 1 && (
                <Field label="Screen">
                  <select
                    className={inputCls}
                    value={billboardId ?? ""}
                    onChange={(e) => {
                      setScreenId(e.target.value as Id<"billboards">);
                      setSlotId("");
                    }}
                  >
                    {screens.map((b) => (
                      <option key={b._id} value={b._id}>
                        {b.name}
                      </option>
                    ))}
                  </select>
                </Field>
              )}
              <Field label="Slot" className="min-w-[220px]">
                <select className={inputCls} value={slotId} onChange={(e) => setSlotId(e.target.value as Id<"slots">)}>
                  <option value="">{outlook === undefined ? "Loading slots..." : sellable.length === 0 ? "No unsold slots" : "Pick an unsold slot"}</option>
                  {sellable.map((s) => (
                    <option key={s.slotId} value={s.slotId}>
                      {timeOfDay(s.startAt)}
                      {s.priceMinor !== null ? ` · listed ${money(s.priceMinor)}` : ""}
                      {s.expectedPeople !== null ? ` · ~${Math.round(s.expectedPeople)} people` : ""}
                    </option>
                  ))}
                </select>
              </Field>
              <button type="submit" disabled={busy || !slotId} className={primaryBtn}>
                Sell this slot now
              </button>
            </form>
          ) : (
            <p className="text-sm text-muted">Only owners can pause the autopilot or sell a slot now.</p>
          )}
        </div>
        <ErrorLine error={error} />
        {note && (
          <p role="status" className="text-sm text-muted">
            {note}
          </p>
        )}
      </Card>
    </Section>
  );
}
