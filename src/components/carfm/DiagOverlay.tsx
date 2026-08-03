/**
 * DiagOverlay — the tail of the tuner log, on the radio face itself.
 *
 * The settings panel already shows the whole log, but reading it means leaving
 * the radio, and the events worth catching are the ones tied to something you
 * just did: pressing a wheel button, turning the headlights on, driving under a
 * bridge. This puts the last few lines where they can be seen while it happens.
 *
 * NOTABLE lines are drawn in amber. Right now that means a panel key the app has
 * no name for — key 14 turned up eight times in the drive log of 2026-08-03 and
 * nobody knows what it is, which is exactly the kind of thing that needs to be
 * visible at the moment of the press rather than found afterwards.
 *
 * Never interactive: `pointerEvents="none"` throughout, so it cannot take a
 * touch away from the controls underneath it.
 */

import React, { useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { diagLines, subscribeDiag } from '../../services/diag';
import type { CarFmPalette } from './tokens';

/** How many lines the strip shows. Enough for a wheel press plus the tune and
 *  RDS lines it causes, without covering the hero. */
const TAIL = 7;
/** Coalescing window. RDS can log about once a second and a burst of panel keys
 *  much faster; re-rendering per line would put avoidable work on the JS thread
 *  during exactly the animations we are trying to keep smooth. */
const REDRAW_MS = 250;

/** A diag line the user is likelier to be hunting for than the routine traffic.
 *  Kept deliberately short: everything here is something currently unexplained. */
function isNotable(line: string): boolean {
  // "panel key 14" with no parenthetical name — the dispatch table has no entry.
  if (/panel key \d+\s*$/.test(line)) return true;
  if (/\bILL\b/.test(line)) return true;              // headlights: rare and easy to miss
  if (/FAILED|failed|error|rejected|expired/.test(line)) return true;
  return false;
}

export default function DiagOverlay({ pal }: { pal: CarFmPalette }) {
  const [, tick] = useState(0);
  const pending = useRef(false);

  useEffect(() => subscribeDiag(() => {
    if (pending.current) return;
    pending.current = true;
    setTimeout(() => { pending.current = false; tick((n) => n + 1); }, REDRAW_MS);
  }), []);

  const all = diagLines();
  const tail = all.slice(Math.max(0, all.length - TAIL));
  if (!tail.length) return null;

  return (
    <View pointerEvents="none" style={styles.wrap}>
      <View style={[styles.card, { backgroundColor: pal.backdrop, borderColor: pal.border }]}>
        {tail.map((l, i) => (
          <Text
            key={`${all.length - tail.length + i}`}
            allowFontScaling={false}
            numberOfLines={1}
            style={[
              styles.line,
              { color: isNotable(l) ? pal.amber : pal.dim },
              // The newest line is the one being watched for; the rest fade back
              // so the strip reads as history rather than seven equal claims.
              i === tail.length - 1 && { color: isNotable(l) ? pal.amber : pal.text },
            ]}
          >
            {l}
          </Text>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: 'absolute',
    top: 0, left: 0, right: 0,
    alignItems: 'center',
    // Above the face, below nothing — the face has no overlays of its own here.
    zIndex: 50,
  },
  card: {
    maxWidth: 720,
    alignSelf: 'center',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderBottomLeftRadius: 10,
    borderBottomRightRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderTopWidth: 0,
    opacity: 0.92,
  },
  line: {
    fontSize: 11,
    lineHeight: 14,
    // Digits must not shift as the clock ticks; the bundled face is proportional,
    // so ask for tabular figures rather than a monospace family we do not ship.
    fontVariant: ['tabular-nums'],
  },
});
