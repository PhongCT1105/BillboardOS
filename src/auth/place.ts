/**
 * Where the browser is, without asking: the IANA timezone names a nearby city.
 * Hosts can rename the workspace and screen later in Workspace settings.
 */
export type Place = { city: string; locationLabel: string; utcOffsetMinutes: number };

const KNOWN: Record<string, { city: string; locationLabel: string }> = {
  "America/Los_Angeles": { city: "San Francisco", locationLabel: "Howard St at Moscone Center" },
  "America/New_York": { city: "New York", locationLabel: "7th Ave at Times Square" },
  "America/Chicago": { city: "Chicago", locationLabel: "Michigan Ave at Randolph St" },
  "America/Denver": { city: "Denver", locationLabel: "16th Street Mall" },
  "America/Phoenix": { city: "Phoenix", locationLabel: "Downtown Phoenix" },
  "America/Toronto": { city: "Toronto", locationLabel: "Yonge-Dundas Square" },
  "America/Vancouver": { city: "Vancouver", locationLabel: "Granville St" },
  "Europe/London": { city: "London", locationLabel: "Piccadilly Circus" },
  "Europe/Berlin": { city: "Berlin", locationLabel: "Alexanderplatz" },
  "Asia/Tokyo": { city: "Tokyo", locationLabel: "Shibuya Crossing" },
  "Asia/Singapore": { city: "Singapore", locationLabel: "Orchard Road" },
  "Asia/Ho_Chi_Minh": { city: "Ho Chi Minh City", locationLabel: "Nguyen Hue Walking Street" },
  "Asia/Saigon": { city: "Ho Chi Minh City", locationLabel: "Nguyen Hue Walking Street" },
};

export function detectPlace(): Place {
  const utcOffsetMinutes = -new Date().getTimezoneOffset();
  let tz = "";
  try {
    tz = Intl.DateTimeFormat().resolvedOptions().timeZone ?? "";
  } catch {
    // Very old browsers: fall through to the default.
  }
  const known = KNOWN[tz];
  if (known) return { ...known, utcOffsetMinutes };
  const fromZone = tz.split("/").pop()?.replaceAll("_", " ");
  const city = fromZone && fromZone.length <= 40 ? fromZone : "San Francisco";
  return { city, locationLabel: `Downtown ${city}`, utcOffsetMinutes };
}

const ADJECTIVES = ["Golden", "Bright", "Northbeam", "Signal", "Harbor", "Crosswalk", "Neon", "Summit", "Bayside", "Lumen"];
const HOST_NOUNS = ["Screens", "Media", "Displays", "Outdoor", "Billboards"];
const COMPANY_NOUNS = ["Labs", "Coffee", "Studio", "Robotics", "Cloud", "Apparel", "Health"];

function pick<T>(list: readonly T[]): T {
  return list[Math.floor(Math.random() * list.length)];
}

function suffix(): string {
  return Math.floor(100 + Math.random() * 900).toString();
}

/** e.g. "Bayside Media 482". The number keeps names unique across demo runs. */
export function randomHostName(): string {
  return `${pick(ADJECTIVES)} ${pick(HOST_NOUNS)} ${suffix()}`;
}

export function randomCompanyName(): string {
  return `${pick(ADJECTIVES)} ${pick(COMPANY_NOUNS)} ${suffix()}`;
}

/** Screen names are unique across the platform, so the starter screen gets a number too. */
export function randomScreenName(city: string): string {
  return `${city} street screen ${suffix()}`;
}
