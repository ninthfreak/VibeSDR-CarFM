import { useEffect, useRef } from 'react';
import { NativeModules } from 'react-native';

// VibeSDR V4 — local-hardware audio (Android only).
//
// Mirrors AudioPlayer, but the audio comes from the on-device local-SDR shim's
// /ws/audio endpoint as raw int16 PCM (mono, or stereo for WFM) and is played
// through the SAME external-PCM engine OWRX/Kiwi use (startExternalAudio /
// pushExternalPcm). Tune/mode/bandwidth are sent back to the shim as JSON.

const Vibe = NativeModules.VibePowerModule as {
  startExternalAudio?: (rate: number) => void;
  pushExternalPcm?: (b64: string, rate: number, channels: number) => void;
  stopExternalAudio?: () => void;
  setInstanceName?: (name: string) => void;
  setExternalLocalMode?: (on: boolean) => void;
} | undefined;

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
function bytesToBase64(b: Uint8Array): string {
  let out = '';
  for (let i = 0; i < b.length; i += 3) {
    const n = (b[i] << 16) | ((i + 1 < b.length ? b[i + 1] : 0) << 8) | (i + 2 < b.length ? b[i + 2] : 0);
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] +
           (i + 1 < b.length ? B64[(n >> 6) & 63] : '=') +
           (i + 2 < b.length ? B64[n & 63] : '=');
  }
  return out;
}

export interface LocalAudioPlayerProps {
  port:          number | null;
  frequency:     number;
  mode:          string;
  bandwidthLow:  number;
  bandwidthHigh: number;
  instanceName?: string;
}

export default function LocalAudioPlayer(
  { port, frequency, mode, bandwidthLow, bandwidthHigh, instanceName }: LocalAudioPlayerProps,
) {
  const ws        = useRef<WebSocket | null>(null);
  const started   = useRef(false);
  const lastRate  = useRef(0);

  // Latest tune, so onopen can assert it immediately.
  const tune = useRef({ frequency, mode, bandwidthLow, bandwidthHigh });
  tune.current = { frequency, mode, bandwidthLow, bandwidthHigh };

  useEffect(() => {
    if (port == null) return;
    let closed = false;

    // Tell the native engine this external audio is LOCAL hardware, so a media
    // pause mutes/resumes instead of the OWRX/Kiwi full-stop.
    Vibe?.setExternalLocalMode?.(true);

    const sock = new WebSocket(`ws://127.0.0.1:${port}/ws/audio`);
    sock.binaryType = 'arraybuffer';
    ws.current = sock;

    sock.onopen = () => {
      if (closed) { sock.close(); return; }
      Vibe?.setInstanceName?.(instanceName ?? 'Local Hardware');
      sock.send(JSON.stringify({ type: 'tune', ...tune.current }));
    };

    sock.onmessage = (e) => {
      if (closed || !(e.data instanceof ArrayBuffer)) return;
      const buf = e.data as ArrayBuffer;
      if (buf.byteLength <= 6) return;
      const dv = new DataView(buf);
      const channels = dv.getUint8(0);
      const rate     = dv.getUint32(2, true);
      const pcm      = new Uint8Array(buf, 6);
      if (!started.current || rate !== lastRate.current) {
        if (!started.current) {
          Vibe?.startExternalAudio?.(rate);
          started.current = true;
          // Mark LOCAL mode AFTER the service exists (startExternalAudio creates
          // it) — the on-mount call no-ops because the service isn't up yet, and
          // without the flag pause hit the OWRX/Kiwi full-teardown path.
          Vibe?.setExternalLocalMode?.(true);
        }
        lastRate.current = rate;
      }
      Vibe?.pushExternalPcm?.(bytesToBase64(pcm), rate, channels === 2 ? 2 : 1);
    };

    sock.onerror = () => {};
    sock.onclose = () => {};

    return () => {
      closed = true;
      try { sock.close(); } catch {}
      ws.current = null;
      Vibe?.setExternalLocalMode?.(false);
      if (started.current) { Vibe?.stopExternalAudio?.(); started.current = false; }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [port]);

  // Forward tune/mode/bandwidth changes to the shim.
  useEffect(() => {
    const sock = ws.current;
    if (!sock || sock.readyState !== WebSocket.OPEN) return;
    sock.send(JSON.stringify({ type: 'tune', frequency, mode, bandwidthLow, bandwidthHigh }));
  }, [frequency, mode, bandwidthLow, bandwidthHigh]);

  useEffect(() => {
    Vibe?.setInstanceName?.(instanceName ?? 'Local Hardware');
  }, [instanceName]);

  return null;
}
