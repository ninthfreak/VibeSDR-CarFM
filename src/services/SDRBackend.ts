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

export type BackendKind = 'ubersdr' | 'kiwi' | 'owrx' | 'fmdx';

/** FM-DX transmitter identification (from the server's maps.fmdx.org lookup).
 *  Distances/azimuths are relative to the SERVER's QTH, not the listener. */
export interface FmdxTxInfo {
  tx?:   string;   // transmitter/station name
  city?: string;
  itu?:  string;   // ITU country prefix
  erp?:  number;   // kW
  pol?:  string;   // polarisation (h/v)
  dist?: number;   // km from server QTH
  azi?:  number;   // degrees from server QTH
}

/** Whole-state snapshot from an FM-DX Webserver `/text` frame, normalised for
 *  the tuner screen. Delivered via BackendCallbacks.onFmdxState. */
export interface FmdxState {
  freqHz:  number;
  sig:     number;    // dBf (TEF scale)
  stereo:  boolean;
  rds:     boolean;
  pi:      string;    // hex PI code ('' when none)
  ps:      string;    // programme service (station) name
  rt:      string;    // current RadioText bank
  pty:     number;    // programme type (European RDS table)
  tp:      boolean;
  ta:      boolean;
  af:      number[];  // alternative frequencies, Hz
  users:   number;
  tx?:     FmdxTxInfo;
  countryIso?: string;  // RDS ECC-derived ISO country (e.g. 'GB') — disambiguates logos
  eq?:     boolean;   // cEQ filter on
  ims?:    boolean;   // iMS filter on
  ant?:    number;    // current antenna index
}

/** One-shot FM-DX server capabilities (from /static_data) — drives the
 *  demodulator options sheet (antenna list, whether IF-bandwidth is switchable). */
export interface FmdxServerInfo {
  antennas: { id: number; name: string }[];
  bwSwitch: boolean;
  /** The RECEIVER's name/location, from /static_data `tunerName`. Needed wherever a
   *  txInfo distance is shown: `dist` is measured from the SERVER's QTH, so "46 km"
   *  is meaningless without saying 46 km from WHERE. */
  tunerName?: string;
}

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

  /** recenter:true forces a one-shot view recentre even when unlocked (discrete
   *  jumps: freq modal, skip, Siri). Omitted/false = respect the follow flag. */
  tune(frequency: number, mode?: SDRMode, opts?: { recenter?: boolean }): void;
  /** Adopt an externally-confirmed tune (native audio WS echo) without re-sending. */
  syncFrequency(frequency: number, mode?: SDRMode): void;

  /** Locked (true) = view follows the VFO (today's behaviour). Unlocked = the
   *  waterfall pans independently and tune() leaves the view where it is. */
  setFollowMode(follow: boolean): void;

  /** Inclusive Hz range the visible window may pan across with no retune /
   *  profile change. movable=false → hard wall (band edge, OWRX profile span,
   *  Kiwi rx range). movable=true → wall can be pushed by retuning (local
   *  RTL-SDR Fs window). */
  panSpan(): { loHz: number; hiHz: number; movable: boolean };
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
  /** OWRX: send a chat message on the main WS (basic text chat, no tune/zoom sync).
   *  name = the user's chosen handle, prefixed to each message server-side. */
  sendChat?(text: string, name: string): void;
  /** OWRX: squelch level in dB (−150 = off/open). */
  setSquelch?(level: number): void;
  /** OWRX: noise reduction — threshold ≤ 0 = off, higher = more NR. */
  setNr?(threshold: number): void;
  /** Kiwi: server-side noise filter / blanker, modelled as DSP descriptors.
   *  setDsp = enable+filter+params; setDspFilter/setDspParams update them. */
  setDsp?(enabled: boolean, filter: string, params: Record<string, string>): void;
  setDspFilter?(filter: string, params: Record<string, string>): void;
  setDspParams?(params: Record<string, string>): void;
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
  /** WFM stereo pilot detected (V4 local hardware) — drives the stereo icon. */
  stereo?: boolean;
  /** RDS PI code (hex, e.g. 'C712') — station identity for logo/country lookup. */
  pi?: string;
  /** ISO country (RDS ECC-derived, or receiver-location fallback) — flag + logo. */
  countryIso?: string;
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
  onSdrUsage?: (sdrs: Record<string, { name: string; inUse: boolean; activeProfileId?: string }>) => void;
  /** OWRX: live user count (the WS `clients` broadcast = real connected users,
   *  NOT background tasks). Pairs with onSdrUsage so the user can tell whether an
   *  in-use SDR has real listeners before switching its profile. */
  onClients?: (count: number) => void;
  /** OWRX: an inbound chat message (server broadcasts incl. our own echo). */
  onChatMessage?: (name: string, text: string, color?: string) => void;
  /** OWRX: whether the server has chat enabled (config `allow_chat`). */
  onChatEnabled?: (enabled: boolean) => void;
  /** OWRX: server software name (OpenWebRX / OpenWebRX+) + version, for the menu. */
  onServerInfo?: (info: { name: string; version: string }) => void;
  /** OWRX: server's available demodulators — gate the mode picker to these. */
  onModes?: (list: BackendMode[]) => void;
  /** OWRX: live RDS (FM) / DAB station metadata. Cleared with empty fields. */
  onMetadata?: (meta: StationMeta) => void;
  /** FM-DX: whole-state telemetry per `/text` frame (freq, sig, RDS, txInfo, AF,
   *  users). Drives the tuner screen; supersedes onMetadata for that backend. */
  onFmdxState?: (state: FmdxState) => void;
  /** FM-DX: one-shot server capabilities (antennas, bw switch) from /static_data. */
  onFmdxInfo?: (info: FmdxServerInfo) => void;
  /** OWRX: the WS closed UNEXPECTEDLY (server crash/restart — common on OWRX),
   *  as opposed to a user pause/navigation. The UI keeps the session alive and
   *  shows a "server stopped responding" prompt instead of silently dropping. */
  onServerLost?: () => void;
  /** Kiwi: the receiver is full (all channels in use) — `MSG too_busy`. Distinct
   *  from onServerLost so the UI can say "server full, try another". */
  onServerBusy?: () => void;
  /** The receiver's own longitude, if the server advertises it (OWRX /status.json
   *  receiver.gps.lon). Drives the ITU region (MW 9/10 kHz) for custom/OWRX hosts
   *  that don't come through the directory with a known longitude. */
  onReceiverLon?: (lon: number) => void;
  /** Full receiver lat/lon (Kiwi `gps=(lat,lon)`) — drives FT8 spot distances and
   *  the on-device-decoder map for Local/Kiwi. */
  onReceiverLoc?: (lat: number, lon: number) => void;
  /** OWRX: server bookmarks + dial-frequency markers arrive over the WS (no REST
   *  endpoint like UberSDR). Feeds the VTS station readout + the search bar. */
  onBookmarks?: (list: { name: string; frequency: number; mode?: string; repeater?: boolean }[]) => void;
  /** OWRX: server-side secondary-decoder image output (SSTV/Fax). The server
   *  decodes and streams scanlines; the UI just paints them on the decoder
   *  canvas — SSTV pixels are RGB triplets, Fax pixels are greyscale bytes. */
  onDecoderImage?: (ev:
    | { phase: 'start'; kind: 'sstv' | 'fax'; width: number; height: number }
    | { phase: 'line';  kind: 'sstv' | 'fax'; line: number; width: number; pixels: Uint8Array }
    | { phase: 'done';  kind: 'sstv' | 'fax' }) => void;
  /** OWRX: server-side TEXT-decoder output (Packet/POCSAG/FLEX/DSC/ISM/HFDL/
   *  ACARS/ADSB/WSJT…), one formatted line per record. `replace` true = a live
   *  snapshot (ADS-B list) that supersedes the previous block rather than appends. */
  onDecoderText?: (line: string, replace?: boolean) => void;
  /** OWRX: the server/profile's own preset DSP defaults (config `initial_squelch_level`
   *  / `initial_nr_level`), pushed on connect and every profile switch. The adapter
   *  has already applied them to the demod; this just lets the UI sliders reflect the
   *  server's preset (e.g. an NFM 2 m profile that ships with a −65 dB squelch). A
   *  field is omitted when the server doesn't preset it. squelchDb −150 = off;
   *  nrThreshold 0 (with nrEnabled false) = NR off. */
  onServerDspDefaults?: (d: { squelchDb?: number; nrEnabled?: boolean; nrThreshold?: number }) => void;
}

export type { SDRStatus, SDRMode, SDRCallbacks };
