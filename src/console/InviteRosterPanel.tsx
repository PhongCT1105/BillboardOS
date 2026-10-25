import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { ago } from "../lib/format";
import { useNow } from "../lib/hooks";

/** Active top-10 vibe invites, cool-downs, and last CREAO harness pulse for one screen. */
export function InviteRosterPanel({ billboardId }: { billboardId: Id<"billboards"> }) {
  const roster = useQuery(api.inviteStatus.forBillboard, { billboardId });
  const pulse = useQuery(api.inviteStatus.harnessPulse, {});
  const now = useNow(15_000);
  if (roster === undefined) return null;

  return (
    <section aria-labelledby="invite-roster-heading" className="flex flex-col gap-3">
      <div>
        <h2 id="invite-roster-heading" className="text-base font-semibold">
          Invite roster
        </h2>
        <p className="text-sm text-muted">
          Network pool {roster.networkSize}; this screen invites the top {roster.inviteLimit} vibe matches.
          Chronic price rejects cool out so the next-best company can enter.
        </p>
      </div>
      <ul className="divide-y divide-line text-sm">
        {roster.active.map((a) => (
          <li key={a.advertiserId} className="flex justify-between gap-3 py-2">
            <span>{a.name}</span>
            <span className="text-muted">
              {a.match === null ? "match n/a" : `${Math.round(a.match * 100)}%`}
              {a.prefWeight !== 0 ? ` · pref ${a.prefWeight}` : ""}
            </span>
          </li>
        ))}
        {roster.active.length === 0 && <li className="py-2 text-muted">No eligible companies right now.</li>}
      </ul>
      {roster.cooled.length > 0 && (
        <div>
          <h3 className="text-sm font-medium">Cooled down</h3>
          <ul className="mt-1 text-sm text-muted">
            {roster.cooled.map((c) => {
              const leftSec = Math.max(0, Math.round((c.cooledUntilAt - now) / 1000));
              return (
                <li key={c.advertiserId}>
                  {c.name} · {c.rejectStreak} rejects · back in {leftSec < 60 ? `${leftSec}s` : `${Math.round(leftSec / 60)}m`}
                </li>
              );
            })}
          </ul>
        </div>
      )}
      <div className="text-xs text-muted">
        {roster.lastInviteHarness
          ? `Invite harness: ${roster.lastInviteHarness.status} — ${roster.lastInviteHarness.summary} (${ago(roster.lastInviteHarness.at, now)})`
          : pulse?.lastInvite
            ? `Invite harness: ${pulse.lastInvite.status} — ${pulse.lastInvite.summary}`
            : "Invite harness has not run yet."}
        <br />
        {roster.lastPriceHarness
          ? `Price harness: ${roster.lastPriceHarness.status} — ${roster.lastPriceHarness.summary} (${ago(roster.lastPriceHarness.at, now)})`
          : pulse?.lastPrice
            ? `Price harness: ${pulse.lastPrice.status} — ${pulse.lastPrice.summary}`
            : "Price harness has not run yet."}
      </div>
    </section>
  );
}
