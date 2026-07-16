/**
 * Presets band (design: bottom strip, height ~140): ‹ › nav buttons, a
 * horizontally scrolling preset grid with a custom draggable scrollbar (no
 * native bar, no arrows), and the round NEARBY disc — replaced by DONE while
 * reordering. Long-press a tile to enter reorder mode: tiles wiggle and show
 * ‹ › move controls and a ✕ remove badge; moves animate to their new slot.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Animated, Easing, LayoutAnimation, PanResponder, Platform, Pressable,
  ScrollView, StyleSheet, Text, UIManager, View,
  type LayoutChangeEvent, type NativeScrollEvent, type NativeSyntheticEvent,
} from 'react-native';

import { MagnifierTower } from './icons';
import LogoTile from './LogoTile';
import { FONT, type CarFmPalette } from './tokens';

if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

export interface PresetItem { name: string; frequencyMhz: number; }

const TILE_W = 148;
const GAP = 10;
const HOLD_MS = 550;
const MOVE_ANIM = { duration: 300, create: { type: 'easeInEaseOut', property: 'opacity' },
  update: { type: 'easeInEaseOut' }, delete: { type: 'easeInEaseOut', property: 'opacity' } } as const;

/** One preset tile; wiggles (±1.1°, 0.42s loop) while reordering. */
function Tile({ p, pal, active, reordering, first, last, onPress, onLongPress, onMove, onRemove }: {
  p: PresetItem; pal: CarFmPalette; active: boolean; reordering: boolean;
  first: boolean; last: boolean;
  onPress: () => void; onLongPress: () => void;
  onMove: (dir: 1 | -1) => void; onRemove: () => void;
}) {
  const rot = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!reordering) { rot.setValue(0); return; }
    const loop = Animated.loop(Animated.sequence([
      Animated.timing(rot, { toValue: 1, duration: 210, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
      Animated.timing(rot, { toValue: -1, duration: 210, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
    ]));
    loop.start();
    return () => loop.stop();
  }, [reordering, rot]);
  const rotate = rot.interpolate({ inputRange: [-1, 1], outputRange: ['-1.1deg', '1.1deg'] });

  return (
    <Animated.View style={{ transform: [{ rotate }] }}>
      <Pressable
        onPress={onPress}
        onLongPress={onLongPress}
        delayLongPress={HOLD_MS}
        style={({ pressed }) => [
          styles.tile,
          {
            backgroundColor: pal.panel,
            borderColor: active ? pal.blue : pal.border,
            borderWidth: active ? 2 : 1,
          },
          pressed && !reordering && { opacity: 0.6 },
        ]}
        accessibilityRole="button"
        accessibilityState={{ selected: active }}
        accessibilityLabel={`Preset ${p.name}${active ? ', playing' : ''}${reordering ? ', reordering' : ''}`}
      >
        {reordering ? (
          <>
            <Pressable
              onPress={onRemove}
              style={[styles.removeBadge, { backgroundColor: pal.amber }]}
              accessibilityRole="button" accessibilityLabel={`Remove preset ${p.name}`}
            >
              <Text style={styles.removeText}>✕</Text>
            </Pressable>
            <Pressable
              onPress={() => onMove(-1)} disabled={first}
              style={[styles.moveBtn, styles.moveLeft, { backgroundColor: pal.raised, opacity: first ? 0.3 : 1 }]}
              accessibilityRole="button" accessibilityLabel="Move left"
            >
              <Text style={[styles.moveText, { color: pal.text }]}>‹</Text>
            </Pressable>
            <Pressable
              onPress={() => onMove(1)} disabled={last}
              style={[styles.moveBtn, styles.moveRight, { backgroundColor: pal.raised, opacity: last ? 0.3 : 1 }]}
              accessibilityRole="button" accessibilityLabel="Move right"
            >
              <Text style={[styles.moveText, { color: pal.text }]}>›</Text>
            </Pressable>
          </>
        ) : null}
        <LogoTile name={p.name} size={58} radius={15} />
        <Text style={[styles.tileName, { color: pal.text }]} numberOfLines={2}>
          {p.name}
        </Text>
        {active ? <View style={[styles.activeBar, { backgroundColor: pal.amber }]} /> : null}
      </Pressable>
    </Animated.View>
  );
}

export default function PresetsBand({
  pal, presets, activeIndex, reordering,
  onSelect, onEnterReorder, onExitReorder, onMove, onRemove, onOpenNearby,
}: {
  pal: CarFmPalette;
  presets: PresetItem[];
  activeIndex: number;                    // -1 when the tuned freq isn't a preset
  reordering: boolean;
  onSelect: (p: PresetItem) => void;
  onEnterReorder: () => void;
  onExitReorder: () => void;
  onMove: (index: number, dir: 1 | -1) => void;
  onRemove: (index: number) => void;
  onOpenNearby: () => void;
}) {
  const scroll = useRef<ScrollView>(null);
  const [viewW, setViewW] = useState(0);
  const [contentW, setContentW] = useState(0);
  const [scrollX, setScrollX] = useState(0);
  const [trackW, setTrackW] = useState(0);

  const showBar = contentW > viewW && viewW > 0;
  const thumbW = showBar ? Math.max(24, (viewW / contentW) * trackW) : 0;
  const maxScroll = Math.max(1, contentW - viewW);
  const thumbL = showBar ? (scrollX / maxScroll) * (trackW - thumbW) : 0;

  const onScroll = (e: NativeSyntheticEvent<NativeScrollEvent>) =>
    setScrollX(e.nativeEvent.contentOffset.x);

  // Track/thumb are draggable: pointer x → scrollLeft.
  const pan = useRef(PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,
    onPanResponderGrant: (evt) => dragTo(evt.nativeEvent.locationX),
    onPanResponderMove: (evt) => dragTo(evt.nativeEvent.locationX),
  })).current;
  const geo = useRef({ trackW: 0, thumbW: 0, maxScroll: 1 });
  geo.current = { trackW, thumbW, maxScroll };
  function dragTo(x: number) {
    const g = geo.current;
    if (g.trackW <= g.thumbW) return;
    const f = Math.max(0, Math.min(1, (x - g.thumbW / 2) / (g.trackW - g.thumbW)));
    scroll.current?.scrollTo({ x: f * g.maxScroll, animated: false });
  }

  // Selecting a preset auto-scrolls the strip to centre the active tile.
  useEffect(() => {
    if (activeIndex < 0 || !showBar) return;
    const target = activeIndex * (TILE_W + GAP) - (viewW - TILE_W) / 2;
    scroll.current?.scrollTo({ x: Math.max(0, Math.min(maxScroll, target)), animated: true });
  }, [activeIndex, showBar, viewW, maxScroll]);

  const move = useCallback((index: number, dir: 1 | -1) => {
    LayoutAnimation.configureNext(MOVE_ANIM);
    onMove(index, dir);
  }, [onMove]);
  const remove = useCallback((index: number) => {
    LayoutAnimation.configureNext(MOVE_ANIM);
    onRemove(index);
  }, [onRemove]);

  return (
    <View style={styles.band}>
      {/* ‹ page-left */}
      <Pressable
        onPress={() => scroll.current?.scrollTo({ x: Math.max(0, scrollX - viewW * 0.8), animated: true })}
        style={({ pressed }) => [styles.nav, { backgroundColor: pal.raised, borderColor: pal.border }, pressed && { opacity: 0.55 }]}
        accessibilityRole="button" accessibilityLabel="Scroll presets left"
      >
        <Text style={[styles.navText, { color: pal.text }]}>‹</Text>
      </Pressable>

      {/* grid + custom scrollbar */}
      <View style={styles.gridWrap}>
        <ScrollView
          ref={scroll}
          horizontal
          showsHorizontalScrollIndicator={false}
          onLayout={(e: LayoutChangeEvent) => setViewW(e.nativeEvent.layout.width)}
          onContentSizeChange={(w: number) => setContentW(w)}
          onScroll={onScroll}
          scrollEventThrottle={16}
          contentContainerStyle={styles.grid}
        >
          {presets.length === 0 ? (
            <View style={styles.emptyWrap}>
              <Text style={[styles.empty, { color: pal.dim }]}>
                No presets yet — tap ★ to save the tuned station, or find one with NEARBY.
              </Text>
            </View>
          ) : presets.map((p, i) => (
            <Tile
              key={`${p.name}|${p.frequencyMhz}`}
              p={p}
              pal={pal}
              active={i === activeIndex}
              reordering={reordering}
              first={i === 0}
              last={i === presets.length - 1}
              onPress={() => (reordering ? undefined : onSelect(p))}
              onLongPress={onEnterReorder}
              onMove={(dir) => move(i, dir)}
              onRemove={() => remove(i)}
            />
          ))}
        </ScrollView>
        {showBar ? (
          <View
            style={[styles.track, { backgroundColor: pal.meterEmpty }]}
            onLayout={(e: LayoutChangeEvent) => setTrackW(e.nativeEvent.layout.width)}
            {...pan.panHandlers}
          >
            <View style={[styles.thumb, { backgroundColor: pal.scrollThumb, width: thumbW, left: thumbL }]} />
          </View>
        ) : <View style={styles.track} />}
      </View>

      {/* › page-right */}
      <Pressable
        onPress={() => scroll.current?.scrollTo({ x: Math.min(maxScroll, scrollX + viewW * 0.8), animated: true })}
        style={({ pressed }) => [styles.nav, { backgroundColor: pal.raised, borderColor: pal.border }, pressed && { opacity: 0.55 }]}
        accessibilityRole="button" accessibilityLabel="Scroll presets right"
      >
        <Text style={[styles.navText, { color: pal.text }]}>›</Text>
      </Pressable>

      {/* NEARBY disc — DONE while reordering */}
      {reordering ? (
        <Pressable
          onPress={onExitReorder}
          style={({ pressed }) => [styles.nearby, { backgroundColor: pal.blue }, pressed && { opacity: 0.7 }]}
          accessibilityRole="button" accessibilityLabel="Done reordering"
        >
          <Text style={styles.doneCheck}>✓</Text>
          <Text style={styles.doneText}>DONE</Text>
        </Pressable>
      ) : (
        <Pressable
          onPress={onOpenNearby}
          style={({ pressed }) => [styles.nearby, { backgroundColor: pal.panel, borderWidth: 1, borderColor: pal.border }, pressed && { opacity: 0.7 }]}
          accessibilityRole="button" accessibilityLabel="Nearby stations"
        >
          <MagnifierTower size={64} line={pal.text} glass={pal.raised} />
        </Pressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  band: { height: 140, flexDirection: 'row', alignItems: 'stretch', gap: 10 },
  nav: { width: 56, borderRadius: 16, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  navText: { fontSize: 30, fontWeight: '700', fontFamily: FONT },
  gridWrap: { flex: 1 },
  grid: { gap: GAP, alignItems: 'stretch', paddingVertical: 2 },
  emptyWrap: { justifyContent: 'center', paddingHorizontal: 14 },
  empty: { fontFamily: FONT, fontSize: 15 },
  tile: {
    width: TILE_W, flex: 1, borderRadius: 16,
    alignItems: 'center', justifyContent: 'center', gap: 6, paddingHorizontal: 8,
  },
  tileName: { fontFamily: FONT, fontSize: 18, fontWeight: '700', textAlign: 'center' },
  activeBar: { position: 'absolute', bottom: 6, width: 26, height: 3, borderRadius: 2 },
  removeBadge: {
    position: 'absolute', top: -6, right: -6, zIndex: 2,
    width: 30, height: 30, borderRadius: 15, alignItems: 'center', justifyContent: 'center',
  },
  removeText: { color: '#FFF', fontSize: 15, fontWeight: '700' },
  moveBtn: {
    position: 'absolute', top: 6, zIndex: 2, width: 34, height: 34, borderRadius: 10,
    alignItems: 'center', justifyContent: 'center',
  },
  moveLeft: { left: 6 },
  moveRight: { right: 6 },
  moveText: { fontSize: 22, fontWeight: '700', lineHeight: 24 },
  track: { height: 6, borderRadius: 999, marginTop: 6, overflow: 'hidden' },
  thumb: { position: 'absolute', top: 0, bottom: 0, borderRadius: 999 },
  nearby: {
    width: 92, height: 92, borderRadius: 46, alignSelf: 'center',
    alignItems: 'center', justifyContent: 'center',
  },
  doneCheck: { color: '#FFF', fontSize: 26, fontWeight: '700' },
  doneText: { color: '#FFF', fontFamily: FONT, fontSize: 13, fontWeight: '700', letterSpacing: 1.5 },
});
