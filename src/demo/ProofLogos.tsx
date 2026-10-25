export const PROOF_LOGOS = [
  { name: "NVIDIA", src: "/images/logos/nvidia.svg", width: 112 },
  { name: "Convex", src: "/images/logos/convex.svg", width: 104 },
  { name: "Microsoft", src: "/images/logos/microsoft.svg", width: 118 },
  { name: "Okta", src: "/images/logos/okta.svg", width: 74 },
  { name: "LaunchKit", src: "/images/logos/launchkit.svg", width: 116 },
  { name: "Quarry", src: "/images/logos/quarry.svg", width: 92 },
  { name: "Pabbly", src: "/images/logos/pabbly.svg", width: 92 },
  { name: "Golden Gate Coffee", src: "/images/logos/golden-gate-coffee.svg", width: 148 },
] as const;

export function ProofLogo({
  name,
  src,
  width,
}: {
  name: string;
  src: string;
  width: number;
}) {
  return (
    <img
      className="demo-proof-mark"
      src={src}
      alt={name}
      width={width}
      height={28}
      loading="lazy"
      decoding="async"
      draggable={false}
    />
  );
}
