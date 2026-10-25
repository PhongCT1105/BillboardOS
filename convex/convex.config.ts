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
    /** Server-only CREAO API Trigger configuration. */
    CREAO_API_BASE_URL: v.optional(v.string()),
    CREAO_SALES_AGENT_ID: v.optional(v.string()),
    CREAO_SALES_API_KEY: v.optional(v.string()),
    CREAO_REVENUE_AGENT_ID: v.optional(v.string()),
    CREAO_REVENUE_API_KEY: v.optional(v.string()),
    /** New live-pipeline agents. Each capi_ key is scoped to its saved agent. */
    CREAO_COMPANY_RESEARCH_AGENT_ID: v.optional(v.string()),
    CREAO_COMPANY_RESEARCH_API_KEY: v.optional(v.string()),
    CREAO_SCREEN_AUDIENCE_AGENT_ID: v.optional(v.string()),
    CREAO_SCREEN_AUDIENCE_API_KEY: v.optional(v.string()),
    CREAO_CREATIVE_SAFETY_AGENT_ID: v.optional(v.string()),
    CREAO_CREATIVE_SAFETY_API_KEY: v.optional(v.string()),
    CREAO_OPPORTUNITY_STRATEGY_AGENT_ID: v.optional(v.string()),
    CREAO_OPPORTUNITY_STRATEGY_API_KEY: v.optional(v.string()),
    /** Server-only Model Studio credentials for the fast buyer negotiation turns. */
    BITDEER_API_KEY: v.optional(v.string()),
    BITDEER_MODEL: v.optional(v.string()),
  },
});

// Website hosting (ADR 0006: one OS server). The component stores the Vite
// build; http.ts registers its catch-all after the app's own routes so
// /api/agent, /a2a, /purchases, /internal and the auth routes keep their URLs.
app.use(staticHosting);

export default app;
