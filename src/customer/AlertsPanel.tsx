import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { api } from "../../convex/_generated/api";
import { ago, money, shortDate, timeOfDay } from "../lib/format";
import { hashHref, useNow } from "../lib/hooks";
import { Card, Empty, ErrorLine, Pill, Section, Skeleton, primaryBtn, secondaryBtn, useAction } from "./ui";

type Alert = FunctionReturnType<typeof api.alerts.inbox>["alerts"][number];

const TRIGGER_LABEL: Record<Alert["trigger"], string> = {
  available: "Available",
  price_drop: "Price drop",
  last_minute: "Last minute",
  auction_open: "Auction open",
  flash_offer: "Flash offer",
};

/** Max slots the booking page takes in one quote. */
const MAX_QUOTE_SLOTS = 4;

export function AlertsPanel() {
  const inbox = useQuery(api.alerts.inbox, { limit: 50 });
  const markRead = useMutation(api.alerts.markRead);
  const { busy, error, run } = useAction();
  return (
    <Section
      title="Alerts"
      lead="Live matches from your watch rules, newest first. Quote straight from an alert; slots can sell to someone else in the meantime."
      action={
        inbox && inbox.unreadCount > 0 ? (
          <button type="button" className={secondaryBtn} disabled={busy} onClick={() => run(() => markRead({}))}>
            Mark all read
          </button>
        ) : undefined
      }
    >
      <ErrorLine error={error} />
      {inbox === undefined ? (
        <Skeleton />
      ) : inbox.alerts.length === 0 ? (
        <Empty>No alerts yet. Create a watch rule and matching slots appear here within minutes.</Empty>
      ) : (
        <div className="flex flex-col gap-3">
          {inbox.alerts.map((a) => (
            <AlertRow key={a.alertId} alert={a} />
          ))}
        </div>
      )}
    </Section>
  );
}

function AlertRow({ alert }: { alert: Alert }) {
  const markRead = useMutation(api.alerts.markRead);
  const now = useNow(30_000);
  const bid = alert.trigger === "auction_open";
  const href = hashHref("/book", {
    billboard: alert.billboardId,
    campaign: alert.campaignId,
    slots: alert.slots
      .slice(0, bid ? 1 : MAX_QUOTE_SLOTS)
      .map((s) => s.slotId)
      .join(","),
  });
  return (
    <Card className={`flex flex-col gap-3 ${alert.read ? "" : "border-accent/50"}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            {!alert.read && <span className="size-2 rounded-full bg-accent" aria-label="Unread" />}
            <Pill tone={alert.trigger === "available" ? "muted" : "accent"}>{TRIGGER_LABEL[alert.trigger]}</Pill>
            <span className="font-medium">{alert.billboardName}</span>
            <span className="text-sm text-faint">{alert.city}</span>
          </div>
          <p className="mt-2 text-sm text-fg">{alert.reason}</p>
          <p className="mt-1 text-xs text-faint">
            {alert.ruleName} · {ago(alert.createdAt, now)}
          </p>
        </div>
        <div className="text-right">
          <p className="text-xs text-muted">{bid ? "Current bid" : "From"}</p>
          <p className="tabular font-mono text-xl">{money(alert.priceMinor)}</p>
        </div>
      </div>
      <ul className="flex flex-wrap gap-2 text-sm">
        {alert.slots.map((s) => (
          <li key={s.slotId} className="rounded-md border border-line bg-ink px-2.5 py-1">
            <span className="tabular font-mono">
              {shortDate(s.startAt)} {timeOfDay(s.startAt)}
            </span>{" "}
            <span className="tabular font-mono text-muted">{money(s.screenPriceMinor)}</span>
          </li>
        ))}
        {alert.matchCount > alert.slots.length && (
          <li className="px-1 py-1 text-xs text-faint">+{alert.matchCount - alert.slots.length} more matching</li>
        )}
      </ul>
      <div className="flex flex-wrap items-center gap-2">
        <a href={href} onClick={() => void markRead({ alertId: alert.alertId })} className={primaryBtn}>
          {bid ? "Bid on this" : "Quote this"}
        </a>
        {!alert.read && (
          <button type="button" className={secondaryBtn} onClick={() => void markRead({ alertId: alert.alertId })}>
            Mark read
          </button>
        )}
        {alert.agent && (
          <span className="text-xs text-muted">
            Agent webhook:{" "}
            <span className={alert.agent.status === "failed" ? "text-danger" : alert.agent.status === "delivered" ? "text-emerald-300" : "text-fg"}>
              {alert.agent.status}
            </span>
            {alert.agent.attempts > 0 && ` after ${alert.agent.attempts} attempt${alert.agent.attempts === 1 ? "" : "s"}`}
            {alert.agent.lastError && alert.agent.status !== "delivered" && ` (${alert.agent.lastError})`}
          </span>
        )}
      </div>
    </Card>
  );
}
