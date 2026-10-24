/**
 * Shared helpers for the x402 payment server and the buyer agent:
 * env loading (never prints secret values), exact USDC <-> USD-cent conversion,
 * and small logging utilities.
 */
import { config as loadDotenv } from "dotenv";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Shell env wins over .env (dotenv does not override by default).
loadDotenv({ path: resolve(ROOT, ".env"), quiet: true });

/** Optional env var; empty strings count as unset. */
export function env(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

/** Required env var; exits with a clear message (never the value) when missing. */
export function requireEnv(name: string, why: string): string {
  const value = env(name);
  if (!value) {
    console.error(`Missing ${name} in .env (${why}).`);
    process.exit(1);
  }
  return value;
}

/** "set" / "missing" for logs. Never prints the value. */
export function presence(name: string): "set" | "missing" {
  return env(name) ? "set" : "missing";
}

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

/** CDP SDK network names for the networks we use. */
export function cdpNetworkName(network: string): "base-sepolia" | "base" {
  if (network === "eip155:84532") return "base-sepolia";
  if (network === "eip155:8453") return "base";
  throw new Error(`Unsupported network ${network}; use eip155:84532 (Base Sepolia)`);
}

/** Structured error from the BillboardOS agent API ({ error: { code, message, ... } }). */
export class AgentApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(`${code}: ${message}`);
  }
}

/**
 * Minimal client for the BillboardOS agent HTTP API (ADR 0004):
 * `Authorization: Bearer bos_agent_...`, JSON in and out.
 */
export function agentApi(siteUrl: string, key: string) {
  const base = `${siteUrl.replace(/\/$/, "")}/api/agent/`;
  async function request<T>(method: "GET" | "POST", path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
    const res = await fetch(base + path.replace(/^\//, ""), {
      method,
      headers: {
        Authorization: `Bearer ${key}`,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const json = (await res.json().catch(() => ({}))) as { error?: { code?: string; message?: string } & Record<string, unknown> };
    if (!res.ok) {
      const err = json.error ?? {};
      throw new AgentApiError(res.status, err.code ?? `HTTP_${res.status}`, err.message ?? res.statusText, err);
    }
    return json as T;
  }
  return {
    get: <T>(path: string, headers?: Record<string, string>) => request<T>("GET", path, undefined, headers),
    post: <T>(path: string, body: unknown) => request<T>("POST", path, body),
  };
}
