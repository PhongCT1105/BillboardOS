import { useEffect, useRef, useState } from "react";
import { useMutation } from "convex/react";
import { Check } from "@phosphor-icons/react";
import type { FunctionReturnType } from "convex/server";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { errorMessage } from "../lib/format";
import { CreateCompany, CreateWorkspace, RoleChooser } from "./Onboarding";
import { PENDING_ROLE_KEY, readPendingRole, type AccountType } from "./SignInPage";
import { STARTER_AUDIENCE, detectPlace, randomCompanyName, randomHostName, randomScreenName } from "./place";

type Me = NonNullable<FunctionReturnType<typeof api.accounts.me>>;
type Step = { label: string; done: boolean };

function codeOf(err: unknown): string | undefined {
  if (err && typeof err === "object" && "data" in err) {
    const data = (err as { data: unknown }).data;
    if (data && typeof data === "object" && "code" in data) return String((data as { code: unknown }).code);
  }
  return undefined;
}

/**
 * Right after sign-up: pick the side chosen on the form, then create a workspace with one screen
 * (host) or a company with a starter campaign (customer), named and placed automatically.
 * Everything can be renamed later; the point is landing on a working dashboard in seconds.
 */
export function AutoSetup({ me, onDone }: { me: Me; onDone: () => void }) {
  const role: AccountType | null = me.accountType ?? readPendingRole();
  if (!role) return <RoleChooser />;
  return <AutoSetupRun me={me} role={role} onDone={onDone} />;
}

function finish(onDone: () => void) {
  try {
    localStorage.removeItem(PENDING_ROLE_KEY);
  } catch {
    // ignore
  }
  onDone();
}

function AutoSetupRun({ me, role, onDone }: { me: Me; role: AccountType; onDone: () => void }) {
  const setAccountType = useMutation(api.accounts.setAccountType);
  const createWorkspace = useMutation(api.workspaces.create);
  const createScreen = useMutation(api.billboards.create);
  const setAudience = useMutation(api.billboards.setAudienceTags);
  const createCompany = useMutation(api.accounts.createCompany);
  const createCampaign = useMutation(api.campaigns.create);
  const generateUploadUrl = useMutation(api.creatives.generateUploadUrl);
  const attachCreative = useMutation(api.creatives.attach);
  const place = useRef(detectPlace()).current;
  const started = useRef(false);
  const [steps, setSteps] = useState<Step[]>(
    role === "host"
      ? [
          { label: `Detected ${place.city}`, done: true },
          { label: "Creating your host workspace", done: false },
          { label: "Adding your first screen", done: false },
        ]
      : [
          { label: `Detected ${place.city}`, done: true },
          { label: "Creating your company", done: false },
          { label: "Adding a starter campaign", done: false },
          { label: "Uploading a starter ad", done: false },
        ],
  );
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const tick = (i: number, label?: string) =>
      setSteps((s) => s.map((step, j) => (j === i ? { label: label ?? step.label, done: true } : step)));

    (async () => {
      try {
        if (!me.accountType) await setAccountType({ accountType: role });
        if (role === "host") {
          if (me.workspaces.length === 0) {
            const name = randomHostName();
            const workspaceId = await createWorkspace({ name, city: place.city });
            tick(1, `Created ${name}`);
            let screenId;
            for (let attempt = 0; attempt < 4 && !screenId; attempt++) {
              try {
                screenId = await createScreen({
                  workspaceId,
                  name: randomScreenName(place.city),
                  city: place.city,
                  locationLabel: place.locationLabel,
                  utcOffsetMinutes: place.utcOffsetMinutes,
                  // Testnet-friendly prices: a busy spot stays under a faucet claim of test USDC.
                  baseRateMinor: 300,
                  reserveFloorMinor: 100,
                });
              } catch (err) {
                if (codeOf(err) !== "NAME_TAKEN") throw err;
              }
            }
            if (!screenId) throw new Error("Could not pick a free screen name; add one from the console.");
            await setAudience({ billboardId: screenId, audienceTags: STARTER_AUDIENCE });
            tick(2, `Screen on ${place.locationLabel}`);
          }
        } else if (me.companies.length === 0) {
          let advertiserId;
          let name = "";
          for (let attempt = 0; attempt < 4 && !advertiserId; attempt++) {
            name = randomCompanyName();
            try {
              advertiserId = await createCompany({ name });
            } catch (err) {
              if (codeOf(err) !== "NAME_TAKEN") throw err;
            }
          }
          if (!advertiserId) throw new Error("Could not pick a free company name; try again.");
          tick(1, `Created ${name}`);
          const campaignId = await createCampaign({
            advertiserId,
            brief: `Launch campaign for ${name}: reach founders and engineers near ${place.city}`,
            targetCity: place.city,
            budgetMinor: 5000,
            targetAudience: { startups: 0.6, software: 0.4 },
          });
          tick(2, "Starter campaign ready ($50 budget)");
          // A starter ad so the campaign can play once a host approves it. Uploading and attaching can take
          // a while, so it runs in the background instead of holding up the dashboard.
          void (async () => {
            const asset = await fetch("/demo-creatives/launchkit.svg");
            if (!asset.ok) return;
            const uploadUrl = await generateUploadUrl();
            const res = await fetch(uploadUrl, { method: "POST", headers: { "Content-Type": "image/svg+xml" }, body: await asset.blob() });
            if (!res.ok) return;
            const { storageId } = (await res.json()) as { storageId: Id<"_storage"> };
            await attachCreative({ campaignId, storageId, contentType: "image/svg+xml" });
          })().catch((err) => console.warn("Starter ad upload failed; upload one from Campaigns", err));
          tick(3, "Starter ad uploading in the background");
        }
        // Let the last checkmark land before switching to the dashboard.
        setTimeout(() => finish(onDone), 600);
      } catch (err) {
        setError(errorMessage(err));
      }
    })();
    // Runs once per sign-up; `me` updates as each step lands and must not restart it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const hasHome = role === "host" ? me.workspaces.length > 0 : me.companies.length > 0;
  useEffect(() => {
    // After a manual fallback form succeeds, hand over to the normal dashboard.
    if (error && hasHome) finish(onDone);
  }, [error, hasHome, onDone]);

  if (error) {
    // Fall back to the manual forms so nobody is stuck on a failed automatic setup.
    return (
      <div>
        <p role="alert" className="mx-auto mt-8 max-w-md px-4 text-sm text-danger">
          Automatic setup stopped: {error}
        </p>
        {role === "host" && me.workspaces.length === 0 ? <CreateWorkspace /> : <CreateCompany />}
      </div>
    );
  }

  return (
    <main className="grid min-h-[calc(100dvh-3.5rem)] place-items-center px-4 py-12">
      <section className="fade-in w-full max-w-md rounded-xl border border-line bg-panel p-8" aria-live="polite">
        <h1 className="text-xl font-semibold tracking-tight">
          {role === "host" ? "Setting up your screens" : "Setting up your company"}
        </h1>
        <p className="mt-1 text-sm text-muted">A few seconds. You can rename anything later.</p>
        <ol className="mt-6 flex flex-col gap-3 text-sm">
          {steps.map((s) => (
            <li key={s.label} className="flex items-center gap-3">
              <span
                aria-hidden
                className={`grid h-5 w-5 shrink-0 place-items-center rounded-full border ${
                  s.done ? "border-accent bg-accent text-accent-ink" : "border-line text-faint"
                }`}
              >
                {s.done && <Check size={12} weight="bold" />}
              </span>
              <span className={s.done ? "text-fg" : "text-muted"}>{s.label}</span>
            </li>
          ))}
        </ol>
      </section>
    </main>
  );
}
