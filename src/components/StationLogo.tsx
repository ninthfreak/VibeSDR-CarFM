import React, { useEffect, useState } from 'react';
import { Image, StyleSheet } from 'react-native';
import { resolveStationLogo } from '../services/stationLogoCache';
import { ituToIso } from '../services/rdsCountry';

/**
 * A station's logo, resolved lazily and cached.
 *
 * Renders nothing at all when there is no logo — a placeholder in a long list of
 * shortwave stations is just noise, and most of them will never have one.
 *
 * `itu` is EiBi's transmitter-country code and is AUTHORITATIVE: the schedule states
 * the country outright, so it is passed as a hard country filter rather than as the
 * receiver's country used as a mere preference. That makes an EiBi row's logo strictly
 * more trustworthy than one resolved from RDS, where the country often has to be
 * inferred from the PI nibble.
 */
export default function StationLogo({ name, itu, size = 18 }: {
  name?: string;
  itu?: string;
  size?: number;
}) {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setUrl(null);
    const n = name?.trim();
    if (!n) return;
    const iso = itu ? ituToIso(itu) : '';
    resolveStationLogo({ name: n, iso: iso || undefined })
      .then((u) => { if (!cancelled) setUrl(u); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [name, itu]);

  if (!url) return null;
  return (
    <Image
      source={{ uri: url }}
      style={[styles.logo, { width: size, height: size }]}
      resizeMode="contain"
    />
  );
}

const styles = StyleSheet.create({
  logo: {
    borderRadius: 3,
    marginRight: 6,
    backgroundColor: 'rgba(255,255,255,0.9)',
  },
});
