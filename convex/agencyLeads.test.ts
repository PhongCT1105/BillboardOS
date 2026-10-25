import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import { modules, registerBackendComponents, signedInOperator } from "./test.setup";

beforeEach(() => {
  vi.useFakeTimers();
  process.env.INTERNAL_API_SECRET = "test-internal-secret-0123456789";
});
afterEach(() => {
  vi.useRealTimers();
  delete process.env.INTERNAL_API_SECRET;
});

describe("agencyLeads", () => {
  test("drafts outreach, lists it, marks copied, and never invents a send", async () => {
    const t = convexTest(schema, modules);
    registerBackendComponents(t);
    const host = await signedInOperator(t, "host@venue.test");

    const drafted = await host.mutation(api.agencyLeads.draft, {
      companyName: "Northwind Labs",
      website: "https://northwind.example",
      notes: "B2B SaaS near Moscone",
    });
    expect(drafted.subject).toContain("Northwind Labs");
    expect(drafted.body).toMatch(/not sent from BillboardOS/i);

    const listed = await host.query(api.agencyLeads.list, {});
    expect(listed).toHaveLength(1);
    expect(listed[0].status).toBe("draft");
    expect(listed[0].website).toBe("https://northwind.example/");

    await host.mutation(api.agencyLeads.markCopied, { leadId: drafted.leadId });
    expect((await host.query(api.agencyLeads.list, {}))[0].status).toBe("copied");

    await host.mutation(api.agencyLeads.dismiss, { leadId: drafted.leadId });
    expect(await host.query(api.agencyLeads.list, {})).toHaveLength(0);

    const audits = await t.run(async (ctx) =>
      ctx.db
        .query("auditEvents")
        .withIndex("by_subject", (q) => q.eq("subjectId", drafted.leadId))
        .collect(),
    );
    expect(audits.map((a) => a.type).sort()).toEqual(["lead.copied", "lead.dismissed", "lead.drafted"]);
    expect(audits.find((a) => a.type === "lead.drafted")?.reason).toMatch(/not sent/i);
  });
});
