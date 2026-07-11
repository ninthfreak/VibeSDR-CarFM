/**
 * main.ts — VibeSDR web client entry.
 *
 * Talks to the VibeServer shim running on a phone. Same origin when served by
 * the shim itself (GET /), so the WS URLs are relative; in dev the splash takes
 * an explicit host:port.
 */

import { SpectrumClient, MODE_BANDWIDTHS, type SDRMode } from './spectrum';
import { AudioPlayer } from './audio';
import { Waterfall } from './waterfall';
import { resolveAuth, withAuth, type AuthState } from './auth';
import { COLORMAP_NAMES } from '../../../src/assets/colormapUtils';
import { stepsForFreq } from '../../../src/services/sdrTypes';
import {
  loadStations, loadBookmarks, getBookmarks, addBookmark, removeBookmark,
  exportBookmarks, importBookmarks, search, type SearchResult,
} from './search';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const MODES: SDRMode[] = ['wfm', 'nfm', 'am', 'usb', 'lsb', 'cwu', 'cwl'];
const LS_SERVERS = 'vibesdr_web_servers_v1';   // { "host:port": pin }
const LS_PREFS   = 'vibesdr_web_prefs_v1';

let step = 1000;                 // tuning step, Hz (restored from prefs on load)
let spec: SpectrumClient | null = null;
let audio: AudioPlayer | null = null;
let wf: Waterfall | null = null;

// ── Saved servers (PIN per host:port, like the app) ──────────────────────────

function savedServers(): Record<string, string> {
  try { return JSON.parse(localStorage.getItem(LS_SERVERS) || '{}'); } catch { return {}; }
}
function saveServer(host: string, pin: string) {
  const s = savedServers();
  s[host] = pin;
  localStorage.setItem(LS_SERVERS, JSON.stringify(s));
}
/** Frequency + mode are remembered PER SERVER — two receivers rarely want the
 *  same dial. Everything else (display, DSP, hardware) is global. */
let currentHost = '';

function lastTuned(): { hz: number; mode: SDRMode } | null {
  const all = (prefs().tuned ?? {}) as Record<string, { hz: number; mode: SDRMode }>;
  const t = all[currentHost];
  return t && t.hz > 0 ? t : null;
}

function saveTuned() {
  if (!spec || !currentHost || !spec.frequency) return;
  const all = (prefs().tuned ?? {}) as Record<string, { hz: number; mode: SDRMode }>;
  all[currentHost] = { hz: Math.round(spec.frequency), mode: spec.mode };
  savePref('tuned', all);
}

function prefs(): Record<string, unknown> {
  try { return JSON.parse(localStorage.getItem(LS_PREFS) || '{}'); } catch { return {}; }
}
function savePref(k: string, v: unknown) {
  const p = prefs(); p[k] = v;
  localStorage.setItem(LS_PREFS, JSON.stringify(p));
}

// ── Splash ───────────────────────────────────────────────────────────────────

function initSplash() {
  const hostEl = $<HTMLInputElement>('host');
  const pinEl  = $<HTMLInputElement>('pin');
  const msg    = $('splashMsg');

  // When the shim serves this page the server IS this origin, so pre-fill it.
  // Port 8080 is the dev server on the Mac, which is NOT a VibeServer — there
  // the box starts from whatever was last used.
  const servedByShim = location.protocol.startsWith('http') && !!location.host
    && location.port !== '8080';
  const saved = savedServers();
  const last = servedByShim ? location.host : ((prefs().lastHost as string) || '');
  hostEl.value = last;
  if (last && saved[last]) pinEl.value = saved[last];

  const go = async (remember: boolean) => {
    const host = hostEl.value.trim().replace(/^https?:\/\//, '').replace(/\/$/, '');
    const pin = pinEl.value.trim();
    if (!host) { msg.textContent = 'Enter a server address'; return; }
    msg.className = 'info';
    msg.textContent = 'Connecting…';
    $<HTMLButtonElement>('btnConnect').disabled = true;
    $<HTMLButtonElement>('btnSaveConnect').disabled = true;
    try {
      await connect(host, pin);
      if (remember) saveServer(host, pin);
      savePref('lastHost', host);
    } catch (e) {
      msg.className = '';
      msg.textContent = e instanceof Error ? e.message : String(e);
      $<HTMLButtonElement>('btnConnect').disabled = false;
      $<HTMLButtonElement>('btnSaveConnect').disabled = false;
    }
  };

  $<HTMLFormElement>('connForm').addEventListener('submit', (e) => { e.preventDefault(); go(false); });
  $('btnSaveConnect').addEventListener('click', () => go(true));
}

// ── Connect ──────────────────────────────────────────────────────────────────

/** UUID v4. NOT crypto.randomUUID() — that is secure-context-only, and a
 *  VibeServer is plain http:// on a LAN IP, so it's undefined there.
 *  crypto.getRandomValues() has no such restriction. */
function uuid(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map(x => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

async function connect(host: string, pin: string) {
  currentHost = host;
  const httpBase = `http://${host}`;
  const wsBase = `ws://${host}`;

  let auth: AuthState;
  try {
    auth = await resolveAuth(httpBase, pin);
  } catch (e) {
    if (e instanceof Error && e.message === 'PIN required') throw new Error('This server needs a PIN');
    // Only a genuine fetch failure means "unreachable". Anything else is a real
    // error and must surface as itself — flattening everything into "can't
    // reach" is what hid the secure-context crypto failure.
    if (e instanceof TypeError) {
      throw new Error(`Can't reach ${host} — check the address and that Server mode is running`);
    }
    throw e;
  }

  const specUrl  = `${wsBase}${withAuth('/ws/user-spectrum?user_session_id=' + uuid() + '&mode=binary8', auth)}`;
  const audioUrl = `${wsBase}${withAuth('/ws/audio', auth)}`;

  // The shim only rejects a bad PIN at WS-upgrade time (401), so surface that
  // as a splash error rather than silently retrying forever.
  await new Promise<void>((resolve, reject) => {
    const probe = new WebSocket(specUrl);
    const t = setTimeout(() => { probe.close(); reject(new Error('Server did not respond')); }, 6000);
    probe.onopen = () => { clearTimeout(t); probe.close(); resolve(); };
    probe.onerror = () => { clearTimeout(t); reject(new Error(auth.required ? 'Wrong PIN, or server refused the connection' : 'Server refused the connection')); };
  });

  startApp(specUrl, audioUrl);
}

// ── App ──────────────────────────────────────────────────────────────────────

function startApp(specUrl: string, audioUrl: string) {
  $('splash').classList.add('hidden');
  $('app').classList.add('live');

  const canvas = $<HTMLCanvasElement>('wf');
  const p = prefs();
  wf = new Waterfall(canvas, {
    palette: (p.palette as string) || 'gqrx',
    // The pref stores the SLIDER's value (0-60 percent), not a fraction.
    specRatio: typeof p.specRatio === 'number' ? p.specRatio / 100 : 0.25,
  });

  spec = new SpectrumClient(specUrl, {
    onBins: (bins, centerHz, bwHz) => {
      noteFrame();
      wf!.push(bins, centerHz, bwHz);
      updateSignal(bins, centerHz, bwHz);
    },
    onConfig: (cfg) => {
      if (!spec!.frequency) {
        // First config. Resume where this server was left, if we've been here
        // before; otherwise park the VFO at the view centre.
        const last = lastTuned();
        spec!.frequency = last?.hz ?? cfg.centerFreq;
        setMode(last?.mode ?? spec!.mode, !!last);
        renderFreq();
        if (last) spec!.tune(last.hz, last.mode, { recenter: true });
      }
    },
    onHwInfo: (gains, rates) => { hwGains = gains; hwRates = rates; populateHw(); },
    onRds: (m) => {
      $('stereo').classList.toggle('on', m.stereo);
      const ps = m.ps.trim();
      const rt = m.radiotext.trim();
      $('rds').innerHTML = ps || rt
        ? `${escapeHtml(ps)} <span class="rt">${escapeHtml(rt)}</span>` : '';
    },
    onStatus: (s, detail) => {
      setStatus(s, detail);
      // Server-side settings live on the SERVER, so restoring the sliders isn't
      // enough — they have to be re-sent, or the UI shows values the radio isn't
      // actually using. Also covers reconnects, where the shim starts fresh.
      if (s === 'open') pushSettingsToServer();
    },
    onRtt: (ms) => { rtt = ms; },
  });
  spec.connect();

  audio = new AudioPlayer(audioUrl, {
    onBytes: (n) => { audioBytes += n; },
    onStatus: (s) => { if (s === 'error') setStatus('error', 'audio'); },
  });
  // The AudioContext is built after several awaits, so the browser no longer
  // credits it to the Connect click and may leave it suspended. Rather than rely
  // on that chain surviving, always arm a resume on the next real interaction.
  audio.start().catch((e) => console.error('audio start failed', e));
  const kick = () => {
    audio?.resume();
    if (!audio?.suspended) {
      window.removeEventListener('pointerdown', kick);
      window.removeEventListener('keydown', kick);
    }
  };
  window.addEventListener('pointerdown', kick);
  window.addEventListener('keydown', kick);

  buildControls();
  initIdleThrottle();
  window.addEventListener('resize', () => { wf!.resize(); });
  window.addEventListener('beforeunload', saveTuned);
  requestAnimationFrame(loop);
}

// ── Render loop ──────────────────────────────────────────────────────────────

let rtt = 0;
let audioBytes = 0;
let lastBytesAt = performance.now();
let audioKbps = 0;
let hwGains: number[] = [];
let hwRates: number[] = [];

function loop() {
  if (!wf || !spec) return;
  wf.vfoHz = spec.frequency;
  // Passband drives the acrylic sidebands — so bandwidth is something you SEE
  // sitting on the signal, not a number you read.
  wf.filterLow = spec.bandwidthLow;
  wf.filterHigh = spec.bandwidthHigh;
  wf.tick();      // synthesise any waterfall lines now due (see Waterfall.tick)
  wf.draw();
  drawScale();

  const now = performance.now();
  if (now - lastBytesAt > 1000) {
    audioKbps = (audioBytes / 1024) / ((now - lastBytesAt) / 1000);
    audioBytes = 0;
    lastBytesAt = now;
    updateStatus();
    updateRecTime();
    checkIdle();
    saveTuned();   // once a second, not per tune — a drum-fast nudge would thrash localStorage
  }
  requestAnimationFrame(loop);
}

// ── Frequency scale ──────────────────────────────────────────────────────────

/** Pick a tick step that yields ~6-10 labels across the span, from a 1/2/5 ladder. */
function tickStep(spanHz: number, targetTicks: number): number {
  const raw = spanHz / targetTicks;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  for (const m of [1, 2, 5, 10]) if (raw <= mag * m) return mag * m;
  return mag * 10;
}

/** Label a frequency at a resolution matched to the tick step — the units must
 *  SWITCH with the span, not just the decimal places, or a wide span overflows
 *  the label and a narrow one shows nothing changing. */
function fmtTick(hz: number, step: number): string {
  if (step >= 1e6) return (hz / 1e6).toFixed(0) + 'M';
  if (step >= 1e5) return (hz / 1e6).toFixed(1) + 'M';
  if (step >= 1e4) return (hz / 1e6).toFixed(2) + 'M';
  if (step >= 1e3) return (hz / 1e6).toFixed(3) + 'M';
  if (step >= 100) return (hz / 1e3).toFixed(1) + 'k';
  return (hz / 1e3).toFixed(2) + 'k';
}

function drawScale() {
  const c = $<HTMLCanvasElement>('scale');
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = Math.round(c.clientWidth * dpr);
  const h = Math.round(c.clientHeight * dpr);
  if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, w, h);
  if (!spec || !wf || !wf.spanHz) return;

  const span = wf.spanHz;
  const lo = wf.centerHz - span / 2;
  const step = tickStep(span, 8);
  const first = Math.ceil(lo / step) * step;

  ctx.font = `${11 * dpr}px ui-monospace, Menlo, monospace`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'bottom';

  for (let f = first; f < lo + span; f += step) {
    const x = ((f - lo) / span) * w;
    ctx.strokeStyle = 'rgba(255,160,0,0.35)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x + 0.5, h);
    ctx.lineTo(x + 0.5, h - 5 * dpr);
    ctx.stroke();
    ctx.fillStyle = 'rgba(255,184,51,0.75)';
    ctx.fillText(fmtTick(f, step), x, h - 7 * dpr);
  }

  // VFO marker on the scale.
  const vx = ((spec.frequency - lo) / span) * w;
  if (vx >= 0 && vx <= w) {
    ctx.strokeStyle = 'rgba(255,229,102,0.9)';
    ctx.beginPath();
    ctx.moveTo(vx + 0.5, 0);
    ctx.lineTo(vx + 0.5, h);
    ctx.stroke();
  }
}

// ── Signal meter (derived from the SPEC bins — the shim sends no S-meter) ────

let sigSmooth = 0, sigPeak = 0;

function updateSignal(bins: Float32Array, centerHz: number, bwHz: number) {
  if (!spec) return;
  // Power in the demod passband, vs the noise floor (median of the frame).
  const n = bins.length;
  const hzPerBin = bwHz / n;
  const lo = centerHz - bwHz / 2;
  const b0 = Math.max(0, Math.floor((spec.frequency + spec.bandwidthLow - lo) / hzPerBin));
  const b1 = Math.min(n - 1, Math.ceil((spec.frequency + spec.bandwidthHigh - lo) / hzPerBin));

  let sigDb = -160;
  for (let i = b0; i <= b1; i++) if (bins[i] > sigDb) sigDb = bins[i];

  const { dbMin, dbMax } = wf!.getRange();
  const norm = Math.max(0, Math.min(1, (sigDb - dbMin) / Math.max(1, dbMax - dbMin)));

  // Asymmetric smoothing: fast attack, slow decay (same feel as the app's meter).
  sigSmooth += (norm - sigSmooth) * (norm > sigSmooth ? 0.55 : 0.18);
  sigPeak = norm > sigPeak ? norm : Math.max(norm, sigPeak - 0.004);

  $('sigFill').style.width = `${(sigSmooth * 100).toFixed(1)}%`;
  $('sigPeak').style.left = `${(sigPeak * 100).toFixed(1)}%`;
  $('sigLabel').textContent = `${sigDb.toFixed(0)} dBFS  ·  ${toSUnit(sigDb)}`;
}

/** dBFS -> S-unit, 6 dB per unit (lifted from the skin's _toSUnit ladder). */
function toSUnit(dbfs: number): string {
  if (dbfs >= -73) return `S9+${Math.min(60, Math.round((dbfs + 73) / 6) * 6)}`;
  const ladder = [-79, -85, -91, -97, -103, -109, -115];
  for (let i = 0; i < ladder.length; i++) if (dbfs >= ladder[i]) return `S${8 - i}`;
  return 'S1';
}

// ── Status ───────────────────────────────────────────────────────────────────

function setStatus(s: string, detail?: string) {
  const el = $('status');
  if (s === 'closed' || s === 'error') {
    el.innerHTML = `<span class="bad">${escapeHtml(detail || s.toUpperCase())}</span>`;
  } else if (s === 'connecting') {
    el.textContent = 'CONNECTING…';
  } else {
    updateStatus();
  }
}

// ── Link quality ─────────────────────────────────────────────────────────────
//
// Measured from SPEC FRAME TIMING, not RTT — a link that has stopped delivering
// frames is broken even if pings still come back, and that's what the app keys
// off too (its own note: an FFT-timing reading taken after the jitter buffer
// "stays green while the network is failing").
//
//   3 green  frames arriving on schedule
//   2 amber  gaps up to 3x the expected interval — jitter or drops
//   1 red    stalled: nothing for over 3x
//   0 (✕)    socket down

let lastFrameAt = 0;
let linkQ: 0 | 1 | 2 | 3 = 0;

function noteFrame() {
  const now = performance.now();
  const expected = 1000 / (throttled ? IDLE_FPS : ACTIVE_FPS);
  if (lastFrameAt) {
    const gap = now - lastFrameAt;
    if (gap > expected * 3) linkQ = 1;
    else if (gap > expected * 1.6) linkQ = 2;
    else linkQ = 3;
  }
  lastFrameAt = now;
}

function updateLink() {
  // No frame for a long time = stalled, regardless of what the last gap said.
  if (!spec || !lastFrameAt) linkQ = 0;
  else {
    const expected = 1000 / (throttled ? IDLE_FPS : ACTIVE_FPS);
    const since = performance.now() - lastFrameAt;
    if (since > expected * 8) linkQ = 1;
    if (since > 5000) linkQ = 0;
  }
  const el = $('linkBars');
  el.className = `q${linkQ}`;
}

function updateStatus() {
  updateLink();
  const idle = throttled ? ` · IDLE ${IDLE_FPS}fps` : '';
  const base = `${audioKbps.toFixed(0)} KB/s · ${rtt.toFixed(0)} ms${idle}`;

  // Silence has several causes that look identical from the outside. Name the one
  // we're in — especially the tab-level mute, which no in-page control can undo.
  let warn = '';
  switch (audio?.health) {
    case 'suspended': warn = 'AUDIO PAUSED — click the page'; break;
    case 'no-stream': warn = 'AUDIO DISCONNECTED'; break;
    case 'silent':    warn = 'NO SOUND — is the browser tab muted?'; break;
  }
  $('status').innerHTML = warn
    ? `${base} · <span class="bad">${warn}</span>`
    : base;
}

// ── Controls ─────────────────────────────────────────────────────────────────

function buildControls() {
  // Mode buttons
  const modes = $('modes');
  modes.innerHTML = '';
  for (const m of MODES) {
    const b = document.createElement('button');
    b.className = 'btn';
    b.textContent = m.toUpperCase();
    b.dataset.mode = m;
    b.onclick = () => setMode(m, true);
    modes.appendChild(b);
  }

  buildVfo();

  $('zoomIn').onclick    = () => spec!.zoomBy(2);
  $('zoomOut').onclick   = () => spec!.zoomBy(0.5);
  $('zoomReset').onclick = () => spec!.resetView();

  const lock = $<HTMLButtonElement>('lockBtn');
  lock.onclick = () => {
    spec!.followVfo = !spec!.followVfo;
    lock.classList.toggle('on', spec!.followVfo);
    lock.textContent = spec!.followVfo ? 'LOCK' : 'FREE';
  };

  const vol = $<HTMLInputElement>('vol');
  vol.value = String(((prefs().volume as number) ?? 0.8) * 100);
  audio!.volume = Number(vol.value) / 100;
  vol.oninput = () => {
    audio!.volume = Number(vol.value) / 100;
    savePref('volume', audio!.volume);
  };
  const mute = $<HTMLButtonElement>('muteBtn');
  mute.onclick = () => {
    audio!.muted = !audio!.muted;
    mute.classList.toggle('on', audio!.muted);
  };

  $('pill').onclick = promptFrequency;
  initBw();
  initRecorder();
  initSearch();
  initBookmarks();
  buildMenu();

  // Station list comes from the SERVER (the app's cached EiBi) — the browser
  // can't fetch eibispace.de itself, no CORS headers there. Absent = degrade to
  // bookmarks + band plan, both of which are local.
  void loadBookmarks();
  void loadStations(currentHost).then((n) => {
    if (n) console.info(`stations: ${n} from server`);
  });
  initWaterfallInput();
  initKeyboard();
}

// ── Idle power saving ────────────────────────────────────────────────────────
//
// The app's client-side idle slowdown saves the SERVER nothing — the phone still
// computes and transmits every frame. So here we throttle the server instead:
// after IDLE_AFTER_MS with no interaction, ask it to drop its spectrum rate. The
// engine then genuinely skips the FFT work (and the Wi-Fi radio goes quiet with
// it), which is what matters for a solar-powered server at the allotment.
//
// Audio is untouched — an idle server still sounds identical. That's deliberate:
// you leave it listening and walk away; it's the WATERFALL nobody is watching.

const IDLE_AFTER_MS = 30_000;
const ACTIVE_FPS = 20;
const IDLE_FPS = 5;

let lastInteraction = Date.now();
let throttled = false;

function markActive() {
  lastInteraction = Date.now();
  if (throttled) {
    throttled = false;
    spec?.setFftRate(ACTIVE_FPS);
    updateStatus();
  }
}

function checkIdle() {
  if (!spec || throttled) return;
  if (Date.now() - lastInteraction < IDLE_AFTER_MS) return;
  throttled = true;
  spec.setFftRate(IDLE_FPS);
  updateStatus();
}

function initIdleThrottle() {
  for (const ev of ['pointerdown', 'pointermove', 'wheel', 'keydown'] as const) {
    window.addEventListener(ev, markActive, { passive: true });
  }
  // A backgrounded tab isn't watching either — throttle immediately, and wake on
  // return rather than waiting out the timer.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { lastInteraction = 0; checkIdle(); }
    else markActive();
  });
}

// ── Search + bookmarks ───────────────────────────────────────────────────────

const SRC_LABEL: Record<string, string> = {
  user: '★', server: 'SRV', eibi: 'EiBi', band: 'BAND',
};

function initSearch() {
  const el = $<HTMLInputElement>('search');
  const list = $('searchResults');
  let results: SearchResult[] = [];
  let sel = -1;

  const close = () => { list.classList.remove('open'); sel = -1; };

  const render = () => {
    if (!results.length) { close(); return; }
    list.innerHTML = '';
    results.forEach((r, i) => {
      const row = document.createElement('div');
      row.className = 'sres' + (i === sel ? ' sel' : '');
      row.innerHTML =
        `<span class="f">${(r.frequency / 1e6).toFixed(3)}</span>` +
        `<span class="n">${r.flag ? r.flag + ' ' : ''}${escapeHtml(r.name)}` +
        (r.detail ? ` <span class="src">${escapeHtml(r.detail)}</span>` : '') +
        `</span>` +
        `<span class="src">${SRC_LABEL[r.source] ?? ''}</span>`;
      row.onclick = () => { tuneTo(r); close(); };
      list.appendChild(row);
    });
    list.classList.add('open');
  };

  el.oninput = () => {
    results = search(el.value);
    sel = -1;
    render();
  };
  el.onfocus = () => { if (results.length) list.classList.add('open'); };
  el.onblur = () => setTimeout(close, 150);   // let a click land first

  el.onkeydown = (e) => {
    if (e.key === 'Escape') { el.blur(); close(); return; }
    if (!results.length) return;
    if (e.key === 'ArrowDown') { sel = Math.min(results.length - 1, sel + 1); render(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { sel = Math.max(0, sel - 1); render(); e.preventDefault(); }
    else if (e.key === 'Enter') {
      tuneTo(results[Math.max(0, sel)]);
      el.blur();
      close();
      e.preventDefault();
    }
  };
}

function tuneTo(r: SearchResult) {
  if (!spec || !r) return;
  const mode = (r.mode || spec.mode) as SDRMode;
  spec.tune(clampTune(r.frequency), mode, { recenter: true });
  setMode(mode, false);
  // A bookmark can carry its own passband — honour it rather than the mode default.
  if (typeof r.bandwidthLow === 'number' && typeof r.bandwidthHigh === 'number') {
    spec.setBandwidth(r.bandwidthLow, r.bandwidthHigh);
    syncBw();
  }
  renderFreq();
  syncStep();
}

function initBookmarks() {
  $('bookmarksBtn').onclick = () => {
    $('bookmarksPanel').classList.toggle('open');
    renderBookmarks();
  };
  $('bmClose').onclick = () => $('bookmarksPanel').classList.remove('open');

  // Bookmark whatever we're listening to right now.
  $('bmAdd').onclick = async () => {
    if (!spec) return;
    const name = prompt('Bookmark name', `${(spec.frequency / 1e6).toFixed(3)} MHz ${spec.mode.toUpperCase()}`);
    if (!name) return;
    await addBookmark({
      name,
      frequency: Math.round(spec.frequency),
      mode: spec.mode,
      group: null, comment: null, extension: null,
      bandwidth_low: spec.bandwidthLow,
      bandwidth_high: spec.bandwidthHigh,
    });
    renderBookmarks();
  };

  // Export: the same UberSDR-importable JSON the phone app writes, so bookmarks
  // move between browser, phone and desktop UberSDR.
  $('bmExport').onclick = () => {
    const blob = new Blob([exportBookmarks()], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'vibesdr-bookmarks.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
  };

  $('bmImport').onclick = () => $('bmFile').click();
  $<HTMLInputElement>('bmFile').onchange = async (e) => {
    const f = (e.target as HTMLInputElement).files?.[0];
    if (!f) return;
    try {
      const n = await importBookmarks(await f.text());
      renderBookmarks();
      $('bmMsg').textContent = `Imported ${n} bookmark${n === 1 ? '' : 's'}`;
    } catch (err) {
      $('bmMsg').textContent = err instanceof Error ? err.message : 'Import failed';
    }
    $<HTMLInputElement>('bmFile').value = '';
  };
}

function renderBookmarks() {
  const host = $('bmList');
  const list = getBookmarks();
  host.innerHTML = '';
  if (!list.length) {
    host.innerHTML = '<div class="sres"><span class="n">No bookmarks yet — tune something and press ADD.</span></div>';
    return;
  }
  for (const b of [...list].sort((a, z) => a.frequency - z.frequency)) {
    const row = document.createElement('div');
    row.className = 'sres';
    row.innerHTML =
      `<span class="f">${(b.frequency / 1e6).toFixed(3)}</span>` +
      `<span class="n">${escapeHtml(b.name)}</span>` +
      `<span class="src">${(b.mode || '').toUpperCase()}</span>`;
    row.onclick = () => {
      tuneTo({
        name: b.name, frequency: b.frequency, mode: b.mode, source: 'user',
        bandwidthLow: b.bandwidth_low, bandwidthHigh: b.bandwidth_high,
      });
      $('bookmarksPanel').classList.remove('open');
    };
    const del = document.createElement('button');
    del.className = 'btn';
    del.textContent = '✕';
    del.onclick = async (e) => {
      e.stopPropagation();
      await removeBookmark(b.name, b.frequency);
      renderBookmarks();
    };
    row.appendChild(del);
    host.appendChild(row);
  }
}

// ── Recorder ─────────────────────────────────────────────────────────────────

function initRecorder() {
  const btn = $<HTMLButtonElement>('recBtn');
  btn.onclick = () => {
    if (!audio) return;
    if (!audio.recording) {
      audio.startRecording();
      btn.classList.add('rec');
      btn.textContent = '■ STOP';
      return;
    }
    const blob = audio.stopRecording();
    btn.classList.remove('rec');
    btn.textContent = '● REC';
    $('recTime').textContent = '';
    if (!blob) return;

    // Name it the way the app does: frequency + mode + timestamp, so a folder of
    // recordings is self-describing.
    const f = (spec!.frequency / 1e6).toFixed(3);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `VibeSDR_${f}MHz_${spec!.mode.toUpperCase()}_${stamp}.wav`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
  };
}

function updateRecTime() {
  if (!audio?.recording) return;
  const s = Math.floor(audio.recordedSeconds);
  $('recTime').textContent =
    `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

// ── Menu: Radio / Audio / Display ────────────────────────────────────────────

/** Wire a slider: live label, live effect, persisted. */
function slider(
  id: string, valId: string,
  fmt: (v: number) => string,
  apply: (v: number) => void,
  prefKey?: string,
) {
  const el = $<HTMLInputElement>(id);
  const lbl = $(valId);
  const saved = prefKey ? prefs()[prefKey] : undefined;
  if (typeof saved === 'number') el.value = String(saved);
  const run = () => {
    const v = Number(el.value);
    lbl.textContent = fmt(v);
    apply(v);
  };
  el.oninput = () => { run(); if (prefKey) savePref(prefKey, Number(el.value)); };
  run();
}

/** Wire a toggle button: ON/OFF text, live effect, persisted. */
function toggle(id: string, apply: (on: boolean) => void, prefKey?: string, initial = false) {
  const el = $<HTMLButtonElement>(id);
  const saved = prefKey ? prefs()[prefKey] : undefined;
  let on = typeof saved === 'boolean' ? saved : initial;
  const run = () => {
    el.classList.toggle('on', on);
    el.textContent = on ? 'ON' : 'OFF';
    apply(on);
  };
  el.onclick = () => { on = !on; run(); if (prefKey) savePref(prefKey, on); };
  run();
}

/** Wire a segmented control (data-<attr> on each button). */
function segment(id: string, attr: string, apply: (v: number) => void, prefKey?: string) {
  const host = $(id);
  const btns = Array.from(host.children) as HTMLButtonElement[];
  const saved = prefKey ? prefs()[prefKey] : undefined;
  const pick = (v: number, fire: boolean) => {
    for (const b of btns) b.classList.toggle('on', Number(b.dataset[attr]) === v);
    if (fire) apply(v);
  };
  for (const b of btns) {
    b.onclick = () => {
      const v = Number(b.dataset[attr]);
      pick(v, true);
      if (prefKey) savePref(prefKey, v);
    };
  }
  pick(typeof saved === 'number' ? saved : Number(btns[0].dataset[attr]), false);
}

function buildMenu() {
  $('menuBtn').onclick   = () => $('menu').classList.toggle('open');
  $('menuClose').onclick = () => $('menu').classList.remove('open');

  // ── Radio (server-side hardware; ranges filled in from hwinfo) ────────────
  $<HTMLInputElement>('ppm').oninput = () => {
    const v = Number($<HTMLInputElement>('ppm').value);
    $('ppmVal').textContent = String(v);
    spec!.setHwPpm(v);
    savePref('ppm', v);
  };
  toggle('biasT', (on) => spec!.setHwBiasT(on), 'biasT');
  toggle('agc',   (on) => spec!.setHwAgc(on),   'agc');
  segment('dsSeg', 'ds', (v) => spec!.setHwDirectSampling(v as 0 | 1 | 2), 'directSampling');

  const gainAuto = $<HTMLButtonElement>('gainAuto');
  gainAuto.onclick = () => {
    const on = !gainAuto.classList.contains('on');
    gainAuto.classList.toggle('on', on);
    $<HTMLInputElement>('gain').disabled = on;
    if (on) spec!.setHwGain(0, true);
    else spec!.setHwGain(hwGains[Number($<HTMLInputElement>('gain').value)] ?? 0, false);
  };

  // ── Audio (server-side DSP in the shim) ──────────────────────────────────
  slider('sql', 'sqlVal',
    (v) => (v <= -100 ? 'OFF' : `${v} dB`),
    (v) => spec!.setSquelch(v),
    'squelch');

  slider('nr', 'nrVal',
    (v) => (v === 0 ? 'OFF' : `${v}%`),
    (v) => spec!.setNr(v > 0, v / 100),
    'nr');

  toggle('notch', (on) => spec!.setNotch(on), 'notch');
  toggle('stereoBtn', (on) => {
    $('stereoBtn').textContent = on ? 'ON' : 'OFF';
    spec!.setStereo(on);
  }, 'stereo', true);
  segment('deemphSeg', 'tau', (us) => spec!.setDeemph(us * 1e-6), 'deemph');

  // ── Display (client-side; SignalProcessor + palette, same as the app) ─────
  const pal = $<HTMLSelectElement>('palette');
  for (const name of [...COLORMAP_NAMES].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))) {
    const o = document.createElement('option');
    o.value = name; o.textContent = name;
    pal.appendChild(o);
  }
  pal.value = wf!.palette;
  pal.onchange = () => { wf!.setPalette(pal.value); savePref('palette', pal.value); };

  slider('specRatio', 'specRatioVal', (v) => `${v}%`,
    (v) => wf!.setSpecRatio(v / 100), 'specRatio');
  slider('bright', 'brightVal', (v) => String(v),
    (v) => wf!.applySettings({ wfBrightness: v }), 'wfBrightness');
  slider('contrast', 'contrastVal', (v) => String(v),
    (v) => wf!.applySettings({ wfContrast: v }), 'wfContrast');
  slider('sharp', 'sharpVal', (v) => String(v),
    (v) => wf!.applySettings({ wfSharpness: v }), 'wfSharpness');
  slider('smooth', 'smoothVal', (v) => String(v),
    (v) => wf!.applySettings({ smoothingFrames: v }), 'smoothingFrames');
  toggle('peakHold', (on) => wf!.applySettings({ peakHold: on }), 'peakHold', true);

  // ── VFO (needle + acrylic sidebands), as in the app ──────────────────────
  const colEl = $<HTMLInputElement>('vfoColor');
  const savedCol = prefs().vfoColor;
  if (typeof savedCol === 'string') colEl.value = savedCol;
  wf!.vfoColor = colEl.value;
  colEl.oninput = () => { wf!.vfoColor = colEl.value; savePref('vfoColor', colEl.value); };

  slider('vfoGlow', 'vfoGlowVal', (v) => String(v),
    (v) => { wf!.vfoIntensity = v; }, 'vfoIntensity');
  slider('vfoFrost', 'vfoFrostVal', (v) => (v === 0 ? 'OFF' : String(v)),
    (v) => { wf!.vfoFrost = v; }, 'vfoFrost');
}

/**
 * Re-send every SERVER-side setting we've persisted. Called whenever the
 * spectrum socket opens (first connect, and every reconnect — the shim keeps no
 * per-client state, so a reconnect silently reverts the radio to defaults).
 *
 * Client-side settings (palette, brightness, spectrum split…) don't appear here:
 * they're applied locally when the menu is built.
 */
function pushSettingsToServer() {
  if (!spec) return;
  const p = prefs();
  const num = (k: string) => (typeof p[k] === 'number' ? p[k] as number : undefined);
  const bool = (k: string) => (typeof p[k] === 'boolean' ? p[k] as boolean : undefined);

  const sql = num('squelch');       if (sql !== undefined) spec.setSquelch(sql);
  const nr = num('nr');             if (nr !== undefined) spec.setNr(nr > 0, nr / 100);
  const notch = bool('notch');      if (notch !== undefined) spec.setNotch(notch);
  const stereo = bool('stereo');    if (stereo !== undefined) spec.setStereo(stereo);
  const deemph = num('deemph');     if (deemph !== undefined) spec.setDeemph(deemph * 1e-6);
  const ppm = num('ppm');           if (ppm !== undefined) spec.setHwPpm(ppm);
  const biasT = bool('biasT');      if (biasT !== undefined) spec.setHwBiasT(biasT);
  const agc = bool('agc');          if (agc !== undefined) spec.setHwAgc(agc);
  const ds = num('directSampling'); if (ds !== undefined) spec.setHwDirectSampling(ds as 0 | 1 | 2);

  // Re-assert the frame rate: the shim keeps whatever it was last set to, so a
  // reconnect could otherwise land in a stuck 5 fps with no way back.
  spec.setFftRate(throttled ? IDLE_FPS : ACTIVE_FPS);

  // Gain and sample rate wait for hwinfo — we can't validate them until the
  // server has told us what this dongle actually supports.
}

/** The server tells us its real gain steps and sample rates (hwinfo) — the
 *  client can't query a remote dongle, so the controls are built from that. */
function populateHw() {
  if (hwGains.length) {
    const g = $<HTMLInputElement>('gain');
    g.min = '0';
    g.max = String(hwGains.length - 1);
    const savedIdx = prefs().gainIdx;
    g.value = String(typeof savedIdx === 'number'
      ? Math.min(hwGains.length - 1, savedIdx)
      : hwGains.length - 1);
    const show = () => {
      const tenths = hwGains[Number(g.value)] ?? 0;
      $('gainVal').textContent = `${(tenths / 10).toFixed(1)} dB`;
    };
    g.oninput = () => {
      show();
      spec!.setHwGain(hwGains[Number(g.value)] ?? 0, false);
      savePref('gainIdx', Number(g.value));
    };
    show();
    // Push the restored gain — otherwise the slider shows a value the radio
    // isn't using.
    if (typeof savedIdx === 'number') spec!.setHwGain(hwGains[Number(g.value)] ?? 0, false);
  }
  if (hwRates.length) {
    const r = $<HTMLSelectElement>('rate');
    r.innerHTML = '';
    for (const rate of hwRates) {
      const o = document.createElement('option');
      o.value = String(rate);
      o.textContent = `${(rate / 1e6).toFixed(3).replace(/0+$/, '').replace(/\.$/, '')} MS/s`;
      r.appendChild(o);
    }
    r.onchange = () => {
      spec!.setHwSampleRate(Number(r.value));
      savePref('sampleRate', Number(r.value));
    };
    const saved = prefs().sampleRate;
    // Only restore a rate this dongle actually offers (hwinfo is authoritative).
    if (typeof saved === 'number' && hwRates.includes(saved)) {
      r.value = String(saved);
      spec!.setHwSampleRate(saved);
    }
  }
}

function setMode(m: SDRMode, send: boolean) {
  if (!spec) return;
  if (send) spec.setMode(m);
  else { spec.mode = m; const bw = MODE_BANDWIDTHS[m]; spec.bandwidthLow = bw[0]; spec.bandwidthHigh = bw[1]; }
  $('modeLbl').textContent = m.toUpperCase();
  for (const b of Array.from($('modes').children) as HTMLButtonElement[]) {
    b.classList.toggle('on', b.dataset.mode === m);
  }
  if (m !== 'wfm') { $('stereo').classList.remove('on'); $('rds').innerHTML = ''; }
  syncBw();
}

// ── Demodulator bandwidth ────────────────────────────────────────────────────
//
// The slider is a single WIDTH, but the passband isn't symmetric in every mode:
// SSB sits entirely on one side of the carrier. So width is mapped to a low/high
// pair per mode rather than assumed to be ±width/2.

/** Sensible width range per mode, Hz. */
const BW_RANGE: Record<SDRMode, [number, number]> = {
  usb: [500, 6000],   lsb: [500, 6000],
  am:  [2000, 20000], sam: [2000, 20000],
  cwu: [100, 2000],   cwl: [100, 2000],
  fm:  [5000, 30000], nfm: [5000, 30000],
  wfm: [50000, 250000],
};

/** Width -> (low, high) about the carrier, per mode. */
function bwPair(mode: SDRMode, width: number): [number, number] {
  switch (mode) {
    case 'usb': return [50, 50 + width];        // entirely above the carrier
    case 'lsb': return [-(50 + width), -50];    // entirely below
    default:    return [-width / 2, width / 2]; // symmetric
  }
}

function fmtBw(hz: number): string {
  return hz >= 1000 ? `${(hz / 1000).toFixed(hz >= 100_000 ? 0 : 1)}k` : `${hz}`;
}

/** Point the slider at the current mode's range, seeded from the mode default. */
function syncBw() {
  if (!spec) return;
  const el = $<HTMLInputElement>('bw');
  const [min, max] = BW_RANGE[spec.mode];
  const width = Math.abs(spec.bandwidthHigh - spec.bandwidthLow);
  el.min = String(min);
  el.max = String(max);
  el.step = String(Math.max(50, Math.round((max - min) / 100)));
  el.value = String(Math.max(min, Math.min(max, Math.round(width))));
  $('bwVal').textContent = fmtBw(Number(el.value));
}

function initBw() {
  const el = $<HTMLInputElement>('bw');
  el.oninput = () => {
    if (!spec) return;
    const width = Number(el.value);
    $('bwVal').textContent = fmtBw(width);
    const [lo, hi] = bwPair(spec.mode, width);
    spec.setBandwidth(Math.round(lo), Math.round(hi));
  };
  syncBw();
}

/** The step ladder is band-aware — the app switches to VHF steps above 30 MHz,
 *  where 10 Hz is uselessly small for broadcast FM and repeaters. */
function formatStep(hz: number): string {
  if (hz >= 1000) {
    const k = hz / 1000;
    return `${k % 1 === 0 ? k : k.toFixed(1)}kHz`;
  }
  return `${hz}Hz`;
}

function buildVfo() {
  const saved = prefs().step;
  if (typeof saved === 'number' && saved > 0) step = saved;
  $('tuneDown').onclick = () => nudge(-step);
  $('tuneUp').onclick   = () => nudge(step);
  $('stepBtn').onclick  = cycleStep;
  syncStep();
  renderFreq();
}

/** Click the step button to walk the ladder for the current band. */
function cycleStep() {
  if (!spec) return;
  const steps = stepsForFreq(spec.frequency);
  const i = steps.indexOf(step);
  step = steps[(i + 1) % steps.length];
  $('stepBtn').textContent = formatStep(step);
  savePref('step', step);
}

/** Keep the step legal for the band we're in — the HF and VHF ladders differ,
 *  so a step carried across 30 MHz can land off-ladder. */
function syncStep() {
  if (!spec) return;
  const steps = stepsForFreq(spec.frequency);
  if (!steps.includes(step)) {
    // Nearest step on the new ladder, so crossing the boundary doesn't jolt.
    step = steps.reduce((a, s) => Math.abs(s - step) < Math.abs(a - step) ? s : a, steps[0]);
  }
  $('stepBtn').textContent = formatStep(step);
}

/** Never let the VFO walk down to DC — 0 Hz is not a frequency, and once there
 *  the display reads 0.000 and nothing sensible can be tuned. */
const MIN_TUNE_HZ = 10_000;

function clampTune(hz: number): number {
  const max = spec?.cfg.maxBandwidth
    ? Math.max(30e6, spec.cfg.centerFreq + spec.cfg.maxBandwidth)
    : 2e9;
  return Math.max(MIN_TUNE_HZ, Math.min(max, Math.round(hz)));
}

function nudge(hz: number) {
  if (!spec) return;
  // Snap to the step grid so repeated nudges stay on round frequencies.
  const mag = Math.abs(hz);
  const next = Math.round((spec.frequency + hz) / mag) * mag;
  spec.tune(clampTune(next));
  syncStep();
  renderFreq();
}

function renderFreq() {
  if (!spec) return;
  $('freq').textContent = (Math.round(spec.frequency) / 1e6).toFixed(3);
}

function promptFrequency() {
  if (!spec) return;
  const v = prompt('Frequency (MHz)', (spec.frequency / 1e6).toFixed(4));
  if (!v) return;
  const mhz = parseFloat(v.replace(/[^\d.]/g, ''));
  if (!isFinite(mhz) || mhz <= 0) return;
  spec.tune(clampTune(mhz * 1e6), undefined, { recenter: true });
  renderFreq();
}

// ── Waterfall input: click-to-tune, drag-to-pan, wheel-to-zoom ───────────────

function initWaterfallInput() {
  const c = $<HTMLCanvasElement>('wf');
  let dragging = false;
  let moved = false;
  let lastX = 0;

  c.addEventListener('pointerdown', (e) => {
    dragging = true; moved = false; lastX = e.clientX;
    c.setPointerCapture(e.pointerId);
    c.classList.add('panning');
  });

  c.addEventListener('pointermove', (e) => {
    if (!dragging || !spec || !wf) return;
    const dx = e.clientX - lastX;
    if (Math.abs(dx) < 1) return;
    if (Math.abs(e.clientX - lastX) > 2) moved = true;
    lastX = e.clientX;
    // Drag the spectrum: moving right pulls lower frequencies into view.
    spec.pan(wf.centerHz - dx * wf.hzPerPx());
  });

  c.addEventListener('pointerup', (e) => {
    dragging = false;
    c.classList.remove('panning');
    if (!moved && spec && wf) {
      const rect = c.getBoundingClientRect();
      // Snap the click to the step grid, so the arrows carry on from a round number.
      const hz = Math.round(wf.xToHz(e.clientX - rect.left) / step) * step;
      spec.tune(clampTune(hz));
      syncStep();
      renderFreq();
    }
  });

  c.addEventListener('wheel', (e) => {
    e.preventDefault();
    if (!spec) return;
    spec.zoomBy(e.deltaY < 0 ? 1.25 : 0.8);
  }, { passive: false });
}

function initKeyboard() {
  window.addEventListener('keydown', (e) => {
    if (!spec) return;
    const tgt = e.target as HTMLElement;
    if (tgt && /INPUT|SELECT|TEXTAREA/.test(tgt.tagName)) return;

    // Arrow keys tune by the selected step (×10 with Shift for a fast run).
    const d = step * (e.shiftKey ? 10 : 1);
    switch (e.key) {
      case 'ArrowLeft':  nudge(-d); e.preventDefault(); break;
      case 'ArrowRight': nudge(d);  e.preventDefault(); break;
      case '[': case ']': cycleStep(); e.preventDefault(); break;
      case 'ArrowUp':    spec.zoomBy(1.25); e.preventDefault(); break;
      case 'ArrowDown':  spec.zoomBy(0.8);  e.preventDefault(); break;
      case 'm': audio!.muted = !audio!.muted; $('muteBtn').classList.toggle('on', audio!.muted); break;
      default: {
        // Mode letter keys: first mode whose name starts with the key.
        const m = MODES.find(x => x[0] === e.key.toLowerCase());
        if (m) setMode(m, true);
      }
    }
  });
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!
  ));
}

initSplash();
