import { convexTest } from "convex-test";
import { beforeEach, afterEach, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { modules, signedInOperator } from "./test.setup";
import { FIXTURE_AS_OF } from "./fixtures/financeFixture";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(FIXTURE_AS_OF);
});
afterEach(() => {
  vi.useRealTimers();
});

test("the open case is the short payment, with collections history attached", async () => {
  const t = await signedInOperator(convexTest(schema, modules));
  await t.mutation(internal.seed.finance, {});
  const waiting = await t.query(api.financeCase.caseFile, {});
  expect(waiting.moment).toBeNull();
  expect(waiting.unmatchedLines).toBeGreaterThan(0);
  expect(waiting.bankSource).toBe("fixture");
  expect(waiting.seats.map((seat) => seat.id)).toEqual(["ar", "collections", "controller"]);

  await t.mutation(internal.reconciliation.run, {});
  await t.mutation(internal.collections.plan, { asOf: FIXTURE_AS_OF });

  const file = await t.query(api.financeCase.caseFile, {});
  expect(file.moment).toMatchObject({
    kind: "short_payment",
    invoiceNumber: "INV-1012",
    advertiserName: "Sunset Records",
    expectedMinor: 60000,
    observedMinor: 56000,
    appliedBy: "agent:ar",
    collections: { invoiceNumber: "INV-1012", tone: "firm" },
  });
  expect(file.moment?.defense).toContain("INV-1012");
  expect(file.moment?.collections?.reason.length).toBeGreaterThan(0);
});
