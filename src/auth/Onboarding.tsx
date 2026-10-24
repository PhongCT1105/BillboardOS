import { useState, type FormEvent, type ReactNode } from "react";
import { useMutation } from "convex/react";
import { api } from "../../convex/_generated/api";
import { errorMessage } from "../lib/format";
import { PENDING_ROLE_KEY, readPendingRole, type AccountType } from "./SignInPage";

const input = "rounded-md border border-line bg-panel px-3 py-2 text-fg outline-none focus:border-muted";
const primary =
  "rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-ink transition-transform active:scale-[0.98] disabled:opacity-50";

function Shell(props: { title: string; lead: string; children: ReactNode }) {
  return (
    <main className="mx-auto max-w-[1400px] px-4 pt-16 pb-24 md:px-6">
      <section className="fade-in w-full max-w-md">
        <h1 className="text-2xl font-semibold tracking-tight">{props.title}</h1>
        <p className="mt-2 text-sm text-muted">{props.lead}</p>
        {props.children}
      </section>
    </main>
  );
}

function useSubmit() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function run(e: FormEvent, fn: () => Promise<unknown>) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }
  return { busy, error, run };
}

function ErrorLine({ error }: { error: string | null }) {
  return error ? (
    <p role="alert" className="text-sm text-danger">
      {error}
    </p>
  ) : null;
}

/** Signed in without a side yet (e.g. sign-up finished in another tab). */
export function RoleChooser() {
  const setAccountType = useMutation(api.accounts.setAccountType);
  const [role, setRole] = useState<AccountType>(readPendingRole() ?? "customer");
  const { busy, error, run } = useSubmit();
  return (
    <Shell title="How will you use BillboardOS?" lead="You can't change this later; a host can still be invited into other workspaces.">
      <form
        className="mt-8 flex flex-col gap-5"
        onSubmit={(e) =>
          run(e, async () => {
            await setAccountType({ accountType: role });
            try {
              localStorage.removeItem(PENDING_ROLE_KEY);
            } catch {
              // ignore
            }
          })
        }
      >
        <fieldset className="grid grid-cols-2 gap-2 text-sm">
          <legend className="sr-only">Account type</legend>
          {(
            [
              ["customer", "Book ad time", "Run campaigns on screens"],
              ["host", "Host screens", "Sell time on my displays"],
            ] as const
          ).map(([value, title, hint]) => (
            <label
              key={value}
              className={`flex cursor-pointer flex-col gap-0.5 rounded-md border px-3 py-2 ${
                role === value ? "border-accent bg-accent/10" : "border-line bg-panel hover:border-muted"
              }`}
            >
              <input type="radio" name="role" checked={role === value} onChange={() => setRole(value)} className="sr-only" />
              <span className="font-medium text-fg">{title}</span>
              <span className="text-xs text-muted">{hint}</span>
            </label>
          ))}
        </fieldset>
        <ErrorLine error={error} />
        <button type="submit" disabled={busy} className={primary}>
          Continue
        </button>
      </form>
    </Shell>
  );
}

/** Host onboarding: name the workspace that owns your screens. */
export function CreateWorkspace() {
  const create = useMutation(api.workspaces.create);
  const [name, setName] = useState("");
  const [city, setCity] = useState("");
  const { busy, error, run } = useSubmit();
  return (
    <Shell title="Create your host workspace" lead="Your screens, team, payouts and finance desk live here. You can invite teammates later.">
      <form className="mt-8 flex flex-col gap-5" onSubmit={(e) => run(e, () => create({ name, city }))}>
        <label className="flex flex-col gap-2 text-sm">
          <span className="text-muted">Workspace name</span>
          <input required value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Mission Screens" className={input} />
        </label>
        <label className="flex flex-col gap-2 text-sm">
          <span className="text-muted">City</span>
          <input required value={city} onChange={(e) => setCity(e.target.value)} placeholder="San Francisco" className={input} />
        </label>
        <ErrorLine error={error} />
        <button type="submit" disabled={busy || !name.trim() || !city.trim()} className={primary}>
          Create workspace
        </button>
      </form>
    </Shell>
  );
}

const SIZES = ["1-10", "11-50", "51-200", "201-1000", "1000+"] as const;

/** Customer onboarding: the company your campaigns belong to. */
export function CreateCompany() {
  const create = useMutation(api.accounts.createCompany);
  const [name, setName] = useState("");
  const [website, setWebsite] = useState("");
  const [size, setSize] = useState<(typeof SIZES)[number] | "">("");
  const { busy, error, run } = useSubmit();
  return (
    <Shell title="Tell us about your company" lead="Campaigns, bookings and invoices belong to your company. Only its members see them.">
      <form
        className="mt-8 flex flex-col gap-5"
        onSubmit={(e) => run(e, () => create({ name, website: website.trim() || undefined, size: size || undefined }))}
      >
        <label className="flex flex-col gap-2 text-sm">
          <span className="text-muted">Company name</span>
          <input required value={name} onChange={(e) => setName(e.target.value)} className={input} />
        </label>
        <label className="flex flex-col gap-2 text-sm">
          <span className="text-muted">Website (optional)</span>
          <input type="url" value={website} onChange={(e) => setWebsite(e.target.value)} placeholder="https://" className={input} />
        </label>
        <label className="flex flex-col gap-2 text-sm">
          <span className="text-muted">Company size (optional)</span>
          <select value={size} onChange={(e) => setSize(e.target.value as typeof size)} className={input}>
            <option value="">Prefer not to say</option>
            {SIZES.map((s) => (
              <option key={s} value={s}>
                {s} people
              </option>
            ))}
          </select>
        </label>
        <ErrorLine error={error} />
        <button type="submit" disabled={busy || !name.trim()} className={primary}>
          Create company
        </button>
      </form>
    </Shell>
  );
}

/** Host: add a screen to the active workspace (12 h of slots go on sale immediately). */
export function AddScreenForm() {
  const create = useMutation(api.billboards.create);
  const [name, setName] = useState("");
  const [city, setCity] = useState("");
  const [location, setLocation] = useState("");
  const [base, setBase] = useState("40");
  const [floor, setFloor] = useState("20");
  const { busy, error, run } = useSubmit();
  const offset = -new Date().getTimezoneOffset();
  return (
    <form
      className="flex max-w-xl flex-col gap-4 rounded-lg border border-line bg-panel p-5"
      onSubmit={(e) =>
        run(e, () =>
          create({
            name,
            city,
            locationLabel: location,
            utcOffsetMinutes: offset,
            baseRateMinor: Math.round(Number.parseFloat(base) * 100),
            reserveFloorMinor: Math.round(Number.parseFloat(floor) * 100),
          }),
        )
      }
    >
      <h2 className="text-lg font-semibold">Add a screen</h2>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <label className="flex flex-col gap-2 text-sm">
          <span className="text-muted">Screen name</span>
          <input required value={name} onChange={(e) => setName(e.target.value)} className={input} />
        </label>
        <label className="flex flex-col gap-2 text-sm">
          <span className="text-muted">City</span>
          <input required value={city} onChange={(e) => setCity(e.target.value)} className={input} />
        </label>
      </div>
      <label className="flex flex-col gap-2 text-sm">
        <span className="text-muted">Where it is</span>
        <input required value={location} onChange={(e) => setLocation(e.target.value)} placeholder="Street and cross street" className={input} />
      </label>
      <div className="grid grid-cols-2 gap-4">
        <label className="flex flex-col gap-2 text-sm">
          <span className="text-muted">Base price per 15 min (USD)</span>
          <input inputMode="decimal" value={base} onChange={(e) => setBase(e.target.value)} className={`${input} font-mono`} />
        </label>
        <label className="flex flex-col gap-2 text-sm">
          <span className="text-muted">Never below (USD)</span>
          <input inputMode="decimal" value={floor} onChange={(e) => setFloor(e.target.value)} className={`${input} font-mono`} />
        </label>
      </div>
      <ErrorLine error={error} />
      <button type="submit" disabled={busy || !name.trim() || !city.trim() || !location.trim()} className={`${primary} self-start`}>
        Add screen
      </button>
    </form>
  );
}
