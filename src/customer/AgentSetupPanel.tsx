import { useEffect, useRef, useState, type ReactNode } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import {
  BUDGET_DEFAULT_MINOR,
  BUDGET_MAX_MINOR,
  BUDGET_MIN_MINOR,
  BUDGET_STEP_MINOR,
  limitsFromBudget,
} from "../../convex/lib/companyAgent";
import { defaultThumbnailUrl, parseYouTubeUrl } from "../../convex/lib/youtube";
import { ReviewStatus } from "../creatives/YouTubeCreativeField";
import { SEGMENTS } from "../lib/segments";
import { AgentFeed } from "./AgentFeed";
import { Card, ErrorLine, Field, Section, Skeleton, inputCls, primaryBtn, secondaryBtn, useAction } from "./ui";

const usd = (minor: number) => `$${(minor / 100).toFixed(2)}`;
const usdc = (minor: number) => `${(minor / 100).toFixed(2)} USDC`;
const shortAddr = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const segmentLabel = (key: string) => SEGMENTS.find((s) => s.key === key)?.label ?? key;
/** Snap a saved budget onto the slider's range and steps. */
const snapBudget = (minor: number) =>
  Math.min(BUDGET_MAX_MINOR, Math.max(BUDGET_MIN_MINOR, Math.round(minor / BUDGET_STEP_MINOR) * BUDGET_STEP_MINOR));

function SectionHead({ n, children }: { n: number; children: string }) {
  return (
    <h3 className="flex items-center gap-2 text-xs font-semibold tracking-wider text-muted uppercase">
      <span className="tabular flex h-5 w-5 items-center justify-center rounded-full border border-line font-mono text-[11px]">{n}</span>
      {children}
    </h3>
  );
}

type StepState = "done" | "working" | "waiting" | "failed";

function Step({ state, title, children }: { state: StepState; title: string; children?: ReactNode }) {
  const dot = {
    done: "bg-ok",
    working: "animate-pulse bg-accent",
    waiting: "border border-line bg-transparent",
    failed: "bg-amber-400",
  }[state];
  const stateText = { done: "done", working: "working", waiting: "waiting", failed: "needs attention" }[state];
  return (
    <li className="flex gap-3">
      <span aria-hidden className={`mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full ${dot}`} />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <p className={`text-sm ${state === "waiting" ? "text-muted" : "text-fg"}`}>
          {title}
          <span className="sr-only">: {stateText}</span>
        </p>
        {children}
      </div>
    </li>
  );
}

function Tag({ children, tone = "muted" }: { children: ReactNode; tone?: "muted" | "accent" }) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs ${
        tone === "accent" ? "border-accent/60 text-accent" : "border-line text-muted"
      }`}
    >
      {children}
    </span>
  );
}

/** What the automatic pipeline has worked out so far: video, content, profile, audience, review, bidding. */
function AgentLearned({ agent }: { agent: NonNullable<ReturnType<typeof useAgent>> }) {
  const reviews = useQuery(api.creativeReview.forMyCampaign, { campaignId: agent.campaignId as Id<"campaigns"> });
  const video = agent.video;
  const profile = agent.profile;
  const tags = profile
    ? Object.entries(profile.audienceTags as Record<string, number>)
        .filter(([, w]) => w > 0)
        .sort((a, b) => b[1] - a[1])
    : [];

  const videoState: StepState = !video ? "waiting" : video.status === "ok" ? "done" : video.status === "failed" ? "failed" : "working";
  const contentState: StepState = video?.description ? "done" : video && video.status !== "failed" ? "working" : "waiting";
  const profileState: StepState = profile ? "done" : video && video.status !== "failed" ? "working" : "waiting";
  const tagsState: StepState = tags.length > 0 ? "done" : profile?.building || profileState === "working" ? "working" : "waiting";
  const reviewState: StepState =
    reviews && reviews.some((r) => r.verdict === "approved")
      ? "done"
      : reviews && reviews.length > 0 && reviews.every((r) => r.verdict === "flagged")
        ? "failed"
        : video
          ? "working"
          : "waiting";

  return (
    <Card>
      <div className="flex flex-col gap-4">
        <h3 className="text-xs font-semibold tracking-wider text-muted uppercase">What your agent learned</h3>
        <ol className="flex flex-col gap-4" aria-live="polite">
          <Step state={videoState} title="Video found">
            {video?.status === "ok" && (
              <p className="text-[13px] text-muted">
                <span className="text-fg">{video.title ?? "Untitled video"}</span>
                {video.author && <> · {video.author}</>}
              </p>
            )}
            {video?.status === "failed" && (
              <p className="text-[13px] text-amber-300">Couldn't read this video (private or embedding off)</p>
            )}
            {video?.status === "pending" && <p className="text-[13px] text-muted">Looking up the video…</p>}
          </Step>

          <Step state={contentState} title="Content read">
            {video?.description && (
              <p className="text-[13px] text-faint">
                {video.description.length > 160 ? `${video.description.slice(0, 160).trimEnd()}…` : video.description}
              </p>
            )}
          </Step>

          <Step state={profileState} title="Company profile">
            {profile && (
              <>
                <p className="text-[13px] text-muted">{profile.summary}</p>
                <div className="flex flex-wrap items-center gap-1.5">
                  {profile.category && <Tag>{profile.category}</Tag>}
                  {profile.stage && <Tag>{profile.stage}</Tag>}
                  <span className="text-[11px] text-faint">{profile.method === "claude" ? "by Claude" : "quick guess"}</span>
                </div>
                {profile.building && <p className="text-[12px] text-faint">Refining with Claude…</p>}
              </>
            )}
          </Step>

          <Step state={tagsState} title="Ideal customers">
            {tags.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {tags.map(([key, w]) => (
                  <Tag key={key} tone="accent">
                    {segmentLabel(key)} <span className="tabular font-mono">{Math.round(w * 100)}%</span>
                  </Tag>
                ))}
              </div>
            )}
          </Step>

          <Step state={reviewState} title="Approved for screens">
            <ReviewStatus campaignId={agent.campaignId as Id<"campaigns">} />
          </Step>

          <Step state={agent.enabled ? "done" : "waiting"} title="Bidding">
            {agent.lastAction && <p className="text-[13px] text-faint">{agent.lastAction}</p>}
            {!agent.enabled && !agent.lastAction && <p className="text-[13px] text-faint">The agent is off.</p>}
          </Step>
        </ol>
      </div>
    </Card>
  );
}

function useAgent() {
  return useQuery(api.companyAgents.mine, {});
}

export function AgentSetupPanel() {
  const agent = useAgent();
  const quickSetup = useMutation(api.companyAgents.quickSetup);
  const setEnabled = useMutation(api.companyAgents.setEnabled);
  const topUp = useMutation(api.companyAgents.requestTopUp);

  const [videoUrl, setVideoUrl] = useState("");
  const [budget, setBudget] = useState(BUDGET_DEFAULT_MINOR);
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
    if (agent.video?.url) setVideoUrl(agent.video.url);
    if (agent.standing) setBudget(snapBudget(agent.standing.dailyBudgetMinor));
  }, [agent]);

  if (agent === undefined) return <Skeleton h="h-96" />;

  const parsed = videoUrl.trim().length > 0 ? parseYouTubeUrl(videoUrl.trim()) : null;
  const perSpot = limitsFromBudget(budget).maxPerSpotMinor;
  const walletMissing = !agent?.walletAddress;
  const noKeys = !!agent?.lastAction && /no cdp keys/i.test(agent.lastAction);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!parsed) return save.setError("Paste the YouTube link of your ad");
    if (!parsed.ok) return save.setError(parsed.error);
    await save.run(() => quickSetup({ videoUrl: parsed.url, dailyBudgetMinor: budget }));
  }

  async function doTopUp() {
    setTopUpNote(null);
    const ok = await top.run(() => topUp({}));
    if (ok !== undefined) setTopUpNote("Claiming free test USDC from the faucet. It lands in a few seconds.");
  }

  return (
    <Section
      title="Your agent"
      lead="Paste your ad and set a daily limit. We work out who your ad is for and bid on screens where they are."
    >
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <div className="flex min-w-0 flex-col gap-6">
          <Card>
            <form onSubmit={submit} className="flex flex-col gap-6">
              <div className="flex flex-col gap-3">
                <SectionHead n={1}>Your ad video</SectionHead>
                <Field label="YouTube link">
                  <input
                    type="url"
                    inputMode="url"
                    value={videoUrl}
                    onChange={(e) => {
                      setVideoUrl(e.target.value);
                      save.setError(null);
                    }}
                    placeholder="https://youtu.be/…"
                    aria-invalid={parsed ? !parsed.ok : undefined}
                    className={`${inputCls} min-h-11 w-full min-w-0`}
                  />
                </Field>
                {parsed && !parsed.ok && (
                  <p role="alert" className="text-sm text-danger">
                    {parsed.error}
                  </p>
                )}
                {parsed?.ok && (
                  <div className="flex items-center gap-3 rounded-lg border border-line bg-ink p-2">
                    <img
                      src={defaultThumbnailUrl(parsed.videoId)}
                      alt="Video thumbnail"
                      className="aspect-video w-28 shrink-0 rounded object-cover"
                    />
                    <div className="min-w-0 text-[13px]">
                      <p className="truncate text-fg">
                        {agent?.video?.videoId === parsed.videoId && agent.video.title ? agent.video.title : `YouTube video ${parsed.videoId}`}
                      </p>
                      <p className="text-muted">Plays muted on screens through YouTube's own player.</p>
                    </div>
                  </div>
                )}
              </div>

              <div className="flex flex-col gap-3">
                <SectionHead n={2}>Spend limit</SectionHead>
                <div>
                  <p className="tabular font-mono text-3xl font-semibold tracking-tight text-fg">
                    {usd(budget)} <span className="font-sans text-base font-normal text-muted">a day</span>
                  </p>
                  <p className="mt-1 text-sm text-muted">
                    Your agent bids up to <span className="tabular font-mono text-fg">{usd(perSpot)}</span> a spot
                  </p>
                </div>
                <input
                  type="range"
                  min={BUDGET_MIN_MINOR}
                  max={BUDGET_MAX_MINOR}
                  step={BUDGET_STEP_MINOR}
                  value={budget}
                  onChange={(e) => {
                    setBudget(Number(e.target.value));
                    save.setError(null);
                  }}
                  aria-label="Daily spend limit"
                  aria-valuetext={`${usd(budget)} a day`}
                  className="h-11 w-full cursor-pointer touch-pan-y accent-accent"
                />
                <div className="flex justify-between text-xs text-faint">
                  <span className="tabular font-mono">{usd(BUDGET_MIN_MINOR)}</span>
                  <span className="tabular font-mono">{usd(BUDGET_MAX_MINOR)}</span>
                </div>
              </div>

              <div className="flex flex-col gap-2 rounded-md border border-line p-3 text-sm">
                <span className="text-muted">Wallet (test USDC on Base Sepolia)</span>
                {!agent ? (
                  <span className="text-faint">Your agent's wallet is created when you start it.</span>
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

              <ErrorLine error={save.error} />
              <div className="flex flex-wrap gap-2">
                <button type="submit" disabled={save.busy || !parsed?.ok} className={`${primaryBtn} min-h-11`}>
                  {save.busy ? "Saving…" : agent ? "Save and restart agent" : "Start my agent"}
                </button>
                {agent && (
                  <button
                    type="button"
                    disabled={toggle.busy}
                    className={`${agent.enabled ? secondaryBtn : primaryBtn} min-h-11`}
                    onClick={() => toggle.run(() => setEnabled({ enabled: !agent.enabled }))}
                  >
                    {agent.enabled ? "Turn agent off" : "Turn agent on"}
                  </button>
                )}
              </div>
              <p className="text-xs text-faint">
                We read your video, work out who it's for, and your agent bids on screens where those people are.
              </p>
              <ErrorLine error={toggle.error} />
            </form>
          </Card>

          {agent && <AgentLearned agent={agent} />}
        </div>

        <AgentFeed />
      </div>
    </Section>
  );
}
