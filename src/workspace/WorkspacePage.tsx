import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { api } from "../../convex/_generated/api";
import { money } from "../lib/format";
import { PairScreenForm } from "../screens/PairScreenForm";
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
      <Screens />
      <ReadyCreatives />
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
      lead={`Each screen is one real device: open ${urlFor("/screen")} on it and pair it with the code it shows. The sensor URL runs the people counter on a laptop or phone facing the street.`}
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
          <PairScreenForm onDone={() => setAdding(false)} />
          <button type="button" className="self-start px-1 text-sm text-muted hover:text-fg" onClick={() => setAdding(false)}>
            Done
          </button>
        </div>
      )}
      {screens === undefined ? (
        <Skeleton />
      ) : screens.length === 0 ? (
        <Empty>No screens yet. Pair a device; once it's online, company agents get offers for the spot on air.</Empty>
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
                    Floor <span className="tabular font-mono text-fg">{money(s.reserveFloorMinor)}</span>
                  </span>
                  <Pill tone={s.deviceStatus === "online" ? "ok" : "danger"}>{s.deviceStatus}</Pill>
                </div>
              </div>
              {s.audienceSummary && <p className="text-sm text-muted">Who is here: {s.audienceSummary}</p>}
              <UrlLine label="Preview" url={urlFor(`/player/${s._id}`)} />
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

