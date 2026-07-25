// blur.ts — a three-pass box blur, which approximates a Gaussian closely enough
// at the tiny radii this pipeline uses (1.0px alpha feather in stage 3, 2.5px
// halo glow in stage 5b). The handoff explicitly recommends this over the
// deprecated ScriptIntrinsicBlur / API-31 RenderEffect to avoid version
// branching for two small blurs. Operates on a Float32 alpha plane in place-free
// fashion (returns a new array), separable H then V, three passes.

/** Box blur of a single Float32 plane, `radius` px, `passes` times (default 3).
 *  Separable (horizontal then vertical) with clamped edges. Returns a new array;
 *  the input is not modified. radius <= 0 returns a copy. */
export function boxBlur(src: Float32Array, w: number, h: number, radius: number, passes = 3): Float32Array {
  let cur = Float32Array.from(src);
  if (radius <= 0) return cur;
  const r = Math.max(1, Math.round(radius));
  let tmp = new Float32Array(w * h);
  for (let p = 0; p < passes; p++) {
    boxBlurH(cur, tmp, w, h, r);
    boxBlurV(tmp, cur, w, h, r);
  }
  return cur;
}

// Horizontal pass with a running sum (O(n), independent of radius).
function boxBlurH(src: Float32Array, dst: Float32Array, w: number, h: number, r: number): void {
  const norm = 1 / (2 * r + 1);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let sum = 0;
    // Prime the window at x = -1 → [-r .. r-1], clamped to [0, w-1].
    for (let k = -r; k <= r; k++) sum += src[row + clamp(k, 0, w - 1)];
    for (let x = 0; x < w; x++) {
      dst[row + x] = sum * norm;
      const add = src[row + clamp(x + r + 1, 0, w - 1)];
      const sub = src[row + clamp(x - r, 0, w - 1)];
      sum += add - sub;
    }
  }
}

// Vertical pass, same running-sum trick down each column.
function boxBlurV(src: Float32Array, dst: Float32Array, w: number, h: number, r: number): void {
  const norm = 1 / (2 * r + 1);
  for (let x = 0; x < w; x++) {
    let sum = 0;
    for (let k = -r; k <= r; k++) sum += src[clamp(k, 0, h - 1) * w + x];
    for (let y = 0; y < h; y++) {
      dst[y * w + x] = sum * norm;
      const add = src[clamp(y + r + 1, 0, h - 1) * w + x];
      const sub = src[clamp(y - r, 0, h - 1) * w + x];
      sum += add - sub;
    }
  }
}

function clamp(v: number, lo: number, hi: number): number { return v < lo ? lo : v > hi ? hi : v; }
