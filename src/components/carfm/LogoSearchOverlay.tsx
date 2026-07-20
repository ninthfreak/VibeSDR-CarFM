/**
 * ⚠️ PLACEHOLDER UI — NOT the final design. ⚠️
 *
 * This is the functional wiring for the preset logo-search window only. Its LOOK
 * is deliberately bare (plain borders, system spacing, no design tokens beyond
 * legibility) so it makes ZERO design decisions — Claude Design owns the visual
 * design of this window. See docs/design/handoff-logo-search.md for the contract
 * this placeholder fulfils; when the visual handoff lands, restyle/rebuild the
 * render output to match it. The LOGIC below (auto-search on open, pick one of
 * four, confirm/cancel, save-as-manual, invalidate the tile) is the contract and
 * should be preserved.
 *
 * Flow: opened from the preset reorder icon → auto-runs the DuckDuckGo query
 * "radio <freq> <lowercase-callsign> logo" → shows the first 4 results → user
 * taps one → Confirm saves it as this station's manual logo (sticky) and
 * refreshes the tiles; Cancel closes without changing anything.
 */
import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator, Image, Modal, Pressable, StyleSheet, Text, View,
} from 'react-native';

import { ddgStationLogoResults, stationLogoQuery, type DdgImage } from '../../services/logoDuckDuckGo';
import { setStationLogoFromUrl } from '../../services/stationFinder';
import { invalidateLogoTile } from './LogoTile';

export interface LogoSearchTarget {
  base: string;        // callsign base — the DB key the logo is saved against
  callsign: string;    // callsign (or name) used to build the search query
  freqMhz: number;     // dial frequency — part of the query
  name: string;        // preset display name, for the header
}

export default function LogoSearchOverlay({ visible, target, onClose, onAssigned }: {
  visible: boolean;
  target: LogoSearchTarget | null;
  onClose: () => void;
  onAssigned?: (base: string) => void;
}) {
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState<DdgImage[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const query = target ? stationLogoQuery(target.freqMhz, target.callsign) : '';

  // Auto-search whenever the window opens for a target.
  useEffect(() => {
    if (!visible || !target) return;
    let cancelled = false;
    setLoading(true); setResults([]); setSelected(null); setError(null);
    ddgStationLogoResults(target.freqMhz, target.callsign, 4)
      .then((r) => { if (!cancelled) { setResults(r); if (r.length === 0) setError('No results'); } })
      .catch(() => { if (!cancelled) setError('Search failed'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [visible, target]);

  const confirm = async () => {
    if (!target || selected == null || !results[selected]) return;
    setSaving(true); setError(null);
    try {
      const ok = await setStationLogoFromUrl(target.base, results[selected].image);
      if (ok) { invalidateLogoTile(target.base); onAssigned?.(target.base); onClose(); }
      else setError('Could not save that image');
    } catch {
      setError('Could not save that image');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal visible={visible && !!target} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.scrim}>
        <View style={styles.card}>
          <Text style={styles.placeholderTag}>PLACEHOLDER — pending Claude Design</Text>
          <Text style={styles.title}>Logo for {target?.name}</Text>
          <Text style={styles.subtitle}>search: {query}</Text>

          <View style={styles.body}>
            {loading ? (
              <ActivityIndicator size="large" />
            ) : results.length === 0 ? (
              <Text style={styles.stateText}>{error ?? 'No logos found.'}</Text>
            ) : (
              <View style={styles.grid}>
                {results.map((r, i) => (
                  <Pressable
                    key={`${r.image}-${i}`}
                    onPress={() => setSelected(i)}
                    style={[styles.cell, selected === i && styles.cellSelected]}
                    accessibilityRole="button"
                    accessibilityState={{ selected: selected === i }}
                    accessibilityLabel={`Logo option ${i + 1}${r.source ? ` from ${r.source}` : ''}`}
                  >
                    <Image source={{ uri: r.thumbnail }} style={styles.thumb} resizeMode="contain" />
                  </Pressable>
                ))}
              </View>
            )}
            {error && results.length > 0 ? <Text style={styles.errText}>{error}</Text> : null}
          </View>

          <View style={styles.footer}>
            <Pressable onPress={onClose} style={styles.btn} accessibilityRole="button" accessibilityLabel="Cancel">
              <Text style={styles.btnText}>Cancel</Text>
            </Pressable>
            <Pressable
              onPress={confirm}
              disabled={selected == null || saving}
              style={[styles.btn, styles.btnPrimary, (selected == null || saving) && styles.btnDisabled]}
              accessibilityRole="button" accessibilityLabel="Confirm logo"
            >
              {saving ? <ActivityIndicator color="#FFFFFF" /> : <Text style={[styles.btnText, styles.btnPrimaryText]}>Confirm</Text>}
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

// Bare, neutral styling ONLY — do not treat these values as design. Claude Design
// replaces this render output. Kept just legible/tappable for testing the flow.
const styles = StyleSheet.create({
  scrim: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', alignItems: 'center', justifyContent: 'center', padding: 24 },
  card: { width: '100%', maxWidth: 460, backgroundColor: '#1b1f24', borderRadius: 10, borderWidth: 1, borderColor: '#444', padding: 18, gap: 10 },
  placeholderTag: { color: '#e0a000', fontSize: 11, letterSpacing: 1, textAlign: 'center' },
  title: { color: '#fff', fontSize: 18, fontWeight: '700' },
  subtitle: { color: '#9aa4b0', fontSize: 12 },
  body: { minHeight: 200, alignItems: 'center', justifyContent: 'center', gap: 10 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, justifyContent: 'center' },
  cell: { width: 120, height: 120, borderRadius: 8, borderWidth: 2, borderColor: '#444', backgroundColor: '#fff', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  cellSelected: { borderColor: '#4A9EFF' },
  thumb: { width: '100%', height: '100%' },
  stateText: { color: '#9aa4b0', fontSize: 14 },
  errText: { color: '#e07070', fontSize: 12 },
  footer: { flexDirection: 'row', justifyContent: 'flex-end', gap: 10, marginTop: 4 },
  btn: { minWidth: 96, height: 44, paddingHorizontal: 16, borderRadius: 8, borderWidth: 1, borderColor: '#555', alignItems: 'center', justifyContent: 'center' },
  btnText: { color: '#e9eef4', fontSize: 15 },
  btnPrimary: { backgroundColor: '#2E86FF', borderColor: '#2E86FF' },
  btnPrimaryText: { color: '#fff', fontWeight: '700' },
  btnDisabled: { opacity: 0.4 },
});
