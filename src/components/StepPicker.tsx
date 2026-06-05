import React from 'react';
import { Modal, Pressable, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Colors } from '../constants/theme';
import { STEPS_HZ } from '../services/ubersdrProtocol';

function stepLabel(hz: number): string {
  if (hz >= 1000) return (hz / 1000) + ' kHz';
  return hz + ' Hz';
}

interface StepPickerProps {
  visible:     boolean;
  currentStep: number;
  onSelect:    (hz: number) => void;
  onClose:     () => void;
}

export default function StepPicker({ visible, currentStep, onSelect, onClose }: StepPickerProps) {
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose} />
      <View style={styles.picker} pointerEvents="box-none">
        {STEPS_HZ.map(hz => (
          <TouchableOpacity
            key={hz}
            style={[styles.item, hz === currentStep && styles.itemActive]}
            onPress={() => { onSelect(hz); onClose(); }}
          >
            <Text style={[styles.itemText, hz === currentStep && styles.itemTextActive]}>
              {stepLabel(hz)}
            </Text>
          </TouchableOpacity>
        ))}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    ...StyleSheet.absoluteFill,
    backgroundColor: 'rgba(0,0,0,0.4)',
  },
  picker: {
    position:    'absolute',
    bottom:      160,
    left:        20,
    backgroundColor: 'rgba(0,0,0,0.92)',
    borderWidth:  1,
    borderColor:  'rgba(255,160,0,0.25)',
    borderRadius: 8,
    padding:      5,
    gap:          3,
  },
  item: {
    backgroundColor: 'transparent',
    borderWidth:     1,
    borderColor:     'rgba(80,50,0,0.4)',
    borderRadius:    4,
    paddingVertical: 6,
    paddingHorizontal: 12,
  },
  itemActive: {
    backgroundColor: 'rgba(20,10,0,0.9)',
    borderColor:     'rgba(160,90,0,0.65)',
  },
  itemText: {
    fontFamily:    'Courier',
    fontSize:      11,
    color:         'rgba(150,100,30,0.85)',
    letterSpacing: 0.5,
    textAlign:     'center',
  },
  itemTextActive: {
    color: Colors.amber,
  },
});
