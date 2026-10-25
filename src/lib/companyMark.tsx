import { useState } from "react";
import { PROOF_LOGOS } from "../demo/ProofLogos";

type Brand = { color: string; ink?: string; logo?: string; domain?: string; initials?: string };

/** Known sponsor marks: local logo → favicon domain → monogram tile. */
const BRAND: Record<string, Brand> = {
  "Capital One": { color: "#d03027", ink: "#fff", domain: "capitalone.com", initials: "CO" },
  Anthropic: { color: "#d4a27f", ink: "#1a120b", domain: "anthropic.com", initials: "A" },
  Coinbase: { color: "#0052ff", ink: "#fff", domain: "coinbase.com", initials: "Cb" },
  Convex: { color: "#f3f4f6", ink: "#111", logo: "/images/logos/convex.svg", initials: "Cx" },
  Microsoft: { color: "#f3f4f6", ink: "#111", logo: "/images/logos/microsoft.svg", initials: "Ms" },
  NVIDIA: { color: "#76b900", ink: "#111", logo: "/images/logos/nvidia.svg", initials: "N" },
  Visa: { color: "#1a1f71", ink: "#fff", domain: "visa.com", initials: "V" },
  Meta: { color: "#0668e1", ink: "#fff", domain: "meta.com", initials: "M" },
  CREAO: { color: "#111827", ink: "#fff", domain: "creao.ai", initials: "Cr" },
  Apify: { color: "#8bf508", ink: "#111", domain: "apify.com", initials: "Ap" },
  "Fetch.ai": { color: "#1b1f3b", ink: "#fff", domain: "fetch.ai", initials: "Fe" },
  Cartesia: { color: "#0b1020", ink: "#fff", domain: "cartesia.ai", initials: "Ca" },
  "Bright Data": { color: "#0f62fe", ink: "#fff", domain: "brightdata.com", initials: "BD" },
  Supercell: { color: "#111", ink: "#fff", domain: "supercell.com", initials: "Sc" },
  Figma: { color: "#f24e1e", ink: "#fff", domain: "figma.com", initials: "Fi" },
  Okta: { color: "#f3f4f6", ink: "#111", logo: "/images/logos/okta.svg", initials: "Ok" },
  LaunchKit: { color: "#f3f4f6", ink: "#111", logo: "/images/logos/launchkit.svg", initials: "Lk" },
  Quarry: { color: "#f3f4f6", ink: "#111", logo: "/images/logos/quarry.svg", initials: "Q" },
  Pabbly: { color: "#f3f4f6", ink: "#111", logo: "/images/logos/pabbly.svg", initials: "Pb" },
  "Golden Gate Coffee": {
    color: "#f3f4f6",
    ink: "#111",
    logo: "/images/logos/golden-gate-coffee.svg",
    initials: "GG",
  },
};

function resolve(name: string): Brand {
  const known = BRAND[name];
  if (known?.logo) return known;
  const proof = PROOF_LOGOS.find((p) => p.name.toLowerCase() === name.toLowerCase());
  if (proof) return { color: "#f3f4f6", ink: "#111", logo: proof.src, initials: initialsOf(name) };
  if (known) return known;
  return { color: hueOf(name), ink: "#fff", initials: initialsOf(name) };
}

function faviconUrl(domain: string) {
  return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=128`;
}

function initialsOf(name: string) {
  const parts = name.replace(/[.&]/g, " ").split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

function hueOf(name: string) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return `hsl(${h % 360} 42% 38%)`;
}

/** Square brand tile for receipts and bid rows: logo image, favicon, or monogram. */
export function CompanyMark({ name, size = 44 }: { name: string; size?: number }) {
  const brand = resolve(name);
  const [remoteFailed, setRemoteFailed] = useState(false);
  const iconSize = Math.round(size * (brand.logo ? 0.62 : 0.55));
  const src = brand.logo ?? (brand.domain && !remoteFailed ? faviconUrl(brand.domain) : null);

  if (src) {
    const tile = brand.logo ? brand.color : "#fff";
    return (
      <span
        className="company-mark company-mark-logo"
        style={{ width: size, height: size, background: tile }}
        title={name}
      >
        <img
          src={src}
          alt=""
          width={iconSize}
          height={iconSize}
          draggable={false}
          onError={() => setRemoteFailed(true)}
        />
      </span>
    );
  }

  return (
    <span
      className="company-mark"
      style={{ width: size, height: size, background: brand.color, color: brand.ink ?? "#fff" }}
      aria-hidden
      title={name}
    >
      {brand.initials ?? initialsOf(name)}
    </span>
  );
}
