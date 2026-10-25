/// <reference types="vite/client" />
// Never call the real Claude API from tests: the company analyst falls back
// to its deterministic heuristic when no key is set.
delete process.env.ANTHROPIC_API_KEY;
import type { TestConvexForDataModel } from "convex-test";
import type { DataModel, Id } from "./_generated/dataModel";
import rateLimiterTest from "@convex-dev/rate-limiter/test";
import workpoolTest from "@convex-dev/workpool/test";

// Module map for convex-test (everything Convex would deploy, plus codegen).
export const modules = import.meta.glob([
  "./**/*.ts",
  "./**/*.js",
  "!./**/*.test.ts",
  "!./**/*.d.ts",
  "!./test.setup.ts",
]);

/** A convex-test client, with or without an identity. */
export type TestClient = TestConvexForDataModel<DataModel>;

/** Register workpool + rate-limiter components used by CREAO harnesses. */
export function registerBackendComponents(t: TestClient): void {
  // Component test helpers are typed against a looser schema than our DataModel.
  rateLimiterTest.register(t as never, "rateLimiter");
  workpoolTest.register(t as never, "creaoWorkpool");
}

const userOf = new WeakMap<object, Id<"users">>();

/** The user id behind a client created by these helpers. */
export function userIdOf(client: TestClient): Id<"users"> {
  const id = userOf.get(client);
  if (!id) throw new Error("client was not created by a test.setup helper");
  return id;
}

function signIn(t: TestClient, userId: Id<"users">, email: string): TestClient {
  // Convex Auth's getAuthUserId reads the user id from `subject` ("<userId>|<sessionId>").
  const client = t.withIdentity({ subject: `${userId}|test-session`, email });
  userOf.set(client, userId);
  return client;
}

/**
 * A host account that is a member of `workspaceName` (default "Moscone Media",
 * the seeded demo workspace; created here if seeds haven't run yet). The
 * first member becomes owner, later ones operators.
 */
export async function signedInOperator(
  t: TestClient,
  email = "ops@billboardos.test",
  workspaceName = "Moscone Media",
): Promise<TestClient> {
  const userId = await t.run(async (ctx) => {
    const id = await ctx.db.insert("users", { email });
    let workspace = await ctx.db
      .query("workspaces")
      .withIndex("by_name", (q) => q.eq("name", workspaceName))
      .first();
    if (!workspace) {
      const wsId = await ctx.db.insert("workspaces", { name: workspaceName, city: "San Francisco" });
      workspace = (await ctx.db.get(wsId))!;
    }
    const existing = await ctx.db
      .query("workspaceMembers")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", workspace._id))
      .first();
    await ctx.db.insert("workspaceMembers", {
      workspaceId: workspace._id,
      userId: id,
      email,
      role: existing ? "operator" : "owner",
    });
    await ctx.db.insert("profiles", { userId: id, accountType: "host", activeWorkspaceId: workspace._id });
    return id;
  });
  return signIn(t, userId, email);
}

/** Let an existing test client also act for customer companies (all of them by default). */
export async function joinCompanies(client: TestClient, advertiserIds?: Id<"advertisers">[]): Promise<void> {
  const userId = userIdOf(client);
  await client.run(async (ctx) => {
    const user = await ctx.db.get(userId);
    const ids = advertiserIds ?? (await ctx.db.query("advertisers").take(100)).map((a) => a._id);
    for (const advertiserId of ids) {
      const existing = await ctx.db
        .query("advertiserMembers")
        .withIndex("by_advertiser_and_user", (q) => q.eq("advertiserId", advertiserId).eq("userId", userId))
        .unique();
      if (!existing) {
        await ctx.db.insert("advertiserMembers", { advertiserId, userId, email: user?.email ?? "?", role: "member" });
      }
    }
  });
}

/** A customer account acting for exactly one company. */
export async function signedInCustomer(
  t: TestClient,
  advertiserId: Id<"advertisers">,
  email = "buyer@customer.test",
): Promise<TestClient> {
  const userId = await t.run(async (ctx) => {
    const id = await ctx.db.insert("users", { email });
    await ctx.db.insert("profiles", { userId: id, accountType: "customer" });
    await ctx.db.insert("advertiserMembers", { advertiserId, userId: id, email, role: "owner" });
    return id;
  });
  return signIn(t, userId, email);
}

/** A signed-in account with no workspace and no company. */
export async function signedInUser(t: TestClient, email = "someone@billboardos.test"): Promise<TestClient> {
  const userId = await t.run(async (ctx) => ctx.db.insert("users", { email }));
  return signIn(t, userId, email);
}

/** A quote for a campaign's slots at the screen's base rate (as a round deal writes one). */
export async function quoteFor(client: TestClient, args: { campaignId: Id<"campaigns">; slotIds: Id<"slots">[]; amountMinor?: number }) {
  return await client.run(async (ctx) => {
    const slot = (await ctx.db.get(args.slotIds[0]))!;
    const billboard = (await ctx.db.get(slot.billboardId))!;
    const amountMinor = args.amountMinor ?? billboard.baseRateMinor * args.slotIds.length;
    const quoteId = await ctx.db.insert("quotes", {
      workspaceId: billboard.workspaceId,
      campaignId: args.campaignId,
      billboardId: billboard._id,
      slotIds: args.slotIds,
      amountMinor,
      currency: "USD",
      expiresAt: Date.now() + 10 * 60_000,
      pricingBasis: ["test"],
      confidence: "medium",
      policyVersion: "test",
      status: "open",
      traceId: `test:${args.campaignId}:${args.slotIds.join(",")}`,
    });
    return { quoteId, amountMinor, traceId: `test:${args.campaignId}:${args.slotIds.join(",")}` };
  });
}

/** An exclusive hold on a quote's slots (the same takeHold a round deal uses). */
export async function holdFor(client: TestClient, quote: { quoteId: Id<"quotes"> }, idempotencyKey: string, actor = "buyer") {
  const { takeHold, toResult } = await import("./holds");
  return await client.run(async (ctx) => toResult(await takeHold(ctx, (await ctx.db.get(quote.quoteId))!, idempotencyKey, actor), false));
}
