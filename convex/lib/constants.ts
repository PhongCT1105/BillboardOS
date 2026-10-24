/** How long a quote stays acceptable (can be turned into a hold). */
export const QUOTE_TTL_MS = 10 * 60 * 1000;

/** How long an exclusive hold lasts before slots return to inventory. */
export const HOLD_TTL_MS = 5 * 60 * 1000;

/** Max slots in a single quote / hold. */
export const MAX_SLOTS_PER_QUOTE = 16;

/** Assets accepted as settlement for a USD-denominated quote. */
export const ACCEPTED_PAYMENT_ASSETS: readonly string[] = ["USD", "USDC"];

/** Bound for free-form identifier strings supplied by callers. */
export const MAX_KEY_LENGTH = 128;
