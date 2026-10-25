import { useState } from "react";
import { Bell, Plus, UserCircle } from "@phosphor-icons/react";
import { HostNavigation } from "../App";
import { DashboardLayout } from "../console/ConsolePage";
import { ConnectedDisplays, DisplayCreative, type ConnectedDisplay } from "../console/ConnectedDisplays";
import { HostMetrics, PlaybackSummary } from "../demo/HostOverview";
import { LiveSalesPanel, type LiveSalesData } from "../demo/LiveSales";
import { Brand } from "../demo/ui";
import type { Id } from "../../convex/_generated/dataModel";
import assets from "./stitch-assets.json";

const firstDisplays: ConnectedDisplay[] = [
  { id: "sample-times", name: "Times Square North LED - 01", city: "New York", online: true, resolution: "3840×2160 UHD", floorMinor: 4200 },
  { id: "sample-sunset", name: "Sunset Boulevard Digital Pillar - 04", city: "Los Angeles", online: true, resolution: "1920×1080 FHD", floorMinor: 3450 },
  { id: "sample-soho", name: "SoHo Broadway Flagship Display", city: "New York", online: true, resolution: "2560×1440 QHD", floorMinor: 5200 },
  { id: "sample-ohare", name: "O'Hare Terminal 3 Concourse", city: "Chicago", online: false, resolution: "1920×1080 FHD" },
];
const sampleDisplays = [...firstDisplays, ...Array.from({ length: 144 }, (_, i) => ({
  id: `sample-network-${i}`, name: `Network Display ${String(i + 5).padStart(3, "0")}`, city: "New York", online: i < 139,
}))];
const creatives = [
  { title: "Nike Air Max 2025 Campaign", imageUrl: assets.nike, note: "15-second rotational campaign" },
  { title: "Tesla Cybercab Launch", imageUrl: assets.tesla, note: "Evening campaign · Los Angeles" },
  { title: "Acne Studios Fall Collection", imageUrl: assets.fashion, note: "Editorial fashion campaign" },
];
const transactions = [
  { winner: "Spotify USA", name: "Times Square · 15s Prime Drive-Time", price: 42000, minutes: 2 },
  { winner: "Uber Technologies", name: "SoHo Broadway · 30s Evening Loop", price: 28000, minutes: 7 },
  { winner: "Arc'teryx Outdoor", name: "Denver Arch · 10s Rotational", price: 19500, minutes: 14 },
  { winner: "Stripe Tour 2025", name: "Sunset Boulevard · 60s Takeover", price: 85000, minutes: 22 },
  { winner: "Rimowa Luggage", name: "O'Hare Concourse · 15s Standard", price: 31000, minutes: 35 },
];

// Development-only fixture. All data is illustrative; no backend writes.
export default function DesignPreview() {
  const [adding, setAdding] = useState(false);
  const [autoSell, setAutoSell] = useState(true);
  const [note, setNote] = useState<string | null>(null);
  const [displays, setDisplays] = useState<ConnectedDisplay[]>(sampleDisplays);
  const [startedAt] = useState(Date.now);
  const [notifications, setNotifications] = useState(false);
  const live: LiveSalesData = {
    autoSell,
    screens: transactions.map((t, i) => ({
      billboardId: `sample-sale-${i}` as Id<"billboards">, name: t.name, online: true,
      round: { status: "paid", outcome: null, askingMinor: t.price, bids: [], winner: t.winner, priceMinor: t.price, spotStartAt: startedAt - t.minutes * 60000 },
    })),
  };
  return (
    <div className="app-shell host-shell min-h-[100dvh]">
      <header className="app-header">
        <div className="app-header-inner">
          <Brand /><HostNavigation route="/console" />
          <div className="app-account ml-auto flex items-center gap-3">
            <button className="demo-button demo-button-primary header-add" onClick={() => setAdding(!adding)}><Plus size={17} />Add Display</button>
            <button className="header-icon" aria-label="Sample notifications" aria-expanded={notifications} onClick={() => setNotifications(!notifications)}><Bell size={20} /></button>
            <details className="account-menu"><summary aria-label="Sample account"><UserCircle size={30} weight="duotone" /></summary><div className="account-popover"><strong>Sample workspace</strong><span className="sample-data-label">Design preview · No live transactions</span></div></details>
          </div>
        </div>
      </header>
      <DashboardLayout adding={adding} onToggleAdd={() => setAdding(!adding)}>
        {notifications && <p className="mb-6 rounded-xl border border-line bg-panel p-4 text-sm">6 sample displays are offline. Use the Attention filter to review them.</p>}
        {adding && <form className="mb-8 grid gap-4 rounded-xl border border-line bg-panel p-6" onSubmit={(event) => {
          event.preventDefault();
          const data = new FormData(event.currentTarget);
          setDisplays([...displays, { id: `sample-${displays.length}`, name: String(data.get("name")), city: String(data.get("city")), online: false }]);
          setAdding(false);
        }}>
          <h2 className="text-lg font-semibold">Add sample display</h2>
          <label className="grid gap-2 text-sm">Name<input name="name" required className="rounded-lg border border-line p-3" /></label>
          <label className="grid gap-2 text-sm">City<input name="city" required className="rounded-lg border border-line p-3" /></label>
          <button className="demo-button demo-button-primary justify-self-start">Add sample</button>
        </form>}
        <div className="demo-overview">
          <HostMetrics online={displays.filter(d => d.online).length} total={displays.length} revenue={8425000} booked={1894} completed={14210} slotTotal={2152} />
          <div className="host-content-grid">
            <ConnectedDisplays displays={displays} autoSell={autoSell} sample renderPreview={display => {
              const creative = creatives[firstDisplays.findIndex(d => d.id === display.id)];
              return <DisplayCreative display={display} title={creative?.title ?? "No scheduled creative"} imageUrl={creative?.imageUrl} note={creative?.note} sample />;
            }} />
            <aside className="host-side-rail"><LiveSalesPanel live={live} onToggle={setAutoSell} onSell={() => setNote("Sample preview: no sale was started.")} note={note} sample /><PlaybackSummary completed={14210} sample /></aside>
          </div>
        </div>
        <details className="demo-tools"><summary>Operational tools</summary><div className="rounded-xl border border-line bg-panel p-6"><h2 className="text-lg font-semibold">CREAO agent rehearsal</h2><p className="text-sm text-muted">Agent runs are available in your workspace.</p></div></details>
      </DashboardLayout>
      <footer className="host-footer"><span>BillboardOS</span><span>Design preview · Sample data</span></footer>
    </div>
  );
}
