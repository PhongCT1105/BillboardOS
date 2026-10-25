import { convexTest } from "convex-test";
import { ConvexError } from "convex/values";
import { expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import { modules, signedInOperator } from "./test.setup";

test("a finished rehearsal is stored and the newest one is what the console reads", async () => {
  const t = await signedInOperator(convexTest(schema, modules));
  expect(await t.query(api.creaoHandoff.latest, {})).toBeNull();
  const roster = await t.query(api.creaoHandoff.roster, {});
  expect(roster.map((role) => role.id)).toEqual([
    "sales",
    "revenue",
    "company_research",
    "screen_audience",
    "creative_safety",
    "price_refine",
    "invite_rotate",
    "opportunity_strategy",
  ]);
  expect(roster.every((role) => role.configured === false)).toBe(true);
  expect(roster.find((role) => role.id === "opportunity_strategy")?.wired).toBe(false);
  expect(roster.find((role) => role.id === "price_refine")?.wired).toBe(true);
  expect(roster.find((role) => role.id === "invite_rotate")?.wired).toBe(true);
  expect(roster.find((role) => role.id === "sales")?.wired).toBe(true);

  await t.mutation(api.creaoHandoff.record, {
    traceId: "trace-1",
    snapshotId: "snap-1",
    selectedCampaigns: ["camp-a"],
    pricingPlans: 1,
    preparedOffers: 1,
  });
  const second = await t.mutation(api.creaoHandoff.record, {
    traceId: "trace-2",
    snapshotId: "snap-1",
    selectedCampaigns: ["camp-a", "camp-b"],
    pricingPlans: 2,
    preparedOffers: 0,
  });

  const latest = await t.query(api.creaoHandoff.latest, {});
  expect(latest?._id).toBe(second);
  expect(latest).toMatchObject({
    mode: "simulated_rehearsal",
    deliveredOffers: 0,
    selectedCampaigns: ["camp-a", "camp-b"],
    pricingPlans: 2,
    preparedOffers: 0,
  });
  expect(latest?.summary).toContain("delivered 0");
});

test("a visitor cannot save a handoff", async () => {
  const t = convexTest(schema, modules);
  await expect(
    t.mutation(api.creaoHandoff.record, {
      traceId: "trace-1",
      snapshotId: "snap-1",
      selectedCampaigns: ["camp-a"],
      pricingPlans: 1,
      preparedOffers: 0,
    }),
  ).rejects.toBeInstanceOf(ConvexError);
});
