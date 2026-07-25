// labeling.ts — the two connected-component primitives the handoff flags as
// "the one real gap" (not in the Android SDK; we'd have pulled in 10-20MB of
// OpenCV per ABI for them). Both are 4-connectivity, which the doc says is
// sufficient. Pure TS, Node-testable.
//
//   • borderConnectedMask — stage 3: from a boolean "background-coloured" mask,
//     keep only the region reachable from the image border. A stack-based
//     scanline flood fill (the doc's recommended simpler route than full
//     labeling for stage 3).
//   • connectedComponents — stage 5a: label every component and return per-label
//     pixel areas, so `protect` can keep only light-neutral blobs ≥ 8% of bbox.

/** Border-connected subset of `mask` (1 = candidate background pixel).
 *  Returns a fresh Uint8Array where 1 = in `mask` AND reachable from the border
 *  through other masked pixels (4-connected). Iterative stack; no recursion, so
 *  a 1M-pixel image can't blow the call stack. */
export function borderConnectedMask(mask: Uint8Array, w: number, h: number): Uint8Array {
  const out = new Uint8Array(w * h);
  const stack: number[] = [];
  const push = (i: number) => { if (mask[i] && !out[i]) { out[i] = 1; stack.push(i); } };

  // Seed from every border pixel that is itself background-coloured.
  for (let x = 0; x < w; x++) { push(x); push((h - 1) * w + x); }
  for (let y = 0; y < h; y++) { push(y * w); push(y * w + (w - 1)); }

  while (stack.length) {
    const i = stack.pop() as number;
    const x = i % w, y = (i / w) | 0;
    if (x > 0) push(i - 1);
    if (x < w - 1) push(i + 1);
    if (y > 0) push(i - w);
    if (y < h - 1) push(i + w);
  }
  return out;
}

export type Components = {
  /** Per-pixel label; 0 = not in the mask, ≥1 = component id. */
  labels: Int32Array;
  /** areas[id] = pixel count for component `id` (areas[0] is unused/0). */
  areas: number[];
  count: number;
};

/** Two-pass union-find connected-component labeling of `mask` (1 = foreground),
 *  4-connectivity. Returns per-pixel labels (1-based) and per-label areas. */
export function connectedComponents(mask: Uint8Array, w: number, h: number): Components {
  const n = w * h;
  const parent = new Int32Array(n + 1);   // union-find over provisional labels
  let next = 0;
  const find = (x: number): number => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  const union = (a: number, b: number) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[ra < rb ? rb : ra] = ra < rb ? ra : rb; };

  const prov = new Int32Array(n);         // provisional label per pixel
  // Pass 1: assign provisional labels, record equivalences (west + north).
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!mask[i]) continue;
      const west = x > 0 && mask[i - 1] ? prov[i - 1] : 0;
      const north = y > 0 && mask[i - w] ? prov[i - w] : 0;
      if (!west && !north) { next++; parent[next] = next; prov[i] = next; }
      else if (west && !north) prov[i] = west;
      else if (!west && north) prov[i] = north;
      else { prov[i] = west; if (west !== north) union(west, north); }
    }
  }

  // Pass 2: resolve to root labels, compact to 1..count, tally areas.
  const remap = new Int32Array(next + 1);
  const labels = new Int32Array(n);
  const areas: number[] = [0];
  let count = 0;
  for (let i = 0; i < n; i++) {
    if (!prov[i]) continue;
    const root = find(prov[i]);
    let id = remap[root];
    if (id === 0) { id = ++count; remap[root] = id; areas[id] = 0; }
    labels[i] = id;
    areas[id]++;
  }
  return { labels, areas, count };
}
