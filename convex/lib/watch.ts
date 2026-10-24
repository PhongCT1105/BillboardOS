/**
 * Watch-rule matcher (ADR 0004 "Tell me when a spot fits"). Pure: the
 * internal mutations load inputs and record dedupe state; this decides.
 */

export type WatchTrigger = "available" | "price_drop" | "last_minute" | "auction_open";

export const LAST_MINUTE_WINDOW_MS = 60 * 60_000;
export const MAX_SLOTS_PER_ALERT = 5;

export type RuleFilters = {
  cities?: string[];
  billboardIds?: string[];
  minMatch?: number;
  maxPriceMinor: number;
  daysOfWeek?: number[];
  hourStart?: number;
  hourEnd?: number;
  dateFrom?: number;
  dateTo?: number;
  triggers: WatchTrigger[];
};

export type ScreenFacts = {
  billboardId: string;
  city: string;
  utcOffsetMinutes: number;
  /** Audience match for this rule's campaign; null if either side has no profile. */
  matchScore: number | null;
};

export type SlotFacts = {
  startAt: number;
  /** On sale at a posted price (available state, no open auction). */
  available: boolean;
  /** An open auction covers this slot. */
  auctionOpen: boolean;
  /** Screen price now (auction: its reserve). */
  priceMinor: number;
  /** Price the last time this rule saw this slot (null = never seen). */
  previousPriceMinor: number | null;
  /** The scarcity stage discounted it because it starts soon. */
  lastMinuteDiscount: boolean;
};

function localParts(ts: number, offsetMinutes: number): { day: number; hour: number } {
  const d = new Date(ts + offsetMinutes * 60_000);
  return { day: d.getUTCDay(), hour: d.getUTCHours() + d.getUTCMinutes() / 60 };
}

/** Where/when filters (not price): does this slot on this screen fit the rule? */
export function ruleFitsSlot(rule: RuleFilters, screen: ScreenFacts, slotStartAt: number): boolean {
  if (rule.billboardIds && rule.billboardIds.length > 0 && !rule.billboardIds.includes(screen.billboardId)) return false;
  if (rule.cities && rule.cities.length > 0) {
    const city = screen.city.trim().toLowerCase();
    if (!rule.cities.some((c) => c.trim().toLowerCase() === city)) return false;
  }
  if (rule.minMatch !== undefined && rule.minMatch > 0) {
    if (screen.matchScore === null || screen.matchScore < rule.minMatch) return false;
  }
  if (rule.dateFrom !== undefined && slotStartAt < rule.dateFrom) return false;
  if (rule.dateTo !== undefined && slotStartAt > rule.dateTo) return false;
  const { day, hour } = localParts(slotStartAt, screen.utcOffsetMinutes);
  if (rule.daysOfWeek && rule.daysOfWeek.length > 0 && !rule.daysOfWeek.includes(day)) return false;
  if (rule.hourStart !== undefined && hour < rule.hourStart) return false;
  if (rule.hourEnd !== undefined && hour >= rule.hourEnd) return false;
  return true;
}

/** Which of the rule's triggers this slot satisfies right now (before dedupe). */
export function triggersFor(rule: RuleFilters, slot: SlotFacts, now: number): WatchTrigger[] {
  const out: WatchTrigger[] = [];
  const affordable = slot.priceMinor <= rule.maxPriceMinor;
  const onSale = slot.available && !slot.auctionOpen;
  for (const t of rule.triggers) {
    if (t === "available" && onSale && affordable) out.push(t);
    if (
      t === "price_drop" &&
      onSale &&
      affordable &&
      slot.previousPriceMinor !== null &&
      slot.previousPriceMinor > rule.maxPriceMinor
    ) {
      out.push(t);
    }
    if (t === "last_minute" && onSale && affordable && slot.lastMinuteDiscount && slot.startAt - now < LAST_MINUTE_WINDOW_MS) {
      out.push(t);
    }
    if (t === "auction_open" && slot.auctionOpen && affordable) out.push(t);
  }
  return out;
}

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function hourLabel(h: number): string {
  const whole = Math.floor(h);
  const minutes = Math.round((h - whole) * 60);
  const suffix = whole % 24 < 12 ? "AM" : "PM";
  const h12 = whole % 12 === 0 ? 12 : whole % 12;
  return minutes ? `${h12}:${String(minutes).padStart(2, "0")} ${suffix}` : `${h12} ${suffix}`;
}

/**
 * Plain-language rule summary, e.g.
 * "Tell me when a slot on a screen matching 60%+ of my audience in San Francisco is under $60.00 between 8 AM and 11 AM".
 */
export function summarizeRule(
  rule: RuleFilters & { delivery?: ("inbox" | "agent")[] },
  screenNames: Record<string, string> = {},
): string {
  const parts: string[] = [];
  const what =
    rule.triggers.length === 1 && rule.triggers[0] === "auction_open"
      ? "an auction opens"
      : rule.triggers.includes("last_minute") && rule.triggers.length === 1
        ? "a last-minute discount appears"
        : "a slot";
  let where = "";
  if (rule.billboardIds && rule.billboardIds.length > 0) {
    where = ` on ${rule.billboardIds.map((id) => screenNames[id] ?? "a chosen screen").join(" or ")}`;
  } else if (rule.minMatch) {
    where = ` on a screen matching ${Math.round(rule.minMatch * 100)}%+ of my audience`;
  } else {
    where = " on any screen";
  }
  if (rule.cities && rule.cities.length > 0) where += ` in ${rule.cities.join(" or ")}`;
  parts.push(`Tell me when ${what}${what === "a slot" ? where : ` for a slot${where}`}`);
  parts.push(`is under $${(rule.maxPriceMinor / 100).toFixed(2)}`);
  if (rule.hourStart !== undefined || rule.hourEnd !== undefined) {
    parts.push(`between ${hourLabel(rule.hourStart ?? 0)} and ${hourLabel(rule.hourEnd ?? 24)}`);
  }
  if (rule.daysOfWeek && rule.daysOfWeek.length > 0 && rule.daysOfWeek.length < 7) {
    parts.push(`on ${rule.daysOfWeek.map((d) => DAY_NAMES[d]).join(", ")}`);
  }
  const extras = rule.triggers.filter((t) => t === "price_drop" || t === "last_minute" || t === "auction_open");
  let text = parts.join(" ");
  if (what === "a slot" && extras.length > 0) {
    const names = extras.map((t) => (t === "price_drop" ? "price drops" : t === "last_minute" ? "last-minute deals" : "auctions"));
    text += `, including ${names.join(", ")}`;
  }
  if (rule.delivery?.includes("agent")) text += rule.delivery.includes("inbox") ? " (inbox and my agent)" : " (my agent)";
  return text;
}
