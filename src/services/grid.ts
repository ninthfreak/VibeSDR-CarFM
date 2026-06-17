// Maidenhead grid-locator → lat/lon, and great-circle distance.
//
// FT8/FT4 messages carry the transmitter's Maidenhead locator (usually 4 chars,
// sometimes 6). The on-device decoder (local USB hardware + Kiwi via the native
// sidecar) emits that grid in each digital_spot, so we can show distance from the
// receiver to each spot without any server-side enrichment.

/** Decode a 4- or 6-char Maidenhead locator to the centre of its square.
 *  Returns null for anything that isn't a valid locator. */
export function gridToLatLon(grid?: string | null): { lat: number; lon: number } | null {
  if (!grid) return null;
  const g = grid.trim().toUpperCase();
  if (!/^[A-R]{2}[0-9]{2}([A-X]{2})?$/.test(g)) return null;

  // Field (20° lon / 10° lat) + square (2° lon / 1° lat).
  let lon = (g.charCodeAt(0) - 65) * 20 - 180;
  let lat = (g.charCodeAt(1) - 65) * 10 - 90;
  lon += (g.charCodeAt(2) - 48) * 2;
  lat += (g.charCodeAt(3) - 48) * 1;

  if (g.length === 6) {
    // Sub-square (5′ lon / 2.5′ lat); centre within it.
    lon += (g.charCodeAt(4) - 65) * (2 / 24) + (1 / 24);
    lat += (g.charCodeAt(5) - 65) * (1 / 24) + (0.5 / 24);
  } else {
    // Centre of the 2°×1° square.
    lon += 1;
    lat += 0.5;
  }
  return { lat, lon };
}

const R_KM = 6371.0088;
const toRad = (d: number) => (d * Math.PI) / 180;

/** Great-circle distance in km between two lat/lon points. */
export function haversineKm(
  a: { lat: number; lon: number },
  b: { lat: number; lon: number },
): number {
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R_KM * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** Distance (km) from a receiver to a spot's grid, or undefined if either is
 *  missing/invalid. */
export function distanceKmToGrid(
  rx: { lat: number; lon: number } | null,
  grid?: string | null,
): number | undefined {
  if (!rx) return undefined;
  const tx = gridToLatLon(grid);
  if (!tx) return undefined;
  return Math.round(haversineKm(rx, tx));
}
