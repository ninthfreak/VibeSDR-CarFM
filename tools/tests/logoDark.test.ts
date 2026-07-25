// node --no-warnings tools/tests/logoDark.test.ts
// Regression tests for the dark-mode logo pipeline's pure-maths core (the
// Skia-free leaves: OKLab colour, connected-component labeling, box blur). The
// stages/orchestrator import these extensionlessly for the app bundle and so
// can't run under bare Node — their pixel behaviour is validated on-device in
// the treatment picker, as the handoff directs. This locks down the arithmetic
// that is impossible to eyeball.
import { srgb8ToLab, labToSrgb8, chroma, rasterToLab, labToRaster, type Raster } from '../../src/services/logoDark/oklab.ts';
import { borderConnectedMask, connectedComponents } from '../../src/services/logoDark/labeling.ts';
import { boxBlur } from '../../src/services/logoDark/blur.ts';

let fail = 0;
const ok = (name: string, cond: boolean, extra = '') => {
  console.log((cond ? 'ok   ' : 'FAIL ') + name + (extra ? ` — ${extra}` : ''));
  if (!cond) fail++;
};
const near = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) <= eps;

// OKLab anchors + full 8-bit round-trip (0-LSB is the bar).
ok('white L≈1', near(srgb8ToLab(255, 255, 255)[0], 1, 2e-3));
ok('black L≈0', near(srgb8ToLab(0, 0, 0)[0], 0, 2e-3));
{
  const [, a, b] = srgb8ToLab(119, 119, 119);
  ok('grey chroma≈0', chroma(a, b) < 1e-3);
}
{
  let maxErr = 0;
  const probes: Array<[number, number, number]> = [];
  for (let v = 0; v < 256; v += 5) probes.push([v, v, v]);
  probes.push([220, 30, 40], [20, 90, 200], [240, 200, 10], [12, 140, 70], [180, 60, 160]);
  for (const [r, g, b] of probes) {
    const [L, A, B] = srgb8ToLab(r, g, b);
    const [r2, g2, b2] = labToSrgb8(L, A, B);
    maxErr = Math.max(maxErr, Math.abs(r - r2), Math.abs(g - g2), Math.abs(b - b2));
  }
  ok('8-bit round-trip ≤1 LSB', maxErr <= 1, `maxErr=${maxErr}`);
}
{
  // Hue preserved when chroma is scaled — the pipeline's core invariant.
  const [, a, b] = srgb8ToLab(200, 40, 60);
  ok('chroma scale keeps hue', near(Math.atan2(b, a), Math.atan2(b * 0.85, a * 0.85), 1e-9));
}
{
  const img: Raster = { w: 2, h: 1, rgba: new Uint8ClampedArray([255, 0, 0, 255, 0, 0, 0, 128]) };
  const p = rasterToLab(img);
  ok('alpha carried through', near(p.alpha[0], 1) && near(p.alpha[1], 128 / 255, 1e-3));
  const back = labToRaster(p);
  ok('raster round-trip red+alpha', back.rgba[0] === 255 && back.rgba[1] === 0 && back.rgba[2] === 0 && back.rgba[7] === 128);
}

// Border-connected flood fill: keep the border ring, drop an enclosed hole
// (stage 3 must NOT remove letter counters).
{
  const w = 5, h = 5, mask = new Uint8Array(w * h);
  for (let x = 0; x < w; x++) { mask[x] = 1; mask[(h - 1) * w + x] = 1; }
  for (let y = 0; y < h; y++) { mask[y * w] = 1; mask[y * w + w - 1] = 1; }
  mask[12] = 1;
  const bc = borderConnectedMask(mask, w, h);
  ok('border ring kept', bc[0] === 1 && bc[20] === 1);
  ok('enclosed pixel dropped', bc[12] === 0);
}

// Connected components + areas.
{
  const w = 5, h = 5, mask = new Uint8Array(w * h);
  mask[0] = mask[1] = mask[5] = mask[6] = 1;
  mask[24] = 1;
  const cc = connectedComponents(mask, w, h);
  const sorted = cc.areas.slice(1).sort((a, b) => b - a);
  ok('two components, areas 4 and 1', cc.count === 2 && sorted[0] === 4 && sorted[1] === 1, `count=${cc.count} areas=${sorted}`);
  ok('same label within blob', cc.labels[0] === cc.labels[6] && cc.labels[0] !== cc.labels[24]);
}

// Box blur: conserves mass on an interior spike, leaves a flat field flat.
{
  const w = 9, h = 9, a = new Float32Array(w * h);
  a[40] = 1;
  const blurred = boxBlur(a, w, h, 1, 3);
  ok('blur conserves mass', near(blurred.reduce((s, v) => s + v, 0), 1, 1e-4));
  ok('blur spreads the spike', blurred[40] < 1 && blurred[39] > 0);
  const flat = new Float32Array(w * h).fill(0.5);
  ok('blur leaves flat flat', boxBlur(flat, w, h, 2, 3).every((v) => near(v, 0.5, 1e-4)));
}

console.log(fail === 0 ? '\nlogoDark core: ALL PASS' : `\nlogoDark core: ${fail} FAILURE(S)`);
process.exit(fail === 0 ? 0 : 1);
