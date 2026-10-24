import { useState, type FormEvent } from "react";
import { useAuthActions } from "@convex-dev/auth/react";

type Flow = "signIn" | "signUp";

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
          {signingUp ? "Create operator account" : "Operator sign in"}
        </h1>
        <p className="mt-2 text-sm text-muted">
          {signingUp
            ? "The first account on a new deployment becomes the operator. Later accounts need an operator to grant access."
            : "The console, finance desk and sensor are for operators. Booking and the screen stay public."}
        </p>

        <form onSubmit={submit} className="mt-8 flex flex-col gap-5" noValidate>
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

/** Signed in, but this account has not been granted operator access. */
export function NotOperatorPage({ email }: { email: string | null }) {
  return (
    <main className="mx-auto max-w-[1400px] px-4 pt-16 md:px-6">
      <section className="fade-in max-w-md">
        <h1 className="text-2xl font-semibold tracking-tight">Waiting for operator access</h1>
        <p className="mt-2 text-sm text-muted">
          {email ?? "This account"} is signed in but is not an operator yet. Ask an existing operator to grant access to
          this email, then reload.
        </p>
      </section>
    </main>
  );
}
