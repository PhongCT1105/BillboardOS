import { defineApp } from "convex/server";
import { v } from "convex/values";
import staticHosting from "@convex-dev/static-hosting/convex.config";

const app = defineApp({
  env: {
    /**
     * Shared secret for /internal/* HTTP routes (`Authorization: Bearer <secret>`).
     * Optional so the app deploys without it; those routes fail closed (503)
     * until it is set: `npx convex env set INTERNAL_API_SECRET <value>`.
     */
    INTERNAL_API_SECRET: v.optional(v.string()),
  },
});

// Website hosting (ADR 0006: one OS server). The component stores the Vite
// build; http.ts registers its catch-all after the app's own routes so
// /api/agent, /a2a, /purchases, /internal and the auth routes keep their URLs.
app.use(staticHosting);

export default app;
