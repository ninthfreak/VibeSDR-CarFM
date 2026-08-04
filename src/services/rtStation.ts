/**
 * Trim a station's own identifier off its RadioText.
 *
 * WIBA-FM sends `101.5 IBA-FM - Walk This Way - Aerosmith`. The hero already
 * shows which station is tuned, in large type, so the first eleven characters of
 * the plate are spent repeating it — on the one line where horizontal space is
 * scarcest and the interesting content sits furthest right.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO: split artist from title. The station's own
 * metadata does not distinguish them. From one hour of one drive, 2026-08-04:
 *
 *   101.5 IBA-FM - Whole Lotta Love - Led Zeppelin     title, then artist
 *   101.5 IBA-FM - Walk This Way - Aerosmith           title, then artist
 *   101.5 IBA-FM - What It Takes - Aerosmith           title, then artist
 *   101.5 IBA-FM - Led Zeppelin - Kashmir              ARTIST, then title
 *
 * Same station, same artist, both orders. Any rule that labelled one side
 * "artist" would be right most of the time and confidently wrong the rest, which
 * is worse than showing the pair unlabelled. The face has rtArtist/rtTitle for
 * genuine RT+ and this does not pretend to fill them.
 *
 * Only the ENDS are trimmed, and only segments positively identified as the
 * station. Everything else — adverts, slogans, prose — passes through untouched.
 */

/** Uppercase, alphanumerics only: "101.5 IBA-FM" → "1015IBAFM". */
function squash(s: string): string {
  return s.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/**
 * Is this segment the station naming itself?
 *
 * Matched on the dial frequency and the callsign ONLY. Not on the PS, which
 * would be catastrophic here: WIBA scrolls song titles through PS, so a PS of
 * "Walk" would have made this strip "Walk This Way" out of its own RadioText.
 */
function isStationSegment(seg: string, freqToken: string, callToken: string): boolean {
  const s = squash(seg);
  if (!s) return false;
  if (freqToken && s.includes(freqToken)) return true;
  if (callToken && s.includes(callToken)) return true;
  return false;
}

export function stripStationFromRt(
  rt: string | null | undefined,
  opts: { mhz?: number | null; callsign?: string | null } = {},
): string {
  const text = (rt ?? '').trim();
  if (!text) return '';

  // "101.5" → "1015". The station writes its own frequency the same way it is
  // displayed, so this matches without needing to know the format.
  const freqToken = typeof opts.mhz === 'number' && opts.mhz > 0
    ? squash(opts.mhz.toFixed(1)) : '';
  const callToken = squash(opts.callsign ?? '');
  if (!freqToken && !callToken) return text;

  // Split on a SPACED hyphen only. "IBA-FM" must survive as one segment, and it
  // does: its hyphen has no surrounding whitespace.
  const parts = text.split(/\s+-\s+/);
  if (parts.length < 2) return text;   // nothing to trim from

  let lo = 0;
  let hi = parts.length - 1;
  while (lo <= hi && isStationSegment(parts[lo], freqToken, callToken)) lo++;
  while (hi >= lo && isStationSegment(parts[hi], freqToken, callToken)) hi--;

  // The whole message was the station's name — a legitimate thing to broadcast,
  // so show it rather than blanking the plate.
  if (lo > hi) return text;
  if (lo === 0 && hi === parts.length - 1) return text;   // nothing trimmed

  return parts.slice(lo, hi + 1).join(' - ').trim();
}
