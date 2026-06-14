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

/** A demodulator the backend offers (OWRX reports these; UI gates the picker). */
export interface BackendMode {
  id:    string;            // wire modulation name (usb, wfm, dmr, dab…)
  label: string;            // display name ("Broadcast FM")
  digital?: boolean;        // true for DMR/DStar/DAB/etc. (no SSB sideband concept)
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
  /** Pause-disconnect: close the connection but keep the native audio session
   *  (lock-screen card) intact. OWRX/Kiwi only; UberSDR uses pauseSpectrum. */
  disconnectSocket?(): void;

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

  /** OWRX: the active secondary decoder id (SSTV/Fax/…) running on top of the
   *  analog carrier, or null. Lets the UI highlight the carrier AND the decoder. */
  getSecondaryDecoder?(): string | null;
  /** DAB: switch the audio service (programme) within the tuned ensemble. */
  setAudioServiceId?(id: number): void;
  /** DAB: speed-correction factor for the dablin chipmunk (1 = off). */
  setDabAudioScale?(scale: number): void;
}

/** A DAB programme (audio service) within the tuned ensemble. */
export interface DabProgramme { id: number; name: string; }

/**
 * Live station metadata decoded by the backend — RDS on broadcast FM and the
 * DAB ensemble/programme labels. Normalised so the UI shows ONE station name
 * uniformly, whether it came from RDS, DAB, or a bookmark match.
 */
export interface StationMeta {
  /** WFM RDS programme service (station) name, or the selected DAB programme. */
  stationName?: string;
  /** WFM RDS radiotext (scrolling now-playing/info), if any. */
  text?: string;
  /** DAB ensemble (multiplex) label. */
  ensemble?: string;
  /** DAB programmes in the ensemble — drives the programme picker. */
  programmes?: DabProgramme[];
  /** Short source tag for the UI badge (e.g. 'RDS', 'DMR') — live server data. */
  badge?: string;
}

/** Additive callbacks for v3 backends — UI ignores when absent. */
export interface BackendCallbacks extends SDRCallbacks {
  /** Direct S-meter reading in dBm (Kiwi: every SND header; OWRX: smeter msgs). */
  onSMeter?: (rssiDbm: number) => void;
  /** OWRX: profile list arrived/changed. */
  onProfiles?: (list: ProfileInfo[]) => void;
  /** OWRX: per-SDR usage, keyed by sdrId (the `sdrId|profileId` prefix). name =
   *  the SDR's display name; inUse = an active source (live user or background
   *  task) is on it (from /status.json polling). Lets the profile picker group
   *  by SDR and badge in-use SDRs so a user doesn't disturb another user. */
  onSdrUsage?: (sdrs: Record<string, { name: string; inUse: boolean }>) => void;
  /** OWRX: live user count (the WS `clients` broadcast = real connected users,
   *  NOT background tasks). Pairs with onSdrUsage so the user can tell whether an
   *  in-use SDR has real listeners before switching its profile. */
  onClients?: (count: number) => void;
  /** OWRX: server's available demodulators — gate the mode picker to these. */
  onModes?: (list: BackendMode[]) => void;
  /** OWRX: live RDS (FM) / DAB station metadata. Cleared with empty fields. */
  onMetadata?: (meta: StationMeta) => void;
  /** OWRX: server bookmarks + dial-frequency markers arrive over the WS (no REST
   *  endpoint like UberSDR). Feeds the VTS station readout + the search bar. */
  onBookmarks?: (list: { name: string; frequency: number; mode?: string }[]) => void;
  /** OWRX: server-side secondary-decoder image output (SSTV/Fax). The server
   *  decodes and streams scanlines; the UI just paints them on the decoder
   *  canvas — SSTV pixels are RGB triplets, Fax pixels are greyscale bytes. */
  onDecoderImage?: (ev:
    | { phase: 'start'; kind: 'sstv' | 'fax'; width: number; height: number }
    | { phase: 'line';  kind: 'sstv' | 'fax'; line: number; width: number; pixels: Uint8Array }
    | { phase: 'done';  kind: 'sstv' | 'fax' }) => void;
}

export type { SDRStatus, SDRMode, SDRCallbacks };
