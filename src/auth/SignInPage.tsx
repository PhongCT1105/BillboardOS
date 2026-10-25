import { useState, type FormEvent } from "react";
import { useAuthActions } from "@convex-dev/auth/react";
import { Lightning, Monitor, Megaphone } from "@phosphor-icons/react";

type Flow = "signIn" | "signUp";
export type AccountType = "host" | "customer";

/** The side chosen at sign-up, applied right after sign-in by AutoSetup. */
export const PENDING_ROLE_KEY = "billboardos:pendingAccountType";
export function readPendingRole(): AccountType | null {
  try {
    const v = localStorage.getItem(PENDING_ROLE_KEY);
    return v === "host" || v === "customer" ? v : null;
  } catch {
    return null;
  }
}

function rememberRole(role: AccountType) {
  try {
    localStorage.setItem(PENDING_ROLE_KEY, role);
  } catch {
    // Private mode: AutoSetup falls back to asking.
  }
}

/** One-click demo accounts: generated credentials kept in this browser so the demo can be resumed. */
const DEMO_KEY = "billboardos:demoAccount";
type DemoAccount = { email: string; password: string; role: AccountType };

function readDemo(): DemoAccount | null {
  try {
    const raw = localStorage.getItem(DEMO_KEY);
    const v = raw ? (JSON.parse(raw) as DemoAccount) : null;
    return v && v.email && v.password && (v.role === "host" || v.role === "customer") ? v : null;
  } catch {
    return null;
  }
}

function newDemo(role: AccountType): DemoAccount {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return {
    email: `demo-${role === "host" ? "host" : "advertiser"}-${hex.slice(0, 8)}@demo.billboardos.dev`,
    password: hex,
    role,
  };
}

/** Map Convex Auth's terse errors to something a person can act on. */
function authErrorMessage(err: unknown, flow: Flow): string {
  const raw = err instanceof Error ? err.message : String(err);
  if (/valid email/i.test(raw)) return "Enter a valid email address.";
  if (/already exists/i.test(raw)) return "An account with this email already exists. Sign in instead.";
  if (/password/i.test(raw) && /8|length|requirement|invalid password/i.test(raw)) {
    return "Password must be at least 8 characters.";
  }
  if (/InvalidAccountId|InvalidSecret|Invalid credentials/i.test(raw)) return "Email or password is incorrect.";
  if (/TooManyFailedAttempts/i.test(raw)) return "Too many attempts. Wait a minute and try again.";
  return flow === "signIn"
    ? "Could not sign in. Check your email and password."
    : "Could not create the account. If this email already has an account, sign in instead.";
}

const input = "rounded-md border border-line bg-ink px-3 py-2 text-fg outline-none transition-colors focus:border-muted";

export function SignInPage() {
  const { signIn } = useAuthActions();
  const [flow, setFlow] = useState<Flow>("signIn");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<AccountType>("host");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const savedDemo = readDemo();

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (password.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }
    setBusy(flow);
    try {
      if (flow === "signUp") rememberRole(role);
      await signIn("password", { email: email.trim(), password, flow });
    } catch (err) {
      setError(authErrorMessage(err, flow));
      setBusy(null);
    }
  }

  async function quickStart(next: AccountType) {
    setError(null);
    setBusy(next);
    const demo = newDemo(next);
    try {
      rememberRole(next);
      localStorage.setItem(DEMO_KEY, JSON.stringify(demo));
    } catch {
      // Without storage the demo still works; it just can't be resumed later.
    }
    try {
      await signIn("password", { email: demo.email, password: demo.password, flow: "signUp" });
    } catch (err) {
      setError(authErrorMessage(err, "signUp"));
      setBusy(null);
    }
  }

  async function resumeDemo(demo: DemoAccount) {
    setError(null);
    setBusy("resume");
    try {
      await signIn("password", { email: demo.email, password: demo.password, flow: "signIn" });
    } catch (err) {
      setError(authErrorMessage(err, "signIn"));
      setBusy(null);
    }
  }

  const signingUp = flow === "signUp";
  return (
    <main className="grid min-h-[calc(100dvh-3.5rem)] place-items-center px-4 py-12">
      <section className="fade-in w-full max-w-md rounded-xl border border-line bg-panel p-8" aria-labelledby="signin-heading">
        <h1 id="signin-heading" className="text-2xl font-semibold tracking-tight">
          {signingUp ? "Create your account" : "Welcome to BillboardOS"}
        </h1>
        <p className="mt-2 text-sm text-muted">Screens that sell their own ad time. Agents buy it and pay over x402.</p>

        <div className="mt-6 grid grid-cols-2 gap-2">
          <QuickButton
            icon={<Monitor size={18} />}
            title="Try as a host"
            hint="Get a screen in seconds"
            busy={busy === "host"}
            disabled={busy !== null}
            onClick={() => void quickStart("host")}
          />
          <QuickButton
            icon={<Megaphone size={18} />}
            title="Try as an advertiser"
            hint="Get a starter campaign"
            busy={busy === "customer"}
            disabled={busy !== null}
            onClick={() => void quickStart("customer")}
          />
        </div>
        {savedDemo && (
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => void resumeDemo(savedDemo)}
            className="mt-2 flex w-full items-center justify-center gap-2 rounded-md border border-line px-3 py-2 text-sm text-muted transition-colors hover:text-fg disabled:opacity-50"
          >
            <Lightning size={14} />
            {busy === "resume" ? "Signing in..." : `Continue your demo ${savedDemo.role === "host" ? "host" : "advertiser"} account`}
          </button>
        )}

        <div className="my-6 flex items-center gap-3 text-xs text-faint">
          <span className="h-px flex-1 bg-line" />
          or with email
          <span className="h-px flex-1 bg-line" />
        </div>

        <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
          {signingUp && (
            <fieldset className="grid grid-cols-2 gap-2 text-sm">
              <legend className="mb-2 text-muted">I want to</legend>
              {(
                [
                  ["host", "Host screens"],
                  ["customer", "Book ad time"],
                ] as const
              ).map(([value, title]) => (
                <label
                  key={value}
                  className={`cursor-pointer rounded-md border px-3 py-2 text-center transition-colors ${
                    role === value ? "border-accent bg-accent/10 text-fg" : "border-line text-muted hover:border-muted"
                  }`}
                >
                  <input type="radio" name="role" value={value} checked={role === value} onChange={() => setRole(value)} className="sr-only" />
                  {title}
                </label>
              ))}
            </fieldset>
          )}
          <label className="flex flex-col gap-1.5 text-sm">
            <span className="text-muted">Email</span>
            <input
              type="email"
              name="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              aria-invalid={error !== null}
              className={input}
            />
          </label>
          <label className="flex flex-col gap-1.5 text-sm">
            <span className="text-muted">Password</span>
            <input
              type="password"
              name="password"
              autoComplete={signingUp ? "new-password" : "current-password"}
              required
              minLength={8}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              aria-invalid={error !== null}
              aria-describedby="password-help"
              className={input}
            />
            <span id="password-help" className="text-xs text-faint">
              At least 8 characters.
            </span>
          </label>

          {error && (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={busy !== null || email.trim() === "" || password === ""}
            className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-ink transition-transform active:scale-[0.98] disabled:opacity-50"
          >
            {busy === flow ? (signingUp ? "Creating account..." : "Signing in...") : signingUp ? "Create account" : "Sign in"}
          </button>
        </form>

        <p className="mt-5 text-center text-sm text-muted">
          {signingUp ? "Already have an account?" : "New here?"}{" "}
          <button
            type="button"
            onClick={() => {
              setFlow(signingUp ? "signIn" : "signUp");
              setError(null);
            }}
            className="text-fg underline underline-offset-4 hover:text-accent"
          >
            {signingUp ? "Sign in" : "Create an account"}
          </button>
        </p>
      </section>
    </main>
  );
}

function QuickButton(props: {
  icon: React.ReactNode;
  title: string;
  hint: string;
  busy: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      disabled={props.disabled}
      className="flex flex-col items-start gap-1 rounded-md border border-line bg-ink px-3 py-3 text-left transition-colors hover:border-accent disabled:opacity-60"
    >
      <span className="text-accent">{props.icon}</span>
      <span className="text-sm font-medium text-fg">{props.busy ? "Setting up..." : props.title}</span>
      <span className="text-xs text-muted">{props.hint}</span>
    </button>
  );
}
