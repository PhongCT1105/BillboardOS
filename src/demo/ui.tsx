import { ArrowUpRight, Monitor } from "@phosphor-icons/react";
import type { ReactNode } from "react";
import "./demo.css";

export function Brand() {
  return (
    <a href="#/" className="demo-brand" aria-label="BillboardOS home">
      <span className="demo-brand-mark">
        <Monitor size={19} weight="bold" />
      </span>
      Billboard<span className="text-muted">OS</span>
    </a>
  );
}

export function PrimaryLink({
  href,
  children,
}: {
  href: string;
  children: ReactNode;
}) {
  return (
    <a className="demo-button demo-button-primary" href={href}>
      {children}
      <ArrowUpRight size={17} />
    </a>
  );
}

export function Metrics({
  items,
  compact = false,
}: {
  items: { label: string; value: string; detail: string }[];
  compact?: boolean;
}) {
  return (
    <section className="demo-metrics" aria-label="Key statistics">
      {items.map((item) => (
        <div key={item.label}>
          <span className="demo-metric-label">{item.label}</span>
          <strong>{item.value}</strong>
          {!compact && <span className="demo-metric-detail">{item.detail}</span>}
        </div>
      ))}
    </section>
  );
}

export function DashboardSkeleton() {
  return (
    <div className="demo-loading" role="status" aria-label="Loading dashboard">
      <div />
      <div />
      <div />
      <span className="sr-only">Loading dashboard</span>
    </div>
  );
}
