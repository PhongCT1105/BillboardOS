/**
 * Agent webhook signing (ADR 0004, timestamp binding per ADR 0005 §4).
 * Web Crypto only, so it runs in the default Convex runtime and in tests.
 *
 * Every delivery carries two headers:
 *   X-BillboardOS-Timestamp: <unix ms>, e.g. 1792860225315
 *   X-BillboardOS-Signature: sha256=<hex HMAC-SHA256(key = webhookSecret,
 *                                     message = "<timestamp>.<raw body>")>
 *
 * The signed message is the timestamp header value, a literal ".", then the
 * exact raw request body bytes (UTF-8). Receivers must:
 *   1. recompute the HMAC over "<X-BillboardOS-Timestamp>.<raw body>" and
 *      compare in constant time;
 *   2. reject timestamps outside a small window (e.g. 5 minutes), so a
 *      captured delivery can't be replayed later with a fresh timestamp.
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

/** The exact string that gets signed: "<timestamp>.<raw body>". */
export function signedPayload(timestamp: string, rawBody: string): string {
  return `${timestamp}.${rawBody}`;
}

/** `sha256=<hex>` HMAC of "<timestamp>.<raw body>" with the key's webhook secret. */
export async function signWebhook(secret: string, timestamp: string, rawBody: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, enc.encode(signedPayload(timestamp, rawBody)));
  return `sha256=${hex(mac)}`;
}

/** Delay before the next attempt after `attempts` failures, or null when out of attempts. */
export function nextRetryDelay(attempts: number): number | null {
  if (attempts >= MAX_DELIVERY_ATTEMPTS) return null;
  return RETRY_BACKOFF_MS[Math.min(attempts - 1, RETRY_BACKOFF_MS.length - 1)] ?? null;
}
