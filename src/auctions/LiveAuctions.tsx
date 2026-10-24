import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { AuctionCard } from "./AuctionCard";

/** Console panel: live auctions and those that ended in the last 15 minutes. */
export function LiveAuctions({ billboardId }: { billboardId?: Id<"billboards"> }) {
  const auctions = useQuery(api.auctions.live, { billboardId });
  return (
    <section aria-labelledby="auctions-heading">
      <h2 id="auctions-heading" className="text-lg font-semibold">
        Live auctions
      </h2>
      <p className="mt-1 text-sm text-muted">
        Hot slots stop selling at the posted price. Buyers bid; the highest bid at close gets a hold at that price.
      </p>
      {auctions === undefined ? (
        <div className="mt-4 h-32 animate-pulse rounded bg-panel" />
      ) : auctions.length === 0 ? (
        <p className="mt-4 text-muted">
          No auctions right now. Open one from a slot below, or let the seller agent open one when two buyers want the same slot.
        </p>
      ) : (
        <div className="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-2">
          {auctions.map((a) => (
            <AuctionCard key={a.auctionId} auction={a} />
          ))}
        </div>
      )}
    </section>
  );
}
