import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import { modules, signedInOperator, type TestClient } from "./test.setup";

// Sunday 2026-10-25, 09:07 PDT.
const START = Date.UTC(2026, 9, 25, 16, 7);
const SITE = "https://site.test";
const SECRET = "test-internal-secret-0123456789";

let current: TestClient | null = null;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(START);
  process.env.INTERNAL_API_SECRET = SECRET;
  process.env.CONVEX_SITE_URL = SITE;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.startsWith(SITE) && current) return await current.fetch(url.slice(SITE.length), init);
      if (url.startsWith("https://agent.test/")) return new Response("ok", { status: 200 });
      throw new Error(`unexpected fetch ${url}`);
    }),
  );
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  delete process.env.INTERNAL_API_SECRET;
  delete process.env.CONVEX_SITE_URL;
  current = null;
});

describe("live auction settings", () => {
  test("settings defaults: 1 person in view, 2 s join window, no cooldown or rehearsal", async () => {
    const t = convexTest(schema, modules);
    current = t;
    const host = await signedInOperator(t, "host@moscone.test");
    expect(await host.query(api.moments.settings, {})).toEqual({ enabled: true, minPeopleInView: 1, joinWindowSeconds: 2, minMatch: 0.3 });
  });
});
