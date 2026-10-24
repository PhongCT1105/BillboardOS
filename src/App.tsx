import { useConvexAuth, useMutation, useQuery } from "convex/react";
import { useAuthActions } from "@convex-dev/auth/react";
import type { FunctionReturnType } from "convex/server";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { useHashRoute } from "./lib/hooks";
import { ConsolePage } from "./console/ConsolePage";
import { PlayerPage } from "./player/PlayerPage";
import { BookPage } from "./book/BookPage";
import { FinancePage } from "./finance/FinancePage";
import { SensorPage } from "./sensor/SensorPage";
import { SignInPage } from "./auth/SignInPage";
import { CreateCompany, CreateWorkspace, RoleChooser } from "./auth/Onboarding";

type Me = NonNullable<FunctionReturnType<typeof api.accounts.me>>;

export function App() {
  const route = useHashRoute();
  // The screen itself stays public by billboard id.
  const playerMatch = route.match(/^\/player\/([^/]+)$/);
  if (playerMatch) return <PlayerPage billboardId={playerMatch[1] as Id<"billboards">} />;
  return <Shell route={route} />;
}

function Shell({ route }: { route: string }) {
  const { isLoading, isAuthenticated } = useConvexAuth();
  const me = useQuery(api.accounts.me, isAuthenticated ? {} : "skip");
  const loading = isLoading || (isAuthenticated && me === undefined);
  const signedIn = isAuthenticated && me ? me : null;

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
              <NavLink href="#/book" active={route === "/book" || route === "/"}>
                Book a slot
              </NavLink>
            </nav>
          )}
          <div className="ml-auto flex items-center gap-3">
            {signedIn?.accountType === "host" && signedIn.workspaces.length > 1 && <WorkspaceSwitcher me={signedIn} />}
            {signedIn && <AccountMenu me={signedIn} />}
          </div>
        </div>
      </header>
      {loading ? (
        <main className="mx-auto max-w-[1400px] px-4 pt-8 md:px-6">
          <div className="h-64 animate-pulse rounded bg-panel" />
        </main>
      ) : !signedIn ? (
        <SignInPage />
      ) : signedIn.accountType === null ? (
        <RoleChooser />
      ) : signedIn.accountType === "host" ? (
        <HostArea me={signedIn} route={route} />
      ) : (
        <CustomerArea me={signedIn} route={route} />
      )}
    </div>
  );
}

function HostArea({ me, route }: { me: Me; route: string }) {
  if (me.workspaces.length === 0) return <CreateWorkspace />;
  const sensorMatch = route.match(/^\/sensor\/([^/]+)$/);
  if (sensorMatch) return <SensorPage billboardId={sensorMatch[1] as Id<"billboards">} />;
  if (route === "/finance") return <FinancePage />;
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
  if (me.companies.length === 0) return <CreateCompany />;
  if (route !== "/book" && route !== "/" && route !== "/console") {
    return (
      <main className="mx-auto max-w-[1400px] px-4 py-16 md:px-6">
        <p className="text-muted">
          That page is for screen hosts. <a href="#/book" className="text-fg underline underline-offset-4">Book a slot</a> instead.
        </p>
      </main>
    );
  }
  return <BookPage />;
}

function HostNav({ route }: { route: string }) {
  const screens = useQuery(api.billboards.mine, {});
  const first = screens?.[0];
  return (
    <nav className="flex items-center gap-1 text-sm">
      <NavLink href="#/console" active={route === "/console" || route === "/"}>
        Console
      </NavLink>
      <NavLink href="#/finance" active={route === "/finance"}>
        Finance
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
