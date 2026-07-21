/**
 * Station brand logo. A real image from the stations DB when we have one — rendered
 * FIT (`object-fit: contain`): never cropped, never overflowing, centered in a
 * fixed-geometry plate — else a colored monogram cube. Real logos are assigned only
 * via the preset logo-search window (LogoSearchOverlay); on save it calls
 * invalidateLogoTile(base) so every mounted tile re-reads the DB and swaps the art.
 *
 * The surfaces (hero / preset tile / peek card) branch their WHOLE layout on whether
 * a real logo exists, so the resolution lives in a shared `useStationLogo` hook.
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

/** Resolve a station's callsign base + logo data-URI. Shared by LogoTile and the
 *  surfaces that must branch their layout on `hasLogo` (hero replaces the call
 *  sign with the logo; tiles/peek hide their text). */
export function useStationLogo(name?: string, freqMhz?: number): {
  base: string | null; uri: string | null; hasLogo: boolean;
} {
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

  return { base, uri, hasLogo: !!uri };
}

export default function LogoTile({ name, freqMhz, size, w, h, radius, plateBg, showMonogram = true }: {
  name?: string;          // station name / callsign-ish string
  freqMhz?: number;       // dial frequency — resolves the callsign when `name` isn't one
  size?: number;          // square box (back-compat) — or pass w/h for a non-square plate
  w?: number;
  h?: number;
  radius?: number;
  plateBg?: string;       // plate colour behind a real logo (default transparent; hero uses white)
  showMonogram?: boolean; // false → render an empty box when no real logo (hero shows none)
}) {
  const { base, uri } = useStationLogo(name, freqMhz);
  const boxW = w ?? size ?? 0;
  const boxH = h ?? size ?? boxW;
  const r = radius ?? Math.round((size ?? boxW) * 0.22);

  // Real logo: FIT inside a fixed-geometry plate. The plate owns the size; the
  // image is 100%×100% with contain INSIDE it — that separation is what prevents
  // overflow for any aspect ratio (wide wordmark, square badge, tall lockup).
  if (uri) {
    return (
      <View style={{
        width: boxW, height: boxH, borderRadius: r,
        backgroundColor: plateBg ?? 'transparent', overflow: 'hidden',
        alignItems: 'center', justifyContent: 'center',
      }}>
        <Image source={{ uri }} style={{ width: '100%', height: '100%' }} resizeMode="contain" />
      </View>
    );
  }

  // No real logo: monogram cube (or an empty box where the caller suppresses it).
  if (!showMonogram) return <View style={{ width: boxW, height: boxH }} />;
  const label = base ? monogram(base) : (name?.trim().slice(0, 4).toUpperCase() || '·');
  return (
    <View style={{
      width: boxW, height: boxH, borderRadius: r,
      backgroundColor: brandColor(base ?? label),
      alignItems: 'center', justifyContent: 'center',
    }}>
      <Text
        allowFontScaling={false}
        numberOfLines={1}
        style={{
          color: '#FFFFFF', fontFamily: FONT_BOLD,
          fontSize: Math.round((size ?? Math.min(boxW, boxH)) * (label.length > 3 ? 0.26 : 0.34)),
        }}
      >
        {label}
      </Text>
    </View>
  );
}
