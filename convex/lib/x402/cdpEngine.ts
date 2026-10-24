"use node";
/**
 * CDP-backed x402 resource server for the Convex payment endpoints (node
 * runtime only). Credentials come from the Convex deployment env:
 *   CDP_API_KEY_ID, CDP_API_KEY_SECRET      CDP facilitator (verify + settle)
 *   X402_PAY_TO                             default receiver (workspaces without a payout address)
 *   CDP_WALLET_SECRET (+ X402_RECEIVER_WALLET_NAME)  alternative: provision a CDP wallet as the default receiver
 *   X402_NETWORK (default eip155:84532), X402_ENVIRONMENT (default development)
 * Cached per warm action instance.
 */
import { createX402Server, type X402Server } from "@coinbase/cdp-sdk/x402";
import { paidRoutes, type Engine } from "./flow";

export type EngineHandle = { engine: Engine; defaultPayTo: string; network: `${string}:${string}` };

let cached: Promise<EngineHandle> | null = null;

export function x402Config() {
  const network = (process.env.X402_NETWORK || "eip155:84532") as `${string}:${string}`;
  const environment: "development" | "production" = process.env.X402_ENVIRONMENT === "production" ? "production" : "development";
  return { network, environment };
}

async function build(): Promise<EngineHandle> {
  const { network, environment } = x402Config();
  if (!process.env.CDP_API_KEY_ID || !process.env.CDP_API_KEY_SECRET) {
    throw new Error("x402 is not configured: set CDP_API_KEY_ID and CDP_API_KEY_SECRET on this Convex deployment");
  }
  const payTo = process.env.X402_PAY_TO?.trim();
  const routes = paidRoutes(network);
  let server: X402Server;
  if (payTo) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(payTo)) throw new Error("X402_PAY_TO must be a 0x-prefixed 20-byte EVM address");
    server = await createX402Server({ environment, payToConfig: { type: "address", evm: payTo as `0x${string}` }, routes });
  } else if (process.env.CDP_WALLET_SECRET) {
    server = await createX402Server({
      environment,
      payToConfig: { type: "eoa", accountName: process.env.X402_RECEIVER_WALLET_NAME || "billboardos-operator" },
      routes,
    });
  } else {
    throw new Error("x402 has no default receiver: set X402_PAY_TO (or CDP_WALLET_SECRET) on this Convex deployment");
  }
  return { engine: server, defaultPayTo: server.payToEvmAddress ?? payTo ?? "", network };
}

/** The resource server, built once per warm instance (a failed build is retried next call). */
export function getEngine(): Promise<EngineHandle> {
  if (!cached) {
    cached = build().catch((error: unknown) => {
      cached = null;
      throw error;
    });
  }
  return cached;
}
