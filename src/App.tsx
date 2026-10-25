import { lazy, Suspense, useEffect, useState } from "react";
import { useConvexAuth, useMutation, useQuery } from "convex/react";
import { useAuthActions } from "@convex-dev/auth/react";
import type { FunctionReturnType } from "convex/server";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { useHashParams, useHashRoute } from "./lib/hooks";
import { ConsolePage } from "./console/ConsolePage";
import { PlayerPage } from "./player/PlayerPage";
import { ScreenPage } from "./screens/ScreenPage";
import { SensorPage } from "./sensor/SensorPage";
import { SignInPage } from "./auth/SignInPage";
import { AutoSetup } from "./auth/AutoSetup";
import { readPendingRole } from "./auth/SignInPage";
import {
  CUSTOMER_TABS,
  CustomerPage,
  type CustomerTab,
} from "./customer/CustomerPage";
import { WorkspacePage } from "./workspace/WorkspacePage";
import { MomentPage } from "./moment/MomentPage";
import { LandingPage } from "./demo/LandingPage";
import { DemoPage } from "./demo/DemoPage";
import { Brand } from "./demo/ui";
import "./dashboard.css";
import "./stitch-dashboard.css";
import { Plus, UserCircle } from "@phosphor-icons/react";

type Me = NonNullable<FunctionReturnType<typeof api.accounts.me>>;
const DesignPreview = import.meta.env.DEV ? lazy(() => import("./dev/DesignPreview")) : null;

export function App() {
  const route = useHashRoute();
  const params = useHashParams();
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [route]);
  if (route === "/design-preview" && DesignPreview) return <Suspense fallback={null}><DesignPreview /></Suspense>;
  if (route === "/" || route === "/landing") return <LandingPage />;
  if (route === "/demo") return <DemoPage />;
  // A device that becomes (or already is) a screen: pairing code, then the player with a heartbeat.
  if (route === "/screen") return <ScreenPage camera={params.get("camera") === "1"} />;
  // The screen itself stays public by billboard id (a preview: no heartbeat). `?camera=1` also counts people on this device.
  const playerMatch = route.match(/^\/player\/([^/]+)$/);
  if (playerMatch)
    return (
      <PlayerPage
        billboardId={playerMatch[1] as Id<"billboards">}
        camera={params.get("camera") === "1"}
      />
    );
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
    <div className={`app-shell min-h-[100dvh] ${signedIn?.accountType === "host" ? "host-shell" : ""}`}>
      <header className="app-header">
        <div className="app-header-inner">
          <Brand />
          {signedIn?.accountType === "host" &&
            signedIn.workspaces.length > 0 && <HostNav route={route} />}
          {signedIn?.accountType === "customer" &&
            signedIn.companies.length > 0 && (
              <nav className="flex min-w-0 items-center gap-1 overflow-x-auto text-sm">
                <NavLink
                  href="#/customer"
                  active={
                    (route.startsWith("/customer") &&
                      route !== "/customer/displays") ||
                    route === "/signin"
                  }
                >
                  Dashboard
                </NavLink>
                <NavLink
                  href="#/customer/displays"
                  active={route === "/customer/displays"}
                >
                  Find displays
                </NavLink>
              </nav>
            )}
          <div className="app-account ml-auto flex items-center gap-3">
            {signedIn?.accountType === "host" && (
              <a className="demo-button demo-button-primary header-add" href="#/console?add=1"><Plus size={17} />Add Display</a>
            )}
            {signedIn?.accountType === "host" &&
              signedIn.workspaces.length > 1 && (
                <WorkspaceSwitcher me={signedIn} />
              )}
            {signedIn && <AccountMenu me={signedIn} />}
          </div>
        </div>
      </header>
      {loading ? (
        <main className="grid min-h-[calc(100dvh-3.5rem)] place-items-center px-4">
          <p className="animate-pulse text-sm text-muted">
            Loading your workspace...
          </p>
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
  return me.accountType === "host"
    ? me.workspaces.length === 0
    : me.companies.length === 0;
}

function HostArea({ route }: { route: string }) {
  const sensorMatch = route.match(/^\/sensor\/([^/]+)$/);
  if (sensorMatch)
    return <SensorPage billboardId={sensorMatch[1] as Id<"billboards">} />;
  if (route === "/workspace") return <WorkspacePage />;
  if (route === "/moment") return <MomentPage />;
  return <ConsolePage />;
}

function CustomerArea({ me, route }: { me: Me; route: string }) {
  const tabMatch = route.match(/^\/customer(?:\/([a-z]+))?$/);
  if (
    tabMatch ||
    route === "/" ||
    route === "/console" ||
    route === "/signin"
  ) {
    const tab = (CUSTOMER_TABS.find((t) => t.key === tabMatch?.[1])?.key ??
      "overview") as CustomerTab;
    return (
      <CustomerPage
        tab={tab}
        companyName={me.companies[0]?.displayName ?? "Your company"}
      />
    );
  }
  return (
    <main className="mx-auto max-w-[1400px] px-4 py-16 md:px-6">
      <p className="text-muted">
        That page is for screen hosts.{" "}
        <a href="#/customer" className="text-fg underline underline-offset-4">
          Go to your dashboard
        </a>{" "}
        instead.
      </p>
    </main>
  );
}

function HostNav({ route }: { route: string }) {
  const screens = useQuery(api.billboards.mine, {});
  const first = screens?.[0];
  return <HostNavigation route={route} firstId={first?._id} />;
}

export function HostNavigation({ route, firstId }: { route: string; firstId?: string }) {
  return (
    <nav
      aria-label="Host navigation"
      className="app-navigation flex min-w-0 items-center gap-1 text-sm"
    >
      <NavLink
        href="#/console"
        active={route === "/console" || route === "/" || route === "/signin"}
      >
        Overview
      </NavLink>
      <NavLink href="#/displays" active={route === "/displays"}>Displays</NavLink>
      <NavLink href="#/moment" active={route === "/moment"}>
        Live Sales
      </NavLink>
      <NavLink href="#/workspace" active={route === "/workspace"}>Settings</NavLink>
      {firstId && <details className="demo-header-tools">
        <summary>Tools</summary>
        <div className="demo-advanced-menu">
          <a href="#/workspace">Workspace settings</a>
          {firstId && <a href={`#/sensor/${firstId}`}>Audience sensor</a>}

        <a
          href={`#/player/${firstId}`}
          target="_blank"
          rel="noreferrer"
          title="A preview on this computer. The real screen runs on the ad machine: open #/screen there."
          className="rounded-md px-3 py-1.5 text-muted transition-colors hover:text-fg"
        >
          Preview screen
        </a>
        </div>
      </details>}
    </nav>
  );
}

/** Hosts in several workspaces pick which one the console and sensor show. */
function WorkspaceSwitcher({ me }: { me: Me }) {
  const setActive = useMutation(api.accounts.setActiveWorkspace);
  return (
    <label className="flex items-center gap-2 text-sm">
      <span className="sr-only">Workspace</span>
      <select
        className="rounded-md border border-line bg-panel px-2 py-1.5 text-fg"
        value={me.activeWorkspaceId ?? ""}
        onChange={(e) =>
          void setActive({ workspaceId: e.target.value as Id<"workspaces"> })
        }
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
    <details className="account-menu">
      <summary aria-label="Account menu"><UserCircle size={30} weight="duotone" /></summary>
      <div className="account-popover">
      {me.accountType === "host" && <a href="#/workspace">Workspace settings</a>}
      <span
        className="account-name"
        title={me.email ?? undefined}
      >
        {where ?? me.email ?? "Signed in"}
      </span>
      <button
        type="button"
        onClick={() => void signOut()}
        className="shrink-0 rounded-md border border-line px-3 py-1.5 whitespace-nowrap text-muted transition-colors hover:text-fg"
      >
        Sign out
      </button>
      </div>
    </details>
  );
}

function NavLink(props: {
  href: string;
  active: boolean;
  children: React.ReactNode;
}) {
  return (
    <a
      href={props.href}
      aria-current={props.active ? "page" : undefined}
      className={`rounded-md px-3 py-1.5 whitespace-nowrap transition-colors ${props.active ? "bg-raised text-fg" : "text-muted hover:text-fg"}`}
    >
      {props.children}
    </a>
  );
}
