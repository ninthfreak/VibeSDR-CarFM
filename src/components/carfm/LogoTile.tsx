/**
 * Station brand tile: the real logo from the stations DB when we have one,
 * else a colored monogram (design: "colored monogram tiles… real brand art
 * would replace these later"). Lookup is lazy and cached per callsign base.
 */
import React, { useEffect, useState } from 'react';
import { Image, Text, View } from 'react-native';

import { getStationLogo } from '../../services/stationFinder';
import { callsignBase } from '../../services/piCallsign';
import { brandColor, monogram, FONT_BOLD } from './tokens';

const cache = new Map<string, string | null>();

/** Extract a plausible callsign base ("WJJO-FM" / "94.1 WJJO" → "WJJO"). */
export function callsignFrom(name?: string): string | null {
  if (!name) return null;
  const m = name.toUpperCase().match(/\b([KW][A-Z]{2,3})(?:-FM)?\b/);
  return m ? m[1] : null;
}

export default function LogoTile({ name, size, radius }: {
  name?: string;          // station name / callsign-ish string
  size: number;
  radius?: number;
}) {
  const base = callsignFrom(name) ? callsignBase(callsignFrom(name)!) : null;
  const [uri, setUri] = useState<string | null>(base ? cache.get(base) ?? null : null);

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
  return (
    <View style={{
      width: size, height: size, borderRadius: r,
      backgroundColor: brandColor(base ?? label),
      alignItems: 'center', justifyContent: 'center',
    }}>
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
    </View>
  );
}
