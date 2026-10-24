/**
 * AR clerk reconciliation engine. Pure and deterministic: given one bank line
 * and a snapshot of payers / invoices / earlier bank lines, decide how the
 * cash is applied and which differences need a person. No DB, no clock.
 *
 * Rule order (first that applies wins):
 *   0. duplicate_line      identical payer+amount+memo within 24h of an earlier line -> review
 *   1. invoice_number      memo cites invoice number(s) -> apply to those (bundled_invoices if >1)
 *   2. payer_exact_amount  identified payer has one open invoice with exactly this balance
 *   3. payer_bundle_exact  identified payer has 2+ open invoices summing exactly to the amount
 *   4. payer_open_balance  apply oldest-first against the payer's open balance
 *   -  unidentified        no invoice reference and no known payer -> review
 *
 * Differences: short below MATERIALITY_MINOR is auto-accepted as an adjustment
 * (with a note); a larger short opens `short_payment`; any excess opens
 * `overpayment` (never silently kept).
 */

/** Short payments strictly below $1.00 are accepted without review. */
export const MATERIALITY_MINOR = 100;
const DUPLICATE_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Bound on subset search for bundled payments without a memo reference. */
const MAX_BUNDLE_CANDIDATES = 12;

export type ReconcileRule =
  | "invoice_number"
  | "bundled_invoices"
  | "payer_exact_amount"
  | "payer_bundle_exact"
  | "payer_open_balance"
  | "duplicate_line"
  | "unidentified"
  | "no_open_invoices";

export type ReconcileExceptionKind =
  | "short_payment"
  | "overpayment"
  | "unidentified_payment"
  | "duplicate_payment";

export type BankLine<B extends string> = {
  id: B;
  externalId: string;
  amountMinor: number;
  postedAt: number;
  payerName: string;
  memo: string;
};

export type Payer<A extends string> = {
  id: A;
  displayName: string;
  aliases: string[];
};

export type InvoiceCandidate<I extends string, A extends string> = {
  id: I;
  number: string;
  advertiserId: A;
  /** Outstanding balance (amount - paid - adjustments - write-offs). */
  balanceMinor: number;
  dueAt: number;
};

export type ReconcileInput<B extends string, A extends string, I extends string> = {
  line: BankLine<B>;
  payers: Payer<A>[];
  /** Invoices whose numbers appear in the memo (any status; zero balance allowed). */
  referencedInvoices: InvoiceCandidate<I, A>[];
  /** Open invoices (balance > 0) of the identified payer. */
  payerOpenInvoices: InvoiceCandidate<I, A>[];
  /** Bank lines already processed (not "unmatched"), for duplicate detection. */
  priorLines: BankLine<B>[];
};

export type ReconcileDecision<B extends string, A extends string, I extends string> = {
  bankTransactionId: B;
  outcome: "matched" | "partially_applied" | "needs_review";
  rule: ReconcileRule;
  advertiserId: A | null;
  applications: { invoiceId: I; invoiceNumber: string; amountMinor: number; evidence: string }[];
  adjustments: { invoiceId: I; invoiceNumber: string; amountMinor: number; note: string }[];
  exceptions: {
    kind: ReconcileExceptionKind;
    invoiceId: I | null;
    expectedMinor: number;
    observedMinor: number;
    evidence: string;
  }[];
  duplicateOf: B | null;
  unappliedMinor: number;
  explanation: string[];
};

// ---------------------------------------------------------------------------
// Normalization helpers (exported for the mutation's lookups and for tests)
// ---------------------------------------------------------------------------

const NAME_NOISE = new Set([
  "LLC", "INC", "CO", "CORP", "CORPORATION", "LTD", "GRP", "GROUP", "THE", "COMPANY", "INCORPORATED",
]);

/** "Harbor Dental Group" and "HARBOR DENTAL GRP" both -> "HARBOR DENTAL". */
export function normalizeName(name: string): string {
  return name
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, " ")
    .split(" ")
    .filter((t) => t.length > 0 && !NAME_NOISE.has(t))
    .join(" ");
}

function normalizeMemo(memo: string): string {
  return memo.toUpperCase().replace(/\s+/g, " ").trim();
}

/** Invoice numbers cited in a memo, normalized to "INV-<digits>", in order, unique. */
export function parseInvoiceNumbers(memo: string): string[] {
  const out: string[] = [];
  for (const m of memo.matchAll(/\bINV[\s#:-]*(\d{3,6})\b/gi)) {
    const n = `INV-${m[1]}`;
    if (!out.includes(n)) out.push(n);
  }
  return out;
}

/** Exact match on normalized display name or alias. Ambiguous -> null. */
export function identifyPayer<A extends string>(
  payerName: string,
  payers: Payer<A>[],
): { payer: Payer<A> | null; ambiguous: boolean } {
  const key = normalizeName(payerName);
  if (key.length === 0) return { payer: null, ambiguous: false };
  const hits = payers.filter(
    (p) =>
      normalizeName(p.displayName) === key || p.aliases.some((a) => normalizeName(a) === key),
  );
  if (hits.length === 1) return { payer: hits[0], ambiguous: false };
  return { payer: null, ambiguous: hits.length > 1 };
}

export function usd(minor: number): string {
  const sign = minor < 0 ? "-" : "";
  return `${sign}$${(Math.abs(minor) / 100).toFixed(2)}`;
}

const byDueThenNumber = <I extends string, A extends string>(
  a: InvoiceCandidate<I, A>,
  b: InvoiceCandidate<I, A>,
) => a.dueAt - b.dueAt || a.number.localeCompare(b.number);

// ---------------------------------------------------------------------------
// Core
// ---------------------------------------------------------------------------

export function reconcileLine<B extends string, A extends string, I extends string>(
  input: ReconcileInput<B, A, I>,
): ReconcileDecision<B, A, I> {
  const { line } = input;
  const X = line.amountMinor;
  const lineRef = `bank line ${line.externalId} (${line.payerName}, ${usd(X)}, memo "${line.memo}")`;
  const { payer, ambiguous } = identifyPayer(line.payerName, input.payers);

  const base = (): ReconcileDecision<B, A, I> => ({
    bankTransactionId: line.id,
    outcome: "needs_review",
    rule: "unidentified",
    advertiserId: payer?.id ?? null,
    applications: [],
    adjustments: [],
    exceptions: [],
    duplicateOf: null,
    unappliedMinor: X,
    explanation: [],
  });

  // 0. Duplicate bank line (same payer, amount and memo within 24h of an earlier processed line).
  const dup = input.priorLines.find(
    (p) =>
      p.id !== line.id &&
      p.amountMinor === X &&
      normalizeName(p.payerName) === normalizeName(line.payerName) &&
      normalizeMemo(p.memo) === normalizeMemo(line.memo) &&
      Math.abs(p.postedAt - line.postedAt) < DUPLICATE_WINDOW_MS,
  );
  if (dup) {
    const d = base();
    d.rule = "duplicate_line";
    d.duplicateOf = dup.id;
    d.exceptions.push({
      kind: "duplicate_payment",
      invoiceId: null,
      expectedMinor: 0,
      observedMinor: X,
      evidence: `${lineRef} is identical to earlier bank line ${dup.externalId} (same payer, amount and memo within 24h). Not applied: possible duplicate feed entry or a genuine second payment.`,
    });
    d.explanation.push(`Duplicate of ${dup.externalId}; held for review instead of applying twice.`);
    return d;
  }

  // 1. Invoice numbers in the memo.
  const cited = parseInvoiceNumbers(line.memo);
  const found = input.referencedInvoices.filter((i) => cited.includes(i.number));
  const missing = cited.filter((n) => !found.some((i) => i.number === n));
  if (found.length > 0) {
    const owners = new Set(found.map((i) => i.advertiserId));
    if (owners.size > 1 || (payer && !owners.has(payer.id))) {
      const d = base();
      d.rule = "unidentified";
      d.exceptions.push({
        kind: "unidentified_payment",
        invoiceId: found[0].id,
        expectedMinor: found.reduce((s, i) => s + i.balanceMinor, 0),
        observedMinor: X,
        evidence: `${lineRef}: memo cites ${found.map((i) => i.number).join(", ")} but the payer on the bank line (${payer ? payer.displayName : line.payerName}) is not the invoiced advertiser. Bank and invoice disagree; not applied.`,
      });
      d.explanation.push("Payer on bank line does not own the cited invoice(s).");
      return d;
    }
    const advertiserId = found[0].advertiserId;
    const open = found.filter((i) => i.balanceMinor > 0).sort(byDueThenNumber);
    const settled = found.filter((i) => i.balanceMinor <= 0);
    const notes: string[] = [];
    if (!payer) {
      notes.push(
        `Payer name "${line.payerName}" not on file${ambiguous ? " (ambiguous)" : ""}; trusted the invoice number in the memo.`,
      );
    }
    if (missing.length > 0) notes.push(`Memo also cites unknown ${missing.join(", ")}.`);
    if (settled.length > 0) notes.push(`${settled.map((i) => i.number).join(", ")} already settled.`);

    if (open.length === 0) {
      const d = base();
      d.advertiserId = advertiserId;
      d.rule = "invoice_number";
      d.exceptions.push({
        kind: "overpayment",
        invoiceId: found[0].id,
        expectedMinor: 0,
        observedMinor: X,
        evidence: `${lineRef}: every cited invoice is already settled; the whole amount is unapplied cash.`,
      });
      d.explanation.push(...notes, "Nothing left to apply to.");
      return d;
    }
    const rule: ReconcileRule = open.length > 1 ? "bundled_invoices" : "invoice_number";
    const how =
      open.length > 1
        ? `memo cites ${open.map((i) => i.number).join(" + ")} (bundled payment)`
        : `memo cites ${open[0].number}`;
    return allocate(base(), advertiserId, rule, open, lineRef, how, notes);
  }

  // No usable invoice reference from here on.
  if (!payer) {
    const d = base();
    d.exceptions.push({
      kind: "unidentified_payment",
      invoiceId: null,
      expectedMinor: 0,
      observedMinor: X,
      evidence: `${lineRef}: payer ${ambiguous ? "matches more than one advertiser" : "is not a known advertiser or alias"} and the memo cites no invoice${missing.length ? ` on file (cited ${missing.join(", ")})` : ""}.`,
    });
    d.explanation.push("Unidentified payer; needs a person to identify and request a manual match.");
    return d;
  }

  const open = input.payerOpenInvoices
    .filter((i) => i.advertiserId === payer.id && i.balanceMinor > 0)
    .sort(byDueThenNumber);
  const payerNote = `payer "${line.payerName}" identified as ${payer.displayName}`;

  if (open.length === 0) {
    const d = base();
    d.rule = "no_open_invoices";
    d.exceptions.push({
      kind: "overpayment",
      invoiceId: null,
      expectedMinor: 0,
      observedMinor: X,
      evidence: `${lineRef}: ${payerNote}, but they have no open invoices. Unapplied cash.`,
    });
    d.explanation.push("Known payer with nothing owed.");
    return d;
  }

  // 2. Exactly one invoice with this balance (oldest wins on ties).
  const exact = open.find((i) => i.balanceMinor === X);
  if (exact) {
    return allocate(base(), payer.id, "payer_exact_amount", [exact], lineRef, `${payerNote}; amount equals the balance of ${exact.number}`, []);
  }

  // 3. Smallest, oldest subset of 2+ invoices summing exactly to the amount.
  const bundle = findExactSubset(open.slice(0, MAX_BUNDLE_CANDIDATES), X);
  if (bundle) {
    return allocate(
      base(),
      payer.id,
      "payer_bundle_exact",
      bundle,
      lineRef,
      `${payerNote}; amount equals ${bundle.map((i) => i.number).join(" + ")} exactly`,
      [],
    );
  }

  // 4. Oldest-first against the open balance.
  return allocate(base(), payer.id, "payer_open_balance", open, lineRef, `${payerNote}; applied oldest-first against open balance`, []);
}

/** Apply `line.amountMinor` oldest-first to `targets`, then classify the difference. */
function allocate<B extends string, A extends string, I extends string>(
  d: ReconcileDecision<B, A, I>,
  advertiserId: A,
  rule: ReconcileRule,
  targets: InvoiceCandidate<I, A>[],
  lineRef: string,
  how: string,
  notes: string[],
): ReconcileDecision<B, A, I> {
  d.advertiserId = advertiserId;
  d.rule = rule;
  const X = d.unappliedMinor;
  const due = targets.reduce((s, i) => s + i.balanceMinor, 0);
  let remaining = X;
  const leftover: { inv: InvoiceCandidate<I, A>; balance: number }[] = [];
  for (const inv of targets) {
    const amt = Math.min(remaining, inv.balanceMinor);
    if (amt > 0) {
      d.applications.push({
        invoiceId: inv.id,
        invoiceNumber: inv.number,
        amountMinor: amt,
        evidence: `${lineRef}: ${how}. Applied ${usd(amt)} of ${usd(inv.balanceMinor)} balance on ${inv.number}.`,
      });
      remaining -= amt;
    }
    if (inv.balanceMinor - amt > 0) leftover.push({ inv, balance: inv.balanceMinor - amt });
  }
  d.unappliedMinor = remaining;
  d.explanation.push(`${how}.`, ...notes);

  if (X === due) {
    d.outcome = "matched";
    d.explanation.push(`Paid in full: ${usd(X)}.`);
  } else if (X > due) {
    const excess = X - due;
    d.outcome = "partially_applied";
    d.exceptions.push({
      kind: "overpayment",
      invoiceId: targets[targets.length - 1].id,
      expectedMinor: due,
      observedMinor: X,
      evidence: `${lineRef}: received ${usd(X)} against ${usd(due)} due on ${targets.map((i) => i.number).join(", ")}; ${usd(excess)} unapplied.`,
    });
    d.explanation.push(`Overpaid by ${usd(excess)}; excess held as unapplied cash pending refund approval.`);
  } else {
    const short = due - X;
    if (short < MATERIALITY_MINOR) {
      d.outcome = "matched";
      for (const { inv, balance } of leftover) {
        d.adjustments.push({
          invoiceId: inv.id,
          invoiceNumber: inv.number,
          amountMinor: balance,
          note: `Short by ${usd(balance)} on ${inv.number}, below ${usd(MATERIALITY_MINOR)} materiality: accepted by policy.`,
        });
      }
      d.explanation.push(...d.adjustments.map((a) => a.note));
    } else {
      d.outcome = "partially_applied";
      d.exceptions.push({
        kind: "short_payment",
        invoiceId: leftover[0].inv.id,
        expectedMinor: due,
        observedMinor: X,
        evidence: `${lineRef}: received ${usd(X)} against ${usd(due)} due on ${targets.map((i) => i.number).join(", ")}; short ${usd(short)} (above ${usd(MATERIALITY_MINOR)} materiality).`,
      });
      d.explanation.push(`Short by ${usd(short)}; applied what was received and flagged the shortfall.`);
    }
  }
  return d;
}

/** Smallest subset (size >= 2) summing to target; ties -> earliest-due combination. */
function findExactSubset<I extends string, A extends string>(
  invoices: InvoiceCandidate<I, A>[],
  target: number,
): InvoiceCandidate<I, A>[] | null {
  const n = invoices.length;
  const search = (size: number, start: number, sum: number, pick: number[]): number[] | null => {
    if (pick.length === size) return sum === target ? pick : null;
    for (let i = start; i < n; i++) {
      const next = sum + invoices[i].balanceMinor;
      if (next > target) continue;
      const r = search(size, i + 1, next, [...pick, i]);
      if (r) return r;
    }
    return null;
  };
  for (let size = 2; size <= n; size++) {
    const found = search(size, 0, 0, []);
    if (found) return found.map((i) => invoices[i]);
  }
  return null;
}
