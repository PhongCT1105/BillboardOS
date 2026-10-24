/**
 * Answer key for the planted errors in ./financeFixture.ts.
 * The test `finance.test.ts` asserts the AR clerk and collections seat
 * reproduce this exactly. If the engine changes, this file must not.
 */

export type ExpectedLine = {
  planted: string;
  status: "matched" | "partially_applied" | "needs_review";
  rule: string;
  applications: { invoice: string; amountMinor: number }[];
  /** Sub-materiality differences accepted by policy. */
  adjustments: { invoice: string; amountMinor: number }[];
  exceptions: { kind: string; invoice: string | null; expectedMinor: number; observedMinor: number }[];
  approvalsRequested: { action: string; amountMinor: number }[];
};

export const INGEST_ANSWER = {
  rawLines: 8,
  inserted: 7,
  /** fx-bank-001 delivered twice by the feed; second copy dropped at ingest. */
  duplicatesIgnored: ["fx-bank-001"],
};

export const LINE_ANSWERS: Record<string, ExpectedLine> = {
  "fx-bank-001": {
    planted: "Bundled payment covering two invoices (memo cites both)",
    status: "matched",
    rule: "bundled_invoices",
    applications: [
      { invoice: "INV-1010", amountMinor: 40000 },
      { invoice: "INV-1011", amountMinor: 25000 },
    ],
    adjustments: [],
    exceptions: [],
    approvalsRequested: [],
  },
  "fx-bank-002": {
    planted: "$40 short payment (above $1.00 materiality)",
    status: "partially_applied",
    rule: "invoice_number",
    applications: [{ invoice: "INV-1012", amountMinor: 56000 }],
    adjustments: [],
    exceptions: [{ kind: "short_payment", invoice: "INV-1012", expectedMinor: 60000, observedMinor: 56000 }],
    approvalsRequested: [],
  },
  "fx-bank-003": {
    planted: "$0.50 short payment (under materiality, auto-accepted with a note)",
    status: "matched",
    rule: "invoice_number",
    applications: [{ invoice: "INV-1014", amountMinor: 34950 }],
    adjustments: [{ invoice: "INV-1014", amountMinor: 50 }],
    exceptions: [],
    approvalsRequested: [],
  },
  "fx-bank-004": {
    planted: "Overpayment by $30 (never silently kept)",
    status: "partially_applied",
    rule: "invoice_number",
    applications: [{ invoice: "INV-1016", amountMinor: 30000 }],
    adjustments: [],
    exceptions: [{ kind: "overpayment", invoice: "INV-1016", expectedMinor: 30000, observedMinor: 33000 }],
    approvalsRequested: [{ action: "refund", amountMinor: 3000 }],
  },
  "fx-bank-005": {
    planted: "Clean match: payer alias + exact open amount, no memo reference",
    status: "matched",
    rule: "payer_exact_amount",
    applications: [{ invoice: "INV-1017", amountMinor: 18000 }],
    adjustments: [],
    exceptions: [],
    approvalsRequested: [],
  },
  "fx-bank-006": {
    planted: "Duplicated bank line (same payer/amount/memo as fx-bank-005, new id)",
    status: "needs_review",
    rule: "duplicate_line",
    applications: [],
    adjustments: [],
    exceptions: [{ kind: "duplicate_payment", invoice: null, expectedMinor: 0, observedMinor: 18000 }],
    approvalsRequested: [],
  },
  "fx-bank-007": {
    planted: "Unidentified payer, no invoice reference",
    status: "needs_review",
    rule: "unidentified",
    applications: [],
    adjustments: [],
    exceptions: [{ kind: "unidentified_payment", invoice: null, expectedMinor: 0, observedMinor: 27500 }],
    approvalsRequested: [],
  },
};

/** Invoice state after reconciliation. */
export const INVOICE_ANSWERS: Record<string, { status: string; balanceMinor: number }> = {
  "INV-1008": { status: "open", balanceMinor: 45000 },
  "INV-1010": { status: "paid", balanceMinor: 0 },
  "INV-1011": { status: "paid", balanceMinor: 0 },
  "INV-1012": { status: "partially_paid", balanceMinor: 4000 },
  "INV-1013": { status: "open", balanceMinor: 30000 },
  "INV-1014": { status: "paid", balanceMinor: 0 },
  "INV-1015": { status: "open", balanceMinor: 20000 },
  "INV-1016": { status: "paid", balanceMinor: 0 },
  "INV-1017": { status: "paid", balanceMinor: 0 },
};

/**
 * Collections plan at FIXTURE_AS_OF (Oct 24 2026) after reconciliation.
 * Sunset Records paid INV-1002 and INV-1005 ~3 weeks late, so it gets firm
 * treatment from day 1 and escalation for the 24-day-old invoice; Harbor
 * Dental has a clean history and gets a friendly first reminder.
 */
export const COLLECTION_ANSWERS: Record<string, { tone: string; daysOverdue: number; priorLateCount: number }> = {
  "INV-1008": { tone: "escalate_to_controller", daysOverdue: 24, priorLateCount: 2 },
  "INV-1012": { tone: "firm", daysOverdue: 8, priorLateCount: 2 },
  "INV-1013": { tone: "firm", daysOverdue: 6, priorLateCount: 2 },
  "INV-1015": { tone: "friendly", daysOverdue: 3, priorLateCount: 0 },
};
