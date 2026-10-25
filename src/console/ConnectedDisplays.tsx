import { useState, type ReactNode } from "react";
import { useQuery } from "convex/react";
import { ArrowRight, CaretRight, MagnifyingGlass, Monitor, Timer, WarningCircle } from "@phosphor-icons/react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { countdown, money } from "../lib/format";
import { useNow } from "../lib/hooks";

export type ConnectedDisplay = {
  id: string;
  name: string;
  city: string;
  online: boolean;
  resolution?: string;
  floorMinor?: number;
};

export function ConnectedDisplays({ displays, autoSell, renderPreview, sample = false }: {
  displays: ConnectedDisplay[];
  autoSell?: boolean;
  renderPreview?: (display: ConnectedDisplay) => ReactNode;
  sample?: boolean;
}) {
  const [filter, setFilter] = useState("all");
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState(false);
  const online = displays.filter((d) => d.online).length;
  const filtered = displays.filter((d) => (filter === "all" || (filter === "online" ? d.online : !d.online))
    && `${d.name} ${d.city}`.toLowerCase().includes(query.trim().toLowerCase()));
  const visible = expanded ? filtered : filtered.slice(0, 4);
  return (
    <section className="connected-displays" id="connected-displays" aria-labelledby="connected-heading">
      <div className="connected-toolbar">
        <div className="connected-filters">
          <h2 id="connected-heading">Connected Displays</h2>
          <div className="segmented-control" aria-label="Filter displays by status">
            {[["all", "All", displays.length], ["online", "Online", online], ["attention", "Attention", displays.length - online]].map(([key, label, count]) => (
              <button key={key} type="button" aria-pressed={filter === key} onClick={() => { setFilter(String(key)); setExpanded(false); }}>
                {label} <span>({count})</span>
              </button>
            ))}
          </div>
        </div>
        <label className="connected-search"><MagnifyingGlass size={18} /><input aria-label="Filter displays" placeholder="Filter displays…" value={query} onChange={(e) => { setQuery(e.target.value); setExpanded(false); }} /></label>
      </div>
      <div className="connected-list">
        {visible.map((display) => (
          <article className="connected-card" key={display.id}>
            <div className="connected-card-heading">
              <div className="connected-name"><i className={`status-dot ${display.online ? "online" : "attention"}`} /><h3>{display.name}</h3>{display.resolution && <span className="resolution-chip">{display.resolution}</span>}</div>
              <div className="connected-state"><span className={display.online ? "status-online" : "status-attention"}>{display.online ? "Online" : "Attention"}</span><span className="state-divider" />{display.online ? <span className="text-accent">{autoSell === undefined ? "Connected" : autoSell ? "Auto-sell Active" : "Auto-sell Off"}</span> : <span>Offline</span>}</div>
            </div>
            {display.online ? (renderPreview ? renderPreview(display) : <LiveDisplayCreative display={display} />) : (
              <div className="offline-panel">
                <WarningCircle size={25} />
                <div><strong>Display offline</strong><p>{display.city} · Check the device connection</p></div>
                {sample ? <details className="offline-help"><summary>Details</summary><p>Sample offline display. Reconnect its device to resume playback.</p></details> : <a href={`#/player/${display.id}`} target="_blank" rel="noreferrer">Inspect Display <CaretRight size={16} /></a>}
              </div>
            )}
          </article>
        ))}
        {filtered.length === 0 && <div className="connected-empty"><Monitor size={30} /><h3>{displays.length ? "No matching displays" : "No displays yet"}</h3><p>{displays.length ? "Try another search or status filter." : "Add your first display to get started."}</p>{displays.length > 0 && <button onClick={() => { setFilter("all"); setQuery(""); }}>Clear filters</button>}</div>}
      </div>
      {filtered.length > 4 && <button className="view-displays" onClick={() => setExpanded(!expanded)}>{expanded ? "Show fewer displays" : `View all ${filtered.length} displays`}<ArrowRight size={18} /></button>}
    </section>
  );
}

export function DisplayCreative({ display, title, imageUrl, videoUrl, note, endsAt, loading = false, sample = false }: {
  display: ConnectedDisplay;
  title: string;
  imageUrl?: string | null;
  videoUrl?: string | null;
  note?: string;
  endsAt?: number;
  loading?: boolean;
  sample?: boolean;
}) {
  const now = useNow(1000);
  const [failedSource, setFailedSource] = useState<string | null>(null);
  const source = imageUrl || videoUrl;
  const hasMedia = source && failedSource !== source;
  const [inspect, setInspect] = useState(false);
  return <>
    <div className="creative-panel">
      <div className="creative-thumbnail">
        {hasMedia && imageUrl ? <img src={imageUrl} alt={title} onError={() => setFailedSource(imageUrl)} /> : hasMedia && videoUrl ? <video src={videoUrl} controls muted playsInline preload="metadata" onError={() => setFailedSource(videoUrl)} /> : <div className={`creative-idle ${loading ? "animate-pulse" : ""}`}><Monitor size={30} /><span>{loading ? "Loading preview" : source ? "Preview unavailable" : "No ad playing"}</span></div>}
        {hasMedia && <span className="creative-media-label">{sample ? "SAMPLE CREATIVE" : "AD PREVIEW"}</span>}
      </div>
      <div className="creative-information">
        <div className="creative-meta"><span>Current Creative</span>{endsAt && endsAt > now && <span className="creative-timer"><Timer size={13} />{countdown(endsAt, now)}</span>}</div>
        <h4>{title}</h4><p>{note ?? display.city}</p>
        <div className="creative-bottom"><span>{display.floorMinor !== undefined ? `Floor price: ${money(display.floorMinor)}` : display.city}</span>{sample ? <button onClick={() => setInspect(!inspect)} aria-expanded={inspect}>Inspect Display <CaretRight size={16} /></button> : <a href={`#/player/${display.id}`} target="_blank" rel="noreferrer">Inspect Display <CaretRight size={16} /></a>}</div>
      </div>
    </div>
    {inspect && <div className="sample-inspector"><strong>{display.name}</strong><span>{display.city} · {display.resolution ?? "Display preview"} · Sample data</span><button onClick={() => setInspect(false)}>Close preview</button></div>}
  </>;
}

function LiveDisplayCreative({ display }: { display: ConnectedDisplay }) {
  const now = useNow(5000);
  const billboardId = display.id as Id<"billboards">;
  const live = useQuery(api.player.screenState, { billboardId });
  const state = useQuery(api.player.nowPlaying, { billboardId, atMinute: Math.floor(now / 60000) * 60000 });
  const current = state?.current;
  const scheduled = current && current.startAt <= now && current.endAt > now && (current.state === "scheduled" || current.state === "played") ? current : null;
  const window = live?.windows.find((w) => w.status === "paid" && w.spotStartAt <= now && now < w.spotEndAt);
  const youtubeId = scheduled?.youtubeVideoId ?? window?.creative?.youtubeVideoId;
  const imageUrl = youtubeId ? `https://i.ytimg.com/vi/${encodeURIComponent(youtubeId)}/hqdefault.jpg` : scheduled?.creativeUrl && !scheduled.contentType?.startsWith("video/") ? scheduled.creativeUrl : null;
  return <DisplayCreative display={display} loading={live === undefined || state === undefined}
    title={scheduled?.creativeTitle ?? window?.creative?.title ?? (live?.bidding ? "Bidding in progress" : "No scheduled creative")}
    imageUrl={imageUrl} videoUrl={!youtubeId && scheduled?.contentType?.startsWith("video/") ? scheduled.creativeUrl : null}
    endsAt={scheduled?.endAt ?? window?.spotEndAt}
    note={scheduled?.advertiserName ?? window?.company ?? display.city} />;
}
