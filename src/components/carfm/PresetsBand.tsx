/**
 * Presets band. Three layout tracks (design handoff aspect-ratio pass):
 *   - strip   (wide / landscape): horizontal scroll, ‹ › nav, custom scrollbar,
 *             active tile grows; smaller tiles in the short landscape track.
 *   - tworow  (⅔ slice): 2-row horizontal grid (columns of two).
 *   - grid    (tall / ⅓ slice / portrait): 3-column vertical grid, scrolls down.
 * Long-press a tile → reorder mode: tiles wiggle, show ‹ › move + ✕ remove; the
 * NEARBY disc becomes DONE. In the tall track NEARBY/DONE + nav live in the top
 * bar (the face passes showNav/showNearby=false there).
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Animated, Easing, PanResponder, Pressable,
  ScrollView, StyleSheet, Text, View,
  type LayoutChangeEvent, type NativeScrollEvent, type NativeSyntheticEvent,
} from 'react-native';

import { MagnifierTower } from './icons';
import LogoTile from './LogoTile';
import { FONT, type CarFmPalette } from './tokens';

export interface PresetItem { name: string; frequencyMhz: number; }

const TILE_W = 148;
const GAP = 10;
const HOLD_MS = 550;

interface TileSize { w: number | 'auto'; h: number | string; logo: number; logoRadius: number; nameFont: number; }

/** One preset tile; wiggles (±1.1°, 0.42s loop) while reordering. */
function Tile({ p, pal, active, reordering, first, last, size, flipX, onMeasureX, onPress, onLongPress, onMove, onRemove }: {
  p: PresetItem; pal: CarFmPalette; active: boolean; reordering: boolean;
  first: boolean; last: boolean; size: TileSize;
  flipX: Animated.Value; onMeasureX: (x: number) => void;
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
    <Animated.View
      style={{ transform: [{ translateX: flipX }, { rotate }] }}
      onLayout={(e: LayoutChangeEvent) => onMeasureX(e.nativeEvent.layout.x)}
    >
      <Pressable
        onPress={onPress}
        onLongPress={onLongPress}
        delayLongPress={HOLD_MS}
        style={({ pressed }) => [
          styles.tile,
          {
            width: size.w, height: size.h as any,
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
        <LogoTile name={p.name} size={size.logo} radius={size.logoRadius} />
        <Text style={[styles.tileName, { fontSize: size.nameFont, color: pal.text }]} numberOfLines={2}>
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
  grow = false, bandHeight = 140, showNav = true, showNearby = true,
  tall = false, twoRows = false, landscape = false,
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
  /** Tall track: fill remaining height instead of a fixed band height. */
  grow?: boolean;
  /** Fixed band height when not growing (per aspect track). In the tall track the
   *  caller passes a content-sized height capped at 46% (design §2). */
  bandHeight?: number;
  /** Show the ‹ › page buttons (hidden in the tall track). */
  showNav?: boolean;
  /** Show the in-band NEARBY/DONE disc (moves to the top bar in the tall track). */
  showNearby?: boolean;
  /** Layout track. tall → 3-col vertical grid; twoRows → 2-row horizontal grid;
   *  otherwise a horizontal strip (landscape shrinks the tiles). */
  tall?: boolean;
  twoRows?: boolean;
  landscape?: boolean;
}) {
  const scroll = useRef<ScrollView>(null);
  const [viewW, setViewW] = useState(0);
  const [viewH, setViewH] = useState(0);
  const [contentW, setContentW] = useState(0);
  const [scrollX, setScrollX] = useState(0);
  const [trackW, setTrackW] = useState(0);

  const strip = !tall && !twoRows;

  // Custom draggable scrollbar only applies to the horizontal strip track.
  const showBar = strip && contentW > viewW && viewW > 0;
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

  // Selecting a preset auto-scrolls the strip to centre the active tile (strip only).
  useEffect(() => {
    if (!strip || activeIndex < 0 || !showBar) return;
    const target = activeIndex * (TILE_W + GAP) - (viewW - TILE_W) / 2;
    scroll.current?.scrollTo({ x: Math.max(0, Math.min(maxScroll, target)), animated: true });
  }, [strip, activeIndex, showBar, viewW, maxScroll]);

  // Preset-reflow FLIP (design runFlip): on a reorder/remove the list re-lays
  // out instantly, then each tile that shifted animates translateX from its old
  // position to its new one over 300ms cubic-bezier(.2,.8,.2,1). RN has no CSS
  // FLIP → capture each tile's x before the change, diff against the post-change
  // x reported by onLayout, and drive a per-tile translateX back to 0.
  const tileX = useRef<Map<string, number>>(new Map()).current;        // last measured x
  const flipVals = useRef<Map<string, Animated.Value>>(new Map()).current;
  const pending = useRef<Map<string, number>>(new Map()).current;      // pre-change x snapshot
  const flipVal = useCallback((key: string) => {
    let v = flipVals.get(key);
    if (!v) { v = new Animated.Value(0); flipVals.set(key, v); }
    return v;
  }, [flipVals]);
  const snapshot = useCallback(() => {
    pending.clear();
    tileX.forEach((x, k) => pending.set(k, x));
  }, [pending, tileX]);
  const onMeasureX = useCallback((key: string, x: number) => {
    const old = pending.get(key);
    tileX.set(key, x);
    if (old == null) return;
    pending.delete(key);
    const dx = old - x;
    if (Math.abs(dx) < 1) return;
    const v = flipVal(key);
    v.setValue(dx);
    Animated.timing(v, { toValue: 0, duration: 300, easing: Easing.bezier(0.2, 0.8, 0.2, 1), useNativeDriver: true }).start();
  }, [pending, tileX, flipVal]);

  const move = useCallback((index: number, dir: 1 | -1) => {
    snapshot();
    onMove(index, dir);
  }, [onMove, snapshot]);
  const remove = useCallback((index: number) => {
    snapshot();
    onRemove(index);
  }, [onRemove, snapshot]);

  // Per-track tile sizing (design renderVals). The active tile grows only in the
  // strip tracks; grid/two-row tiles are uniform.
  const tileSizeFor = (active: boolean): TileSize => {
    if (tall) {
      const w = viewW > 0 ? (viewW - 2 * 12 - 8) / 3 : 118;   // 3 cols, 12px gaps, 4px h-pad
      return { w, h: 128, logo: 50, logoRadius: 13, nameFont: 15 };
    }
    if (twoRows) {
      // Fixed row height from the band height (no measure dependency) so the two
      // rows are stable from the first frame.
      const rowH = Math.max(96, Math.round((bandHeight - GAP) / 2));
      return { w: 150, h: rowH, logo: 46, logoRadius: 12, nameFont: 15 };
    }
    const big = active && !reordering;
    return {
      w: big ? (landscape ? 134 : 150) : (landscape ? 106 : 118),
      h: big ? '100%' : '80%',
      logo: big ? (landscape ? 50 : 58) : (landscape ? 38 : 44),
      logoRadius: big ? 15 : 12,
      nameFont: big ? (landscape ? 16 : 18) : (landscape ? 13 : 15),
    };
  };

  const tiles = presets.map((p, i) => {
    const key = `${p.name}|${p.frequencyMhz}`;
    return (
      <Tile
        key={key}
        p={p}
        pal={pal}
        active={i === activeIndex}
        reordering={reordering}
        first={i === 0}
        last={i === presets.length - 1}
        size={tileSizeFor(i === activeIndex)}
        flipX={flipVal(key)}
        onMeasureX={(x) => onMeasureX(key, x)}
        onPress={() => (reordering ? undefined : onSelect(p))}
        onLongPress={onEnterReorder}
        onMove={(dir) => move(i, dir)}
        onRemove={() => remove(i)}
      />
    );
  });

  const empty = (
    <View style={styles.emptyWrap}>
      <Text style={[styles.empty, { color: pal.dim }]}>
        No presets yet — tap ★ to save the tuned station, or find one with NEARBY.
      </Text>
    </View>
  );

  // The scrollable preset area, one of three layouts.
  let gridArea: React.ReactNode;
  if (tall) {
    // 3-column vertical grid, scrolls down; top-aligned (PHONEPORTRAITFIXES §2).
    gridArea = (
      <ScrollView
        ref={scroll}
        showsVerticalScrollIndicator={false}
        onLayout={(e: LayoutChangeEvent) => setViewW(e.nativeEvent.layout.width)}
        contentContainerStyle={styles.gridWrapTall}
      >
        {presets.length === 0 ? empty : tiles}
      </ScrollView>
    );
  } else if (twoRows) {
    // 2-row grid: explicit stacked columns of two (column-major, matching the
    // design). Built as real rows rather than a flexWrap-by-measured-height,
    // which collapses to a single row before the height is known (LOSSY-ELEMENTS
    // #3). tile i and i+1 share a column, so the grid reads top-to-bottom then
    // left-to-right.
    const cols: React.ReactNode[][] = [];
    for (let i = 0; i < tiles.length; i += 2) cols.push(tiles.slice(i, i + 2));
    gridArea = (
      <ScrollView ref={scroll} horizontal showsHorizontalScrollIndicator={false}>
        {presets.length === 0 ? empty : (
          <View style={styles.gridTwoRow}>
            {cols.map((col, ci) => <View key={ci} style={styles.twoRowCol}>{col}</View>)}
          </View>
        )}
      </ScrollView>
    );
  } else {
    // Horizontal strip with custom scrollbar.
    gridArea = (
      <>
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
          {presets.length === 0 ? empty : tiles}
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
      </>
    );
  }

  return (
    <View style={[styles.band, grow ? { flex: 1 } : { height: bandHeight }]}>
      {/* ‹ page-left (strip/two-row only) */}
      {showNav ? (
      <Pressable
        onPress={() => scroll.current?.scrollTo({ x: Math.max(0, scrollX - viewW * 0.8), animated: true })}
        style={({ pressed }) => [styles.nav, { backgroundColor: pal.raised, borderColor: pal.border }, pressed && { opacity: 0.55 }]}
        accessibilityRole="button" accessibilityLabel="Scroll presets left"
      >
        <Text style={[styles.navText, { color: pal.text }]}>‹</Text>
      </Pressable>
      ) : null}

      <View style={styles.gridWrap}>{gridArea}</View>

      {/* › page-right (strip/two-row only) */}
      {showNav ? (
      <Pressable
        onPress={() => scroll.current?.scrollTo({ x: Math.min(maxScroll, scrollX + viewW * 0.8), animated: true })}
        style={({ pressed }) => [styles.nav, { backgroundColor: pal.raised, borderColor: pal.border }, pressed && { opacity: 0.55 }]}
        accessibilityRole="button" accessibilityLabel="Scroll presets right"
      >
        <Text style={[styles.navText, { color: pal.text }]}>›</Text>
      </Pressable>
      ) : null}

      {/* NEARBY disc — DONE while reordering. Hidden in the tall track, where it
          lives in the top bar instead. */}
      {!showNearby ? null : reordering ? (
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
  band: { flexDirection: 'row', alignItems: 'stretch', gap: 10 },
  nav: { width: 56, borderRadius: 16, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  navText: { fontSize: 30, fontWeight: '700', fontFamily: FONT },
  gridWrap: { flex: 1 },
  grid: { gap: GAP, alignItems: 'stretch', paddingVertical: 2 },
  gridWrapTall: { flexDirection: 'row', flexWrap: 'wrap', gap: 12, alignContent: 'flex-start', paddingHorizontal: 4, paddingVertical: 3 },
  gridTwoRow: { flexDirection: 'row', gap: GAP, alignItems: 'flex-start', paddingVertical: 2 },
  twoRowCol: { gap: GAP },
  emptyWrap: { justifyContent: 'center', paddingHorizontal: 14, maxWidth: 340 },
  empty: { fontFamily: FONT, fontSize: 15 },
  tile: {
    borderRadius: 16,
    alignItems: 'center', justifyContent: 'center', gap: 6, paddingHorizontal: 8,
  },
  tileName: { fontFamily: FONT, fontWeight: '700', textAlign: 'center' },
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
