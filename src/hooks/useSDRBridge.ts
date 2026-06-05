import { useCallback, useRef } from 'react';
import { WebView } from 'react-native-webview';
import { Mode } from '../services/ubersdrProtocol';

export interface SDRBridge {
  webViewRef: React.RefObject<WebView>;
  tune: (hz: number) => void;
  setMode: (mode: Mode) => void;
  mute: (muted: boolean) => void;
  readFreq: () => void;
  injectZoom: (delta: number) => void;
}

export function useSDRBridge(
  onFreqChange: (hz: number) => void,
  onModeChange: (mode: Mode) => void,
  onSnrChange:  (snr: number) => void,
): SDRBridge {
  const webViewRef = useRef<WebView>(null as any);

  const inject = useCallback((js: string) => {
    webViewRef.current?.injectJavaScript(js + '; true;');
  }, []);

  const tune = useCallback((hz: number) => {
    // Use the DOM method to set frequency — matches what setFreqHz() does in the skin.
    // window.setFrequency() is NOT used because it bypasses UberSDR's pan/zoom logic.
    inject(`
      (function(){
        var si = document.getElementById('frequency');
        if (!si) return;
        si.setAttribute('data-hz-value', ${hz});
        var s = (${hz}/1000).toFixed(3);
        try { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(si,s); }
        catch(e){ si.value = s; }
        ['input','change'].forEach(function(ev){
          si.dispatchEvent(new Event(ev,{bubbles:true,cancelable:true}));
        });
        ['keydown','keypress','keyup'].forEach(function(ev){
          si.dispatchEvent(new KeyboardEvent(ev,{key:'Enter',code:'Enter',keyCode:13,bubbles:true,cancelable:true}));
        });
        var form = si.closest ? si.closest('form') : null;
        if (form) { try{form.requestSubmit();}catch(e){} }
      })();
    `);
  }, [inject]);

  const setMode = useCallback((mode: Mode) => {
    inject(`if(typeof window.setMode==='function') window.setMode('${mode}', true);`);
  }, [inject]);

  const mute = useCallback((muted: boolean) => {
    inject(muted
      ? `try{ var ac=window._audioContext||window.audioContext; if(ac&&ac.suspend) ac.suspend(); }catch(e){}`
      : `try{ var ac=window._audioContext||window.audioContext; if(ac&&ac.resume)  ac.resume();  }catch(e){}`
    );
  }, [inject]);

  const readFreq = useCallback(() => {
    inject(`
      (function(){
        var hz=0;
        var si=document.getElementById('frequency');
        if(si){
          var dv=si.getAttribute('data-hz-value');
          if(dv){hz=parseInt(dv,10);}
          if(!hz){var kv=parseFloat(si.value);if(!isNaN(kv)&&kv>0)hz=Math.round(kv*1000);}
        }
        var snr=typeof window.kiwi_snr==='number'?window.kiwi_snr:-1;
        var mode='';
        try{var ms=document.getElementById('mode_select')||document.querySelector('[data-mode]');
          if(ms)mode=ms.value||ms.getAttribute('data-mode')||'';}catch(e){}
        window.ReactNativeWebView.postMessage(JSON.stringify({type:'state',hz:hz,snr:snr,mode:mode}));
      })();
    `);
  }, [inject]);

  const injectZoom = useCallback((delta: number) => {
    inject(`if(typeof wfDirectZoom==='function') wfDirectZoom(${delta});`);
  }, [inject]);

  return { webViewRef, tune, setMode, mute, readFreq, injectZoom };
}

export function parseWebViewMessage(
  json: string,
  onFreq: (hz: number) => void,
  onMode: (mode: Mode) => void,
  onSnr:  (snr: number) => void,
): void {
  try {
    const msg = JSON.parse(json);
    if (msg.type === 'state') {
      if (msg.hz  > 0) onFreq(msg.hz);
      if (msg.snr >= 0) onSnr(msg.snr);
      if (msg.mode)     onMode(msg.mode as Mode);
    }
  } catch { /* ignore */ }
}
