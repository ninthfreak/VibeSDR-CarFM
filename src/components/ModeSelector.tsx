import React from 'react';
import {
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { Colors } from '../constants/theme';
import { Mode, MODES } from '../services/ubersdrProtocol';

interface ModeSelectorProps {
  visible:    boolean;
  current:    Mode;
  onSelect:   (mode: Mode) => void;
  onClose:    () => void;
}

export default function ModeSelector({ visible, current, onSelect, onClose }: ModeSelectorProps) {
  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
    >
      <Pressable style={styles.backdrop} onPress={onClose} />
      <View style={styles.sheet}>
        <Text style={styles.sheetLabel}>DEMODULATOR</Text>
        <View style={styles.grid}>
          {MODES.map(m => (
            <TouchableOpacity
              key={m}
              style={[styles.btn, m === current && styles.btnActive]}
              onPress={() => { onSelect(m); onClose(); }}
            >
              <Text style={[styles.btnText, m === current && styles.btnTextActive]}>
                {m}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
        <TouchableOpacity style={styles.closeBtn} onPress={onClose}>
          <Text style={styles.closeBtnText}>CLOSE</Text>
        </TouchableOpacity>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
  },
  sheet: {
    backgroundColor: 'rgba(8,6,1,0.97)',
    borderTopWidth:  1,
    borderTopColor:  Colors.border,
    borderRadius:    14,
    padding:         16,
    paddingBottom:   40,
  },
  sheetLabel: {
    textAlign:     'center',
    color:         Colors.textDim,
    fontFamily:    'Courier',
    fontSize:      10,
    letterSpacing: 3,
    marginBottom:  14,
  },
  grid: {
    flexDirection:  'row',
    flexWrap:       'wrap',
    gap:            7,
  },
  btn: {
    flex:            1,
    minWidth:        '22%',
    backgroundColor: 'transparent',
    borderWidth:     1,
    borderColor:     'rgba(80,50,0,0.4)',
    borderRadius:    3,
    paddingVertical: 10,
    paddingHorizontal: 4,
    alignItems:      'center',
  },
  btnActive: {
    backgroundColor: 'rgba(20,10,0,0.8)',
    borderColor:     'rgba(160,90,0,0.6)',
  },
  btnText: {
    fontFamily:    'Courier',
    fontSize:      14,
    color:         Colors.textDim,
  },
  btnTextActive: {
    color:      Colors.amber,
    textShadowColor:  Colors.amberGlow,
    textShadowOffset: { width: 0, height: 0 },
    textShadowRadius: 5,
  },
  closeBtn: {
    marginTop:       14,
    alignSelf:       'center',
    borderWidth:     1,
    borderColor:     'rgba(80,50,0,0.38)',
    borderRadius:    3,
    paddingVertical: 7,
    paddingHorizontal: 24,
  },
  closeBtnText: {
    fontFamily:    'Courier',
    fontSize:      11,
    color:         Colors.textDim,
  },
});
