import { useQuery } from "convex/react";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { useHashRoute } from "./lib/hooks";
import { ConsolePage } from "./console/ConsolePage";
import { PlayerPage } from "./player/PlayerPage";
import { BookPage } from "./book/BookPage";
import { FinancePage } from "./finance/FinancePage";
import { SensorPage } from "./sensor/SensorPage";

export function App() {
  const route = useHashRoute();
  const billboards = useQuery(api.billboards.list);

  const playerMatch = route.match(/^\/player\/([^/]+)$/);
  if (playerMatch) {
    return <PlayerPage billboardId={playerMatch[1] as Id<"billboards">} />;
  }

  const sensorMatch = route.match(/^\/sensor\/([^/]+)$/);

  return (
    <div className="min-h-[100dvh]">
      <header className="border-b border-line">
        <div className="mx-auto flex h-14 max-w-[1400px] items-center gap-8 px-4 md:px-6">
          <a href="#/console" className="text-[15px] font-semibold tracking-tight">
            BillboardOS
          </a>
          <nav className="flex items-center gap-1 text-sm">
            <NavLink href="#/console" active={route === "/console"}>
              Console
            </NavLink>
            <NavLink href="#/finance" active={route === "/finance"}>
              Finance
            </NavLink>
            <NavLink href="#/book" active={route === "/book"}>
              Book a slot
            </NavLink>
            {billboards?.[0] && (
              <NavLink href={`#/sensor/${billboards[0]._id}`} active={route.startsWith("/sensor/")}>
                Sensor
              </NavLink>
            )}
            {billboards?.[0] && (
              <a
                href={`#/player/${billboards[0]._id}`}
                target="_blank"
                rel="noreferrer"
                className="rounded-md px-3 py-1.5 text-muted transition-colors hover:text-fg"
              >
                Open screen
              </a>
            )}
          </nav>
        </div>
      </header>
      {sensorMatch ? (
        <SensorPage billboardId={sensorMatch[1] as Id<"billboards">} />
      ) : route === "/book" ? (
        <BookPage />
      ) : route === "/finance" ? (
        <FinancePage />
      ) : (
        <ConsolePage />
      )}
    </div>
  );
}

function NavLink(props: { href: string; active: boolean; children: React.ReactNode }) {
  return (
    <a
      href={props.href}
      className={`rounded-md px-3 py-1.5 transition-colors ${
        props.active ? "bg-raised text-fg" : "text-muted hover:text-fg"
      }`}
    >
      {props.children}
    </a>
  );
}
