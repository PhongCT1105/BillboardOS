/**
 * Tiny receiver for BillboardOS watch-alert webhooks (ADR 0004).
 *
 *   npm run webhook:listen            # listens on http://localhost:8787/alerts
 *
 * Env: WEBHOOK_SECRET (the agent key's whsec_... secret, printed once by
 * `npx convex run seed:demoWatchRules` or shown once when you create a key),
 * WEBHOOK_PORT (default 8787), WEBHOOK_MAX_SKEW_SECONDS (default 300).
 *
 * Verifies `X-BillboardOS-Signature: sha256=<hex HMAC-SHA256(raw body, secret)>`
 * in constant time, rejects stale `X-BillboardOS-Timestamp`s, prints the alert
 * and answers 200 so BillboardOS records it as delivered.
 *
 * Convex cloud cannot reach your laptop's localhost: expose this with a tunnel
 * (e.g. `cloudflared tunnel --url http://localhost:8787`) and use the https
 * tunnel URL + "/alerts" as the key's webhook URL.
 */
import { createServer } from "node:http";
import { createHmac, timingSafeEqual } from "node:crypto";
import { env, requireEnv } from "./lib.ts";

const secret = requireEnv("WEBHOOK_SECRET", "the agent key's webhook secret (whsec_...)");
const port = Number(env("WEBHOOK_PORT") ?? 8787);
const maxSkewMs = Number(env("WEBHOOK_MAX_SKEW_SECONDS") ?? 300) * 1000;
const MAX_BODY_BYTES = 256 * 1024;

export function verify(rawBody: string, signatureHeader: string | undefined, key: string): boolean {
  const match = /^sha256=([0-9a-f]{64})$/.exec(signatureHeader ?? "");
  if (!match) return false;
  const expected = createHmac("sha256", key).update(rawBody, "utf8").digest();
  const given = Buffer.from(match[1], "hex");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

type AlertSlot = { slotId: string; startAt: number; endAt: number; screenPriceMinor: number };
type AlertPayload = {
  alertId: string;
  trigger: string;
  campaignId: string;
  billboard: { name: string; city: string };
  slots: AlertSlot[];
  matchCount: number;
  auctionId?: string;
  reason: string;
  createdAt: number;
};

const usd = (minor: number) => `$${(minor / 100).toFixed(2)}`;
const time = (ts: number) => new Date(ts).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

function print(alert: AlertPayload) {
  console.log(`\n[${new Date().toLocaleTimeString()}] ${alert.trigger.toUpperCase()} on ${alert.billboard.name} (${alert.billboard.city})`);
  console.log(`  ${alert.reason}`);
  for (const s of alert.slots) console.log(`  - ${time(s.startAt)}-${time(s.endAt)}  ${usd(s.screenPriceMinor)}  slot ${s.slotId}`);
  if (alert.matchCount > alert.slots.length) console.log(`  (+${alert.matchCount - alert.slots.length} more matching slots)`);
  if (alert.auctionId) console.log(`  auction ${alert.auctionId}`);
  console.log(`  alert ${alert.alertId}  campaign ${alert.campaignId}`);
  console.log(`  next: POST /api/agent/quotes {"campaignId":"${alert.campaignId}","slotIds":[...]}`);
}

const server = createServer((req, res) => {
  const reply = (status: number, body: Record<string, unknown>) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };
  if (req.method !== "POST" || !req.url?.startsWith("/alerts")) return reply(404, { error: "POST /alerts" });
  const chunks: Buffer[] = [];
  let size = 0;
  req.on("data", (chunk: Buffer) => {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) req.destroy();
    else chunks.push(chunk);
  });
  req.on("end", () => {
    const raw = Buffer.concat(chunks).toString("utf8");
    const signature = req.headers["x-billboardos-signature"];
    if (!verify(raw, Array.isArray(signature) ? signature[0] : signature, secret)) {
      console.warn(`[${new Date().toLocaleTimeString()}] rejected: bad signature`);
      return reply(401, { error: "bad signature" });
    }
    const ts = Number(req.headers["x-billboardos-timestamp"]);
    if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > maxSkewMs) {
      console.warn(`[${new Date().toLocaleTimeString()}] rejected: stale timestamp`);
      return reply(401, { error: "stale timestamp" });
    }
    try {
      print(JSON.parse(raw) as AlertPayload);
    } catch {
      return reply(400, { error: "body is not JSON" });
    }
    reply(200, { ok: true });
  });
});

server.listen(port, () => {
  console.log(`Listening for BillboardOS alerts on http://localhost:${port}/alerts (signature check on)`);
});
