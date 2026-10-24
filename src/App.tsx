import { useEffect, useState } from "react";
import { useConvexAuth, useMutation, useQuery } from "convex/react";
import { useAuthActions } from "@convex-dev/auth/react";
import type { FunctionReturnType } from "convex/server";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { useHashParams, useHashRoute } from "./lib/hooks";
import { ConsolePage } from "./console/ConsolePage";
import { PlayerPage } from "./player/PlayerPage";
import { BookPage } from "./book/BookPage";
import { FinancePage } from "./finance/FinancePage";
import { SensorPage } from "./sensor/SensorPage";
import { SignInPage } from "./auth/SignInPage";
import { AutoSetup } from "./auth/AutoSetup";
import { readPendingRole } from "./auth/SignInPage";
import { AlertsBadgeLink, CUSTOMER_TABS, CustomerPage, type CustomerTab } from "./customer/CustomerPage";
import { WorkspacePage } from "./workspace/WorkspacePage";
import { MomentPage } from "./moment/MomentPage";

type Me = NonNullable<FunctionReturnType<typeof api.accounts.me>>;

export function App() {
  const route = useHashRoute();
  const params = useHashParams();
  // The screen itself stays public by billboard id. `?camera=1` also counts people on this device.
  const playerMatch = route.match(/^\/player\/([^/]+)$/);
  if (playerMatch) return <PlayerPage billboardId={playerMatch[1] as Id<"billboards">} camera={params.get("camera") === "1"} />;
  return <Shell route={route} />;
}

function Shell({ route }: { route: string }) {
  const { isLoading, isAuthenticated } = useConvexAuth();
  const me = useQuery(api.accounts.me, isAuthenticated ? {} : "skip");
  const loading = isLoading || (isAuthenticated && me === undefined);
  const signedIn = isAuthenticated && me ? me : null;
  // A fresh sign-up stays on the setup screen until every starter step has finished.
  const [setupRunning, setSetupRunning] = useState(false);
  const userId = signedIn?.userId;
  useEffect(() => {
    if (userId && readPendingRole()) setSetupRunning(true);
  }, [userId]);

  return (
    <div className="min-h-[100dvh]">
      <header className="border-b border-line">
        <div className="mx-auto flex h-14 max-w-[1400px] items-center gap-6 px-4 md:px-6">
          <a href="#/" className="text-[15px] font-semibold tracking-tight">
            BillboardOS
          </a>
          {signedIn?.accountType === "host" && signedIn.workspaces.length > 0 && <HostNav route={route} />}
          {signedIn?.accountType === "customer" && signedIn.companies.length > 0 && (
            <nav className="flex items-center gap-1 text-sm">
              <NavLink href="#/customer" active={route.startsWith("/customer") && route !== "/customer/alerts"}>
                Dashboard
              </NavLink>
              <NavLink href="#/book" active={route === "/book"}>
                Book a slot
              </NavLink>
              <AlertsBadgeLink active={route === "/customer/alerts"} />
            </nav>
          )}
          <div className="ml-auto flex items-center gap-3">
            {signedIn?.accountType === "host" && signedIn.workspaces.length > 1 && <WorkspaceSwitcher me={signedIn} />}
            {signedIn && <AccountMenu me={signedIn} />}
          </div>
        </div>
      </header>
      {loading ? (
        <main className="grid min-h-[calc(100dvh-3.5rem)] place-items-center px-4">
          <p className="animate-pulse text-sm text-muted">Loading your workspace...</p>
        </main>
      ) : !signedIn ? (
        <SignInPage />
      ) : setupRunning || needsSetup(signedIn) ? (
        <AutoSetup me={signedIn} onDone={() => setSetupRunning(false)} />
      ) : signedIn.accountType === "host" ? (
        <HostArea route={route} />
      ) : (
        <CustomerArea me={signedIn} route={route} />
      )}
    </div>
  );
}

/** New accounts land on automatic setup until they have a workspace (host) or company (customer). */
function needsSetup(me: Me): boolean {
  if (me.accountType === null) return true;
  return me.accountType === "host" ? me.workspaces.length === 0 : me.companies.length === 0;
}

function HostArea({ route }: { route: string }) {
  const sensorMatch = route.match(/^\/sensor\/([^/]+)$/);
  if (sensorMatch) return <SensorPage billboardId={sensorMatch[1] as Id<"billboards">} />;
  if (route === "/finance") return <FinancePage />;
  if (route === "/workspace") return <WorkspacePage />;
  if (route === "/moment") return <MomentPage />;
  if (route === "/book") {
    return (
      <main className="mx-auto max-w-[1400px] px-4 py-16 md:px-6">
        <p className="text-muted">Booking is for customer accounts. Sign in with a customer account to buy ad time.</p>
      </main>
    );
  }
  return <ConsolePage />;
}

function CustomerArea({ me, route }: { me: Me; route: string }) {
  if (route === "/book") return <BookPage />;
  const tabMatch = route.match(/^\/customer(?:\/([a-z]+))?$/);
  if (tabMatch || route === "/" || route === "/console") {
    const tab = (CUSTOMER_TABS.find((t) => t.key === tabMatch?.[1])?.key ?? "agent") as CustomerTab;
    return <CustomerPage tab={tab} companyName={me.companies[0]?.displayName ?? "Your company"} />;
  }
  return (
    <main className="mx-auto max-w-[1400px] px-4 py-16 md:px-6">
      <p className="text-muted">
        That page is for screen hosts. <a href="#/customer" className="text-fg underline underline-offset-4">Go to your dashboard</a> instead.
      </p>
    </main>
  );
}

function HostNav({ route }: { route: string }) {
  const screens = useQuery(api.billboards.mine, {});
  const first = screens?.[0];
  return (
    <nav className="flex items-center gap-1 text-sm">
      <NavLink href="#/console" active={route === "/console" || route === "/"}>
        Console
      </NavLink>
      <NavLink href="#/moment" active={route === "/moment"}>
        Live moment
      </NavLink>
      <NavLink href="#/finance" active={route === "/finance"}>
        Finance
      </NavLink>
      <NavLink href="#/workspace" active={route === "/workspace"}>
        Workspace
      </NavLink>
      {first && (
        <NavLink href={`#/sensor/${first._id}`} active={route.startsWith("/sensor/")}>
          Sensor
        </NavLink>
      )}
      {first && (
        <a
          href={`#/player/${first._id}`}
          target="_blank"
          rel="noreferrer"
          className="rounded-md px-3 py-1.5 text-muted transition-colors hover:text-fg"
        >
          Open screen
        </a>
      )}
    </nav>
  );
}

/** Hosts in several workspaces pick which one the console, finance desk and sensor show. */
function WorkspaceSwitcher({ me }: { me: Me }) {
  const setActive = useMutation(api.accounts.setActiveWorkspace);
  return (
    <label className="flex items-center gap-2 text-sm">
      <span className="sr-only">Workspace</span>
      <select
        className="rounded-md border border-line bg-panel px-2 py-1.5 text-fg"
        value={me.activeWorkspaceId ?? ""}
        onChange={(e) => void setActive({ workspaceId: e.target.value as Id<"workspaces"> })}
      >
        {me.workspaces.map((w) => (
          <option key={w.workspaceId} value={w.workspaceId}>
            {w.name}
          </option>
        ))}
      </select>
    </label>
  );
}

function AccountMenu({ me }: { me: Me }) {
  const { signOut } = useAuthActions();
  const where =
    me.accountType === "host"
      ? me.workspaces.find((w) => w.workspaceId === me.activeWorkspaceId)?.name
      : me.companies[0]?.displayName;
  return (
    <div className="flex items-center gap-3 text-sm">
      <span className="hidden text-muted sm:inline">
        {me.email ?? "Signed in"}
        {where && <span className="text-faint"> · {where}</span>}
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

function NavLink(props: { href: string; active: boolean; children: React.ReactNode }) {
  return (
    <a
      href={props.href}
      className={`rounded-md px-3 py-1.5 transition-colors ${props.active ? "bg-raised text-fg" : "text-muted hover:text-fg"}`}
    >
      {props.children}
    </a>
  );
}
