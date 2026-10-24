import { useState, type FormEvent } from "react";
import { useAuthActions } from "@convex-dev/auth/react";

type Flow = "signIn" | "signUp";
export type AccountType = "host" | "customer";

/** The side chosen at sign-up, applied on the first signed-in render (see RoleChooser). */
export const PENDING_ROLE_KEY = "billboardos:pendingAccountType";
export function readPendingRole(): AccountType | null {
  try {
    const v = localStorage.getItem(PENDING_ROLE_KEY);
    return v === "host" || v === "customer" ? v : null;
  } catch {
    return null;
  }
}

/** Map Convex Auth's terse errors to something an operator can act on. */
function authErrorMessage(err: unknown, flow: Flow): string {
  const raw = err instanceof Error ? err.message : String(err);
  if (/valid email/i.test(raw)) return "Enter a valid email address.";
  if (/already exists/i.test(raw)) return "An account with this email already exists. Sign in instead.";
  if (/password/i.test(raw) && /8|length|requirement|invalid password/i.test(raw)) {
    return "Password must be at least 8 characters.";
  }
  if (/InvalidAccountId|InvalidSecret|Invalid credentials/i.test(raw)) {
    return "Email or password is incorrect.";
  }
  if (/TooManyFailedAttempts/i.test(raw)) return "Too many attempts. Wait a minute and try again.";
  return flow === "signIn"
    ? "Could not sign in. Check your email and password."
    : "Could not create the account. If this email already has an account, sign in instead.";
}

export function SignInPage() {
  const { signIn } = useAuthActions();
  const [flow, setFlow] = useState<Flow>("signIn");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<AccountType>("customer");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (password.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }
    setBusy(true);
    try {
      if (flow === "signUp") {
        try {
          localStorage.setItem(PENDING_ROLE_KEY, role);
        } catch {
          // Private mode: the role chooser asks again after sign-up.
        }
      }
      await signIn("password", { email: email.trim(), password, flow });
    } catch (err) {
      setError(authErrorMessage(err, flow));
    } finally {
      setBusy(false);
    }
  }

  const signingUp = flow === "signUp";
  return (
    <main className="mx-auto flex max-w-[1400px] px-4 pt-16 pb-24 md:px-6">
      <section className="fade-in w-full max-w-sm" aria-labelledby="signin-heading">
        <h1 id="signin-heading" className="text-2xl font-semibold tracking-tight">
          {signingUp ? "Create your account" : "Sign in to BillboardOS"}
        </h1>
        <p className="mt-2 text-sm text-muted">
          {signingUp
            ? "Hosts run screens and get paid. Customers book ad time for their campaigns."
            : "Hosts see their screens and money; customers see their own campaigns and bookings."}
        </p>

        <form onSubmit={submit} className="mt-8 flex flex-col gap-5" noValidate>
          {signingUp && (
            <fieldset className="flex flex-col gap-2 text-sm">
              <legend className="mb-2 text-muted">I want to</legend>
              <div className="grid grid-cols-2 gap-2">
                {(
                  [
                    ["customer", "Book ad time", "Run campaigns on screens"],
                    ["host", "Host screens", "Sell time on my displays"],
                  ] as const
                ).map(([value, title, hint]) => (
                  <label
                    key={value}
                    className={`flex cursor-pointer flex-col gap-0.5 rounded-md border px-3 py-2 transition-colors ${
                      role === value ? "border-accent bg-accent/10" : "border-line bg-panel hover:border-muted"
                    }`}
                  >
                    <input
                      type="radio"
                      name="role"
                      value={value}
                      checked={role === value}
                      onChange={() => setRole(value)}
                      className="sr-only"
                    />
                    <span className="font-medium text-fg">{title}</span>
                    <span className="text-xs text-muted">{hint}</span>
                  </label>
                ))}
              </div>
            </fieldset>
          )}
          <label className="flex flex-col gap-2 text-sm">
            <span className="text-muted">Email</span>
            <input
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              aria-invalid={error !== null}
              className="rounded-md border border-line bg-panel px-3 py-2 text-fg outline-none focus:border-muted"
            />
          </label>
          <label className="flex flex-col gap-2 text-sm">
            <span className="text-muted">Password</span>
            <input
              type="password"
              autoComplete={signingUp ? "new-password" : "current-password"}
              required
              minLength={8}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              aria-invalid={error !== null}
              aria-describedby="password-help"
              className="rounded-md border border-line bg-panel px-3 py-2 text-fg outline-none focus:border-muted"
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
            disabled={busy || email.trim() === "" || password === ""}
            className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-ink transition-transform active:scale-[0.98] disabled:opacity-50"
          >
            {busy ? (signingUp ? "Creating account..." : "Signing in...") : signingUp ? "Create account" : "Sign in"}
          </button>
        </form>

        <p className="mt-6 text-sm text-muted">
          {signingUp ? "Already have an account?" : "New deployment or new teammate?"}{" "}
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
