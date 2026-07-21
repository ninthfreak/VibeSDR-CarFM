// nwdRadio.ts — JS side of the NOWADA (NWD) built-in head-unit FM tuner backend.
//
// Thin typed wrapper over the native `NwdRadio` module (NwdRadioModule.kt), which
// binds the vendor service `com.nwd.radio.service`. The native side is the
// productised form of the validated `spike/nwd-tuner-probe`.
//
// This backend is unlike the SDR adapters: audio is analog + MCU-routed (nothing
// streams to the app), there is no spectrum, and RDS arrives already decoded
// (PS / RadioText / PTY / TA / stereo) via native callback events. So it does NOT
// implement SDRBackend — SDRScreen drives the CarFM face from these events
// directly (see the carFm NWD effect there).

import { NativeEventEmitter, NativeModules, Platform } from 'react-native';

type NwdNative = {
  isAvailable(): Promise<boolean>;
  connect(): Promise<NwdConnectInfo>;
  disconnect(): void;
  tune(mhz: number): Promise<number>;
  seek(up: boolean): void;
  setRdsEnabled(on: boolean): void;
  setAudioEnabled(on: boolean): void;
  addListener(eventName: string): void;
  removeListeners(count: number): void;
};

export type NwdConnectInfo = { band: number; freqMult: number; mhz?: number; ps?: string };

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
export function nwdSetRds(on: boolean): void { native?.setRdsEnabled(on); }
export function nwdSetAudio(on: boolean): void { native?.setAudioEnabled(on); }

// ── Events ───────────────────────────────────────────────────────────────────
export type NwdEvents = {
  NwdRadioFrequency: { band: number; freq: number; mhz: number; ps: string; arg: number };
  NwdRadioRt: { rt: string };
  NwdRadioStereo: { on: boolean };
  NwdRadioPty: { pty: number };
  NwdRadioTa: { ta: boolean };
  NwdRadioScanState: { state: number };
  NwdRadioState: { state: number };
  NwdRadioDisconnected: Record<string, never>;
};

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
