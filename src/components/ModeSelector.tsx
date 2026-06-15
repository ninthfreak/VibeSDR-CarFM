import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Modal, Pressable, ScrollView, StyleSheet, Text, TouchableOpacity, View,
} from 'react-native';
import { Mode, MODES } from '../services/sdrTypes';
import { useTheme } from '../contexts/ThemeContext';
import GainSlider from './GainSlider';

// Common analog/voice demodulators shown as buttons; everything else the server
// offers (digital, decoders, sondes…) goes into the in-popup dropdown.
const COMMON_IDS = ['nfm', 'fm', 'wfm', 'am', 'sam', 'lsb', 'usb', 'cw', 'cwu', 'cwl', 'data'];
const DEC_COL = '#52dc64';   // active-decoder accent (matches VTS live-data green)

interface ModeSelectorProps {
  visible:  boolean;
  current:  Mode;
  /** Gated demodulator list (OWRX reports its own, incl. WFM/digital). When
   *  absent, the default UberSDR MODES are shown. */
  modes?:   { id: string; label: string }[];
  /** OWRX secondary decoder running on top of the carrier (e.g. 'sstv'/'fax').
   *  Highlighted separately so the carrier demod (`current`) stays lit too. */
  activeDecoder?: string;
  onSelect: (mode: Mode) => void;
  onClose:  () => void;
  /** V4 local hardware: quick-access RTL-SDR gain control shown above the modes. */
  gainControl?: {
    gains: number[]; gainTenthDb: number; auto: boolean;
    onAuto: (auto: boolean) => void; onGain: (tenthDb: number) => void;
  };
}

export default function ModeSelector({ visible, current, modes, activeDecoder, onSelect, onClose, gainControl }: ModeSelectorProps) {
  const { theme: t } = useTheme();
  const isWhite = t.name === 'white';
  const [moreOpen, setMoreOpen] = useState(false);
  // Collapse the decoder dropdown when the sheet closes, so reopening it lands on
  // the current decoder (the scroll-to-active effect only fires on open) instead
  // of staying open scrolled to the top.
  useEffect(() => { if (!visible) setMoreOpen(false); }, [visible]);

  const list = modes && modes.length ? modes : MODES.map(m => ({ id: m, label: m.toUpperCase() }));
  const common = list.filter(m => COMMON_IDS.includes(m.id.toLowerCase()));
  // Decoder/digital list — OWRX reports these in server-add order (no order at
  // all), so sort alphabetically by label to make the long list scannable.
  const others = useMemo(
    () => list.filter(m => !COMMON_IDS.includes(m.id.toLowerCase()))
              .sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: 'base' })),
    [list],
  );
  const currentInOthers = others.find(m => m.id === current);
  const activeDecInOthers = activeDecoder ? others.find(m => m.id === activeDecoder) : undefined;
  // The carrier label for the "Decoding X over Y" caption (e.g. USB).
  const carrierLabel = (common.find(m => m.id === current) ?? list.find(m => m.id === current))?.label.toUpperCase() ?? String(current).toUpperCase();

  // Remember the spot: when the dropdown opens, jump to the active decoder so
  // the user lands where they were instead of scrolling a long list.
  const moreScroll = useRef<ScrollView | null>(null);
  const itemY = useRef<Record<string, number>>({});
  useEffect(() => {
    if (!moreOpen) return;
    const target = activeDecInOthers ?? currentInOthers;   // active decoder, else current mode
    if (!target) return;
    // Read the captured y INSIDE the delay so onLayout has populated it first.
    const id = setTimeout(() => {
      const y = itemY.current[target.id];
      if (y != null) moreScroll.current?.scrollTo({ y: Math.max(0, y - 8), animated: false });
    }, 60);
    return () => clearTimeout(id);
  }, [moreOpen, currentInOthers, activeDecInOthers]);

  const pick = (id: string) => { onSelect(id as Mode); onClose(); };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}
           supportedOrientations={['portrait', 'landscape', 'landscape-left', 'landscape-right']}>
      <Pressable style={st.backdrop} onPress={onClose} />
      <View style={[st.sheet, { borderTopColor: t.barBorder }]}>
        <Text style={[st.sheetLabel, { color: t.sectionColor, fontFamily: t.font }]}>
          DEMODULATOR
        </Text>
        {gainControl ? (
          <View style={st.gainWrap}>
            <GainSlider
              gains={gainControl.gains}
              gainTenthDb={gainControl.gainTenthDb}
              auto={gainControl.auto}
              onAuto={gainControl.onAuto}
              onGain={gainControl.onGain}
            />
          </View>
        ) : null}
        <View style={st.grid}>
          {common.map(m => (
            <TouchableOpacity
              key={m.id}
              style={[
                st.btn,
                { borderColor: isWhite ? 'rgba(255,255,255,0.20)' : 'rgba(80,50,0,0.40)',
                  paddingVertical: isWhite ? 12 : 10 },
                m.id === current && { backgroundColor: t.btnActiveBg, borderColor: t.btnActiveBdr },
              ]}
              onPress={() => pick(m.id)}
            >
              <Text style={[
                st.btnText,
                { fontFamily: t.font, fontSize: isWhite ? 15 : 14,
                  color: isWhite ? 'rgba(255,255,255,0.55)' : 'rgba(150,100,30,0.70)' },
                m.id === current && { color: t.btnActiveText },
              ]}>
                {m.label.toUpperCase()}
              </Text>
            </TouchableOpacity>
          ))}
        </View>

        {/* Combo dropdown: all the digital / decoder modes the server offers */}
        {others.length > 0 && (
          <View style={st.moreWrap}>
            <TouchableOpacity
              style={[st.moreHead, { borderColor: t.btnBorder },
                      currentInOthers && { borderColor: t.btnActiveBdr, backgroundColor: t.btnActiveBg },
                      activeDecInOthers && { borderColor: DEC_COL, backgroundColor: 'rgba(80,220,100,0.14)' }]}
              onPress={() => setMoreOpen(o => !o)}
              activeOpacity={0.8}>
              <Text style={[st.moreHeadText, { fontFamily: t.font },
                            { color: activeDecInOthers ? DEC_COL : currentInOthers ? t.btnActiveText : t.btnText }]} numberOfLines={1}>
                {activeDecInOthers ? activeDecInOthers.label.toUpperCase()
                  : currentInOthers ? currentInOthers.label.toUpperCase()
                  : `DIGITAL / DECODERS (${others.length})`}
              </Text>
              <Text style={[st.moreChevron, { color: t.btnText }]}>{moreOpen ? '▴' : '▾'}</Text>
            </TouchableOpacity>
            {moreOpen && (
              <ScrollView ref={moreScroll} style={[st.moreList, { borderColor: t.btnBorder }]} keyboardShouldPersistTaps="handled">
                {others.map(m => (
                  <TouchableOpacity
                    key={m.id}
                    style={[st.moreItem, { borderBottomColor: t.barBorder }]}
                    onPress={() => pick(m.id)}
                    onLayout={e => { itemY.current[m.id] = e.nativeEvent.layout.y; }}
                    activeOpacity={0.7}>
                    <Text style={[st.moreItemText, { fontFamily: t.font },
                                  { color: m.id === activeDecoder ? DEC_COL : m.id === current ? t.btnActiveText : t.btnText }]}>
                      {m.id === activeDecoder || m.id === current ? '✓ ' : ''}{m.label.toUpperCase()}
                    </Text>
                  </TouchableOpacity>
                ))}
              </ScrollView>
            )}
            {/* Advisory only for decoders that ride on a carrier (RTTY/WEFAX/SSTV
                etc., where the decoder id differs from the current demod). OWRX
                decodes whatever sideband you're on — we don't force it. Standalone
                decoders (ADSB/POCSAG, where current === the decoder) need nothing. */}
            {!!activeDecInOthers && activeDecoder !== current && (
              <Text style={[st.decCaption, { fontFamily: t.font }]}>
                ⚠ {activeDecInOthers.label.toUpperCase()} decodes your demodulator's audio — set the correct sideband (USB/LSB) above before using it.
              </Text>
            )}
          </View>
        )}

        <TouchableOpacity
          style={[st.closeBtn, { borderColor: t.btnBorder }]}
          onPress={onClose}
        >
          <Text style={[st.closeBtnText, { fontFamily: t.font, color: t.btnText }]}>CLOSE</Text>
        </TouchableOpacity>
      </View>
    </Modal>
  );
}

const st = StyleSheet.create({
  backdrop:     { flex: 1, backgroundColor: 'rgba(0,0,0,0.50)' },
  sheet: {
    backgroundColor: 'rgba(8,6,1,0.97)',
    borderTopWidth: 1, borderRadius: 14,
    padding: 16, paddingBottom: 40,
  },
  sheetLabel:   { textAlign: 'center', fontSize: 10, letterSpacing: 3, marginBottom: 14 },
  grid:         { flexDirection: 'row', flexWrap: 'wrap', gap: 7 },
  gainWrap:     { marginBottom: 12, paddingBottom: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: 'rgba(255,255,255,0.15)' },
  btn: {
    flex: 1, minWidth: '22%', backgroundColor: 'transparent',
    borderWidth: 1, borderRadius: 3, paddingHorizontal: 4, alignItems: 'center',
  },
  btnText:      { textAlign: 'center' },
  moreWrap:     { marginTop: 12 },
  moreHead: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    borderWidth: 1, borderRadius: 3, paddingVertical: 10, paddingHorizontal: 12,
  },
  moreHeadText: { fontSize: 13, flex: 1 },
  moreChevron:  { fontSize: 13, marginLeft: 8 },
  moreList:     { marginTop: 4, maxHeight: 260, borderWidth: 1, borderRadius: 3 },
  moreItem:     { paddingVertical: 11, paddingHorizontal: 12, borderBottomWidth: StyleSheet.hairlineWidth },
  moreItemText: { fontSize: 14 },
  decCaption:   { color: DEC_COL, fontSize: 11, marginTop: 7, opacity: 0.85, lineHeight: 15 },
  closeBtn: {
    marginTop: 14, alignSelf: 'center', borderWidth: 1,
    borderRadius: 3, paddingVertical: 7, paddingHorizontal: 24,
  },
  closeBtnText: { fontSize: 11 },
});
