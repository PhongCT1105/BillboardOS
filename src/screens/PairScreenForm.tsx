import { useState } from "react";
import { useMutation } from "convex/react";
import { api } from "../../convex/_generated/api";
import { ErrorLine, primaryBtn, useAction } from "../customer/ui";

const input = "rounded-md border border-line bg-ink px-3 py-2 text-fg outline-none focus:border-muted";

/**
 * Host: turn a device into a screen. Open #/screen on the device, then type
 * the code it shows here with the screen's name, place and floor price.
 */
export function PairScreenForm({ onDone }: { onDone?: () => void }) {
  const claim = useMutation(api.devices.claim);
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [city, setCity] = useState("");
  const [place, setPlace] = useState("");
  const [floor, setFloor] = useState("0.05");
  const action = useAction();
  const screenUrl = `${window.location.origin}${window.location.pathname}#/screen`;
  const floorMinor = Math.round(Number.parseFloat(floor) * 100);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const id = await action.run(() => claim({ code, name, city, locationLabel: place, floorMinor }));
    if (id) {
      setCode("");
      setName("");
      onDone?.();
    }
  }

  return (
    <form className="flex max-w-xl flex-col gap-4 rounded-lg border border-line bg-panel p-5" onSubmit={submit}>
      <div>
        <h2 className="text-lg font-semibold">Add a screen</h2>
        <p className="mt-1 text-sm text-muted">
          Each screen is one real device. On the device, open <span className="font-mono text-fg break-all">{screenUrl}</span>, then type the code it shows.
        </p>
      </div>
      <label className="flex flex-col gap-2 text-sm">
        <span className="text-muted">Pairing code</span>
        <input
          required
          value={code}
          onChange={(e) => setCode(e.target.value.toUpperCase())}
          placeholder="ABC123"
          autoCapitalize="characters"
          className={`${input} font-mono tracking-[0.2em]`}
        />
      </label>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <label className="flex flex-col gap-2 text-sm">
          <span className="text-muted">Screen name</span>
          <input required value={name} onChange={(e) => setName(e.target.value)} placeholder="Lobby screen" className={input} />
        </label>
        <label className="flex flex-col gap-2 text-sm">
          <span className="text-muted">City</span>
          <input required value={city} onChange={(e) => setCity(e.target.value)} placeholder="San Francisco" className={input} />
        </label>
      </div>
      <label className="flex flex-col gap-2 text-sm">
        <span className="text-muted">Where it is (the audience agent reads this)</span>
        <input required value={place} onChange={(e) => setPlace(e.target.value)} placeholder="Moscone Center West, 800 Howard St" className={input} />
      </label>
      <label className="flex flex-col gap-2 text-sm sm:max-w-[50%]">
        <span className="text-muted">Never sell a spot below (USD)</span>
        <input inputMode="decimal" value={floor} onChange={(e) => setFloor(e.target.value)} className={`${input} font-mono`} />
      </label>
      <ErrorLine error={action.error} />
      <button
        type="submit"
        disabled={action.busy || !code.trim() || !name.trim() || !city.trim() || !place.trim() || !(floorMinor > 0)}
        className={`${primaryBtn} self-start`}
      >
        {action.busy ? "Pairing…" : "Add screen"}
      </button>
    </form>
  );
}
