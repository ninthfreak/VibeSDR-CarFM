/**
 * CarFmFace — the FM radio face for the CarFM fork, built to the Claude Design
 * handoff (design_handoff_fm_radio_face): header pills, hero band (logo tile +
 * call letters + star + amber frequency + RadioText strip), SEEK/PREV/NEXT side
 * columns, presets band with reorder mode + custom scrollbar + NEARBY disc,
 * plus the direct-entry numpad and Nearby picker modals.
 *
 * Renders as a full-screen opaque layer OVER the existing SDR pipeline (spec §4):
 * SDRScreen keeps doing all the connect / audio / RDS work; this presents the
 * tuner and calls back. Readable at a glance, in a moving car, in sunlight.
 *
 * Accessibility (spec §6): no state is encoded red-vs-green — amber/blue/neutral
 * only, and colour only ever reinforces a label/shape/position.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Animated, Easing, Pressable, StyleSheet, Text, View, useColorScheme,
  type LayoutChangeEvent,
} from 'react-native';
import { useKeepAwake } from 'expo-keep-awake';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { getNearbyStations } from '../services/stationFinder';
import type { NearbyStation } from '../services/stationTypes';
import { GearIcon, MagnifierTower, SignalWaves, StarIcon, StereoWave, WarningTriangle } from './carfm/icons';
import LogoTile from './carfm/LogoTile';
import NearbyPicker from './carfm/NearbyPicker';
import Numpad from './carfm/Numpad';
import PresetsBand, { type PresetItem } from './carfm/PresetsBand';
import SidePresetCard, { PEEK_OPACITY, PEEK_SCALE } from './carfm/SidePresetCard';
import SettingsPanel, { type CarFmTheme } from './carfm/SettingsPanel';
import { DARK, FM_MAX_MHZ, FM_MIN_MHZ, FONT, LIGHT } from './carfm/tokens';

export interface CarFmPreset {
  name: string;
  frequency: number;   // Hz
}

export interface CarFmFaceProps {
  freqHz: number;
  stationName?: string;     // RDS PS
  callsignHint?: string;    // PI-derived callsign (·city), shown only when PS absent
  radioText?: string;       // RDS RT
  stereo: boolean;
  signalDb: number | null;
  /** RDS decoder has a lock (PI/PS seen) — drives the RDS tell. */
  rdsOk?: boolean;
  /** RDS Traffic Programme flag. */
  tp?: boolean;
  /** RDS Traffic Announcement in progress (pulses amber). */
  ta?: boolean;
  /** Station transmits an AF list. */
  af?: boolean;
  /** Programme-type label ("Rock", …) — already region-decoded. */
  ptyText?: string;
  /** No compatible tuner session (dongle absent/failed) — replaces the whole
   *  header status cluster with the error pill (design addendum). */
  tunerError?: boolean;
  /** Theme override from settings ('system' follows the OS). */
  theme?: CarFmTheme;
  /** Start-radio-on-boot setting (shown/edited in the settings panel). */
  autostart?: boolean;
  onSetAutostart?: (on: boolean) => void;
  onSetTheme?: (t: CarFmTheme) => void;
  /** Immediate tuner reconnect attempt (tunerless sessions). */
  onRetryTuner?: () => void;
  presets: CarFmPreset[];   // displayed order (user-arranged)
  onTuneHz: (hz: number) => void;
  onToggleSave: () => void;              // star: save/remove current frequency
  onReorderPreset: (index: number, dir: 1 | -1) => void;
  onRemovePreset: (index: number) => void;
  onSaveStationPreset: (name: string, freqMhz: number) => void;  // nearby hold
  onOpenAdvanced: () => void;
}

const CHANNEL_HZ = 100_000;             // 0.1 MHz — the design's tune/seek step
const SCAN_TICK_MS = 34;                // fast text sweep, per the handoff
const RT_MARQUEE_CHARS = 46;

type Rect = { x: number; y: number; w: number; h: number };
/** Live hero-swap FLIP (LOSSY #9); null when the hero is at rest. */
interface FlipDescriptor {
  dir: 1 | -1;
  nearSide: 'left' | 'right';   // source peek + entering new far card
  farSide: 'left' | 'right';    // landing slot + leaving fade clone
  centerTransform: any[];
  landTransform: any[];
  enterOpacity: Animated.Value; // new far peek 0 → 0.6
  cloneOpacity: Animated.Value; // leaving far peek 0.6 → 0
  cloneRect: Rect;
  cloneName: string;
}

const mhzOf = (hz: number) => Math.round(hz / CHANNEL_HZ) / 10;
const fmt = (mhz: number) => mhz.toFixed(1);

/** dB → 0–4 waves (count/position encode strength, never colour alone). */
function waveStrength(db: number | null): number {
  if (db == null) return 0;
  return Math.max(0, Math.min(4, Math.round((db / 40) * 4)));
}

// ── RadioText strip: static when short, 16s marquee when > 46 chars ──────────
// Real RadioText renders in the full text colour; when empty, a dim-italic
// "Waiting for RadioText…" placeholder shows instead (design rtItemStyle).
function RadioTextStrip({ text, colors, height = 52, fontSize = 30, maxWidth = 880 }: { text: string; colors: { raised: string; border: string; dim: string; text: string }; height?: number; fontSize?: number; maxWidth?: number }) {
  const [trackW, setTrackW] = useState(0);
  const x = useRef(new Animated.Value(0)).current;
  const hasText = text.trim().length > 0;
  const shown = hasText ? text : 'Waiting for RadioText…';
  const textColor = hasText ? colors.text : colors.dim;
  const marquee = shown.length > RT_MARQUEE_CHARS;   // placeholder is short → static

  // Design carfm-ticker: two copies with a fixed gap translate 0 → −50% of the
  // track over 16s linear, looping seamlessly (the second copy lands where the
  // first began). RN has no CSS keyframes → Animated.loop reproduces it.
  useEffect(() => {
    if (!marquee || !trackW) { x.setValue(0); return; }
    x.setValue(0);
    const anim = Animated.loop(Animated.timing(x, {
      toValue: -trackW / 2, duration: 16_000, easing: Easing.linear, useNativeDriver: true,
    }));
    anim.start();
    return () => anim.stop();
  }, [marquee, trackW, text, x]);

  return (
    <View
      style={[styles.rtStrip, { minHeight: height, maxWidth, backgroundColor: colors.raised, borderColor: colors.border, justifyContent: marquee ? 'flex-start' : 'center' }]}
    >
      {marquee ? (
        <Animated.View
          style={[styles.rtTrack, { transform: [{ translateX: x }] }]}
          onLayout={(e: LayoutChangeEvent) => setTrackW(e.nativeEvent.layout.width)}
        >
          <Text numberOfLines={1} style={[styles.rtText, { fontSize, color: textColor }]}>{shown}</Text>
          <Text numberOfLines={1} style={[styles.rtText, { fontSize, color: textColor }]}>{shown}</Text>
        </Animated.View>
      ) : (
        <Text numberOfLines={1} style={[styles.rtText, { fontSize, color: textColor, fontStyle: hasText ? 'normal' : 'italic', textAlign: 'center' }]}>
          {shown}
        </Text>
      )}
    </View>
  );
}

// ── Seek digit slide (LOSSY #6 — required) ───────────────────────────────────
// On each frequency change while seeking, the digits enter offset ±14dp with
// opacity 0.25 and settle to 0 / 1 over ~200ms — one two-endpoint transition
// per change (the design's carfm-scan-up/down keyframes expressed as a single
// timing), never a hard swap. dir 0 = ordinary retune, no slide.
function SlidingFreq({ value, dir, fontSize, color }: {
  value: string; dir: 1 | -1 | 0; fontSize: number; color: string;
}) {
  const y = useRef(new Animated.Value(0)).current;
  const op = useRef(new Animated.Value(1)).current;
  const last = useRef(value);
  useEffect(() => {
    if (value === last.current) return;
    last.current = value;
    if (!dir) { y.setValue(0); op.setValue(1); return; }
    // Seek-up rises from below (+14 → 0); seek-down falls from above (−14 → 0).
    y.setValue(dir > 0 ? 14 : -14);
    op.setValue(0.25);
    Animated.parallel([
      Animated.timing(y, { toValue: 0, duration: 200, easing: Easing.bezier(0.25, 0.1, 0.25, 1), useNativeDriver: true }),
      Animated.timing(op, { toValue: 1, duration: 200, easing: Easing.bezier(0.25, 0.1, 0.25, 1), useNativeDriver: true }),
    ]).start();
  }, [value, dir, y, op]);
  return (
    <Animated.Text style={[styles.freq, { fontSize, color, opacity: op, transform: [{ translateY: y }] }]}>
      {value}
    </Animated.Text>
  );
}

// The header's little status letters ("tells"): lit when true, ghosted when
// not. HD is never lit — an RTL-SDR pipeline doesn't decode IBOC — but the
// slot stays so the strip reads the same as a factory head unit's.
function Tell({ label, on, pulse, pal, fontSize = 11 }: { label: string; on: boolean; pulse?: boolean; pal: { text: string; amber: string }; fontSize?: number }) {
  const op = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    if (!pulse) { op.setValue(1); return; }
    const loop = Animated.loop(Animated.sequence([
      Animated.timing(op, { toValue: 0.35, duration: 550, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
      Animated.timing(op, { toValue: 1, duration: 550, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
    ]));
    loop.start();
    return () => loop.stop();
  }, [pulse, op]);
  return (
    <Animated.Text style={[styles.tell, { fontSize, color: pulse ? pal.amber : pal.text, opacity: pulse ? op : (on ? 1 : 0.32) }]}>
      {label}
    </Animated.Text>
  );
}

export default function CarFmFace(props: CarFmFaceProps) {
  const {
    freqHz, stationName, callsignHint, radioText, stereo, signalDb,
    rdsOk, tp, ta, af, ptyText, tunerError, theme, autostart,
    onSetAutostart, onSetTheme, onRetryTuner, presets,
    onTuneHz, onToggleSave, onReorderPreset, onRemovePreset, onSaveStationPreset,
    onOpenAdvanced,
  } = props;
  const insets = useSafeAreaInsets();
  const scheme = useColorScheme();
  const pal = (theme === 'light' || (theme !== 'dark' && scheme === 'light')) ? LIGHT : DARK;

  // A car radio's display never sleeps mid-drive: keep the screen awake for as
  // long as the face is mounted (released automatically on unmount).
  useKeepAwake();

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [numpadOpen, setNumpadOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [reordering, setReordering] = useState(false);
  const [scan, setScan] = useState<{ dir: 1 | -1; display: number } | null>(null);
  const scanTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  // ── Aspect-ratio layout tracks (handoff: fill the container, switch layout by
  // measured w/h so the face survives DuduOS splitting the head unit into
  // vertical thirds). Target 2000×1200 (≈1.67) is the `wide` track.
  //   tall      : portrait / ⅓ vertical slice — hero stacks, NEARBY -> top bar
  //   twoRows   : near-square ⅔ slice — taller preset band
  //   landscape : very wide & short phone — smaller type
  const [dim, setDim] = useState({ w: 0, h: 0 });
  // Real available dp (measured, so the face composes correctly inside a DuduOS
  // vertical third as well as full-screen). Until the first layout, assume the
  // head-unit shape — one frame at most.
  const w = dim.w > 0 ? dim.w : 1024;
  const h = dim.h > 0 ? dim.h : 614;
  // Track selection (ANDROID §2): compact width → tall; otherwise wide, with two
  // density sub-modes — near-square (⅔ slice) gets the 2-row preset band, short
  // (phone landscape) gets smaller type/tiles. Width-class breakpoint 600dp per
  // WindowSizeClass Compact.
  const tall = w < 600;
  const landscape = !tall && h < 480;
  const twoRows = !tall && !landscape && w / h < 1.4;
  // Type/element ramp factor. The spec's dp values are authored at each track's
  // representative surface (§2 table); k re-derives them for the dp actually
  // available, bounded so type never collapses or balloons. This sizes TOKENS
  // only — the layout itself is flex that reflows per track, text is sp (system
  // font-scale multiplies on top), and touch targets keep a 48dp floor via
  // hitSlop. That is what separates this from the banned scale-to-fit (§0):
  // nothing here is a frozen canvas under a uniform transform.
  const k = tall
    ? Math.min(1, Math.max(0.68, w / 486))
    : Math.min(1, Math.max(0.68, landscape
        ? Math.min(w / 1080, h / 486)
        : twoRows ? Math.min(w / 900, h / 810) : Math.min(w / 1024, h / 614)));
  const L = useMemo(() => {
    const s = (v: number) => Math.round(v * k);
    return {
      s,
      padH: s(tall ? 16 : 24),
      padTop: s(tall ? 14 : 18),
      gap: s(tall ? 10 : 12),
      freq: s(tall ? 58 : landscape ? 48 : 60),
      mhz: s(tall ? 22 : landscape ? 18 : 22),
      call: s(tall ? 52 : landscape ? 50 : 66),
      logo: s(tall ? 80 : landscape ? 70 : 92),
      star: s(tall ? 58 : landscape ? 48 : 56),
      rtMarginTop: s(tall ? 12 : landscape ? 10 : 18),
      rtHeight: s(tall ? 56 : landscape ? 50 : 60),
      rtFont: s(landscape ? 26 : 30),
      // Header element scaling (design renderVals `tall ?` branches). Small
      // status type floors at legibility, not proportion (§10).
      signalIcon: s(tall ? 46 : 33),
      signalDb: Math.max(12, s(tall ? 19 : 15)),
      stereoFont: Math.max(12, s(tall ? 18 : 15)),
      stereoWave: tall ? { w: s(28), h: s(40) } : { w: s(20), h: s(28) },
      // STEREO/MONO pill chrome (design stereoStyle = pill + minWidth). Heights
      // are minimums so ×1.5 font-scale grows the pill instead of clipping.
      stereoH: s(tall ? 46 : 36),
      stereoPadH: s(tall ? 18 : 14),
      stereoRadius: tall ? 12 : 10,
      stereoMinW: s(tall ? 196 : 158),
      ptyFont: Math.max(12, s(tall ? 19 : 15)),
      tellFont: Math.max(10, s(tall ? 14 : 11)),
      // ⅔ slice gets the taller two-row band; landscape a short one (§4.3 dp).
      bandHeight: s(twoRows ? 250 : landscape ? 104 : 140),
      // Wide/two-row/landscape hero is a panel card of clamped width (design
      // heroMainStyle: clamp(470, 62%, 720)). Tall uses a wider fraction.
      heroCardW: Math.max(s(470), Math.min(s(720), Math.round(w * 0.62))),
    };
  }, [tall, landscape, twoRows, w, k]);

  const mhz = mhzOf(freqHz);
  const inBand = mhz >= FM_MIN_MHZ - 0.05 && mhz <= FM_MAX_MHZ + 0.05;
  const ps = (stationName ?? '').trim();
  const rt = (radioText ?? '').trim();
  const callsign = ps || callsignHint || '';

  // Displayed-order presets in MHz for the band + saved checks.
  const items = useMemo<PresetItem[]>(
    () => presets.map((p) => ({ name: p.name, frequencyMhz: mhzOf(p.frequency) })),
    [presets],
  );
  const activeIndex = useMemo(
    () => items.findIndex((p) => Math.abs(p.frequencyMhz - mhz) < 0.05),
    [items, mhz],
  );
  const saved = activeIndex >= 0;
  const presetMHz = useMemo(
    () => new Set(items.map((p) => Math.round(p.frequencyMhz * 10))),
    [items],
  );

  // Adjacent presets for the flanking side cards (design wideHero): with no
  // active preset, prev = last / next = first, matching the design.
  const [prevP, nextP] = useMemo<[PresetItem | null, PresetItem | null]>(() => {
    if (items.length === 0) return [null, null];
    if (activeIndex < 0) return [items[items.length - 1], items[0]];
    return [items[(activeIndex - 1 + items.length) % items.length], items[(activeIndex + 1) % items.length]];
  }, [items, activeIndex]);
  const sideCardW = Math.min(L.s(206), Math.max(L.s(120), Math.round(w * 0.18)));
  // Tall/portrait track sizing: a narrower hero card (82%) flanked by smaller
  // peek cards tucked tight. The design's reference screenshots (surface-portrait
  // / surface-slice-one-third) show the peek cards present on the tall track too,
  // not just wide — so they render in every track, only the sizing differs.
  const tallHeroW = Math.min(L.s(560), Math.round(w * 0.82));
  const tallSideW = Math.min(L.s(150), Math.max(L.s(88), Math.round(w * 0.2)));
  const peekOverlap = L.s(tall ? -46 : -72);

  // Tall track (PHONEPORTRAITFIXES §2): hero band grows + centers; the preset
  // band sizes to its 3-column grid content but is CAPPED at 46% of the screen
  // (design: height auto + maxHeight 46%). A definite computed height keeps the
  // vertical grid's ScrollView scrollable while still letting the hero reclaim
  // the freed space when there are few presets, killing the dead void.
  const tallBand = useMemo(() => {
    if (!tall) return L.bandHeight;
    const tileH = L.s(128), gap = L.s(12);
    const rows = Math.ceil(items.length / 3);
    const contentH = rows > 0 ? rows * tileH + (rows - 1) * gap + 8 : 0;
    const cap = Math.round(h * 0.42);   // ~45% shelf (§4.3), trimmed so the shorter ⅓ slice still fits the hero + RadioText above it
    return Math.min(cap, Math.max(L.s(96), contentH));                   // ≥96 so an empty band still reads
  }, [tall, items.length, h, L]);

  // ── Seek: scan to the next/previous station in the local FCC DB ────────────
  // The frequency list loads lazily (offline-first facade; enrich off since only
  // frequencies are needed). Empty list (no GPS / no DB) → seek sweeps one step.
  const seekFreqs = useRef<number[]>([]);
  useEffect(() => {
    getNearbyStations({ enrich: false, limit: 200 })
      .then((r) => {
        seekFreqs.current = [...new Set(r.stations.map((s) => Math.round(s.frequencyMhz * 10) / 10))]
          .sort((a, b) => a - b);
      })
      .catch(() => {});
  }, []);

  const stopScan = useCallback(() => {
    if (scanTimer.current) { clearInterval(scanTimer.current); scanTimer.current = null; }
  }, []);
  useEffect(() => stopScan, [stopScan]);

  const seekLandDir = useRef<1 | -1 | 0>(0);
  const runSeek = useCallback((dir: 1 | -1) => {
    if (scanTimer.current) return;                     // one sweep at a time
    const cur = mhzOf(freqHz);
    const fs = seekFreqs.current;
    let target: number;
    if (fs.length > 0) {
      target = dir > 0
        ? (fs.find((f) => f > cur + 0.05) ?? fs[0])                          // wrap
        : ([...fs].reverse().find((f) => f < cur - 0.05) ?? fs[fs.length - 1]);
    } else {
      target = Math.round((cur + dir * 0.1) * 10) / 10;                      // fallback: one step
      if (target > FM_MAX_MHZ) target = FM_MIN_MHZ;
      if (target < FM_MIN_MHZ) target = FM_MAX_MHZ;
    }
    let v = cur;
    setScan({ dir, display: v });
    scanTimer.current = setInterval(() => {
      v = Math.round((v + dir * 0.1) * 10) / 10;
      if (v > FM_MAX_MHZ) v = FM_MIN_MHZ;
      if (v < FM_MIN_MHZ) v = FM_MAX_MHZ;
      if (Math.abs(v - target) < 0.05) {
        stopScan();
        setScan(null);
        // The landing frequency gets the same entry slide as the ticks; the
        // direction is consumed by SlidingFreq on the retune render and then
        // cleared so ordinary tunes stay slide-free.
        seekLandDir.current = dir;
        setTimeout(() => { seekLandDir.current = 0; }, 400);
        onTuneHz(Math.round(target * 1e6));
      } else {
        setScan({ dir, display: v });
      }
    }, SCAN_TICK_MS);
  }, [freqHz, onTuneHz, stopScan]);

  // ── Hero carousel prev/next SWAP FLIP (LOSSY-ELEMENTS #9) ──────────────────
  // Tuning to an adjacent preset shifts the whole strip one slot with a real
  // position+size morph, not a hard cut. Before the tune we capture the three
  // resting slot rects (they don't move when content swaps); after the data
  // updates each card is driven from its "first" (pre-swap) geometry back to its
  // resting "last" geometry over 520ms — translation on an ease-out cubic, scale
  // on an ease-out quint (size settles slightly ahead of position). The leaving
  // far card fades 0.6→0 in place; the new far card fades 0→0.6, delayed 120ms.
  const slotRects = useRef<{ left: Rect | null; center: Rect | null; right: Rect | null }>({
    left: null, center: null, right: null,
  }).current;
  const [flip, setFlip] = useState<FlipDescriptor | null>(null);
  const flipProg = useRef(new Animated.Value(0)).current;

  const startFlip = useCallback((dir: 1 | -1): boolean => {
    const { left, center, right } = slotRects;
    if (!left || !center || !right || !prevP || !nextP) return false;
    const source = dir > 0 ? right : left;        // new center emerges from here
    const landing = dir > 0 ? left : right;       // old hero shrinks into here
    const farSide: 'left' | 'right' = dir > 0 ? 'left' : 'right';   // clone + landing side
    const nearSide: 'left' | 'right' = dir > 0 ? 'right' : 'left';  // source + entering side
    const cloneName = (dir > 0 ? prevP.name : nextP.name) || 'FM';

    const cx = (r: Rect) => r.x + r.w / 2;
    const cy = (r: Rect) => r.y + r.h / 2;
    // Two easings, sampled into 13-point interpolations (mirrors the design's
    // 12-frame keyframe track): translate on cubic, scale on quint.
    const easeMove = (p: number) => 1 - Math.pow(1 - p, 3);
    const easeScale = (p: number) => 1 - Math.pow(1 - p, 5);
    const STEPS = 12;
    const track = (from: number, to: number, ease: (p: number) => number) => {
      const input: number[] = [], output: number[] = [];
      for (let i = 0; i <= STEPS; i++) { const p = i / STEPS; input.push(p); output.push(from + (to - from) * ease(p)); }
      return flipProg.interpolate({ inputRange: input, outputRange: output });
    };
    // New center card (base scale 1): from the source peek slot → center slot.
    const centerTransform = [
      { translateX: track(cx(source) - cx(center), 0, easeMove) },
      { translateY: track(cy(source) - cy(center), 0, easeMove) },
      { scaleX: track((PEEK_SCALE * source.w) / center.w, 1, easeScale) },
      { scaleY: track((PEEK_SCALE * source.h) / center.h, 1, easeScale) },
    ];
    // Old hero, now the landing peek (base scale 0.88): from center → landing slot.
    const landTransform = [
      { translateX: track(cx(center) - cx(landing), 0, easeMove) },
      { translateY: track(cy(center) - cy(landing), 0, easeMove) },
      { scaleX: track(center.w / landing.w, PEEK_SCALE, easeScale) },
      { scaleY: track(center.h / landing.h, PEEK_SCALE, easeScale) },
    ];
    flipProg.setValue(0);
    setFlip({
      dir, nearSide, farSide, centerTransform, landTransform,
      enterOpacity: new Animated.Value(0),
      cloneOpacity: new Animated.Value(PEEK_OPACITY),
      cloneRect: landing, cloneName,
    });
    return true;
  }, [slotRects, prevP, nextP, flipProg]);

  // Run the four animations once the descriptor is in place (data has updated).
  useEffect(() => {
    if (!flip) return;
    const anim = Animated.parallel([
      Animated.timing(flipProg, { toValue: 1, duration: 520, easing: Easing.linear, useNativeDriver: true }),
      Animated.timing(flip.cloneOpacity, { toValue: 0, duration: 520, easing: Easing.bezier(0.25, 0.1, 0.25, 1), useNativeDriver: true }),
      Animated.timing(flip.enterOpacity, { toValue: PEEK_OPACITY, duration: 520, delay: 120, easing: Easing.bezier(0.25, 0.1, 0.25, 1), useNativeDriver: true }),
    ]);
    anim.start(({ finished }) => { if (finished) setFlip(null); });
    return () => anim.stop();
  }, [flip, flipProg]);

  const measureSlot = useCallback((slot: 'left' | 'center' | 'right') => (e: LayoutChangeEvent) => {
    const { x, y, width, height } = e.nativeEvent.layout;
    slotRects[slot] = { x, y, w: width, h: height };
  }, [slotRects]);

  // PREV/NEXT step through presets in their DISPLAYED order (wrapping). Fire the
  // hero-swap FLIP first (it captures resting geometry), then tune.
  const stepPreset = useCallback((dir: 1 | -1) => {
    if (items.length === 0) return;
    startFlip(dir);
    const i = activeIndex >= 0 ? activeIndex : (dir > 0 ? -1 : 0);
    const n = ((i + dir) % items.length + items.length) % items.length;
    onTuneHz(Math.round(items[n].frequencyMhz * 1e6));
  }, [items, activeIndex, onTuneHz, startFlip]);

  const onNearbyTune = useCallback((st: NearbyStation) => {
    onTuneHz(Math.round(st.frequencyMhz * 1e6));
  }, [onTuneHz]);
  const onNearbySave = useCallback((st: NearbyStation) => {
    onSaveStationPreset(st.callsign, st.frequencyMhz);
  }, [onSaveStationPreset]);

  return (
    <View
      onLayout={(e: LayoutChangeEvent) => setDim({ w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height })}
      style={[styles.stage, { backgroundColor: pal.bg, paddingTop: insets.top, paddingBottom: insets.bottom }]}
    >
      {/* Responsive face (ANDROID §0): laid out directly at the real available
          dp — no design canvas, no uniform scale. Tracks reflow per surface and
          the token ramp (L) re-derives the spec's dp for this surface. */}
      <View style={[styles.face, { backgroundColor: pal.bg, paddingHorizontal: L.padH, gap: L.gap, paddingVertical: L.padTop }]}>
      {/* ── Header row (design v2: signal · stereo+tells · PTY · gear) ──
          Tuner error is a hard either/or with the status cluster: with no tuner
          session there is no signal/RDS/stereo/genre to read, so the whole
          cluster is replaced by the one fault pill (design addendum). */}
      <View style={styles.header}>
        {tunerError ? (
        <View style={[styles.tunerErrPill, { borderColor: pal.amber, backgroundColor: pal.amberFill }]}>
          <WarningTriangle size={26} color={pal.amber} />
          <Text style={[styles.tunerErrText, { color: pal.amber }]} numberOfLines={1}>
            Failure to connect to tuner.
          </Text>
        </View>
        ) : (
        <View style={[styles.headerLeft, tall && { flexWrap: 'wrap', flexShrink: 1 }]}>
          <View style={styles.signalPill}>
            <SignalWaves size={L.signalIcon} strength={waveStrength(signalDb)} on={pal.amber} off={pal.meterEmpty} />
            <Text style={[styles.signalText, { fontSize: L.signalDb, color: pal.dim }]}>
              {signalDb == null ? '—' : `${Math.round(signalDb)} dB`}
            </Text>
          </View>
          <View style={styles.stereoCol}>
            <View style={[styles.stereoRow, {
              minHeight: L.stereoH, paddingHorizontal: L.stereoPadH, borderRadius: L.stereoRadius,
              minWidth: L.stereoMinW, borderWidth: 1.5,
              borderColor: stereo ? pal.blue : pal.border,
              backgroundColor: stereo ? pal.blueFill : 'transparent',
            }]}>
              {stereo ? <StereoWave color={pal.blue} flip w={L.stereoWave.w} h={L.stereoWave.h} /> : <View style={{ width: L.stereoWave.w, height: L.stereoWave.h }} />}
              <Text style={[styles.stereoText, { fontSize: L.stereoFont, color: stereo ? pal.blue : pal.dim }]}>
                {stereo ? 'STEREO' : 'MONO'}
              </Text>
              {stereo ? <StereoWave color={pal.blue} w={L.stereoWave.w} h={L.stereoWave.h} /> : <View style={{ width: L.stereoWave.w, height: L.stereoWave.h }} />}
            </View>
            <View style={styles.tellStrip}>
              <Tell label="RDS" on={!!rdsOk} pal={pal} fontSize={L.tellFont} />
              <Tell label="HD" on={false} pal={pal} fontSize={L.tellFont} />
              {ta ? <Tell label="TA" on pulse pal={pal} fontSize={L.tellFont} /> : <Tell label="TP" on={!!tp} pal={pal} fontSize={L.tellFont} />}
              <Tell label="AF" on={!!af} pal={pal} fontSize={L.tellFont} />
            </View>
          </View>
          {ptyText ? (
            <View style={[styles.ptyWrap, tall ? { flexBasis: '100%' } : { maxWidth: 200 }]}>
              <Text numberOfLines={1} style={[styles.ptyText, { fontSize: L.ptyFont, color: pal.dim }]}>{ptyText}</Text>
            </View>
          ) : null}
          {!inBand ? (
            <View style={[styles.oobPill, { borderColor: pal.amber }]}>
              <Text style={[styles.oobText, { color: pal.amber }]}>⚠ OUT OF FM BAND</Text>
            </View>
          ) : null}
        </View>
        )}
        {/* Right cluster: gear always; in the tall/portrait track the NEARBY disc
            (design: it moves into the top bar) rides beneath it — becoming DONE
            while reordering, since the presets band no longer hosts it here. */}
        <View style={styles.headerRight}>
          <Pressable
            onPress={() => setSettingsOpen(true)}
            hitSlop={2}
            style={({ pressed }) => [styles.gearBtn, { borderColor: pal.border, backgroundColor: pal.raised }, pressed && { opacity: 0.55 }]}
            accessibilityRole="button" accessibilityLabel="Settings"
          >
            <GearIcon size={24} color={pal.dim} />
          </Pressable>
          {tall ? (
            reordering ? (
              <Pressable
                onPress={() => setReordering(false)}
                style={({ pressed }) => [styles.headerNearby, { width: L.s(74), height: L.s(74), borderRadius: L.s(37), backgroundColor: pal.blue }, pressed && { opacity: 0.7 }]}
                accessibilityRole="button" accessibilityLabel="Done reordering"
              >
                <Text style={styles.headerDoneCheck}>✓</Text>
                <Text style={styles.headerDoneText}>DONE</Text>
              </Pressable>
            ) : (
              <Pressable
                onPress={() => setPickerOpen(true)}
                style={({ pressed }) => [styles.headerNearby, { width: L.s(74), height: L.s(74), borderRadius: L.s(37), backgroundColor: pal.panel, borderWidth: 1, borderColor: pal.border }, pressed && { opacity: 0.7 }]}
                accessibilityRole="button" accessibilityLabel="Nearby stations"
              >
                <MagnifierTower size={L.s(59)} line={pal.text} glass={pal.raised} />
              </Pressable>
            )
          ) : null}
        </View>
      </View>

      {/* ── Hero band ──
          `heroCenter` (logo + call letters + star + frequency + RadioText) is
          the same in every track; only the FRAME around it changes: wide/
          two-row/landscape keep the horizontal chevron side columns, while the
          tall/portrait track stacks the hero into a card with a PREV/NEXT nav
          row below it. */}
      {(() => {
        // ≥48dp touch floor (§10): when the ramp sizes a control below 48dp,
        // hitSlop extends the touchable area without changing the visual.
        const starSlop = Math.max(0, Math.ceil((48 - L.star) / 2));
        const heroCenter = scan ? (
          <View style={styles.scanWrap}>
            <Text style={[styles.call, { fontSize: L.call, color: pal.dim, fontStyle: 'italic' }]}>
              Scanning…
            </Text>
            <View style={styles.freqRow}>
              <Text style={[styles.scanArrow, { color: pal.dim }]}>{scan.dir > 0 ? '▲' : '▼'}</Text>
              <SlidingFreq value={fmt(scan.display)} dir={scan.dir} fontSize={L.freq} color={pal.amber} />
              <Text style={[styles.mhz, { fontSize: L.mhz, color: pal.dim }]}>MHz</Text>
            </View>
          </View>
        ) : (
          <>
            <View style={[styles.stationRow, tall && { gap: L.s(14) }]}>
              <LogoTile name={callsign || undefined} size={L.logo} radius={20} />
              <Text
                numberOfLines={1}
                style={[
                  styles.call,
                  { fontSize: L.call, color: pal.text },
                  !ps && { fontStyle: 'italic', color: pal.dim },
                ]}
              >
                {callsign || 'Tuning…'}
              </Text>
              <Pressable
                onPress={onToggleSave}
                hitSlop={starSlop}
                style={({ pressed }) => [
                  styles.starBtn,
                  { width: L.star, height: L.star, backgroundColor: saved ? pal.blueFill : pal.raised },
                  pressed && { opacity: 0.55 },
                ]}
                accessibilityRole="button"
                accessibilityState={{ selected: saved }}
                accessibilityLabel={saved ? 'Remove this frequency from presets' : 'Save this frequency as a preset'}
              >
                <StarIcon size={L.s(30)} filled={saved} color={pal.amber} outline={pal.dim} />
              </Pressable>
            </View>
            <Pressable
              onPress={() => setNumpadOpen(true)}
              accessibilityRole="button"
              accessibilityLabel={`Frequency ${fmt(mhz)} megahertz. Tap to enter a frequency.`}
            >
              <View style={styles.freqRow}>
                <SlidingFreq value={fmt(mhz)} dir={seekLandDir.current} fontSize={L.freq} color={pal.amber} />
                <Text style={[styles.mhz, { fontSize: L.mhz, color: pal.dim }]}>MHz</Text>
              </View>
            </Pressable>
          </>
        );

        // PREV/NEXT preset peek cards flank the hero in EVERY track — the design
        // reference screenshots show them tucked on both sides in tall too, not
        // just wide. Chevrons are never used. Only the sizing differs: tall tucks
        // smaller cards with a -46 overlap; wide/landscape use the clamped hero
        // card and a -72 overlap.
        const peekW = tall ? tallSideW : sideCardW;
        const overlap = peekOverlap;
        const renderPeek = (side: 'left' | 'right', preset: PresetItem, onPress: () => void) => {
          const isLanding = !!flip && flip.farSide === side;    // old hero shrinking into this slot
          const isEntering = !!flip && flip.nearSide === side;  // brand-new far card fading in
          return (
            <Animated.View
              onLayout={measureSlot(side)}
              style={[
                { marginRight: side === 'left' ? overlap : 0, marginLeft: side === 'right' ? overlap : 0 },
                { transform: isLanding ? flip!.landTransform : [{ scale: PEEK_SCALE }] },
                { opacity: isEntering ? flip!.enterOpacity : PEEK_OPACITY },
              ]}
            >
              <SidePresetCard name={preset.name} pal={pal} side={side} width={peekW} onPress={onPress} />
            </Animated.View>
          );
        };
        const heroRow = (
          <View style={tall ? styles.heroRowTall : styles.hero}>
            {prevP ? renderPeek('left', prevP, () => stepPreset(-1)) : null}
            <Animated.View
              onLayout={measureSlot('center')}
              style={[
                tall ? styles.heroCard : styles.heroCardWide, styles.heroCardZ,
                {
                  width: tall ? tallHeroW : L.heroCardW, backgroundColor: pal.panel, borderColor: pal.border,
                  paddingVertical: L.s(tall ? 30 : 24), paddingHorizontal: L.s(tall ? 26 : 30), gap: L.s(14),
                },
                flip ? { transform: flip.centerTransform } : null,
              ]}
            >
              {heroCenter}
            </Animated.View>
            {nextP ? renderPeek('right', nextP, () => stepPreset(1)) : null}
            {flip ? (
              <Animated.View
                pointerEvents="none"
                style={[
                  styles.cloneOverlay,
                  {
                    left: flip.cloneRect.x, top: flip.cloneRect.y,
                    width: flip.cloneRect.w, height: flip.cloneRect.h,
                    opacity: flip.cloneOpacity, transform: [{ scale: PEEK_SCALE }],
                  },
                ]}
              >
                <SidePresetCard name={flip.cloneName} pal={pal} side={flip.farSide} width={peekW} />
              </Animated.View>
            ) : null}
          </View>
        );
        // The RadioText strip is a SIBLING BELOW the hero row (design heroBand =
        // column of [heroRow, rtZone]) — NOT inside the hero card. Keeping it out
        // of the card matches the compact hero + full-width RT bar in the refs.
        const rtBand = (
          <View style={[styles.rtZone, tall && { marginTop: 'auto', marginBottom: 'auto' }]}>
            <RadioTextStrip
              text={rt}
              height={L.rtHeight}
              fontSize={L.rtFont}
              maxWidth={L.s(880)}
              colors={{ raised: pal.raised, border: pal.border, dim: pal.dim, text: pal.text }}
            />
          </View>
        );
        return (
          <View style={tall ? styles.heroBandTall : styles.heroBand}>
            {heroRow}
            {rtBand}
          </View>
        );
      })()}

      {/* ── Presets band ── (grows to fill in the tall track; NEARBY + nav move to
          the top bar there, so they're suppressed in-band) */}
      <PresetsBand
        pal={pal}
        presets={items}
        activeIndex={activeIndex}
        reordering={reordering}
        grow={false}
        bandHeight={tallBand}
        showNav={!tall}
        showNearby={!tall}
        tall={tall}
        twoRows={twoRows}
        landscape={landscape}
        k={k}
        onSelect={(p) => onTuneHz(Math.round(p.frequencyMhz * 1e6))}
        onEnterReorder={() => setReordering(true)}
        onExitReorder={() => setReordering(false)}
        onMove={onReorderPreset}
        onRemove={onRemovePreset}
        onOpenNearby={() => setPickerOpen(true)}
      />
      </View>

      {/* ── Modals ── (device-level, capped to the surface per §6) */}
      <Numpad
        visible={numpadOpen}
        pal={pal}
        currentMHz={fmt(scan ? scan.display : mhz)}
        scanning={!!scan}
        compact={dim.h > 0 && dim.h < 560}
        maxHeight={dim.h > 0 ? dim.h - 24 : undefined}
        onSeek={runSeek}
        onTune={(f) => { setNumpadOpen(false); onTuneHz(Math.round(f * 1e6)); }}
        onClose={() => setNumpadOpen(false)}
      />
      <NearbyPicker
        visible={pickerOpen}
        pal={pal}
        presetMHz={presetMHz}
        onTune={onNearbyTune}
        onSavePreset={onNearbySave}
        onClose={() => setPickerOpen(false)}
      />
      <SettingsPanel
        visible={settingsOpen}
        pal={pal}
        tunerError={!!tunerError}
        autostart={autostart ?? true}
        theme={theme ?? 'system'}
        onRetryTuner={onRetryTuner}
        onSetAutostart={(on) => onSetAutostart?.(on)}
        onSetTheme={(t) => onSetTheme?.(t)}
        onAdvanced={() => { setSettingsOpen(false); onOpenAdvanced(); }}
        onClose={() => setSettingsOpen(false)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  // Full-screen stage; the face fills it and lays out responsively (§0).
  stage: {
    position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
    zIndex: 60, overflow: 'hidden',
  },
  face: { width: '100%', height: '100%', flexDirection: 'column' },

  header: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 },
  headerLeft: { flexDirection: 'row', alignItems: 'center', gap: 14, flexShrink: 1 },
  headerRight: { alignItems: 'center', gap: 12, flexShrink: 0 },
  headerNearby: { width: 74, height: 74, borderRadius: 37, alignItems: 'center', justifyContent: 'center' },
  headerDoneCheck: { color: '#FFF', fontSize: 22, fontWeight: '700' },
  headerDoneText: { color: '#FFF', fontFamily: FONT, fontSize: 11, fontWeight: '700', letterSpacing: 1.5 },
  signalPill: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  signalText: { fontFamily: FONT, fontSize: 17, fontWeight: '700', fontVariant: ['tabular-nums'] },
  stereoCol: { alignItems: 'center', gap: 5 },
  // STEREO/MONO pill: waves flank the label inside a bordered pill (design
  // stereoStyle). Border/fill colour + min-width set inline from the palette.
  stereoRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 9 },
  waveSpacer: { width: 20, height: 28 },
  stereoText: { fontFamily: FONT, fontSize: 15, fontWeight: '700', letterSpacing: 1 },
  tellStrip: { flexDirection: 'row', gap: 10 },
  tell: { fontFamily: FONT, fontSize: 11, fontWeight: '700', letterSpacing: 1, lineHeight: 12 },
  // PTY: plain dim ellipsized text — no border/fill (design ptyStyle).
  ptyWrap: { height: 36, justifyContent: 'center' },
  ptyText: { fontFamily: FONT, fontSize: 15, fontWeight: '700', letterSpacing: 0.5 },
  oobPill: { borderWidth: 1.5, borderRadius: 10, paddingHorizontal: 10, paddingVertical: 4 },
  oobText: { fontFamily: FONT, fontSize: 12, fontWeight: '700', letterSpacing: 0.5 },
  gearBtn: { width: 44, height: 44, borderRadius: 12, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  tunerErrPill: {
    height: 44, paddingHorizontal: 16, borderRadius: 10, borderWidth: 1.5,
    flexDirection: 'row', alignItems: 'center', gap: 11, alignSelf: 'flex-start',
  },
  tunerErrText: { fontFamily: FONT, fontSize: 17, fontWeight: '700', letterSpacing: 0.3 },

  hero: { flex: 1, flexDirection: 'row', gap: 0, alignItems: 'center', justifyContent: 'center' },
  // Non-tall hero: a panel card of clamped width (design heroMainStyle). It sits
  // ABOVE the flanking side preset cards (heroCardZ) so they tuck behind it.
  heroCardWide: {
    borderWidth: 1, borderRadius: 28, paddingVertical: 24, paddingHorizontal: 30,
    alignItems: 'center', justifyContent: 'center', maxWidth: '100%',
    elevation: 8, shadowColor: '#000', shadowOpacity: 0.18, shadowRadius: 22, shadowOffset: { width: 0, height: 14 },
  },
  heroCardZ: { zIndex: 3 },
  // Snapshot of the far peek leaving the strip during a hero swap; fades in place
  // over its old slot while the landing peek slides in (design fadeClone).
  cloneOverlay: { position: 'absolute', zIndex: 4, alignItems: 'center', justifyContent: 'center' },
  // Tall/portrait track: hero band grows + centers (PHONEPORTRAITFIXES §2); the
  // hero card is flanked by the same side preset cards as every other track.
  // Hero band = column of [hero row, RadioText zone] (design heroBand).
  heroBand: { flex: 1, gap: 16, minHeight: 0 },
  // Tall: leftover height is DISTRIBUTED, not pooled (design §4.2). The hero row
  // (marginTop:auto) and the RadioText zone (marginTop+Bottom:auto) create three
  // equal flexible gaps: above hero, hero→RadioText, RadioText→presets.
  heroBandTall: { flex: 1, justifyContent: 'flex-start', gap: 0, marginTop: 14, minHeight: 0 },
  heroRowTall: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 0, marginTop: 'auto' },
  heroCard: { borderWidth: 1, borderRadius: 28, paddingVertical: 30, paddingHorizontal: 26, gap: 16, alignItems: 'center', justifyContent: 'center', maxWidth: '100%', elevation: 8, shadowColor: '#000', shadowOpacity: 0.18, shadowRadius: 22, shadowOffset: { width: 0, height: 14 } },

  // maxWidth + justify-center keep the logo/callsign/star group INSIDE the hero
  // card: the callsign (flexShrink) gives way so the fixed logo tile and star
  // never spill past the card's rounded bounds (design stationRowStyle).
  stationRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 22, maxWidth: '100%' },
  call: { fontFamily: FONT, fontSize: 66, fontWeight: '700', letterSpacing: -1, flexShrink: 1 },
  starBtn: { width: 56, height: 56, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  freqRow: { flexDirection: 'row', alignItems: 'baseline', gap: 8, marginTop: 6 },
  freq: { fontFamily: FONT, fontSize: 60, fontWeight: '700', fontVariant: ['tabular-nums'] },
  mhz: { fontFamily: FONT, fontSize: 20, fontWeight: '700' },
  rtZone: { flexShrink: 0, alignItems: 'stretch', justifyContent: 'center' },
  // minHeight (not height) so ×1.5 font-scale grows the strip instead of clipping.
  rtStrip: {
    borderWidth: 1, borderRadius: 16, minHeight: 52, width: '100%', maxWidth: 880, alignSelf: 'center',
    justifyContent: 'center', overflow: 'hidden', paddingHorizontal: 28,
  },
  rtTrack: { flexDirection: 'row', alignSelf: 'flex-start', columnGap: 100 },
  rtText: { fontFamily: FONT, fontSize: 22 },

  scanWrap: { alignItems: 'center', gap: 6 },
  scanArrow: { fontSize: 22 },
});
