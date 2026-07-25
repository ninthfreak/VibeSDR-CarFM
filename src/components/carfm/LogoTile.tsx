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
import { getStationPrefs, getDarkLogo } from '../../services/stationDb';
import { regenerateDarkLogo } from '../../services/logoDark/regenerate';
import { callsignBase } from '../../services/piCallsign';
import { brandColor, cleanCall, monogram, FONT_BOLD, DARK, LOGO_DARK_BG, type CarFmPalette } from './tokens';

const cache = new Map<string, string | null>();
const darkCache = new Map<string, { uri: string; treatment: string } | null>();
const regenTried = new Set<string>();   // one lazy regen attempt per (base|bg) per session
const listeners = new Set<() => void>();
const dispListeners = new Set<() => void>();

/** Extract a plausible callsign base ("WJJO-FM" / "94.1 WJJO" → "WJJO"). */
export function callsignFrom(name?: string): string | null {
  if (!name) return null;
  const m = name.toUpperCase().match(/\b([KW][A-Z]{2,3})(?:-FM)?\b/);
  return m ? m[1] : null;
}

/** Drop a station's cached logo (or all) and re-read every mounted tile. Called
 *  after the logo-search window assigns a new logo. */
export function invalidateLogoTile(base?: string): void {
  if (base) {
    const b = base.toUpperCase();
    cache.delete(b);
    darkCache.delete(b);
  } else { cache.clear(); darkCache.clear(); }
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

/** The cached dark-mode variant for a station, or nulls. Pass `active` = true
 *  only when the dark theme is showing AND the station has a logo (light mode →
 *  no lookup). The stored PNG is background-independent (paper is transparent),
 *  so this needs no bg. Re-reads when invalidateLogoTile() fires. The returned
 *  `uri` is a transparent-background PNG (remap/halo/as-is) or the keyed logo for
 *  `PLATE`; `treatment` is the enum so the caller knows whether to add a plate. */
export function useDarkLogo(base: string | null, active: boolean): { uri: string | null; treatment: string | null } {
  const key = base && active ? base.toUpperCase() : null;
  const [v, setV] = useState<{ uri: string; treatment: string } | null>(key ? darkCache.get(key) ?? null : null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const l = () => setTick((n) => n + 1);
    listeners.add(l);
    return () => { listeners.delete(l); };
  }, []);
  useEffect(() => {
    let cancelled = false;
    if (!base || !active || !key) { setV(null); return; }
    if (darkCache.has(key)) { setV(darkCache.get(key)!); return; }
    getDarkLogo(base)
      .then((d) => {
        const val = d ? { uri: d.dataUri, treatment: d.treatment } : null;
        darkCache.set(key, val);
        if (!cancelled) setV(val);
        // No variant yet for a station that HAS a logo (active only when a logo
        // exists) → adapt once in the background (gate bg = the canonical dark
        // surface), then re-read. Guarded so a decode failure doesn't loop.
        if (!d && !regenTried.has(key)) {
          regenTried.add(key);
          regenerateDarkLogo(base, LOGO_DARK_BG).then(() => { darkCache.delete(key); invalidateLogoTile(base); }).catch(() => {});
        }
      })
      .catch(() => {});
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base, active, tick]);
  return { uri: v?.uri ?? null, treatment: v?.treatment ?? null };
}

/** Render a real logo image inside a fixed-geometry plate, choosing the light or
 *  dark-adapted source and the right backing:
 *   • light mode → the original logo on `plateBg` (default transparent).
 *   • dark mode + a cached variant → the adapted PNG; a grey rounded PLATE only
 *     for the PLATE treatment, otherwise transparent (remap/halo/as-is carry
 *     their own readability).
 *   • dark mode + no variant yet → the original on `darkFallbackBg` (a light
 *     plate) so a not-yet-adapted dark logo doesn't vanish.
 *  `dark` is whether the dark theme is active; `darkVariant` comes from
 *  useDarkLogo(); pass both so this stays a pure presentational helper. */
export function LogoImage({ uri, dark, darkVariant, w, h, radius, plateBg, darkFallbackBg = '#FFFFFF' }: {
  uri: string;
  dark: boolean;
  darkVariant: { uri: string | null; treatment: string | null };
  w: number; h: number; radius: number;
  plateBg?: string;
  darkFallbackBg?: string;
}) {
  let src = uri;
  let bg = plateBg ?? 'transparent';
  let pad = 0;
  if (dark) {
    if (darkVariant.uri) {
      src = darkVariant.uri;
      if (darkVariant.treatment === 'PLATE') { bg = '#E6E6E6'; pad = Math.round(Math.max(w, h) * 0.09); }
      else bg = 'transparent';                       // remap/halo/as-is read on the dark surface directly
    } else {
      bg = darkFallbackBg;                            // not adapted yet → keep it visible on a light plate
    }
  }
  const plateRadius = dark && darkVariant.treatment === 'PLATE' ? Math.round(Math.min(w, h) * 0.14) : radius;
  return (
    <View style={{ width: w, height: h, borderRadius: plateRadius, backgroundColor: bg, overflow: 'hidden', alignItems: 'center', justifyContent: 'center', padding: pad }}>
      <Image source={{ uri: src }} style={{ width: '100%', height: '100%' }} resizeMode="contain" />
    </View>
  );
}

/** Notify every mounted hero that a station's Display Call Sign / Frequency
 *  choices changed (called by the logo window on save). */
export function invalidateStationDisplay(): void { dispListeners.forEach((l) => l()); }

/** Per-station hero display flags (Display Call Sign / Display Frequency, §6.4).
 *  Default depends on whether the station has a real logo (v1.9.0): a logo hero
 *  defaults BOTH OFF (logo-only), a no-logo hero defaults BOTH ON (call sign +
 *  frequency). An explicit per-station choice from the logo window overrides the
 *  default. Re-reads when invalidateStationDisplay() fires. */
export function useStationDisplay(base: string | null, hasLogo: boolean): { showCall: boolean; showFreq: boolean } {
  const dflt = hasLogo ? { showCall: false, showFreq: false } : { showCall: true, showFreq: true };
  const [prefs, setPrefs] = useState<{ showCall: boolean; showFreq: boolean }>(dflt);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const l = () => setTick((n) => n + 1);
    dispListeners.add(l);
    return () => { dispListeners.delete(l); };
  }, []);
  useEffect(() => {
    let cancelled = false;
    if (!base) { setPrefs(dflt); return; }
    // getStationPrefs → null when the user hasn't set an explicit choice; fall
    // back to the logo-dependent default in that case.
    getStationPrefs(base).then((p) => { if (!cancelled) setPrefs(p ?? dflt); }).catch(() => {});
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base, tick, hasLogo]);
  return prefs;
}

/** The 4-core-call-letter box (station-color fill, white letters) that stands in
 *  for a real logo on preset tiles + peek cards when no logo exists (§4.3/§4.5).
 *  A WIDE / landscape box in the same aspect as the real-logo plate; the caller
 *  (PresetPlate) renders the frequency BENEATH it — never inside, never repeated. */
export function CallSignBox({ label, colorKey, w, h, radius }: {
  label: string; colorKey: string; w: number; h: number; radius: number;
}) {
  const letters = label || '·';
  // Fit the (up to 4) letters inside the landscape box: bounded by height and by
  // width/letter-count so 4 letters don't overflow a narrow box.
  const fs = Math.max(11, Math.round(Math.min(h * 0.52, (w * 0.82) / Math.max(letters.length, 1) * 1.55)));
  return (
    <View style={{
      width: w, height: h, borderRadius: radius, overflow: 'hidden',
      backgroundColor: brandColor(colorKey), alignItems: 'center', justifyContent: 'center',
    }}>
      <Text
        allowFontScaling={false}
        numberOfLines={1}
        style={{ color: '#FFFFFF', fontFamily: FONT_BOLD, fontSize: fs, letterSpacing: 0.5 }}
      >
        {letters}
      </Text>
    </View>
  );
}

/** Shared preset/peek identity block (§4.3/§4.5/§5): a real logo image when one
 *  exists (borderless, Fit — the logo carries the identity, no text) OR a wide
 *  colored call-sign box with the frequency BENEATH it in full text color +
 *  heavier weight. Preset tiles and prev/next peek cards render EXACTLY this. */
export function PresetPlate({ name, freqMhz, w, h, radius, pal, freqSize }: {
  name?: string;
  freqMhz?: number;
  w: number;              // plate width (landscape box / logo plate)
  h: number;              // plate height
  radius: number;
  pal: CarFmPalette;
  freqSize: number;       // frequency font size (rendered only in the no-logo case)
}) {
  const { base, uri } = useStationLogo(name, freqMhz);
  const dark = pal === DARK;
  const darkVariant = useDarkLogo(base, dark && !!uri);
  if (uri) {
    // Real logo: Fit, borderless in light mode / dark-adapted in dark mode.
    return <LogoImage uri={uri} dark={dark} darkVariant={darkVariant} w={w} h={h} radius={radius} />;
  }
  // No logo: call letters inside the box, frequency beneath it.
  const label = base ? cleanCall(base) : (cleanCall(name).slice(0, 4) || name?.trim().slice(0, 4).toUpperCase() || '·');
  return (
    <View style={{ alignItems: 'center', gap: Math.max(3, Math.round(freqSize * 0.34)) }}>
      <CallSignBox label={label} colorKey={base ?? label} w={w} h={h} radius={radius} />
      {freqMhz != null ? (
        <Text
          allowFontScaling={false}
          numberOfLines={1}
          style={{
            color: pal.text, fontFamily: FONT_BOLD, fontSize: freqSize,
            fontVariant: ['tabular-nums'], letterSpacing: 0.3,
          }}
        >
          {freqMhz.toFixed(1)}
        </Text>
      ) : null}
    </View>
  );
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
