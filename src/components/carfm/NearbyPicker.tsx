/**
 * Nearby stations picker (design §2). Offline-first: renders whatever
 * getNearbyStations() returns from the bundled FCC DB — never blocks on the
 * network (logos fill in on later opens). Tap a row to tune; hold 550ms to
 * save as a preset. Rows come pre-ranked best-signal-first (score order).
 */
import React, { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Modal, Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';

import { getNearbyStations, type NearbyResult } from '../../services/stationFinder';
import type { NearbyStation } from '../../services/stationTypes';
import { BackArrowIcon, SignalWaves, StarIcon } from './icons';
import { FONT, FONT_BOLD, cleanCall, type CarFmPalette } from './tokens';

const HOLD_MS = 550;

// Music vs Talk classification (design NearbyPicker isMusic): a station is Talk
// when its genre reads as spoken-word; anything else (incl. unknown genre) is
// Music. Offline rows have no genre → all Music → the filter bar stays hidden.
const TALK_RE = /(news|talk|sports|public|community|college|student|weather|information|personality|religious talk)/;
function isMusic(s: NearbyStation): boolean {
  const g = (s.genre ?? '').toLowerCase();
  if (!g) return true;
  return !TALK_RE.test(g);
}

/** Filter chip (bucket + genre rows). */
function Chip({ label, active, pal, onPress }: { label: string; active: boolean; pal: CarFmPalette; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.chip,
        active
          ? { borderColor: pal.blue, borderWidth: 1.5, backgroundColor: pal.blueFill }
          : { borderColor: pal.border, borderWidth: 1, backgroundColor: 'transparent' },
        pressed && { opacity: 0.6 },
      ]}
      accessibilityRole="button" accessibilityState={{ selected: active }} accessibilityLabel={`Filter ${label}`}
    >
      <Text style={[styles.chipText, { color: active ? pal.blue : pal.dim }]}>{label}</Text>
    </Pressable>
  );
}

function strengthOf(st: NearbyStation, list: NearbyStation[]): number {
  // score is a relative rank (higher = better); bucket it into 1–4 waves by
  // position within this result set. Never colour alone: count encodes it.
  if (list.length <= 1) return 4;
  const max = list[0].score, min = list[list.length - 1].score;
  const f = (st.score - min) / ((max - min) || 1);
  return 1 + Math.round(f * 3);
}

// Row metrics reflow for a NARROW picker (phone-portrait / ⅓ slice, card clamped
// below ~620dp) so the callsign never wraps and the columns don't cram (§6.2).
interface RowMetrics {
  narrow: boolean; logo: number; logoRadius: number; logoFont: number;
  rowGap: number; rowMinH: number; rowPadH: number; freq: number; call: number; meta: number;
}
function Row({ st, pal, saved, strength, m, onTune, onSave }: {
  st: NearbyStation; pal: CarFmPalette; saved: boolean; strength: number; m: RowMetrics;
  onTune: () => void; onSave: () => void;
}) {
  return (
    <Pressable
      onPress={onTune}
      onLongPress={onSave}
      delayLongPress={HOLD_MS}
      style={({ pressed }) => [
        styles.row,
        { minHeight: m.rowMinH, gap: m.rowGap, paddingHorizontal: m.rowPadH, backgroundColor: pal.raised, borderColor: pal.border },
        pressed && { opacity: 0.6 },
      ]}
      accessibilityRole="button"
      accessibilityLabel={`${st.frequencyMhz.toFixed(1)} megahertz ${st.callsign}. Tap to tune, hold to save preset.`}
    >
      {/* No logo column — Nearby is a text-baseline list (§6.2/§4.5): a small
          square can't render detailed/wide logos legibly, and it's low-traffic. */}
      <View style={[styles.info, m.narrow && { flex: 1 }]}>
        <View style={[styles.line1, m.narrow && { gap: 6 }]}>
          <Text style={[styles.freq, { fontSize: m.freq, color: pal.text }]}>
            {st.frequencyMhz.toFixed(1)}
          </Text>
          <Text numberOfLines={1} style={[styles.call, { fontSize: m.call, marginLeft: m.narrow ? 3 : 6, color: pal.text }]}>{cleanCall(st.callsign)}</Text>
          {st.service !== 'FM' ? (
            <View style={[styles.badge, { borderColor: pal.border }]}>
              <Text style={[styles.badgeText, { color: pal.dim }]}>{st.service}</Text>
            </View>
          ) : null}
        </View>
        <Text style={[styles.meta, { fontSize: m.meta, color: pal.dim }]} numberOfLines={1}>
          {[st.city, st.genre].filter(Boolean).join(' · ') || ' '}
        </Text>
      </View>
      {saved ? <StarIcon size={26} filled color={pal.amber} outline={pal.amber} /> : null}
      <View style={m.narrow ? styles.spacerNarrow : styles.spacer} />
      <View style={styles.trailing}>
        <SignalWaves size={30} strength={strength} on={pal.amber} off={pal.meterEmpty} />
        <Text style={[styles.dist, { color: pal.dim }]}>{Math.round(st.distanceKm)} km</Text>
      </View>
      <Text style={[styles.chevron, { color: pal.dim }]}>›</Text>
    </Pressable>
  );
}

export default function NearbyPicker({ visible, pal, presetMHz, onTune, onSavePreset, onClose }: {
  visible: boolean;
  pal: CarFmPalette;
  presetMHz: Set<number>;                          // saved presets, MHz*10 (int)
  onTune: (st: NearbyStation) => void;
  onSavePreset: (st: NearbyStation) => void;
  onClose: () => void;
}) {
  const [res, setRes] = useState<NearbyResult | null>(null);
  const [loading, setLoading] = useState(false);
  // Two-level filter (design §6.2): All / Music / Talk bucket, then genre.
  const [bucket, setBucket] = useState<'All' | 'Music' | 'Talk'>('All');
  const [genre, setGenre] = useState<string | null>(null);

  // Narrow mode (§6.2): the card is min(900, 94% of the screen); below ~620dp it
  // uses compact row/header metrics so the callsign doesn't wrap on a phone.
  const { width } = useWindowDimensions();
  const narrow = Math.min(900, width * 0.94) < 620;
  const M: RowMetrics = narrow
    ? { narrow: true, logo: 46, logoRadius: 11, logoFont: 18, rowGap: 11, rowMinH: 74, rowPadH: 13, freq: 23, call: 15, meta: 13 }
    : { narrow: false, logo: 60, logoRadius: 14, logoFont: 18, rowGap: 18, rowMinH: 92, rowPadH: 18, freq: 32, call: 20, meta: 15 };
  const sidePad = narrow ? 13 : 22;

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    setLoading(true);
    setBucket('All'); setGenre(null);
    getNearbyStations()
      .then((r) => { if (!cancelled) setRes(r); })
      .catch(() => { if (!cancelled) setRes(null); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [visible]);

  const stations = res?.stations ?? [];
  const noGps = !!res && res.location === null;
  const empty = !!res && res.location !== null && stations.length === 0;

  // Bucket availability + the current bucket's stations / genre list.
  const { hasMusic, hasTalk } = useMemo(() => ({
    hasMusic: stations.some(isMusic),
    hasTalk: stations.some((s) => !isMusic(s)),
  }), [stations]);
  // Bucket row shows ONLY while All is active (§6.2); drilling into Music/Talk
  // hides it entirely and shows the genre row (with its own back-to-All chip).
  const showBucketBar = stations.length > 0 && hasMusic && hasTalk && bucket === 'All';
  const showGenreBar = stations.length > 0 && bucket !== 'All';
  const bucketStations = useMemo(() => (
    bucket === 'All' ? stations : bucket === 'Music' ? stations.filter(isMusic) : stations.filter((s) => !isMusic(s))
  ), [stations, bucket]);
  const genres = useMemo(() => {
    if (bucket === 'All') return [] as string[];
    const seen: string[] = [];
    for (const s of bucketStations) { const g = (s.genre ?? '').trim(); if (g && !seen.includes(g)) seen.push(g); }
    return seen;
  }, [bucket, bucketStations]);
  const activeGenre = genre && genres.includes(genre) ? genre : null;
  const shown = activeGenre ? bucketStations.filter((s) => (s.genre ?? '').trim() === activeGenre) : bucketStations;
  const bucketChips: Array<'All' | 'Music' | 'Talk'> =
    ['All' as const, ...(hasMusic ? ['Music' as const] : []), ...(hasTalk ? ['Talk' as const] : [])];
  const pickBucket = (b: 'All' | 'Music' | 'Talk') => { setBucket(b); setGenre(null); };
  // Genre chips laid out as a 2-row grid that flows column-by-column (design §6.2).
  const genreCols = useMemo(() => {
    const cols: string[][] = [];
    for (let i = 0; i < genres.length; i += 2) cols.push(genres.slice(i, i + 2));
    return cols;
  }, [genres]);

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.scrim}>
        <View style={[styles.card, { backgroundColor: pal.bg }]}>
          {/* header */}
          <View style={[styles.header, { height: narrow ? 62 : 78, paddingHorizontal: narrow ? 18 : 28, borderBottomColor: pal.border }]}>
            <View style={{ flex: 1 }}>
              <Text style={[styles.title, { fontSize: narrow ? 21 : 26, color: pal.text }]}>Nearby stations</Text>
              <Text style={[styles.subtitle, { color: pal.dim }]}>
                Tap to tune · hold to save a preset · best signal first
              </Text>
            </View>
            <Pressable
              onPress={onClose}
              style={({ pressed }) => [styles.close, { borderColor: pal.border, backgroundColor: pal.raised }, pressed && { opacity: 0.55 }]}
              accessibilityRole="button" accessibilityLabel="Close"
            >
              <Text style={[styles.closeText, { color: pal.text }]}>✕</Text>
            </Pressable>
          </View>

          {/* body */}
          {loading && !res ? (
            <View style={styles.stateWrap}><ActivityIndicator color={pal.dim} size="large" /></View>
          ) : noGps ? (
            <View style={styles.stateWrap}>
              <Text style={[styles.stateGlyph, { color: pal.dim }]}>⌖</Text>
              <Text style={[styles.stateTitle, { color: pal.text }]}>Waiting for GPS…</Text>
              <Text style={[styles.stateBody, { color: pal.dim }]}>
                No position fix yet. Waiting for a location fix to list nearby stations.
              </Text>
            </View>
          ) : empty ? (
            <View style={styles.stateWrap}>
              <Text style={[styles.stateGlyph, { color: pal.dim }]}>▤</Text>
              <Text style={[styles.stateTitle, { color: pal.text }]}>
                {res?.snapshotDate ? 'No stations in range' : 'Station database not installed yet'}
              </Text>
              <Text style={[styles.stateBody, { color: pal.dim }]}>
                {res?.snapshotDate
                  ? 'No FM stations within range of this location.'
                  : 'Install the FCC dataset via tools/build_station_db to list nearby stations here.'}
              </Text>
            </View>
          ) : (
            <>
              {/* bucket filter — All / Music / Talk (only while All is active) */}
              {showBucketBar ? (
                <ScrollView
                  horizontal showsHorizontalScrollIndicator={false}
                  style={styles.filterBar} contentContainerStyle={[styles.filterBarContent, { paddingHorizontal: sidePad }]}
                >
                  {bucketChips.map((b) => (
                    <Chip key={b} label={b} active={b === bucket} pal={pal} onPress={() => pickBucket(b)} />
                  ))}
                </ScrollView>
              ) : null}
              {/* genre filter (drilled into Music/Talk): icon-only back-to-All reset
                  chip + divider, then a 2-row genre grid flowing by column (§6.2). */}
              {showGenreBar ? (
                <View style={[styles.genreBar, { paddingHorizontal: sidePad }]}>
                  <Pressable
                    onPress={() => pickBucket('All')}
                    style={({ pressed }) => [styles.allReset, { borderColor: pal.border, backgroundColor: pal.raised }, pressed && { opacity: 0.6 }]}
                    accessibilityRole="button" accessibilityLabel="Back to all stations"
                  >
                    <BackArrowIcon size={22} color={pal.dim} />
                  </Pressable>
                  <View style={[styles.allDivider, { backgroundColor: pal.border }]} />
                  <ScrollView
                    horizontal showsHorizontalScrollIndicator={false}
                    style={{ flex: 1 }} contentContainerStyle={styles.genreGrid}
                  >
                    {genreCols.map((col, ci) => (
                      <View key={ci} style={styles.genreCol}>
                        {col.map((g) => (
                          <Chip key={g} label={g} active={g === activeGenre} pal={pal} onPress={() => setGenre((cur) => (cur === g ? null : g))} />
                        ))}
                      </View>
                    ))}
                  </ScrollView>
                </View>
              ) : null}
              <ScrollView contentContainerStyle={[styles.list, { paddingHorizontal: sidePad, paddingVertical: narrow ? 12 : 16, gap: narrow ? 8 : 10 }]}>
                {shown.map((st) => (
                  <Row
                    key={st.facilityId}
                    st={st}
                    pal={pal}
                    saved={presetMHz.has(Math.round(st.frequencyMhz * 10))}
                    strength={strengthOf(st, shown)}
                    m={M}
                    onTune={() => { onTune(st); onClose(); }}
                    onSave={() => onSavePreset(st)}
                  />
                ))}
              </ScrollView>
            </>
          )}

          {/* footer */}
          <View style={[styles.footer, { borderTopColor: pal.border }]}>
            <Text style={[styles.footerText, { color: pal.dim }]}>
              {res?.snapshotDate ? `FCC data as of ${res.snapshotDate}` : ' '}
            </Text>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  scrim: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', alignItems: 'center', justifyContent: 'center' },
  card: {
    width: 900, maxWidth: '94%', height: '92%', maxHeight: 600, borderRadius: 24, overflow: 'hidden',
    shadowColor: '#000', shadowOpacity: 0.35, shadowRadius: 50, shadowOffset: { width: 0, height: 20 },
    elevation: 24,
  },
  header: {
    height: 78, flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 22, borderBottomWidth: 1, gap: 12,
  },
  title: { fontFamily: FONT_BOLD, fontSize: 26,  },
  subtitle: { fontFamily: FONT, fontSize: 14, marginTop: 1 },
  close: { width: 52, height: 52, borderRadius: 14, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  closeText: { fontSize: 22, fontWeight: '700' },

  // Filter bars (design filterBarStyle / genreBarStyle).
  filterBar: { flexGrow: 0, flexShrink: 0 },
  filterBarContent: { flexDirection: 'row', gap: 10, paddingHorizontal: 22, paddingTop: 14 },
  // Drilled-in genre row: [back-to-All reset chip][divider][2-row genre grid].
  genreBar: { flexShrink: 0, flexDirection: 'row', alignItems: 'stretch', gap: 12, paddingTop: 10, minWidth: 0 },
  allReset: { alignSelf: 'stretch', alignItems: 'center', justifyContent: 'center', paddingHorizontal: 12, borderRadius: 8, borderWidth: 1 },
  allDivider: { alignSelf: 'stretch', width: 1 },
  genreGrid: { flexDirection: 'row', gap: 8, alignItems: 'flex-start' },
  genreCol: { gap: 8 },
  chip: { height: 32, paddingHorizontal: 13, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  chipText: { fontFamily: FONT_BOLD, fontSize: 13, letterSpacing: 0.3 },

  list: { padding: 16, paddingHorizontal: 22, gap: 10 },
  row: {
    borderRadius: 16, borderWidth: 1,
    flexDirection: 'row', alignItems: 'center',
    paddingVertical: 14,
  },
  logo: { width: 60, height: 60, borderRadius: 14 },
  logoText: { color: '#FFF', fontFamily: FONT_BOLD, fontSize: 18 },
  info: { flexShrink: 1, minWidth: 0 },
  line1: { flexDirection: 'row', alignItems: 'baseline', gap: 8, minWidth: 0 },
  freq: { fontFamily: FONT_BOLD, fontSize: 32, fontVariant: ['tabular-nums'], flexShrink: 0 },
  call: { fontFamily: FONT_BOLD, fontSize: 20, flexShrink: 1 },
  badge: { borderWidth: 1, borderRadius: 999, paddingHorizontal: 8, paddingVertical: 1, flexShrink: 0 },
  badgeText: { fontFamily: FONT_BOLD, fontSize: 12,  },
  meta: { fontFamily: FONT, fontSize: 15, marginTop: 2 },
  spacer: { flex: 1 },
  spacerNarrow: { width: 8, flexShrink: 0 },
  trailing: { alignItems: 'center', gap: 2 },
  dist: { fontFamily: FONT_BOLD, fontSize: 15,  },
  chevron: { fontSize: 26, marginLeft: 4 },

  stateWrap: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 14, paddingHorizontal: 80 },
  stateGlyph: { fontSize: 52, lineHeight: 56 },
  stateTitle: { fontFamily: FONT_BOLD, fontSize: 24, textAlign: 'center' },
  stateBody: { fontFamily: FONT, fontSize: 16, textAlign: 'center', lineHeight: 24, maxWidth: 520 },

  footer: { height: 48, justifyContent: 'center', paddingHorizontal: 22, borderTopWidth: 1 },
  footerText: { fontFamily: FONT, fontSize: 14 },
});
