/**
 * Agency outreach drafts for companies outside the seeded Cal Hacks network.
 * Pure helpers: no send, no SMTP — operators copy into their own mail client.
 */

export type OutreachInput = {
  companyName: string;
  website?: string;
  notes?: string;
  /** Host / agency display name used in the sign-off. */
  agencyName?: string;
};

export type OutreachDraft = {
  subject: string;
  body: string;
};

const MAX_NAME = 120;
const MAX_URL = 500;
const MAX_NOTES = 1000;

export function normalizeLeadInput(raw: OutreachInput): OutreachInput | { error: string } {
  const companyName = raw.companyName.trim().replace(/\s+/g, " ");
  if (companyName.length < 2) return { error: "Company name is too short" };
  if (companyName.length > MAX_NAME) return { error: "Company name is too long" };

  let website = raw.website?.trim();
  if (website) {
    if (website.length > MAX_URL) return { error: "Website URL is too long" };
    if (!/^[a-z][a-z0-9+.-]*:/i.test(website)) website = `https://${website}`;
    try {
      const u = new URL(website);
      if (u.protocol !== "http:" && u.protocol !== "https:") return { error: "Website must be http(s)" };
      website = u.toString();
    } catch {
      return { error: "Website is not a valid URL" };
    }
  } else {
    website = undefined;
  }

  let notes = raw.notes?.trim();
  if (notes && notes.length > MAX_NOTES) return { error: "Notes are too long" };
  if (!notes) notes = undefined;

  return {
    companyName,
    website,
    notes,
    agencyName: raw.agencyName?.trim() || "BillboardOS Agency",
  };
}

/** Deterministic draft so operators can edit before sending from their own inbox. */
export function draftAgencyOutreach(input: OutreachInput): OutreachDraft | { error: string } {
  const n = normalizeLeadInput(input);
  if ("error" in n) return n;
  const agency = n.agencyName ?? "BillboardOS Agency";
  const siteLine = n.website ? `I was looking at ${n.website} and ` : "";
  const noteLine = n.notes ? `\n\nWhat stood out to us: ${n.notes}` : "";
  const subject = `${n.companyName} × street screens — quiet intro from ${agency}`;
  const body = `Hi ${n.companyName} team,

${siteLine}we run a small agency desk on BillboardOS that places brand creatives on live street screens in San Francisco (Cal Hacks venue corridor and nearby foot traffic).

We are not asking you to buy anything today. This is a draft intro so you can see whether a short, measured presence on those screens would be useful for ${n.companyName} — typically a brand poster or short loop, priced per window, paid only when the spot is won.${noteLine}

If it is interesting, reply with the right person on your side and we will send a one-page sketch (screen, audience mix, sample creative). If not, no follow-up from us.

Thanks,
${agency}
— draft only; not sent from BillboardOS`;
  return { subject, body };
}
