/**
 * MapOverlay — full-screen Leaflet maps for HFDL / Digital spots / CW spots.
 * Ported from skin v6.3.2 (lsv-hfdl / lsv-digmap / lsv-cwmap overlays).
 *
 * Architecture: react-native-webview running a self-contained HTML document.
 * The WebView talks to the UberSDR server directly:
 *   HFDL  — polls {base}/addon/hfdl/aircraft + /groundstations every 5s
 *   DIGI  — own /ws/dxcluster socket, subscribe_digital_spots
 *   CW    — own /ws/dxcluster socket, subscribe_cw_spots
 *   RX position — {base}/api/description → receiver.gps
 *
 * GPU acceleration: WKWebView composites Leaflet's translate3d pan/zoom on
 * the GPU. On top of that we add:
 *   - CSS transition on .leaflet-marker-icon transforms → aircraft GLIDE
 *     between poll positions, interpolated by the compositor (no JS frames)
 *   - pulse/glow animations as CSS keyframes (compositor-driven opacity/scale)
 *   - will-change: transform hints on marker panes
 */

import React, { useMemo } from 'react';
import { Modal, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { WebView } from 'react-native-webview';

export type MapKind = 'hfdl' | 'digi' | 'cw';

interface MapOverlayProps {
  visible: boolean;
  kind:    MapKind | null;
  baseUrl: string;          // http(s)://host — used for fetch + ws URLs
  onClose: () => void;
}

const TITLES: Record<MapKind, string> = {
  hfdl: '✈ HFDL LIVE',
  digi: '📡 DIGITAL SPOTS',
  cw:   '⊟ CW SPOTS',
};

// ── HTML document builder ─────────────────────────────────────────────────────

function buildHtml(kind: MapKind, baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/, '');
  const wsBase = base.replace(/^http/, 'ws');
  return `<!DOCTYPE html>
<html><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css">
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<style>
  html,body{margin:0;padding:0;height:100%;background:#0a0804;}
  #map{position:absolute;inset:0;background:#0a0804;}
  /* ── GPU hints ──
     Leaflet positions markers with translate3d; the transition makes position
     updates GLIDE, interpolated on the compositor thread (zero JS per frame). */
  .leaflet-pane{will-change:transform;}
  .leaflet-marker-icon.glide{transition:transform 2.2s linear;will-change:transform;}
  .leaflet-fade-anim .leaflet-tile{will-change:opacity;}
  @keyframes pulse{0%{opacity:1;transform:scale(1)}50%{opacity:.55;transform:scale(1.25)}100%{opacity:1;transform:scale(1)}}
  .pulse{animation:pulse 1.4s ease-in-out infinite;transform-origin:center;will-change:transform,opacity;}
  #bar{position:fixed;top:0;left:0;right:0;z-index:9999;display:flex;align-items:center;gap:8px;
    padding:8px 10px;background:rgba(10,8,4,0.88);border-bottom:1px solid rgba(255,160,0,0.25);
    font-family:'Courier New',monospace;backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);}
  #cnt{color:#ffb833;font-size:12px;letter-spacing:1px;}
  #stat{color:rgba(255,160,0,0.55);font-size:10px;letter-spacing:1px;flex:1;text-align:right;}
  select{background:rgba(20,16,8,0.9);color:#ffb833;border:1px solid rgba(255,160,0,0.35);
    border-radius:4px;font-size:11px;padding:3px 4px;font-family:inherit;}
  .leaflet-popup-content-wrapper{background:rgba(10,8,4,0.94);color:#cfc;border:1px solid rgba(255,160,0,0.3);border-radius:8px;}
  .leaflet-popup-tip{background:rgba(10,8,4,0.94);}
  .leaflet-popup-content{margin:10px 12px;font-family:'Courier New',monospace;}
</style>
</head><body>
<div id="bar">
  <span id="cnt">…</span>
  ${kind === 'digi' ? `
  <select id="fMode"><option>ALL</option><option>FT8</option><option>FT4</option><option>WSPR</option><option>JS8</option></select>` : ''}
  ${kind !== 'hfdl' ? `
  <select id="fBand"><option>ALL</option><option>160m</option><option>80m</option><option>60m</option><option>40m</option><option>30m</option><option>20m</option><option>17m</option><option>15m</option><option>12m</option><option>10m</option></select>
  <select id="fAge"><option value="0">AGE</option><option value="15">15m</option><option value="30">30m</option><option value="60">1h</option></select>` : ''}
  <span id="stat">connecting…</span>
</div>
<div id="map"></div>
<script>
var BASE='${base}', WSBASE='${wsBase}', KIND='${kind}';
var RX_LAT=0, RX_LON=0;
var map=L.map('map',{zoomControl:false,attributionControl:false,fadeAnimation:true,zoomAnimation:true,markerZoomAnimation:true})
  .setView([30,0],2);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:14}).addTo(map);
var cnt=document.getElementById('cnt'), stat=document.getElementById('stat');

function age(ms){var s=Math.floor((Date.now()-ms)/1000);if(s<5)return'just now';if(s<60)return s+'s ago';var m=Math.floor(s/60);return m<60?m+'m ago':Math.floor(m/60)+'h ago';}
function distKm(lat,lon){if(!RX_LAT&&!RX_LON)return null;var R=6371,r=Math.PI/180;var dLat=(lat-RX_LAT)*r,dLon=(lon-RX_LON)*r;var a=Math.sin(dLat/2)*Math.sin(dLat/2)+Math.cos(RX_LAT*r)*Math.cos(lat*r)*Math.sin(dLon/2)*Math.sin(dLon/2);return Math.round(R*2*Math.atan2(Math.sqrt(a),Math.sqrt(1-a)));}

var RX_SVG='<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 22 22"><polygon points="11,1 21,10 17,10 17,21 13,21 13,15 9,15 9,21 5,21 5,10 1,10" fill="rgba(255,200,60,0.85)" stroke="rgba(0,0,0,0.5)" stroke-width="1"/></svg>';
function addRx(){if(RX_LAT||RX_LON){L.marker([RX_LAT,RX_LON],{icon:L.divIcon({html:RX_SVG,className:'',iconSize:[22,22],iconAnchor:[11,11]})}).addTo(map).bindPopup('<b style="color:#ffb833">RECEIVER</b>');map.setView([RX_LAT,RX_LON],5);}}

fetch(BASE+'/api/description').then(function(r){return r.json();}).then(function(d){
  var gps=d&&d.receiver&&d.receiver.gps;
  if(gps&&(gps.lat||gps.lon)){RX_LAT=gps.lat;RX_LON=gps.lon;}
  addRx();
}).catch(function(){});

// ════════ HFDL ════════
if(KIND==='hfdl'){
  var gsM={}, acM={}, gsNames={};
  function acColour(lastSeen){var a=Math.floor(Date.now()/1000)-lastSeen;
    if(a<120)return'rgba(80,255,120,0.92)';if(a<300)return'rgba(180,255,80,0.88)';
    if(a<900)return'rgba(255,190,40,0.85)';return'rgba(255,80,60,0.75)';}
  function acSVG(hdg,lastSeen){var c=acColour(lastSeen);
    return'<svg xmlns="http://www.w3.org/2000/svg" width="26" height="26" viewBox="0 0 26 26" style="transform:rotate('+(hdg||0)+'deg);transform-origin:center;">'
    +'<path d="M13,2 L15,10 L23,13 L15,15 L14,22 L16,24 L13,23 L10,24 L12,22 L11,15 L3,13 L11,10 Z" fill="'+c+'" stroke="rgba(0,0,0,0.55)" stroke-width="0.8"/></svg>';}
  function gsSVG(sig){var c;
    if(sig==null||sig===0)c='rgba(120,120,140,0.6)';
    else if(sig>-40)c='rgba(60,220,80,0.92)';else if(sig>-55)c='rgba(220,200,40,0.92)';else c='rgba(255,100,60,0.85)';
    return'<svg xmlns="http://www.w3.org/2000/svg" width="30" height="36" viewBox="0 0 30 36">'
    +'<path d="M10,11 A7,7 0 0,0 10,1" fill="none" stroke="'+c+'" stroke-width="2" stroke-linecap="round"/>'
    +'<path d="M20,11 A7,7 0 0,1 20,1" fill="none" stroke="'+c+'" stroke-width="2" stroke-linecap="round"/>'
    +'<circle cx="15" cy="6" r="2.8" fill="'+c+'"/>'
    +'<path d="M15,9 L15,30 M9,34 L15,28 L21,34" fill="none" stroke="'+c+'" stroke-width="2" stroke-linecap="round"/></svg>';}
  function icon(svg,w,h){return L.divIcon({html:svg,className:'glide',iconSize:[w,h],iconAnchor:[w/2,h/2]});}

  function pollGS(){
    fetch(BASE+'/addon/hfdl/groundstations').then(function(r){if(!r.ok)throw 0;return r.json();}).then(function(data){
      (Array.isArray(data)?data:[]).forEach(function(g){
        if(g.lat==null||g.lon==null)return;
        gsNames[g.id]=g.name||('GS '+g.id);
        var html=gsSVG(g.sig_level);
        var pop='<b style="color:#ffb833">'+(g.name||'GS')+'</b><br><span style="font-size:10px;color:rgba(255,160,0,0.6)">'
          +(g.sig_level?g.sig_level.toFixed(1)+' dBFS':'no signal')+'</span>';
        if(gsM[g.id]){gsM[g.id].setIcon(icon(html,30,36));gsM[g.id].setPopupContent(pop);}
        else{gsM[g.id]=L.marker([g.lat,g.lon],{icon:icon(html,30,36)}).addTo(map).bindPopup(pop);}
      });
      stat.textContent='live';
    }).catch(function(){stat.textContent='hfdl addon unavailable';});
  }
  function pollAC(){
    fetch(BASE+'/addon/hfdl/aircraft').then(function(r){if(!r.ok)throw 0;return r.json();}).then(function(data){
      var ac=Array.isArray(data)?data:[]; var cur={};
      cnt.textContent='✈ '+ac.length;
      ac.forEach(function(a){
        if(a.lat==null||a.lon==null||!a.key)return;
        cur[a.key]=1;
        var hdg=(a.true_trk_valid&&a.true_trk_deg!=null)?a.true_trk_deg:(a.bearing||0);
        var fl=a.flight||a.reg||a.key;
        var pop='<b style="color:#9f9">'+fl+'</b><br><span style="font-size:10px;color:rgba(255,160,0,0.65)">'
          +(a.alt_valid&&a.alt_ft?Math.round(a.alt_ft).toLocaleString()+' ft · ':'')
          +(a.gnd_spd_kts?Math.round(a.gnd_spd_kts)+' kts · ':'')
          +(a.freq_khz?(a.freq_khz/1000).toFixed(3)+' MHz':'')+'<br>'
          +(a.sig_level?a.sig_level.toFixed(1)+' dBFS · ':'')
          +(gsNames[a.gs_id]||'')+'<br>'
          +(distKm(a.lat,a.lon)?distKm(a.lat,a.lon)+' km · ':'')+age(a.last_seen*1000)+'</span>';
        if(acM[a.key]){
          acM[a.key].setLatLng([a.lat,a.lon]);      // CSS transition → GPU glide
          acM[a.key].setIcon(icon(acSVG(hdg,a.last_seen),26,26));
          acM[a.key].setPopupContent(pop);
        }else{
          acM[a.key]=L.marker([a.lat,a.lon],{icon:icon(acSVG(hdg,a.last_seen),26,26)}).addTo(map).bindPopup(pop,{maxWidth:220});
        }
      });
      Object.keys(acM).forEach(function(k){if(!cur[k]){try{map.removeLayer(acM[k]);}catch(e){}delete acM[k];}});
    }).catch(function(){});
  }
  pollGS();pollAC();
  setInterval(pollAC,5000);
  setInterval(pollGS,30000);
}

// ════════ DIGI / CW spots ════════
if(KIND==='digi'||KIND==='cw'){
  var isCW=(KIND==='cw');
  var spots=[], markers={}, MAXS=500;
  var fMode=document.getElementById('fMode'), fBand=document.getElementById('fBand'), fAge=document.getElementById('fAge');
  var MODE_COL={FT8:'rgba(80,255,120,0.9)',FT4:'rgba(60,200,255,0.9)',WSPR:'rgba(200,120,255,0.9)',JS8:'rgba(255,170,50,0.9)',CW:'rgba(255,220,80,0.9)'};

  function spotHz(f){if(!f)return 0;return f<1000?Math.round(f*1e6):Math.round(f);}
  function key(s){return (s.call||'')+'|'+(s.band||'');}
  function passes(s){
    if(!isCW&&fMode&&fMode.value!=='ALL'&&s.mode!==fMode.value)return false;
    if(fBand&&fBand.value!=='ALL'&&s.band!==fBand.value)return false;
    var am=fAge?parseInt(fAge.value):0;
    if(am>0&&Date.now()-s.t>am*60000)return false;
    return true;
  }
  function style(s){
    var col=MODE_COL[s.mode]||'rgba(120,240,120,0.9)';
    var snr=s.snr!==undefined?s.snr:-30;
    var r=snr>=0?7:snr>=-10?6:snr>=-18?5:4;
    return{radius:r,fillColor:col,color:snr>=0?col:'rgba(0,0,0,0.4)',weight:snr>=0?2:1,opacity:snr>=0?0.9:0.5,fillOpacity:0.75};
  }
  function popup(s){
    var hz=spotHz(s.freq);
    return'<div style="font-size:12px;color:rgba(120,240,120,0.95);letter-spacing:1px;">'+s.call+'</div>'
    +'<div style="margin-top:4px;font-size:10px;color:rgba(80,200,80,0.7);">'
    +(s.mode?s.mode+' · ':'')+(s.band?s.band+' · ':'')+(hz?(hz/1e6).toFixed(4)+' MHz':'')+'</div>'
    +'<div style="margin-top:3px;font-size:10px;color:rgba(80,200,80,0.55);">'
    +(s.snr!==undefined?'SNR '+s.snr+' dB':'')+(s.wpm?' · '+Math.round(s.wpm)+' wpm':'')
    +(s.country?' · '+s.country:'')+'</div>'
    +'<div style="margin-top:2px;font-size:9px;color:rgba(80,200,80,0.4);">'+age(s.t)
    +(distKm(s.lat,s.lon)?' · '+distKm(s.lat,s.lon)+' km':'')+'</div>';
  }
  function upsert(s){
    if(!passes(s))return;
    var k=key(s);
    if(markers[k]){markers[k].setStyle(style(s)).setLatLng([s.lat,s.lon]);markers[k].setPopupContent(popup(s));}
    else{markers[k]=L.circleMarker([s.lat,s.lon],style(s)).bindPopup(popup(s),{maxWidth:200}).addTo(map);}
  }
  function rebuild(){
    Object.keys(markers).forEach(function(k){try{map.removeLayer(markers[k]);}catch(e){}});
    markers={};
    spots.forEach(function(s){upsert(s);});
    cnt.textContent=(isCW?'⊟ ':'📡 ')+Object.keys(markers).length;
  }
  [fMode,fBand,fAge].forEach(function(el){if(el)el.onchange=rebuild;});
  setInterval(rebuild,30000); // age filter refresh + prune display

  function norm(d,cw){
    var lat=d.latitude, lon=d.longitude;
    if(lat==null||lon==null)return null;
    return{
      lat:lat, lon:lon, kind:cw?'cw':'digi',
      mode:cw?'CW':String(d.mode||'').toUpperCase(),
      band:String(d.band||''),
      call:String(cw?(d.dx_call||''):(d.callsign||'')),
      snr:typeof d.snr==='number'?d.snr:undefined,
      wpm:typeof d.wpm==='number'?d.wpm:undefined,
      freq:d.frequency, country:String(d.country||''),
      t:(function(ts){var x=new Date(ts).getTime();return isNaN(x)?Date.now():x;})(cw?d.time:d.timestamp)
    };
  }
  function connect(){
    var ws=new WebSocket(WSBASE+'/ws/dxcluster?user_session_id=map-'+Math.random().toString(36).slice(2));
    ws.onopen=function(){
      stat.textContent='live';
      ws.send(JSON.stringify({type:isCW?'subscribe_cw_spots':'subscribe_digital_spots'}));
    };
    ws.onmessage=function(e){
      if(typeof e.data!=='string')return;
      try{
        var m=JSON.parse(e.data);
        if((m.type==='digital_spot'&&!isCW)||(m.type==='cw_spot'&&isCW)){
          var s=norm(m.data||{},isCW);
          if(!s)return;
          spots.unshift(s);
          if(spots.length>MAXS)spots.length=MAXS;
          upsert(s);
          cnt.textContent=(isCW?'⊟ ':'📡 ')+Object.keys(markers).length;
        }
      }catch(x){}
    };
    ws.onclose=function(){stat.textContent='reconnecting…';setTimeout(connect,3000);};
  }
  connect();
}
</script>
</body></html>`;
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function MapOverlay({ visible, kind, baseUrl, onClose }: MapOverlayProps) {
  const insets = useSafeAreaInsets();
  const html = useMemo(
    () => (kind ? buildHtml(kind, baseUrl) : ''),
    [kind, baseUrl],
  );

  if (!visible || !kind) return null;

  return (
    <Modal visible transparent={false} animationType="slide" onRequestClose={onClose}>
      <View style={mo.root}>
        <View style={[mo.titleBar, { paddingTop: insets.top + 6 }]}>
          <Text style={mo.title}>{TITLES[kind]}</Text>
          <TouchableOpacity onPress={onClose} hitSlop={10} style={mo.backBtn}>
            <Text style={mo.backTxt}>← BACK</Text>
          </TouchableOpacity>
        </View>
        <WebView
          source={{ html }}
          originWhitelist={['*']}
          style={mo.web}
          javaScriptEnabled
          domStorageEnabled
          allowsInlineMediaPlayback
          setSupportMultipleWindows={false}
        />
      </View>
    </Modal>
  );
}

const mo = StyleSheet.create({
  root:     { flex: 1, backgroundColor: '#0a0804' },
  titleBar: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 14, paddingBottom: 8,
    backgroundColor: '#0a0804',
    borderBottomWidth: 1, borderBottomColor: 'rgba(255,160,0,0.25)',
  },
  title:   { color: '#ffb833', fontSize: 13, letterSpacing: 2, fontFamily: 'Nixie One' },
  backBtn: {
    borderWidth: 1, borderColor: 'rgba(255,160,0,0.35)', borderRadius: 5,
    paddingHorizontal: 10, paddingVertical: 4,
  },
  backTxt: { color: 'rgba(255,160,0,0.8)', fontSize: 11, letterSpacing: 1, fontFamily: 'Nixie One' },
  web:     { flex: 1, backgroundColor: '#0a0804' },
});
