const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

/** Integer cents to "$1,234.56". */
export function money(minor: number): string {
  return usd.format(minor / 100);
}

const clock = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" });

export function timeOfDay(ms: number): string {
  return clock.format(ms);
}

export function timeRange(startAt: number, endAt: number): string {
  return `${timeOfDay(startAt)} to ${timeOfDay(endAt)}`;
}

/** "4:59" style countdown; "0:00" once passed. */
export function countdown(untilMs: number, nowMs: number): string {
  const total = Math.max(0, Math.round((untilMs - nowMs) / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function ago(ms: number, nowMs: number): string {
  const s = Math.max(0, Math.round((nowMs - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.round(m / 60)}h ago`;
}

/** Read the human message out of a ConvexError or plain Error. */
export function errorMessage(err: unknown): string {
  if (err && typeof err === "object" && "data" in err) {
    const data = (err as { data: unknown }).data;
    if (data && typeof data === "object" && "message" in data) {
      return String((data as { message: unknown }).message);
    }
  }
  return err instanceof Error ? err.message : "Something went wrong";
}

const day = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" });

export function shortDate(ms: number): string {
  return day.format(ms);
}

const weekday = new Intl.DateTimeFormat("en-US", { weekday: "long", month: "short", day: "numeric" });

/** "Sunday, Oct 25" */
export function dayLabel(ms: number): string {
  return weekday.format(ms);
}

/** "partially_applied" -> "partially applied" */
export function words(value: string): string {
  return value.replaceAll("_", " ");
}
