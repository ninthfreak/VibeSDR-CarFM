/**
 * Presets band. Three layout tracks (design handoff aspect-ratio pass):
 *   - strip   (wide / landscape): horizontal scroll, ‹ › nav, custom scrollbar,
 *             active tile grows; smaller tiles in the short landscape track.
 *   - tworow  (⅔ slice): 2-row horizontal grid (columns of two).
 *   - grid    (tall / ⅓ slice / portrait): 3-column vertical grid, scrolls down.
 * Long-press a tile → reorder mode: tiles wiggle and show the logo-search badge
 * (top-left) + ✕ remove badge (top-right); the NEARBY disc becomes DONE.
 *
 * Reorder is by DRAG (§4.3/§8), not arrows: the long-press flows straight into a
 * drag with the same finger (no lift-and-re-press). The picked-up tile lifts
 * (scale 1.06 + shadow) and tracks the finger; the wiggle freezes; the other
 * tiles slide apart to open a real gap at the insertion slot (transform-only,
 * ~160ms; geometry locked to slot rects captured in WINDOW coords at drag start,
 * so it works across all tracks and doesn't oscillate). The list is NOT reordered
 * mid-drag — on release the order commits and every tile (incl. the dropped one,
 * sliding from the finger) resolves via a FLIP slide (~300ms cubic-bezier).
 *
 * NOTE: the drag gesture + Animated transforms + measureInWindow all need a real
 * device; they cannot be exercised in the headless still-harness. Verify on a
 * device screen recording (CORRECTION-LOOP), not a screenshot.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Animated, Easing, PanResponder, Pressable,
  ScrollView, StyleSheet, Text, View,
  type LayoutChangeEvent, type NativeScrollEvent, type NativeSyntheticEvent,
} from 'react-native';

import { LogoSearchIcon, MagnifierTower } from './icons';
import LogoTile from './LogoTile';
import { FONT, FONT_BOLD, type CarFmPalette } from './tokens';

export interface PresetItem { name: string; frequencyMhz: number; }

const TILE_W = 148;
const GAP = 10;
const HOLD_MS = 550;
const keyOf = (p: PresetItem) => `${p.name}|${p.frequencyMhz}`;

interface TileSize {
  w: number | 'auto'; h: number | string; logo: number; logoRadius: number; nameFont: number;
  /** Design tileStyle padding '8 6 12' (big '12 8 16') — the deeper bottom pad
   *  keeps the callsign clear of the active underline. */
  padTop: number; padBottom: number;
}

interface DragCallbacks {
  begin: (pageX: number, pageY: number) => void;
  move: (pageX: number, pageY: number) => void;
  end: () => void;
}

/** One preset tile; wiggles (±1.1°, 0.42s loop) while reordering, frozen mid-drag. */
function Tile({
  p, pal, active, reordering, size, dragging, anyDrag,
  translate, flip, shift, tileRef, onMeasure, onPress, onLongPress, onRemove, onSearchLogo, drag,
}: {
  p: PresetItem; pal: CarFmPalette; active: boolean; reordering: boolean; size: TileSize;
  dragging: boolean; anyDrag: boolean;
  translate: Animated.ValueXY; flip: Animated.ValueXY; shift: Animated.ValueXY;
  tileRef: (v: View | null) => void; onMeasure: (x: number, y: number) => void;
  onPress: () => void; onLongPress: () => void; onRemove: () => void; onSearchLogo?: () => void;
  drag: DragCallbacks;
}) {
  const rot = useRef(new Animated.Value(0)).current;
  // Wiggle only while reordering AND no drag is in progress (the drag freezes it).
  useEffect(() => {
    if (!reordering || anyDrag) { return; }
    const loop = Animated.loop(Animated.sequence([
      Animated.timing(rot, { toValue: 1, duration: 210, easing: Easing.inOut(Easing.quad), useNativeDriver: false }),
      Animated.timing(rot, { toValue: -1, duration: 210, easing: Easing.inOut(Easing.quad), useNativeDriver: false }),
    ]));
    loop.start();
    return () => loop.stop();
  }, [reordering, anyDrag, rot]);
  useEffect(() => { if (!reordering) rot.setValue(0); }, [reordering, rot]);
  const rotate = rot.interpolate({ inputRange: [-1, 1], outputRange: ['-1.1deg', '1.1deg'] });

  // The active translate source: the dragged tile follows the finger; others use
  // their gap-shift while a drag is live, else their FLIP-settle value. Only one
  // source drives a given view, so native (flip/shift) and JS (drag) never mix.
  const t = dragging ? translate : (anyDrag ? shift : flip);

  const cb = useRef(drag); cb.current = drag;
  const reorderingRef = useRef(reordering); reorderingRef.current = reordering;
  const pan = useRef(PanResponder.create({
    onStartShouldSetPanResponder: () => false,
    onStartShouldSetPanResponderCapture: () => false,
    // In reorder mode, a >4dp move on a tile becomes a drag — captured from the
    // inner Pressable / badges so the whole tile picks up.
    onMoveShouldSetPanResponderCapture: (_e, g) =>
      reorderingRef.current && (Math.abs(g.dx) > 4 || Math.abs(g.dy) > 4),
    onPanResponderGrant: (_e, g) => cb.current.begin(g.x0, g.y0),
    onPanResponderMove: (_e, g) => cb.current.move(g.moveX, g.moveY),
    onPanResponderRelease: () => cb.current.end(),
    onPanResponderTerminate: () => cb.current.end(),
  })).current;

  // translate + scale + rotate on one view. All of drag (JS setValue), flip,
  // shift and the wiggle are JS-driven (useNativeDriver:false), so no single
  // transform array mixes a JS-driven and a native-driven value.
  return (
    <Animated.View
      ref={tileRef}
      collapsable={false}
      style={[
        { transform: [{ translateX: t.x }, { translateY: t.y }, { scale: dragging ? 1.06 : 1 }, { rotate }] },
        dragging && styles.lifted,
      ]}
      onLayout={(e: LayoutChangeEvent) => onMeasure(e.nativeEvent.layout.x, e.nativeEvent.layout.y)}
      {...pan.panHandlers}
    >
      <Pressable
        onPress={onPress}
        onLongPress={onLongPress}
        delayLongPress={HOLD_MS}
        style={({ pressed }) => [
          styles.tile,
          {
            width: size.w, height: size.h as any,
            paddingTop: size.padTop, paddingBottom: size.padBottom,
            backgroundColor: pal.panel,
            borderColor: active ? pal.blue : pal.border,
            borderWidth: active ? 2 : 1,
          },
          pressed && !reordering && { opacity: 0.6 },
        ]}
        accessibilityRole="button"
        accessibilityState={{ selected: active }}
        accessibilityLabel={`Preset ${p.name}${active ? ', playing' : ''}${reordering ? ', reordering — drag to move' : ''}`}
      >
        {reordering ? (
          <>
            {/* Logo-search badge (§6.4): magnifier-over-picture, top-left, blue. */}
            <Pressable
              onPress={onSearchLogo}
              hitSlop={10}
              style={[styles.logoEdit, { backgroundColor: pal.blue, borderColor: pal.panel }]}
              accessibilityRole="button" accessibilityLabel={`Find logo for ${p.name}`}
            >
              <LogoSearchIcon size={17} />
            </Pressable>
            <Pressable
              onPress={onRemove}
              hitSlop={10}
              style={[styles.removeBadge, { backgroundColor: pal.amber, borderColor: pal.panel }]}
              accessibilityRole="button" accessibilityLabel={`Remove preset ${p.name}`}
            >
              <Text style={styles.removeText}>✕</Text>
            </Pressable>
          </>
        ) : null}
        <LogoTile name={p.name} size={size.logo} radius={size.logoRadius} />
        <Text style={[styles.tileName, { fontSize: size.nameFont, color: pal.text }]} numberOfLines={2}>
          {p.name}
        </Text>
        {active ? <View style={[styles.activeBar, { backgroundColor: pal.blue }]} /> : null}
      </Pressable>
    </Animated.View>
  );
}

export default function PresetsBand({
  pal, presets, activeIndex, reordering,
  onSelect, onEnterReorder, onExitReorder, onReorder, onRemove, onOpenNearby, onSearchLogo,
  grow = false, bandHeight = 140, showNav = true, showNearby = true,
  tall = false, twoRows = false, landscape = false, k = 1,
}: {
  pal: CarFmPalette;
  presets: PresetItem[];
  activeIndex: number;                    // -1 when the tuned freq isn't a preset
  reordering: boolean;
  onSelect: (p: PresetItem) => void;
  onEnterReorder: () => void;
  onExitReorder: () => void;
  /** New order as original indices in their new arrangement (order[newPos] = oldIndex). */
  onReorder: (order: number[]) => void;
  onRemove: (index: number) => void;
  onOpenNearby: () => void;
  /** Reorder-mode logo-search trigger (the tile badge). */
  onSearchLogo?: (index: number) => void;
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
  /** Type/element ramp factor from the face (ANDROID §0 responsive tokens). */
  k?: number;
}) {
  const S = (v: number) => Math.round(v * (k ?? 1));
  const scroll = useRef<ScrollView>(null);
  const [viewW, setViewW] = useState(0);
  const [contentW, setContentW] = useState(0);
  const [scrollX, setScrollX] = useState(0);
  const [trackW, setTrackW] = useState(0);

  const strip = !tall && !twoRows;

  // Custom draggable scrollbar under both horizontal layouts (strip AND the
  // ⅔-slice two-row grid — the design shows it whenever the rail overflows).
  const showBar = !tall && contentW > viewW && viewW > 0;
  const thumbW = showBar ? Math.max(24, (viewW / contentW) * trackW) : 0;
  const maxScroll = Math.max(1, contentW - viewW);
  const thumbL = showBar ? (scrollX / maxScroll) * (trackW - thumbW) : 0;

  const onScroll = (e: NativeSyntheticEvent<NativeScrollEvent>) =>
    setScrollX(e.nativeEvent.contentOffset.x);

  // Track/thumb are draggable: pointer x → scrollLeft. (Still works in reorder
  // mode, where the rail's own scroll is disabled so tile drags aren't stolen.)
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

  // ── FLIP + drag machinery ──────────────────────────────────────────────────
  // FLIP settle (design runFlip): after a reorder/remove the list re-lays out
  // instantly, then each tile that shifted animates translate from its old
  // position to its new one (300ms). RN has no CSS FLIP → capture each tile's
  // {x,y} before the change, diff against the post-change layout from onLayout,
  // and drive a per-tile translate back to 0. 2D so it works in the grids too.
  const tilePos = useRef<Map<string, { x: number; y: number }>>(new Map()).current;   // last measured layout pos
  const pending = useRef<Map<string, { x: number; y: number }>>(new Map()).current;    // pre-change snapshot
  const flipVals = useRef<Map<string, Animated.ValueXY>>(new Map()).current;
  const shiftVals = useRef<Map<string, Animated.ValueXY>>(new Map()).current;
  const flipOf = useCallback((key: string) => {
    let v = flipVals.get(key); if (!v) { v = new Animated.ValueXY(); flipVals.set(key, v); } return v;
  }, [flipVals]);
  const shiftOf = useCallback((key: string) => {
    let v = shiftVals.get(key); if (!v) { v = new Animated.ValueXY(); shiftVals.set(key, v); } return v;
  }, [shiftVals]);
  const onMeasure = useCallback((key: string, x: number, y: number) => {
    const old = pending.get(key);
    tilePos.set(key, { x, y });
    if (!old) return;
    pending.delete(key);
    const dx = old.x - x, dy = old.y - y;
    if (Math.hypot(dx, dy) < 1) return;
    const v = flipOf(key);
    v.setValue({ x: dx, y: dy });
    Animated.timing(v, { toValue: { x: 0, y: 0 }, duration: 300, easing: Easing.bezier(0.2, 0.8, 0.2, 1), useNativeDriver: false }).start();
  }, [pending, tilePos, flipOf]);
  const snapshot = useCallback(() => {
    pending.clear();
    tilePos.forEach((pos, key) => pending.set(key, pos));
  }, [pending, tilePos]);

  // Latest-value refs for the drag closures (created once in each Tile).
  const tileRefs = useRef<Map<string, View | null>>(new Map()).current;
  const dragXY = useRef(new Animated.ValueXY()).current;
  const [dragKey, setDragKey] = useState<string | null>(null);
  const dragRef = useRef<{ key: string; ox: number; oy: number; dx: number; dy: number } | null>(null);
  const slotRef = useRef<{ keys: string[]; centers: { x: number; y: number }[] } | null>(null);
  const shiftTargets = useRef<Map<string, { x: number; y: number }>>(new Map()).current;
  const finalOrderRef = useRef<number[] | null>(null);
  const suppressPress = useRef(false);

  const keyIndex = useMemo(() => {
    const m = new Map<string, number>();
    presets.forEach((p, i) => m.set(keyOf(p), i));
    return m;
  }, [presets]);
  const keyIndexRef = useRef(keyIndex); keyIndexRef.current = keyIndex;
  const onReorderRef = useRef(onReorder); onReorderRef.current = onReorder;

  const measureAll = useCallback((done: (keys: string[], centers: { x: number; y: number }[]) => void) => {
    const keys = presets.map(keyOf);
    const centers: { x: number; y: number }[] = new Array(keys.length);
    let left = keys.length;
    if (left === 0) { done(keys, centers); return; }
    keys.forEach((key, i) => {
      const ref = tileRefs.get(key);
      if (!ref) { centers[i] = { x: 0, y: 0 }; if (--left === 0) done(keys, centers); return; }
      ref.measureInWindow((x, y, w, h) => {
        centers[i] = { x: x + w / 2, y: y + h / 2 };
        if (--left === 0) done(keys, centers);
      });
    });
  }, [presets, tileRefs]);

  const beginDrag = useCallback((key: string, pageX: number, pageY: number) => {
    dragRef.current = { key, ox: pageX, oy: pageY, dx: 0, dy: 0 };
    dragXY.setValue({ x: 0, y: 0 });
    shiftVals.forEach((v) => v.setValue({ x: 0, y: 0 }));
    shiftTargets.clear();
    setDragKey(key);
    measureAll((keys, centers) => { slotRef.current = { keys, centers }; });
  }, [dragXY, shiftVals, shiftTargets, measureAll]);

  const moveDrag = useCallback((pageX: number, pageY: number) => {
    const d = dragRef.current, slot = slotRef.current;
    if (!d || !slot) return;
    d.dx = pageX - d.ox; d.dy = pageY - d.oy;
    dragXY.setValue({ x: d.dx, y: d.dy });
    // nearest slot to the finger
    let best = Infinity, ns = 0;
    slot.centers.forEach((c, i) => { const dist = Math.hypot(pageX - c.x, pageY - c.y); if (dist < best) { best = dist; ns = i; } });
    const fromIdx = slot.keys.indexOf(d.key);
    if (fromIdx < 0) return;
    const arr = slot.keys.slice(); arr.splice(fromIdx, 1); arr.splice(ns, 0, d.key);
    finalOrderRef.current = arr.map((kk) => keyIndexRef.current.get(kk) ?? 0);
    // Open the gap: every other tile shifts from its current slot to its dest slot.
    slot.keys.forEach((f, cur) => {
      if (f === d.key) return;
      const dest = arr.indexOf(f);
      const tx = slot.centers[dest].x - slot.centers[cur].x;
      const ty = slot.centers[dest].y - slot.centers[cur].y;
      const prev = shiftTargets.get(f);
      if (!prev || prev.x !== tx || prev.y !== ty) {
        shiftTargets.set(f, { x: tx, y: ty });
        Animated.timing(shiftOf(f), { toValue: { x: tx, y: ty }, duration: 160, easing: Easing.out(Easing.quad), useNativeDriver: false }).start();
      }
    });
  }, [dragXY, shiftOf, shiftTargets]);

  const endDrag = useCallback(() => {
    const d = dragRef.current;
    if (!d) return;
    const order = finalOrderRef.current;
    // FLIP snapshot = each tile's VISUAL position (layout + its live transform),
    // so the settle runs from where the finger/gap left them, not a pre-drag jump.
    pending.clear();
    tilePos.forEach((pos, key) => {
      if (key === d.key) pending.set(key, { x: pos.x + d.dx, y: pos.y + d.dy });
      else { const s = shiftTargets.get(key) || { x: 0, y: 0 }; pending.set(key, { x: pos.x + s.x, y: pos.y + s.y }); }
    });
    dragRef.current = null; slotRef.current = null; finalOrderRef.current = null;
    setDragKey(null);
    dragXY.setValue({ x: 0, y: 0 });
    shiftVals.forEach((v) => v.setValue({ x: 0, y: 0 }));
    shiftTargets.clear();
    suppressPress.current = true;
    setTimeout(() => { suppressPress.current = false; }, 150);
    if (order && onReorderRef.current) onReorderRef.current(order);
  }, [pending, tilePos, dragXY, shiftVals, shiftTargets]);

  const remove = useCallback((index: number) => { snapshot(); onRemove(index); }, [onRemove, snapshot]);

  // Per-track tile sizing (design renderVals). The active tile grows only in the
  // strip tracks; grid/two-row tiles are uniform.
  const tileSizeFor = (active: boolean): TileSize => {
    const nf = (v: number) => Math.max(12, S(v));   // tile-name legibility floor
    if (tall) {
      const g = S(12);
      const w = viewW > 0 ? (viewW - 2 * g - 8) / 3 : S(118);   // 3 cols, gaps, h-pad
      return { w, h: S(128), logo: S(50), logoRadius: 13, nameFont: nf(15), padTop: S(8), padBottom: S(12) };
    }
    if (twoRows) {
      const rowH = Math.max(S(90), Math.round((bandHeight - GAP - 16) / 2));
      return { w: S(150), h: rowH, logo: S(46), logoRadius: 12, nameFont: nf(15), padTop: S(8), padBottom: S(12) };
    }
    const big = active && !reordering;
    return {
      w: S(big ? (landscape ? 134 : 150) : (landscape ? 106 : 118)),
      h: big ? '100%' : '80%',
      logo: S(big ? (landscape ? 50 : 58) : (landscape ? 38 : 44)),
      logoRadius: big ? 15 : 12,
      nameFont: nf(big ? (landscape ? 16 : 18) : (landscape ? 13 : 15)),
      padTop: S(big ? 12 : 8),
      padBottom: S(big ? 16 : 12),
    };
  };

  const anyDrag = dragKey != null;
  const tiles = presets.map((p, i) => {
    const key = keyOf(p);
    return (
      <Tile
        key={key}
        p={p}
        pal={pal}
        active={i === activeIndex}
        reordering={reordering}
        size={tileSizeFor(i === activeIndex)}
        dragging={dragKey === key}
        anyDrag={anyDrag}
        translate={dragXY}
        flip={flipOf(key)}
        shift={shiftOf(key)}
        tileRef={(v) => { if (v) tileRefs.set(key, v); else tileRefs.delete(key); }}
        onMeasure={(x, y) => onMeasure(key, x, y)}
        onPress={() => { if (suppressPress.current) return; if (!reordering) onSelect(p); }}
        onLongPress={onEnterReorder}
        onRemove={() => remove(i)}
        onSearchLogo={onSearchLogo ? () => onSearchLogo(i) : undefined}
        drag={{
          begin: (x, y) => beginDrag(key, x, y),
          move: moveDrag,
          end: endDrag,
        }}
      />
    );
  });

  // Design emptyStyle: a dashed full-band placeholder with the exact copy.
  const empty = (
    <View style={[styles.emptyWrap, { borderColor: pal.border }]}>
      <Text style={[styles.empty, { color: pal.dim }]}>
        No presets yet — tune a station and tap the ★
      </Text>
    </View>
  );

  // The scrollable preset area, one of three layouts. Rail scroll is disabled in
  // reorder mode so a tile drag isn't stolen by the ScrollView (the scrollbar and
  // ‹ › nav still scroll it programmatically).
  let gridArea: React.ReactNode;
  if (tall) {
    gridArea = (
      <ScrollView
        ref={scroll}
        scrollEnabled={!reordering}
        showsVerticalScrollIndicator={false}
        onLayout={(e: LayoutChangeEvent) => setViewW(e.nativeEvent.layout.width)}
        contentContainerStyle={[styles.gridWrapTall, { gap: S(12) }]}
      >
        {tiles}
      </ScrollView>
    );
  } else if (twoRows) {
    const cols: React.ReactNode[][] = [];
    for (let i = 0; i < tiles.length; i += 2) cols.push(tiles.slice(i, i + 2));
    gridArea = (
      <>
        <ScrollView
          ref={scroll}
          horizontal
          scrollEnabled={!reordering}
          showsHorizontalScrollIndicator={false}
          onLayout={(e: LayoutChangeEvent) => setViewW(e.nativeEvent.layout.width)}
          onContentSizeChange={(w: number) => setContentW(w)}
          onScroll={onScroll}
          scrollEventThrottle={16}
        >
          <View style={styles.gridTwoRow}>
            {cols.map((col, ci) => <View key={ci} style={styles.twoRowCol}>{col}</View>)}
          </View>
        </ScrollView>
        {showBar ? (
          <View
            style={[styles.track, { backgroundColor: pal.meterEmpty }]}
            onLayout={(e: LayoutChangeEvent) => setTrackW(e.nativeEvent.layout.width)}
            {...pan.panHandlers}
          >
            <View style={[styles.thumb, { backgroundColor: pal.scrollThumb, width: thumbW, left: thumbL }]} />
          </View>
        ) : null}
      </>
    );
  } else {
    gridArea = (
      <>
        <ScrollView
          ref={scroll}
          horizontal
          scrollEnabled={!reordering}
          showsHorizontalScrollIndicator={false}
          onLayout={(e: LayoutChangeEvent) => setViewW(e.nativeEvent.layout.width)}
          onContentSizeChange={(w: number) => setContentW(w)}
          onScroll={onScroll}
          scrollEventThrottle={16}
          contentContainerStyle={styles.grid}
        >
          {tiles}
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
        style={({ pressed }) => [styles.nav, { width: Math.max(48, S(56)) }, { backgroundColor: pal.raised, borderColor: pal.border }, pressed && { opacity: 0.55 }]}
        accessibilityRole="button" accessibilityLabel="Scroll presets left"
      >
        <Text style={[styles.navText, { fontSize: S(30), color: pal.text }]}>‹</Text>
      </Pressable>
      ) : null}

      <View style={styles.gridWrap}>{presets.length === 0 ? empty : gridArea}</View>

      {/* › page-right (strip/two-row only) */}
      {showNav ? (
      <Pressable
        onPress={() => scroll.current?.scrollTo({ x: Math.min(maxScroll, scrollX + viewW * 0.8), animated: true })}
        style={({ pressed }) => [styles.nav, { width: Math.max(48, S(56)) }, { backgroundColor: pal.raised, borderColor: pal.border }, pressed && { opacity: 0.55 }]}
        accessibilityRole="button" accessibilityLabel="Scroll presets right"
      >
        <Text style={[styles.navText, { fontSize: S(30), color: pal.text }]}>›</Text>
      </Pressable>
      ) : null}

      {/* NEARBY disc — DONE while reordering. Hidden in the tall track, where it
          lives in the top bar instead. */}
      {!showNearby ? null : reordering ? (
        <Pressable
          onPress={onExitReorder}
          style={({ pressed }) => [styles.nearby, { width: S(92), height: S(92), borderRadius: S(46) }, { backgroundColor: pal.blue }, pressed && { opacity: 0.7 }]}
          accessibilityRole="button" accessibilityLabel="Done reordering"
        >
          <Text style={styles.doneCheck}>✓</Text>
          <Text style={styles.doneText}>DONE</Text>
        </Pressable>
      ) : (
        <Pressable
          onPress={onOpenNearby}
          style={({ pressed }) => [styles.nearby, { width: S(92), height: S(92), borderRadius: S(46) }, { backgroundColor: pal.nearbyDisc, borderWidth: 1, borderColor: pal.border }, pressed && { opacity: 0.7 }]}
          accessibilityRole="button" accessibilityLabel="Nearby stations"
        >
          <MagnifierTower size={S(64)} line={pal.nearbyLine} glass={pal.nearbyGlass} />
        </Pressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  band: { flexDirection: 'row', alignItems: 'stretch', gap: 10 },
  nav: { width: 56, borderRadius: 14, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  navText: { fontSize: 30, fontWeight: '700', fontFamily: FONT },
  gridWrap: { flex: 1 },
  grid: { gap: GAP, alignItems: 'stretch', paddingVertical: 2 },
  gridWrapTall: { flexDirection: 'row', flexWrap: 'wrap', gap: 12, alignContent: 'flex-start', paddingHorizontal: 4, paddingVertical: 3 },
  gridTwoRow: { flexDirection: 'row', gap: GAP, alignItems: 'flex-start', paddingVertical: 2 },
  twoRowCol: { gap: GAP },
  emptyWrap: {
    flex: 1, alignSelf: 'stretch', alignItems: 'center', justifyContent: 'center',
    borderWidth: 1.5, borderStyle: 'dashed', borderRadius: 16, paddingHorizontal: 14,
  },
  empty: { fontFamily: FONT, fontSize: 17, textAlign: 'center' },
  tile: {
    borderRadius: 16,
    alignItems: 'center', justifyContent: 'center', gap: 6, paddingHorizontal: 8,
  },
  // Picked-up tile: raised above its neighbours with a drop shadow (design §8).
  lifted: { zIndex: 30, elevation: 12, shadowColor: '#000', shadowOpacity: 0.35, shadowRadius: 20, shadowOffset: { width: 0, height: 18 } },
  tileName: { fontFamily: FONT_BOLD, textAlign: 'center' },
  activeBar: { position: 'absolute', bottom: 6, width: 26, height: 3, borderRadius: 2 },
  // §6.4 badge anatomy: 28×28, top corners at -9, 2px panel ring.
  logoEdit: {
    position: 'absolute', top: -9, left: -9, zIndex: 2,
    width: 28, height: 28, borderRadius: 14, borderWidth: 2,
    alignItems: 'center', justifyContent: 'center',
  },
  removeBadge: {
    position: 'absolute', top: -9, right: -9, zIndex: 2, borderWidth: 2,
    width: 28, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center',
  },
  removeText: { color: '#FFF', fontSize: 17, fontWeight: '700', lineHeight: 18 },
  track: { height: 6, borderRadius: 999, marginTop: 6, overflow: 'hidden' },
  thumb: { position: 'absolute', top: 0, bottom: 0, borderRadius: 999 },
  nearby: {
    width: 92, height: 92, borderRadius: 46, alignSelf: 'center',
    alignItems: 'center', justifyContent: 'center',
  },
  doneCheck: { color: '#FFF', fontSize: 26, fontWeight: '700' },
  doneText: { color: '#FFF', fontFamily: FONT_BOLD, fontSize: 13, letterSpacing: 1.5 },
});
