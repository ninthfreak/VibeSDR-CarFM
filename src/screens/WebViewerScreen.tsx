import React, { useRef } from 'react';
import { StyleSheet, TouchableOpacity, Text, View, StatusBar } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { WebView } from 'react-native-webview';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { RootStackParamList } from '../../App';

type Props = NativeStackScreenProps<RootStackParamList, 'WebViewer'>;

export default function WebViewerScreen({ route, navigation }: Props) {
  const { url, title } = route.params;
  const insets = useSafeAreaInsets();
  const wvRef  = useRef<WebView>(null);

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      <StatusBar barStyle="light-content" backgroundColor="#000000" />

      <WebView
        ref={wvRef}
        source={{ uri: url }}
        style={styles.webview}
        scalesPageToFit
        javaScriptEnabled
        domStorageEnabled
        mixedContentMode="always"
        scrollEnabled
        bounces={false}
      />

      {/* Floating back button */}
      <TouchableOpacity
        style={[styles.backBtn, { top: insets.top + 10 }]}
        onPress={() => navigation.goBack()}
        activeOpacity={0.8}
      >
        <Text style={styles.backTxt}>‹ SDR</Text>
      </TouchableOpacity>

      {/* Page title chip */}
      {title ? (
        <View style={[styles.titleChip, { top: insets.top + 10 }]}>
          <Text style={styles.titleTxt} numberOfLines={1}>{title}</Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root:    { flex: 1, backgroundColor: '#000' },
  webview: { flex: 1 },

  backBtn: {
    position: 'absolute', left: 12,
    backgroundColor: 'rgba(10,8,2,0.88)',
    borderWidth: 1, borderColor: 'rgba(255,184,51,0.45)',
    borderRadius: 8, paddingHorizontal: 14, paddingVertical: 8,
    zIndex: 10,
  },
  backTxt: {
    fontFamily: 'Courier', fontSize: 13, fontWeight: 'bold',
    color: '#FFB833', letterSpacing: 1,
  },

  titleChip: {
    position: 'absolute', alignSelf: 'center', left: 100, right: 100,
    backgroundColor: 'rgba(10,8,2,0.75)',
    borderWidth: 1, borderColor: 'rgba(255,184,51,0.25)',
    borderRadius: 8, paddingHorizontal: 10, paddingVertical: 8,
    zIndex: 9, alignItems: 'center',
  },
  titleTxt: {
    fontFamily: 'Courier', fontSize: 11, color: 'rgba(200,137,58,0.90)', letterSpacing: 1,
  },
});
