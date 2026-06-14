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
import { Image as RNImage, PixelRatio, StyleSheet, Text, View } from 'react-native';
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
  /** Needle/glow brightness 1–10 (5 = original look) — bright palettes can
   *  swallow the needle whatever colour it is. */
  needleIntensity?: number;
  /** Frosted backing 0–10 (0 = off): smoked-glass band over the passband
   *  that dims the waterfall behind the needle — contrast on bright
   *  palettes even when their colours match the needle. */
  needleFrost?: number;
  /** Instance spectrum backdrop (/api/spectrum-bg-image) — sits behind the
   *  spectrum line graph only, like the web UI. */
  bgImageUrl?:  string | null;
  /** Backdrop opacity 0–1 (0 = hidden). */
  bgOpacity?:   number;
  /** Station-ID overlay: "CALLSIGN - NAME" + location, top-right of the
   *  spectrum (web drawStationIdOverlay parity). */
  stationId?:   { line1: string; line2?: string; color: string } | null;
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
uniform float uHeadF;    // ABSOLUTE frame counter (next write index)
uniform float uFrac;     // 0..1 progress through the current frame interval
uniform float uN;        // lines per data frame (1/2/3 = native/20fps/30fps)
uniform float uQuant;    // 1 = crisp whole-line steps (settled), 0 = continuous (boost)
uniform float uRows;     // ring rows (256 frames)
uniform float uTexW;     // bins
uniform float uDrawW;    // draw width (screen px)
uniform float uDrawH;    // draw height incl. overscan row (screen px)
uniform float uSharp;    // unsharp amount (0..~1.2)
uniform float uContrast; // -1..1 S-curve mix

// Temporal interpolation (phase 2): the ring holds RAW frames; intermediate
// lines are synthesized here by blending adjacent frames at fractional depth
// — identical maths to the old JS line ticker, per-pixel, for free.
// Line algebra: with frame K = uHeadF-1 newest, lines (K-1)*uN+1..K*uN blend
// frame[K-1]->frame[K]; revealed lines this interval R = uFrac*uN; absolute
// line at display row L is A = (uHeadF-2)*uN + R - L; its source frames are
// f = floor(A/uN) and f+1 blended by frac(A/uN).
half4 main(float2 xy) {
  float Lc = xy.y / uDrawH * uRows;            // continuous display line
  float L  = uQuant > 0.5 ? floor(Lc) : Lc;    // whole-pixel rows when settled
  float R  = uFrac * uN;
  if (uQuant > 0.5) { R = floor(R + 0.0001); }
  float A  = (uHeadF - 2.0) * uN + R - L;
  float fI = floor(A / uN);
  float t  = A / uN - fI;
  float r1 = mod(fI, uRows) + 0.5;
  float r2 = mod(fI + 1.0, uRows) + 0.5;
  float tx = clamp(xy.x / uDrawW * uTexW, 0.5, uTexW - 0.5);
  float c  = mix(wf.eval(float2(tx, r1)).r, wf.eval(float2(tx, r2)).r, t);
  if (uSharp > 0.0) {
    float xl = max(tx - 1.0, 0.5);
    float xr = min(tx + 1.0, uTexW - 0.5);
    float l = mix(wf.eval(float2(xl, r1)).r, wf.eval(float2(xl, r2)).r, t);
    float r = mix(wf.eval(float2(xr, r1)).r, wf.eval(float2(xr, r2)).r, t);
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

function WaterfallView({
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
  frameRate = '20fps', needleColor = '#ff2020', needleIntensity = 5, needleFrost = 0,
  bgImageUrl = null, bgOpacity = 0, stationId = null,
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
  const lastBinCount = useRef(0);
  const [texReady, setTexReady] = useState(false);
  const texReadyRef  = useRef(false);

  // Shader uniforms driven from the UI thread (no React render per change)
  const uHead       = useSharedValue(0); // ABSOLUTE frame counter (next write)
  const uTexW       = useSharedValue(1024);
  const uSharpSv    = useSharedValue(0);
  const uContrastSv = useSharedValue(0);
  const uNSv        = useSharedValue(2); // lines per data frame
  const uQuantSv    = useSharedValue(1); // 1 = crisp steps, 0 = boost glide
  const frameCount  = useRef(0);

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
  const wfPending = useRef<Set<{ img: SkImage; data: SkData }>>(new Set());
  const swapWfImage = useCallback((img: SkImage, data: SkData) => {
    wfImage.value = img;
    const old = wfLive.current;
    wfLive.current = { img, data };
    // TIME-based disposal (was count-based "keep 2"). The UI-thread Skia render
    // may still be drawing the previous image; a fast producer (OWRX FFT/zoom is
    // much faster than UberSDR) can swap past a count window before the GPU
    // renders, so dispose() freed an image still referenced → JSI "disposed"
    // throw on the render thread = hard crash. A 300ms grace is far longer than
    // any render interval, so the freed image is always off-screen first.
    if (old) {
      wfPending.current.add(old);
      setTimeout(() => {
        if (wfPending.current.delete(old)) { try { old.img.dispose(); old.data.dispose(); } catch {} }
      }, 300);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Paths share the same hazard (the trace/peak redraw every tween + zoom frame),
  // so dispose them on the same time grace rather than a count window.
  const pathPending = useRef<Set<SkPath>>(new Set());
  const swapPath = useCallback((sv: { value: SkPath }, p: SkPath) => {
    const old = sv.value;
    sv.value = p;
    if (old) {
      pathPending.current.add(old);
      setTimeout(() => { if (pathPending.current.delete(old)) { try { old.dispose(); } catch {} } }, 300);
    }
  }, []);

  useEffect(() => () => { // unmount: flush the pending-dispose sets + the live image
    wfPending.current.forEach(r => { try { r.img.dispose(); r.data.dispose(); } catch {} });
    wfPending.current.clear();
    if (wfLive.current) { try { wfLive.current.img.dispose(); wfLive.current.data.dispose(); } catch {} wfLive.current = null; }
    pathPending.current.forEach(p => { try { p.dispose(); } catch {} });
    pathPending.current.clear();
  }, []);

  // ── Smooth scroll (UI thread) — fed to the shader as a sub-pixel sample
  // offset (uShift); no view transform, no gap at the slide edge.
  const scrollFrac  = useSharedValue(1);
  const lastFrameTs = useRef(0);
  const avgFrameMs  = useRef(150);

  const wfUniforms = useDerivedValue(() => ({
    uHeadF:    uHead.value,
    uFrac:     scrollFrac.value,
    uN:        uNSv.value,
    uQuant:    uQuantSv.value,
    uRows:     ROWS,
    uTexW:     uTexW.value,
    uDrawW:    width,
    uDrawH:    wfRenderH,
    uSharp:    uSharpSv.value,
    uContrast: uContrastSv.value,
  }), [width, wfRenderH]);

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
      frameCount.current = 0;
      lastBinCount.current = n;
      uTexW.value = n;
    }
    idxBuf.current.set(row, (frameCount.current % ROWS) * n);
    frameCount.current += 1;

    const data = Skia.Data.fromBytes(idxBuf.current);
    const img = Skia.Image.MakeImage(
      { width: n, height: ROWS, colorType: ColorType.Gray_8, alphaType: AlphaType.Opaque },
      data,
      n,
    );
    if (img) {
      swapWfImage(img, data); // UI-thread swap + retire old pair (~256KB now)
      uHead.value = frameCount.current;
      if (!texReadyRef.current) { texReadyRef.current = true; setTexReady(true); }
    } else {
      data.dispose();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [swapWfImage]);

  // (pushLine and the per-line slide/snap switching are gone — phase 2 moves
  // line synthesis into the shader; pushRow runs once per data frame and the
  // reveal stepper / boost withTiming drive uFrac.)

  // ── Reveal stepper (phase 2) ─────────────────────────────────────────────
  // The shader synthesizes intermediate lines from adjacent RAW frames; JS
  // only advances the reveal fraction. Settled = discrete whole-line steps
  // (one shared-value write per line, display idles between); boost = vsync
  // withTiming for the continuous glide. All the old lerp buffers, row pools
  // and per-line texture pushes are GONE.
  const revealTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopRevealStepper = useCallback(() => {
    if (revealTimer.current) { clearInterval(revealTimer.current); revealTimer.current = null; }
  }, []);

  const startRevealStepper = useCallback((n: number, intervalMs: number) => {
    stopRevealStepper();
    scrollFrac.value = 0;
    if (n <= 1) { scrollFrac.value = 1; return; } // native: one whole-line step
    let k = 0;
    revealTimer.current = setInterval(() => {
      k++;
      scrollFrac.value = Math.min(1, k / n);
      if (k >= n) stopRevealStepper();
    }, Math.max(16, intervalMs / n));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stopRevealStepper]);

  useEffect(() => stopRevealStepper, [stopRevealStepper]); // clear on unmount

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
    // dB axis labels — 2dB HYSTERESIS, not just rounding: a noisy floor
    // hovering on a .5 boundary flipped the rounded value every few frames,
    // re-rendering the whole WaterfallView tree at up to 10Hz (profiled:
    // React task execution was still ~a third of all JS post-meter-bus).
    const rMin = Math.round(frame.dbMin), rMax = Math.round(frame.dbMax);
    setLiveRange(prev =>
      Math.abs(prev.dbMin - rMin) < 2 && Math.abs(prev.dbMax - rMax) < 2
        ? prev : { dbMin: rMin, dbMax: rMax });

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

    // 3. Waterfall (phase 2): ONE raw frame row into the ring — the shader
    //    synthesizes the line-rate look (uN lines/frame, temporal blend of
    //    adjacent frames) and the reveal. JS just advances the fraction.
    pushRow(frame.row); // copies synchronously — no snapshot needed
    uNSv.value     = cfg.rowsPerFrame;
    uQuantSv.value = boost ? 0 : 1;
    const dur = Math.max(50, Math.min(1000, avgFrameMs.current));
    if (boost) {
      // Continuous reveal at panel rate (120Hz glide + temporal morph).
      stopRevealStepper();
      scrollFrac.value = 0;
      scrollFrac.value = withTiming(1, { duration: dur, easing: Easing.linear });
    } else {
      // Discrete whole-line steps — display idles between them.
      startRevealStepper(cfg.rowsPerFrame, dur);
    }

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
    // Intensity 1–10 (5 = original): scales halo alphas and, above 5, widens
    // the strokes too — a maxed needle punches through the brightest palettes
    const k = needleIntensity / 5;
    const wk = Math.max(1, k);
    layer(Math.min(1, 0.35 * k), 28 * sc, 1.5 * sc * wk);  // outer halo
    layer(Math.min(1, 0.70 * k), 16 * sc, 0.8 * sc * wk);  // mid glow
    layer(Math.min(1, 0.80 * k),  6 * sc, 0.8 * wk);       // filament glow
    // CRISP core filament — HTML canvas shadowBlur glows BEHIND a sharp
    // stroke, but MaskFilter blurs the stroke itself; the v1 acrylic look
    // is blurred halo + razor hairline on top.
    const crisp = Skia.Paint();
    crisp.setColor(Skia.Color(needleColor));
    crisp.setStrokeWidth(0.75 * wk);
    crisp.setStyle(1);
    crisp.setAntiAlias(true);
    c.drawPath(path, crisp);
    return { img: surface.makeImageSnapshot(), halfW, w };
  }, [needleColor, needleIntensity, needle?.scaleQ, height, dpr]);

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
    // Crisp acrylic edge line on top of the glow (v1 shadow semantics).
    const pc = Skia.Paint();
    pc.setColor(Skia.Color(hexRgba(needleColor, 0.35)));
    pc.setStrokeWidth(Math.max(0.75, sc * 0.75));
    pc.setStyle(1);
    pc.setAntiAlias(true);
    c.drawPath(path, pc);
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

  // Needle + acrylics memoised likewise — only rebuilds when the needle
  // geometry or colour actually changes.
  const needleCanvas = useMemo(() => (
    <Canvas style={{ position: 'absolute', left: 0, top: 0, width, height }}>

      {/* ── Frosted backing (under the acrylics): smoked-glass band dims the
             waterfall across the passband so the needle keeps contrast on
             bright palettes whatever colour it is ── */}
      {needle && needleFrost > 0 && needle.hiXc > needle.loXc && (
        <Rect x={needle.loXc} y={BAND_H}
              width={needle.hiXc - needle.loXc} height={height - BAND_H}
              color={`rgba(0,0,0,${(needleFrost / 10) * 0.72})`} />
      )}

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
  ), [width, height, needle, needleStrip, edgeStrip, needleColor, needleFrost]);

  // Static overlay (band plan/ticks/dB lines) memoised as ELEMENTS — when the
  // component re-renders for unrelated reasons React reuses the subtree and
  // skips reconciling dozens of Skia nodes.
  const staticOverlayCanvas = useMemo(() => (
    <Canvas style={{ position: 'absolute', left: 0, top: 0, width, height }}>
      {/* Opaque backing for the band/tick strips only — the spectrum graph
          area stays transparent so the instance backdrop image (an RN Image
          UNDER this canvas) can show through; without an image the root's
          #000 shows, indistinguishable from the old rgb(2,2,2) full-height
          backing (WebGL parity). */}
      <Rect x={0} y={0} width={width} height={specTop} color="rgb(2,2,2)" />
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
      {/* ── Faint dB reference lines ── */}
      {specShow && dbLabels.map((d, i) => (
        <Rect key={i} x={0} y={d.y} width={width} height={0.5}
              color="rgba(255,180,0,0.12)" />
      ))}
    </Canvas>
  ), [width, height, specTop, tickTop, bandSegs, ticks, dbLabels, specShow]);

  // ── Render ──────────────────────────────────────────────────────────────────
  // Canvas 1 (bottom): waterfall texture only — the ONLY thing the 120Hz
  // Reanimated scroll repaints. Canvas 2 (top): everything else, repainted at
  // the 10Hz data rate. The canvas bounds clip the over-tall scrolling image.
  return (
    <GestureDetector gesture={gesture}>
      <View style={[styles.root, { width, height }]}>

        {/* Instance spectrum backdrop — behind the line graph only (web
            parity); the canvases above are transparent in that region */}
        {bgImageUrl != null && bgOpacity > 0 && specShow && specH > 8 && (
          <RNImage
            source={{ uri: bgImageUrl }}
            resizeMode="cover"
            style={{ position: 'absolute', left: 0, top: specTop, width,
                     height: specH, opacity: bgOpacity }}
          />
        )}

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

        {staticOverlayCanvas}

        {/* Init splash — the spectrum WS takes 1-2s to deliver its first
            frame; show intent instead of a black void. texReady flips on the
            first pushed row and never re-renders after. */}
        {!texReady && (
          <View style={wfStyles.initWrap} pointerEvents="none">
            <Text style={[wfStyles.initText, { fontFamily }]}>
              WATERFALL INITIALIZING…
            </Text>
          </View>
        )}

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

        {needleCanvas}

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

        {/* Station-ID overlay — top-right of the spectrum (web parity:
            bold "CALLSIGN - NAME", location at 75% beneath, drop shadow) */}
        {stationId != null && specShow && specH > 40 && (
          <View pointerEvents="none"
                style={[styles.stationId, { top: specTop + 6 }]}>
            <Text style={[styles.stationIdL1, { color: stationId.color }]} numberOfLines={1}>
              {stationId.line1}
            </Text>
            {!!stationId.line2 && (
              <Text style={[styles.stationIdL2, { color: stationId.color }]} numberOfLines={1}>
                {stationId.line2}
              </Text>
            )}
          </View>
        )}

      </View>
    </GestureDetector>
  );
}

// ── Styles (typography from v1.5 canvas calls) ───────────────────────────────

const styles = StyleSheet.create({
  root: { overflow: 'hidden', backgroundColor: '#000' },
  stationId: { position: 'absolute', right: 6, alignItems: 'flex-end' },
  stationIdL1: {
    fontSize: 13, fontWeight: 'bold',
    textShadowColor: 'rgba(0,0,0,0.55)', textShadowOffset: { width: 1, height: 1 }, textShadowRadius: 0,
  },
  stationIdL2: {
    fontSize: 11, opacity: 0.75,
    textShadowColor: 'rgba(0,0,0,0.55)', textShadowOffset: { width: 1, height: 1 }, textShadowRadius: 0,
  },
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

// Memo wall: residual SDRScreen renders stop here — every prop is a
// primitive, a stable ref, or a useCallback.
export default React.memo(WaterfallView);

const wfStyles = StyleSheet.create({
  initWrap: {
    position: 'absolute', left: 0, right: 0, top: 0, bottom: 0,
    alignItems: 'center', justifyContent: 'center',
  },
  initText: {
    color: 'rgba(255,255,255,0.55)', fontSize: 14,
    letterSpacing: 2, fontWeight: '600',
  },
});
