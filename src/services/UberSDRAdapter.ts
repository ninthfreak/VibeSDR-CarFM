/**
 * UberSDRAdapter — UberSDRClient behind the SDRBackend contract (v3 brief §8
 * phase 0). Near pass-through by design: the internal model IS UberSDR-shaped,
 * so this wrapper only contributes kind/caps and the delegation plumbing.
 * Zero behaviour change from calling the client directly.
 */

import { UberSDRClient, type SDRMode, type SDRStatus } from './UberSDRClient';
import type { SDRBackend, BackendCallbacks, BackendCapabilities, BackendKind } from './SDRBackend';
import { OwrxAdapter } from './OwrxAdapter';
import { KiwiAdapter } from './KiwiAdapter';

const UBERSDR_CAPS: BackendCapabilities = {
  profiles:       false,
  serverSideZoom: true,
  smeter:         'derived',
  freqRange:      [0, 30_000_000],
  chat:           true,
  serverNR:       true,
  maxBandwidth:   { default: 6000 },
};

export class UberSDRAdapter implements SDRBackend {
  readonly kind: BackendKind = 'ubersdr';
  readonly caps = UBERSDR_CAPS;
  private client: UberSDRClient;

  constructor(baseUrl: string, uuid: string, callbacks: BackendCallbacks, password?: string) {
    // onSMeter/onProfiles unused: S-meter is spectrum-derived, no profiles.
    this.client = new UberSDRClient(baseUrl, uuid, callbacks, password);
  }

  get uuid(): string { return this.client.uuid; }

  connect(frequency?: number, mode?: SDRMode) { return this.client.connect(frequency, mode); }
  destroy()                                   { this.client.destroy(); }

  tune(frequency: number, mode?: SDRMode)          { this.client.tune(frequency, mode); }
  syncFrequency(frequency: number, mode?: SDRMode) { this.client.syncFrequency(frequency, mode); }
  setMode(mode: SDRMode)                           { this.client.setMode(mode); }
  setBandwidth(low: number, high: number)          { this.client.setBandwidth(low, high); }

  zoom(frequency: number, binBandwidth: number) { this.client.zoom(frequency, binBandwidth); }
  pan(frequency: number)                        { this.client.pan(frequency); }
  resetView()                                   { this.client.resetView(); }

  setRate(divisor: number) { this.client.setRate(divisor); }
  pauseSpectrum()          { this.client.pauseSpectrum(); }
  resumeSpectrum()         { this.client.resumeSpectrum(); }

  getStatus(): SDRStatus { return this.client.getStatus(); }
  getView():   SDRStatus { return this.client.getView(); }
}

/** Backend factory — KiwiAdapter / OwrxAdapter register here in later phases. */
export function createBackend(
  kind: BackendKind,
  baseUrl: string,
  uuid: string,
  callbacks: BackendCallbacks,
  password?: string,
): SDRBackend {
  switch (kind) {
    case 'ubersdr': return new UberSDRAdapter(baseUrl, uuid, callbacks, password);
    case 'owrx':    return new OwrxAdapter(baseUrl, uuid, callbacks);
    case 'kiwi':    return new KiwiAdapter(baseUrl, uuid, callbacks, password);
    default: throw new Error(`backend '${kind}' not implemented`);
  }
}
