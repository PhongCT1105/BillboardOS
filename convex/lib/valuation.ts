/**
 * Company valuation harness (ADR 0003 section 2): willingness-to-pay
 * multiplier per advertiser. Pure helpers shared by the Claude action, the
 * heuristic fallback and quotes. The multiplier is ALWAYS clamped here.
 */

export const VALUATION_MIN = 0.75;
export const VALUATION_MAX = 1.5;
export const VALUATION_TTL_MS = 24 * 60 * 60 * 1000;
export const OVERRIDE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Don't schedule another assessment for the same company within this window. */
export const REQUEST_DEBOUNCE_MS = 5 * 60 * 1000;
export const HEURISTIC_CONFIDENCE = 0.3;

export const BRAND_TIERS = ["enterprise", "established", "growth", "startup", "unknown"] as const;
export type BrandTier = (typeof BRAND_TIERS)[number];

export function clampMultiplier(m: number): number {
  if (!Number.isFinite(m)) return 1;
  return Math.round(Math.min(VALUATION_MAX, Math.max(VALUATION_MIN, m)) * 100) / 100;
}

/** Company-level inputs only: no individual people, nothing from the camera. */
export type CompanyInputs = {
  displayName: string;
  paymentTerms: string;
  campaigns: {
    brief: string;
    budgetUsd: number;
    targetCity: string | null;
    targetAudience: Record<string, number> | null;
    status: string;
  }[];
  history: {
    quotes: number;
    bookings: number;
    spendUsd: number;
  };
  payments: {
    invoices: number;
    paidLate: number;
    writtenOffOrDisputed: number;
    paidOnTime: number;
  };
  market: {
    /** Mean sale price vs time-adjusted base across this operator's screens (null if no sales). */
    averageSaleRatio: number | null;
    sales: number;
  };
};

export type Assessment = {
  multiplier: number;
  brandTier: BrandTier;
  reasoning: string;
  sources: string[];
  confidence: number;
};

/**
 * Deterministic fallback when Claude is unavailable. Declared budget and our
 * own booking/payment history only; labeled low confidence.
 */
export function heuristicAssessment(inputs: CompanyInputs): Assessment {
  const totalBudget = inputs.campaigns.filter((c) => c.status !== "cancelled").reduce((s, c) => s + c.budgetUsd, 0);
  let m = 1;
  const reasons: string[] = [];
  let tier: BrandTier = "unknown";
  if (totalBudget >= 25_000) {
    m += 0.25;
    tier = "enterprise";
    reasons.push(`declared budgets total $${totalBudget.toLocaleString("en-US")} (large advertiser): +0.25`);
  } else if (totalBudget >= 5_000) {
    m += 0.1;
    tier = "established";
    reasons.push(`declared budgets total $${totalBudget.toLocaleString("en-US")}: +0.10`);
  } else if (totalBudget > 0 && totalBudget < 100) {
    m -= 0.1;
    tier = "startup";
    reasons.push(`declared budgets total $${totalBudget.toLocaleString("en-US")} (micro budget, startup package): -0.10`);
  } else {
    reasons.push(`declared budgets total $${totalBudget.toLocaleString("en-US")}: no adjustment`);
  }
  if (inputs.history.bookings >= 3) {
    m += 0.05;
    reasons.push(`${inputs.history.bookings} past bookings (proven willingness to pay): +0.05`);
  }
  if (inputs.payments.paidLate >= 2) {
    m += 0.05;
    reasons.push(`${inputs.payments.paidLate} late payments (credit risk premium): +0.05`);
  }
  if (inputs.payments.writtenOffOrDisputed > 0) {
    m += 0.05;
    reasons.push(`${inputs.payments.writtenOffOrDisputed} written-off or disputed invoice(s): +0.05`);
  }
  if (inputs.payments.paidOnTime >= 3 && inputs.payments.paidLate === 0) {
    m -= 0.05;
    reasons.push(`${inputs.payments.paidOnTime} invoices paid on time (reliable payer): -0.05`);
  }
  const multiplier = clampMultiplier(m);
  return {
    multiplier,
    brandTier: tier,
    reasoning: `Heuristic (no model): ${reasons.join("; ")}. Result x${multiplier.toFixed(2)}.`,
    sources: [],
    confidence: HEURISTIC_CONFIDENCE,
  };
}

/** One-line, company-level summary stored with the assessment. */
export function summarizeInputs(inputs: CompanyInputs): string {
  const budget = inputs.campaigns.reduce((s, c) => s + c.budgetUsd, 0);
  return [
    `${inputs.displayName} (${inputs.paymentTerms})`,
    `${inputs.campaigns.length} campaign(s), budgets $${budget.toLocaleString("en-US")}`,
    `${inputs.history.quotes} quotes, ${inputs.history.bookings} bookings, $${inputs.history.spendUsd.toLocaleString("en-US")} spent`,
    `invoices: ${inputs.payments.invoices} (${inputs.payments.paidLate} late, ${inputs.payments.writtenOffOrDisputed} written off/disputed)`,
    inputs.market.averageSaleRatio === null
      ? "no market sales yet"
      : `market sales avg x${inputs.market.averageSaleRatio.toFixed(2)} of base over ${inputs.market.sales} sale(s)`,
  ].join("; ");
}

/** JSON schema for Claude's structured output (constraints re-checked in code). */
export const ASSESSMENT_JSON_SCHEMA = {
  type: "object",
  properties: {
    multiplier: { type: "number", description: "Willingness-to-pay multiplier, 0.75 to 1.5" },
    brandTier: { type: "string", enum: [...BRAND_TIERS] },
    reasoning: { type: "string", description: "3-6 sentences an operator can audit" },
    sources: { type: "array", items: { type: "string" }, description: "URLs relied on" },
    confidence: { type: "number", description: "0 to 1" },
  },
  required: ["multiplier", "brandTier", "reasoning", "sources", "confidence"],
  additionalProperties: false,
} as const;

/** Validate untrusted model output. Returns null if unusable. Clamps everything. */
export function parseAssessment(raw: unknown): Assessment | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.multiplier !== "number" || !Number.isFinite(o.multiplier)) return null;
  if (typeof o.reasoning !== "string" || o.reasoning.trim().length === 0) return null;
  const tier = BRAND_TIERS.includes(o.brandTier as BrandTier) ? (o.brandTier as BrandTier) : "unknown";
  const sources = Array.isArray(o.sources)
    ? o.sources.filter((s): s is string => typeof s === "string" && /^https?:\/\//.test(s) && s.length <= 500).slice(0, 10)
    : [];
  const confidence =
    typeof o.confidence === "number" && Number.isFinite(o.confidence) ? Math.min(1, Math.max(0, o.confidence)) : 0.5;
  return {
    multiplier: clampMultiplier(o.multiplier),
    brandTier: tier,
    reasoning: o.reasoning.trim().slice(0, 2000),
    sources,
    confidence,
  };
}

/** Final per-slot price after company valuation, still within the screen's floor and ceiling. */
export function applyCompanyMultiplier(
  screenMinor: number,
  multiplier: number,
  floorMinor: number,
  ceilingMinor: number,
): number {
  const raw = Math.round(screenMinor * clampMultiplier(multiplier));
  return Math.min(ceilingMinor, Math.max(floorMinor, raw));
}
