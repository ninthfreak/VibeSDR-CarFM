/**
 * BrowserOverlay — full-screen in-app browser for the server's admin pages
 * (ADMIN / NOISE / CONDITIONS / LISTENERS — skin menu's Admin section).
 * Native "← SDR" bar with browser ‹ › history arrows (the admin pages are
 * multi-level); iOS also keeps edge-swipe back/forward inside the page, and
 * the Android back gesture navigates page history before closing the modal.
 * The pages are arbitrary server HTML, so unlike MapOverlay no chrome is
 * injected into the WebView itself.
 */

import React, { useRef, useState } from 'react';
import {
  Modal, Share, StyleSheet, Text, TouchableOpacity, View,
} from 'react-native';
import { WebView } from 'react-native-webview';
import { SafeAreaView } from 'react-native-safe-area-context';

export interface BrowserOverlayProps {
  url:     string | null;
  title?:  string;
  onClose: () => void;
  /** Show a Save/Share button (OWRX files gallery — save SSTV/WEFAX images). */
  allowSave?: boolean;
  /** CSS injected into the page (e.g. hide the OWRX header to enlarge the map). */
  injectCSS?: string;
}

export default function BrowserOverlay({ url, title, onClose, allowSave, injectCSS }: BrowserOverlayProps) {
  const webRef = useRef<WebView>(null);
  const [canBack, setCanBack] = useState(false);
  const [canFwd,  setCanFwd]  = useState(false);
  const [curUrl,  setCurUrl]  = useState(url);
  if (!url) return null;
  // Hand the currently-open URL to the OS share sheet — for an image (a tapped
  // file in the OWRX gallery) iOS/Android offer "Save Image" / "Save to Files".
  const onSave = () => { Share.share({ url: curUrl ?? url }).catch(() => {}); };
  return (
    <Modal
      visible
      animationType="slide"
      supportedOrientations={['portrait', 'landscape']}
      // Android back gesture/button: walk page history first, close last
      onRequestClose={() => {
        if (canBack) webRef.current?.goBack();
        else onClose();
      }}
    >
      {/* SafeAreaView (native, measures the modal's own window) — the
          useSafeAreaInsets hook returns 0 inside an RN Modal, which clipped
          the bar under the Dynamic Island. */}
      <SafeAreaView style={styles.root} edges={['top']}>
        <View style={styles.bar}>
          <TouchableOpacity onPress={onClose} hitSlop={12} activeOpacity={0.7}>
            <Text style={styles.back}>← SDR</Text>
          </TouchableOpacity>
          <Text style={styles.title} numberOfLines={1}>{title ?? url}</Text>
          {allowSave && (
            <TouchableOpacity onPress={onSave} hitSlop={10} activeOpacity={0.7}>
              <Text style={styles.save}>⤓ Save</Text>
            </TouchableOpacity>
          )}
          {/* Browser history arrows — multi-level admin pages */}
          <TouchableOpacity
            onPress={() => webRef.current?.goBack()}
            hitSlop={10} activeOpacity={0.7} disabled={!canBack}
          >
            <Text style={[styles.navArrow, !canBack && styles.navArrowDim]}>‹</Text>
          </TouchableOpacity>
          <TouchableOpacity
            onPress={() => webRef.current?.goForward()}
            hitSlop={10} activeOpacity={0.7} disabled={!canFwd}
          >
            <Text style={[styles.navArrow, !canFwd && styles.navArrowDim]}>›</Text>
          </TouchableOpacity>
        </View>
        <WebView
          ref={webRef}
          source={{ uri: url }}
          style={styles.web}
          allowsBackForwardNavigationGestures
          // Inject after the page loads (injectedJavaScript-prop timing was
          // unreliable on the OWRX map). A MutationObserver re-applies it in case
          // the header mounts after load.
          onLoadEnd={() => {
            if (!injectCSS) return;
            const css = JSON.stringify(injectCSS);
            webRef.current?.injectJavaScript(
              `(function(){function a(){var id='vibe-inj';if(!document.getElementById(id)){var s=document.createElement('style');s.id=id;s.textContent=${css};(document.head||document.documentElement).appendChild(s);}}a();new MutationObserver(a).observe(document.documentElement,{childList:true,subtree:true});})();true;`,
            );
          }}
          onNavigationStateChange={(nav: { canGoBack: boolean; canGoForward: boolean; url: string }) => {
            setCanBack(nav.canGoBack);
            setCanFwd(nav.canGoForward);
            setCurUrl(nav.url);
          }}
        />
      </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root:  { flex: 1, backgroundColor: '#000' },
  bar:   {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 14, paddingTop: 6, paddingBottom: 8, backgroundColor: '#0a0a0a',
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: 'rgba(255,255,255,0.18)',
    gap: 6,
  },
  back:  { color: '#ffe566', fontFamily: 'Atkinson Hyperlegible', fontSize: 16 },
  save:  { color: '#ffe566', fontFamily: 'Atkinson Hyperlegible', fontSize: 14, paddingHorizontal: 6 },
  title: {
    flex: 1, textAlign: 'center', paddingHorizontal: 8,
    color: 'rgba(255,255,255,0.85)', fontFamily: 'Atkinson Hyperlegible', fontSize: 15,
  },
  navArrow: {
    color: '#ffe566', fontSize: 26, lineHeight: 28,
    paddingHorizontal: 8, fontFamily: 'Atkinson Hyperlegible',
  },
  navArrowDim: { color: 'rgba(255,255,255,0.22)' },
  web:   { flex: 1, backgroundColor: '#000' },
});
