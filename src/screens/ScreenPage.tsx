import { useCallback, useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { PlayerPage } from "../player/PlayerPage";
import { errorMessage } from "../lib/format";

/**
 * #/screen: this device becomes one screen. It keeps a random key in this
 * browser, shows a pairing code until a host claims it in "Add a screen",
 * then plays its screen and sends a heartbeat every 10 s (that is what
 * "online" means). `?camera=1` also runs the person detector in a small
 * window and sends how many people are in view with each heartbeat.
 */

const STORE = "billboardos.device";
const HEARTBEAT_MS = 10_000;

type Saved = { deviceId: Id<"screenDevices">; deviceKey: string };

function load(): Saved | null {
  try {
    const raw = localStorage.getItem(STORE);
    return raw ? (JSON.parse(raw) as Saved) : null;
  } catch {
    return null;
  }
}

function randomKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Where the browser is, if it allows it (asked once; never required). */
function position(): Promise<{ latitude: number; longitude: number } | null> {
  return new Promise((resolve) => {
    if (!navigator.geolocation) return resolve(null);
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ latitude: p.coords.latitude, longitude: p.coords.longitude }),
      () => resolve(null),
      { timeout: 8_000, maximumAge: 10 * 60_000 },
    );
  });
}

export function ScreenPage({ camera }: { camera: boolean }) {
  const register = useMutation(api.devices.register);
  const heartbeat = useMutation(api.devices.heartbeat);
  const [device, setDevice] = useState<Saved | null>(null);
  const [error, setError] = useState<string | null>(null);
  const status = useQuery(api.devices.status, device ? { deviceId: device.deviceId } : "skip");
  const people = useRef<number | null>(null);
  const onPeople = useCallback((n: number) => {
    people.current = n;
  }, []);

  // Register (or refresh the code of) this device once.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const saved = load();
        const deviceKey = saved?.deviceKey ?? randomKey();
        const where = await position();
        const { deviceId } = await register({
          deviceId: saved?.deviceId,
          deviceKey,
          utcOffsetMinutes: -new Date().getTimezoneOffset(),
          ...(where ?? {}),
        });
        const next = { deviceId, deviceKey };
        try {
          localStorage.setItem(STORE, JSON.stringify(next));
        } catch {
          // Private mode: the device pairs for this session only.
        }
        if (!cancelled) setDevice(next);
      } catch (err) {
        // A stale saved device (e.g. a reset backend): start over as a new device.
        try {
          localStorage.removeItem(STORE);
        } catch {
          // ignore
        }
        if (!cancelled) setError(errorMessage(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [register]);

  // Heartbeat while this page is open.
  useEffect(() => {
    if (!device) return;
    const beat = () => void heartbeat({ ...device, ...(people.current !== null ? { peopleInView: people.current } : {}) }).catch(() => undefined);
    beat();
    const timer = setInterval(beat, HEARTBEAT_MS);
    return () => clearInterval(timer);
  }, [device, heartbeat]);

  if (status?.billboardId) return <PlayerPage billboardId={status.billboardId} camera={camera} onPeople={onPeople} />;

  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-8 bg-ink px-4 text-center text-fg">
      <p className="text-sm tracking-[0.3em] text-muted uppercase">BillboardOS screen</p>
      {error ? (
        <p role="alert" className="max-w-md text-danger">
          {error}. Reload this page to try again.
        </p>
      ) : status?.pairingCode ? (
        <>
          <p className="tabular font-mono text-[clamp(3.5rem,14vw,10rem)] leading-none font-semibold tracking-[0.15em]">
            {status.pairingCode}
          </p>
          <p className="max-w-lg text-[clamp(1rem,2vw,1.4rem)] text-muted">
            On your host dashboard, choose <strong className="text-fg">Add a screen</strong> and type this code. This device then becomes that screen.
          </p>
        </>
      ) : (
        <p className="text-muted">Getting a pairing code…</p>
      )}
    </main>
  );
}
