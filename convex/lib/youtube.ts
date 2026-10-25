/**
 * YouTube creatives (ADR 0007 section 4). Pure helpers shared by the backend
 * and the browser: strict URL parsing to an 11-character video id, the
 * official embed URL, the public thumbnail and oEmbed validation. We never
 * download or re-host the video; the player uses YouTube's embedded player.
 */

/** `campaigns.creativeContentType` marker for a YouTube creative (no storage file). */
export const YOUTUBE_CONTENT_TYPE = "youtube";

/** Ads play at most 30 s per loop (policy text; the embed is not cut). */
export const YOUTUBE_MAX_SECONDS_PER_PLAY = 30;

const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;
const MAX_URL_LENGTH = 2048;

const WATCH_HOSTS = new Set(["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com"]);
const NOCOOKIE_HOSTS = new Set(["youtube-nocookie.com", "www.youtube-nocookie.com"]);
const SHORT_HOSTS = new Set(["youtu.be", "www.youtu.be"]);
/** Path prefixes on youtube.com that carry the id as the next segment. */
const PATH_KINDS = new Set(["shorts", "embed", "live", "v"]);

export type ParsedYouTube = { ok: true; videoId: string; url: string } | { ok: false; error: string };

export function isVideoId(id: string): boolean {
  return VIDEO_ID_RE.test(id);
}

/** Canonical watch URL for a video id (what we store and send to oEmbed). */
export function watchUrl(videoId: string): string {
  return `https://www.youtube.com/watch?v=${videoId}`;
}

/**
 * Parse a YouTube link (watch, youtu.be, shorts, embed, live) into its video
 * id. Strict: http(s) only, known YouTube hosts only, an 11-character id.
 */
export function parseYouTubeUrl(input: string): ParsedYouTube {
  const raw = input.trim();
  if (raw.length === 0) return { ok: false, error: "Paste a YouTube link" };
  if (raw.length > MAX_URL_LENGTH) return { ok: false, error: "That link is too long" };
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return { ok: false, error: "That isn't a valid link" };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return { ok: false, error: "Use an http(s) YouTube link" };
  if (url.username || url.password) return { ok: false, error: "That isn't a YouTube link" };
  const host = url.hostname.toLowerCase();
  const segments = url.pathname.split("/").filter((s) => s.length > 0);

  let id: string | null = null;
  if (SHORT_HOSTS.has(host)) {
    id = segments.length === 1 ? segments[0] : null;
  } else if (WATCH_HOSTS.has(host) || NOCOOKIE_HOSTS.has(host)) {
    if (segments.length === 1 && segments[0] === "watch" && !NOCOOKIE_HOSTS.has(host)) {
      id = url.searchParams.get("v");
    } else if (segments.length === 2 && PATH_KINDS.has(segments[0])) {
      if (NOCOOKIE_HOSTS.has(host) && segments[0] !== "embed") id = null;
      else id = segments[1];
    }
  } else {
    return { ok: false, error: "That isn't a YouTube link" };
  }
  if (!id || !VIDEO_ID_RE.test(id)) return { ok: false, error: "Couldn't find a video in that YouTube link" };
  return { ok: true, videoId: id, url: watchUrl(id) };
}

/** Official privacy-enhanced embed: autoplay, muted, looped, no controls. */
export function embedUrl(videoId: string, origin?: string): string {
  if (!VIDEO_ID_RE.test(videoId)) throw new Error("invalid video id");
  const params = new URLSearchParams({
    autoplay: "1",
    mute: "1",
    loop: "1",
    playlist: videoId,
    controls: "0",
    playsinline: "1",
    modestbranding: "1",
    enablejsapi: "1",
  });
  if (origin) params.set("origin", origin);
  return `https://www.youtube-nocookie.com/embed/${videoId}?${params.toString()}`;
}

/** Public thumbnail (no API call needed); oEmbed may replace it with its own. */
export function defaultThumbnailUrl(videoId: string): string {
  return `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
}

export function oembedUrl(videoId: string): string {
  return `https://www.youtube.com/oembed?url=${encodeURIComponent(watchUrl(videoId))}&format=json`;
}

export type OEmbed = { title: string; author: string; authorUrl: string | null; thumbnailUrl: string };

const clean = (s: string, max: number) => s.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);

/** Validate untrusted oEmbed JSON. Returns null unless it is a usable YouTube video record. */
export function parseOEmbed(raw: unknown): OEmbed | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (o.type !== undefined && o.type !== "video") return null;
  if (typeof o.provider_name === "string" && o.provider_name !== "YouTube") return null;
  if (typeof o.title !== "string" || typeof o.author_name !== "string") return null;
  const title = clean(o.title, 200);
  const author = clean(o.author_name, 120);
  if (title.length === 0 || author.length === 0) return null;
  let thumbnailUrl: string | null = null;
  if (typeof o.thumbnail_url === "string") {
    try {
      const u = new URL(o.thumbnail_url);
      if (u.protocol === "https:" && (u.hostname === "i.ytimg.com" || u.hostname.endsWith(".ytimg.com"))) thumbnailUrl = u.toString();
    } catch {
      thumbnailUrl = null;
    }
  }
  if (!thumbnailUrl) return null;
  let authorUrl: string | null = null;
  if (typeof o.author_url === "string") {
    try {
      const u = new URL(o.author_url);
      if (u.protocol === "https:" && WATCH_HOSTS.has(u.hostname)) authorUrl = u.toString().slice(0, 300);
    } catch {
      authorUrl = null;
    }
  }
  return { title, author, authorUrl, thumbnailUrl };
}

const MAX_DESCRIPTION = 1500;
const MAX_KEYWORDS = 15;

const decodeEntities = (s: string) =>
  s
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;|&#x0*27;|&apos;/gi, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");

/** A JSON string literal's body (as found in the page) decoded; null if malformed. */
function jsonString(body: string): string | null {
  try {
    const out: unknown = JSON.parse(`"${body}"`);
    return typeof out === "string" ? out : null;
  } catch {
    return null;
  }
}

/**
 * What the public watch page says about the video (untrusted HTML): the full
 * description and the uploader's keywords from the embedded player JSON,
 * else the meta tags. Bounded and whitespace-collapsed; a consent wall or an
 * unexpected page yields nothing, never an error.
 */
export function parseWatchPage(html: string): { description: string | null; keywords: string[] } {
  const short = /"shortDescription":"((?:[^"\\]|\\.)*)"/.exec(html);
  const meta = /<meta\s+name="description"\s+content="([^"]*)"/i.exec(html);
  const rawDescription = (short && jsonString(short[1])) ?? (meta ? decodeEntities(meta[1]) : null);
  const description = rawDescription ? clean(rawDescription.replace(/\s+/g, " "), MAX_DESCRIPTION) || null : null;

  let keywords: string[] = [];
  const jsonKeywords = /"keywords":\[((?:"(?:[^"\\]|\\.)*",?)*)\]/.exec(html);
  if (jsonKeywords) {
    try {
      const list: unknown = JSON.parse(`[${jsonKeywords[1]}]`);
      if (Array.isArray(list)) keywords = list.filter((k): k is string => typeof k === "string");
    } catch {
      keywords = [];
    }
  }
  if (keywords.length === 0) {
    const metaKeywords = /<meta\s+name="keywords"\s+content="([^"]*)"/i.exec(html);
    if (metaKeywords) keywords = decodeEntities(metaKeywords[1]).split(",");
  }
  const seen = new Set<string>();
  for (const k of keywords) {
    const tag = clean(k, 40).toLowerCase();
    if (tag.length > 0) seen.add(tag);
    if (seen.size >= MAX_KEYWORDS) break;
  }
  return { description, keywords: [...seen] };
}

/** A campaign has a creative: an uploaded file or a YouTube link. */
export function hasCreative(campaign: {
  creativeStorageId?: unknown;
  creativeExternalUrl?: string;
  creativeContentType?: string;
}): boolean {
  return (
    Boolean(campaign.creativeStorageId) ||
    Boolean(campaign.creativeExternalUrl) ||
    campaign.creativeContentType === YOUTUBE_CONTENT_TYPE
  );
}

export function isYouTubeCreative(campaign: { creativeContentType?: string }): boolean {
  return campaign.creativeContentType === YOUTUBE_CONTENT_TYPE;
}
