import React, { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { Platform, StyleSheet } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { WebView, WebViewMessageEvent } from 'react-native-webview';
import { SKIN_HTML } from '../assets/skinHtml';
import { FONTS_CSS } from '../assets/fontsCSS';
import { LEAFLET_CSS } from '../assets/leafletCSS';
import { LEAFLET_JS } from '../assets/leafletJS';
import { ViewMode, skinPrefsJson } from '../services/viewMode';

export const NATIVE_BAR_PX = 0;

const APP_PREFS_KEY = '@vibesdr/app_prefs';

async function loadAppPrefs(): Promise<Record<string, unknown>> {
  try {
    const raw = await AsyncStorage.getItem(APP_PREFS_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

async function saveAppPref(key: string, value: unknown): Promise<void> {
  try {
    const prefs = await loadAppPrefs();
    prefs[key] = value;
    await AsyncStorage.setItem(APP_PREFS_KEY, JSON.stringify(prefs));
  } catch {}
}

// ── Pre-page script ───────────────────────────────────────────────────────────
function buildPreInject(
  viewMode: ViewMode,
  fontsCss: string,
  leafletCss: string,
  leafletJs: string,
  appPrefs: Record<string, unknown>,
): string {
  const skinPrefs = JSON.parse(skinPrefsJson(viewMode)) as Record<string, unknown>;
  // Merge saved app prefs (e.g. haptics) into the skin prefs
  const mergedPrefs = { ...skinPrefs, ...appPrefs };

  const fontsEscaped  = JSON.stringify(fontsCss);
  const leafletCssEsc = JSON.stringify(leafletCss);
  const leafletJsEsc  = JSON.stringify(leafletJs);
  const prefsJson     = JSON.stringify(JSON.stringify(mergedPrefs));

  const isAndroid = Platform.OS === 'android';
  return `
(function(){
  window.__vibeAppSkin = true;
  window.__vibeAndroid = ${isAndroid ? 'true' : 'false'};

  // document.head is null at documentStart — use documentElement as fallback
  var _head = document.head || document.documentElement;

  // Inject bundled fonts so no network request is needed for typography
  try {
    var fs = document.createElement('style');
    fs.id = 'vibe-fonts';
    fs.textContent = ${fontsEscaped};
    _head.appendChild(fs);
  } catch(e) {}

  // Inject bundled Leaflet CSS + JS so map overlays work offline
  try {
    var lcs = document.createElement('style');
    lcs.id = 'vibe-leaflet-css';
    lcs.textContent = ${leafletCssEsc};
    _head.appendChild(lcs);
  } catch(e) {}
  try {
    if (!window.L) { var ljs = document.createElement('script'); ljs.textContent = ${leafletJsEsc}; _head.appendChild(ljs); }
  } catch(e) {}

  // Pre-set merged skin + app prefs (skin mode, haptics, etc.) so they are
  // consistent across every server without relying on per-origin localStorage.
  try { localStorage.setItem('lsv_prefs', ${prefsJson}); } catch(e) {}

  // Enable UberSDR's Android Chrome audio path so the HTTP audio stream
  // (<audio src="/audio/stream?session=...">) is used instead of AudioContext.
  // UberSDR reads this flag at module load time — must be set before app.js runs.
  // Without this, UberSDR uses the desktop path which has no background audio.
  try { localStorage.setItem('mediaSessionEnabled', 'true'); } catch(e) {}

  var SKIN_IDS = new Set([
    'utp','ubw-css',
    'lsv-chat-toast','lsv-hfdl-overlay','lsv-digmap-overlay','lsv-cwmap-overlay',
    'lsv-pill-restore','lsv-a11y-notif','lsv-skin-picker','lsv-drum-hint-popup',
    'lsv-wrap','lsv-menu-backdrop','lsv-anim-clock','lsv-rec-float',
    'lsv-chat-drawer','lsv-menu-panel','lsv-audio-only-overlay','lsv-mp-scrollbar',
    'lsv-zoom-tip','freq-modal-wrap','share-toast','lsv-step-pick',
    'u-backdrop','lsv-decoder-panel','vts-desktop-wrap',
  ]);

  var obs = new MutationObserver(function(muts) {
    muts.forEach(function(m) {
      m.addedNodes.forEach(function(node) {
        if (node.id && SKIN_IDS.has(node.id) && node.parentNode) {
          node.parentNode.removeChild(node);
        }
      });
    });
  });
  obs.observe(document.documentElement, { childList: true, subtree: true });

  window.__vibeStopObserver = function() {
    obs.disconnect();
    SKIN_IDS.forEach(function(id) {
      var el = document.getElementById(id);
      if (el && el.parentNode) el.parentNode.removeChild(el);
    });
    document.querySelectorAll('style[id="ubw-css"]').forEach(function(el){ el.remove(); });
  };
})();
true;
`;}

// ── Post-load injection ───────────────────────────────────────────────────────
function buildInject(skinHtml: string): string {
  const skinEscaped = JSON.stringify(skinHtml);
  return `
(function(){
  if (window.__vibeSdrInjected === '0.1.51') return;
  window.__vibeSdrInjected = '0.1.51';

  if (typeof window.__vibeStopObserver === 'function') window.__vibeStopObserver();

  // ── 0. Remove any previous skin injection ────────────────────────────────
  ['lsv-wrap','lsv-menu-backdrop','lsv-anim-clock','lsv-rec-float',
   'lsv-chat-drawer','lsv-menu-panel','lsv-skin-picker','lsv-drum-hint-popup',
   'lsv-hint-toast','vts-desktop-wrap'].forEach(function(id) {
    var el = document.getElementById(id);
    if (el && el.parentNode) el.parentNode.removeChild(el);
  });
  ['ubw-css','ubw-scale-css','vibesdr-base'].forEach(function(id) {
    var el = document.getElementById(id);
    if (el && el.parentNode) el.parentNode.removeChild(el);
  });

  // ── 1. Base CSS ───────────────────────────────────────────────────────────
  var baseStyle = document.createElement('style');
  baseStyle.id = 'vibesdr-base';
  baseStyle.textContent = [
    'body,html{margin:0!important;padding:0!important;overflow:hidden!important;background:#000!important;}',
    '.controls{display:none!important;}',
    '.band-status-bar{display:none!important;}',
    '#audio-buffer-display{display:none!important;}',
    '#space-weather-display{display:none!important;}',
    '#time-display{display:none!important;}',
    '#notification-toast{display:none!important;}',
    '#waterfall-resize-handle{display:none!important;}',
    '.spectrum-display-controls{display:none!important;}',
    '#spectrum-vzoom-slider{display:none!important;}',
    '#digital-spots-badges-main{display:none!important;}',
    '#cw-spots-badges-main{display:none!important;}',
    '.container{display:block!important;padding:0!important;margin:0!important;width:100vw!important;height:100vh!important;overflow:hidden!important;}',
    '.spectrum-display-panel,.spectrum-display-container{width:100vw!important;padding:0!important;margin:0!important;}',
    '#spectrum-display-canvas{width:100%!important;display:block!important;}',
  ].join('');
  document.head.appendChild(baseStyle);

  // ── 2. Waterfall height ───────────────────────────────────────────────────
  function setWFHeight() {
    var h = window.innerHeight;
    try { localStorage.setItem('waterfallHeight', String(h)); } catch(e) {}
    document.documentElement.style.setProperty('--waterfall-height', h + 'px');
    if (window.spectrumDisplay && typeof window.spectrumDisplay.setWaterfallHeight === 'function') {
      window.spectrumDisplay.setWaterfallHeight(h);
    }
  }
  setWFHeight();
  window.addEventListener('resize', function() { setTimeout(setWFHeight, 50); });
  var _wfT = setInterval(setWFHeight, 300);
  setTimeout(function(){ clearInterval(_wfT); setWFHeight(); }, 10000);

  // ── 3. Inject app skin ────────────────────────────────────────────────────
  var skinHtml = ${skinEscaped};
  var parser = new DOMParser();
  var skinDoc = parser.parseFromString('<html><body>' + skinHtml + '</body></html>', 'text/html');

  skinDoc.querySelectorAll('link').forEach(function(l) {
    var el = document.createElement('link');
    if (l.rel)  el.rel  = l.rel;
    if (l.href) el.href = l.href;
    document.head.appendChild(el);
  });

  skinDoc.querySelectorAll('style').forEach(function(s) {
    var el = document.createElement('style');
    if (s.id) el.id = s.id;
    el.textContent = s.textContent;
    document.head.appendChild(el);
  });

  Array.from(skinDoc.body.childNodes).forEach(function(node) {
    if (node.nodeName !== 'SCRIPT') document.body.appendChild(node.cloneNode(true));
  });

  var scripts = skinDoc.querySelectorAll('script');
  var idx = 0;
  function runNext() {
    if (idx >= scripts.length) return;
    var src = scripts[idx++].textContent;
    try { var s = document.createElement('script'); s.textContent = src; document.body.appendChild(s); }
    catch(e) {}
    setTimeout(runNext, 0);
  }
  runNext();

  // ── 4. Auto-click start ───────────────────────────────────────────────────
  var _startTries = 0;
  function tryStart() {
    var btn = document.getElementById('audio-start-button');
    if (btn && !btn.disabled) { btn.click(); return; }
    if (++_startTries < 20) setTimeout(tryStart, 250);
  }
  setTimeout(tryStart, 500);

  // ── 5. Media session / AirPods fix ───────────────────────────────────────
  // iOS only: UberSDR's media session handling is broken on Safari — it calls
  // mediaElement.pause() on AirPod disconnect which kills the bridge, and sets
  // playbackState='paused' handing control to the music app. Override those.
  //
  // Android: UberSDR's _isMobileChrome path sets up its own HTTP audio stream
  // and registers MediaSession correctly. Do NOT interfere — let it run.
  // We only wire VTS next/prev and expose __vibeSetMeta for the state poll.
  (function() {
    var _pt = setInterval(function() {
      if (!window.mediaElement || !('mediaSession' in navigator)) return;
      clearInterval(_pt);

      if (!window.__vibeAndroid) {
        // iOS: prevent mediaElement.pause from killing the bridge
        window.mediaElement.pause = function() {};

        navigator.mediaSession.setActionHandler('pause', function() {
          try { if (!window.isMuted && typeof window.toggleMute === 'function') window.toggleMute(); } catch(e) {}
          try { if (window.mediaElement && window.mediaElement.paused) window.mediaElement.play().catch(function(){}); } catch(e) {}
          try { navigator.mediaSession.playbackState = 'playing'; } catch(e) {}
        });
        navigator.mediaSession.setActionHandler('play', function() {
          try { if (window.isMuted && typeof window.toggleMute === 'function') window.toggleMute(); } catch(e) {}
          try { if (window.mediaElement && window.mediaElement.paused) window.mediaElement.play().catch(function(){}); } catch(e) {}
          try { navigator.mediaSession.playbackState = 'playing'; } catch(e) {}
        });
      }

      // Both platforms: map next/prev track to VTS station arrows
      try { navigator.mediaSession.setActionHandler('nexttrack', function() {
        try { var b=document.getElementById('lsv-vts-rarr'); if(b) b.click(); } catch(e) {}
      }); } catch(e) {}
      try { navigator.mediaSession.setActionHandler('previoustrack', function() {
        try { var b=document.getElementById('lsv-vts-larr'); if(b) b.click(); } catch(e) {}
      }); } catch(e) {}

      function _fmtHz(hz) {
        if (!hz) return 'VibeSDR';
        return hz >= 1000000 ? (hz/1e6).toFixed(3)+' MHz' : (hz/1000).toFixed(3)+' kHz';
      }
      function _setMeta(hz, station) {
        try {
          navigator.mediaSession.metadata = new MediaMetadata({
            title:  _fmtHz(hz),
            artist: station || 'SDR Receiver',
            album:  'VibeSDR',
          });
          if (!window.__vibeAndroid) {
            navigator.mediaSession.playbackState = 'playing';
          }
        } catch(e) {}
      }
      window.__vibeSetMeta = _setMeta;
      if (!window.__vibeAndroid) _setMeta(0, '');
    }, 300);
    setTimeout(function() { clearInterval(_pt); }, 30000);
  })();

  // ── 6. Mute indicator ────────────────────────────────────────────────────
  (function() {
    var style = document.createElement('style');
    style.textContent =
      '#vibe-mute-pill{' +
        'display:none;position:fixed;bottom:32px;left:50%;' +
        'transform:translateX(-50%);z-index:99990;' +
        'background:rgba(10,6,0,0.92);' +
        'border:1.5px solid rgba(255,160,0,0.65);border-radius:50px;' +
        'padding:11px 24px;flex-direction:row;align-items:center;gap:10px;' +
        'cursor:pointer;-webkit-tap-highlight-color:transparent;' +
        'touch-action:manipulation;user-select:none;' +
      '}' +
      '#vibe-mute-pill.vmp-on{display:flex;}' +
      '#vibe-mute-pill span.vmp-icon{font-size:22px;line-height:1;}' +
      '#vibe-mute-pill span.vmp-label{' +
        "font-family:Courier,'Courier New',monospace;" +
        'font-size:11px;color:#ffb833;letter-spacing:2px;white-space:nowrap;' +
      '}' +
      '@keyframes vmp-pulse{' +
        '0%,100%{box-shadow:0 0 0 0 rgba(255,160,0,0.40);}' +
        '50%{box-shadow:0 0 0 10px rgba(255,160,0,0);}' +
      '}' +
      '#vibe-mute-pill.vmp-on{animation:vmp-pulse 2s ease-in-out infinite;}';
    document.head.appendChild(style);

    var pill = document.createElement('div');
    pill.id = 'vibe-mute-pill';
    pill.innerHTML = '<span class="vmp-icon">🔇</span><span class="vmp-label">MUTED — TAP TO RESTORE</span>';
    pill.addEventListener('click', function() {
      try { if (typeof window.toggleMute === 'function') window.toggleMute(); } catch(e) {}
    });
    document.body.appendChild(pill);

    function _setMuted(m) {
      if (m) pill.classList.add('vmp-on');
      else   pill.classList.remove('vmp-on');
    }

    var _hookTimer = setInterval(function() {
      if (!window.radioAPI) return;
      clearInterval(_hookTimer);
      var _orig = window.radioAPI.notifyMuteChange;
      window.radioAPI.notifyMuteChange = function(muted) {
        _setMuted(!!muted);
        if (_orig) try { _orig.call(window.radioAPI, muted); } catch(e) {}
      };
    }, 200);
    var _btnTimer = setInterval(function() {
      try {
        var m = !!(window.isMuted);
        if (!m) { var btn = document.getElementById('mute-btn'); if (btn) m = btn.textContent.indexOf('Unmute') >= 0; }
        _setMuted(m);
      } catch(e) {}
    }, 600);
  })();

  // ── 7. State poll ─────────────────────────────────────────────────────────
  setInterval(function() {
    try {
      var hz = 0;
      var si = document.getElementById('frequency');
      if (si) {
        var dv = si.getAttribute('data-hz-value');
        if (dv) hz = parseInt(dv, 10);
        if (!hz) { var kv = parseFloat(si.value); if (!isNaN(kv) && kv > 0) hz = Math.round(kv * 1000); }
      }
      var station = '';
      try {
        var vtsTxt = document.getElementById('vts-desktop-wrap-txt') ||
                     document.getElementById('lsv-vts-txt');
        if (vtsTxt) station = vtsTxt.textContent.trim();
        if (!station) {
          var vtsArea = document.querySelector('#lsv-vts-area');
          if (vtsArea) station = vtsArea.textContent.trim();
        }
      } catch(_) {}
      var muted = !!(window.isMuted);
      window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'state', hz: hz, station: station, muted: muted }));
      try { if (typeof window.__vibeSetMeta === 'function') window.__vibeSetMeta(hz, station); } catch(e) {}
    } catch(e) {}
  }, 500);

  // ── 8. Android audio-started signal ────────────────────────────────────────
  // Uses a DOM capture-phase 'play' event so it fires for any <audio> element
  // regardless of UberSDR's internal variable name. Also polls window.mediaElement
  // as a fallback. Once fired, tells native to start the foreground MediaService.
  (function() {
    var _sent = false;
    function _signal() {
      if (_sent) return;
      _sent = true;
      try { window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'audio-started' })); } catch(_) {}
    }
    // Primary: catch any audio element starting to play
    document.addEventListener('play', function(e) {
      if (e.target && e.target.nodeName === 'AUDIO') _signal();
    }, true);
    // Fallback: poll window.mediaElement (UberSDR desktop path)
    var _pt = setInterval(function() {
      try {
        if (window.mediaElement && !window.mediaElement.paused) { clearInterval(_pt); _signal(); }
      } catch(_) {}
    }, 500);
    setTimeout(function() { clearInterval(_pt); }, 60000);
  })();
})();
`;
}

const INJECT_SCRIPT = buildInject(SKIN_HTML);

interface WaterfallWebViewProps {
  url:        string;
  viewMode?:  ViewMode;
  appPrefs?:  Record<string, unknown>;
  onMessage?: (event: WebViewMessageEvent) => void;
  onLoad?:    () => void;
  onError?:   () => void;
}

export interface WaterfallWebViewHandle {
  inject: (js: string) => void;
}

const WaterfallWebView = forwardRef<WaterfallWebViewHandle, WaterfallWebViewProps>(
  ({ url, viewMode = 'default', appPrefs = {}, onMessage, onLoad, onError }, ref) => {
    const webViewRef = useRef<WebView>(null as any);

    const preInject = useMemo(
      () => buildPreInject(viewMode, FONTS_CSS, LEAFLET_CSS, LEAFLET_JS, appPrefs),
      [viewMode, appPrefs],
    );

    useImperativeHandle(ref, () => ({
      inject: (js: string) => {
        webViewRef.current?.injectJavaScript(js + '; true;');
      },
    }));

    const handleLoad = () => {
      webViewRef.current?.injectJavaScript(INJECT_SCRIPT + '; true;');
      onLoad?.();
    };

    return (
      <WebView
        ref={webViewRef}
        source={{ uri: url }}
        style={styles.webview}
        allowsInlineMediaPlayback
        mediaPlaybackRequiresUserAction={false}
        allowsBackForwardNavigationGestures={false}
        javaScriptEnabled
        domStorageEnabled
        mixedContentMode="always"
        userAgent={Platform.OS === 'android'
          ? "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36"
          : "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36"
        }
        injectedJavaScriptBeforeContentLoaded={preInject}
        onMessage={onMessage}
        onLoad={handleLoad}
        onError={onError}
        onHttpError={onError}
        scalesPageToFit={false}
        scrollEnabled={false}
        bounces={false}
        overScrollMode="never"
        showsHorizontalScrollIndicator={false}
        showsVerticalScrollIndicator={false}
        {...(Platform.OS === 'android' && {
          textZoom: 100,
          androidLayerType: 'hardware',
        })}
      />
    );
  },
);

WaterfallWebView.displayName = 'WaterfallWebView';
export default WaterfallWebView;
export { loadAppPrefs, saveAppPref };

const styles = StyleSheet.create({
  webview: { flex: 1, backgroundColor: '#000000' },
});
