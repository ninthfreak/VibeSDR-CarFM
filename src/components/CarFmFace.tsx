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
  Animated, Easing, Image, Pressable, StyleSheet, Text, View, useColorScheme,
  type LayoutChangeEvent,
} from 'react-native';
import { useKeepAwake } from 'expo-keep-awake';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { getNearbyStations, callsignForFreq } from '../services/stationFinder';
import type { NearbyStation } from '../services/stationTypes';
import { GearIcon, GpsSatellite, MagnifierTower, MotionCar, PowerIcon, SignalWaves, StarIcon, StereoWave, WarningTriangle } from './carfm/icons';
import { useMotion } from '../services/motion';
import { useGpsFix } from '../services/gps';
import LogoTile, { callsignFrom, useStationLogo, useStationDisplay } from './carfm/LogoTile';
import LogoSearchOverlay, { type LogoSearchTarget } from './carfm/LogoSearchOverlay';
import NearbyPicker from './carfm/NearbyPicker';
import Numpad from './carfm/Numpad';
import PresetsBand, { type PresetItem } from './carfm/PresetsBand';
import { callsignBase } from '../services/piCallsign';
import SidePresetCard, { PEEK_OPACITY, PEEK_SCALE } from './carfm/SidePresetCard';
import SettingsPanel, { type CarFmTheme } from './carfm/SettingsPanel';
import { cleanCall, DARK, FM_MAX_MHZ, FM_MIN_MHZ, FONT, FONT_BOLD, LIGHT, type CarFmPalette } from './carfm/tokens';

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
  /** The built-in NWD tuner is the active source (drives hardware seek + honest
   *  tuner-source detection in settings). */
  nwdActive?: boolean;
  /** Hardware seek (built-in tuner): when set, SEEK uses the tuner's own
   *  next-station scan instead of the FCC-DB sweep. */
  onHardwareSeek?: (dir: 1 | -1) => void;
  presets: CarFmPreset[];   // displayed order (user-arranged)
  onTuneHz: (hz: number) => void;
  onToggleSave: () => void;              // star: save/remove current frequency
  onReorderPreset: (order: number[]) => void;   // new order as original indices
  onRemovePreset: (index: number) => void;
  onSaveStationPreset: (name: string, freqMhz: number) => void;  // nearby hold
  /** Whether this app holds FM audio priority on the shared bus (§4.7). Default
   *  true. NOT a mute — false means priority is released to another source and the
   *  face goes flat/grayscale. */
  audioActive?: boolean;
  onClaimAudio?: () => void;     // inactive → take priority (power button)
  onReleaseAudio?: () => void;   // active → give it up
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

/** dB → 0–4 waves (count/position encode strength, never colour alone).
 *  Design mapping (CarFmLive): rating 0–5 ↔ db = −95 + rating·8, 12 meter
 *  segments = rating/5·12, waves = segments/3. Inverted here so real dBFS
 *  (−110…−55) lights the same waves as the design demo. */
function waveStrength(db: number | null): number {
  if (db == null) return 0;
  const segs = Math.max(0, Math.min(12, Math.round((db + 95) * 0.3)));
  return Math.max(0, Math.min(4, Math.round(segs / 3)));
}

/**
 * Driving-status icons (§4.6) — GPS lock + vehicle-in-motion, wide/landscape only.
 * A tiny self-subscribing child so GPS/motion toggles re-render only these glyphs,
 * not the whole face. GPS satellite is always present (blue on a fix; dim ~32% when
 * not — the "disabled tell" look; the faint 1px emboss the design uses can't render
 * on RN-svg, so the dim colour+opacity carries it). The car shows ONLY while moving,
 * amber, slow-pulsing ~2.6s. Driven by the unified GPS engine (services/gps +
 * services/motion).
 */
function DrivingStatusIcons({ pal }: { pal: CarFmPalette }) {
  const { hasFix } = useGpsFix();
  const { isMoving } = useMotion();
  const pulse = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!isMoving) return;
    const loop = Animated.loop(Animated.sequence([
      Animated.timing(pulse, { toValue: 1, duration: 1300, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
      Animated.timing(pulse, { toValue: 0, duration: 1300, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
    ]));
    loop.start();
    return () => { loop.stop(); pulse.setValue(0); };
  }, [isMoving, pulse]);
  const opacity = pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 0.4] });
  const scale = pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 1.07] });
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 2 }}>
      {isMoving ? (
        <Animated.View style={{ opacity, transform: [{ scale }], marginRight: -6 }} accessibilityLabel="Vehicle in motion">
          <MotionCar size={34} color={pal.amber} />
        </Animated.View>
      ) : null}
      {/* §4.6: no fix → full text color at 32% + the same faint 1px light emboss. */}
      <View
        style={[
          { opacity: hasFix ? 1 : 0.32, transform: [{ translateY: -4 }] },
          !hasFix && ({ filter: [{ dropShadow: { offsetX: 0, offsetY: 1, standardDeviation: 0, color: pal === DARK ? 'rgba(255,255,255,0.10)' : 'rgba(255,255,255,0.9)' } }] } as any),
        ]}
        accessibilityLabel={hasFix ? 'GPS lock' : 'No GPS lock'}>
        <GpsSatellite size={30} color={hasFix ? pal.blue : pal.text} />
      </View>
    </View>
  );
}

/** Audio-priority (claim/release) power button, §4.7 — mirrors the ★ top-right.
 *  Drawn in full colour ABOVE the grayscaled face: a dim outline when active; solid
 *  amber + white glyph + a slow (~1.8s) expanding pulse ring when priority is
 *  released, to draw the eye back. NOT a mute. */
function PowerButton({ off, size, radius, pal, onClaim, onRelease, style }: {
  off: boolean; size: number; radius: number; pal: CarFmPalette;
  onClaim?: () => void; onRelease?: () => void; style?: any;
}) {
  const pulse = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!off) { pulse.setValue(0); return; }
    const loop = Animated.loop(Animated.timing(pulse, { toValue: 1, duration: 1800, easing: Easing.out(Easing.ease), useNativeDriver: true }));
    loop.start();
    return () => loop.stop();
  }, [off, pulse]);
  const ringScale = pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 1.9] });
  const ringOpacity = pulse.interpolate({ inputRange: [0, 0.7, 1], outputRange: [0.5, 0, 0] });
  return (
    <View style={[{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }, style]} pointerEvents="box-none">
      {off ? (
        <Animated.View pointerEvents="none" style={{ position: 'absolute', width: size, height: size, borderRadius: radius, backgroundColor: '#FFAE1A', opacity: ringOpacity, transform: [{ scale: ringScale }] }} />
      ) : null}
      <Pressable
        onPress={() => (off ? onClaim?.() : onRelease?.())}
        style={({ pressed }) => [{
          width: size, height: size, borderRadius: radius,
          alignItems: 'center', justifyContent: 'center',
          backgroundColor: off ? '#FFAE1A' : 'transparent',
          borderWidth: 1, borderColor: off ? 'transparent' : pal.border,
        }, pressed && { opacity: 0.6 }]}
        accessibilityRole="button"
        accessibilityState={{ selected: !off }}
        accessibilityLabel={off ? 'Claim FM audio priority' : 'Release FM audio priority'}
      >
        <PowerIcon size={Math.round(size * 0.58)} color={off ? '#FFFFFF' : pal.dim} />
      </Pressable>
    </View>
  );
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
        // Static text clips at the strip edges like the design's overflow:hidden
        // — never an ellipsis (the refs show edge-clipped text, not "…").
        <Text numberOfLines={1} ellipsizeMode="clip" style={[styles.rtText, { fontSize, color: textColor, fontStyle: hasText ? 'normal' : 'italic', textAlign: 'center' }]}>
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

// ── Hero real logo (§4.5) ────────────────────────────────────────────────────
// A real logo REPLACES the big call sign on the hero. Fixed HEIGHT (grows as the
// call sign / frequency are hidden); the white plate hugs the logo's width once
// its aspect ratio is known (captured on load), so square badges and wide
// wordmarks both sit tight rather than in a big empty box. Fit — never cropped.
function HeroLogo({ uri, height, maxWidth, radius }: {
  uri: string; height: number; maxWidth: number; radius: number;
}) {
  const [aspect, setAspect] = useState<number | null>(null);
  const w = aspect ? Math.min(maxWidth, Math.round(height * aspect)) : maxWidth;
  return (
    <View style={{
      height, width: w, maxWidth, borderRadius: radius, backgroundColor: '#FFFFFF',
      paddingVertical: 4, paddingHorizontal: 8, overflow: 'hidden',
      alignItems: 'center', justifyContent: 'center',
    }}>
      <Image
        source={{ uri }}
        onLoad={(e) => {
          const s = e.nativeEvent.source as { width?: number; height?: number };
          if (s?.width && s?.height) setAspect(s.width / s.height);
        }}
        style={{ width: '100%', height: '100%' }}
        resizeMode="contain"
      />
    </View>
  );
}

// The header's little status letters ("tells"): lit when true, ghosted when
// not. HD is never lit — an RTL-SDR pipeline doesn't decode IBOC — but the
// slot stays so the strip reads the same as a factory head unit's.
function Tell({ label, on, pulse, pal, fontSize = 11, dark = false, off = false }: { label: string; on: boolean; pulse?: boolean; pal: { text: string; amber: string }; fontSize?: number; dark?: boolean; off?: boolean }) {
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
  // §4.1 tell emboss: an active/pulsing tell casts a soft dark drop; a dim tell gets
  // a faint 1px light emboss (engraved look). §4.7 removes all of it when the audio
  // priority is released (the flat "dead" state).
  const shadow = off
    ? { textShadowColor: 'transparent', textShadowOffset: { width: 0, height: 0 }, textShadowRadius: 0 }
    : (pulse || on)
      ? { textShadowColor: 'rgba(0,0,0,0.30)', textShadowOffset: { width: 0, height: 1 }, textShadowRadius: 2 }
      : { textShadowColor: dark ? 'rgba(255,255,255,0.10)' : 'rgba(255,255,255,0.9)', textShadowOffset: { width: 0, height: 1 }, textShadowRadius: 0 };
  return (
    <Animated.Text style={[styles.tell, { fontSize, color: pulse ? pal.amber : pal.text, opacity: pulse ? op : (on ? 1 : 0.32) }, shadow]}>
      {label}
    </Animated.Text>
  );
}

export default function CarFmFace(props: CarFmFaceProps) {
  const {
    freqHz, stationName, callsignHint, radioText, stereo, signalDb,
    rdsOk, tp, ta, af, ptyText, tunerError, theme, autostart,
    onSetAutostart, onSetTheme, onRetryTuner, presets, nwdActive, onHardwareSeek,
    onTuneHz, onToggleSave, onReorderPreset, onRemovePreset, onSaveStationPreset,
    audioActive, onClaimAudio, onReleaseAudio,
  } = props;
  const insets = useSafeAreaInsets();
  const scheme = useColorScheme();
  const pal = (theme === 'light' || (theme !== 'dark' && scheme === 'light')) ? LIGHT : DARK;
  const dark = pal === DARK;
  // Audio priority released (§4.7): the whole face goes flat/grayscale + "dead".
  // `off` gates the grayscale filter, veils, depth removal and indicator off-states.
  const off = audioActive === false;
  // RN filter grayscale (New Architecture) — applied to each face region's content;
  // the power button is drawn in full color ABOVE it (design's Android guidance).
  const GS: any = off ? { filter: [{ grayscale: 1 }] } : null;
  const heroVeilColor = dark ? 'rgba(0,0,0,0.42)' : 'rgba(72,82,96,0.26)';
  const screenVeilColor = dark ? 'rgba(0,0,0,0.50)' : 'rgba(24,32,46,0.34)';
  // PTY genre 1px emboss (§4.1). RN Text supports one shadow, so the design's
  // two-part emboss is approximated by its dominant edge. (PTY is hidden when off.)
  const ptyShadow = { textShadowColor: dark ? 'rgba(0,0,0,0.5)' : 'rgba(255,255,255,0.95)', textShadowOffset: { width: 0, height: 1 }, textShadowRadius: 0 };

  // A car radio's display never sleeps mid-drive: keep the screen awake for as
  // long as the face is mounted (released automatically on unmount).
  useKeepAwake();

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [numpadOpen, setNumpadOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [reordering, setReordering] = useState(false);
  const [logoSearch, setLogoSearch] = useState<LogoSearchTarget | null>(null);
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
      mhz: s(tall ? 20 : landscape ? 18 : 22),
      call: s(tall ? 52 : landscape ? 50 : 66),
      logo: s(tall ? 80 : landscape ? 70 : 92),
      star: s(tall ? 58 : landscape ? 48 : 56),
      rtMarginTop: s(tall ? 12 : landscape ? 10 : 18),
      // Design rtStripStyle: the strip is 64 tall on every track; the ZONE
      // around it is what varies (rtZoneStyle 60/50/56/76).
      rtHeight: s(64),
      rtZoneH: s(tall ? 60 : landscape ? 50 : twoRows ? 56 : 76),
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
  const callsign = cleanCall(ps || callsignHint || '');
  // Hero real-logo model (§4.5): a real logo replaces the big call sign, which
  // becomes a small label beneath; no logo → big call sign, no monogram. The
  // per-station Display Call Sign / Frequency flags hide those on the hero and
  // the logo grows to reclaim the freed space.
  const heroLogo = useStationLogo(callsign || undefined, mhz);
  const heroDisp = useStationDisplay(heroLogo.base, heroLogo.hasLogo);
  // Station identity for the hero: RDS PS / PI-callsign when present, else the
  // callsign resolved from the dial frequency via the FCC DB (heroLogo.base).
  // The NWD tuner sends no RDS PS, so the name comes purely from that lookup,
  // which needs a GPS location. When it can't resolve (no lock yet), the hero
  // shows the frequency as its identity — NEVER an inaccurate "Tuning…".
  const heroIdent = callsign || cleanCall(heroLogo.base ?? '');

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
    // Built-in tuner: use ITS hardware seek — it finds the next real station
    // regardless of GPS/DB. The landed frequency arrives via the tuner callback
    // (freqHz), so there's no client-side sweep to animate here.
    if (onHardwareSeek) { onHardwareSeek(dir); return; }
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
  }, [freqHz, onTuneHz, stopScan, onHardwareSeek]);

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
    if (!off) startFlip(dir);   // §4.7/§8: instant swaps (no hero animation) while audio is released
    const i = activeIndex >= 0 ? activeIndex : (dir > 0 ? -1 : 0);
    const n = ((i + dir) % items.length + items.length) % items.length;
    onTuneHz(Math.round(items[n].frequencyMhz * 1e6));
  }, [items, activeIndex, onTuneHz, startFlip, off]);

  const onNearbyTune = useCallback((st: NearbyStation) => {
    onTuneHz(Math.round(st.frequencyMhz * 1e6));
  }, [onTuneHz]);
  const onNearbySave = useCallback((st: NearbyStation) => {
    onSaveStationPreset(st.callsign, st.frequencyMhz);
  }, [onSaveStationPreset]);

  // Status-bar sub-clusters (design §4.1 v1.5.0). Wide keeps everything inline in
  // a left cluster; tall splits into three zones — signal left, stereo/tells/PTY
  // centered, controls right — so the signal dB stacks below the icon and the
  // stereo column is truly centered regardless of the side widths.
  const signalCluster = (
    <View style={[styles.signalPill, tall && styles.signalPillTall]}>
      {/* NWD has no real signal metric — the bars are a DB+GPS *estimate*, so they
          render grey (not amber) to signal "not live", and the dB number is
          suppressed (we have no measured level). Zero + grey when there's no fix
          or no dataset entry. RTL-SDR keeps the live amber meter + dB readout. */}
      <SignalWaves size={L.signalIcon} strength={off ? 0 : waveStrength(signalDb)} on={nwdActive ? pal.dim : pal.amber} off={pal.meterEmpty} />
      <Text style={[styles.signalText, { fontSize: L.signalDb, color: pal.dim }]}>
        {off ? '--' : nwdActive ? 'EST' : signalDb == null ? '—' : `${Math.round(signalDb)} dB`}
      </Text>
    </View>
  );
  // §4.7 off: the STEREO/MONO pill goes EMPTY (outline, no waves, no text) and all
  // tells drop to their dim/off state.
  const so = stereo && !off;
  const stereoCluster = (
    <View style={styles.stereoCol}>
      <View style={[styles.stereoRow, {
        minHeight: L.stereoH, paddingHorizontal: L.stereoPadH, borderRadius: L.stereoRadius,
        minWidth: L.stereoMinW, borderWidth: 1.5,
        borderColor: so ? pal.blue : pal.border,
        backgroundColor: so ? pal.blueFill : 'transparent',
      }]}>
        {so ? <StereoWave color={pal.blue} flip w={L.stereoWave.w} h={L.stereoWave.h} /> : <View style={{ width: L.stereoWave.w, height: L.stereoWave.h }} />}
        <Text style={[styles.stereoText, { fontSize: L.stereoFont, color: so ? pal.blue : pal.dim }]}>
          {off ? '' : stereo ? 'STEREO' : 'MONO'}
        </Text>
        {so ? <StereoWave color={pal.blue} w={L.stereoWave.w} h={L.stereoWave.h} /> : <View style={{ width: L.stereoWave.w, height: L.stereoWave.h }} />}
      </View>
      <View style={styles.tellStrip}>
        <Tell label="RDS" on={!off && !!rdsOk} pal={pal} fontSize={L.tellFont} dark={dark} off={off} />
        <Tell label="HD" on={false} pal={pal} fontSize={L.tellFont} dark={dark} off={off} />
        {ta && !off ? <Tell label="TA" on pulse pal={pal} fontSize={L.tellFont} dark={dark} off={off} /> : <Tell label="TP" on={!off && !!tp} pal={pal} fontSize={L.tellFont} dark={dark} off={off} />}
        <Tell label="AF" on={!off && !!af} pal={pal} fontSize={L.tellFont} dark={dark} off={off} />
      </View>
    </View>
  );
  const oobEl = !inBand ? (
    <View style={[styles.oobPill, { borderColor: pal.amber }]}>
      <Text style={[styles.oobText, { color: pal.amber }]}>⚠ OUT OF FM BAND</Text>
    </View>
  ) : null;

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
      <View style={[styles.header, GS]}>
        {tunerError ? (
        <View style={[styles.tunerErrPill, { borderColor: pal.amber, backgroundColor: pal.amberFill }]}>
          <WarningTriangle size={26} color={pal.amber} />
          <Text style={[styles.tunerErrText, { color: pal.amber }]} numberOfLines={1}>
            Failure to connect to tuner.
          </Text>
        </View>
        ) : tall ? (
          // Tall (§4.1): three zones — signal (+ OOB) left, stereo/tells/PTY
          // centered, controls right. The two flexed sides center the middle.
          <>
            <View style={styles.zoneSide}>
              {signalCluster}
              {oobEl}
            </View>
            <View style={styles.zoneCenter}>
              {stereoCluster}
              {ptyText && !off ? (
                <Text numberOfLines={1} style={[styles.ptyCentered, { fontSize: L.ptyFont, color: pal.dim }, ptyShadow]}>{ptyText}</Text>
              ) : null}
            </View>
          </>
        ) : (
          // Wide/landscape: everything inline in the left cluster.
          <View style={styles.headerLeft}>
            {signalCluster}
            {stereoCluster}
            {ptyText && !off ? (
              <View style={[styles.ptyWrap, { maxWidth: 200 }]}>
                <Text numberOfLines={1} style={[styles.ptyText, { fontSize: L.ptyFont, color: pal.dim }, ptyShadow]}>{ptyText}</Text>
              </View>
            ) : null}
            {oobEl}
          </View>
        )}
        {/* Right cluster: gear always; in the tall/portrait track the NEARBY disc
            (design: it moves into the top bar) rides beneath it — becoming DONE
            while reordering, since the presets band no longer hosts it here. */}
        <View style={[styles.headerRight, tall && styles.zoneRight]}>
          <View style={styles.headerTopRow}>
            {/* Driving-status icons (§4.6): GPS lock + motion, wide/landscape only. */}
            {!tall ? <DrivingStatusIcons pal={pal} /> : null}
            <Pressable
              onPress={() => setSettingsOpen(true)}
              hitSlop={2}
              style={({ pressed }) => [styles.gearBtn, { borderColor: pal.border, backgroundColor: pal.raised }, pressed && { opacity: 0.55 }]}
              accessibilityRole="button" accessibilityLabel="Settings"
            >
              <GearIcon size={24} color={pal.dim} />
            </Pressable>
          </View>
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
                style={({ pressed }) => [styles.headerNearby, { width: L.s(74), height: L.s(74), borderRadius: L.s(37), backgroundColor: pal.nearbyDisc, borderWidth: 1, borderColor: pal.border }, pressed && { opacity: 0.7 }]}
                accessibilityRole="button" accessibilityLabel="Nearby stations"
              >
                <MagnifierTower size={L.s(59)} line={pal.nearbyLine} glass={pal.nearbyGlass} />
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
        // Hero real-logo sizing (§4.5): the logo box HEIGHT grows as the call sign
        // and/or frequency are hidden (0/1/2 hidden → base/big/max), so the logo
        // keeps filling the freed vertical space regardless of aspect.
        const heroHidden = (heroDisp.showCall ? 0 : 1) + (heroDisp.showFreq ? 0 : 1);
        const heroLogoH = L.s(heroHidden === 0 ? (tall ? 90 : 118) : heroHidden === 1 ? (tall ? 126 : 168) : (tall ? 156 : 210));
        const heroLogoMaxW = (tall ? tallHeroW : L.heroCardW) - L.s(tall ? 60 : 68);
        // Star always sits in the card's top-right corner (both tracks), never
        // inline with the identity.
        const heroStar = (
          <Pressable
            onPress={onToggleSave}
            hitSlop={starSlop}
            style={({ pressed }) => [
              styles.heroStarAbs,
              {
                top: L.s(tall ? 16 : 18), right: L.s(tall ? 16 : 18),
                width: L.star, height: L.star, borderRadius: L.s(16),
                backgroundColor: saved ? pal.blueFill : 'transparent',
                borderWidth: 1, borderColor: saved ? 'transparent' : pal.border,
              },
              GS,   // grayscales with the rest of the face when audio is released
              pressed && { opacity: 0.55 },
            ]}
            accessibilityRole="button"
            accessibilityState={{ selected: saved }}
            accessibilityLabel={saved ? 'Remove this frequency from presets' : 'Save this frequency as a preset'}
          >
            <StarIcon size={L.s(30)} filled={saved} color={pal.amber} outline={pal.dim} />
          </Pressable>
        );
        // §4.7 power button — mirrors the ★, TOP-LEFT, drawn in full colour above the
        // grayscaled hero content. Claims/releases FM audio priority (NOT a mute).
        const heroPower = (
          <PowerButton
            off={off}
            size={L.star}
            radius={L.s(16)}
            pal={pal}
            onClaim={onClaimAudio}
            onRelease={onReleaseAudio}
            style={{ position: 'absolute', zIndex: 7, top: L.s(tall ? 16 : 18), left: L.s(tall ? 16 : 18) }}
          />
        );
        const heroCenter = scan ? (
          <View style={styles.scanWrap}>
            <Text style={[styles.call, { fontSize: L.call, color: pal.dim, fontStyle: 'italic' }]}>
              Scanning…
            </Text>
            <View style={styles.freqRow}>
              <Text style={[styles.scanArrow, { color: pal.dim }]}>{scan.dir > 0 ? '▲' : '▼'}</Text>
              <SlidingFreq value={fmt(scan.display)} dir={scan.dir} fontSize={L.freq} color={pal.amber} />
            </View>
          </View>
        ) : (
          <>
            {heroLogo.hasLogo && heroLogo.uri ? (
              // Real logo REPLACES the big call sign; call sign is a small label beneath.
              <View style={styles.heroLogoCol}>
                <HeroLogo uri={heroLogo.uri} height={heroLogoH} maxWidth={heroLogoMaxW} radius={L.s(16)} />
                {heroDisp.showCall && !!heroIdent ? (
                  <Text numberOfLines={1} style={[styles.heroCallLabel, { fontSize: L.s(tall ? 22 : 26), color: pal.dim }]}>
                    {heroIdent}
                  </Text>
                ) : null}
              </View>
            ) : heroIdent ? (
              // No real logo: big call sign, NO monogram tile on the hero.
              <Text
                numberOfLines={1}
                style={[styles.call, { fontSize: L.call, color: pal.text }]}
              >
                {heroIdent}
              </Text>
            ) : null /* No callsign resolved (NWD with no GPS lock yet): show
                        nothing here and let the frequency below stand as the
                        identity — never the inaccurate "Tuning…". */}
            {/* Always show the frequency when there's no name, even if the user
                turned the freq line off — otherwise the hero would be blank. */}
            {(heroDisp.showFreq || !heroIdent) ? (
              <Pressable
                onPress={() => setNumpadOpen(true)}
                accessibilityRole="button"
                accessibilityLabel={`Frequency ${fmt(mhz)} megahertz. Tap to enter a frequency.`}
              >
                <View style={styles.freqRow}>
                  <SlidingFreq value={fmt(mhz)} dir={seekLandDir.current} fontSize={L.freq} color={pal.amber} />
                </View>
              </Pressable>
            ) : null}
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
                { opacity: isEntering ? flip!.enterOpacity : (off ? 0.28 : PEEK_OPACITY) },   // §4.7: peeks dim further when dead
                GS,
              ]}
            >
              <SidePresetCard name={preset.name} freqMhz={preset.frequencyMhz} pal={pal} side={side} width={peekW} k={k} onPress={onPress} />
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
                off && styles.heroCardFlat,   // §4.7: drop the depth shadow when dead
                flip ? { transform: flip.centerTransform } : null,
              ]}
            >
              {/* Grayscaled content (§4.7); the power button is drawn in colour above it. */}
              <View style={[styles.heroContent, { gap: L.s(14) }, GS]}>
                {heroCenter}
              </View>
              {!scan ? heroStar : null}
              {off ? <View pointerEvents="none" style={[StyleSheet.absoluteFill, { borderRadius: 28, backgroundColor: heroVeilColor }]} /> : null}
              {!scan ? heroPower : null}
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
                <SidePresetCard name={flip.cloneName} pal={pal} side={flip.farSide} width={peekW} k={k} />
              </Animated.View>
            ) : null}
          </View>
        );
        // The RadioText strip is a SIBLING BELOW the hero row (design heroBand =
        // column of [heroRow, rtZone]) — NOT inside the hero card. Keeping it out
        // of the card matches the compact hero + full-width RT bar in the refs.
        const rtBand = (
          <View style={[styles.rtZone, { height: L.rtZoneH }, tall && { marginTop: 'auto', marginBottom: 'auto' }, off && { opacity: 0 }]}>
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
          <View style={[tall ? styles.heroBandTall : styles.heroBand, off && { zIndex: 6 }]}>
            {heroRow}
            {rtBand}
          </View>
        );
      })()}

      {/* §4.7 screen veil — darker veil over the rest of the face; the hero band
          (zIndex 6) rises above it and carries its own lighter veil. */}
      {off ? (
        <View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: screenVeilColor, zIndex: 5 }]} />
      ) : null}

      {/* ── Presets band ── (grows to fill in the tall track; NEARBY + nav move to
          the top bar there, so they're suppressed in-band) */}
      <View style={GS}>
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
        onReorder={onReorderPreset}
        onRemove={onRemovePreset}
        onOpenNearby={() => setPickerOpen(true)}
        onSearchLogo={(i) => {
          const p = items[i];
          if (!p) return;
          // Resolve the real callsign: from the name if it carries one, else from
          // the frequency (FCC DB) — the preset name may be a bare "FM 88.7".
          void (async () => {
            const cs = callsignFrom(p.name);
            const base = cs ? callsignBase(cs) : (await callsignForFreq(p.frequencyMhz));
            setLogoSearch({
              base: base || p.name.toUpperCase().trim(),
              callsign: base || '',           // '' → query is "radio <freq> logo", never junk
              freqMhz: p.frequencyMhz,
              name: p.name,
            });
          })();
        }}
      />
      </View>
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
        nwdActive={!!nwdActive}
        autostart={autostart ?? true}
        theme={theme ?? 'system'}
        onRetryTuner={onRetryTuner}
        onSetAutostart={(on) => onSetAutostart?.(on)}
        onSetTheme={(t) => onSetTheme?.(t)}
        onClose={() => setSettingsOpen(false)}
      />
      {/* Preset logo-search window (design §6.4). */}
      <LogoSearchOverlay
        visible={!!logoSearch}
        pal={pal}
        target={logoSearch}
        onClose={() => setLogoSearch(null)}
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
  headerTopRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  // Tall-track status zones (§4.1 v1.5.0): flexed sides center the wrap-content
  // middle column; the signal side and controls side each take weight 1.
  zoneSide: { flex: 1, minWidth: 0, flexDirection: 'row', flexWrap: 'wrap', alignItems: 'flex-start', gap: 10 },
  zoneCenter: { flexShrink: 0, alignItems: 'center', gap: 5 },
  zoneRight: { flex: 1, alignItems: 'flex-end' },
  headerNearby: { width: 74, height: 74, borderRadius: 37, alignItems: 'center', justifyContent: 'center' },
  headerDoneCheck: { color: '#FFF', fontSize: 22, fontWeight: '700' },
  headerDoneText: { color: '#FFF', fontFamily: FONT_BOLD, fontSize: 11, letterSpacing: 1.5 },
  signalPill: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  // Tall: dB stacks below the icon (design signalWrapStyle column, gap 2).
  signalPillTall: { flexDirection: 'column', gap: 2 },
  signalText: { fontFamily: FONT_BOLD, fontSize: 17, fontVariant: ['tabular-nums'] },
  stereoCol: { alignItems: 'center', gap: 5 },
  ptyCentered: { fontFamily: FONT_BOLD, fontSize: 19, letterSpacing: 0.5, textAlign: 'center', maxWidth: '100%' },
  // STEREO/MONO pill: waves flank the label inside a bordered pill (design
  // stereoStyle). Border/fill colour + min-width set inline from the palette.
  stereoRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 9 },
  waveSpacer: { width: 20, height: 28 },
  stereoText: { fontFamily: FONT_BOLD, fontSize: 15, letterSpacing: 1 },
  tellStrip: { flexDirection: 'row', gap: 10 },
  tell: { fontFamily: FONT_BOLD, fontSize: 11, letterSpacing: 1, lineHeight: 12 },
  // PTY: plain dim ellipsized text — no border/fill (design ptyStyle).
  ptyWrap: { height: 36, justifyContent: 'center' },
  ptyText: { fontFamily: FONT_BOLD, fontSize: 15, letterSpacing: 0.5 },
  oobPill: { borderWidth: 1.5, borderRadius: 10, paddingHorizontal: 10, paddingVertical: 4 },
  oobText: { fontFamily: FONT_BOLD, fontSize: 12, letterSpacing: 0.5 },
  gearBtn: { width: 44, height: 44, borderRadius: 12, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  tunerErrPill: {
    height: 44, paddingHorizontal: 16, borderRadius: 10, borderWidth: 1.5,
    flexDirection: 'row', alignItems: 'center', gap: 11, alignSelf: 'flex-start',
  },
  tunerErrText: { fontFamily: FONT_BOLD, fontSize: 17, letterSpacing: 0.3 },

  hero: { flex: 1, flexDirection: 'row', gap: 0, alignItems: 'center', justifyContent: 'center' },
  // Non-tall hero: a panel card of clamped width (design heroMainStyle,
  // height 98% of the hero row). It sits ABOVE the flanking side preset cards
  // (heroCardZ) so they tuck behind it.
  heroCardWide: {
    borderWidth: 1, borderRadius: 28, paddingVertical: 24, paddingHorizontal: 30,
    height: '98%', alignItems: 'center', justifyContent: 'center', maxWidth: '100%',
    elevation: 8, shadowColor: '#000', shadowOpacity: 0.18, shadowRadius: 22, shadowOffset: { width: 0, height: 14 },
  },
  heroCardZ: { zIndex: 3 },
  // §4.7: the hero content (everything except the colored power button) lives in
  // this stretch-fill wrapper so the grayscale filter can be applied to it alone.
  heroContent: { alignSelf: 'stretch', flexGrow: 1, flexShrink: 1, alignItems: 'center', justifyContent: 'center' },
  heroCardFlat: { elevation: 0, shadowOpacity: 0 },
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
  call: { fontFamily: FONT_BOLD, fontSize: 66, letterSpacing: -1, flexShrink: 1 },
  starBtn: { width: 56, height: 56, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  // Hero real-logo column (§4.5): logo above a small dim call-sign label.
  heroLogoCol: { alignItems: 'center', justifyContent: 'center', gap: 8, maxWidth: '100%' },
  heroCallLabel: { fontFamily: FONT_BOLD, letterSpacing: 0.5, textAlign: 'center' },
  // Star pinned to the hero card corner (both tracks).
  heroStarAbs: { position: 'absolute', zIndex: 4, alignItems: 'center', justifyContent: 'center' },
  freqRow: { flexDirection: 'row', alignItems: 'baseline', gap: 8, marginTop: 6 },
  freq: { fontFamily: FONT_BOLD, fontSize: 60, fontVariant: ['tabular-nums'] },
  mhz: { fontFamily: FONT_BOLD, fontSize: 20,  },
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
