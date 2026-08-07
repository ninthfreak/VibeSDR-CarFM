// nwdRadio.ts — JS side of the NOWADA (NWD) built-in head-unit FM tuner backend.
//
// Thin typed wrapper over the native `NwdRadio` module (NwdRadioModule.kt), which
// binds the vendor service `com.nwd.radio.service`. The native side is the
// productised form of the validated `spike/nwd-tuner-probe`.
//
// This backend is unlike the SDR adapters: audio is analog + MCU-routed (nothing
// streams to the app), there is no spectrum, and RDS arrives already decoded
// (PS / RadioText / PTY / TA / stereo) via native callback events. So it does NOT
// implement SDRBackend — RadioScreen drives the CarFM face from these events
// directly (see the carFm NWD effect there).

import { NativeEventEmitter, NativeModules, Platform } from 'react-native';

type NwdNative = {
  isAvailable(): Promise<boolean>;
  connect(): Promise<NwdConnectInfo>;
  disconnect(): void;
  tune(mhz: number): Promise<number>;
  seek(up: boolean): void;
  poll(): Promise<NwdPoll | null>;
  probe(): Promise<string>;
  setRdsEnabled(on: boolean): void;
  setAudioEnabled(on: boolean): void;
  sendPanelKey?(key: number): void;
  probeNwdFmManager?(): Promise<string>;
  startLevelWatch?(intervalMs: number): void;
  stopLevelWatch?(): void;
  readLevelNow?(): void;
  startIlluminationWatch?(): void;
  addListener(eventName: string): void;
  removeListeners(count: number): void;
};

export type NwdConnectInfo = {
  band: number; freqMult: number; mhz?: number; ps?: string;
  // No `stereo` here on purpose: the connect map no longer carries one (the
  // native getter is stuck true). Stereo arrives only via NwdRadioStereo.
  registered?: boolean; rt?: string; pty?: number;
};

const native: NwdNative | undefined =
  Platform.OS === 'android' ? (NativeModules.NwdRadio as NwdNative | undefined) : undefined;

// A shared emitter so every subscribe() call multiplexes one native bridge.
const emitter = native ? new NativeEventEmitter(NativeModules.NwdRadio) : null;

// ── Detection ────────────────────────────────────────────────────────────────
/** True only on an NWD/NOWADA head unit that exposes com.nwd.radio.service.
 *  Cheap PackageManager probe; drives the settings tuner-source "Detected" state
 *  and whether CarFM offers the built-in tuner at all. Never throws. */
export async function isNwdAvailable(): Promise<boolean> {
  if (!native) return false;
  try { return await native.isAvailable(); } catch { return false; }
}

// ── Lifecycle / control ──────────────────────────────────────────────────────
export function nwdConnect(): Promise<NwdConnectInfo> {
  if (!native) return Promise.reject(new Error('NWD radio module unavailable'));
  return native.connect();
}
export function nwdDisconnect(): void { native?.disconnect(); }
export function nwdTune(mhz: number): Promise<number> {
  if (!native) return Promise.reject(new Error('NWD radio module unavailable'));
  return native.tune(mhz);
}
export function nwdSeek(up: boolean): void { native?.seek(up); }
/** Current tuner state via the synchronous getters (the push callbacks don't
 *  reach us on-device). Null when not connected. Never rejects. */
export type NwdPoll = {
  mhz?: number; ps?: string; stereo?: boolean; rt?: string; pty?: number;
  /** MCU audio source: 4 = FM, anything else = something else owns the speakers,
   *  -1 = could not read. This, not Android audio focus, is whether FM is
   *  actually playing on a head unit — and unlike focus it recovers by itself. */
  source?: number;
};
export function nwdPoll(): Promise<NwdPoll | null> {
  if (!native) return Promise.resolve(null);
  return native.poll().catch(() => null);
}
/** One-shot diagnostic dump of every readable NWD getter (station name, RadioText,
 *  RDS-enable selectors, band plan incl. seek step, presets, radio/scan state) —
 *  drives the settings "RDS probe" button. Multi-line string; never rejects to a
 *  throw the UI must catch. Null-safe: returns a note if the module is absent. */
export async function nwdProbe(): Promise<string> {
  if (!native) return 'NWD radio module unavailable';
  try { return await native.probe(); } catch (e) { return `probe failed: ${String(e)}`; }
}
export function nwdSetRds(on: boolean): void { native?.setRdsEnabled(on); }
export function nwdSetAudio(on: boolean): void { native?.setAudioEnabled(on); }

// ── Events ───────────────────────────────────────────────────────────────────
export type NwdEvents = {
  NwdRadioFrequency: { band: number; freq: number; mhz: number; ps: string; arg: number };
  NwdRadioRt: { rt: string };
  NwdRadioStereo: { on: boolean };
  NwdRadioPty: { pty: number };
  NwdRadioScanState: { state: number };
  /** One raw RDS group, 16 hex chars (4 blocks x 2 bytes), from
   *  com.nwd.app.NwdFmManager.getRadioRDSDataArm(). Feed to createNwdRdsDecoder
   *  in nwdRds.ts — this is the channel the bound AIDL cannot provide. */
  NwdRdsGroup: { hex: string };
  /** Signal level from NwdFmManager.seek(currentFrequency) — see nwdSignalLevel.
   *  `ok` is false when the tuner did not stay on the frequency we asked about,
   *  or when the call failed; `level` is meaningless then. UNDER DEVELOPMENT. */
  NwdRadioLevel: { level: number; asked: number; landed: number; ok: boolean; err?: string };
  NwdRadioState: { state: number };
  NwdRadioDisconnected: Record<string, never>;
  /** Steering-wheel / front-panel key, straight off the MCU's unprotected
   *  `com.nwd.action.ACTION_KEY_VALUE` broadcast (see NwdRadioModule). 62 =
   *  preset next, 63 = preset prev; see PANEL_KEY below. */
  NwdPanelKey: { key: number; action: string };
  /** Vendor illumination (headlights) broadcast `com.nwd.ACTION_ILL_STATE_CHANGE`.
   *  `extras` is a verbatim dump — the type of `extra_ill_state` is unknown, so
   *  the probe does not guess a getter. `uiMode` is Android's own night flag read
   *  at the same instant, which is what says whether this ROM sets night mode at
   *  all or only signals day/night through its own broadcast. */
  NwdIllState: { action: string; extras: string; uiMode: string };
};

/** The vendor service's own panel-key dispatch table (decompiled from
 *  ArmRadioManager.handlePanelKey). Everything here also fires on the WHEEL. */
export const PANEL_KEY = {
  CHANGE_BAND: 4,
  SEARCH_UP: 5, SEARCH_UP_ALT: 60,
  SEARCH_DOWN: 6, SEARCH_DOWN_ALT: 59,
  SEEK_UP: 16, SEEK_DOWN: 17,
  AMS: 46, INTRO: 61,
  PRESET_NEXT: 62, PRESET_PREV: 63,
  CHANGE_FM_BAND: 72, CHANGE_AM_BAND: 73,
} as const;

/** Human name for a panel key, or null when the MCU sent a code the decompiled
 *  dispatch table has no entry for.
 *
 *  Null is the interesting answer: key 14 arrived eight times in the drive log of
 *  2026-08-03 and is not in the table, so nobody knows what button it is. The
 *  diagnostics overlay highlights exactly the lines this returns null for. */
export function panelKeyName(key: number): string | null {
  const hit = Object.entries(PANEL_KEY).find(([, v]) => v === key);
  return hit ? hit[0].toLowerCase().replace(/_/g, ' ') : null;
}

/** Fire a panel key as if the wheel/panel had been pressed (same unprotected
 *  broadcast the MCU sends) — lets us drive the service's own dispatch table. */
export function nwdSendPanelKey(key: number): void { native?.sendPanelKey?.(key); }

/** Start listening for the head unit's illumination (headlights) broadcast.
 *  Day/night belongs to the vehicle, not to the selected tuner, so this is
 *  deliberately callable without connecting the NWD tuner — an RTL-SDR session
 *  needs it just as much. Idempotent; a no-op off an NWD unit. */
export function nwdStartIlluminationWatch(): void { native?.startIlluminationWatch?.(); }


/**
 * Probe `com.nwd.app.NwdFmManager` — the vendor framework class this unit's
 * radio manager actually reads through (via AWNative), as opposed to the
 * android.os.Hardware JSON channel, which belongs to the Si4792x variant and is
 * absent here. Carries the three things the AIDL cannot: signal strength, raw
 * RDS groups, and a real per-station stereo state. Also reports the two MCU
 * settings that gate RDS. Read-only; changes no tuner state.
 *
 * Takes ~1s — it bursts the RDS read, since a single poll usually returns the
 * all-zero "no data" sentinel and would read like a failure.
 */
export async function nwdProbeFmManager(): Promise<string> {
  try { return (await native?.probeNwdFmManager?.()) ?? 'module unavailable'; }
  catch (e) { return `probe threw: ${String((e as Error)?.message ?? e)}`; }
}


/** Start the periodic level read. Each tick COMMANDS the tuner (see
 *  seekHere in NwdRadioModule), so the native side floors it at 5s and skips
 *  any tick where the MCU says FM is not the current source. Idempotent. */
export function nwdStartLevelWatch(intervalMs: number): void { native?.startLevelWatch?.(intervalMs); }
export function nwdStopLevelWatch(): void { native?.stopLevelWatch?.(); }
/** One reading now, off the bridge thread — call on retune so the meter does not
 *  sit on the previous station's level until the next tick. */
export function nwdReadLevelNow(): void { native?.readLevelNow?.(); }

/** Subscribe to a native NWD event. Returns an unsubscribe fn (no-op if the
 *  module is absent, e.g. on a non-NWD unit or iOS). */
export function onNwd<K extends keyof NwdEvents>(
  event: K,
  handler: (payload: NwdEvents[K]) => void,
): () => void {
  if (!emitter) return () => {};
  const sub = emitter.addListener(event, handler as (p: unknown) => void);
  return () => sub.remove();
}
