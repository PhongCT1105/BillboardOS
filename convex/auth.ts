import { convexAuth } from "@convex-dev/auth/server";
import { ConvexError } from "convex/values";
import { Password } from "@convex-dev/auth/providers/Password";

/**
 * Email + password sign-in (no email server needed). After sign-up the user
 * picks a side (accounts.setAccountType): hosts create or join a workspace,
 * customers create their company. No account gets special rights by default.
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
});
