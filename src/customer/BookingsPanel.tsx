import { useQuery } from "convex/react";
import { money, shortDate, timeOfDay, words } from "../lib/format";
import { api } from "../../convex/_generated/api";
import { Empty, Pill, Section, Skeleton } from "./ui";

export function BookingsPanel() {
  const bookings = useQuery(api.customerPortal.bookings, {});
  const invoices = useQuery(api.customerPortal.invoices, {});
  return (
    <div className="flex flex-col gap-10">
      <Section title="My bookings" lead="Booked airtime across your campaigns, newest first.">
        {bookings === undefined ? (
          <Skeleton />
        ) : bookings.length === 0 ? (
          <Empty>No bookings yet. Quote and hold slots on the Book page, then pay to confirm.</Empty>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-line">
            <table className="w-full min-w-[720px] text-left text-sm">
              <thead className="bg-panel text-xs text-muted">
                <tr>
                  <th className="px-4 py-2.5 font-medium">Screen</th>
                  <th className="px-4 py-2.5 font-medium">Airs</th>
                  <th className="px-4 py-2.5 font-medium">Campaign</th>
                  <th className="px-4 py-2.5 text-right font-medium">Amount</th>
                  <th className="px-4 py-2.5 font-medium">Paid by</th>
                  <th className="px-4 py-2.5 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {bookings.map((b) => (
                  <tr key={b.bookingId} className="border-t border-line">
                    <td className="px-4 py-2.5">{b.billboardName}</td>
                    <td className="tabular px-4 py-2.5 font-mono text-muted">
                      {b.firstStartAt ? `${shortDate(b.firstStartAt)} ${timeOfDay(b.firstStartAt)}` : "-"}
                      {b.lastEndAt ? ` to ${timeOfDay(b.lastEndAt)}` : ""}
                      <span className="text-faint"> · {b.slotCount} slot{b.slotCount === 1 ? "" : "s"}</span>
                    </td>
                    <td className="max-w-[240px] truncate px-4 py-2.5 text-muted">{b.campaignBrief}</td>
                    <td className="tabular px-4 py-2.5 text-right font-mono">{money(b.amountMinor)}</td>
                    <td className="px-4 py-2.5 text-muted">
                      {b.paidBy === "invoice" ? `Invoice ${b.invoiceNumber ?? ""}` : b.paidBy === "payment" ? "Paid up front" : "-"}
                    </td>
                    <td className="px-4 py-2.5">
                      <Pill tone={b.status === "failed" ? "danger" : b.status === "played" ? "ok" : "muted"}>{words(b.status)}</Pill>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <Section title="Invoices" lead="Bookings on payment terms are invoiced to your company.">
        {invoices === undefined ? (
          <Skeleton />
        ) : invoices.length === 0 ? (
          <Empty>No invoices. Prepaid bookings don't create one.</Empty>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-line">
            <table className="w-full min-w-[640px] text-left text-sm">
              <thead className="bg-panel text-xs text-muted">
                <tr>
                  <th className="px-4 py-2.5 font-medium">Invoice</th>
                  <th className="px-4 py-2.5 font-medium">Description</th>
                  <th className="px-4 py-2.5 font-medium">Due</th>
                  <th className="px-4 py-2.5 text-right font-medium">Amount</th>
                  <th className="px-4 py-2.5 text-right font-medium">Balance</th>
                  <th className="px-4 py-2.5 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {invoices.map((i) => (
                  <tr key={i.invoiceId} className="border-t border-line">
                    <td className="px-4 py-2.5 font-mono">
                      {i.number}
                      {i.source === "fixture" && <span className="ml-2 text-xs text-faint">simulated</span>}
                    </td>
                    <td className="max-w-[260px] truncate px-4 py-2.5 text-muted">{i.description}</td>
                    <td className="tabular px-4 py-2.5 font-mono text-muted">{shortDate(i.dueAt)}</td>
                    <td className="tabular px-4 py-2.5 text-right font-mono">{money(i.amountMinor)}</td>
                    <td className="tabular px-4 py-2.5 text-right font-mono">{money(i.balanceMinor)}</td>
                    <td className="px-4 py-2.5">
                      <Pill tone={i.status === "paid" ? "ok" : i.status === "disputed" ? "danger" : "muted"}>{words(i.status)}</Pill>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>
    </div>
  );
}
