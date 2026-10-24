import { convexAuth } from "@convex-dev/auth/server";
import { ConvexError } from "convex/values";
import type { MutationCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { ensureFirstOperator } from "./lib/operator";
import { Password } from "@convex-dev/auth/providers/Password";

/**
 * Operator sign-in: email + password (no email server needed).
 * The first account ever created becomes an operator; later accounts need an
 * existing operator to grant access (operators.grant).
 */
export const { auth, signIn, signOut, store, isAuthenticated } = convexAuth({
  providers: [
    Password({
      profile(params) {
        const email = typeof params.email === "string" ? params.email.trim().toLowerCase() : "";
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
          throw new ConvexError("Enter a valid email address");
        }
        return { email };
      },
    }),
  ],
  callbacks: {
    async afterUserCreatedOrUpdated(ctx, { userId, existingUserId }) {
      if (existingUserId) return; // sign-in to an existing account
      // The callback ctx is typed for any data model; it is this app's mutation ctx.
      await ensureFirstOperator(ctx as unknown as MutationCtx, userId as Id<"users">);
    },
  },
});
