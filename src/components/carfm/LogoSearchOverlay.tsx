/**
 * Preset logo-search window (design §6.4 / LogoSearchOverlay.dc.html). A modal
 * card over the radio face, opened by the per-tile logo-search badge in reorder
 * mode — the ONE and only way a station logo is assigned (no auto-fetch).
 *
 * On open it immediately runs the DuckDuckGo search "radio <freq> <lowercase-
 * callsign> logo" (no query field), then walks: loading → results (four
 * candidates, 2×2) → no-results / error (Search again) → saving. Selecting a
 * cell (blue border + fill + check, never red/green) enables Confirm, which
 * saves the pick as this station's sticky manual logo, refreshes the tiles, and
 * closes. Cancel / scrim / ✕ change nothing.
 *
 * Built to match the design references exactly; the candidate cells show the
 * REAL image thumbnails (the design's monograms were placeholders for art).
 */
import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator, Image, Modal, Pressable, ScrollView,
  StyleSheet, Text, useWindowDimensions, View,
} from 'react-native';
import Svg, { Circle, Line, Path, Rect } from 'react-native-svg';

import { ddgStationLogoResults, stationLogoQuery, type DdgImage } from '../../services/logoDuckDuckGo';
import { setStationLogoFromUrl, getStationLogo } from '../../services/stationFinder';
import { getStationPrefs, setStationPrefs } from '../../services/stationDb';
import LogoTile, { invalidateLogoTile, invalidateStationDisplay } from './LogoTile';
import { FONT, FONT_BOLD, type CarFmPalette } from './tokens';

export interface LogoSearchTarget {
  base: string;        // callsign base — the DB key the logo is saved against
  callsign: string;    // callsign (or name) used to build the search query
  freqMhz: number;     // dial frequency — part of the query
  name: string;        // preset display name, for the header
}

type Phase = 'landing' | 'loading' | 'results' | 'empty' | 'error';

export default function LogoSearchOverlay({ visible, pal, target, onClose, onAssigned }: {
  visible: boolean;
  pal: CarFmPalette;
  target: LogoSearchTarget | null;
  onClose: () => void;
  onAssigned?: (base: string) => void;
}) {
  const { width, height } = useWindowDimensions();
  const cardW = Math.min(720, width - 32);
  const cardH = Math.min(560, height - 32);
  const narrow = cardW < 620;

  // Opens on a LANDING view (§6.4), not a search: the current logo (if any) +
  // the per-station Display Call Sign / Frequency toggles. Search runs only when
  // the Search button is pressed.
  const [phase, setPhase] = useState<Phase>('landing');
  const [results, setResults] = useState<DdgImage[]>([]);
  const [sel, setSel] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [currentUri, setCurrentUri] = useState<string | null>(null);
  const [showCall, setShowCall] = useState(true);
  const [showFreq, setShowFreq] = useState(true);

  const query = target ? stationLogoQuery(target.freqMhz, target.callsign) : '';

  const runSearch = useCallback((t: LogoSearchTarget) => {
    setPhase('loading'); setResults([]); setSel(null);
    ddgStationLogoResults(t.freqMhz, t.callsign, 4)
      .then((r) => { setResults(r); setPhase(r.length ? 'results' : 'empty'); })
      .catch(() => setPhase('error'));
  }, []);

  // On open: load the current logo + saved display prefs, land on the landing view.
  useEffect(() => {
    if (!visible || !target) return;
    let cancelled = false;
    setPhase('landing'); setResults([]); setSel(null); setSaving(false);
    getStationLogo(target.base).then((u) => { if (!cancelled) setCurrentUri(u); }).catch(() => {});
    getStationPrefs(target.base).then((p) => {
      if (!cancelled) { setShowCall(p.showCall); setShowFreq(p.showFreq); }
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [visible, target]);

  const confirm = async () => {
    if (!target || saving) return;
    const picking = phase === 'results' && sel != null && !!results[sel];
    if (phase !== 'landing' && !picking) return;
    setSaving(true);
    try {
      if (picking) {
        const ok = await setStationLogoFromUrl(target.base, results[sel!].image);
        if (!ok) { setPhase('error'); setSaving(false); return; }
      }
      // Persist the per-station hero display choices alongside the logo.
      await setStationPrefs(target.base, showCall, showFreq);
      invalidateLogoTile(target.base);
      invalidateStationDisplay();
      onAssigned?.(target.base);
      onClose();
    } catch {
      setPhase('error');
    } finally {
      setSaving(false);
    }
  };

  // Confirm is enabled on the landing view (save the display choices) or once a
  // result cell is picked.
  const canConfirm = !saving && (phase === 'landing' || (phase === 'results' && sel != null));
  const pad = narrow
    ? { hx: 16, hy: 14, qx: 16, qy: 10, bx: 16, fx: 16, fy: 12 }
    : { hx: 22, hy: 16, qx: 22, qy: 12, bx: 22, fx: 22, fy: 14 };

  return (
    <Modal visible={visible && !!target} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.scrim}>
        <View style={[styles.card, { width: cardW, height: cardH, backgroundColor: pal.bg }]}>

          {/* Header: current logo · name · callsign·freq · ✕ */}
          <View style={[styles.header, { paddingHorizontal: pad.hx, paddingVertical: pad.hy, borderBottomColor: pal.border }]}>
            <View style={[styles.headerLeft, { gap: narrow ? 12 : 16 }]}>
              <LogoTile name={target?.name} size={narrow ? 48 : 56} radius={14} />
              <View style={styles.headerText}>
                <Text numberOfLines={1} style={[styles.title, { fontSize: narrow ? 22 : 26, color: pal.text }]}>
                  {target?.name}
                </Text>
                <Text numberOfLines={1} style={[styles.sub, { color: pal.dim }]}>
                  {(target && target.callsign && target.callsign !== target.name ? `${target.callsign}  ·  ` : '')
                    + (target ? `${target.freqMhz.toFixed(1)} MHz` : '')}
                </Text>
              </View>
            </View>
            <Pressable
              onPress={onClose}
              style={({ pressed }) => [styles.close, { borderColor: pal.border }, pressed && { opacity: 0.55 }]}
              accessibilityRole="button" accessibilityLabel="Close"
            >
              <Text style={[styles.closeText, { color: pal.dim }]}>✕</Text>
            </Pressable>
          </View>

          {/* Query chip — shown only during/after a search (not on the landing view) */}
          {phase !== 'landing' ? (
            <View style={[styles.queryRow, { paddingHorizontal: pad.qx, paddingVertical: pad.qy }]}>
              <Svg width={16} height={16} viewBox="0 0 24 24" fill="none">
                <Circle cx="11" cy="11" r="7" stroke={pal.dim} strokeWidth="2.2" />
                <Line x1="20.5" y1="20.5" x2="16.65" y2="16.65" stroke={pal.dim} strokeWidth="2.2" strokeLinecap="round" />
              </Svg>
              <Text style={[styles.queryLabel, { color: pal.dim }]}>SEARCHED</Text>
              <Text numberOfLines={1} style={[styles.queryText, { color: pal.text, backgroundColor: pal.raised, borderColor: pal.border }]}>
                {query}
              </Text>
            </View>
          ) : null}

          {/* Body */}
          <View style={[styles.body, { paddingHorizontal: pad.bx }]}>
            {phase === 'landing' ? (
              <ScrollView contentContainerStyle={styles.landing} showsVerticalScrollIndicator={false}>
                {currentUri ? (
                  <>
                    <View style={styles.landingLogo}>
                      <Image source={{ uri: currentUri }} style={styles.landingLogoImg} resizeMode="contain" />
                    </View>
                    <View style={styles.optList}>
                      {([['Display Call Sign', showCall, () => setShowCall((v) => !v)],
                         ['Display Frequency', showFreq, () => setShowFreq((v) => !v)]] as const).map(([label, on, toggle]) => (
                        <Pressable
                          key={label}
                          onPress={toggle}
                          style={({ pressed }) => [styles.optRow, { backgroundColor: pal.raised, borderColor: pal.border }, pressed && { opacity: 0.7 }]}
                          accessibilityRole="checkbox" accessibilityState={{ checked: on }} accessibilityLabel={label}
                        >
                          <View style={[styles.checkbox, on ? { backgroundColor: pal.blue, borderColor: pal.blue } : { borderColor: pal.border }]}>
                            {on ? (
                              <Svg width={15} height={15} viewBox="0 0 24 24" fill="none">
                                <Path d="M5 12.5 L10 17.5 L19 6.5" stroke="#FFFFFF" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
                              </Svg>
                            ) : null}
                          </View>
                          <Text style={[styles.optLabel, { color: pal.text }]}>{label}</Text>
                        </Pressable>
                      ))}
                    </View>
                    <Pressable
                      onPress={() => target && runSearch(target)}
                      style={({ pressed }) => [styles.searchBtn, { borderColor: pal.blue, backgroundColor: pal.blueFill }, pressed && { opacity: 0.7 }]}
                      accessibilityRole="button" accessibilityLabel="Search for a different logo"
                    >
                      <Text style={[styles.searchBtnText, { color: pal.blue }]}>Search for a different logo</Text>
                    </Pressable>
                  </>
                ) : (
                  <>
                    <Svg width={46} height={46} viewBox="0 0 24 24" fill="none">
                      <Rect x="3" y="4" width="14" height="12" rx="2" stroke={pal.dim} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                      <Circle cx="7.5" cy="8.5" r="1.4" stroke={pal.dim} strokeWidth="1.8" />
                      <Path d="M3.5 14 L8 9.5 L12 13" stroke={pal.dim} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                    </Svg>
                    <Text style={[styles.centerTitle, { color: pal.text }]}>No Logo Installed</Text>
                    <Text style={[styles.centerSub, { color: pal.dim }]}>This station doesn’t have a logo yet.</Text>
                    <Pressable
                      onPress={() => target && runSearch(target)}
                      style={({ pressed }) => [styles.searchBtn, { borderColor: pal.blue, backgroundColor: pal.blueFill }, pressed && { opacity: 0.7 }]}
                      accessibilityRole="button" accessibilityLabel="Search for a logo"
                    >
                      <Text style={[styles.searchBtnText, { color: pal.blue }]}>Search for a logo</Text>
                    </Pressable>
                  </>
                )}
              </ScrollView>
            ) : phase === 'loading' ? (
              <View style={styles.center}>
                <ActivityIndicator size="large" color={pal.blue} />
                <Text style={[styles.centerTitle, { color: pal.text }]}>Searching for logos…</Text>
                <Text style={[styles.centerSub, { color: pal.dim }]}>Looking up brand art for this station.</Text>
              </View>
            ) : phase === 'results' ? (
              <ScrollView contentContainerStyle={styles.grid} showsVerticalScrollIndicator={false}>
                {results.map((r, i) => {
                  const selected = sel === i;
                  return (
                    <Pressable
                      key={`${r.image}-${i}`}
                      onPress={() => setSel(i)}
                      style={[
                        styles.cell,
                        { borderColor: selected ? pal.blue : pal.border, borderWidth: selected ? 2 : 1, backgroundColor: selected ? pal.blueFill : pal.raised },
                      ]}
                      accessibilityRole="button"
                      accessibilityState={{ selected }}
                      accessibilityLabel={`Logo option ${i + 1}${r.source ? ` from ${r.source}` : ''}`}
                    >
                      <View style={styles.imgWrap}>
                        <Image source={{ uri: r.thumbnail }} style={styles.thumb} resizeMode="contain" />
                        {selected ? (
                          <View style={[styles.check, { backgroundColor: pal.blue }]}>
                            <Svg width={17} height={17} viewBox="0 0 24 24" fill="none">
                              <Path d="M5 12.5 L10 17.5 L19 6.5" stroke="#FFFFFF" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
                            </Svg>
                          </View>
                        ) : null}
                      </View>
                      <View style={styles.meta}>
                        <Text numberOfLines={1} style={[styles.domain, { color: pal.dim }]}>{r.source || 'image'}</Text>
                        <Text style={[styles.dims, { color: pal.dim }]}>{r.width && r.height ? `${r.width}×${r.height}` : ''}</Text>
                      </View>
                    </Pressable>
                  );
                })}
              </ScrollView>
            ) : (
              // empty / error share the centered layout
              <View style={styles.center}>
                {phase === 'empty' ? (
                  <Svg width={46} height={46} viewBox="0 0 24 24" fill="none">
                    <Rect x="3" y="4" width="14" height="12" rx="2" stroke={pal.dim} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                    <Circle cx="7.5" cy="8.5" r="1.4" stroke={pal.dim} strokeWidth="1.8" />
                    <Path d="M3.5 14 L8 9.5 L12 13" stroke={pal.dim} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                    <Circle cx="17" cy="17" r="4" stroke={pal.dim} strokeWidth="1.8" />
                    <Line x1="20" y1="20" x2="22.5" y2="22.5" stroke={pal.dim} strokeWidth="1.8" strokeLinecap="round" />
                  </Svg>
                ) : (
                  <Svg width={46} height={46} viewBox="0 0 24 24" fill="none">
                    <Path d="M12 3 L22 20 H2 Z" stroke={pal.amber} strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
                    <Line x1="12" y1="9.5" x2="12" y2="14.5" stroke={pal.amber} strokeWidth="1.9" strokeLinecap="round" />
                    <Circle cx="12" cy="17.4" r="0.6" fill={pal.amber} stroke={pal.amber} />
                  </Svg>
                )}
                <Text style={[styles.centerTitle, { color: pal.text }]}>
                  {phase === 'empty' ? 'No logos found' : 'Search couldn’t finish'}
                </Text>
                <Text style={[styles.centerSub, { color: pal.dim }]}>
                  {phase === 'empty'
                    ? 'The search came back empty. You can try again or keep the current monogram.'
                    : 'Something went wrong reaching the logo search. Check your connection and try again.'}
                </Text>
                <Pressable
                  onPress={() => target && runSearch(target)}
                  style={({ pressed }) => [styles.retry, { borderColor: pal.blue, backgroundColor: pal.blueFill }, pressed && { opacity: 0.7 }]}
                  accessibilityRole="button" accessibilityLabel="Search again"
                >
                  <Text style={[styles.retryText, { color: pal.blue }]}>Search again</Text>
                </Pressable>
              </View>
            )}
          </View>

          {/* Footer: hint · Cancel · Confirm */}
          <View style={[styles.footer, { paddingHorizontal: pad.fx, paddingVertical: pad.fy, borderTopColor: pal.border }]}>
            <Text numberOfLines={1} style={[styles.hint, { color: pal.dim }]}>
              {phase === 'landing'
                ? (currentUri ? 'Choose what shows on the hero' : '')
                : (canConfirm ? 'Saved as this station’s logo' : (phase === 'results' ? 'Pick the correct logo' : ''))}
            </Text>
            <View style={styles.footerBtns}>
              <Pressable
                onPress={onClose}
                style={({ pressed }) => [styles.btn, { minWidth: narrow ? 96 : 120, height: narrow ? 50 : 56, borderColor: pal.border }, pressed && { opacity: 0.6 }]}
                accessibilityRole="button" accessibilityLabel="Cancel"
              >
                <Text style={[styles.btnText, { color: pal.dim }]}>Cancel</Text>
              </Pressable>
              <Pressable
                onPress={confirm}
                disabled={!canConfirm}
                style={[
                  styles.btn, styles.confirm,
                  { minWidth: narrow ? 120 : 148, height: narrow ? 50 : 56 },
                  canConfirm
                    ? { backgroundColor: pal.blue, borderColor: pal.blue }
                    : { backgroundColor: 'transparent', borderColor: pal.border, opacity: saving ? 1 : 0.55 },
                ]}
                accessibilityRole="button" accessibilityLabel="Confirm logo"
              >
                {saving ? <ActivityIndicator color="#FFFFFF" /> : (
                  <Text style={[styles.btnText, { color: canConfirm ? '#FFFFFF' : pal.dim }]}>Confirm</Text>
                )}
              </Pressable>
            </View>
          </View>

        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  scrim: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', alignItems: 'center', justifyContent: 'center' },
  card: {
    borderRadius: 24, overflow: 'hidden',
    shadowColor: '#000', shadowOpacity: 0.35, shadowRadius: 50, shadowOffset: { width: 0, height: 20 }, elevation: 24,
  },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, borderBottomWidth: 1 },
  headerLeft: { flexDirection: 'row', alignItems: 'center', flexShrink: 1 },
  headerText: { flexShrink: 1, gap: 3 },
  title: { fontFamily: FONT_BOLD },
  sub: { fontFamily: FONT, fontSize: 15, letterSpacing: 0.3 },
  close: { width: 52, height: 52, borderRadius: 12, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  closeText: { fontSize: 22, fontWeight: '700' },

  queryRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  queryLabel: { fontFamily: FONT_BOLD, fontSize: 12, letterSpacing: 1.5 },
  queryText: {
    flexShrink: 1, fontFamily: FONT_BOLD, fontSize: 15,
    borderWidth: 1, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 5, fontVariant: ['tabular-nums'],
  },

  body: { flex: 1, paddingTop: 4, paddingBottom: 10 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 14, paddingHorizontal: 40 },

  // Landing view (§6.4): current logo + Display Call Sign / Frequency toggles.
  landing: { flexGrow: 1, alignItems: 'center', justifyContent: 'center', gap: 18, paddingVertical: 12 },
  landingLogo: {
    width: '70%', maxWidth: 320, height: 120, borderRadius: 14, backgroundColor: '#FFFFFF',
    paddingVertical: 8, paddingHorizontal: 14, alignItems: 'center', justifyContent: 'center', overflow: 'hidden',
  },
  landingLogoImg: { width: '100%', height: '100%' },
  optList: { width: '100%', maxWidth: 420, gap: 10 },
  optRow: { flexDirection: 'row', alignItems: 'center', gap: 14, minHeight: 52, paddingHorizontal: 16, borderRadius: 12, borderWidth: 1 },
  checkbox: { width: 26, height: 26, borderRadius: 7, borderWidth: 2, alignItems: 'center', justifyContent: 'center' },
  optLabel: { fontFamily: FONT_BOLD, fontSize: 17 },
  searchBtn: { marginTop: 2, height: 52, paddingHorizontal: 24, borderRadius: 12, borderWidth: 1.5, alignItems: 'center', justifyContent: 'center' },
  searchBtnText: { fontFamily: FONT_BOLD, fontSize: 16, letterSpacing: 0.3 },
  centerTitle: { fontFamily: FONT_BOLD, fontSize: 22, textAlign: 'center' },
  centerSub: { fontFamily: FONT, fontSize: 15, lineHeight: 22, textAlign: 'center', maxWidth: 420 },
  retry: { marginTop: 4, height: 48, paddingHorizontal: 22, borderRadius: 12, borderWidth: 1.5, alignItems: 'center', justifyContent: 'center' },
  retryText: { fontFamily: FONT_BOLD, fontSize: 15 },

  grid: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', rowGap: 14, paddingVertical: 6, paddingHorizontal: 2 },
  cell: { width: '48%', borderRadius: 16, padding: 8, gap: 8 },
  imgWrap: {
    position: 'relative', height: 88, borderRadius: 10, backgroundColor: '#FFFFFF',
    alignItems: 'center', justifyContent: 'center', overflow: 'hidden',
  },
  thumb: { width: '100%', height: '100%' },
  check: { position: 'absolute', top: 8, right: 8, width: 28, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  meta: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8, paddingHorizontal: 4 },
  domain: { flexShrink: 1, fontFamily: FONT_BOLD, fontSize: 13 },
  dims: { fontFamily: FONT, fontSize: 12, fontVariant: ['tabular-nums'] },

  footer: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 16, borderTopWidth: 1 },
  hint: { flexShrink: 1, fontFamily: FONT_BOLD, fontSize: 14 },
  footerBtns: { flexDirection: 'row', gap: 12, flexShrink: 0 },
  btn: { paddingHorizontal: 22, borderRadius: 14, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  btnText: { fontFamily: FONT_BOLD, fontSize: 16, letterSpacing: 0.5 },
  confirm: { borderWidth: 1.5 },
});
