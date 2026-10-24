import { defineApp } from "convex/server";
import { v } from "convex/values";

const app = defineApp({
  env: {
    /**
     * Shared secret the Express x402 server presents as
     * `Authorization: Bearer <secret>` on /internal/* HTTP routes.
     * Optional so the app deploys without it; the routes fail closed (503)
     * until it is set: `npx convex env set INTERNAL_API_SECRET <value>`.
     */
    INTERNAL_API_SECRET: v.optional(v.string()),
  },
});

export default app;
