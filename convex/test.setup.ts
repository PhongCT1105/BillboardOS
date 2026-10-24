/// <reference types="vite/client" />
import type { TestConvexForDataModel } from "convex-test";
import type { DataModel } from "./_generated/dataModel";

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

/**
 * Create a Convex Auth user + operator grant and return a client signed in as
 * them. Convex Auth's getAuthUserId reads the user id from `subject`
 * ("<userId>|<sessionId>").
 */
export async function signedInOperator(
  t: TestClient,
  email = "ops@billboardos.test",
): Promise<TestClient> {
  const userId = await t.run(async (ctx) => {
    const id = await ctx.db.insert("users", { email });
    await ctx.db.insert("operators", { userId: id, email, grantedBy: "test" });
    return id;
  });
  return t.withIdentity({ subject: `${userId}|test-session`, email });
}

/** A signed-in account that is NOT an operator. */
export async function signedInUser(t: TestClient, email = "someone@billboardos.test"): Promise<TestClient> {
  const userId = await t.run(async (ctx) => ctx.db.insert("users", { email }));
  return t.withIdentity({ subject: `${userId}|test-session`, email });
}
