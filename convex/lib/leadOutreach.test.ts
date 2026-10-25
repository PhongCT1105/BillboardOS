import { describe, expect, test } from "vitest";
import { draftAgencyOutreach, normalizeLeadInput } from "./leadOutreach";

describe("leadOutreach", () => {
  test("drafts a quiet agency intro and never claims it was sent", () => {
    const draft = draftAgencyOutreach({
      companyName: "Acme Robotics",
      website: "acme.example",
      notes: "hiring engineers in SF",
      agencyName: "Moscone Media",
    });
    expect(draft).not.toHaveProperty("error");
    if ("error" in draft) return;
    expect(draft.subject).toContain("Acme Robotics");
    expect(draft.subject).toContain("Moscone Media");
    expect(draft.body).toContain("https://acme.example/");
    expect(draft.body).toContain("hiring engineers in SF");
    expect(draft.body.toLowerCase()).toContain("draft only");
    expect(draft.body.toLowerCase()).not.toMatch(/\bsent\b(?!.*billboardos)/i);
    expect(draft.body).toMatch(/not sent from BillboardOS/i);
  });

  test("rejects empty names", () => {
    expect(normalizeLeadInput({ companyName: " " })).toEqual({ error: "Company name is too short" });
  });
});
