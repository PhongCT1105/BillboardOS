import { useState } from "react";
import { useQuery } from "convex/react";
import {
  ArrowUpRight,
  MagnifyingGlass,
  MapPin,
  Monitor,
  Play,
} from "@phosphor-icons/react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { useNow } from "../lib/hooks";
import { DashboardSkeleton } from "./ui";

export type Display = {
  id: string;
  name: string;
  city: string;
  online: boolean;
};

export function Displays({
  displays,
  host = false,
  sample = false,
}: {
  displays: Display[];
  host?: boolean;
  sample?: boolean;
}) {
  const [query, setQuery] = useState("");
  const [onlyOnline, setOnlyOnline] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const filtered = displays.filter(
    (d) =>
      (!onlyOnline || d.online) &&
      `${d.name} ${d.city}`.toLowerCase().includes(query.toLowerCase()),
  );
  const display = filtered.find((d) => d.id === selected) ?? filtered[0];
  return (
    <section aria-labelledby="displays-heading" className="demo-displays">
      <div className="demo-section-heading">
        <div>
          <h2 id="displays-heading">
            {host ? "Your displays" : "Find your next display"}
          </h2>
          <p>
            {host
              ? "Your screens and what’s showing."
              : "A real place for your next campaign."}
          </p>
        </div>
        <span className="demo-count">
          {displays.length} {displays.length === 1 ? "display" : "displays"}
        </span>
      </div>
      <div className="demo-display-toolbar">
        <label>
          <MagnifyingGlass size={17} />
          <input
            aria-label="Search displays"
            placeholder="Search by name or city"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        <button
          type="button"
          className={`demo-filter ${onlyOnline ? "is-active" : ""}`}
          aria-pressed={onlyOnline}
          onClick={() => setOnlyOnline(!onlyOnline)}
        >
          Online only
        </button>
      </div>
      <div className="demo-display-layout">
        <div className="demo-display-list">
          {filtered.length === 0 ? (
            <div className="demo-empty">
              <Monitor size={28} />
              <h3>
                {displays.length ? "No matching displays" : "No displays yet"}
              </h3>
              <p>
                {displays.length
                  ? "Try another search or turn off the online filter."
                  : host
                    ? "Add a screen below to get started."
                    : "Available screens will appear here."}
              </p>
            </div>
          ) : (
            filtered.map((d) => (
              <button
                type="button"
                key={d.id}
                className={`demo-display-row ${display?.id === d.id ? "is-selected" : ""}`}
                onClick={() => setSelected(d.id)}
                aria-pressed={display?.id === d.id}
              >
                <span className="demo-display-icon">
                  <Monitor size={23} />
                </span>
                <span className="demo-display-name">
                  <strong>{d.name}</strong>
                  <span>
                    <MapPin size={12} />
                    {d.city}
                  </span>
                </span>
                <span className={`demo-status ${d.online ? "is-online" : ""}`}>
                  <i />
                  {d.online ? "Online" : "Offline"}
                </span>
                <ArrowUpRight size={16} className="demo-row-arrow" />
              </button>
            ))
          )}
        </div>
        <div className="demo-preview">
          {display ? (
            <>
              <div className="demo-preview-label">
                <span>
                  <Play size={13} weight="fill" />
                  {sample ? "Sample creative" : "Display preview"}
                </span>
                <span>{display.city}</span>
              </div>
              {sample ? (
                <img
                  src="/demo-creatives/golden-gate-coffee.svg"
                  alt="Sample Golden Gate Coffee advertisement"
                  className="demo-preview-media"
                />
              ) : (
                <LivePreview
                  key={display.id}
                  billboardId={display.id as Id<"billboards">}
                />
              )}
              <div className="demo-preview-footer">
                <div>
                  <strong>{display.name}</strong>
                  <span>
                    {sample
                      ? "Illustrative display · sample data"
                      : "Preview only · no playback recorded"}
                  </span>
                </div>
                <a
                  href={
                    sample
                      ? "#/signin"
                      : host
                        ? `#/player/${display.id}`
                        : `#/book?billboard=${display.id}`
                  }
                  className="demo-button demo-button-small"
                  target={host && !sample ? "_blank" : undefined}
                  rel={host && !sample ? "noreferrer" : undefined}
                >
                  {host ? "Open display" : "Book ad time"}
                  <ArrowUpRight size={16} />
                </a>
              </div>
            </>
          ) : (
            <div className="demo-empty">
              <Monitor size={32} />
              <p>Select a display to see its preview.</p>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function LivePreview({ billboardId }: { billboardId: Id<"billboards"> }) {
  const now = useNow(5000);
  const [mediaFailed, setMediaFailed] = useState(false);
  const live = useQuery(api.player.screenState, { billboardId });
  const state = useQuery(api.player.nowPlaying, {
    billboardId,
    atMinute: Math.floor(now / 60000) * 60000,
  });
  const current = state?.current;
  const playable =
    current &&
    current.startAt <= now &&
    current.endAt > now &&
    (current.state === "scheduled" || current.state === "played");
  if (state === undefined || live === undefined)
    return (
      <div
        className="demo-preview-placeholder animate-pulse"
        aria-label="Loading display preview"
      />
    );
  if (mediaFailed)
    return (
      <div className="demo-preview-placeholder">
        <Monitor size={26} />
        <strong>Preview unavailable</strong>
        <span>Open the display to view the current ad.</span>
      </div>
    );
  const livePlaying =
    live.windows.find((w) => w.status === "paid" && w.spotStartAt <= now && now < w.spotEndAt) ?? null;
  if (!livePlaying && !playable)
    return (
      <div className="demo-preview-placeholder">
        <Monitor size={26} />
        <strong>{live.bidding ? "Finding the next ad." : "Your ad here."}</strong>
        <span>
          {live.bidding
            ? `${live.bidding.offered} ${live.bidding.offered === 1 ? "company is" : "companies are"} bidding for the next 30 seconds.`
            : "A new campaign is on its way to this display."}
        </span>
      </div>
    );
  const youtubeVideoId = playable
    ? current.youtubeVideoId
    : livePlaying?.creative?.youtubeVideoId;
  if (youtubeVideoId)
    return (
      <img
        className="demo-preview-media"
        src={`https://i.ytimg.com/vi/${encodeURIComponent(youtubeVideoId)}/hqdefault.jpg`}
        alt={
          current?.creativeTitle ??
          livePlaying?.creative?.title ??
          "Current video advertisement thumbnail"
        }
        onError={() => setMediaFailed(true)}
      />
    );
  if (
    playable &&
    current.creativeUrl &&
    !current.contentType?.startsWith("video/")
  )
    return (
      <img
        className="demo-preview-media"
        src={current.creativeUrl}
        onError={() => setMediaFailed(true)}
        alt={
          current.creativeTitle ??
          current.advertiserName ??
          "Current advertisement"
        }
      />
    );
  if (playable && current.creativeUrl)
    return (
      <video
        className="demo-preview-media"
        src={current.creativeUrl}
        muted
        playsInline
        controls
        preload="metadata"
        onError={() => setMediaFailed(true)}
      />
    );
  return (
    <div className="demo-preview-placeholder">
      <Monitor size={26} />
      <strong>
        {playable
          ? (current.advertiserName ?? "Advertisement scheduled")
          : (livePlaying?.company ?? "Your ad here.")}
      </strong>
      <span>
        {playable || livePlaying
          ? "Open the display to see playback."
          : "Ready for the next great local brand."}
      </span>
    </div>
  );
}

export function DisplayBrowser() {
  const displays = useQuery(api.billboards.list, {});
  if (!displays) return <DashboardSkeleton />;
  return (
    <Displays
      displays={displays.map((d) => ({
        id: d._id,
        name: d.name,
        city: d.city,
        online: d.deviceStatus === "online",
      }))}
    />
  );
}
