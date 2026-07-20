/**
 * Station brand tile: the real logo from the stations DB when we have one,
 * else a colored monogram (design: "colored monogram tiles… real brand art
 * would replace these later"). Lookup is lazy and cached per callsign base.
 *
 * Logos are assigned through the preset-reorder logo-search window (see
 * LogoSearchOverlay) — that is the one and only way. When it saves a logo,
 * it calls invalidateLogoTile(base) so every mounted tile for that station
 * re-reads the DB and swaps the monogram for the art.
 */
import React, { useEffect, useState } from 'react';
import { Image, Text, View } from 'react-native';

import { getStationLogo, callsignForFreq } from '../../services/stationFinder';
import { callsignBase } from '../../services/piCallsign';
import { brandColor, monogram, FONT_BOLD } from './tokens';

const cache = new Map<string, string | null>();
const listeners = new Set<() => void>();

/** Extract a plausible callsign base ("WJJO-FM" / "94.1 WJJO" → "WJJO"). */
export function callsignFrom(name?: string): string | null {
  if (!name) return null;
  const m = name.toUpperCase().match(/\b([KW][A-Z]{2,3})(?:-FM)?\b/);
  return m ? m[1] : null;
}

/** Drop a station's cached logo (or all) and re-read every mounted tile. Called
 *  after the logo-search window assigns a new logo. */
export function invalidateLogoTile(base?: string): void {
  if (base) cache.delete(base.toUpperCase());
  else cache.clear();
  listeners.forEach((l) => l());
}

export default function LogoTile({ name, freqMhz, size, radius }: {
  name?: string;          // station name / callsign-ish string
  freqMhz?: number;       // dial frequency — resolves the callsign when `name` isn't one
  size: number;
  radius?: number;
}) {
  const nameBase = callsignFrom(name) ? callsignBase(callsignFrom(name)!) : null;
  const [base, setBase] = useState<string | null>(nameBase);
  const [uri, setUri] = useState<string | null>(nameBase ? cache.get(nameBase) ?? null : null);
  const [tick, setTick] = useState(0);

  // Re-read when invalidateLogoTile() fires (a new logo was just assigned).
  useEffect(() => {
    const l = () => setTick((n) => n + 1);
    listeners.add(l);
    return () => { listeners.delete(l); };
  }, []);

  // Identity is the callsign: from `name` if it carries one, else resolved from
  // the dial frequency via the FCC DB (a bare "FM 88.7" preset name has none).
  useEffect(() => {
    let cancelled = false;
    if (nameBase) { setBase(nameBase); return; }
    callsignForFreq(freqMhz).then((b) => { if (!cancelled) setBase(b); }).catch(() => {});
    return () => { cancelled = true; };
  }, [nameBase, freqMhz]);

  useEffect(() => {
    let cancelled = false;
    if (!base) { setUri(null); return; }
    if (cache.has(base)) { setUri(cache.get(base)!); return; }
    getStationLogo(base)
      .then((u) => { cache.set(base, u); if (!cancelled) setUri(u); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [base, tick]);

  const r = radius ?? Math.round(size * 0.22);
  const label = base ? monogram(base) : (name?.trim().slice(0, 4).toUpperCase() || '·');
  if (uri) {
    return <Image source={{ uri }} style={{ width: size, height: size, borderRadius: r }} resizeMode="cover" />;
  }
  return (
    <View style={{
      width: size, height: size, borderRadius: r,
      backgroundColor: brandColor(base ?? label),
      alignItems: 'center', justifyContent: 'center',
    }}>
      <Text
        allowFontScaling={false}
        numberOfLines={1}
        style={{
          color: '#FFFFFF', fontFamily: FONT_BOLD,
          fontSize: Math.round(size * (label.length > 3 ? 0.26 : 0.34)),
        }}
      >
        {label}
      </Text>
    </View>
  );
}
