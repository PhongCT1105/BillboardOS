/**
 * Agent webhook signing (ADR 0004). Web Crypto only, so it runs in the
 * default Convex runtime and in tests. Receivers verify:
 *   X-BillboardOS-Signature: sha256=<hex HMAC-SHA256(raw body, webhookSecret)>
 *   X-BillboardOS-Timestamp: <unix ms> (reject stale deliveries if you like)
 */

export const SIGNATURE_HEADER = "X-BillboardOS-Signature";
export const TIMESTAMP_HEADER = "X-BillboardOS-Timestamp";
export const WEBHOOK_TIMEOUT_MS = 10_000;
export const MAX_DELIVERY_ATTEMPTS = 3;
/** Wait before attempt 2 and attempt 3. */
export const RETRY_BACKOFF_MS = [5_000, 30_000];

function hex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** `sha256=<hex>` for the exact bytes of `rawBody`. */
export async function signWebhook(secret: string, rawBody: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, enc.encode(rawBody));
  return `sha256=${hex(mac)}`;
}

/** Delay before the next attempt after `attempts` failures, or null when out of attempts. */
export function nextRetryDelay(attempts: number): number | null {
  if (attempts >= MAX_DELIVERY_ATTEMPTS) return null;
  return RETRY_BACKOFF_MS[Math.min(attempts - 1, RETRY_BACKOFF_MS.length - 1)] ?? null;
}
