/**
 * Collections seat, deterministic part: choose how hard to chase an overdue
 * invoice from the payer's own history (the "Time" dimension). Pure.
 *
 *  - escalate_to_controller: >= 21 days overdue, or a repeat-late payer >= 14 days overdue
 *  - firm:     payer paid late before -> firm from the first day overdue
 *  - friendly: first time late, after a 3-day grace period
 *  - null:     not overdue yet / inside grace
 */

export const DAY_MS = 24 * 60 * 60 * 1000;
/** Paid more than this many days after due counts as "late" in history. */
export const LATE_GRACE_DAYS = 3;
export const FRIENDLY_AFTER_DAYS = 3;
export const ESCALATE_AFTER_DAYS = 21;
export const REPEAT_LATE_ESCALATE_AFTER_DAYS = 14;

export type Tone = "friendly" | "firm" | "escalate_to_controller";

export const TONE_RANK: Record<Tone, number> = {
  friendly: 1,
  firm: 2,
  escalate_to_controller: 3,
};

export type HistoryItem = {
  number: string;
  dueAt: number;
  /** null = not fully paid yet */
  paidAt: number | null;
};

export function daysOverdue(dueAt: number, asOf: number): number {
  return Math.floor((asOf - dueAt) / DAY_MS);
}

function day(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

export function chooseTone(args: {
  invoiceNumber: string;
  dueAt: number;
  asOf: number;
  /** Other invoices of the same advertiser (this one excluded). */
  history: HistoryItem[];
}): { tone: Tone | null; reason: string; priorLateCount: number; daysOverdue: number } {
  const overdue = daysOverdue(args.dueAt, args.asOf);
  const paid = args.history
    .filter((h) => h.paidAt !== null && h.dueAt < args.asOf)
    .sort((a, b) => a.dueAt - b.dueAt);
  const late = paid.filter((h) => (h.paidAt! - h.dueAt) / DAY_MS > LATE_GRACE_DAYS);
  const lateText = late
    .map((h) => `${h.number} paid ${Math.floor((h.paidAt! - h.dueAt) / DAY_MS)} days late (${day(h.paidAt!)})`)
    .join("; ");
  const historyText =
    late.length > 0
      ? `Prior late payments: ${lateText}.`
      : paid.length > 0
        ? `No late payments on ${paid.length} prior invoice(s) (${paid.map((h) => h.number).join(", ")}).`
        : "No payment history on file.";
  const head = `${args.invoiceNumber} is ${overdue} day(s) overdue (due ${day(args.dueAt)}).`;

  if (overdue <= 0) {
    return { tone: null, reason: `${args.invoiceNumber} is not overdue.`, priorLateCount: late.length, daysOverdue: overdue };
  }
  if (
    overdue >= ESCALATE_AFTER_DAYS ||
    (late.length >= 2 && overdue >= REPEAT_LATE_ESCALATE_AFTER_DAYS)
  ) {
    return {
      tone: "escalate_to_controller",
      reason: `${head} ${historyText} Escalating to the controller (policy: ${ESCALATE_AFTER_DAYS}+ days, or ${REPEAT_LATE_ESCALATE_AFTER_DAYS}+ days for repeat-late payers).`,
      priorLateCount: late.length,
      daysOverdue: overdue,
    };
  }
  if (late.length >= 1) {
    return {
      tone: "firm",
      reason: `${head} ${historyText} Repeat-late payer: firm reminder from day 1.`,
      priorLateCount: late.length,
      daysOverdue: overdue,
    };
  }
  if (overdue >= FRIENDLY_AFTER_DAYS) {
    return {
      tone: "friendly",
      reason: `${head} ${historyText} First time late: friendly reminder.`,
      priorLateCount: 0,
      daysOverdue: overdue,
    };
  }
  return {
    tone: null,
    reason: `${head} ${historyText} Within the ${FRIENDLY_AFTER_DAYS}-day grace period for first-time-late payers.`,
    priorLateCount: 0,
    daysOverdue: overdue,
  };
}
