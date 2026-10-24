import { convexTest } from "convex-test";
import { ConvexError } from "convex/values";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { modules, signedInOperator, signedInUser, joinCompanies } from "./test.setup";
import { applyCompanyMultiplier, heuristicAssessment, parseAssessment, type CompanyInputs } from "./lib/valuation";

const START = Date.UTC(2026, 9, 25, 16, 7);
const MIN = 60_000;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  vi.setSystemTime(START);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  delete process.env.ANTHROPIC_API_KEY;
});

async function errorCode(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ConvexError) return (error.data as { code: string }).code;
    throw error;
  }
  throw new Error("expected promise to reject");
}

async function world() {
  const anon = convexTest(schema, modules);
  const t = await signedInOperator(anon);
  const seed = await t.mutation(internal.seed.demo, {});
  await joinCompanies(t);
  const demo = await t.mutation(internal.seed.pricingDemo, {});
  await joinCompanies(t);
  const slots = await t.query(api.slots.listForBillboard, {
    billboardId: seed.billboardId,
    from: START,
    to: START + 24 * 60 * MIN,
  });
  return { anon, t, seed, demo, slots };
}

const inputs = (over: Partial<CompanyInputs> = {}): CompanyInputs => ({
  displayName: "Acme",
  paymentTerms: "prepay",
  campaigns: [],
  history: { quotes: 0, bookings: 0, spendUsd: 0 },
  payments: { invoices: 0, paidLate: 0, writtenOffOrDisputed: 0, paidOnTime: 0 },
  market: { averageSaleRatio: null, sales: 0 },
  ...over,
});
const campaign = (budgetUsd: number) => ({ brief: "b", budgetUsd, targetCity: null, targetAudience: null, status: "active" });

describe("valuation logic (pure)", () => {
  test("heuristic uses declared budget and our history; clamped", () => {
    expect(heuristicAssessment(inputs()).multiplier).toBe(1);
    expect(heuristicAssessment(inputs({ campaigns: [campaign(5000)] }))).toMatchObject({ multiplier: 1.1, brandTier: "established" });
    expect(heuristicAssessment(inputs({ campaigns: [campaign(50)] }))).toMatchObject({ multiplier: 0.9, brandTier: "startup" });
    const big = heuristicAssessment(
      inputs({
        campaigns: [campaign(100_000)],
        history: { quotes: 9, bookings: 5, spendUsd: 900 },
        payments: { invoices: 4, paidLate: 2, writtenOffOrDisputed: 1, paidOnTime: 2 },
      }),
    );
    expect(big.multiplier).toBe(1.4);
    expect(big.confidence).toBe(0.3);
    expect(big.reasoning).toContain("Heuristic");
  });

  test("model output is validated and clamped in code", () => {
    expect(parseAssessment({ multiplier: 3, brandTier: "enterprise", reasoning: "Big", sources: ["https://a.example", "not a url"], confidence: 4 })).toEqual({
      multiplier: 1.5,
      brandTier: "enterprise",
      reasoning: "Big",
      sources: ["https://a.example"],
      confidence: 1,
    });
    expect(parseAssessment({ multiplier: 0.1, brandTier: "mega", reasoning: "x", sources: [], confidence: 0.5 })).toMatchObject({
      multiplier: 0.75,
      brandTier: "unknown",
    });
    expect(parseAssessment({ multiplier: "1.2", reasoning: "x" })).toBeNull();
    expect(parseAssessment({ multiplier: 1.2, reasoning: "" })).toBeNull();
    // Final price stays inside the screen's floor and ceiling.
    expect(applyCompanyMultiplier(4000, 1.5, 2000, 5000)).toBe(5000);
    expect(applyCompanyMultiplier(2100, 0.75, 2000, 16000)).toBe(2000);
  });
});

describe("company pricing on posted quotes", () => {
  test("hidden from the buyer, recorded for the operator, cached and refreshed in the background", async () => {
    const { t, demo, slots } = await world();
    // Nvidia: $5,000 declared budget -> heuristic x1.10 while no assessment exists yet.
    const q = await t.mutation(api.quotes.create, { campaignId: demo.nvidiaCampaignId, slotIds: [slots[20]._id] });
    const screen = q.priceBreakdown[0].screenMinor;
    expect(q.amountMinor).toBe(Math.round(screen * 1.1));
    const buyerText = JSON.stringify(q);
    expect(buyerText).not.toMatch(/multiplier.*1\\.1|company|valuation|heuristic|reasoning/i);
    expect(q.pricingBasis.at(-1)).toBe(`Price for your account: $${(q.amountMinor / 100).toFixed(2)}`);

    const stored = await t.run(async (ctx) => ctx.db.get(q.quoteId));
    expect(stored).toMatchObject({ companyMultiplier: 1.1, companyMethod: "inline_heuristic", screenAmountMinor: screen });

    // The scheduled analyst runs (no key in tests -> heuristic) and caches the result.
    await t.finishInProgressScheduledFunctions();
    vi.advanceTimersByTime(1);
    await t.finishInProgressScheduledFunctions();
    const list = await t.query(api.valuation.list, {});
    const nvidia = list.find((r) => r.displayName === "Nvidia")!;
    expect(nvidia.assessment).toMatchObject({ method: "heuristic", multiplier: 1.1, fresh: true, brandTier: "established" });

    const q2 = await t.mutation(api.quotes.create, { campaignId: demo.nvidiaCampaignId, slotIds: [slots[21]._id] });
    const stored2 = await t.run(async (ctx) => ctx.db.get(q2.quoteId));
    expect(stored2).toMatchObject({ companyMethod: "heuristic", companyAssessmentId: nvidia.assessment!._id });

    // Company valuation is platform-level: its audit events carry no workspace.
    const audit = await t.run(async (ctx) => ctx.db.query("auditEvents").withIndex("by_subject", (q) => q.eq("subjectId", demo.nvidiaAdvertiserId)).take(50));
    expect(audit.some((e) => e.type === "valuation.assessed" && e.actor === "system:valuation-heuristic")).toBe(true);
  });

  test("workspace override pins the multiplier for this workspace's quotes, even after an automated run", async () => {
    const { anon, t, demo, slots } = await world();
    const stranger = await signedInUser(anon);
    expect(
      await errorCode(stranger.mutation(api.valuation.override, { advertiserId: demo.nvidiaAdvertiserId, multiplier: 1.4, reason: "x" })),
    ).toBe("NO_WORKSPACE");
    expect(await errorCode(anon.query(api.valuation.list, {}))).toBe("UNAUTHENTICATED");
    expect(
      await errorCode(t.mutation(api.valuation.override, { advertiserId: demo.nvidiaAdvertiserId, multiplier: 2, reason: "x" })),
    ).toBe("INVALID_INPUT");

    // Hosts can only price companies that have quoted their screens.
    await t.mutation(api.quotes.create, { campaignId: demo.nvidiaCampaignId, slotIds: [slots[19]._id] });
    await t.mutation(api.valuation.override, {
      advertiserId: demo.nvidiaAdvertiserId,
      multiplier: 1.4,
      reason: "Global brand; GTC week",
    });
    const q = await t.mutation(api.quotes.create, { campaignId: demo.nvidiaCampaignId, slotIds: [slots[20]._id] });
    expect(q.amountMinor).toBe(Math.round(q.priceBreakdown[0].screenMinor * 1.4));

    // An automated (platform) run is stored, but this workspace's override keeps winning here.
    const r = await t.action(internal.valuationAgent.assessCompany, { advertiserId: demo.nvidiaAdvertiserId, reason: "test" });
    expect(r.method).toBe("heuristic");
    const q2 = await t.mutation(api.quotes.create, { campaignId: demo.nvidiaCampaignId, slotIds: [slots[21]._id] });
    expect(q2.amountMinor).toBe(Math.round(q2.priceBreakdown[0].screenMinor * 1.4));
    const audit = await t.query(api.audit.recent, {});
    expect(audit.find((e) => e.type === "valuation.overridden")?.actor).toBe("operator:ops@billboardos.test");
  });

  test("campaign creation kicks off an assessment", async () => {
    const { t, seed } = await world();
    await t.mutation(api.campaigns.create, { advertiserId: seed.advertiserIds[1], brief: "robots", budgetMinor: 10_000 });
    const advertiser = await t.run(async (ctx) => ctx.db.get(seed.advertiserIds[1]));
    expect(Math.abs((advertiser?.valuationRequestedAt ?? 0) - Date.now())).toBeLessThan(1000);
  });
});

describe("Claude company analyst (mocked API)", () => {
  function jsonResponse(body: unknown) {
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }
  const message = (content: unknown[], stop_reason: string, extra: Record<string, unknown> = {}) => ({
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "claude-opus-5-5",
    content,
    stop_reason,
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 10 },
    ...extra,
  });

  test("web search + structured output, pause_turn continuation, clamp, sources, request shape", async () => {
    const { t, demo, slots } = await world();
    process.env.ANTHROPIC_API_KEY = "test-key";
    const bodies: Record<string, unknown>[] = [];
    const headers: Headers[] = [];
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      headers.push(new Headers(init?.headers));
      if (bodies.length === 1) {
        return jsonResponse(
          message(
            [
              { type: "server_tool_use", id: "srvtoolu_1", name: "web_search", input: { query: "Nvidia advertising" } },
              {
                type: "web_search_tool_result",
                tool_use_id: "srvtoolu_1",
                content: [{ type: "web_search_result", url: "https://news.example/nvidia", title: "Nvidia", encrypted_content: "x", page_age: null }],
              },
              { type: "server_tool_use", id: "srvtoolu_2", name: "web_search", input: { query: "Nvidia GTC" } },
              { type: "web_search_tool_result", tool_use_id: "srvtoolu_2", content: { type: "web_search_tool_result_error", error_code: "max_uses_exceeded" } },
            ],
            "pause_turn",
          ),
        );
      }
      return jsonResponse(
        message(
          [
            {
              type: "text",
              text: JSON.stringify({
                multiplier: 2.4,
                brandTier: "enterprise",
                reasoning: "Global chip maker with very large marketing budgets; GTC drives developer attention.",
                sources: ["https://news.example/nvidia", "https://made-up.example/x"],
                confidence: 0.85,
              }),
            },
          ],
          "end_turn",
        ),
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const r = await t.action(internal.valuationAgent.assessCompany, { advertiserId: demo.nvidiaAdvertiserId, reason: "test" });
    expect(r).toEqual({ method: "claude", multiplier: 1.5 });
    expect(bodies).toHaveLength(2);
    const first = bodies[0];
    expect(first).toMatchObject({
      model: "claude-opus-5-5",
      fallbacks: "default",
      thinking: { type: "adaptive" },
      output_config: { effort: "medium", format: { type: "json_schema" } },
      tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 5 }],
    });
    expect(headers[0].get("anthropic-beta")).toContain("server-side-fallback-2026-07-01");
    // Resumed with the paused assistant turn appended, no extra user message.
    const second = bodies[1] as { messages: { role: string }[] };
    expect(second.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    // No personal data: the request carries company-level inputs only.
    expect(JSON.stringify(first)).toContain("Nvidia");

    await t.mutation(api.quotes.create, { campaignId: demo.nvidiaCampaignId, slotIds: [slots[19]._id] });
    const list = await t.query(api.valuation.list, {});
    const a = list.find((x) => x.displayName === "Nvidia")!.assessment!;
    expect(a).toMatchObject({ method: "claude", multiplier: 1.5, brandTier: "enterprise", model: "claude-opus-5-5" });
    expect(a.sources).toEqual(["https://news.example/nvidia"]);
    expect(a.reasoning).toContain("max_uses_exceeded");
  });

  test("refusal or API failure falls back to the heuristic and is audited", async () => {
    const { t, demo } = await world();
    process.env.ANTHROPIC_API_KEY = "test-key";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(message([], "refusal", { stop_details: { type: "refusal", category: null, explanation: null } }))),
    );
    const r = await t.action(internal.valuationAgent.assessCompany, { advertiserId: demo.nvidiaAdvertiserId, reason: "test" });
    expect(r).toEqual({ method: "heuristic", multiplier: 1.1 });
    const audit = await t.run(async (ctx) => ctx.db.query("auditEvents").withIndex("by_subject", (q) => q.eq("subjectId", demo.nvidiaAdvertiserId)).take(50));
    expect(audit.find((e) => e.type === "valuation.failed")?.reason).toContain("Model declined");
  });
});
