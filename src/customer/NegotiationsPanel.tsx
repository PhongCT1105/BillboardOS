import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import { NegotiationTimeline, txUrl } from "../a2a/NegotiationTimeline";
import { money } from "../lib/format";
import { useNow } from "../lib/hooks";
import { ago } from "../lib/format";
import { Card, Pill, Section } from "./ui";

/** Customer: their buying agents' conversations with host seller agents (ADR 0005). */
export function NegotiationsPanel() {
  const items = useQuery(api.negotiations.mine, {});
  const purchases = useQuery(api.a2a.dataPurchasesMine, {});
  return (
    <div className="flex flex-col gap-10">
      <FlashBuys />
      <NegotiationsSection items={items} purchases={purchases} />
    </div>
  );
}

/** Live-moment flash offers your agents answered (ADR 0006). */
function FlashBuys() {
  const buys = useQuery(api.moments.myBuys, {});
  const now = useNow(30_000);
  if (!buys || buys.length === 0) return null;
  return (
    <Section title="Live moments" lead="Flash offers hosts' seller agents sent your agents when a matching crowd formed.">
      <div className="flex flex-col gap-3">
        {buys.map((b) => {
          const won = b.status === "won";
          const paid = won && (b.momentStatus === "paid" || b.momentStatus === "playing");
          const url = b.paymentTx ? txUrl(b.paymentNetwork, b.paymentTx) : null;
          return (
            <Card key={b.offerId} className="flex flex-wrap items-center justify-between gap-3 p-4">
              <div className="min-w-0">
                <p className="font-medium">
                  {won
                    ? `Your agent ${paid ? "bought" : "won"} ${b.minutes} minutes at ${b.billboardName} for ${b.amountMinor !== null ? money(b.amountMinor) : "-"} (${b.relevantViewers} relevant viewers)`
                    : `Offer for ${b.minutes} minutes at ${b.billboardName}: ${b.status}`}
                </p>
                <p className="text-xs text-faint">
                  {ago(b.at, now)}
                  {url && (
                    <>
                      {" · "}
                      <a href={url} target="_blank" rel="noreferrer" className="text-accent underline-offset-4 hover:underline">
                        settlement tx
                      </a>
                    </>
                  )}
                </p>
              </div>
              {paid ? (
                <Pill tone="ok">paid over x402</Pill>
              ) : (
                <Pill tone={won ? "accent" : "muted"}>{b.status}</Pill>
              )}
            </Card>
          );
        })}
      </div>
    </Section>
  );
}

function NegotiationsSection({
  items,
  purchases,
}: {
  items: ReturnType<typeof useQuery<typeof api.negotiations.mine>>;
  purchases: ReturnType<typeof useQuery<typeof api.a2a.dataPurchasesMine>>;
}) {
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
