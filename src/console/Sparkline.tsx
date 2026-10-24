/** Minimal trend line for audience counts; no axes, the number beside it carries the value. */
export function Sparkline({ values }: { values: number[] }) {
  const w = 120;
  const h = 24;
  const max = Math.max(1, ...values);
  const step = values.length > 1 ? w / (values.length - 1) : w;
  const points = values.map((v, i) => `${(i * step).toFixed(1)},${(h - (v / max) * (h - 2) - 1).toFixed(1)}`).join(" ");
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} role="img" aria-label="Audience trend">
      <polyline points={points} fill="none" stroke="var(--color-accent)" strokeWidth={1.5} strokeLinejoin="round" />
    </svg>
  );
}
