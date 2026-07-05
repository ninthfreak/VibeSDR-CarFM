/**
 * useUiScale — port of computeUiScale() + applyUiScale() from Scalable_Mobile_UI_v6_3_1.html
 *
 * Original JS (lines 4263–4384):
 *   function computeUiScale() {
 *     var W = window.innerWidth, H = window.innerHeight;
 *     if (W > H) return Math.max(0.58, Math.min(1.45, W / 926));   // landscape
 *     return Math.max(0.75, Math.min(1.45, W / 390));               // portrait
 *   }
 *
 * Portrait scale examples:
 *   320dp (SE Display Zoom) → 0.82
 *   375dp (SE3 normal)      → 0.96
 *   390dp (iPhone 14)       → 1.00  ← reference
 *   430dp (14 Plus)         → 1.10
 *
 * Landscape scale examples:
 *   568dp (SE Display Zoom) → 0.61
 *   667dp (SE3)             → 0.72
 *   844dp (iPhone 14)       → 0.91
 *   926dp (reference)       → 1.00
 *
 * isSmall: W <= 415 — triggers portrait-sm layout (skin line 4297)
 * isTiny:  W <= 330 — Display Zoom SE absolute minimum
 *
 * r(n): Math.round(n * scale) — use for all layout dp values
 * f(n): n * scale             — use for fontSize (React Native accepts floats)
 */

import { useWindowDimensions } from 'react-native';
import { useMemo } from 'react';

export interface UiScale {
  scale:       number;
  r:           (n: number) => number;
  f:           (n: number) => number;
  isPortrait:  boolean;
  isLandscape: boolean;
  isSmall:     boolean;   // W <= 415
  isTiny:      boolean;   // W <= 330
  isTablet:    boolean;   // shortest side >= 768 (iPad)
  W:           number;
  H:           number;
  drumW:       number;    // scaled BASE_LSV_DW (140)
  drumH:       number;    // scaled drum height (60 portrait / 44 landscape)
  pxStep:      number;    // scaled BASE_LSV_PX_STEP (22)
}

export function useUiScale(): UiScale {
  const { width: W, height: H } = useWindowDimensions();

  return useMemo(() => {
    const isPortrait  = H >= W;
    const isLandscape = !isPortrait;

    // Direct port of computeUiScale()
    const scale = isLandscape
      ? Math.max(0.58, Math.min(1.45, W / 926))
      : Math.max(0.75, Math.min(1.45, W / 390));

    const r = (n: number) => Math.round(n * scale);
    const f = (n: number) => n * scale;

    const isSmall = isPortrait && W <= 415;
    const isTiny  = W <= 330;
    const isTablet = Math.min(W, H) >= 768;

    const drumW  = r(140);
    const drumH  = isPortrait ? r(60) : r(44);
    const pxStep = r(22);

    return { scale, r, f, isPortrait, isLandscape, isSmall, isTiny, isTablet, W, H, drumW, drumH, pxStep };
  }, [W, H]);
}
