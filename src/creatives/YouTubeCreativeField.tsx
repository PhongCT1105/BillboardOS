import { useState, type FormEvent } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { YOUTUBE_MAX_SECONDS_PER_PLAY, defaultThumbnailUrl, parseYouTubeUrl } from "../../convex/lib/youtube";
import { errorMessage } from "../lib/format";

/**
 * Use a YouTube video as the campaign's ad (ADR 0007): paste a link, see the
 * video it points to, attach it. The review agent checks it for every host
 * and the result shows underneath. Drop-in for the booking page and the
 * customer dashboard.
 */
export function YouTubeCreativeField({
  campaignId,
  disabled = false,
  showReview = true,
  onAttached,
}: {
  campaignId: Id<"campaigns">;
  /** E.g. the campaign's creative is already approved (locked). */
  disabled?: boolean;
  showReview?: boolean;
  onAttached?: (videoId: string) => void;
}) {
  const attach = useMutation(api.creatives.attachYouTube);
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const parsed = url.trim().length > 0 ? parseYouTubeUrl(url) : null;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!parsed?.ok || busy) return;
    setBusy(true);
    setStatus(null);
    try {
      const r = await attach({ campaignId, url: parsed.url });
      setStatus({ tone: "ok", text: "Attached. The review agent is checking it for each host's screens." });
      setUrl("");
      onAttached?.(r.videoId);
    } catch (err) {
      setStatus({ tone: "error", text: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <form onSubmit={submit} className="flex flex-col gap-2">
        <label className="flex flex-col gap-2 text-[13px]">
          <span className="text-muted">Or use a YouTube video</span>
          <div className="flex flex-col gap-2 sm:flex-row">
            <input
              type="url"
              inputMode="url"
              value={url}
              disabled={disabled || busy}
              onChange={(e) => {
                setUrl(e.target.value);
                setStatus(null);
              }}
              placeholder="https://youtu.be/…"
              aria-invalid={parsed ? !parsed.ok : undefined}
              className="min-h-11 min-w-0 flex-1 rounded-md border border-line bg-ink px-3 py-2 text-fg outline-none focus:border-muted disabled:opacity-50"
            />
            <button
              type="submit"
              disabled={disabled || busy || !parsed?.ok}
              className="min-h-11 rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-ink transition-transform active:scale-[0.98] disabled:opacity-50"
            >
              {busy ? "Attaching…" : "Use this video"}
            </button>
          </div>
        </label>
        {parsed && !parsed.ok && (
          <p role="alert" className="text-sm text-danger">
            {parsed.error}
          </p>
        )}
        {parsed?.ok && (
          <div className="flex items-center gap-3 rounded-lg border border-line bg-panel p-2">
            <img
              src={defaultThumbnailUrl(parsed.videoId)}
              alt="Video thumbnail"
              className="aspect-video w-32 shrink-0 rounded object-cover"
            />
            <div className="min-w-0 text-[13px]">
              <p className="text-fg">YouTube video {parsed.videoId}</p>
              <p className="text-muted">
                Plays muted through YouTube's own player, looped, at most {YOUTUBE_MAX_SECONDS_PER_PLAY} s per play.
              </p>
            </div>
          </div>
        )}
        {status && (
          <p role="status" className={`text-sm ${status.tone === "ok" ? "text-muted" : "text-danger"}`}>
            {status.text}
          </p>
        )}
      </form>
      {showReview && <ReviewStatus campaignId={campaignId} />}
    </div>
  );
}

/** What the review agent decided on each host's screens for this campaign's current creative. */
export function ReviewStatus({ campaignId }: { campaignId: Id<"campaigns"> }) {
  const rows = useQuery(api.creativeReview.forMyCampaign, { campaignId });
  if (!rows || rows.length === 0) return null;
  return (
    <ul className="flex flex-col gap-1 text-[13px]" aria-label="Review by host">
      {rows.map((r) => (
        <li key={`${r.workspaceName}-${r.reviewedAt}`} className="flex gap-2">
          <span
            aria-hidden
            className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${
              r.verdict === "approved" ? "bg-ok" : r.verdict === "flagged" ? "bg-danger" : "bg-faint"
            }`}
          />
          <span className="text-muted">
            <span className="text-fg">{r.workspaceName}</span>: {r.label}
          </span>
        </li>
      ))}
    </ul>
  );
}
