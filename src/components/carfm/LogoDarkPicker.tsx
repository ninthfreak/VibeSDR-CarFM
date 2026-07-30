/**
 * Dark-mode logo treatment picker — the handoff's priority #2 ("build the picker
 * before more algorithm work"). At logo import it renders the pipeline's
 * candidate treatments as thumbnails ON THE ACTUAL DARK BACKGROUND, defaults to
 * the auto-pick, and lets the user tap a different one. A human glance caught
 * five errors the metric scored as successes across five logos, so the pick is a
 * default, never a verdict.
 *
 * It runs the pipeline itself (processLogoForDark) and, on Save, persists the
 * chosen variant via saveDarkLogo — chosen=true only when the user overrode the
 * auto-pick, so we can both keep their choice across reprocessing AND log the
 * override rate as telemetry.
 */
import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Image, Modal, Pressable, Text, View } from 'react-native';

import { processLogoForDark, hexToUnitRgb, treatmentToEnum, type ProcessResult, type EncodedCandidate } from '../../services/logoDark/adapt';
import { putDark } from '../../services/logoStore';
import { prepareDarkLadder } from '../../services/logoPrep';
import { invalidateLogoTile } from './LogoTile';
import { FONT_BOLD, type CarFmPalette } from './tokens';

const LABELS: Record<string, string> = { remap: 'Recolor', halo: 'Glow', 'as-is': 'As-is', plate: 'Plate' };

export default function LogoDarkPicker({ visible, base, logoUri, darkBg, pal, onClose }: {
  visible: boolean;
  base: string | null;
  logoUri: string | null;   // the just-assigned (light) logo, raw data URI
  darkBg: string;           // the dark surface hex the variants composite onto
  pal: CarFmPalette;
  onClose: () => void;
}) {
  const [result, setResult] = useState<ProcessResult | null>(null);
  const [sel, setSel] = useState<string | null>(null);   // selected treatment key
  const [busy, setBusy] = useState(false);

  // Run the pipeline whenever the picker opens for a logo.
  useEffect(() => {
    let cancelled = false;
    setResult(null); setSel(null);
    if (!visible || !logoUri || !base) return;
    processLogoForDark(logoUri, hexToUnitRgb(darkBg)).then((r) => {
      if (cancelled || !r) { if (!cancelled) onClose(); return; }   // undecodable → skip silently
      setResult(r); setSel(r.pick);
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, logoUri, base, darkBg]);

  const save = async () => {
    if (!result || !sel || !base || busy) return;
    const cand = result.candidates.find((c) => c.treatment === sel);
    if (!cand) return;
    setBusy(true);
    try {
      await putDark(base, treatmentToEnum(cand.treatment), cand.pngBase64, sel !== result.pick);
      await prepareDarkLadder(base);
      invalidateLogoTile(base);
    } finally {
      setBusy(false);
      onClose();
    }
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
        <View style={{ width: '100%', maxWidth: 560, borderRadius: 20, backgroundColor: pal.bg, padding: 22 }}>
          <Text style={{ fontFamily: FONT_BOLD, fontSize: 22, color: pal.text }}>Dark-mode logo</Text>
          <Text style={{ marginTop: 4, fontSize: 14, color: pal.dim }}>
            Pick how this logo looks on the dark theme. The suggested option is marked “Auto”.
          </Text>

          {!result ? (
            <View style={{ height: 160, alignItems: 'center', justifyContent: 'center' }}>
              <ActivityIndicator color={pal.blue} />
              <Text style={{ marginTop: 10, color: pal.dim }}>Adapting…</Text>
            </View>
          ) : (
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 12, marginTop: 16 }}>
              {result.candidates.map((c) => (
                <CandidateCard
                  key={c.treatment}
                  cand={c}
                  darkBg={darkBg}
                  selected={sel === c.treatment}
                  isAuto={c.treatment === result.pick}
                  pal={pal}
                  onPress={() => setSel(c.treatment)}
                />
              ))}
            </View>
          )}

          <View style={{ flexDirection: 'row', gap: 12, marginTop: 22 }}>
            <Pressable
              onPress={onClose}
              style={({ pressed }) => [{ flex: 1, height: 48, borderRadius: 12, borderWidth: 1, borderColor: pal.border, alignItems: 'center', justifyContent: 'center' }, pressed && { opacity: 0.6 }]}
              accessibilityRole="button" accessibilityLabel="Skip"
            >
              <Text style={{ color: pal.dim, fontFamily: FONT_BOLD, fontSize: 16 }}>Skip</Text>
            </Pressable>
            <Pressable
              onPress={save}
              disabled={!result || busy}
              style={({ pressed }) => [{ flex: 2, height: 48, borderRadius: 12, backgroundColor: pal.blue, alignItems: 'center', justifyContent: 'center', opacity: !result || busy ? 0.5 : 1 }, pressed && { opacity: 0.75 }]}
              accessibilityRole="button" accessibilityLabel="Use this treatment"
            >
              <Text style={{ color: '#FFFFFF', fontFamily: FONT_BOLD, fontSize: 16 }}>Use this</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

function CandidateCard({ cand, darkBg, selected, isAuto, pal, onPress }: {
  cand: EncodedCandidate; darkBg: string; selected: boolean; isAuto: boolean; pal: CarFmPalette; onPress: () => void;
}) {
  const isPlate = cand.treatment === 'plate';
  const uri = `data:image/png;base64,${cand.pngBase64}`;
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [{ width: 150, borderRadius: 14, borderWidth: 2, borderColor: selected ? pal.blue : pal.border, overflow: 'hidden' }, pressed && { opacity: 0.85 }]}
      accessibilityRole="button" accessibilityState={{ selected }} accessibilityLabel={`${LABELS[cand.treatment]}${isAuto ? ', suggested' : ''}`}
    >
      {/* The swatch IS the real dark background the logo will sit on. */}
      <View style={{ height: 96, backgroundColor: darkBg, alignItems: 'center', justifyContent: 'center', padding: isPlate ? 0 : 12 }}>
        {isPlate ? (
          <View style={{ width: '78%', height: '78%', borderRadius: 12, backgroundColor: '#E6E6E6', padding: 8, alignItems: 'center', justifyContent: 'center' }}>
            <Image source={{ uri }} style={{ width: '100%', height: '100%' }} resizeMode="contain" />
          </View>
        ) : (
          <Image source={{ uri }} style={{ width: '100%', height: '100%' }} resizeMode="contain" />
        )}
      </View>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: 8, backgroundColor: pal.raised }}>
        <Text style={{ color: pal.text, fontFamily: FONT_BOLD, fontSize: 14 }}>{LABELS[cand.treatment] ?? cand.treatment}</Text>
        {isAuto ? <Text style={{ color: pal.blue, fontSize: 11, fontFamily: FONT_BOLD }}>AUTO</Text> : null}
      </View>
    </Pressable>
  );
}
