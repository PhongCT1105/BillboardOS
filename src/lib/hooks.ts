import { useEffect, useState } from "react";

/** Current time, refreshed every `intervalMs`. */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

function readHash(): { path: string; query: string } {
  const raw = window.location.hash.replace(/^#/, "") || "/console";
  const i = raw.indexOf("?");
  return i === -1 ? { path: raw, query: "" } : { path: raw.slice(0, i) || "/", query: raw.slice(i + 1) };
}

function useHash() {
  const [hash, setHash] = useState(readHash);
  useEffect(() => {
    const onChange = () => setHash(readHash());
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return hash;
}

/** Hash path without the leading "#" or any "?query", e.g. "/player/abc". */
export function useHashRoute(): string {
  return useHash().path;
}

/** Query parameters after "?" in the hash, e.g. "#/book?slots=a,b". */
export function useHashParams(): URLSearchParams {
  return new URLSearchParams(useHash().query);
}

/** Build a hash link: hashHref("/book", { slots: "a,b" }) -> "#/book?slots=a,b". */
export function hashHref(path: string, params: Record<string, string | undefined> = {}): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) q.set(k, v);
  const s = q.toString();
  return `#${path}${s ? `?${s}` : ""}`;
}
