import React, { useState } from 'react';
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';

interface Props {
  visible:    boolean;
  serverUrl:  string;
  onSubmit:   (password: string) => void;
  onCancel:   () => void;
}

export default function PasswordModal({ visible, serverUrl, onSubmit, onCancel }: Props) {
  const [pw, setPw] = useState('');

  const submit = () => {
    const val = pw.trim();
    setPw('');
    onSubmit(val);
  };

  const cancel = () => {
    setPw('');
    onCancel();
  };

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={cancel}
    >
      <KeyboardAvoidingView
        style={styles.overlay}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        <View style={styles.box}>
          <Text style={styles.title}>Password Required</Text>
          <Text style={styles.sub} numberOfLines={2}>{serverUrl}</Text>
          <TextInput
            style={styles.input}
            placeholder="Enter password"
            placeholderTextColor="rgba(200,137,58,0.45)"
            value={pw}
            onChangeText={setPw}
            secureTextEntry
            autoFocus
            returnKeyType="go"
            onSubmitEditing={submit}
          />
          <View style={styles.row}>
            <TouchableOpacity style={styles.btn} onPress={cancel}>
              <Text style={styles.btnTxtCancel}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[styles.btn, styles.btnPrimary]} onPress={submit}>
              <Text style={styles.btnTxtPrimary}>Connect</Text>
            </TouchableOpacity>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay:     { flex: 1, backgroundColor: 'rgba(0,0,0,0.75)', justifyContent: 'center', padding: 24 },
  box:         { backgroundColor: '#0A0804', borderRadius: 10, borderWidth: 1, borderColor: 'rgba(255,160,0,0.40)', padding: 20, gap: 14 },
  title:       { fontFamily: 'Courier', fontSize: 16, fontWeight: 'bold', color: '#FFB833', letterSpacing: 1 },
  sub:         { fontFamily: 'Courier', fontSize: 11, color: 'rgba(200,137,58,0.70)' },
  input:       { height: 44, backgroundColor: 'rgba(20,10,0,0.80)', borderWidth: 1, borderColor: 'rgba(255,160,0,0.35)', borderRadius: 6, paddingHorizontal: 12, fontFamily: 'Courier', fontSize: 14, color: '#FFB833' },
  row:         { flexDirection: 'row', gap: 10, justifyContent: 'flex-end' },
  btn:         { paddingHorizontal: 18, paddingVertical: 10, borderRadius: 6, borderWidth: 1, borderColor: 'rgba(255,160,0,0.30)' },
  btnPrimary:  { borderColor: 'rgba(255,160,0,0.60)', backgroundColor: 'rgba(255,160,0,0.12)' },
  btnTxtCancel:  { fontFamily: 'Courier', fontSize: 13, color: 'rgba(200,137,58,0.70)' },
  btnTxtPrimary: { fontFamily: 'Courier', fontSize: 13, color: '#FFB833', fontWeight: 'bold' },
});
