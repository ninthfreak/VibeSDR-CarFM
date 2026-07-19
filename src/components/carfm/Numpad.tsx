/**
 * Direct-entry TUNE card (design v2): amber display row, a ‹‹SEEK / SEEK››
 * row (seek moved here from the face's side columns), 3×4 keypad (1-9, ".",
 * 0, ⌫), CANCEL / TUNE. Max 4 digits, one decimal; TUNE validates 87.5–108.0
 * and rounds to 0.1. A seek sweep runs with the card open — the display
 * follows the sweep and settles on the found station.
 */
import React, { useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';

import { BackspaceIcon } from './icons';
import { FONT, FONT_BOLD, FM_MAX_MHZ, FM_MIN_MHZ, type CarFmPalette } from './tokens';

const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '.', '0', '⌫'] as const;

export default function Numpad({ visible, pal, currentMHz, scanning, onSeek, onTune, onClose, compact = false, maxHeight }: {
  visible: boolean;
  pal: CarFmPalette;
  currentMHz: string;              // live (or sweeping) frequency, shown until typing starts
  scanning: boolean;
  onSeek: (dir: 1 | -1) => void;
  onTune: (mhz: number) => void;
  onClose: () => void;
  /** Short screens (design npCompact, height < 560): shrink keys/display/gaps
   *  and drop the title so the whole card fits without clipping. */
  compact?: boolean;
  maxHeight?: number;
}) {
  const [buf, setBuf] = useState('');
  const [error, setError] = useState(false);
  // Per-size metrics (design npCompact branch).
  const gap = compact ? 9 : 12;
  const S = {
    cardPadV: compact ? 16 : 20, cardPadH: compact ? 18 : 20, cardRadius: compact ? 20 : 24,
    dispH: compact ? 60 : 78, dispRadius: compact ? 12 : 14, value: compact ? 38 : 46,
    seekH: compact ? 46 : 56, keyH: compact ? 46 : 64, keyRadius: compact ? 12 : 14, keyFont: compact ? 22 : 26,
    actionH: compact ? 52 : 60, actionRadius: compact ? 12 : 14,
  };

  const reset = () => { setBuf(''); setError(false); };
  const close = () => { reset(); onClose(); };
  const seek = (dir: 1 | -1) => { reset(); onSeek(dir); };

  const press = (k: string) => {
    setError(false);
    if (k === '⌫') { setBuf((b) => b.slice(0, -1)); return; }
    setBuf((b) => {
      if (k === '.') return b.includes('.') || b.length === 0 ? b : b + '.';
      const digits = b.replace('.', '').length;
      if (digits >= 4) return b;
      return b + k;
    });
  };

  const commit = () => {
    const f = Math.round(parseFloat(buf) * 10) / 10;
    if (!isFinite(f) || f < FM_MIN_MHZ || f > FM_MAX_MHZ) { setError(true); return; }
    reset();
    onTune(f);
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={close}>
      <Pressable style={styles.scrim} onPress={close}>
        <Pressable style={[styles.card, { backgroundColor: pal.panel, paddingVertical: S.cardPadV, paddingHorizontal: S.cardPadH, borderRadius: S.cardRadius }, maxHeight ? { maxHeight } : null]} onPress={() => {}}>
          {compact ? null : <Text style={[styles.title, { color: pal.dim }]}>TUNE</Text>}
          <View style={[styles.display, { height: S.dispH, borderRadius: S.dispRadius, backgroundColor: pal.raised, borderColor: error ? pal.amber : pal.border }]}>
            <Text style={[styles.value, { fontSize: S.value, color: pal.amber, opacity: buf || scanning ? 1 : 0.45 }]}>
              {buf || currentMHz}
            </Text>
            <Text style={[styles.unit, { color: pal.dim }]}>MHz</Text>
          </View>
          <View style={[styles.seekRow, { gap, marginTop: gap }]}>
            <Pressable
              onPress={() => seek(-1)}
              style={({ pressed }) => [styles.seekBtn, { height: S.seekH, backgroundColor: pal.raised, borderColor: pal.border }, pressed && { opacity: 0.55 }]}
              accessibilityRole="button" accessibilityLabel="Seek down to previous station"
            >
              <Text style={[styles.seekIcon, { color: pal.text }]}>‹‹</Text>
              <Text style={[styles.seekText, { color: pal.dim }]}>SEEK</Text>
            </Pressable>
            <Pressable
              onPress={() => seek(1)}
              style={({ pressed }) => [styles.seekBtn, { height: S.seekH, backgroundColor: pal.raised, borderColor: pal.border }, pressed && { opacity: 0.55 }]}
              accessibilityRole="button" accessibilityLabel="Seek up to next station"
            >
              <Text style={[styles.seekText, { color: pal.dim }]}>SEEK</Text>
              <Text style={[styles.seekIcon, { color: pal.text }]}>››</Text>
            </Pressable>
          </View>
          {error ? (
            <Text style={[styles.err, { color: pal.amber }]}>
              ⚠ Outside {FM_MIN_MHZ.toFixed(1)}–{FM_MAX_MHZ.toFixed(1)} MHz band
            </Text>
          ) : null}
          <View style={[styles.grid, { gap, marginTop: gap + 4 }]}>
            {KEYS.map((k) => (
              <Pressable
                key={k}
                onPress={() => press(k)}
                style={({ pressed }) => [
                  styles.key,
                  { height: S.keyH, borderRadius: S.keyRadius, backgroundColor: pal.raised, borderColor: pal.border },
                  pressed && { opacity: 0.55 },
                ]}
                accessibilityRole="button"
                accessibilityLabel={k === '⌫' ? 'Delete' : k}
              >
                {k === '⌫'
                  ? <BackspaceIcon size={30} color={pal.text} />
                  : <Text style={[styles.keyText, { fontSize: S.keyFont, color: pal.text }]}>{k}</Text>}
              </Pressable>
            ))}
          </View>
          <View style={[styles.actions, { gap, marginTop: gap + 4 }]}>
            <Pressable
              onPress={close}
              style={({ pressed }) => [styles.action, { height: S.actionH, borderRadius: S.actionRadius, borderColor: pal.border }, pressed && { opacity: 0.55 }]}
              accessibilityRole="button" accessibilityLabel="Cancel"
            >
              <Text style={[styles.actionText, { color: pal.dim }]}>CANCEL</Text>
            </Pressable>
            <Pressable
              onPress={commit}
              disabled={!buf}
              style={({ pressed }) => [
                styles.action,
                { height: S.actionH, borderRadius: S.actionRadius, borderColor: pal.blue, backgroundColor: pal.blueFill, opacity: buf ? 1 : 0.4 },
                pressed && { opacity: 0.55 },
              ]}
              accessibilityRole="button" accessibilityLabel="Tune"
            >
              <Text style={[styles.actionText, { color: pal.blue }]}>TUNE</Text>
            </Pressable>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  scrim: {
    flex: 1, backgroundColor: 'rgba(0,0,0,0.45)',
    alignItems: 'center', justifyContent: 'center',
  },
  card: {
    width: 440, maxWidth: '92%', borderRadius: 24, padding: 20,
    shadowColor: '#000', shadowOpacity: 0.35, shadowRadius: 50, shadowOffset: { width: 0, height: 20 },
    elevation: 24,
  },
  title: { fontFamily: FONT_BOLD, fontSize: 14, letterSpacing: 3, textAlign: 'center', marginBottom: 12 },
  display: {
    height: 78, borderRadius: 14, borderWidth: 1,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
  },
  value: { fontFamily: FONT_BOLD, fontSize: 46, fontVariant: ['tabular-nums'] },
  unit: { fontFamily: FONT_BOLD, fontSize: 18, marginTop: 14 },
  seekRow: { flexDirection: 'row', gap: 12, marginTop: 12 },
  seekBtn: {
    flex: 1, height: 56, borderRadius: 14, borderWidth: 1,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10,
  },
  seekIcon: { fontFamily: FONT_BOLD, fontSize: 24, lineHeight: 26 },
  seekText: { fontFamily: FONT_BOLD, fontSize: 14, letterSpacing: 2 },
  err: { fontFamily: FONT_BOLD, fontSize: 13, textAlign: 'center', marginTop: 6 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 12, marginTop: 16 },
  key: {
    width: '30.5%', flexGrow: 1, height: 64, borderRadius: 14, borderWidth: 1,
    alignItems: 'center', justifyContent: 'center',
  },
  keyText: { fontFamily: FONT_BOLD, fontSize: 26,  },
  actions: { flexDirection: 'row', gap: 12, marginTop: 16 },
  action: {
    flex: 1, height: 58, borderRadius: 14, borderWidth: 1,
    alignItems: 'center', justifyContent: 'center',
  },
  actionText: { fontFamily: FONT_BOLD, fontSize: 17, letterSpacing: 2 },
});
