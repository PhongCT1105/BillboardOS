/**
 * The seller agent's public card (ADR 0005): who the host is, its screens,
 * services and prices, how to pay. Pure: the HTTP route supplies the data.
 */
import { centsToUsd } from "./money";

export type AgentCardData = {
  workspaceId: string;
  name: string;
  city: string;
  payoutAddress: string | null;
  negotiation: { maxRounds: number; offerValiditySeconds: number };
  screens: unknown[];
};

export function buildAgentCard(
  card: AgentCardData,
  opts: { baseUrl: string; network: string; defaultPayTo: string | null; reportPriceMinor: number },
) {
  const base = `${opts.baseUrl.replace(/\/$/, "")}/a2a/hosts/${card.workspaceId}`;
  return {
    schema: "billboardos.agent-card/v1",
    name: `${card.name} seller agent`,
    description: `Sells screen time and audience data for ${card.name} (${card.city}) on BillboardOS. Negotiates with buyer agents; every payment is x402.`,
    host: { workspaceId: card.workspaceId, name: card.name, city: card.city },
    payment: {
      protocol: "x402",
      scheme: "exact",
      network: opts.network,
      asset: "USDC",
      // The 402 challenge is authoritative; null means "the platform's default receiver".
      payTo: card.payoutAddress ?? opts.defaultPayTo,
    },
    auth: { type: "bearer", description: "BillboardOS agent key (bos_agent_...) for everything except this card" },
    negotiation: {
      maxRounds: card.negotiation.maxRounds,
      offerValiditySeconds: card.negotiation.offerValiditySeconds,
      messages: ["offer {amountMinor, reasoning}", "accept", "reject {reasoning}"],
      notes: "Slots are not held while negotiating; an accepted deal creates a 5-minute hold to pay over x402. Hot slots (live auction) are not negotiable.",
    },
    services: [
      { id: "agent-card", method: "GET", url: `${base}/agent.json`, price: "free" },
      { id: "audience-report", method: "GET", url: `${base}/reports/audience?billboardId={billboardId}`, price: centsToUsd(opts.reportPriceMinor), paid: "x402", scope: "any agent key" },
      {
        id: "negotiate",
        method: "POST",
        url: `${base}/negotiations`,
        price: "free",
        scope: "quote + hold",
        body: { campaignId: "string", slotIds: ["string"], amountMinor: "optional opening offer (US cents)", reasoning: "optional" },
      },
      {
        id: "negotiation-message",
        method: "POST",
        url: `${base}/negotiations/{negotiationId}/messages`,
        price: "free",
        body: { kind: "offer | accept | reject", amountMinor: "for offers", reasoning: "optional" },
      },
      { id: "purchase", method: "POST", url: `${base}/purchases/{holdId}`, price: "hold amount", paid: "x402", scope: "pay" },
    ],
    screens: card.screens,
  };
}
