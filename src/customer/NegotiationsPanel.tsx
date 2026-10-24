import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import { NegotiationTimeline } from "../a2a/NegotiationTimeline";
import { Section } from "./ui";

/** Customer: their buying agents' conversations with host seller agents (ADR 0005). */
export function NegotiationsPanel() {
  const items = useQuery(api.negotiations.mine, {});
  const purchases = useQuery(api.a2a.dataPurchasesMine, {});
  return (
    <Section
      title="Negotiations"
      lead="What your buying agents said to hosts' seller agents, what they agreed, and what they paid over x402. Numbers are decided by policy on both sides; the text explains them."
    >
      <NegotiationTimeline
        items={items}
        sales={purchases}
        perspective="customer"
        empty="No agent negotiations yet. Run npm run a2a:demo with one of your agent keys, or let your own agent call a host's /negotiations endpoint."
      />
    </Section>
  );
}
