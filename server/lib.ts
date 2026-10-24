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

// Money and explorer helpers are shared with the Convex x402 endpoints (one implementation).
export { USDC_DECIMALS, atomicToCents, centsToAtomic, centsToUsd, decimalToCents, explorerTxUrl } from "../convex/lib/x402/money.ts";

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

/**
 * Where x402 payments and seller agents live. Default: the Convex deployment
 * itself (ADR 0006, one OS server: CONVEX_SITE_URL). Override with
 * X402_SERVER_URL or a --server flag (e.g. a local fork).
 */
export function paymentServerUrl(override?: string): string {
  const url = override ?? env("X402_SERVER_URL") ?? env("CONVEX_SITE_URL");
  if (!url) {
    console.error("Missing CONVEX_SITE_URL in .env (the Convex deployment serves the x402 endpoints).");
    process.exit(1);
  }
  return url.replace(/\/$/, "");
}
