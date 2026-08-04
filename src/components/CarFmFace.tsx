/**
 * CarFmFace — the FM radio face for the CarFM fork, built to the Claude Design
 * handoff (design_handoff_fm_radio_face): header pills, hero band (logo tile +
 * call letters + star + amber frequency + RadioText strip), SEEK/PREV/NEXT side
 * columns, presets band with reorder mode + custom scrollbar + NEARBY disc,
 * plus the direct-entry numpad and Nearby picker modals.
 *
 * Renders as a full-screen opaque layer OVER the existing SDR pipeline (spec §4):
 * RadioScreen keeps doing all the connect / audio / RDS work; this presents the
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
import { useIsMoving } from '../services/motion';
import { useGpsFix } from '../services/gps';
import { blockedWhileDriving, closeOnMotion, subscribeDriveBlocked } from '../services/driveLock';
import LogoTile, { callsignFrom, useStationLogo, useStationDisplay, useDarkLogo } from './carfm/LogoTile';
import LogoSearchOverlay, { type LogoSearchTarget } from './carfm/LogoSearchOverlay';
import NearbyPicker from './carfm/NearbyPicker';
import Numpad from './carfm/Numpad';
import PresetsBand, { type PresetItem } from './carfm/PresetsBand';
import { callsignBase } from '../services/piCallsign';
import { diag } from '../services/diag';
import SidePresetCard, { PEEK_OPACITY, PEEK_SCALE } from './carfm/SidePresetCard';
import SettingsPanel, { type CarFmTheme } from './carfm/SettingsPanel';
import { cleanCall, DARK, FM_MAX_MHZ, FM_MIN_MHZ, FONT, FONT_BOLD, LIGHT, type CarFmPalette } from './carfm/tokens';
import { resolveEgg, eggTokens, areBandFontsReady, subscribeBandFonts } from './carfm/bandThemes';
import { BandGear, AcdcHorn, AcdcBolt, CardFrame } from './carfm/bandArt';

export interface CarFmPreset {
  name: string;
  frequency: number;   // Hz
}

export interface CarFmFaceProps {
  freqHz: number;
  stationName?: string;     // RDS PS
  callsignHint?: string;    // PI-derived callsign (·city), shown only when PS absent
  radioText?: string;       // RDS RT
  /** true = STEREO, false = MONO, null = UNKNOWN (blank pill — nothing has reported yet). */
  stereo: boolean | null;
  signalDb: number | null;
  /** MEASURED bars 0..4 from the built-in tuner's own level read, or null when
   *  there is no reading. Overrides `signalDb` when present — that path is a
   *  GPS+database ESTIMATE and resolves to null on a head unit with no fix.
   *  See services/nwdSignalLevel.ts. UNDER DEVELOPMENT. */
  signalBars?: number | null;
  /** The raw level behind `signalBars`. Shown bare, with NO unit: the scale is
   *  anchored to the vendor's own seek-stop thresholds but its units are
   *  unresolved, and printing "dB" would be inventing one. */
  signalLevelRaw?: number | null;
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
  /** Head-unit preset programming (Settings). Manual only — writing sweeps. */
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
  /** Steering-wheel / media ⏮⏭ preset step from the parent. Bump `seq` (with a
   *  direction) to run the SAME animated stepPreset as the on-screen PREV/NEXT —
   *  hero-swap FLIP + step in DISPLAYED order — instead of a silent tune. */
  hardwareStep?: { dir: 1 | -1; seq: number };
  /** Where the TUNER says it is — device reports only, never our own optimistic
   *  echo of a tune we just requested. `seq` rises on each genuine change and is
   *  what releases the commit-to-target hold below. Null when no built-in tuner
   *  is reporting. */
  device?: { mhz: number; seq: number } | null;
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
  /** The station this swap is heading to. The morph must not start until the
   *  cards actually HOLD the new stations — see the arming effect. */
  targetMhz: number;
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
/**
 * The vehicle-in-motion car (§4.6), and the drive-lock refusal it doubles as.
 *
 * Blocking an action silently reads as the app being broken, so every refusal
 * (services/driveLock) makes this glyph SWELL to ~2.6x for about half a second
 * and settle back — the same tell wherever the block came from.
 *
 * `persistent` is the wide/landscape track, where §4.6 has the car up for as
 * long as the car is moving. The tall track has no driving icons at all in the
 * design, so there the car is drawn ONLY for the length of a flash: the refusal
 * still lands without adding permanent chrome §4.6 doesn't specify. Callers
 * place the non-persistent one absolutely, so appearing shifts no layout.
 */
function MotionCarGlyph({ pal, persistent }: { pal: CarFmPalette; persistent?: boolean }) {
  const moving = useIsMoving();
  const [flashing, setFlashing] = useState(false);
  const pulse = useRef(new Animated.Value(0)).current;
  const block = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (!moving) return;
    const loop = Animated.loop(Animated.sequence([
      Animated.timing(pulse, { toValue: 1, duration: 1300, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
      Animated.timing(pulse, { toValue: 0, duration: 1300, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
    ]));
    loop.start();
    return () => { loop.stop(); pulse.setValue(0); };
  }, [moving, pulse]);

  useEffect(() => subscribeDriveBlocked(() => {
    // Re-trigger cleanly if the driver jabs at a locked control repeatedly:
    // stop whatever is running and replay from the top rather than stacking.
    block.stopAnimation();
    block.setValue(0);
    setFlashing(true);
    Animated.sequence([
      Animated.timing(block, { toValue: 1, duration: 150, easing: Easing.out(Easing.back(1.5)), useNativeDriver: true }),
      Animated.delay(240),
      Animated.timing(block, { toValue: 0, duration: 230, easing: Easing.in(Easing.quad), useNativeDriver: true }),
    ]).start(({ finished }) => { if (finished) setFlashing(false); });
  }), [block]);

  if (!flashing && !(persistent && moving)) return null;

  const opacity = pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 0.4] });
  // The idle breathe and the refusal swell multiply, so a block mid-pulse reads
  // as one movement instead of the two fighting over `scale`.
  const scale = Animated.multiply(
    pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 1.07] }),
    block.interpolate({ inputRange: [0, 1], outputRange: [1, 2.6] }),
  );
  return (
    <Animated.View
      style={{ opacity, transform: [{ scale }], zIndex: 5 }}
      accessibilityLabel={flashing ? 'Not available while driving' : 'Vehicle in motion'}>
      <MotionCar size={34} color={pal.amber} />
    </Animated.View>
  );
}

function DrivingStatusIcons({ pal }: { pal: CarFmPalette }) {
  const { hasFix } = useGpsFix();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
      <MotionCarGlyph pal={pal} persistent />
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
function RadioTextStrip({ text, colors, height = 52, fontSize = 30, maxWidth = 880, fontFamily, letterSpacing, serial }: { text: string; colors: { raised: string; border: string; dim: string; text: string }; height?: number; fontSize?: number; maxWidth?: number; fontFamily?: string; letterSpacing?: number; serial?: string }) {
  const eggType = fontFamily ? { fontFamily } : null;
  const eggTrack = letterSpacing != null ? { letterSpacing } : null;
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
          <Text numberOfLines={1} style={[styles.rtText, { fontSize, color: textColor }, eggType, eggTrack]}>{shown}</Text>
          <Text numberOfLines={1} style={[styles.rtText, { fontSize, color: textColor }, eggType, eggTrack]}>{shown}</Text>
        </Animated.View>
      ) : (
        // Static text clips at the strip edges like the design's overflow:hidden
        // — never an ellipsis (the refs show edge-clipped text, not "…").
        <Text numberOfLines={1} ellipsizeMode="clip" style={[styles.rtText, { fontSize, color: textColor, fontStyle: hasText ? 'normal' : 'italic', textAlign: 'center' }, hasText ? eggType : null, eggTrack]}>
          {shown}
        </Text>
      )}
      {/* Beatles: catalogue-serial stamp, bottom-right of the plate. */}
      {serial ? (
        <Text style={{ position: 'absolute', right: 14, bottom: 6, fontSize: Math.max(11, fontSize * 0.4), color: colors.dim, letterSpacing: 1 }}>{serial}</Text>
      ) : null}
    </View>
  );
}

// ── Themed genre line (§12) ──────────────────────────────────────────────────
// The band-theme genre string, with two optional live behaviours: AC/DC PULSES
// the colour between two ambers; NIN CROSS-FADES through a list of phrases. With
// neither it renders exactly like the plain PTY text (safe drop-in). All timing
// uses useNativeDriver:false so the animated colour and fade share a driver.
function ThemedGenre({ label, cycle, pulse, pulseOn, dark, color, fontFamily, fontSize, style, shadow, outline, droop }: {
  label: string; cycle?: string[]; pulse?: { light: string[]; dark: string[] }; pulseOn?: boolean;
  dark: boolean; color: string; fontFamily?: string; fontSize: number; style: any; shadow?: any;
  outline?: { color: string; width: number }; droop?: boolean;
}) {
  const items = cycle && cycle.length > 1 ? cycle : [label];
  const [idx, setIdx] = useState(0);
  const fade = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    if (items.length < 2) { setIdx(0); return; }
    const id = setInterval(() => {
      Animated.timing(fade, { toValue: 0, duration: 380, useNativeDriver: false }).start(() => {
        setIdx((i) => (i + 1) % items.length);
        Animated.timing(fade, { toValue: 1, duration: 380, useNativeDriver: false }).start();
      });
    }, 3200);
    return () => clearInterval(id);
  }, [items.length, fade]);

  const pulseV = useRef(new Animated.Value(0)).current;
  const ramp = pulse ? (dark ? pulse.dark : pulse.light) : null;
  useEffect(() => {
    if (!pulseOn || !ramp) return;
    const anim = Animated.loop(Animated.sequence([
      Animated.timing(pulseV, { toValue: 1, duration: 720, useNativeDriver: false }),
      Animated.timing(pulseV, { toValue: 0, duration: 720, useNativeDriver: false }),
    ]));
    anim.start();
    return () => anim.stop();
  }, [pulseOn, ramp, pulseV]);
  const animColor: any = pulseOn && ramp ? pulseV.interpolate({ inputRange: [0, 1], outputRange: [ramp[0], ramp[1]] }) : color;

  const edge = outline
    ? { textShadowColor: outline.color, textShadowOffset: { width: 0, height: 0 }, textShadowRadius: outline.width }
    : shadow;
  return (
    <Animated.Text numberOfLines={1} style={[style, { fontSize, color: animColor, opacity: fade }, fontFamily ? { fontFamily } : null, droop ? { transform: [{ rotate: '-4deg' }] } : null, edge]}>
      {items[idx] ?? label}
    </Animated.Text>
  );
}

// ── Hero glitch (§12, NIN) ───────────────────────────────────────────────────
// A DELIBERATELY subtle periodic horizontal jitter on the hero identity — a brief
// ±2dp twitch every ~2s, never sustained, so the type stays readable. Off → the
// children render untouched.
function GlitchWrap({ on, children }: { on: boolean; children: React.ReactNode }) {
  const x = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!on) { x.setValue(0); return; }
    const anim = Animated.loop(Animated.sequence([
      Animated.delay(1900),
      Animated.timing(x, { toValue: 2, duration: 55, useNativeDriver: true }),
      Animated.timing(x, { toValue: -2, duration: 55, useNativeDriver: true }),
      Animated.timing(x, { toValue: 0, duration: 55, useNativeDriver: true }),
    ]));
    anim.start();
    return () => anim.stop();
  }, [on, x]);
  if (!on) return <>{children}</>;
  return <Animated.View style={{ transform: [{ translateX: x }] }}>{children}</Animated.View>;
}

// AC/DC call sign with the SUPPLIED bolt SVG splitting it at its midpoint
// (WI⚡BA — EASTER-EGGS §2.1). RN can't inline SVG inside <Text>, so it's a row:
// firstHalf | bolt | secondHalf. Bolt inherits the text colour (per §2.1.2), which
// on the dark "Back in Black" hero is the explicit silver the caller passes.
function CallWithBolt({ text, style, fontSize, boltColor }: { text: string; style: any; fontSize: number; boltColor: string }) {
  const mid = Math.ceil(text.length / 2);
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center' }}>
      <Text numberOfLines={1} style={style}>{text.slice(0, mid)}</Text>
      <View style={{ marginHorizontal: fontSize * 0.04, transform: [{ translateY: -fontSize * 0.06 }] }}>
        <AcdcBolt color={boltColor} width={fontSize * 0.74} height={fontSize * 1.05} />
      </View>
      <Text numberOfLines={1} style={style}>{text.slice(mid)}</Text>
    </View>
  );
}

// ── Seek digit slide (LOSSY #6 — required) ───────────────────────────────────
// On each frequency change while seeking, the digits enter offset ±14dp with
// opacity 0.25 and settle to 0 / 1 over ~200ms — one two-endpoint transition
// per change (the design's carfm-scan-up/down keyframes expressed as a single
// timing), never a hard swap. dir 0 = ordinary retune, no slide.
function SlidingFreq({ value, dir, fontSize, color, fontFamily, shadow }: {
  value: string; dir: 1 | -1 | 0; fontSize: number; color: string; fontFamily?: string; shadow?: any;
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
    <Animated.Text style={[styles.freq, { fontSize, color, opacity: op, transform: [{ translateY: y }] }, fontFamily ? { fontFamily } : null, shadow]}>
      {value}
    </Animated.Text>
  );
}

// ── Hero real logo (§4.5) ────────────────────────────────────────────────────
// A real logo REPLACES the big call sign on the hero. Fixed HEIGHT (grows as the
// call sign / frequency are hidden); the white plate hugs the logo's width once
// its aspect ratio is known (captured on load), so square badges and wide
// wordmarks both sit tight rather than in a big empty box. Fit — never cropped.
function HeroLogo({ uri, height, maxWidth, radius, dark, darkVariant }: {
  uri: string; height: number; maxWidth: number; radius: number;
  dark: boolean; darkVariant: { uri: string | null; treatment: string | null };
}) {
  const [aspect, setAspect] = useState<number | null>(null);
  // Light mode keeps the white plate. Dark mode drops it for an adapted variant
  // (remap/halo/as-is read on the hero card itself); the PLATE treatment gets a
  // grey plate; a not-yet-adapted logo keeps the white plate so it stays visible.
  let src = uri, bg = '#FFFFFF', px = 8, py = 4, br = radius;
  if (dark) {
    if (darkVariant.uri) {
      src = darkVariant.uri;
      if (darkVariant.treatment === 'PLATE') { bg = '#E6E6E6'; px = Math.round(height * 0.11); py = px; br = Math.round(height * 0.14); }
      else { bg = 'transparent'; px = 0; py = 0; }
    }
  }
  // LOGO-SIZING §2: the IMAGE height is pinned to the table value; width follows
  // the logo's own aspect, capped by the card's content width (§2.3 — an extreme
  // wordmark hits the width cap and renders shorter; Fit, never crop). The plate
  // shrink-wraps the image, adding ONLY its 4/8 padding — no box of its own.
  // Before onLoad reports the real aspect, assume the 16/10 landscape shape the
  // rest of the face uses for logo plates — otherwise the plate would render one
  // frame at the FULL card width (a wide white flash) and then snap in.
  const imgW = Math.min(maxWidth - px * 2, Math.round(height * (aspect ?? 1.6)));
  return (
    <View style={{
      borderRadius: br, backgroundColor: bg,
      paddingVertical: py, paddingHorizontal: px, overflow: 'hidden',
      alignItems: 'center', justifyContent: 'center',
    }}>
      <Image
        source={{ uri: src }}
        onLoad={(e) => {
          const s = e.nativeEvent.source as { width?: number; height?: number };
          if (s?.width && s?.height) setAspect(s.width / s.height);
        }}
        style={{ width: imgW, height }}
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
    freqHz, stationName, callsignHint, radioText, stereo, signalDb, signalBars, signalLevelRaw,
    rdsOk, tp, ta, af, ptyText, tunerError, theme, autostart,
    onSetAutostart, onSetTheme, onRetryTuner, presets, nwdActive, onHardwareSeek,
    onTuneHz, onToggleSave, onReorderPreset, onRemovePreset, onSaveStationPreset,
    audioActive, onClaimAudio, onReleaseAudio, hardwareStep, device,
  } = props;
  const insets = useSafeAreaInsets();
  const scheme = useColorScheme();
  const basePal = (theme === 'light' || (theme !== 'dark' && scheme === 'light')) ? LIGHT : DARK;
  const dark = basePal === DARK;
  // Audio priority released (§4.7): the whole face goes flat/grayscale + "dead".
  // `off` gates the grayscale filter, veils, depth removal and indicator off-states.
  const off = audioActive === false;
  // Band theme (§12): match the live RadioText to an artist (or take a forced id
  // from the settings secret panel). Cosmetic only; suppressed while audio is
  // released. Forced id is session-only (never persisted, per the spec).
  const [forcedEgg, setForcedEgg] = useState<string | null>(null);
  const egg = resolveEgg({ rt: radioText, forcedId: forcedEgg, dark, pal: basePal, off });
  const eggTk = eggTokens(egg, basePal);
  // Fold the theme's accent restatement into the palette so every interactive
  // element (active preset, star, stereo lock, Nearby/Done) recolours at once.
  // `dark` above intentionally uses basePal (identity), not this merged palette.
  const pal = egg ? { ...basePal, blue: eggTk.blue, blueFill: eggTk.blueFill } : basePal;
  // Themed surfaces (cosmetic overrides; default tokens when no egg).
  const pageBg = egg?.pageBg ?? pal.bg;
  const heroCardBg = egg?.card?.bg ?? pal.panel;
  const heroCardBorder = egg?.card?.border ?? pal.border;
  const heroCardText = egg?.card?.text ?? pal.text;
  // Genre/PTY line: a theme can replace the text and restyle its colour. (Pulse,
  // cross-fade cycle and outline ring are ornament — deferred to the art pass.)
  const genreLabel = egg?.genreText ?? ptyText;
  const genreColor = egg?.genreColor ?? pal.dim;
  // A theme that suppresses logos forces the call-sign identity so its own type
  // reads (hero here; preset/peek suppression rides in the art pass).
  const eggHideLogos = !!egg?.suppressLogos;
  // Themed type — applied only once the display faces are bundled (BAND_FONTS_READY).
  // Values are registered RN family names; undefined → the default face falls through.
  const [bandFonts, setBandFonts] = useState(areBandFontsReady());
  useEffect(() => subscribeBandFonts(() => setBandFonts(areBandFontsReady())), []);
  const eggFontOn = bandFonts && !!egg;
  // Beatles hero stays PLAIN (EASTER-EGGS §4: the SgtPeppers cut is outline-only and
  // its intended solid/lined treatments can't be produced — no hero font, no effects).
  const eggHeroFont = eggFontOn && egg?.motif !== 'submarine' ? (egg?.heroFont ?? egg?.font) : undefined;
  const eggFreqFont = eggFontOn ? egg?.freqFont : undefined;
  const eggRtFont = eggFontOn ? (egg?.rtFont ?? egg?.font) : undefined;
  const eggGenreFont = eggFontOn ? (egg?.genreFont ?? egg?.font) : undefined;
  // Hero-identity lettering (§12). RN Text carries one shadow, so nameGhost (a
  // hard drop-shadow) and nameOutline (approximated as a soft ring — RN has no
  // real text stroke) are mutually exclusive, which matches the registry (no egg
  // sets both). nameBlock wraps the identity in a solid slab (Talking Heads).
  const eggNameShadow: any = egg?.nameGhost
    ? { textShadowColor: egg.nameGhost.color, textShadowOffset: { width: egg.nameGhost.dx, height: egg.nameGhost.dy }, textShadowRadius: 0 }
    : egg?.nameOutline
    ? { textShadowColor: egg.nameOutline.stroke, textShadowOffset: { width: 0, height: 0 }, textShadowRadius: Math.max(1, egg.nameOutline.width) }
    : null;
  const eggFreqShadow: any = egg?.freqShadow
    ? { textShadowColor: egg.freqShadow.color, textShadowOffset: { width: egg.freqShadow.dx, height: egg.freqShadow.dy }, textShadowRadius: 0 }
    : null;
  // Hero/freq type metrics — only meaningful with the display faces loaded.
  const eggHeroScale = eggFontOn ? (egg?.heroScale ?? 1) : 1;
  const eggHeroTrack = eggFontOn ? egg?.heroTrack : undefined;
  const eggFreqScale = eggFontOn ? (egg?.freqScale ?? 1) : 1;
  const eggHeroType = { fontFamily: eggHeroFont ?? styles.call.fontFamily, letterSpacing: eggHeroTrack };
  const caseIdent = (s: string) => (egg?.heroCase === 'lower' ? s.toLowerCase() : s);
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
  // Drive lock: if the car pulls away mid-edit, close reorder mode itself. The
  // subscription only exists while the mode is open, so the face doesn't
  // re-render on motion the rest of the time (the car glyph self-subscribes).
  useEffect(() => {
    if (!reordering) return;
    return closeOnMotion(() => setReordering(false));
  }, [reordering]);
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
  // Landscape breakpoint at 500 (was 480): the landscape reference surface is
  // 1080×486 (LOGO-SIZING §1, and this file's own k ramp divides by h/486), so
  // h<480 could never fire on the very surface the branch is sized for.
  const landscape = !tall && h < 500;
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
      freq: s(tall ? 64 : landscape ? 56 : 78),
      mhz: s(tall ? 20 : landscape ? 18 : 22),
      call: s(tall ? 62 : landscape ? 60 : 94),
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

  // Report the surface the face actually resolved to. Logo sizes are all derived
  // from track + k, so when a logo looks wrong on the unit this line says whether
  // the cause is the SIZE TABLE or the surface landing in an unexpected track.
  const trackSig = `${w}x${h} ${tall ? 'tall' : landscape ? 'landscape' : twoRows ? 'twoRows' : 'wide'} k=${k.toFixed(2)}`;
  const lastTrack = useRef('');
  useEffect(() => {
    if (lastTrack.current === trackSig) return;
    lastTrack.current = trackSig;
    diag(`surface ${trackSig} | hero logo tiers ${[0, 1, 2].map((n) => Math.min(
      L.s(n === 0 ? (tall ? 108 : landscape ? 120 : 144)
        : n === 1 ? (tall ? 152 : landscape ? 171 : 205)
        : (tall ? 188 : landscape ? 215 : 256)),
      Math.round(h * 0.42)).toString()).join('/')}`);
  }, [trackSig, tall, landscape, h, L]);

  // ── Commit-to-target: gloss over the two-tune wrestle ──────────────────────
  // A wheel press makes the vendor radio service tune to ITS preset slot, and
  // CarFM then tunes over the top to the app's (see NwdRadioModule panel keys).
  // Both tunes emit frequency/PS callbacks, so every value derived from the live
  // dial churns mid-change: the hero shows the old station, flips between old and
  // new, briefly shows a THIRD preset (the service's own drifting slot pointer),
  // and the preset highlight jitters between two or three tiles.
  //
  // So a deliberate, bounded exception to showing the truth: from the moment a
  // preset change is committed until the dial settles on it, the FACE renders the
  // TARGET and ignores the live tuner. Purely cosmetic and time-boxed; outside
  // this window the face is honest as always, and if the tune ends up somewhere
  // else the display corrects when the lock lifts.
  //
  // This also fixes a real bug, not just a visual one: stepPreset derived "next"
  // from the LIVE frequency, so a second press arriving mid-wrestle stepped from
  // whatever the vendor service had landed on — walking the wrong way through the
  // list. The pending target is now the source of truth for stepping.
  const rawMhz = mhzOf(freqHz);
  // `sinceSeq` is the device-report counter as of the commit: only a LATER report
  // can release the hold.
  const [pending, setPending] = useState<{ mhz: number; name: string; sinceSeq: number } | null>(null);
  // Release on the DEVICE's word, not on `rawMhz`. onTuneHz writes the requested
  // frequency into status.frequency synchronously, so rawMhz already EQUALS the
  // target by the time this effect first runs — the old comparison released the
  // hold in the same commit that opened it, always. The 30 July drive log shows it
  // exactly: six steps, six instant "settled" lines, not one "holding" line, and
  // the vendor's transit frequencies painting the hero for ~1 s after each.
  //
  // With no built-in tuner (device == null) there is no second opinion to wait
  // for, so fall back to rawMhz and let the cap do the bounding.
  useEffect(() => {
    if (!pending) return;
    if (!device) {
      if (Math.abs(rawMhz - pending.mhz) < 0.05) {
        diag(`face: settled on ${pending.mhz.toFixed(1)} — hold released`);
        setPending(null);
      }
      return;
    }
    if (device.seq <= pending.sinceSeq) return;   // nothing new from the tuner yet
    // Settled: the TUNER itself reported the target → resume honest rendering.
    if (Math.abs(device.mhz - pending.mhz) < 0.05) {
      diag(`face: settled on ${pending.mhz.toFixed(1)} — hold released`);
      setPending(null); return;
    }
    // The vendor service steps ITS OWN preset list on the same wheel press, so
    // the dial visits frequencies we never asked for. Log each one we ride out.
    diag(`face: holding ${pending.mhz.toFixed(1)}, dial went to ${device.mhz.toFixed(1)}`);
  }, [pending, device, rawMhz]);

  // Cap: never let a failed or ignored tune freeze the display. On expiry the face
  // simply shows reality again (fading, not snapping — the values it reads are the
  // same ones it was already animating).
  //
  // Keyed on `pending` ALONE so the 2 s runs from the moment of commit. Keying it
  // on the dial as well would restart the clock on every transit report the vendor
  // emits, which is exactly the churn the cap exists to bound.
  useEffect(() => {
    if (!pending) return;
    const t = setTimeout(() => {
      diag(`face: HOLD CAP expired — target ${pending.mhz.toFixed(1)} never reached`);
      setPending(null);
    }, 2000);
    return () => clearTimeout(t);
  }, [pending]);

  /** Commit the face to a station before the tuner gets there. */
  const deviceSeqRef = useRef(0);
  deviceSeqRef.current = device?.seq ?? 0;
  const commitTo = useCallback((targetMhz: number, name: string) => {
    setPending({ mhz: targetMhz, name, sinceSeq: deviceSeqRef.current });
  }, []);

  // Everything below derives from the EFFECTIVE dial: the committed target while a
  // change is in flight, the real one otherwise.
  const mhz = pending ? pending.mhz : rawMhz;
  const inBand = mhz >= FM_MIN_MHZ - 0.05 && mhz <= FM_MAX_MHZ + 0.05;
  // RDS from the outgoing station is stale the instant a change is committed, and
  // it drives the hero identity AND the band theme — so hold it steady through the
  // window rather than letting a stale PS name or a themed palette flash past.
  const psRaw = (stationName ?? '').trim();
  const rtRaw = (radioText ?? '').trim();
  const heldRds = useRef({ ps: psRaw, rt: rtRaw });
  if (!pending) heldRds.current = { ps: psRaw, rt: rtRaw };
  // While pending, drop PS entirely: identity then resolves from the TARGET
  // frequency via the FCC lookup, which is exactly the station we're moving to.
  const ps = pending ? '' : psRaw;
  const rt = pending ? heldRds.current.rt : rtRaw;
  const callsign = cleanCall(ps || callsignHint || '');
  // Hero real-logo model (§4.5): a real logo replaces the big call sign, which
  // becomes a small label beneath; no logo → big call sign, no monogram. The
  // per-station Display Call Sign / Frequency flags hide those on the hero and
  // the logo grows to reclaim the freed space.
  const heroLogo = useStationLogo(callsign || undefined, mhz);
  const heroDarkLogo = useDarkLogo(heroLogo.base, dark && !!heroLogo.uri);
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
  // LOGO-SIZING §4: peek card = 20% of surface width, capped at 206, on EVERY
  // track (the tall surfaces land ~94–97 straight from the 20%). No minimum.
  const sideCardW = Math.min(L.s(206), Math.round(w * 0.2));
  // Tall/portrait track sizing: a narrower hero card (82%) flanked by smaller
  // peek cards tucked tight. The design's reference screenshots (surface-portrait
  // / surface-slice-one-third) show the peek cards present on the tall track too,
  // not just wide — so they render in every track, only the sizing differs.
  const tallHeroW = Math.min(L.s(560), Math.round(w * 0.82));
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
  // Latched separately from `flip` so a later dial change cannot re-trigger or
  // restart a morph that is already running.
  const [flipArmed, setFlipArmed] = useState(false);
  const flipProg = useRef(new Animated.Value(0)).current;

  const startFlip = useCallback((dir: 1 | -1, targetMhz: number): boolean => {
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
    setFlipArmed(false);
    setFlip({
      dir, nearSide, farSide, centerTransform, landTransform,
      enterOpacity: new Animated.Value(0),
      cloneOpacity: new Animated.Value(PEEK_OPACITY),
      cloneRect: landing, cloneName, targetMhz,
    });
    return true;
  }, [slotRects, prevP, nextP, flipProg]);

  // ARM the morph only once the cards actually HOLD the new stations.
  //
  // This is a FLIP: at progress 0 every card is placed at its PRE-swap geometry,
  // so the morph is only meaningful if the slots already contain the post-swap
  // content. They did not. `setFlip` and the commit-to-target were separate state
  // updates, and the animation — running on the UI thread via the native driver —
  // began before the new content had mounted. So the morph played out on the OLD
  // cards: on a NEXT press the video shows the LEFT peek growing into the centre
  // and the old hero shrinking to the RIGHT, which is the PREV motion, and then
  // the content snaps to the correct arrangement partway through. That is the
  // "card slides in and becomes a different station" reported on 31 July.
  //
  // Holding at progress 0 is free: it is exactly where the cards already are, so
  // waiting shows no movement at all rather than a wrong one.
  //
  // Two gates, and they are guarding different things. `mhz` reaching the target
  // proves the JS side committed the swap — but `pending` sets that synchronously,
  // so on its own it is nearly a no-op. The real lag is the NATIVE MOUNT: the
  // morph is native-driven and starts on the UI thread as soon as .start() is
  // called, while the new card content is still being mounted. Hence one frame of
  // slack. One frame is enough now that the hero resolves its identity, logo and
  // size tier in a single render; when each of those was its own async round trip
  // the content could trail by ~150ms and no fixed delay would have been right.
  useEffect(() => {
    if (!flip || flipArmed) return;
    if (Math.abs(mhz - flip.targetMhz) < 0.05) {
      const r = requestAnimationFrame(() => setFlipArmed(true));
      return () => cancelAnimationFrame(r);
    }
    // A tune that never lands must not freeze the cards in the pre-swap pose.
    // Dropping the descriptor returns them to their resting layout.
    const bail = setTimeout(() => {
      diag(`face: FLIP dropped — content never reached ${flip.targetMhz.toFixed(1)}`);
      setFlip(null);
    }, 400);
    return () => clearTimeout(bail);
  }, [flip, flipArmed, mhz]);

  // Run the four animations once the descriptor is in place AND armed.
  useEffect(() => {
    if (!flip || !flipArmed) return;
    const anim = Animated.parallel([
      Animated.timing(flipProg, { toValue: 1, duration: 520, easing: Easing.linear, useNativeDriver: true }),
      Animated.timing(flip.cloneOpacity, { toValue: 0, duration: 520, easing: Easing.bezier(0.25, 0.1, 0.25, 1), useNativeDriver: true }),
      Animated.timing(flip.enterOpacity, { toValue: PEEK_OPACITY, duration: 520, delay: 120, easing: Easing.bezier(0.25, 0.1, 0.25, 1), useNativeDriver: true }),
    ]);
    anim.start(({ finished }) => { if (finished) setFlip(null); });
    return () => anim.stop();
    // flipArmed MUST be here. It is read above, and arming happens a frame AFTER
    // the descriptor is set — so without it this effect runs once, while armed is
    // still false, returns early, and never runs again. The morph then never
    // starts: progress stays at 0 (pre-swap geometry) and the descriptor is never
    // cleared, because setFlip(null) only happens in the completion callback. The
    // cards sit in the wrong places with no movement until the next step.
  }, [flip, flipArmed, flipProg]);

  const measureSlot = useCallback((slot: 'left' | 'center' | 'right') => (e: LayoutChangeEvent) => {
    const { x, y, width, height } = e.nativeEvent.layout;
    slotRects[slot] = { x, y, w: width, h: height };
  }, [slotRects]);

  // PREV/NEXT step through presets in their DISPLAYED order (wrapping). Fire the
  // hero-swap FLIP first (it captures resting geometry), then tune.
  const stepPreset = useCallback((dir: 1 | -1) => {
    if (items.length === 0) { diag('face: step ignored — no presets'); return; }
    // §4.7/§8: instant swaps (no hero animation) while audio is released.
    // startFlip returns false when the slots are unmeasured or there is no
    // prev/next card — a silent no-animation case worth naming in the log.
    // activeIndex already reflects the committed target (it derives from the
    // effective dial), so rapid presses walk the list one step at a time instead
    // of re-deriving from whatever the vendor service last tuned.
    const i = activeIndex >= 0 ? activeIndex : (dir > 0 ? -1 : 0);
    const n = ((i + dir) % items.length + items.length) % items.length;
    // The target must be known BEFORE the descriptor is built — the morph is
    // armed against it, so it can wait for the cards to hold the new stations.
    const flipped = off ? false : startFlip(dir, items[n].frequencyMhz);
    diag(`face: step ${dir > 0 ? '+1' : '-1'} idx ${i}→${n} of ${items.length}, `
       + `target ${items[n].frequencyMhz.toFixed(1)} "${items[n].name}"`
       + `${flipped ? '' : off ? ' [flip skipped: audio released]' : ' [FLIP SKIPPED]'}`);
    commitTo(items[n].frequencyMhz, items[n].name);
    onTuneHz(Math.round(items[n].frequencyMhz * 1e6));
  }, [items, activeIndex, onTuneHz, startFlip, off, commitTo]);

  // Steering-wheel / media ⏮⏭ (parent bumps hardwareStep.seq): run the animated
  // stepPreset so the wheel gets the hero-swap FLIP and steps in DISPLAYED order —
  // exactly like the on-screen PREV/NEXT, not a silent frequency jump.
  const lastHwSeq = useRef(hardwareStep?.seq ?? 0);
  useEffect(() => {
    if (!hardwareStep || hardwareStep.seq === lastHwSeq.current) return;
    lastHwSeq.current = hardwareStep.seq;
    stepPreset(hardwareStep.dir);
  }, [hardwareStep, stepPreset]);

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
    <View style={[styles.signalPill, tall && styles.signalPillTall, !tall && { minHeight: L.stereoH, justifyContent: 'center' }]}>
      {/* Three cases, and only the first is a real measurement.
          MEASURED (signalBars non-null): the built-in tuner's own level read.
            Amber like the SDR meter, because it IS live, and the raw number is
            shown BARE — the scale is anchored to the vendor's seek-stop
            thresholds but its units are unresolved, so "dB" would be a lie.
          SDR: live amber bars + a genuine dB figure.
          ESTIMATE: grey bars and the word EST. On this head unit the estimate
            needs a GPS fix it never gets, so it renders as an empty icon —
            which is exactly what it has always been. */}
      <SignalWaves
        size={L.signalIcon}
        strength={off ? 0 : signalBars != null ? signalBars : waveStrength(signalDb)}
        on={nwdActive && signalBars == null ? pal.dim : pal.amber}
        off={pal.meterEmpty}
      />
      <Text style={[styles.signalText, { fontSize: L.signalDb, color: pal.dim }]}>
        {off ? '--'
          : signalLevelRaw != null ? `${signalLevelRaw}`
          : nwdActive ? 'EST'
          : signalDb == null ? '—' : `${Math.round(signalDb)} dB`}
      </Text>
    </View>
  );
  // §4.7 off: the STEREO/MONO pill goes EMPTY (outline, no waves, no text) and all
  // tells drop to their dim/off state. stereo === null (nothing has reported yet)
  // renders that same empty pill — asserting MONO before the tuner speaks would be
  // a guess, and on this firmware it was a wrong one.
  const so = stereo === true && !off;
  const stereoBlank = off || stereo == null;
  // AC/DC bolt art (supplied PNGs) flanking the STEREO pill (EASTER-EGGS §2.1):
  // slot 20×28 wide / 28×40 tall, art height 24/34, −2 outward inset, dark-filtered.
  const fanFilter: any = egg?.stereoArtFilter ? { filter: [{ grayscale: 1 }, { brightness: 2.3 }, { contrast: 0.85 }] } : null;
  const stereoFan = (side: 'left' | 'right') => egg?.stereoArtL ? (
    <Image
      resizeMode="contain"
      source={side === 'left' ? require('../../assets/fan-l2.png') : require('../../assets/fan-r2.png')}
      style={[{ width: L.s(tall ? 28 : 20), height: L.s(tall ? 34 : 24),
        marginRight: side === 'left' ? L.s(-2) : 0, marginLeft: side === 'right' ? L.s(-2) : 0 }, fanFilter] as any}
    />
  ) : null;
  const stereoCluster = (
    <View style={styles.stereoCol}>
      <View style={{ flexDirection: 'row', alignItems: 'center' }}>
      {stereoFan('left')}
      <View style={[styles.stereoRow, {
        minHeight: L.stereoH, paddingHorizontal: L.stereoPadH, borderRadius: L.stereoRadius,
        minWidth: L.stereoMinW, borderWidth: 1.5,
        borderColor: so ? pal.blue : pal.border,
        backgroundColor: so ? pal.blueFill : 'transparent',
      }]}>
        {so ? <StereoWave color={pal.blue} flip w={L.stereoWave.w} h={L.stereoWave.h} /> : <View style={{ width: L.stereoWave.w, height: L.stereoWave.h }} />}
        <Text style={[styles.stereoText, { fontSize: L.stereoFont, color: so ? pal.blue : pal.dim }]}>
          {stereoBlank ? '' : stereo ? 'STEREO' : 'MONO'}
        </Text>
        {so ? <StereoWave color={pal.blue} w={L.stereoWave.w} h={L.stereoWave.h} /> : <View style={{ width: L.stereoWave.w, height: L.stereoWave.h }} />}
      </View>
      {stereoFan('right')}
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
      style={[styles.stage, { backgroundColor: pageBg, paddingTop: insets.top, paddingBottom: insets.bottom }]}
    >
      {/* Responsive face (ANDROID §0): laid out directly at the real available
          dp — no design canvas, no uniform scale. Tracks reflow per surface and
          the token ramp (L) re-derives the spec's dp for this surface. */}
      <View style={[styles.face, { backgroundColor: pageBg, paddingHorizontal: L.padH, gap: L.gap, paddingVertical: L.padTop }]}>
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
              {genreLabel && !off ? (
                <ThemedGenre label={genreLabel} cycle={egg?.genreCycle} pulse={egg?.genrePulse} pulseOn={egg?.genrePulseOn} outline={egg?.genreOutline} droop={egg?.genreDroop} dark={dark} color={genreColor} fontFamily={eggGenreFont} fontSize={L.ptyFont} style={styles.ptyCentered} shadow={ptyShadow} />
              ) : null}
            </View>
          </>
        ) : (
          // Wide/landscape: everything inline in the left cluster.
          <View style={styles.headerLeft}>
            {signalCluster}
            {stereoCluster}
            {genreLabel && !off ? (
              <View style={[styles.ptyWrap, { maxWidth: 200, height: L.stereoH }]}>
                <ThemedGenre label={genreLabel} cycle={egg?.genreCycle} pulse={egg?.genrePulse} pulseOn={egg?.genrePulseOn} outline={egg?.genreOutline} droop={egg?.genreDroop} dark={dark} color={genreColor} fontFamily={eggGenreFont} fontSize={L.ptyFont} style={styles.ptyText} shadow={ptyShadow} />
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
            {/* Driving-status icons (§4.6): GPS lock + motion, wide/landscape only.
                The tall track gets no persistent driving icons (§4.6 doesn't give
                it any), but a drive-lock refusal still has to be visible — so the
                car appears there for the flash alone, absolutely placed left of
                the gear so its arrival shifts nothing. */}
            {!tall ? <DrivingStatusIcons pal={pal} /> : (
              <View pointerEvents="none" style={styles.tallDriveFlash}>
                <MotionCarGlyph pal={pal} />
              </View>
            )}
            <Pressable
              onPress={() => setSettingsOpen(true)}
              hitSlop={2}
              style={({ pressed }) => [styles.gearBtn, { borderColor: pal.border, backgroundColor: pal.raised }, pressed && { opacity: 0.55 }]}
              accessibilityRole="button" accessibilityLabel="Settings"
            >
              {egg ? <BandGear motif={egg.motif} size={24} color={egg.settingsBoltColor ?? egg.accent} /> : <GearIcon size={24} color={pal.dim} />}
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
        // Hero logo growth (LOGO-SIZING §2.1): three tiers, stepping up as the
        // call-sign / frequency rows are hidden — both hidden is the logo default
        // and the largest. `landscape` is its OWN branch, not the generic wide one.
        //
        // The tier VALUES sit above the handoff's table (210/176/156 at the top
        // tier) because that table measured SMALLER than the size already approved
        // on the head unit — shipping it shrank every logo. §2.2/§7 state the
        // acceptance as a floor ("anything below is a fail", "reject if less than
        // ~31%"), so a larger logo still passes; the device is the tie-breaker.
        // The handoff's RATIOS between tiers (0.56 / 0.80 / 1.00) are preserved.
        const heroLogoH = Math.min(
          L.s(heroHidden === 0 ? (tall ? 108 : landscape ? 120 : 144)
            : heroHidden === 1 ? (tall ? 152 : landscape ? 171 : 205)
            : (tall ? 188 : landscape ? 215 : 256)),
          // Never let the logo eat the whole card on a short surface.
          Math.round(h * 0.42));
        // §2: maxWidth = 100% of the hero card's CONTENT width (card width minus
        // its own horizontal padding — s(26)/s(30) per side).
        const heroLogoMaxW = (tall ? tallHeroW : L.heroCardW) - L.s(tall ? 52 : 60);
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
              <SlidingFreq value={fmt(scan.display)} dir={scan.dir} fontSize={L.freq} color={pal.amber} fontFamily={eggFreqFont} shadow={eggFreqShadow} />
            </View>
          </View>
        ) : (
          <>
            {heroLogo.hasLogo && heroLogo.uri && !eggHideLogos ? (
              // Real logo REPLACES the big call sign; call sign is a small label beneath.
              // A band theme that suppresses logos falls through to the call-sign form.
              <View style={styles.heroLogoCol}>
                <HeroLogo uri={heroLogo.uri} height={heroLogoH} maxWidth={heroLogoMaxW} radius={L.s(16)} dark={dark} darkVariant={heroDarkLogo} />
                {heroDisp.showCall && !!heroIdent ? (
                  <Text numberOfLines={1} style={[styles.heroCallLabel, { fontSize: L.s(tall ? 22 : 26), color: pal.dim }]}>
                    {heroIdent}
                  </Text>
                ) : null}
              </View>
            ) : heroIdent ? (
              // No real logo (or theme suppresses it): big call sign, no monogram tile.
              // AC/DC flanks it with lightning bolts (design's callSignBolt). NIN
              // twitches the whole identity (heroGlitch).
              <GlitchWrap on={!!egg?.heroGlitch}>{
              egg?.callSignBolt ? (
                // AC/DC: the supplied bolt SVG splits the call sign at its midpoint.
                <CallWithBolt
                  text={caseIdent(heroIdent)}
                  fontSize={L.call * eggHeroScale}
                  boltColor={dark ? '#C9C9C9' : heroCardText}
                  style={[styles.call, { fontSize: L.call * eggHeroScale, color: heroCardText }, eggHeroType, eggNameShadow]}
                />
              ) : egg?.nameBlock ? (
                // Talking Heads: the identity sits in a solid colour slab.
                <View style={{ backgroundColor: egg.nameBlock.bg, paddingHorizontal: L.s(16), paddingTop: L.s(2), paddingBottom: L.s(6), borderRadius: L.s(3) }}>
                  <Text numberOfLines={1} style={[styles.call, { fontSize: L.call * eggHeroScale, color: egg.nameBlock.color }, eggHeroType, eggNameShadow]}>{caseIdent(heroIdent)}</Text>
                </View>
              ) : (
                <Text
                  numberOfLines={1}
                  style={[styles.call, { fontSize: L.call * eggHeroScale, color: heroCardText }, eggHeroType, eggNameShadow]}
                >
                  {caseIdent(heroIdent)}
                </Text>
              )
              }</GlitchWrap>
            ) : null /* No callsign resolved (NWD with no GPS lock yet): show
                        nothing here and let the frequency below stand as the
                        identity — never the inaccurate "Tuning…". */}
            {/* Always show the frequency when there's no name, even if the user
                turned the freq line off — otherwise the hero would be blank. */}
            {(heroDisp.showFreq || !heroIdent) ? (
              <Pressable
                onPress={() => setNumpadOpen(true)}
                style={({ pressed }) => (pressed ? { opacity: 0.6 } : null)}
                accessibilityRole="button"
                accessibilityLabel={`Frequency ${fmt(mhz)} megahertz. Tap to enter a frequency.`}
              >
                <View style={styles.freqRow}>
                  <SlidingFreq value={fmt(mhz)} dir={seekLandDir.current} fontSize={L.freq * eggFreqScale} color={pal.amber} fontFamily={eggFreqFont} shadow={eggFreqShadow} />
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
        const peekW = sideCardW;
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
              <SidePresetCard name={preset.name} freqMhz={preset.frequencyMhz} pal={pal} side={side} width={peekW} k={k} onPress={onPress} suppressLogo={eggHideLogos} />
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
                  width: tall ? tallHeroW : L.heroCardW, backgroundColor: heroCardBg, borderColor: heroCardBorder,
                  paddingVertical: L.s(tall ? 30 : 24), paddingHorizontal: L.s(tall ? 26 : 30), gap: L.s(14),
                },
                off && styles.heroCardFlat,   // §4.7: drop the depth shadow when dead
                flip ? { transform: flip.centerTransform } : null,
              ]}
            >
              {/* Concentric ring frame — Beatles drum-hoop / Talking Heads double rule. */}
              {egg?.cardFrame ? <CardFrame rings={egg.cardFrame.rings} radius={28} /> : null}
              {/* AC/DC horns (EASTER-EGGS §2.1) — the SUPPLIED SVGs, overhanging the
                  hero card's top corners (left top:-44/left:-16, right top:-44/right:-16);
                  they carry their own baked red stroke + glow and rotation. */}
              {egg?.horns ? (
                <>
                  <View pointerEvents="none" style={{ position: 'absolute', top: L.s(-44), left: L.s(-16), zIndex: 4 }}>
                    <AcdcHorn side="left" w={L.s(70)} h={L.s(96)} />
                  </View>
                  <View pointerEvents="none" style={{ position: 'absolute', top: L.s(-44), right: L.s(-16), zIndex: 4 }}>
                    <AcdcHorn side="right" w={L.s(70)} h={L.s(96)} />
                  </View>
                </>
              ) : null}
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
                <SidePresetCard name={flip.cloneName} pal={pal} side={flip.farSide} width={peekW} k={k} suppressLogo={eggHideLogos} />
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
              colors={egg?.rtPlate
                ? { raised: egg.rtPlate.bg, border: egg.rtPlate.border, dim: pal.dim, text: egg.rtPlate.text }
                : { raised: pal.raised, border: pal.border, dim: pal.dim, text: pal.text }}
              fontFamily={eggRtFont}
              letterSpacing={egg?.rtSpacing}
              serial={egg?.rtPlate?.serial}
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
        suppressLogos={eggHideLogos}
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
        onSelect={(p) => { commitTo(p.frequencyMhz, p.name); onTuneHz(Math.round(p.frequencyMhz * 1e6)); }}
        // Drive lock: rearranging presets is a two-handed, eyes-down task.
        onEnterReorder={() => { if (blockedWhileDriving()) return; setReordering(true); }}
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
        forcedEggId={forcedEgg}
        onForceEgg={setForcedEgg}
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
  // flex-start so signal + genre align to the STEREO pill's band (the RDS/HD/TP/AF
  // tell strip hangs BELOW the pill and must not pull them down). signal/genre are
  // given the pill's height + centered content below, so all three read level.
  headerLeft: { flexDirection: 'row', alignItems: 'flex-start', gap: 14, flexShrink: 1 },
  headerRight: { alignItems: 'center', gap: 12, flexShrink: 0 },
  headerTopRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  // Tall track only: the drive-lock car flash, parked just left of the gear and
  // out of flow so it can appear and swell without moving anything.
  // right = gearBtn width (44) + the row's 6 gap + a little air, so the car sits
  // where the wide track draws it rather than under the gear.
  tallDriveFlash: { position: 'absolute', right: 56, top: 0, bottom: 0, justifyContent: 'center' },
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
