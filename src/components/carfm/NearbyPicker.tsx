/**
 * Nearby stations picker (design §2). Offline-first: renders whatever
 * getNearbyStations() returns from the bundled FCC DB — never blocks on the
 * network (logos fill in on later opens). Tap a row to tune; hold 550ms to
 * save as a preset. Rows come pre-ranked best-signal-first (score order).
 */
import React, { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Image, Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { getNearbyStations, type NearbyResult } from '../../services/stationFinder';
import type { NearbyStation } from '../../services/stationTypes';
import { SignalWaves, StarIcon } from './icons';
import { FONT, FONT_BOLD, brandColor, monogram, type CarFmPalette } from './tokens';

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

function Row({ st, pal, saved, strength, onTune, onSave }: {
  st: NearbyStation; pal: CarFmPalette; saved: boolean; strength: number;
  onTune: () => void; onSave: () => void;
}) {
  return (
    <Pressable
      onPress={onTune}
      onLongPress={onSave}
      delayLongPress={HOLD_MS}
      style={({ pressed }) => [
        styles.row,
        { backgroundColor: pal.raised, borderColor: pal.border },
        pressed && { opacity: 0.6 },
      ]}
      accessibilityRole="button"
      accessibilityLabel={`${st.frequencyMhz.toFixed(1)} megahertz ${st.callsign}. Tap to tune, hold to save preset.`}
    >
      {st.logoUri ? (
        <Image source={{ uri: st.logoUri }} style={styles.logo} resizeMode="cover" />
      ) : (
        <View style={[styles.logo, { backgroundColor: brandColor(st.callsignBase), alignItems: 'center', justifyContent: 'center' }]}>
          <Text allowFontScaling={false} style={styles.logoText}>{monogram(st.callsign)}</Text>
        </View>
      )}
      <View style={styles.info}>
        <View style={styles.line1}>
          <Text style={[styles.freq, { color: pal.text }]}>
            {st.frequencyMhz.toFixed(1)}
          </Text>
          <Text style={[styles.mhz, { color: pal.dim }]}>MHz</Text>
          <Text style={[styles.call, { color: pal.text }]}>{st.callsign}</Text>
          {st.service !== 'FM' ? (
            <View style={[styles.badge, { borderColor: pal.border }]}>
              <Text style={[styles.badgeText, { color: pal.dim }]}>{st.service}</Text>
            </View>
          ) : null}
        </View>
        <Text style={[styles.meta, { color: pal.dim }]} numberOfLines={1}>
          {[st.city, st.genre].filter(Boolean).join(' · ') || ' '}
        </Text>
      </View>
      {saved ? <StarIcon size={26} filled color={pal.amber} outline={pal.amber} /> : null}
      <View style={styles.spacer} />
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
  const showBuckets = stations.length > 0 && hasMusic && hasTalk;
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
  // While a bucket other than All is active, the bucket row collapses to just
  // "All" (tapping it clears the filter); All shows all three (design §6.2).
  const bucketChips: Array<'All' | 'Music' | 'Talk'> = bucket === 'All'
    ? ['All' as const, ...(hasMusic ? ['Music' as const] : []), ...(hasTalk ? ['Talk' as const] : [])]
    : ['All'];
  const pickBucket = (b: 'All' | 'Music' | 'Talk') => { setBucket(b); setGenre(null); };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.scrim}>
        <View style={[styles.card, { backgroundColor: pal.bg }]}>
          {/* header */}
          <View style={[styles.header, { borderBottomColor: pal.border }]}>
            <View style={{ flex: 1 }}>
              <Text style={[styles.title, { color: pal.text }]}>Nearby stations</Text>
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
                No position fix yet. Nearby stations will appear once a location is available.
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
              {/* bucket filter — All / Music / Talk */}
              {showBuckets ? (
                <ScrollView
                  horizontal showsHorizontalScrollIndicator={false}
                  style={styles.filterBar} contentContainerStyle={styles.filterBarContent}
                >
                  {bucketChips.map((b) => (
                    <Chip key={b} label={b} active={b === bucket} pal={pal} onPress={() => pickBucket(b)} />
                  ))}
                </ScrollView>
              ) : null}
              {/* genre sub-filter — two rows, flows by column, scrolls horizontally */}
              {bucket !== 'All' && genres.length > 1 ? (
                <ScrollView
                  horizontal showsHorizontalScrollIndicator={false}
                  style={styles.subBar} contentContainerStyle={styles.subBarContent}
                >
                  {genres.map((g) => (
                    <Chip key={g} label={g} active={g === activeGenre} pal={pal} onPress={() => setGenre((cur) => (cur === g ? null : g))} />
                  ))}
                </ScrollView>
              ) : null}
              <ScrollView contentContainerStyle={styles.list}>
                {shown.map((st) => (
                  <Row
                    key={st.facilityId}
                    st={st}
                    pal={pal}
                    saved={presetMHz.has(Math.round(st.frequencyMhz * 10))}
                    strength={strengthOf(st, shown)}
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

  // Filter bars (design filterBarStyle / subBarStyle).
  filterBar: { flexGrow: 0, flexShrink: 0 },
  filterBarContent: { flexDirection: 'row', gap: 10, paddingHorizontal: 22, paddingTop: 14 },
  subBar: { flexGrow: 0, flexShrink: 0 },
  // Two rows, chips flow column-by-column, scrolls horizontally.
  subBarContent: { flexDirection: 'column', flexWrap: 'wrap', height: 72, alignContent: 'flex-start', gap: 8, paddingHorizontal: 22, paddingTop: 10 },
  chip: { height: 32, paddingHorizontal: 13, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  chipText: { fontFamily: FONT_BOLD, fontSize: 13, letterSpacing: 0.3 },

  list: { padding: 16, paddingHorizontal: 22, gap: 10 },
  row: {
    minHeight: 92, borderRadius: 16, borderWidth: 1,
    flexDirection: 'row', alignItems: 'center', gap: 18,
    paddingVertical: 14, paddingHorizontal: 18,
  },
  logo: { width: 60, height: 60, borderRadius: 14 },
  logoText: { color: '#FFF', fontFamily: FONT_BOLD, fontSize: 18 },
  info: { flexShrink: 1 },
  line1: { flexDirection: 'row', alignItems: 'baseline', gap: 8 },
  freq: { fontFamily: FONT_BOLD, fontSize: 32, fontVariant: ['tabular-nums'] },
  mhz: { fontFamily: FONT, fontSize: 15 },
  call: { fontFamily: FONT_BOLD, fontSize: 20,  },
  badge: { borderWidth: 1, borderRadius: 999, paddingHorizontal: 8, paddingVertical: 1 },
  badgeText: { fontFamily: FONT_BOLD, fontSize: 12,  },
  meta: { fontFamily: FONT, fontSize: 15, marginTop: 2 },
  spacer: { flex: 1 },
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
