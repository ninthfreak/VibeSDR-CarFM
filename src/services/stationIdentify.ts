/**
 * The pure half of identifyByPi — every rule that decides whether a decoded PI
 * may name the station, with the two database reads passed in rather than done
 * here.
 *
 * Split out of stationFinder so it can be reached without expo-sqlite: it is the
 * reference the Rust port (core/stations/src/identify.rs) is diffed against by
 * `npm run test:stations-diff`, and the rules below are the ones that cost drive
 * logs to find, so drift between the two would be expensive and silent.
 *
 * The lookups stay lazy — `atFrequency` is only called when a frequency clash
 * needs salvaging — and the enrichment side effect (noteEncountered) stays with
 * the caller, because it is not identification.
 */

import { piToCallsign, callsignBase, piLowBitsCandidates } from './piCallsign';

import type { StationIdentity, StationRow } from './stationTypes';

/** The two row lookups identification needs. */
export interface StationSource {
  forCallsignBase(base: string): Promise<StationRow[]>;
  /** FULL-POWER stations only — the formula does not apply to translators. */
  atFrequency(mhz: number): Promise<StationRow[]>;
}

/** Dial-vs-DB tolerance. The FM raster is 0.2 MHz in North America, so half a
 *  0.1 MHz step is loose enough for rounding and far tighter than any channel. */
export const FREQ_EPS = 0.05;

/** Prefer full-power, then LPFM, then a translator. Stable: among equals the
 *  input order decides. */
export function bestStation(rows: readonly StationRow[]): StationRow | null {
  if (rows.length === 0) return null;
  const order: Record<string, number> = { FM: 0, FL: 1, FX: 2 };
  return [...rows].sort((a, b) => (order[a.service] ?? 9) - (order[b.service] ?? 9))[0];
}

/**
 * Look for the station the dial says we are on, when the PI says otherwise.
 *
 * Only called after a PI decoded cleanly to a callsign that the DB places on a
 * DIFFERENT frequency — the state that says the top nibble is wrong rather than
 * the whole code. Refuses on 0 or 2+ candidates; see piLowBitsCandidates for why
 * a single hit is trustworthy.
 */
async function salvageByLowBits(
  pi: number, freqMhz: number, src: StationSource,
): Promise<StationRow | null> {
  const onDial = await src.atFrequency(freqMhz);
  const bases = piLowBitsCandidates(pi, onDial);
  if (bases.length !== 1) return null;
  return bestStation(onDial.filter((r) => r.callsignBase === bases[0]));
}

/**
 * Identify the live station from its RDS PI. Pass the tuned frequency whenever
 * it is known — it is what stops a mis-encoded PI from renaming the station.
 */
export async function identifyFromSource(
  pi: number, psText: string | undefined, freqMhz: number | undefined, src: StationSource,
): Promise<StationIdentity> {
  const dec = piToCallsign(pi);
  if (!dec.callsign) return { pi, callsign: null, confident: false, station: null, note: dec.note };

  let callsign = dec.callsign;
  let base = callsignBase(callsign);
  const rows = await src.forCallsignBase(base);
  let station = bestStation(rows);

  // NO DB ROW MEANS NO STATION. The formula turns any 16 bits in the K/W range
  // into four plausible letters, so "it decoded" is not evidence that anything is
  // out there. On 2026-08-04 a corrupt block A on WERN read 0xA6FF as 0x57FF,
  // which the formula renders as WBGX — a callsign absent from the entire FCC
  // table. The old code marked it not-confident and returned it anyway, and the
  // hero dropped WERN's logo to show it.
  if (station == null) {
    return { pi, callsign: null, confident: false, station: null, note: 'no DB match for computed callsign' };
  }

  let confident = dec.confident && station.service === 'FM';
  let note = dec.note;
  if (station.service !== 'FM') note = `matched a ${station.service} (formula unreliable for translators)`;

  // ── THE DIAL OUTRANKS THE PI ────────────────────────────────────────────────
  // A PI that decodes to a real station on a different frequency is not this
  // station, however clean the decode looks. Without this check WIBA-FM 101.5
  // renamed itself "KDTI · Rochester Hills" every time PI consensus landed, and
  // queued that station's logo — the decode was correct, the transmitted code
  // was not. See PI_LOW_MASK for the encoder fault and the two stations it hit.
  //
  // This is deliberately the one identity path that survives a head unit with no
  // GPS fix, which is exactly when nothing else can contradict a bad PI.
  if (typeof freqMhz === 'number' && freqMhz > 0
      && Math.abs(station.frequencyMhz - freqMhz) > FREQ_EPS) {
    const clash = `${callsign} is ${station.frequencyMhz} MHz, dial is ${freqMhz}`;
    const salvaged = await salvageByLowBits(pi, freqMhz, src);
    if (!salvaged) {
      return { pi, callsign: null, confident: false, station: null, note: `${clash} — PI rejected` };
    }
    // The BASE, not the row's `callsign`: the formula path returns a bare
    // four-letter form ('WOLX' for a row reading 'WOLX-FM'), and the hero renders
    // whatever this is verbatim, so the two paths must agree on the shape.
    callsign = salvaged.callsignBase;
    base = salvaged.callsignBase;
    station = salvaged;
    confident = salvaged.service === 'FM';
    note = `${clash}; low 12 bits match ${salvaged.callsign} on the dial`;
  }

  if (psText) {
    const other = psText.toUpperCase().match(/\b([KW][A-Z]{3})\b/);
    if (other && other[1] !== base) { confident = false; note = `PS text names ${other[1]}, not ${callsign}`; }
  }

  return { pi, callsign, confident, station, note };
}
