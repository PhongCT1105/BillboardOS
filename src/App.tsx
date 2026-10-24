import { useConvexAuth, useQuery } from "convex/react";
import { useAuthActions } from "@convex-dev/auth/react";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { useHashRoute } from "./lib/hooks";
import { ConsolePage } from "./console/ConsolePage";
import { PlayerPage } from "./player/PlayerPage";
import { BookPage } from "./book/BookPage";
import { FinancePage } from "./finance/FinancePage";
import { SensorPage } from "./sensor/SensorPage";
import { NotOperatorPage, SignInPage } from "./auth/SignInPage";

export function App() {
  const route = useHashRoute();
  const billboards = useQuery(api.billboards.list);

  const playerMatch = route.match(/^\/player\/([^/]+)$/);
  if (playerMatch) {
    return <PlayerPage billboardId={playerMatch[1] as Id<"billboards">} />;
  }

  const sensorMatch = route.match(/^\/sensor\/([^/]+)$/);
  // #/book and #/player are public; everything else is the operator's desk.
  const operatorOnly = route !== "/book";

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
          <AccountMenu />
        </div>
      </header>
      {operatorOnly ? (
        <OperatorGate>
          {sensorMatch ? (
            <SensorPage billboardId={sensorMatch[1] as Id<"billboards">} />
          ) : route === "/finance" ? (
            <FinancePage />
          ) : (
            <ConsolePage />
          )}
        </OperatorGate>
      ) : (
        <BookPage />
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

/** Renders children only for a signed-in operator; otherwise sign-in or a "no access" note. */
function OperatorGate({ children }: { children: React.ReactNode }) {
  const { isLoading, isAuthenticated } = useConvexAuth();
  const me = useQuery(api.operators.me, isAuthenticated ? {} : "skip");
  if (isLoading || (isAuthenticated && me === undefined)) {
    return (
      <main className="mx-auto max-w-[1400px] px-4 pt-8 md:px-6">
        <div className="h-64 animate-pulse rounded bg-panel" />
      </main>
    );
  }
  if (!isAuthenticated || me === null) return <SignInPage />;
  if (!me?.isOperator) return <NotOperatorPage email={me?.email ?? null} />;
  return <>{children}</>;
}

function AccountMenu() {
  const { isAuthenticated } = useConvexAuth();
  const { signOut } = useAuthActions();
  const me = useQuery(api.operators.me, isAuthenticated ? {} : "skip");
  if (!isAuthenticated || !me) return null;
  return (
    <div className="ml-auto flex items-center gap-3 text-sm">
      <span className="hidden text-muted sm:inline" title={me.isOperator ? "Operator" : "Not an operator yet"}>
        {me.email ?? "Signed in"}
      </span>
      <button
        type="button"
        onClick={() => void signOut()}
        className="rounded-md border border-line px-3 py-1.5 text-muted transition-colors hover:text-fg"
      >
        Sign out
      </button>
    </div>
  );
}
