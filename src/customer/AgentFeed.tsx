import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import { money } from "../lib/format";
import { Card, Skeleton } from "./ui";

const ROUND_STYLE: Record<"invited" | "bid" | "passed" | "won" | "lost" | "defaulted", string> = {
  invited: "border-line",
  bid: "border-blue-400",
  passed: "border-line",
  won: "border-emerald-400 bg-emerald-400/10",
  lost: "border-amber-400",
  defaulted: "border-danger bg-danger/10",
};

const RESULT: Record<"invited" | "bid" | "passed" | "won" | "lost" | "defaulted", string> = {
  invited: "negotiating",
  bid: "closing",
  passed: "passed",
  won: "deal",
  lost: "another company closed first",
  defaulted: "didn't pay",
};

/** 14:02:05.6, local time, to a tenth of a second. */
function clock(ms: number): string {
  const d = new Date(ms);
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${Math.floor(d.getMilliseconds() / 100)}`;
}

/** What the company's agent is doing: each live sale it was offered (its price, its answer, the result), newest first. */
export function AgentFeed() {
  const agent = useQuery(api.companyAgents.mine, {});
  const rounds = useQuery(api.rounds.myRounds, { limit: 10 });
  const budget = agent?.standing?.dailyBudgetMinor ?? 0;
  const spent = agent?.spentTodayMinor ?? 0;
  const pct = budget > 0 ? Math.min(100, Math.round((spent / budget) * 100)) : 0;

  return (
    <Card className="flex flex-col gap-4">
      <div>
        <div className="flex items-center justify-between gap-3 text-sm">
          <strong className="flex items-center gap-2">
            <span className={`h-2 w-2 rounded-full ${agent?.enabled ? "bg-emerald-400" : "bg-faint"}`} />
            Agent: {agent?.enabled ? "ON" : "OFF"}
          </strong>
          <span className="text-muted">
            Today spent <span className="tabular font-mono text-fg">{money(spent)}</span>
            {budget > 0 && <> / {money(budget)}</>}
          </span>
        </div>
        <div
          className="mt-2 h-2 overflow-hidden rounded bg-line"
          role="progressbar"
          aria-label="Spent today"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={pct}
        >
          <div className="h-full bg-accent transition-[width]" style={{ width: `${pct}%` }} />
        </div>
        {agent?.lastAction && <p className="mt-2 text-xs text-muted">Last: {agent.lastAction}</p>}
      </div>

      {rounds === undefined ? (
        <Skeleton h="h-48" />
      ) : rounds.length === 0 ? (
        <p className="rounded-lg border border-dashed border-line px-4 py-8 text-center text-sm text-muted">
          Nothing yet. When a screen whose crowd matches your buyers has a spot on air, its offer and your agent's answer show up here.
        </p>
      ) : (
        <ol className="flex flex-col gap-2 text-sm" aria-label="Live sales">
          {rounds.map((r) => (
            <li key={r.roundId} className={`border-l-[3px] py-1 pr-2 pl-3 ${ROUND_STYLE[r.bidStatus]}`}>
              <div className="flex justify-between gap-3">
                <span className="text-fg">
                  {r.screen}
                  {r.offerMinor !== null && <> · offered to you at {money(r.offerMinor)}</>}
                  {r.amountMinor !== null && r.bidStatus !== "passed" && <> · you said {money(r.amountMinor)}</>}
                  {" "}· <span className="text-muted">{RESULT[r.bidStatus]}</span>
                </span>
                <span className="tabular font-mono text-[11px] text-faint">{clock(r.createdAt)}</span>
              </div>
              {r.reasoning && <div className="text-xs text-muted">{r.reasoning}</div>}
              {r.outcome && <div className="text-xs text-faint">{r.outcome}</div>}
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}
