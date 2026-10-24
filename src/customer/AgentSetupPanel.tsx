import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { SEGMENTS } from "../lib/segments";
import { words } from "../lib/format";
import { AgentFeed } from "./AgentFeed";
import { Card, ErrorLine, Field, Section, Skeleton, inputCls, parseUsd, primaryBtn, secondaryBtn, useAction } from "./ui";

const MAX_REACH = 10000;
const usdText = (minor: number) => (minor / 100).toFixed(2);
const usdc = (minor: number) => `${(minor / 100).toFixed(2)} USDC`;
const shortAddr = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

function SectionHead({ n, children }: { n: number; children: string }) {
  return (
    <h3 className="flex items-center gap-2 text-xs font-semibold tracking-wider text-muted uppercase">
      <span className="tabular flex h-5 w-5 items-center justify-center rounded-full border border-line font-mono text-[11px]">{n}</span>
      {children}
    </h3>
  );
}

export function AgentSetupPanel() {
  const campaigns = useQuery(api.campaigns.list, {});
  const agent = useQuery(api.companyAgents.mine, {});
  const setup = useMutation(api.companyAgents.setup);
  const setEnabled = useMutation(api.companyAgents.setEnabled);
  const topUp = useMutation(api.companyAgents.requestTopUp);

  const [campaignId, setCampaignId] = useState<string>("");
  const [picked, setPicked] = useState<string[]>([]);
  const [reach, setReach] = useState("3");
  const [maxSpot, setMaxSpot] = useState("1.50");
  const [daily, setDaily] = useState("5.00");
  const [topUpNote, setTopUpNote] = useState<string | null>(null);
  const seeded = useRef(false);
  const save = useAction();
  const toggle = useAction();
  const top = useAction();

  // Prefill once from the saved agent so reconfiguring starts from what is live.
  useEffect(() => {
    if (seeded.current || agent === undefined) return;
    seeded.current = true;
    if (!agent) return;
    setCampaignId(agent.campaignId);
    if (agent.targetAudience) setPicked(Object.keys(agent.targetAudience).filter((k) => SEGMENTS.some((s) => s.key === k)));
    if (agent.standing) {
      setReach(String(agent.standing.minRelevantViewers));
      setMaxSpot(usdText(agent.standing.maxPricePerSpotMinor));
      setDaily(usdText(agent.standing.dailyBudgetMinor));
    }
  }, [agent]);

  useEffect(() => {
    if (!campaignId && campaigns && campaigns.length > 0 && agent !== undefined && !agent) setCampaignId(campaigns[0]._id);
  }, [campaigns, campaignId, agent]);

  if (campaigns === undefined || agent === undefined) return <Skeleton h="h-96" />;

  const campaign = campaigns.find((c) => c._id === campaignId);
  const campaignValid = campaign !== undefined;
  const staleCampaign = !!agent && !campaignValid;
  const walletMissing = !agent?.walletAddress;
  const noKeys = !!agent?.lastAction && /no cdp keys/i.test(agent.lastAction);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const maxPerSpotMinor = parseUsd(maxSpot);
    const dailyBudgetMinor = parseUsd(daily);
    const reachText = reach.trim();
    const minRelevantViewers = /^\d+$/.test(reachText) ? Number(reachText) : NaN;
    if (!campaignValid) return save.setError("Pick the campaign whose ad the agent should run");
    if (picked.length === 0) return save.setError("Pick at least one kind of customer");
    if (!Number.isFinite(minRelevantViewers) || minRelevantViewers < 1 || minRelevantViewers > MAX_REACH)
      return save.setError(`Reach target must be a whole number from 1 to ${MAX_REACH}`);
    if (maxPerSpotMinor === null) return save.setError("Max per spot must be a positive dollar amount");
    if (dailyBudgetMinor === null) return save.setError("Daily budget must be a positive dollar amount");
    if (maxPerSpotMinor > dailyBudgetMinor) return save.setError("Max per spot can't be more than the daily budget");
    const targetAudience = Object.fromEntries(picked.map((k) => [k, 1 / picked.length]));
    await save.run(() =>
      setup({ campaignId: campaignId as Id<"campaigns">, targetAudience, minRelevantViewers, maxPerSpotMinor, dailyBudgetMinor }),
    );
  }

  async function doTopUp() {
    setTopUpNote(null);
    const ok = await top.run(() => topUp({}));
    if (ok !== undefined) setTopUpNote("Claiming free test USDC from the faucet. It lands in a few seconds.");
  }

  return (
    <Section
      title="Bidding agent"
      lead="Set this up once. Our server then runs your agent: it listens for screens, bids within your limits and pays from its own wallet. You can watch it on the right."
    >
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Card>
          <form onSubmit={submit} className="flex flex-col gap-6">
            <div className="flex flex-col gap-3">
              <SectionHead n={1}>Your ad</SectionHead>
              {campaigns.length === 0 ? (
                <p className="text-sm text-muted">
                  No campaigns yet. <a href="#/customer/campaigns" className="text-fg underline underline-offset-4">Create one</a> and upload its ad first.
                </p>
              ) : (
                <>
                  <Field label="Campaign">
                    <select value={campaignValid ? campaignId : ""} onChange={(e) => setCampaignId(e.target.value)} className={inputCls}>
                      {!campaignValid && <option value="" disabled>Select a campaign…</option>}
                      {campaigns.map((c) => (
                        <option key={c._id} value={c._id}>
                          {c.brief.length > 60 ? `${c.brief.slice(0, 60)}…` : c.brief}
                        </option>
                      ))}
                    </select>
                  </Field>
                  {staleCampaign && (
                    <p role="alert" className="text-xs text-amber-300">
                      Your agent's campaign is no longer active, pick another.
                    </p>
                  )}
                  {campaign && (
                    <p className={`text-xs ${campaign.creativeStatus === "approved" ? "text-emerald-300" : "text-amber-300"}`}>
                      {campaign.creativeStatus === "approved"
                        ? "Ad video approved by host. Ready to play."
                        : `Ad video: ${words(campaign.creativeStatus ?? "none")}. It must be approved before it can play.`}
                    </p>
                  )}
                </>
              )}
            </div>

            <div className="flex flex-col gap-3">
              <SectionHead n={2}>Ideal customer profile</SectionHead>
              <div className="flex flex-wrap gap-2" role="group" aria-label="Who do you want to reach?">
                {SEGMENTS.map((s) => {
                  const on = picked.includes(s.key);
                  return (
                    <button
                      key={s.key}
                      type="button"
                      aria-pressed={on}
                      onClick={() => setPicked(on ? picked.filter((k) => k !== s.key) : [...picked, s.key])}
                      className={`rounded-full border px-3 py-1 text-xs transition-colors ${
                        on ? "border-accent bg-accent/15 font-semibold text-accent" : "border-line text-muted hover:border-muted hover:text-fg"
                      }`}
                    >
                      {s.label}
                    </button>
                  );
                })}
              </div>
              <p className="text-xs text-faint">Matched against the event at the venue and the screen's audience profile. The camera only counts people.</p>
            </div>

            <div className="flex flex-col gap-3">
              <SectionHead n={3}>Reach target</SectionHead>
              <Field label="Only bid when at least this many matching people are in front of the screen">
                <input inputMode="numeric" value={reach} onChange={(e) => setReach(e.target.value)} className={`${inputCls} w-24 font-mono`} />
              </Field>
            </div>

            <div className="flex flex-col gap-3">
              <SectionHead n={4}>Spending limits</SectionHead>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Field label="Max per spot (USD)" hint="Never bids above this">
                  <input inputMode="decimal" value={maxSpot} onChange={(e) => setMaxSpot(e.target.value)} className={`${inputCls} font-mono`} />
                </Field>
                <Field label="Daily budget (USD)" hint="Stops for the day after">
                  <input inputMode="decimal" value={daily} onChange={(e) => setDaily(e.target.value)} className={`${inputCls} font-mono`} />
                </Field>
              </div>
              <div className="flex flex-col gap-2 rounded-md border border-line p-3 text-sm">
                <span className="text-muted">Wallet (test USDC on Base Sepolia)</span>
                {!agent ? (
                  <span className="text-faint">Your agent's wallet is created when you save.</span>
                ) : noKeys && walletMissing ? (
                  <span className="text-amber-300">Wallet unavailable (server has no Coinbase keys)</span>
                ) : walletMissing ? (
                  <span className="text-muted">Setting up wallet…</span>
                ) : (
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <span>
                      <span className="tabular font-mono font-semibold text-fg">{usdc(agent.balanceMinor ?? 0)}</span>
                      <span className="text-muted"> · </span>
                      <span className="font-mono text-muted" title={agent.walletAddress ?? undefined}>{shortAddr(agent.walletAddress ?? "")}</span>
                    </span>
                    <button type="button" className={secondaryBtn} disabled={top.busy} onClick={doTopUp} title="Claims free test USDC from the Coinbase faucet (5 a day)">
                      {top.busy ? "Requesting…" : "Top up"}
                    </button>
                  </div>
                )}
                {agent && !walletMissing && (
                  <span className="text-xs text-faint">Top up claims free test USDC from the faucet into this wallet, up to 5 times a day.</span>
                )}
                <ErrorLine error={top.error} />
                {topUpNote && !top.error && <span className="text-xs text-emerald-300">{topUpNote}</span>}
              </div>
            </div>

            <ErrorLine error={save.error} />
            <div className="flex flex-wrap gap-2">
              <button type="submit" disabled={save.busy || campaigns.length === 0} className={primaryBtn}>
                {save.busy ? "Saving…" : agent?.enabled ? "Save and restart agent" : "Save and turn agent on"}
              </button>
              {agent && (
                <button
                  type="button"
                  disabled={toggle.busy}
                  className={agent.enabled ? secondaryBtn : primaryBtn}
                  onClick={() => toggle.run(() => setEnabled({ enabled: !agent.enabled }))}
                >
                  {agent.enabled ? "Turn agent off" : "Turn agent on"}
                </button>
              )}
            </div>
            <p className="text-xs text-faint">
              {agent?.enabled
                ? "Saving applies your changes and restarts the agent with a fresh key."
                : agent
                  ? "The agent is off. Saving applies your changes and turns it on."
                  : "Saving creates your agent and its wallet, and turns it on."}
            </p>
            <ErrorLine error={toggle.error} />
          </form>
        </Card>

        <AgentFeed />
      </div>
    </Section>
  );
}
