import React, { useEffect, useRef, useState } from 'react';
import {
  Keyboard,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { Colors } from '../constants/theme';
import { MAX_FREQ_HZ, MIN_FREQ_HZ } from '../services/ubersdrProtocol';

type Unit = 'hz' | 'khz' | 'mhz';

interface FreqModalProps {
  visible:   boolean;
  currentHz: number;
  onConfirm: (hz: number) => void;
  onClose:   () => void;
}

function toDisplay(hz: number, unit: Unit): string {
  if (unit === 'hz')  return Math.round(hz).toString();
  if (unit === 'khz') return (hz / 1000).toFixed(3);
  return (hz / 1e6).toFixed(6);
}

function fromDisplay(val: string, unit: Unit): number {
  const n = parseFloat(val.replace(/[^0-9.]/g, ''));
  if (isNaN(n) || n <= 0) return 0;
  if (unit === 'hz')  return Math.round(n);
  if (unit === 'khz') return Math.round(n * 1000);
  return Math.round(n * 1e6);
}

export default function FreqModal({ visible, currentHz, onConfirm, onClose }: FreqModalProps) {
  const [unit, setUnit]   = useState<Unit>('khz');
  const [value, setValue] = useState('');
  const inputRef          = useRef<TextInput>(null);

  useEffect(() => {
    if (visible) {
      setValue(toDisplay(currentHz, unit));
      setTimeout(() => { inputRef.current?.focus(); }, 80);
    }
  }, [visible, currentHz, unit]);

  const switchUnit = (u: Unit) => {
    const hz = fromDisplay(value, unit);
    setUnit(u);
    if (hz > 0) setValue(toDisplay(hz, u));
  };

  const confirm = () => {
    const hz = fromDisplay(value, unit);
    if (hz >= MIN_FREQ_HZ && hz <= MAX_FREQ_HZ) {
      onConfirm(hz);
      onClose();
    }
    Keyboard.dismiss();
  };

  const unitLabel = unit === 'hz' ? 'Hz' : unit === 'khz' ? 'kHz' : 'MHz';

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose} />
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={styles.center}
        pointerEvents="box-none"
      >
        <View style={styles.modal}>
          <Text style={styles.title}>FREQUENCY</Text>
          <View style={styles.inputRow}>
            <TextInput
              ref={inputRef}
              style={styles.input}
              value={value}
              onChangeText={setValue}
              keyboardType="decimal-pad"
              autoComplete="off"
              autoCorrect={false}
              selectTextOnFocus
              onSubmitEditing={confirm}
              returnKeyType="done"
            />
            <Text style={styles.unitLabel}>{unitLabel}</Text>
          </View>
          <View style={styles.units}>
            {(['hz', 'khz', 'mhz'] as Unit[]).map(u => (
              <TouchableOpacity
                key={u}
                style={[styles.unitBtn, unit === u && styles.unitBtnActive]}
                onPress={() => switchUnit(u)}
              >
                <Text style={[styles.unitBtnText, unit === u && styles.unitBtnTextActive]}>
                  {u === 'hz' ? 'Hz' : u === 'khz' ? 'kHz' : 'MHz'}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
          <View style={styles.actions}>
            <TouchableOpacity style={styles.cancelBtn} onPress={onClose}>
              <Text style={styles.cancelText}>CANCEL</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.tuneBtn} onPress={confirm}>
              <Text style={styles.tuneText}>TUNE ▶</Text>
            </TouchableOpacity>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    ...StyleSheet.absoluteFill,
    backgroundColor: 'rgba(0,0,0,0.58)',
  },
  center: {
    ...StyleSheet.absoluteFill,
    justifyContent: 'flex-start',
    alignItems:     'center',
    paddingTop:     44,
  },
  modal: {
    backgroundColor: 'rgba(8,6,1,0.97)',
    borderWidth:     1,
    borderColor:     'rgba(255,160,0,0.38)',
    borderRadius:    12,
    padding:         20,
    width:           '90%',
    maxWidth:        360,
  },
  title: {
    textAlign:     'center',
    fontFamily:    'Courier',
    fontSize:      10,
    letterSpacing: 3,
    color:         Colors.textDim,
    marginBottom:  14,
  },
  inputRow: {
    flexDirection:   'row',
    alignItems:      'flex-end',
    gap:             6,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255,160,0,0.30)',
    paddingBottom:   6,
    marginBottom:    8,
  },
  input: {
    flex:           1,
    fontFamily:     'Courier',
    fontSize:       32,
    letterSpacing:  3,
    color:          Colors.amber,
    padding:        4,
    backgroundColor: 'transparent',
  },
  unitLabel: {
    fontFamily:    'Courier',
    fontSize:      11,
    letterSpacing: 2,
    color:         Colors.goldDim,
    paddingBottom: 6,
  },
  units: {
    flexDirection:  'row',
    gap:            6,
    marginBottom:   16,
  },
  unitBtn: {
    flex:            1,
    borderWidth:     1,
    borderColor:     'rgba(80,50,0,0.4)',
    borderRadius:    3,
    paddingVertical: 6,
    alignItems:      'center',
    backgroundColor: 'transparent',
  },
  unitBtnActive: {
    backgroundColor: 'rgba(20,10,0,0.8)',
    borderColor:     'rgba(160,90,0,0.6)',
  },
  unitBtnText: {
    fontFamily: 'Courier',
    fontSize:   11,
    color:      Colors.textDim,
  },
  unitBtnTextActive: {
    color: Colors.amber,
  },
  actions: {
    flexDirection: 'row',
    gap:           10,
  },
  cancelBtn: {
    flex:            1,
    borderWidth:     1,
    borderColor:     'rgba(80,50,0,0.4)',
    borderRadius:    3,
    paddingVertical: 10,
    alignItems:      'center',
  },
  cancelText: {
    fontFamily: 'Courier',
    fontSize:   12,
    color:      Colors.textDim,
  },
  tuneBtn: {
    flex:            2,
    backgroundColor: 'rgba(20,10,0,0.8)',
    borderWidth:     1,
    borderColor:     Colors.borderBright,
    borderRadius:    3,
    paddingVertical: 10,
    alignItems:      'center',
  },
  tuneText: {
    fontFamily: 'Courier',
    fontSize:   12,
    color:      Colors.amber,
    fontWeight: 'bold',
  },
});
