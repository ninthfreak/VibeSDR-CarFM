/**
 * SDRBackend — the adapter contract for multi-backend support (v3 brief §2).
 *
 * The internal model stays UberSDR-shaped: SDRStatus/SDRCallbacks/SDRMode are
 * the lingua franca, and foreign protocols (KiwiSDR, OpenWebRX) translate INTO
 * them. The method surface below mirrors what the UI actually calls on
 * UberSDRClient today — including the view-prediction pair zoom()/pan()
 * rather than the brief's setView(centerHz,bwHz), which is expressible
 * through them (Kiwi quantises inside its adapter; OWRX slices locally).
 *
 * UI gating rule: capability-driven, same pattern as the skin's extension
 * probing — profile UI only when caps.profiles, chat only when caps.chat, etc.
 */

import type { SDRStatus, SDRMode, SDRCallbacks } from './UberSDRClient';

export type BackendKind = 'ubersdr' | 'kiwi' | 'owrx';

export interface ProfileInfo {
  id:        string;
  name:      string;
  centerHz?: number;  // learned lazily on OWRX (config follows selection)
  bwHz?:     number;
}

export interface BackendCapabilities {
  /** OWRX: true (profile pill). UberSDR/Kiwi: false. */
  profiles: boolean;
  /** UberSDR/Kiwi: true. OWRX: false — client slices the full-profile row. */
  serverSideZoom: boolean;
  /** Where the S-meter comes from: Kiwi SND header | OWRX JSON | spectrum-derived. */
  smeter: 'header' | 'message' | 'derived';
  /** Absolute tunable range in Hz (per active profile on OWRX). */
  freqRange: [number, number];
  /** Kiwi: 15 quantised zoom levels (0–14). Undefined elsewhere. */
  zoomSteps?: number;
  /** UberSDR only. */
  chat: boolean;
  /** UberSDR only. */
  serverNR: boolean;
  /**
   * Per-edge passband half-width cap in Hz, keyed by mode, with a `default`
   * fallback. Drives the bandwidth sliders' range — never hardcode it, since
   * it varies by demodulator and server (e.g. OWRX broadcast FM wants ±96 kHz
   * = 192 kHz wide, while UberSDR narrow modes cap at 6 kHz).
   */
  maxBandwidth: { default: number } & Partial<Record<SDRMode, number>>;
}

/** Per-edge passband half-width cap (Hz) for the active mode. */
export function filterEdgeMax(caps: BackendCapabilities, mode: SDRMode): number {
  return caps.maxBandwidth[mode] ?? caps.maxBandwidth.default;
}

export interface SDRBackend {
  readonly kind: BackendKind;
  readonly caps: BackendCapabilities;
  /** Session id shared with the native audio engine. */
  readonly uuid: string;

  connect(frequency?: number, mode?: SDRMode): Promise<void>;
  destroy(): void;

  tune(frequency: number, mode?: SDRMode): void;
  /** Adopt an externally-confirmed tune (native audio WS echo) without re-sending. */
  syncFrequency(frequency: number, mode?: SDRMode): void;
  setMode(mode: SDRMode): void;
  setBandwidth(low: number, high: number): void;

  zoom(frequency: number, binBandwidth: number): void;
  pan(frequency: number): void;
  resetView(): void;

  setRate(divisor: number): void;
  pauseSpectrum(): void;
  resumeSpectrum(): void;

  getStatus(): SDRStatus;
  getView(): SDRStatus;

  // Profiles — present only when caps.profiles (OWRX)
  getProfiles?(): ProfileInfo[];
  selectProfile?(id: string): void;
}

/** Additive callbacks for v3 backends — UI ignores when absent. */
export interface BackendCallbacks extends SDRCallbacks {
  /** Direct S-meter reading in dBm (Kiwi: every SND header; OWRX: smeter msgs). */
  onSMeter?: (rssiDbm: number) => void;
  /** OWRX: profile list arrived/changed. */
  onProfiles?: (list: ProfileInfo[]) => void;
}

export type { SDRStatus, SDRMode, SDRCallbacks };
