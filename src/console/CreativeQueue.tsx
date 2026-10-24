import { useState } from "react";
import { useMutation } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { api } from "../../convex/_generated/api";
import { errorMessage } from "../lib/format";

type Pending = FunctionReturnType<typeof api.creatives.pendingReview>;

export function CreativeQueue({ pending }: { pending: Pending | undefined }) {
  const review = useMutation(api.creatives.review);
  const [error, setError] = useState<string | null>(null);

  async function decide(campaignId: Pending[number]["campaignId"], decision: "approved" | "rejected") {
    setError(null);
    try {
      await review({
        campaignId,
        decision,
        reason: decision === "approved" ? "Meets display policy" : "Rejected by operator",
      });
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  return (
    <section aria-labelledby="creatives-heading">
      <h2 id="creatives-heading" className="text-lg font-semibold">
        Creatives awaiting approval
      </h2>
      {error && (
        <p role="alert" className="mt-2 text-sm text-danger">
          {error}
        </p>
      )}
      {pending === undefined ? (
        <div className="mt-4 h-24 animate-pulse rounded bg-panel" />
      ) : pending.length === 0 ? (
        <p className="mt-3 text-muted">No creatives waiting. Nothing plays on screen until you approve it.</p>
      ) : (
        <ul className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
          {pending.map((item) => (
            <li key={item.campaignId} className="overflow-hidden rounded-lg border border-line bg-panel">
              <div className="aspect-video bg-ink">
                {item.creativeUrl &&
                  (item.contentType?.startsWith("video/") ? (
                    <video src={item.creativeUrl} className="h-full w-full object-cover" muted loop autoPlay playsInline />
                  ) : (
                    <img src={item.creativeUrl} alt={`Creative from ${item.advertiserName}`} className="h-full w-full object-cover" />
                  ))}
              </div>
              <div className="flex items-center justify-between gap-3 p-3">
                <span className="truncate text-sm font-medium">{item.advertiserName}</span>
                <div className="flex shrink-0 gap-2">
                  <button
                    type="button"
                    onClick={() => decide(item.campaignId, "rejected")}
                    className="rounded-md border border-line px-3 py-1.5 text-sm text-muted hover:text-fg"
                  >
                    Reject
                  </button>
                  <button
                    type="button"
                    onClick={() => decide(item.campaignId, "approved")}
                    className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-ink active:scale-[0.98]"
                  >
                    Approve
                  </button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
