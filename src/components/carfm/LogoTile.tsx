/**
 * Station brand tile: the real logo from the stations DB when we have one,
 * else a colored monogram (design: "colored monogram tiles… real brand art
 * would replace these later"). Lookup is lazy and cached per callsign base.
 *
 * When `interactive` is set (the live tuned tile only — never presets), a tile
 * that has NO logo yet becomes tappable: one tap runs an explicit DuckDuckGo
 * logo search (freq + callsign) and, on a hit, swaps the monogram for the art.
 * Background auto-resolution stays off (logoResolver.AUTO_LOGO_RESOLUTION), so
 * this tap is the only thing that fetches a logo — see the resolver notes.
 */
import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Image, Pressable, Text, View } from 'react-native';

import { getStationLogo, enrichNow } from '../../services/stationFinder';
import { callsignBase } from '../../services/piCallsign';
import { brandColor, monogram, FONT_BOLD } from './tokens';

const cache = new Map<string, string | null>();

/** Extract a plausible callsign base ("WJJO-FM" / "94.1 WJJO" → "WJJO"). */
export function callsignFrom(name?: string): string | null {
  if (!name) return null;
  const m = name.toUpperCase().match(/\b([KW][A-Z]{2,3})(?:-FM)?\b/);
  return m ? m[1] : null;
}

export default function LogoTile({ name, size, radius, interactive, freqMhz }: {
  name?: string;          // station name / callsign-ish string
  size: number;
  radius?: number;
  interactive?: boolean;  // live tuned tile: tap a logoless tile to search for it
  freqMhz?: number;       // dial frequency — part of the DuckDuckGo query
}) {
  const base = callsignFrom(name) ? callsignBase(callsignFrom(name)!) : null;
  const [uri, setUri] = useState<string | null>(base ? cache.get(base) ?? null : null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (!base) { setUri(null); return; }
    if (cache.has(base)) { setUri(cache.get(base)!); return; }
    getStationLogo(base)
      .then((u) => { cache.set(base, u); if (!cancelled) setUri(u); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [base]);

  const r = radius ?? Math.round(size * 0.22);
  const label = base ? monogram(base) : (name?.trim().slice(0, 4).toUpperCase() || '·');

  if (uri) {
    return <Image source={{ uri }} style={{ width: size, height: size, borderRadius: r }} resizeMode="cover" />;
  }

  const tile = (
    <View style={{
      width: size, height: size, borderRadius: r,
      backgroundColor: brandColor(base ?? label),
      alignItems: 'center', justifyContent: 'center',
    }}>
      {busy ? (
        <ActivityIndicator color="#FFFFFF" />
      ) : (
        <Text
          allowFontScaling={false}
          numberOfLines={1}
          style={{
            color: '#FFFFFF', fontFamily: FONT_BOLD,
            fontSize: Math.round(size * (label.length > 3 ? 0.26 : 0.34)),
          }}
        >
          {label}
        </Text>
      )}
    </View>
  );

  // A tuned station with a real callsign can be searched on demand.
  const canSearch = interactive && !!base && !busy;
  if (!canSearch) return tile;

  const onSearch = async () => {
    setBusy(true);
    try {
      const ok = await enrichNow(base!, { callsign: base!, freqMhz });
      if (ok) {
        cache.delete(base!);
        const u = await getStationLogo(base!);
        cache.set(base!, u);
        setUri(u);
      }
    } catch {
      /* leave the monogram; user can tap again */
    } finally {
      setBusy(false);
    }
  };

  return (
    <Pressable
      onPress={onSearch}
      accessibilityRole="button"
      accessibilityLabel={`Find logo for ${base}`}
      accessibilityHint="Searches the web for this station's logo"
      style={({ pressed }) => (pressed ? { opacity: 0.55 } : null)}
    >
      {tile}
    </Pressable>
  );
}
