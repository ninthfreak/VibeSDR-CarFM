import { useEffect, useRef } from 'react';
import { NativeModules } from 'react-native';

// VibeSDR V4 — local-hardware audio (Android only).
//
// The on-device local-SDR shim serves demodulated PCM on its /ws/audio endpoint.
// That WS is now consumed NATIVELY by the foreground service (VibeStreamService),
// NOT here in JS — so audio and the media card survive backgrounding (the service
// keeps the in-process shim alive). This component just starts/stops the native
// reader and forwards tune/mode/bandwidth changes over the same WS (the shim's
// control channel). The spectrum WS stays JS-owned and is paused in the
// background to save power.

const Vibe = NativeModules.VibePowerModule as {
  startLocalAudio?: (port: number, initialTune: string) => void;
  sendLocalTune?:   (json: string) => void;
  stopLocalAudio?:  () => void;
  setInstanceName?: (name: string) => void;
} | undefined;

export interface LocalAudioPlayerProps {
  port:          number | null;
  frequency:     number;
  mode:          string;
  bandwidthLow:  number;
  bandwidthHigh: number;
  instanceName?: string;
}

function tuneJson(frequency: number, mode: string, bandwidthLow: number, bandwidthHigh: number) {
  return JSON.stringify({ type: 'tune', frequency, mode, bandwidthLow, bandwidthHigh });
}

export default function LocalAudioPlayer(
  { port, frequency, mode, bandwidthLow, bandwidthHigh, instanceName }: LocalAudioPlayerProps,
) {
  const started = useRef(false);

  // Latest tune, so start can send it immediately without a stale closure.
  const tune = useRef({ frequency, mode, bandwidthLow, bandwidthHigh });
  tune.current = { frequency, mode, bandwidthLow, bandwidthHigh };

  useEffect(() => {
    if (port == null) return;
    const { frequency: f, mode: m, bandwidthLow: bl, bandwidthHigh: bh } = tune.current;
    Vibe?.setInstanceName?.(instanceName ?? 'Local Hardware');
    Vibe?.startLocalAudio?.(port, tuneJson(f, m, bl, bh));
    started.current = true;
    return () => {
      if (started.current) { Vibe?.stopLocalAudio?.(); started.current = false; }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [port]);

  // Forward tune/mode/bandwidth changes to the shim (native sends on the WS).
  useEffect(() => {
    if (!started.current) return;
    Vibe?.sendLocalTune?.(tuneJson(frequency, mode, bandwidthLow, bandwidthHigh));
  }, [frequency, mode, bandwidthLow, bandwidthHigh]);

  useEffect(() => {
    Vibe?.setInstanceName?.(instanceName ?? 'Local Hardware');
  }, [instanceName]);

  return null;
}
