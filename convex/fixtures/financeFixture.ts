/**
 * SIMULATED finance data for the Hyphenate demo ("fixture" source).
 * Three net15 advertisers with Aug-Oct 2026 history, open invoices, and a
 * bank feed for the week of Oct 19 2026 with planted errors.
 * Expected outcomes are in ./financeAnswerKey.ts.
 */

/** 17:00 UTC (10:00 PDT) on the given 2026 date. */
export function at(month: number, day: number): number {
  return Date.UTC(2026, month - 1, day, 17, 0);
}

export const FIXTURE_ADVERTISERS = [
  // Bank statements say "MISSION BICYCLE CO": the alias is the evidence that links them.
  { key: "mission", displayName: "Mission Bikes", paymentTerms: "net15" as const, payerAliases: ["MISSION BICYCLE CO"] },
  // Repeat-late payer (Aug and Sep paid 3 weeks late).
  { key: "sunset", displayName: "Sunset Records", paymentTerms: "net15" as const, payerAliases: ["SUNSET REC"] },
  // Always on time until now. "HARBOR DENTAL GRP" normalizes to the display name.
  { key: "harbor", displayName: "Harbor Dental Group", paymentTerms: "net15" as const, payerAliases: [] as string[] },
];

export type FixtureAdvertiserKey = (typeof FIXTURE_ADVERTISERS)[number]["key"];

export type FixtureInvoice = {
  number: string;
  advertiser: FixtureAdvertiserKey;
  description: string;
  amountMinor: number;
  issuedAt: number;
  dueAt: number;
  /** Set for history that was already paid (cash date). */
  paidAt?: number;
};

export const FIXTURE_INVOICES: FixtureInvoice[] = [
  // --- History (paid) ---
  { number: "INV-1001", advertiser: "mission", description: "August rotation, Moscone West", amountMinor: 40000, issuedAt: at(8, 1), dueAt: at(8, 16), paidAt: at(8, 14) },
  { number: "INV-1002", advertiser: "sunset", description: "August album launch", amountMinor: 52000, issuedAt: at(8, 3), dueAt: at(8, 18), paidAt: at(9, 9) },
  { number: "INV-1003", advertiser: "harbor", description: "August awareness", amountMinor: 30000, issuedAt: at(8, 5), dueAt: at(8, 20), paidAt: at(8, 19) },
  { number: "INV-1004", advertiser: "mission", description: "September rotation", amountMinor: 40000, issuedAt: at(9, 1), dueAt: at(9, 16), paidAt: at(9, 15) },
  { number: "INV-1005", advertiser: "sunset", description: "September tour dates", amountMinor: 48000, issuedAt: at(9, 1), dueAt: at(9, 16), paidAt: at(10, 6) },
  { number: "INV-1006", advertiser: "harbor", description: "September awareness", amountMinor: 30000, issuedAt: at(9, 4), dueAt: at(9, 19), paidAt: at(9, 18) },
  { number: "INV-1007", advertiser: "mission", description: "October rotation", amountMinor: 40000, issuedAt: at(10, 1), dueAt: at(10, 16), paidAt: at(10, 15) },
  // --- Open ---
  { number: "INV-1008", advertiser: "sunset", description: "Late-September flash promo", amountMinor: 45000, issuedAt: at(9, 15), dueAt: at(9, 30) },
  { number: "INV-1010", advertiser: "mission", description: "Cal Hacks week, morning slots", amountMinor: 40000, issuedAt: at(10, 5), dueAt: at(10, 20) },
  { number: "INV-1011", advertiser: "mission", description: "Cal Hacks week, evening slots", amountMinor: 25000, issuedAt: at(10, 8), dueAt: at(10, 23) },
  { number: "INV-1012", advertiser: "sunset", description: "October listening party", amountMinor: 60000, issuedAt: at(10, 1), dueAt: at(10, 16) },
  { number: "INV-1013", advertiser: "sunset", description: "October vinyl drop", amountMinor: 30000, issuedAt: at(10, 3), dueAt: at(10, 18) },
  { number: "INV-1014", advertiser: "harbor", description: "October awareness", amountMinor: 35000, issuedAt: at(10, 4), dueAt: at(10, 19) },
  { number: "INV-1015", advertiser: "harbor", description: "October whitening promo", amountMinor: 20000, issuedAt: at(10, 6), dueAt: at(10, 21) },
  { number: "INV-1016", advertiser: "mission", description: "Weekend ride series", amountMinor: 30000, issuedAt: at(10, 10), dueAt: at(10, 25) },
  { number: "INV-1017", advertiser: "mission", description: "Commuter campaign", amountMinor: 18000, issuedAt: at(10, 12), dueAt: at(10, 27) },
];

/** Raw feed, in delivery order. fx-bank-001 is delivered twice (feed re-delivery). */
export const FIXTURE_BANK_LINES = [
  { source: "fixture" as const, externalId: "fx-bank-001", amountMinor: 65000, postedAt: at(10, 20), payerName: "MISSION BICYCLE CO", memo: "INV-1010 / INV-1011" },
  { source: "fixture" as const, externalId: "fx-bank-002", amountMinor: 56000, postedAt: at(10, 21), payerName: "SUNSET REC", memo: "INV-1012" },
  { source: "fixture" as const, externalId: "fx-bank-003", amountMinor: 34950, postedAt: at(10, 21), payerName: "HARBOR DENTAL GRP", memo: "PAYMENT INV 1014" },
  { source: "fixture" as const, externalId: "fx-bank-004", amountMinor: 33000, postedAt: at(10, 22), payerName: "MISSION BICYCLE CO", memo: "INV-1016" },
  { source: "fixture" as const, externalId: "fx-bank-005", amountMinor: 18000, postedAt: at(10, 22), payerName: "MISSION BICYCLE CO", memo: "ACH CREDIT" },
  { source: "fixture" as const, externalId: "fx-bank-006", amountMinor: 18000, postedAt: at(10, 22), payerName: "MISSION BICYCLE CO", memo: "ACH CREDIT" },
  { source: "fixture" as const, externalId: "fx-bank-007", amountMinor: 27500, postedAt: at(10, 23), payerName: "J SMITH CONSULTING", memo: "BILLBOARD AD" },
  { source: "fixture" as const, externalId: "fx-bank-001", amountMinor: 65000, postedAt: at(10, 20), payerName: "MISSION BICYCLE CO", memo: "INV-1010 / INV-1011" },
];

/** "Now" for the fixture scenario (Sat Oct 24 2026, 11:00 PDT). */
export const FIXTURE_AS_OF = Date.UTC(2026, 9, 24, 18, 0);
