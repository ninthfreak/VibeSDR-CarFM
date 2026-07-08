import React, { useState, useMemo } from 'react';
import { View, Text, Pressable, StyleSheet, type LayoutChangeEvent } from 'react-native';
import type { ThemeTokens } from '../contexts/ThemeContext';

// Vintage analogue tuning dial for the FM-DX tuner (v7, plan §2c). A horizontal
// FM-band scale with a moving needle at the current frequency and station-name
// labels at the frequencies where we've decoded RDS (client-learned map) or hold
// a bookmark. Tap anywhere on the dial to tune there. No plugin required — this
// is the universal fallback when a server has no Spectrum Graph plugin.

export interface DialStation {
  freqHz: number;
  name:   string;
}

// Match the VFO drum's LED palette: green digits (hue 120), warm red needle
// (hue 4), on a near-black face.
const GREEN      = 'hsl(120,100%,45%)';
const GREEN_DIM  = 'hsla(120,100%,45%,0.28)';
const GREEN_SOFT = 'hsla(120,100%,55%,0.92)';
const RED        = 'hsl(4,95%,52%)';
const FACE       = '#070806';

interface Props {
  freqHz:  number;
  loHz:    number;
  hiHz:    number;
  stations: DialStation[];
  onTune:  (hz: number) => void;
  theme:   ThemeTokens;
  height?: number;
}

export default function FmdxDial({ freqHz, loHz, hiHz, stations, onTune, theme, height = 118 }: Props) {
  const [w, setW] = useState(0);
  const onLayout = (e: LayoutChangeEvent) => setW(e.nativeEvent.layout.width);
  const span = Math.max(1, hiHz - loHz);
  const x = (hz: number) => ((hz - loHz) / span) * w;
  const t = theme;

  // Major ticks every 1 MHz; labels every 2 MHz.
  const ticks = useMemo(() => {
    const out: { mhz: number; major: boolean }[] = [];
    const startM = Math.ceil(loHz / 1e6);
    const endM = Math.floor(hiHz / 1e6);
    for (let m = startM; m <= endM; m++) out.push({ mhz: m, major: m % 2 === 0 });
    return out;
  }, [loHz, hiHz]);

  // Every in-range station gets a tick (proof it was saved). NAME labels use
  // collision avoidance (two rows, min gap) so dense city bands stay readable —
  // the current station always wins a label; others fill remaining space.
  const { ticks: staTicks, labels } = useMemo(() => {
    const empty = { ticks: [] as { key: string; px: number }[], labels: [] as { key: string; px: number; name: string; row: 0 | 1 }[] };
    if (!w) return empty;
    const MIN_GAP = 50;
    const inRange = [...stations].filter(s => s.freqHz >= loHz && s.freqHz <= hiHz && s.name)
      .sort((a, b) => a.freqHz - b.freqHz);
    const ticks = inRange.map(s => ({ key: `${s.freqHz}`, px: x(s.freqHz) }));
    // Place the current station's label first so it's never dropped.
    const ordered = [...inRange].sort((a, b) =>
      Math.abs(a.freqHz - freqHz) - Math.abs(b.freqHz - freqHz));
    const rows: number[][] = [[], []];
    const labels: { key: string; px: number; name: string; row: 0 | 1 }[] = [];
    for (const s of ordered) {
      const px = x(s.freqHz);
      const row = (rows[0].every(p => Math.abs(p - px) >= MIN_GAP)) ? 0
                : (rows[1].every(p => Math.abs(p - px) >= MIN_GAP)) ? 1 : -1;
      if (row < 0) continue;
      rows[row].push(px);
      labels.push({ key: `${s.freqHz}`, px, name: s.name, row: row as 0 | 1 });
    }
    return { ticks, labels };
  }, [stations, w, loHz, hiHz, freqHz]);

  const needleX = w ? x(freqHz) : 0;
  const midY = height / 2;

  return (
    <Pressable
      onLayout={onLayout}
      onPress={(e) => {
        if (!w) return;
        const px = Math.max(0, Math.min(w, e.nativeEvent.locationX));
        onTune(loHz + (px / w) * span);
      }}
      style={[styles.wrap, { height, backgroundColor: FACE, borderColor: t.barBorder }]}
    >
      {/* Baseline */}
      <View style={[styles.baseline, { top: midY, backgroundColor: GREEN_DIM }]} />

      {/* Ticks + MHz labels */}
      {w > 0 && ticks.map(({ mhz, major }) => {
        const px = x(mhz * 1e6);
        return (
          <React.Fragment key={mhz}>
            <View style={{ position: 'absolute', left: px, top: midY - (major ? 8 : 4), width: 1, height: major ? 16 : 8, backgroundColor: GREEN_DIM }} />
            {major && (
              <Text style={[styles.tickLbl, { left: px - 10, top: midY + 10, color: GREEN, fontFamily: t.font }]}>{mhz}</Text>
            )}
          </React.Fragment>
        );
      })}

      {/* A tick for every saved station */}
      {staTicks.map(({ key, px }) => (
        <View key={`t${key}`} style={{ position: 'absolute', left: px, top: midY - 7, width: 1, height: 14, backgroundColor: GREEN_SOFT }} />
      ))}

      {/* Station name labels (collision-avoided; current station always shown) */}
      {labels.map(({ key, px, name, row }) => (
        <Text
          key={`l${key}`}
          numberOfLines={1}
          style={[styles.staLbl, {
            left: px - 30, width: 60, color: GREEN_SOFT, fontFamily: t.font,
            top: row === 0 ? 4 : height - 16,
            textAlign: 'center',
          }]}
        >{name}</Text>
      ))}

      {/* Current-frequency needle (warm red, matches the drum) */}
      {w > 0 && (
        <>
          <View style={{ position: 'absolute', left: needleX, top: 2, width: 2, height: height - 4, backgroundColor: RED }} />
          <View style={{ position: 'absolute', left: needleX - 5, top: 0, width: 0, height: 0, borderLeftWidth: 5, borderRightWidth: 5, borderTopWidth: 7, borderLeftColor: 'transparent', borderRightColor: 'transparent', borderTopColor: RED }} />
        </>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  wrap: { borderRadius: 14, borderWidth: 1, overflow: 'hidden' },
  baseline: { position: 'absolute', left: 0, right: 0, height: 1 },
  tickLbl: { position: 'absolute', width: 20, textAlign: 'center', fontSize: 10, fontWeight: 'bold' },
  staLbl: { position: 'absolute', fontSize: 9 },
});
