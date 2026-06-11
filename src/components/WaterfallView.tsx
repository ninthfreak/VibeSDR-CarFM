/**
 * WaterfallView — 120Hz ProMotion waterfall + spectrum, v1.5 visual parity.
 *
 * Layout (top → bottom), all in dp:
 *   ┌──────────────────────────────────────────┐
 *   │ BAND_H (20)  — band plan strip           │  coloured allocations + labels
 *   ├──────────────────────────────────────────┤
 *   │ TICK_H (22)  — frequency ticker          │  green glow "7.153M" labels
 *   ├──────────────────────────────────────────┤
 *   │ specH        — spectrum trace            │  LUT-gradient fill + peak hold
 *   ├──────────────────────────────────────────┤
 *   │ wfH          — waterfall                 │  Skia image ring buffer
 *   └──────────────────────────────────────────┘
 *   Acrylic sideband panels + LED needle span band-strip-bottom → screen bottom.
 *
 * Architecture:
 *   - SignalProcessor (M9PSY pipeline + UberSDR auto-range) maps raw dBFS bins
 *     → LUT indices; this component never touches dB maths directly.
 *   - Ring buffer stores LUT *indices* (1 byte/bin); the RGBA display buffer is
 *     persistent and updated incrementally (memmove + colourise ONE new row per
 *     frame). Palette switches recolourise the whole buffer from the index ring.
 *   - TWO stacked canvases (power): the bottom one holds only the waterfall
 *     texture and is the only thing Reanimated redraws at 120Hz ProMotion; the
 *     top one (spectrum/bands/needle) repaints at the 10Hz data rate.
 *   - Needle + sideband-edge glows are Gaussian blurs — the most expensive Skia
 *     primitive — so they are pre-rendered ONCE into offscreen image strips and
 *     composited as plain textures, never re-blurred per frame.
 *   - Reanimated useDerivedValue drives the scroll translate on the UI thread
 *     at full display rate (120Hz ProMotion) — zero JS work per scroll tick.
 *   - Text (band labels, ticker, dB axis) rendered as absolutely-positioned RN
 *     <Text> overlays — crisper than Skia text and uses the expo-font faces.
 *
 * Visuals ported 1:1 from vibeWaterfall.ts v1.5 (M9PSY / Stuey3D):
 *   - BAND_COLS, label sizing rules, bottom border rgba(255,200,80,0.25)
 *   - niceTick / fmtHz ticker with #00aa33 glow text, minGap 52px
 *   - dB axis: 5 stops, amber rgba(255,180,60,0.90), faint reference lines
 *   - Spectrum fill: colormap LUT sampled at 9 stops, indices 15→235
 *   - Peak hold line: VFO colour (matches user's needle selection)
 *   - Acrylic sidebands: 4-stop gradient 0.03→0.28 alpha in VFO colour
 *   - Needle: 3-layer LED glow (28/16/6 blur), needleScale = clamp(.25,1,pxPerHz×4000)
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PixelRatio, StyleSheet, Text, View } from 'react-native';
import {
  Canvas,
  Fill,
  Skia,
  Image as SkiaImage,
  ImageShader,
  Path,
  Rect,
  LinearGradient,
  Shader,
  BlurStyle,
  vec,
  AlphaType,
  ColorType,
  type SkData,
  type SkImage,
  type SkPath,
} from '@shopify/react-native-skia';
import {
  useSharedValue,
  useDerivedValue,
  withTiming,
  Easing,
} from 'react-native-reanimated';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { getColorLUT } from '../assets/colormapUtils';
import type { SDRStatus } from '../services/UberSDRClient';
import { SignalProcessor, type SignalProcessorSettings } from '../assets/signalProcessor';
import { BAND_PLAN, type Band } from '../constants/bandPlan';

// ── Layout constants (vibeWaterfall.ts v1.5) ──────────────────────────────────

const BAND_H   = 20;   // band plan strip height
const TICK_H   = 22;   // frequency ticker height
const ROWS     = 256;  // waterfall history depth

// Band type → colour. Indices match v1.5 BAND_COLS: ham=red, broadcast=blue,
// utility=green, cb=orange. (Screenshot reference: 40m Ham red, 41m B/C blue.)
const BAND_COLS: Record<string, string> = {
  ham:       'rgba(207,0,0,0.92)',
  broadcast: 'rgba(9,0,255,0.92)',
  utility:   'rgba(7,189,0,0.92)',
  cb:        'rgba(255,119,0,0.92)',
};

// ── Helpers (ported verbatim from v1.5) ──────────────────────────────────────

function niceTick(approx: number): number {
  const pow  = Math.pow(10, Math.floor(Math.log10(approx)));
  const norm = approx / pow;
  const nice = norm < 1.5 ? 1 : norm < 3.5 ? 2 : norm < 7.5 ? 5 : 10;
  return nice * pow;
}

function fmtHz(hz: number): string {
  if (hz >= 1e9) return (hz / 1e9).toFixed(2) + 'G';
  if (hz >= 1e6) return (hz / 1e6).toFixed(3) + 'M';
  if (hz >= 1e3) return (hz / 1e3).toFixed(hz < 1e5 ? 1 : 0) + 'k';
  return hz.toFixed(0) + 'Hz';
}

function hexRgba(hex: string, a: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${a})`;
}

/** 11m CB special-case (typed 'utility' in bandPlan.ts but coloured orange). */
function bandColor(b: Band): string {
  if (b.name.includes('CB')) return BAND_COLS.cb;
  return BAND_COLS[b.type] ?? BAND_COLS.utility;
}

// ── Props ─────────────────────────────────────────────────────────────────────

export interface WaterfallViewProps {
  /** Hot-path frame input — the parent assigns frames into this ref's handler
   *  from onSpectrum. Frames NEVER go through React state (a setState per
   *  10–20Hz frame re-rendered the whole screen tree ≈ a full core). */
  frameSink?:  React.MutableRefObject<((bins: Float32Array, status: SDRStatus) => void) | null>;
  /** @deprecated frames come via frameSink; prop kept for compatibility. */
  bins?:       Float32Array | null;
  binCount:    number;
  centerHz:    number;
  bwHz:        number;
  tuneHz:      number;
  /** Filter edges (Hz offsets from carrier; low negative, high positive). */
  filterLow?:  number;
  filterHigh?: number;
  /** Manual range — only used when wfCoarse='manual'. */
  dbMin?:      number;
  dbMax?:      number;
  wfCoarse?:   'auto' | 'manual';
  colormap?:   string;
  width:       number;
  height:      number;
  ituRegion?:  number;            // 1/2/3 — filters regional band plan entries
  fontFamily?: string;            // default Atkinson Hyperlegible (accessibility skin)
  onPanDelta?:  (dxPx: number) => void;
  onZoomDelta?: (dyPx: number) => void;
  onTapTune?:   (hz: number) => void;
  onPinchZoom?: (scale: number) => void;

  // Display settings (SignalProcessor + layout)
  specShow?:       boolean;
  specFrac?:       number;        // spectrum fraction of (height − BAND_H − TICK_H)
  autoContrast?:   number;        // 0–20, default 10 (UberSDR calibration)
  specSmoothing?:  number;        // 1–10 → smoothingFrames
  specFloor?:      number;        // ±20 dB
  specPeakScale?:  number;        // 10 = 1.0×
  peakHold?:       boolean;
  spatialSmooth?:  boolean;
  wfBrightness?:   number;
  wfContrast?:     number;
  wfSharpness?:    number;
  frameRate?:      'native' | '20fps' | '30fps';
  needleColor?:    string;        // VFO colour — needle, sidebands, peak hold
  // Smooth tune (variable refresh): 120Hz interpolated scroll while the user
  // is interacting; once settled the waterfall steps rows discretely (data is
  // ~10Hz — the slide is pure interpolation) and the spectrum trace eases at
  // ~30fps, so ProMotion can drop the panel rate and save battery.
  smoothTune?:     boolean;
  lastInteractAt?: React.MutableRefObject<number>;
}

// ── GPU waterfall shader (the v1 WebGL design, ported to SkSL) ───────────────
// The texture holds RAW normalised intensity (Gray_8 ring buffer); the shader
// does ring addressing (scroll = uniform, no memmove), sub-pixel slide
// (uShift from Reanimated — zero JS per display frame), unsharp, S-curve
// contrast and the palette LUT lookup. Palette/sharpness/contrast changes
// recolour the ENTIRE history live. CRITICAL: this renders inside the
// on-screen Canvas — never via offscreen SkSurface snapshots (different GPU
// context → draws black; learned 2026-06-11).
const WF_SKSL = `
uniform shader wf;
uniform shader lut;
uniform float uHead;     // ring write position (rows)
uniform float uShift;    // sub-pixel slide offset (screen px)
uniform float uRows;     // ring rows (256)
uniform float uTexW;     // bins
uniform float uDrawW;    // draw width (screen px)
uniform float uDrawH;    // draw height incl. overscan row (screen px)
uniform float uSharp;    // unsharp amount (0..~1.2)
uniform float uContrast; // -1..1 S-curve mix

half4 main(float2 xy) {
  float yy  = xy.y + uShift;
  float row = floor(yy / uDrawH * uRows);
  float ty  = mod(uHead - 1.0 - row + 2.0 * uRows, uRows) + 0.5;
  float tx  = clamp(xy.x / uDrawW * uTexW, 0.5, uTexW - 0.5);
  float c   = wf.eval(float2(tx, ty)).r;
  if (uSharp > 0.0) {
    float l = wf.eval(float2(max(tx - 1.0, 0.5), ty)).r;
    float r = wf.eval(float2(min(tx + 1.0, uTexW - 0.5), ty)).r;
    c = c + uSharp * (c - (l + r) * 0.5);
  }
  float raw = clamp(c, 0.0, 1.0);
  float s   = raw * raw * (3.0 - 2.0 * raw);
  float v   = uContrast > 0.0
    ? mix(raw, s, uContrast)
    : mix(raw, raw * 0.5 + 0.25, -uContrast);
  return lut.eval(float2(clamp(v, 0.0, 1.0) * 255.0 + 0.5, 0.5));
}`;
const WF_EFFECT = Skia.RuntimeEffect.Make(WF_SKSL);

// ── Component ─────────────────────────────────────────────────────────────────

export default function WaterfallView({
  frameSink, binCount, centerHz, bwHz, tuneHz,
  filterLow = -3000, filterHigh = 3000,
  dbMin = -120, dbMax = -20, wfCoarse = 'auto',
  colormap = 'gqrx', width, height,
  ituRegion = 1, fontFamily = 'Atkinson Hyperlegible',
  onPanDelta, onZoomDelta, onTapTune, onPinchZoom,
  specShow = true, specFrac = 0.26,
  autoContrast = 10, specSmoothing = 5, specFloor = 0, specPeakScale = 10,
  peakHold = true, spatialSmooth = true,
  wfBrightness = 0, wfContrast = 0, wfSharpness = 0,
  frameRate = '20fps', needleColor = '#ff2020',
  smoothTune = true, lastInteractAt,
}: WaterfallViewProps) {

  // ── Vertical layout ─────────────────────────────────────────────────────────
  const tickTop  = BAND_H;
  const specTop  = tickTop + TICK_H;
  const below    = Math.max(0, height - specTop);
  const specH    = specShow ? Math.round(below * Math.max(0.05, Math.min(0.65, specFrac))) : 0;
  const wfTop    = specTop + specH;
  const wfH      = height - wfTop;
  const wfRenderH = wfH + Math.ceil(wfH / ROWS) + 2; // hide bottom-edge judder
  const rowH      = wfRenderH / ROWS;

  // Waterfall line rate. Settled rows are drawn as WHOLE-PIXEL pushes (no
  // subpixel translate — razor-sharp lines, and no fractional-pixel shimmer,
  // the suspected portrait judder source). NATIVE = one row per data frame
  // (~10 lines/s); 20fps/30fps emit 2/3 lines per data frame, temporally
  // interpolated prev→cur so traces stay continuous (20/30 lines/s — fills
  // faster). 60fps existed briefly but 6-way interpolation smeared each data
  // line across six rows — unusably blurry in portrait; don't bring it back.
  // The smooth-tune boost overrides all of this with a vsync slide.
  const ROWS_PER_FRAME = frameRate === '30fps' ? 3 : frameRate === '20fps' ? 2 : 1;

  // Smooth tune: gestures count as "interacting" for this long after the last
  // touch; inside it the slide is boosted to native rate, outside it drops to
  // the selected fps and the spectrum tween smooths the trace at ~30fps.
  const SMOOTH_TUNE_TAIL_MS = 1000;
  const SPEC_TWEEN_MS       = 33;

  // ── Signal processor (owns all dB→index maths) ──────────────────────────────
  const proc = useRef(new SignalProcessor());
  useEffect(() => {
    // v1 webgl parity: interpolation blur grows with the display rate, so the
    // unsharp base scales with the selected fps and the slider is a multiplier
    // of it (5 = 1×; 60fps base 5 keeps existing setups looking identical).
    const sharpBase =
      frameRate === '30fps' ? 3 : frameRate === '20fps' ? 2 : 1.5; // native: least blur
    // Quadratic slider curve: 5 = 1× base, 10 = 4× — the linear curve made
    // the upper half of the slider nearly imperceptible.
    const sharpMul = Math.pow(wfSharpness / 5, 2);
    // GPU-side row effects (unsharp + S-curve) — uniforms, applied LIVE to
    // the whole waterfall history on the next draw.
    uSharpSv.value    = Math.min(10, sharpBase * sharpMul) * 0.12;
    uContrastSv.value = Math.max(-1, Math.min(1, wfContrast / 10));
    const patch: Partial<SignalProcessorSettings> = {
      autoContrast,
      manualRange: wfCoarse === 'manual' ? { minDb: dbMin, maxDb: dbMax } : null,
      specFloor, specPeakScale,
      smoothingFrames: specSmoothing,
      spatialSmooth, peakHold,
      wfBrightness, wfContrast,
      wfSharpness: Math.min(10, sharpBase * sharpMul),
    };
    proc.current.applySettings(patch);
  }, [autoContrast, wfCoarse, dbMin, dbMax, specFloor, specPeakScale,
      specSmoothing, spatialSmooth, peakHold, wfBrightness, wfContrast,
      wfSharpness, frameRate]);

  // ── Colormap LUT + derived spectrum colours (9 stops, idx 15→235) ───────────
  const lut = useMemo(() => getColorLUT(colormap), [colormap]);
  const specGradColors = useMemo(() => {
    // Sample LUT 90→235 (was 15→235): black-based palettes (Sonar etc.) are
    // near-invisible below ~idx 90, so the fill's baseline starts where the
    // palette has actually picked up colour — weak signals stay visible while
    // the trace still inherits the waterfall hue.
    const stops: string[] = [];
    for (let gi = 0; gi <= 8; gi++) {
      const idx = Math.max(0, Math.min(255, Math.round(90 + (gi / 8) * 145)));
      stops.push(`rgba(${lut[idx * 4]},${lut[idx * 4 + 1]},${lut[idx * 4 + 2]},1)`);
    }
    return stops.reverse(); // gradient runs top→bottom; hot colour at top
  }, [lut]);

  // ── Intensity ring buffer (Gray_8, ring order — the shader does the
  // display-order mapping via uHead). Each push = one row write + a 256KB
  // single-channel image (vs the old 1MB RGBA full rebuild + CPU colourise).
  const idxBuf       = useRef<Uint8Array | null>(null); // normalised intensity bytes
  const rowHead      = useRef(0);
  const lastBinCount = useRef(0);
  const [texReady, setTexReady] = useState(false);
  const texReadyRef  = useRef(false);

  // Shader uniforms driven from the UI thread (no React render per change)
  const uHead       = useSharedValue(0);
  const uTexW       = useSharedValue(1024);
  const uSharpSv    = useSharedValue(0);
  const uContrastSv = useSharedValue(0);

  // Palette = a 256×1 LUT texture; switching recolours ALL history instantly.
  const lutImage = useMemo(() => {
    const data = Skia.Data.fromBytes(lut);
    return Skia.Image.MakeImage(
      { width: 256, height: 1, colorType: ColorType.RGBA_8888, alphaType: AlphaType.Opaque },
      data, 256 * 4,
    );
  }, [lut]);

  // ── Display state ───────────────────────────────────────────────────────────
  // Image + paths are Reanimated shared values, NOT React state: Skia nodes
  // accept them directly and update on the UI thread. The 30-lines/s
  // interpolation pushes and the 30fps spectrum tween would otherwise each
  // trigger a full React re-render per tick — that was the device-heat
  // regression. React renders stay at the ~10Hz data rate (driven by parent
  // props); empty path = draw nothing (Path doesn't take null).
  const wfImage  = useSharedValue<SkImage | null>(null);
  const specPath = useSharedValue<SkPath>(Skia.Path.Make());
  const peakPath = useSharedValue<SkPath>(Skia.Path.Make());
  const [liveRange, setLiveRange] = useState({ dbMin: -120, dbMax: -20 });

  // ── Deterministic Skia disposal ─────────────────────────────────────────────
  // Hermes only sees the tiny JS wrappers, NOT the ~1MB native buffer behind
  // each waterfall image — it feels no memory pressure and lets dead images
  // accumulate for ages (measured ~770MB resident, plus constant GC churn).
  // Retire queues delay dispose() by a couple of swaps so the UI thread can
  // never be mid-draw on a freed object.
  const wfLive    = useRef<{ img: SkImage; data: SkData } | null>(null);
  const wfRetired = useRef<{ img: SkImage; data: SkData }[]>([]);
  const swapWfImage = useCallback((img: SkImage, data: SkData) => {
    wfImage.value = img;
    if (wfLive.current) wfRetired.current.push(wfLive.current);
    wfLive.current = { img, data };
    while (wfRetired.current.length > 2) {
      const r = wfRetired.current.shift()!;
      r.img.dispose(); r.data.dispose();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const pathRetired = useRef<SkPath[]>([]);
  const swapPath = useCallback((sv: { value: SkPath }, p: SkPath) => {
    pathRetired.current.push(sv.value);
    sv.value = p;
    while (pathRetired.current.length > 4) pathRetired.current.shift()!.dispose();
  }, []);

  useEffect(() => () => { // unmount: flush the queues
    wfRetired.current.forEach(r => { r.img.dispose(); r.data.dispose(); });
    wfRetired.current = [];
    pathRetired.current.forEach(p => p.dispose());
    pathRetired.current = [];
  }, []);

  // ── Smooth scroll (UI thread) — fed to the shader as a sub-pixel sample
  // offset (uShift); no view transform, no gap at the slide edge.
  const scrollFrac  = useSharedValue(1);
  const lastFrameTs = useRef(0);
  const avgFrameMs  = useRef(150);

  const wfUniforms = useDerivedValue(() => ({
    uHead:     uHead.value,
    uShift:    (1 - scrollFrac.value) * rowH,
    uRows:     ROWS,
    uTexW:     uTexW.value,
    uDrawW:    width,
    uDrawH:    wfRenderH,
    uSharp:    uSharpSv.value,
    uContrast: uContrastSv.value,
  }), [width, wfRenderH, rowH]);

  // ── Spectrum tween (smooth tune, settled state) ────────────────────────────
  // Data frames arrive at ~10Hz (or ~3Hz under the idle divisor); setting the
  // path per frame would make the trace a slideshow. Instead the displayed
  // trace eases toward the latest frame on 33ms ticks and the timer STOPS once
  // converged, so between frames the display idles.
  const specToRef   = useRef<Float32Array | null>(null);
  const specDispRef = useRef<Float32Array | null>(null);
  const tweenTimer  = useRef<ReturnType<typeof setInterval> | null>(null);

  // Path builder in a ref so the tween tick never closes over stale layout.
  // addPoly = ONE JSI call for the whole polyline. Points come from a POOL of
  // mutated-in-place objects: allocating fresh {x,y}s per build (×30Hz tween)
  // fed the Hermes GC ~12k objects/s — profiling showed HadesGC at ~18% of all
  // CPU samples. Trace sampled every 2px — the data is smoothed, identical look.
  const SPEC_PX_STEP = 2;
  const specPtsPool = useRef<{ x: number; y: number }[]>([]);
  const peakPtsPool = useRef<{ x: number; y: number }[]>([]);
  const buildSpecPathRef = useRef<(spec: Float32Array) => SkPath>(null as never);
  buildSpecPathRef.current = (spec: Float32Array) => {
    const sLen = spec.length;
    const baseline = wfTop;
    const w = Math.floor(width);
    const count = Math.ceil(w / SPEC_PX_STEP) + 2;
    const pool = specPtsPool.current;
    while (pool.length < count) pool.push({ x: 0, y: 0 });
    if (pool.length > count) pool.length = count;
    let k = 0;
    pool[k].x = 0; pool[k].y = baseline; k++;
    for (let px = 0; px < w; px += SPEC_PX_STEP) {
      const v = spec[Math.floor((px / width) * sLen)];
      pool[k].x = px; pool[k].y = baseline - v * specH; k++;
    }
    pool[k].x = w; pool[k].y = baseline;
    const sp = Skia.Path.Make();
    sp.addPoly(pool, true); // addPoly copies synchronously — pool reuse is safe
    return sp;
  };

  const stopSpecTween = useCallback(() => {
    if (tweenTimer.current) { clearInterval(tweenTimer.current); tweenTimer.current = null; }
  }, []);

  const startSpecTween = useCallback(() => {
    if (tweenTimer.current) return;
    tweenTimer.current = setInterval(() => {
      const to = specToRef.current, disp = specDispRef.current;
      if (!to || !disp || to.length !== disp.length) { stopSpecTween(); return; }
      // Time-constant ≈ ⅓ of the measured frame interval — the trace settles
      // comfortably before the next frame at any poll divisor.
      const k = 1 - Math.exp(-SPEC_TWEEN_MS / Math.max(40, avgFrameMs.current * 0.35));
      let maxDelta = 0;
      for (let i = 0; i < disp.length; i++) {
        const d = to[i] - disp[i];
        disp[i] += d * k;
        const a = Math.abs(d);
        if (a > maxDelta) maxDelta = a;
      }
      swapPath(specPath, buildSpecPathRef.current(disp)); // UI-thread — no React render
      if (maxDelta < 0.002) stopSpecTween(); // converged — let the display idle
    }, SPEC_TWEEN_MS);
  }, [stopSpecTween]);

  useEffect(() => stopSpecTween, [stopSpecTween]); // clear on unmount

  // ── Row push + line ticker (whole-pixel waterfall advance) ─────────────────
  // pushRow advances the waterfall by exactly one pixel row: ring write,
  // incremental display shift, colourise, new SkImage. The line ticker emits
  // duplicate pushes of the latest data row between frames so the fps modes
  // reach 30/60 lines per second.
  const pushRow = useCallback((row: Uint8Array) => {
    const n = row.length;
    if (n !== lastBinCount.current || !idxBuf.current) {
      idxBuf.current  = new Uint8Array(n * ROWS);
      rowHead.current = 0;
      lastBinCount.current = n;
      uTexW.value = n;
    }
    idxBuf.current.set(row, rowHead.current * n);
    rowHead.current = (rowHead.current + 1) % ROWS;

    const data = Skia.Data.fromBytes(idxBuf.current);
    const img = Skia.Image.MakeImage(
      { width: n, height: ROWS, colorType: ColorType.Gray_8, alphaType: AlphaType.Opaque },
      data,
      n,
    );
    if (img) {
      swapWfImage(img, data); // UI-thread swap + retire old pair (~256KB now)
      uHead.value = rowHead.current;
      if (!texReadyRef.current) { texReadyRef.current = true; setTexReady(true); }
    } else {
      data.dispose();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [swapWfImage]);

  // pushLine = pushRow + per-push scroll treatment. The line pipeline runs at
  // the SAME rate boosted or settled — only the transform differs (vsync
  // mini-slide vs whole-pixel snap). Deciding slide-vs-snap per PUSH (reading
  // the interact ref live) keeps the fill rate constant across touch
  // transitions; the old per-frame switch dropped to 1 line/frame on boost
  // entry and killed the ticker mid-emission — visible slowdown + stuck
  // judder at both edges of every touch.
  const pushLine = useCallback((row: Uint8Array) => {
    pushRow(row);
    const boosted = smoothTune &&
      Date.now() - (lastInteractAt?.current ?? 0) < SMOOTH_TUNE_TAIL_MS;
    if (boosted) {
      // Slide spans one push interval — continuous motion at panel rate.
      const dur = Math.max(30, Math.min(150, avgFrameMs.current / ROWS_PER_FRAME));
      scrollFrac.value = 0;
      scrollFrac.value = withTiming(1, { duration: dur, easing: Easing.linear });
    } else {
      scrollFrac.value = 1; // whole-pixel landing, display idles
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pushRow, smoothTune, ROWS_PER_FRAME]);

  const pushLineRef = useRef(pushLine);
  pushLineRef.current = pushLine; // ticker always sees current palette + boost state

  const prevRow    = useRef<Uint8Array | null>(null); // last data row (lerp source)
  const lerpBuf    = useRef<Uint8Array | null>(null);
  const rowPool    = useRef<[Uint8Array | null, Uint8Array | null]>([null, null]);
  const rowPoolIdx = useRef(0);
  const lineTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopLineTicker = useCallback(() => {
    if (lineTimer.current) { clearInterval(lineTimer.current); lineTimer.current = null; }
  }, []);

  // Emit n lines morphing prev→cur across the measured data interval
  // (LUT-index lerp — the index ramp is monotonic in intensity, so blends are
  // valid colours). Duplicating instead of interpolating leaves hard 3/6-row
  // bands that read as broken signal traces. The final line is the exact new
  // data row; self-stops after it, so the display idles between frames.
  const startLineInterp = useCallback((from: Uint8Array, to: Uint8Array, n: number, intervalMs: number) => {
    stopLineTicker();
    if (!lerpBuf.current || lerpBuf.current.length !== to.length) {
      lerpBuf.current = new Uint8Array(to.length);
    }
    const buf = lerpBuf.current;
    let k = 0;
    const emit = () => {
      k++;
      if (k >= n) { pushLineRef.current(to); stopLineTicker(); return; }
      const w = k / n;
      for (let i = 0; i < to.length; i++) buf[i] = (from[i] + (to[i] - from[i]) * w) | 0;
      pushLineRef.current(buf); // pushRow copies synchronously — buf reuse is safe
    };
    emit(); // first interpolated line lands with the frame
    if (lineTimer.current === null && k < n) {
      lineTimer.current = setInterval(emit, Math.max(16, intervalMs / n));
    }
  }, [stopLineTicker]);

  useEffect(() => stopLineTicker, [stopLineTicker]); // clear on unmount

  // ── Frame processing (imperative hot path — NO React state per frame) ──────
  // Frames arrive through frameSink, a ref the parent fills from onSpectrum.
  // Routing 10–20Hz frames through setState re-rendered the entire screen tree
  // per frame (~a full core of CPU). Per-render config is mirrored into a ref
  // so the stable callback never closes over stale props.
  const frameCfg = useRef({ width, wfTop, specH, specShow, peakHold,
                            smoothTune, rowsPerFrame: ROWS_PER_FRAME });
  frameCfg.current = { width, wfTop, specH, specShow, peakHold,
                       smoothTune, rowsPerFrame: ROWS_PER_FRAME };

  const handleFrame = useCallback((fbins: Float32Array, fstatus: SDRStatus) => {
    const cfg = frameCfg.current;
    if (!fbins || fbins.length === 0 || cfg.width < 4) return;

    // 1. M9PSY pipeline + UberSDR auto-range
    const frame = proc.current.process(fbins, fstatus.centerHz, fstatus.bwHz);
    // dB axis labels — quantised to whole dB so auto-range wobble doesn't
    // trigger a React re-render every frame.
    const rMin = Math.round(frame.dbMin), rMax = Math.round(frame.dbMax);
    setLiveRange(prev =>
      prev.dbMin === rMin && prev.dbMax === rMax ? prev : { dbMin: rMin, dbMax: rMax });

    // 2. Frame interval + interaction state (smooth tune)
    const now = Date.now();
    if (lastFrameTs.current > 0) {
      const dt = now - lastFrameTs.current;
      avgFrameMs.current = avgFrameMs.current * 0.8 + dt * 0.2;
    }
    lastFrameTs.current = now;
    // Boost: native-rate slide + per-frame spectrum while the user interacts.
    const boost = cfg.smoothTune &&
      now - (lastInteractAt?.current ?? 0) < SMOOTH_TUNE_TAIL_MS;

    // 3. Waterfall lines — runs IDENTICALLY boosted or settled (constant fill
    //    rate; pushLine decides slide-vs-snap per push). NATIVE: the raw data
    //    row once per frame. fps modes: n lines morphing prev→cur across the
    //    frame interval (10×2 / 10×3 lines per second).
    //    Row copies ping-pong between two pooled buffers (GC pressure — the
    //    processor reuses frame.row, so a snapshot is still required).
    let cur = rowPool.current[rowPoolIdx.current];
    if (!cur || cur.length !== frame.row.length) {
      cur = new Uint8Array(frame.row.length);
      rowPool.current[rowPoolIdx.current] = cur;
    }
    cur.set(frame.row);
    rowPoolIdx.current ^= 1;
    const from = prevRow.current;
    if (cfg.rowsPerFrame > 1 && from && from.length === cur.length) {
      startLineInterp(from, cur, cfg.rowsPerFrame, avgFrameMs.current);
    } else {
      stopLineTicker();
      pushLineRef.current(cur);
    }
    prevRow.current = cur;

    // 4. Spectrum + peak paths from normalised [0,1] traces
    if (cfg.specShow && cfg.specH > 4) {
      if (boost) {
        // Full rate: trace follows every data frame directly.
        stopSpecTween();
        specDispRef.current = null;
        swapPath(specPath, buildSpecPathRef.current(frame.spec));
      } else {
        // Settled: retarget the ~30fps tween — the displayed trace eases to
        // this frame instead of jumping (data is only ~10Hz / ~3Hz idle).
        if (!specToRef.current || specToRef.current.length !== frame.spec.length) {
          specToRef.current = Float32Array.from(frame.spec);
        } else {
          specToRef.current.set(frame.spec);
        }
        if (!specDispRef.current || specDispRef.current.length !== frame.spec.length) {
          specDispRef.current = Float32Array.from(frame.spec);
          swapPath(specPath, buildSpecPathRef.current(specDispRef.current));
        }
        startSpecTween();
      }

      if (cfg.peakHold && !boost) {
        const pk = frame.peak;
        const sLen = pk.length;
        const baseline = cfg.wfTop;
        const w = Math.floor(cfg.width);
        const count = Math.ceil(w / SPEC_PX_STEP);
        const pool = peakPtsPool.current;
        while (pool.length < count) pool.push({ x: 0, y: 0 });
        if (pool.length > count) pool.length = count;
        for (let k = 0; k < count; k++) {
          const px = k * SPEC_PX_STEP;
          const v = pk[Math.floor((px / cfg.width) * sLen)];
          pool[k].x = px; pool[k].y = baseline - v * cfg.specH;
        }
        const pp = Skia.Path.Make();
        pp.addPoly(pool, false);
        swapPath(peakPath, pp);
      } else {
        // Peak hold PAUSES while interacting: bin-indexed peaks detach from
        // their signals as the view moves (geometry is pinned during gestures
        // so the processor can't see the shift) and smear the display. Clear
        // and hide; it re-seeds within a frame or two of settling.
        if (boost) proc.current.resetPeakHold();
        swapPath(peakPath, Skia.Path.Make()); // empty = draw nothing
      }
    } else {
      // Spectrum hidden — nothing needs inter-frame smoothness; the panel can
      // fall all the way to the data rate.
      stopSpecTween();
      swapPath(specPath, Skia.Path.Make());
      swapPath(peakPath, Skia.Path.Make());
    }

    // (Scroll transform is handled per push inside pushLine — slide when
    // boosted, whole-pixel snap when settled.)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!frameSink) return;
    frameSink.current = handleFrame;
    return () => { frameSink.current = null; };
  }, [frameSink, handleFrame]);

  // (Palette switches need no rebuild anymore — the lutImage memo swaps the
  // 256×1 LUT texture and the shader recolours the whole history next draw.)

  // ── Frequency geometry ──────────────────────────────────────────────────────
  const visStart = centerHz - bwHz / 2;
  const pxPerHz  = bwHz > 0 ? width / bwHz : 0;
  const hzToX    = useCallback((hz: number) => (hz - visStart) * pxPerHz,
    [visStart, pxPerHz]);

  // ── Band plan segments (visible, region-filtered) ───────────────────────────
  const bandSegs = useMemo(() => {
    if (!(bwHz > 0)) return [];
    const visEnd = visStart + bwHz;
    const segs: Array<{ x0: number; x1: number; color: string; label: string; key: string }> = [];
    for (const b of BAND_PLAN) {
      if (b.regions && !b.regions.includes(ituRegion)) continue;
      if (b.hi < visStart || b.lo > visEnd) continue;
      const x0 = Math.max(0, hzToX(b.lo));
      const x1 = Math.min(width, hzToX(b.hi));
      const px = x1 - x0;
      if (px <= 0) continue;
      const label = px < 28 ? '' : px < 60 ? (b.bandLabel ?? b.name.split(' ')[0]) : b.name;
      segs.push({ x0, x1, color: bandColor(b), label, key: `${b.lo}-${b.hi}` });
    }
    return segs;
  }, [visStart, bwHz, width, ituRegion, hzToX]);

  // ── Frequency ticks ─────────────────────────────────────────────────────────
  const ticks = useMemo(() => {
    if (!(bwHz > 0)) return [];
    const targetTicks  = Math.max(4, Math.min(8, Math.floor(width / 70)));
    let spacing = niceTick(bwHz / targetTicks);
    const minGapPx = 52;
    while (spacing * pxPerHz < minGapPx) spacing *= 2;
    const first = Math.ceil(visStart / spacing) * spacing;
    const out: Array<{ x: number; label: string; showLabel: boolean }> = [];
    let lastLabelX = -999;
    for (let f = first; f <= visStart + bwHz; f += spacing) {
      const x = hzToX(f);
      const showLabel = x - lastLabelX >= minGapPx;
      if (showLabel) lastLabelX = x;
      out.push({ x, label: fmtHz(f), showLabel });
    }
    return out;
  }, [visStart, bwHz, width, pxPerHz, hzToX]);

  // ── dB axis labels (5 stops over spectrum panel) ────────────────────────────
  const dbLabels = useMemo(() => {
    if (!specShow || specH < 40) return [];
    const range = liveRange.dbMax - liveRange.dbMin;
    const out: Array<{ y: number; label: string }> = [];
    for (let di = 0; di <= 4; di++) {
      const frac = di / 4;
      out.push({
        y: wfTop - frac * specH,
        label: Math.round(liveRange.dbMin + frac * range) + 'dB',
      });
    }
    return out;
  }, [specShow, specH, wfTop, liveRange]);

  // ── Needle + sideband geometry (v1.5) ───────────────────────────────────────
  const needle = useMemo(() => {
    if (!(bwHz > 0) || !(tuneHz > 0)) return null;
    const nX = hzToX(tuneHz);
    let loX = hzToX(tuneHz + filterLow);
    let hiX = hzToX(tuneHz + filterHigh);
    const minSbPx = filterLow === 0 && filterHigh === 0 ? 20 : 4;
    if (nX - loX < minSbPx) loX = nX - minSbPx;
    if (hiX - nX < minSbPx) hiX = nX + minSbPx;
    const scale = Math.max(0.25, Math.min(1.0, pxPerHz * 4000));
    // Quantised scale (0.05 steps) so the pre-rendered glow strips are not
    // re-blurred on every zoom tick — only on meaningful scale changes.
    const scaleQ = Math.round(scale * 20) / 20;
    return { nX, loXc: Math.max(0, loX), hiXc: Math.min(width, hiX), loX, hiX, scale, scaleQ };
  }, [bwHz, tuneHz, filterLow, filterHigh, hzToX, pxPerHz, width]);

  // ── Skia paints ─────────────────────────────────────────────────────────────
  const peakPaint = useMemo(() => {
    const p = Skia.Paint();
    p.setColor(Skia.Color(hexRgba(needleColor, 0.85)));
    p.setStrokeWidth(1);
    p.setStyle(1);
    p.setAntiAlias(true);
    p.setMaskFilter(Skia.MaskFilter.MakeBlur(BlurStyle.Normal, 2, false));
    return p;
  }, [needleColor]);

  // ── Pre-rendered glow strips (power) ────────────────────────────────────────
  // Gaussian blur masks are the most expensive primitive Skia draws. Rendering
  // the needle (σ 28/16/6) and sideband edges (σ 8) live meant re-blurring
  // full-height layers on every canvas repaint. Instead they are blurred ONCE
  // here into offscreen raster strips and composited as plain textures.
  const dpr = PixelRatio.get();

  const needleStrip = useMemo(() => {
    if (height < 4) return null;
    const sc = needle?.scaleQ ?? 1;
    // σ in MakeBlur(…, false) is device px; ±3σ in dp covers the full halo.
    const halfW = Math.ceil((3 * 28 * sc) / dpr + 2 * sc + 2);
    const w = halfW * 2;
    const surface = Skia.Surface.Make(Math.ceil(w * dpr), Math.ceil(height * dpr));
    if (!surface) return null;
    const c = surface.getCanvas();
    c.scale(dpr, dpr);
    const path = Skia.Path.Make();
    path.moveTo(halfW, 0); path.lineTo(halfW, height);
    const layer = (alpha: number, blur: number, sw: number) => {
      const p = Skia.Paint();
      p.setColor(Skia.Color(alpha >= 1 ? needleColor : hexRgba(needleColor, alpha)));
      p.setStrokeWidth(sw);
      p.setStyle(1);
      p.setAntiAlias(true);
      p.setMaskFilter(Skia.MaskFilter.MakeBlur(BlurStyle.Normal, blur, false));
      c.drawPath(path, p);
    };
    layer(0.35, 28 * sc, 1.5 * sc);  // outer halo
    layer(0.70, 16 * sc, 0.8 * sc);  // mid glow
    layer(1.00,  6 * sc, 0.5);       // core filament
    return { img: surface.makeImageSnapshot(), halfW, w };
  }, [needleColor, needle?.scaleQ, height, dpr]);

  const edgeStrip = useMemo(() => {
    const h = height - BAND_H;
    if (h < 4) return null;
    const sc = needle?.scaleQ ?? 1;
    const halfW = Math.ceil((3 * 8) / dpr + sc + 2);
    const w = halfW * 2;
    const surface = Skia.Surface.Make(Math.ceil(w * dpr), Math.ceil(h * dpr));
    if (!surface) return null;
    const c = surface.getCanvas();
    c.scale(dpr, dpr);
    const path = Skia.Path.Make();
    path.moveTo(halfW, 0); path.lineTo(halfW, h);
    const p = Skia.Paint();
    p.setColor(Skia.Color(hexRgba(needleColor, 0.35)));
    p.setStrokeWidth(sc);
    p.setStyle(1);
    p.setAntiAlias(true);
    p.setMaskFilter(Skia.MaskFilter.MakeBlur(BlurStyle.Normal, 8, false));
    c.drawPath(path, p);
    return { img: surface.makeImageSnapshot(), halfW, w, h };
  }, [needleColor, needle?.scaleQ, height, dpr]);

  // ── Gestures (tap-to-tune / pan / pinch-zoom) ───────────────────────────────
  const lastPanX = useRef(0);
  const lastPanY = useRef(0);
  const pinchRef = useRef(1);

  const tapGesture = useMemo(() =>
    Gesture.Tap().runOnJS(true).maxDuration(300).onEnd((e: any) => {
      if (!bwHz || !centerHz) return;
      if (e.y < BAND_H) return; // band strip taps reserved (future: band jump)
      onTapTune?.(Math.round(visStart + (e.x / width) * bwHz));
    }), [bwHz, centerHz, visStart, width, onTapTune]);

  const panGesture = useMemo(() =>
    Gesture.Pan().runOnJS(true).minDistance(4)
      .onStart(() => { lastPanX.current = 0; lastPanY.current = 0; })
      .onUpdate((e: any) => {
        const dx = e.translationX - lastPanX.current;
        const dy = e.translationY - lastPanY.current;
        lastPanX.current = e.translationX;
        lastPanY.current = e.translationY;
        if (Math.abs(dx) >= Math.abs(dy)) onPanDelta?.(-dx);
        else onZoomDelta?.(dy);
      }), [onPanDelta, onZoomDelta]);

  const pinchGesture = useMemo(() =>
    Gesture.Pinch().runOnJS(true)
      .onStart(() => { pinchRef.current = 1; })
      .onUpdate((e: any) => {
        const delta = e.scale / pinchRef.current;
        pinchRef.current = e.scale;
        onPinchZoom?.(delta);
      }), [onPinchZoom]);

  const gesture = useMemo(() =>
    Gesture.Simultaneous(Gesture.Exclusive(tapGesture, panGesture), pinchGesture),
    [tapGesture, panGesture, pinchGesture]);

  // ── Render ──────────────────────────────────────────────────────────────────
  // Canvas 1 (bottom): waterfall texture only — the ONLY thing the 120Hz
  // Reanimated scroll repaints. Canvas 2 (top): everything else, repainted at
  // the 10Hz data rate. The canvas bounds clip the over-tall scrolling image.
  return (
    <GestureDetector gesture={gesture}>
      <View style={[styles.root, { width, height }]}>

        <Canvas style={{ position: 'absolute', left: 0, top: wfTop, width, height: wfH }}>
          {/* GPU waterfall: intensity ring + LUT sampled by the runtime
              shader; scroll/slide/sharpness/contrast are uniforms (UI-thread,
              zero React). Child order maps to `uniform shader wf, lut`. */}
          {texReady && lutImage && WF_EFFECT && (
            <Fill>
              <Shader source={WF_EFFECT} uniforms={wfUniforms}>
                <ImageShader image={wfImage} fit="none" />
                <ImageShader image={lutImage} fit="none" />
              </Shader>
            </Fill>
          )}
        </Canvas>

        <Canvas style={{ position: 'absolute', left: 0, top: 0, width, height }}>

          {/* Opaque header backing — WebGL parity rgb(2,2,2) */}
          <Rect x={0} y={0} width={width} height={wfTop} color="rgb(2,2,2)" />

          {/* ── Band plan strip ── */}
          {bandSegs.map(s => (
            <Rect key={s.key} x={s.x0} y={0} width={s.x1 - s.x0} height={BAND_H}
                  color={s.color} />
          ))}
          <Rect x={0} y={BAND_H - 1} width={width} height={1}
                color="rgba(255,200,80,0.25)" />

          {/* ── Ticker backing + tick marks ── */}
          <Rect x={0} y={tickTop} width={width} height={TICK_H}
                color="rgba(0,10,4,0.85)" />
          {ticks.map((t, i) => (
            <Rect key={i} x={t.x - 0.5} y={tickTop} width={1} height={5}
                  color="rgba(0,180,60,0.45)" />
          ))}

          {/* ── Spectrum: LUT-gradient fill, faint dB reference lines, peak ── */}
          {specShow && dbLabels.map((d, i) => (
            <Rect key={i} x={0} y={d.y} width={width} height={0.5}
                  color="rgba(255,180,0,0.12)" />
          ))}
        </Canvas>

        {/* Canvas: LIVE spectrum trace — isolated so the ~30Hz tween repaints
            ONLY these two paths, not the band plan/ticks/needle/acrylics
            (sharing one canvas redrew the whole overlay per tween tick). */}
        <Canvas style={{ position: 'absolute', left: 0, top: 0, width, height: wfTop + 1 }}>
          {specShow && (
            <Path path={specPath} style="fill">
              <LinearGradient start={vec(0, specTop)} end={vec(0, wfTop)}
                              colors={specGradColors} />
            </Path>
          )}
          {specShow && peakHold && (
            <Path path={peakPath} paint={peakPaint} />
          )}
        </Canvas>

        {/* Canvas: needle + acrylics — repaints only on React render (rare). */}
        <Canvas style={{ position: 'absolute', left: 0, top: 0, width, height }}>

          {/* ── Acrylic sideband panels (band-strip bottom → screen bottom) ── */}
          {needle && needle.nX > needle.loXc && (
            <Rect x={needle.loXc} y={BAND_H}
                  width={needle.nX - needle.loXc} height={height - BAND_H}>
              <LinearGradient
                start={vec(needle.loXc, 0)} end={vec(needle.nX, 0)}
                colors={[hexRgba(needleColor, 0.03), hexRgba(needleColor, 0.06),
                         hexRgba(needleColor, 0.14), hexRgba(needleColor, 0.28)]}
                positions={[0, 0.15, 0.55, 1]} />
            </Rect>
          )}
          {needle && needle.hiXc > needle.nX && (
            <Rect x={needle.nX} y={BAND_H}
                  width={needle.hiXc - needle.nX} height={height - BAND_H}>
              <LinearGradient
                start={vec(needle.nX, 0)} end={vec(needle.hiXc, 0)}
                colors={[hexRgba(needleColor, 0.28), hexRgba(needleColor, 0.14),
                         hexRgba(needleColor, 0.06), hexRgba(needleColor, 0.03)]}
                positions={[0, 0.45, 0.85, 1]} />
            </Rect>
          )}
          {needle && needle.loXc > 0 && edgeStrip && (
            <SkiaImage image={edgeStrip.img} x={needle.loXc - edgeStrip.halfW} y={BAND_H}
                       width={edgeStrip.w} height={edgeStrip.h} fit="fill" />
          )}
          {needle && needle.hiXc < width && edgeStrip && (
            <SkiaImage image={edgeStrip.img} x={needle.hiXc - edgeStrip.halfW} y={BAND_H}
                       width={edgeStrip.w} height={edgeStrip.h} fit="fill" />
          )}

          {/* ── LED needle: halo → glow → filament (cached strip) ── */}
          {needle && needleStrip && (
            <SkiaImage image={needleStrip.img} x={needle.nX - needleStrip.halfW} y={0}
                       width={needleStrip.w} height={height} fit="fill" />
          )}

        </Canvas>

        {/* ── Text overlays (RN Text — crisp, uses expo-font faces) ── */}

        {/* Band labels — clipped to segment width, white with dark shadow */}
        {bandSegs.filter(s => s.label).map(s => (
          <View key={'bl' + s.key} pointerEvents="none"
                style={[styles.bandLabelWrap,
                        { left: s.x0 + 2, width: s.x1 - s.x0 - 4, height: BAND_H }]}>
            <Text numberOfLines={1}
                  style={[styles.bandLabel, { fontFamily }]}>{s.label}</Text>
          </View>
        ))}

        {/* Ticker labels — green LED glow */}
        {ticks.filter(t => t.showLabel).map((t, i) => (
          <Text key={'tk' + i} pointerEvents="none"
                style={[styles.tickLabel, { fontFamily, left: t.x - 40, top: tickTop + 5 }]}>
            {t.label}
          </Text>
        ))}

        {/* dB axis — amber, left edge of spectrum */}
        {dbLabels.map((d, i) => (
          <Text key={'db' + i} pointerEvents="none"
                style={[styles.dbLabel, { fontFamily, top: d.y - 14 }]}>
            {d.label}
          </Text>
        ))}

      </View>
    </GestureDetector>
  );
}

// ── Styles (typography from v1.5 canvas calls) ───────────────────────────────

const styles = StyleSheet.create({
  root: { overflow: 'hidden', backgroundColor: '#000' },
  bandLabelWrap: {
    position: 'absolute', top: 0,
    alignItems: 'center', justifyContent: 'flex-end',
    overflow: 'hidden', paddingBottom: 2,
  },
  bandLabel: {
    fontSize: 9, fontWeight: 'bold', color: '#ffffff',
    textShadowColor: 'rgba(0,0,0,0.9)', textShadowRadius: 3,
    textShadowOffset: { width: 0, height: 0 },
  },
  tickLabel: {
    position: 'absolute', width: 80, textAlign: 'center',
    fontSize: 11, fontWeight: 'bold', color: '#00aa33',
    textShadowColor: '#00cc44', textShadowRadius: 5,
    textShadowOffset: { width: 0, height: 0 },
  },
  dbLabel: {
    position: 'absolute', left: 4,
    fontSize: 11, fontWeight: 'bold', color: 'rgba(255,180,60,0.90)',
    textShadowColor: 'rgba(0,0,0,0.75)', textShadowRadius: 2.5,
    textShadowOffset: { width: 0, height: 0 },
  },
});
