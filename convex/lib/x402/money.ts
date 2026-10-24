/**
 * Exact USD-cent <-> USDC conversions and explorer links, shared by the
 * Convex x402 endpoints and the server/ agent scripts. No floats, no imports.
 */

/** USDC has 6 decimals; 1 US cent = 10^4 atomic units. */
export const USDC_DECIMALS = 6;
const ATOMIC_PER_CENT = 10_000n;

/** Integer cents -> x402 Money string, e.g. 1234 -> "$12.34". Exact, no floats. */
export function centsToUsd(cents: number): string {
  if (!Number.isSafeInteger(cents) || cents <= 0) {
    throw new Error(`amount must be a positive integer number of cents, got ${cents}`);
  }
  const dollars = Math.floor(cents / 100);
  const rest = String(cents % 100).padStart(2, "0");
  return `$${dollars}.${rest}`;
}

/** Integer cents -> USDC atomic units (6 decimals), as a decimal string. */
export function centsToAtomic(cents: number): string {
  if (!Number.isSafeInteger(cents) || cents < 0) {
    throw new Error(`cents must be a non-negative integer, got ${cents}`);
  }
  return (BigInt(cents) * ATOMIC_PER_CENT).toString();
}

/**
 * USDC atomic units -> integer cents. Throws unless the amount is a whole
 * number of cents (e.g. 123_4500 -> throws; 123_0000 -> 123).
 */
export function atomicToCents(atomic: string): number {
  if (!/^\d+$/.test(atomic)) throw new Error(`invalid atomic amount "${atomic}"`);
  const value = BigInt(atomic);
  if (value % ATOMIC_PER_CENT !== 0n) {
    throw new Error(`atomic amount ${atomic} is not a whole number of US cents`);
  }
  const cents = value / ATOMIC_PER_CENT;
  if (cents > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`amount ${atomic} too large`);
  return Number(cents);
}

/** Decimal USDC/USD string (max 2 decimals) -> integer cents, e.g. "50" -> 5000, "0.5" -> 50. */
export function decimalToCents(value: string): number {
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(value.trim());
  if (!match) throw new Error(`"${value}" is not a USD amount with at most 2 decimals`);
  const cents = Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0"));
  if (!Number.isSafeInteger(cents)) throw new Error(`"${value}" is too large`);
  return cents;
}

/** Block explorer link for a settlement transaction. */
export function explorerTxUrl(network: string, tx: string): string | undefined {
  if (!/^0x[0-9a-fA-F]{64}$/.test(tx)) return undefined;
  if (network === "eip155:84532") return `https://sepolia.basescan.org/tx/${tx}`;
  if (network === "eip155:8453") return `https://basescan.org/tx/${tx}`;
  return undefined;
}
