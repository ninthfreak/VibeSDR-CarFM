/**
 * MapOverlay — full-screen Leaflet maps for HFDL / Digital spots / CW spots.
 * Ported from skin v6.3.2 (lsv-hfdl / lsv-digmap / lsv-cwmap overlays).
 *
 * Architecture: react-native-webview running a self-contained HTML document.
 * The WebView talks to the UberSDR server directly:
 *   HFDL  — polls {base}/addon/hfdl/aircraft (5s) + /groundstations (piggy-backed)
 *   DIGI  — own /ws/dxcluster socket, subscribe_digital_spots
 *   CW    — own /ws/dxcluster socket, subscribe_cw_spots
 *   RX position — {base}/api/description → receiver.gps
 *
 * HFDL skin parity: exact AC/GS SVGs, latest-flight toast (callsign · via GS ·
 * age, refreshed 15s), yellow/cyan pulse glow on latest AC + its GS, expanding
 * rings after snap, SNAP toggle (persisted), GS popups with 3-bar signal meter
 * + per-frequency ON/off list, AC popups with alt/speed/freq/sig/GS/dist/age.
 *
 * GPU acceleration: WKWebView composites Leaflet's translate3d pan/zoom.
 * On top of that:
 *   - CSS transition on marker transforms → aircraft GLIDE between polls,
 *     interpolated by the compositor (icons only swapped when content changes,
 *     otherwise setLatLng rides the transition; disabled during zoom anims)
 *   - pulse glow + rings are pure CSS keyframes (compositor-driven)
 *   - will-change hints on panes/markers
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
  html,body{margin:0;padding:0;height:100%;background:#0a0804;overflow:hidden;}
  #map{position:absolute;inset:0;background:#0a0804;}
  /* ── GPU hints — markers glide between updates on the compositor ── */
  .leaflet-pane{will-change:transform;}
  .leaflet-marker-icon.glide{transition:transform 2.2s linear;will-change:transform;}
  body.nog .leaflet-marker-icon.glide{transition:none;}
  .leaflet-fade-anim .leaflet-tile{will-change:opacity;}
  /* skin lsv-hfdl pulse + rings (verbatim keyframes) */
  @keyframes pulseac{0%,100%{filter:drop-shadow(0 0 3px rgba(255,255,80,0.5));}50%{filter:drop-shadow(0 0 10px rgba(255,255,80,1)) drop-shadow(0 0 18px rgba(255,200,0,0.7));}}
  @keyframes pulsegs{0%,100%{filter:drop-shadow(0 0 3px rgba(80,200,255,0.5));}50%{filter:drop-shadow(0 0 10px rgba(80,220,255,1)) drop-shadow(0 0 18px rgba(0,180,255,0.7));}}
  .pulse-ac{animation:pulseac 1.2s ease-in-out infinite;}
  .pulse-gs{animation:pulsegs 1.2s ease-in-out infinite;}
  @keyframes ring{0%{transform:translate(-50%,-50%) scale(1);opacity:0.8;}100%{transform:translate(-50%,-50%) scale(3);opacity:0;}}
  .ring{position:absolute;pointer-events:none;z-index:650;width:26px;height:26px;border-radius:50%;border:2px solid;transform:translate(-50%,-50%);animation:ring 1.4s ease-out 3;will-change:transform,opacity;}
  .ring-ac{border-color:rgba(255,255,100,0.85);}
  .ring-gs{border-color:rgba(80,220,255,0.85);}
  #bar{position:fixed;top:0;left:0;right:0;z-index:9999;display:flex;align-items:center;gap:8px;
    padding:8px 10px;padding-left:max(10px,env(safe-area-inset-left));padding-right:max(10px,env(safe-area-inset-right));
    background:rgba(10,8,4,0.88);border-bottom:1px solid rgba(255,160,0,0.25);
    font-family:'Courier New',monospace;backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);}
  #cnt{color:#ffb833;font-size:12px;letter-spacing:1px;white-space:nowrap;}
  #stat{color:rgba(255,160,0,0.55);font-size:10px;letter-spacing:1px;flex:1;text-align:right;
    white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
  select{background:rgba(20,16,8,0.9);color:#ffb833;border:1px solid rgba(255,160,0,0.35);
    border-radius:4px;font-size:11px;padding:3px 4px;font-family:inherit;}
  #snap{background:rgba(255,160,0,0.08);border:1px solid rgba(255,160,0,0.20);border-radius:8px;
    color:rgba(255,160,0,0.45);font-size:10px;letter-spacing:0.5px;padding:4px 8px;cursor:pointer;
    font-family:inherit;-webkit-tap-highlight-color:transparent;}
  #snap.on{border-color:rgba(255,160,0,0.50);color:rgba(255,190,60,0.90);background:rgba(255,160,0,0.10);}
  #toast{position:fixed;bottom:max(12px,env(safe-area-inset-bottom));left:50%;transform:translateX(-50%);
    z-index:1000;background:rgba(9,6,2,0.93);border:1px solid rgba(255,160,0,0.30);border-radius:20px;
    padding:6px 14px;font-family:'Courier New',monospace;font-size:11px;letter-spacing:1px;
    color:rgba(255,190,60,0.90);white-space:nowrap;opacity:0;transition:opacity 0.4s;max-width:90vw;
    overflow:hidden;text-overflow:ellipsis;cursor:pointer;}
  #toast.on{opacity:1;}
  .tf{color:#ffe566;font-size:12px;}
  .tg{color:rgba(255,160,0,0.55);}
  .ta{color:rgba(255,160,0,0.40);font-size:10px;}
  .leaflet-popup-content-wrapper{background:rgba(10,8,4,0.94);color:#cfc;border:1px solid rgba(255,160,0,0.3);border-radius:8px;}
  .leaflet-popup-tip{background:rgba(10,8,4,0.94);}
  .leaflet-popup-content{margin:10px 12px;font-family:'Courier New',monospace;}
</style>
</head><body>
<div id="bar">
  <span id="cnt">…</span>
  ${kind === 'hfdl' ? `<button id="snap">⚙ SNAP</button>` : ''}
  ${kind === 'digi' ? `
  <select id="fMode"><option>ALL</option><option>FT8</option><option>FT4</option><option>WSPR</option><option>JS8</option></select>` : ''}
  ${kind !== 'hfdl' ? `
  <select id="fBand"><option>ALL</option><option>160m</option><option>80m</option><option>60m</option><option>40m</option><option>30m</option><option>20m</option><option>17m</option><option>15m</option><option>12m</option><option>10m</option></select>
  <select id="fAge"><option value="0">AGE</option><option value="15">15m</option><option value="30">30m</option><option value="60">1h</option></select>` : ''}
  <span id="stat">connecting…</span>
</div>
<div id="map"></div>
${kind === 'hfdl' ? '<div id="toast"></div>' : ''}
<script>
var BASE='${base}', WSBASE='${wsBase}', KIND='${kind}';
var RX_LAT=0, RX_LON=0;
var map=L.map('map',{zoomControl:false,attributionControl:false,fadeAnimation:true,zoomAnimation:true,markerZoomAnimation:true})
  .setView([30,0],2);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:14}).addTo(map);
var cnt=document.getElementById('cnt'), stat=document.getElementById('stat');

// Marker glide must not fight Leaflet's zoom repositioning
map.on('zoomstart',function(){document.body.classList.add('nog');});
map.on('zoomend',function(){setTimeout(function(){document.body.classList.remove('nog');},60);});
// Orientation change → relayout
window.addEventListener('resize',function(){setTimeout(function(){try{map.invalidateSize();}catch(e){}},120);});

function age(ms){var s=Math.floor((Date.now()-ms)/1000);if(s<5)return'just now';if(s<60)return s+'s ago';var m=Math.floor(s/60);return m<60?m+'m ago':Math.floor(m/60)+'h ago';}
function distKm(lat,lon){if(!RX_LAT&&!RX_LON)return null;var R=6371,r=Math.PI/180;var dLat=(lat-RX_LAT)*r,dLon=(lon-RX_LON)*r;var a=Math.sin(dLat/2)*Math.sin(dLat/2)+Math.cos(RX_LAT*r)*Math.cos(lat*r)*Math.sin(dLon/2)*Math.sin(dLon/2);return Math.round(R*2*Math.atan2(Math.sqrt(a),Math.sqrt(1-a)));}

var RX_SVG='<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 22 22"><polygon points="11,1 21,10 17,10 17,21 13,21 13,15 9,15 9,21 5,21 5,10 1,10" fill="rgba(255,200,60,0.85)" stroke="rgba(0,0,0,0.5)" stroke-width="1"/></svg>';
function addRx(){if(RX_LAT||RX_LON){L.marker([RX_LAT,RX_LON],{icon:L.divIcon({html:RX_SVG,className:'',iconSize:[22,22],iconAnchor:[11,11]})}).addTo(map).bindPopup('<b style="color:#ffb833">RECEIVER</b>');map.setView([RX_LAT,RX_LON],5);}}

fetch(BASE+'/api/description').then(function(r){return r.json();}).then(function(d){
  var gps=d&&d.receiver&&d.receiver.gps;
  if(gps&&(gps.lat||gps.lon)){RX_LAT=gps.lat;RX_LON=gps.lon;}
  addRx();
}).catch(function(){});

// ════════ HFDL (skin lsv-hfdl parity) ════════
if(KIND==='hfdl'){
  var gsM={}, acM={}, gsNames={};
  var glowGS=null, glowAC=null, lastFlight=null, pendingFit=null;
  var toast=document.getElementById('toast'), ageTimer=null;
  var snapBtn=document.getElementById('snap');
  var snapOn=(function(){try{var v=localStorage.getItem('lsv_hfdl_snap');return v===null?true:v==='1';}catch(e){return true;}})();
  function updSnap(){snapBtn.classList.toggle('on',snapOn);}
  updSnap();
  snapBtn.addEventListener('click',function(){snapOn=!snapOn;try{localStorage.setItem('lsv_hfdl_snap',snapOn?'1':'0');}catch(e){}updSnap();});

  function acColour(lastSeen,glow){if(glow)return'rgba(255,240,60,1)';var a=Math.floor(Date.now()/1000)-lastSeen;
    if(a<120)return'rgba(80,255,120,0.92)';if(a<300)return'rgba(180,255,80,0.88)';
    if(a<900)return'rgba(255,190,40,0.85)';return'rgba(255,80,60,0.75)';}

  // skin _acSVG: fuselage ellipse + swept wings + tail, rotated, glow shadow
  function acSVG(glow,bearing,lastSeen){
    var c=acColour(lastSeen||0,glow);
    var f=glow?'filter:drop-shadow(0 0 5px rgba(255,240,60,0.85));':'';
    return'<svg xmlns="http://www.w3.org/2000/svg" width="26" height="26" viewBox="0 0 26 26" style="'+f+'">'
    +'<g transform="rotate('+(bearing||0)+',13,13)">'
    +'<ellipse cx="13" cy="13" rx="2.5" ry="9" fill="'+c+'" stroke="rgba(0,0,0,0.3)" stroke-width="0.5"/>'
    +'<polygon points="13,10 24,17 24,19 13,15 2,19 2,17" fill="'+c+'" stroke="rgba(0,0,0,0.3)" stroke-width="0.5"/>'
    +'<polygon points="13,20 17,24 17,25 13,23 9,25 9,24" fill="'+c+'" stroke="rgba(0,0,0,0.3)" stroke-width="0.5"/>'
    +'</g></svg>';
  }

  // skin _gsSVG: radiating arcs + dot + mast + ground line + legs, ✕ when silent
  function gsSVG(glow,sig){
    var c,xOver=false;
    if(glow){c='rgba(255,240,60,1)';}
    else if(sig==null||sig===0){c='rgba(120,120,140,0.60)';xOver=true;}
    else if(sig>-40){c='rgba(60,220,80,0.92)';}
    else if(sig>-55){c='rgba(220,200,40,0.92)';}
    else{c='rgba(255,100,60,0.85)';}
    var f=glow?'filter:drop-shadow(0 0 5px rgba(255,240,60,0.85));':'';
    var svg='<svg xmlns="http://www.w3.org/2000/svg" width="30" height="36" viewBox="0 0 30 36" style="'+f+'">'
    +'<path d="M10,11 A7,7 0 0,0 10,1" fill="none" stroke="'+c+'" stroke-width="2" stroke-linecap="round"/>'
    +'<path d="M20,11 A7,7 0 0,1 20,1" fill="none" stroke="'+c+'" stroke-width="2" stroke-linecap="round"/>'
    +'<path d="M7,14 A11,11 0 0,0 7,-2" fill="none" stroke="'+c+'" stroke-width="1.3" stroke-linecap="round" opacity="0.55"/>'
    +'<path d="M23,14 A11,11 0 0,1 23,-2" fill="none" stroke="'+c+'" stroke-width="1.3" stroke-linecap="round" opacity="0.55"/>'
    +'<circle cx="15" cy="6" r="2.8" fill="'+c+'"/>'
    +'<line x1="15" y1="6" x2="15" y2="30" stroke="'+c+'" stroke-width="2.2" stroke-linecap="round"/>'
    +'<line x1="1" y1="30" x2="29" y2="30" stroke="'+c+'" stroke-width="2.2" stroke-linecap="round"/>'
    +'<line x1="4" y1="30" x2="2" y2="34" stroke="'+c+'" stroke-width="1.8" stroke-linecap="round"/>'
    +'<line x1="26" y1="30" x2="28" y2="34" stroke="'+c+'" stroke-width="1.8" stroke-linecap="round"/>';
    if(xOver){
      svg+='<circle cx="24" cy="30" r="6" fill="rgba(9,6,2,0.90)" stroke="rgba(200,40,40,0.90)" stroke-width="1.2"/>'
      +'<line x1="20.5" y1="26.5" x2="27.5" y2="33.5" stroke="rgba(220,50,50,0.95)" stroke-width="1.8" stroke-linecap="round"/>'
      +'<line x1="27.5" y1="26.5" x2="20.5" y2="33.5" stroke="rgba(220,50,50,0.95)" stroke-width="1.8" stroke-linecap="round"/>';
    }
    return svg+'</svg>';
  }
  function icon(svg,w,h,ax,ay){return L.divIcon({html:svg,className:'glide',iconSize:[w,h],iconAnchor:[ax,ay]});}

  // skin _sigMeterHTML: 3 signal bars
  function sigBars(dbfs){if(dbfs==null||dbfs===0)return 0;if(dbfs>-40)return 3;if(dbfs>-55)return 2;return 1;}
  function sigMeterHTML(dbfs){
    var bars=sigBars(dbfs);
    if(bars===0)return'<span style="font-size:9px;color:rgba(255,60,60,0.8);letter-spacing:0.5px;">&#10005; NO SIG</span>';
    var colours=['rgba(255,60,60,0.85)','rgba(255,200,40,0.85)','rgba(60,220,80,0.85)'];
    var heights=[6,9,12];
    var h='<span style="display:inline-flex;align-items:flex-end;gap:2px;margin-left:2px;">';
    for(var i=0;i<3;i++){
      var col=i<bars?colours[bars-1]:'rgba(255,255,255,0.12)';
      h+='<span style="display:inline-block;width:5px;height:'+heights[i]+'px;background:'+col+';border-radius:1px;"></span>';
    }
    return h+'</span>';
  }

  // skin rings — overlay-pane divs, CSS animation, self-removing
  var ringAC=null, ringGS=null;
  function placeRing(latlng,cls){
    var pane=map.getPane('overlayPane');if(!pane)return null;
    var el=document.createElement('div');
    el.className='ring '+cls;
    pane.appendChild(el);
    try{var p=map.latLngToLayerPoint(latlng);el.style.left=p.x+'px';el.style.top=p.y+'px';}catch(e){}
    el._tid=setTimeout(function(){if(el.parentNode)el.parentNode.removeChild(el);},4400);
    return el;
  }
  function removeRing(el){if(!el)return;clearTimeout(el._tid);if(el.parentNode)el.parentNode.removeChild(el);}

  // skin _fitToLatest: flyToBounds AC+GS with 30% padding, rings on arrival
  function fitToLatest(acKey,gsid){
    var acLL=acKey&&acM[acKey]?acM[acKey].getLatLng():null;
    var gsLL=gsid!=null&&gsM[gsid]?gsM[gsid].getLatLng():null;
    if(!acLL)return;
    removeRing(ringAC);ringAC=null;removeRing(ringGS);ringGS=null;
    map.once('moveend',function(){
      if(acKey&&acM[acKey])ringAC=placeRing(acM[acKey].getLatLng(),'ring-ac');
      if(gsid!=null&&gsM[gsid])ringGS=placeRing(gsM[gsid].getLatLng(),'ring-gs');
    });
    if(gsLL){
      var b=L.latLngBounds([acLL,gsLL]);
      var sw=b.getSouthWest(),ne=b.getNorthEast();
      var latPad=Math.max((ne.lat-sw.lat)*0.3,4),lngPad=Math.max((ne.lng-sw.lng)*0.3,4);
      map.flyToBounds(L.latLngBounds([sw.lat-latPad,sw.lng-lngPad],[ne.lat+latPad,ne.lng+lngPad]),
        {maxZoom:6,animate:true,duration:0.9,paddingTopLeft:L.point(60,60),paddingBottomRight:L.point(60,60)});
    }else{
      map.flyTo(acLL,5,{animate:true,duration:0.8});
    }
  }

  function glowGSfn(gsid){
    if(glowGS!=null&&gsM[glowGS]){
      gsM[glowGS].setIcon(icon(gsSVG(false,gsM[glowGS]._sig),30,36,15,36));
      try{gsM[glowGS].getElement().classList.remove('pulse-gs');}catch(e){}
    }
    glowGS=gsid;
    if(gsid!=null&&gsM[gsid]){
      gsM[gsid].setIcon(icon(gsSVG(true,gsM[gsid]._sig),30,36,15,36));
      try{gsM[gsid].getElement().classList.add('pulse-gs');}catch(e){}
    }
  }
  function glowACfn(key){
    if(glowAC&&acM[glowAC]){
      var d=acM[glowAC]._d||{};
      acM[glowAC].setIcon(icon(acSVG(false,d.bearing||0,d.last_seen||0),26,26,13,13));
      acM[glowAC]._sigr='';
      try{acM[glowAC].getElement().classList.remove('pulse-ac');}catch(e){}
    }
    glowAC=key;
    if(key&&acM[key]){
      var d=acM[key]._d||{};
      acM[key].setIcon(icon(acSVG(true,d.bearing||0,d.last_seen||0),26,26,13,13));
      acM[key]._sigr='';
      try{acM[key].getElement().classList.add('pulse-ac');}catch(e){}
    }
  }

  function showToast(){
    if(!lastFlight)return;
    toast.innerHTML='<span class="tf">'+(lastFlight.cs||'???')+'</span>'
      +(lastFlight.gs?' <span class="tg">via '+lastFlight.gs+'</span>':'')
      +' <span class="ta">'+age(lastFlight.t)+'</span>';
    toast.classList.add('on');
    if(ageTimer)clearInterval(ageTimer);
    ageTimer=setInterval(function(){
      if(lastFlight){var el=toast.querySelector('.ta');if(el)el.textContent=age(lastFlight.t);}
    },15000);
  }
  toast.addEventListener('click',function(){
    if(lastFlight&&lastFlight.key)fitToLatest(lastFlight.key,lastFlight.gsid);
  });

  function buildACPopup(a,lat,lon,hdg){
    var fl=a.flight||a.reg||a.key;
    var d=distKm(lat,lon);
    return'<div style="font-size:12px;letter-spacing:1px;color:rgba(120,240,120,0.95)">'+fl+'</div>'
    +'<div style="margin-top:4px;display:flex;align-items:center;gap:5px;">'
    +'<span style="font-size:10px;color:rgba(255,160,0,0.55);">Signal:</span>'
    +sigMeterHTML(a.sig_level)
    +(a.sig_level?'<span style="font-size:9px;color:rgba(255,160,0,0.40);">'+a.sig_level.toFixed(1)+' dBFS</span>':'')
    +'</div>'
    +'<div style="margin-top:4px;font-size:10px;color:rgba(255,160,0,0.65);">'
    +(a.alt_valid&&a.alt_ft?Math.round(a.alt_ft).toLocaleString()+' ft &middot; ':'')
    +(a.gnd_spd_kts?Math.round(a.gnd_spd_kts)+' kts &middot; ':'')
    +(a.freq_khz?(a.freq_khz/1000).toFixed(3)+' MHz':'')+'</div>'
    +'<div style="margin-top:3px;font-size:10px;color:rgba(255,160,0,0.5);">'
    +(gsNames[a.gs_id]?'via '+gsNames[a.gs_id]+'<br>':'')
    +(d?d+' km &middot; ':'')+age(a.last_seen*1000)+'</div>';
  }

  // skin _fetchGS — fields: gs_id, location, frequencies[{freq_khz,enabled}],
  // last_sig_level, last_heard
  function fetchGS(){
    fetch(BASE+'/addon/hfdl/groundstations').then(function(r){if(!r.ok)throw 0;return r.json();}).then(function(data){
      (Array.isArray(data)?data:[]).forEach(function(s){
        var id=s.gs_id;
        var name=s.location||('GS '+id);
        if(s.lat==null||s.lon==null)return;
        gsNames[id]=name;
        var freqs=s.frequencies||[];
        var sig=(s.last_sig_level&&s.last_sig_level!==0)?s.last_sig_level:null;
        var lastHeard=s.last_heard||0;
        var sigLine;
        if(sig){
          sigLine=sigMeterHTML(sig)+'<span style="font-size:9px;color:rgba(255,160,0,0.40);margin-left:3px;">'+sig.toFixed(1)+' dBFS</span>';
        }else if(lastHeard>0){
          var el=Math.floor(Date.now()/1000-lastHeard),elStr;
          if(el<60)elStr=el+'s ago';else if(el<3600)elStr=Math.floor(el/60)+'m ago';
          else if(el<86400)elStr=Math.floor(el/3600)+'h '+Math.floor((el%3600)/60)+'m ago';
          else elStr=Math.floor(el/86400)+'d ago';
          sigLine='<span style="font-size:9px;color:rgba(255,80,60,0.70);">&#10005; No sig &mdash; last '+elStr+'</span>';
        }else{
          sigLine='<span style="font-size:9px;color:rgba(180,80,60,0.55);">&#10005; Never heard</span>';
        }
        var ph='<div style="font-size:12px;letter-spacing:1px;color:rgba(255,200,80,0.9)">'+name+'</div>'
          +'<div style="margin-top:4px;display:flex;align-items:center;gap:6px;">'
          +'<span style="font-size:10px;color:rgba(255,160,0,0.55);">Signal:</span>'+sigLine+'</div>';
        if(freqs.length){
          ph+='<div style="margin-top:6px;">';
          freqs.forEach(function(f){
            var k=f.freq_khz||0,en=f.enabled!==false;
            ph+='<div style="margin:3px 0;display:flex;align-items:center;gap:5px;">'
            +'<span style="color:'+(en?'rgba(255,180,60,0.9)':'rgba(180,120,30,0.45)')+';min-width:66px;font-size:11px;">'+(k?(k/1000).toFixed(3)+' MHz':'?')+'</span>'
            +(en?'<span style="color:rgba(80,220,80,0.7);font-size:9px;">&#9679; ON</span>':'<span style="color:rgba(255,80,80,0.35);font-size:9px;">&#9675; off</span>')
            +'</div>';
          });
          ph+='</div>';
        }else{
          ph+='<div style="color:rgba(255,160,0,0.35);font-size:10px;margin-top:4px;">No frequencies listed</div>';
        }
        if(gsM[id]){
          gsM[id].setPopupContent(ph);
          if(gsM[id]._sig!==sig){
            gsM[id]._sig=sig;
            gsM[id].setIcon(icon(gsSVG(glowGS===id,sig),30,36,15,36));
            if(glowGS===id){try{gsM[id].getElement().classList.add('pulse-gs');}catch(e){}}
          }
        }else{
          var mk=L.marker([s.lat,s.lon],{icon:icon(gsSVG(glowGS===id,sig),30,36,15,36),zIndexOffset:500});
          mk._sig=sig;
          mk.addTo(map).bindPopup(ph,{maxWidth:240});
          gsM[id]=mk;
        }
      });
      stat.textContent='live';
      if(pendingFit){var pf=pendingFit;pendingFit=null;fitToLatest(pf.acKey,pf.gsid);}
    }).catch(function(){stat.textContent='hfdl addon unavailable';});
  }

  // skin _fetchAC — latest flight detection → toast + glow + snap
  function fetchAC(){
    fetch(BASE+'/addon/hfdl/aircraft').then(function(r){if(!r.ok)throw 0;return r.json();}).then(function(data){
      var ac=Array.isArray(data)?data:[];
      cnt.textContent='✈ '+ac.length;
      var latest=null;
      ac.forEach(function(a){
        if(a.lat==null||a.lon==null)return;
        if(!latest||a.last_seen>latest.last_seen)latest=a;
      });
      if(latest){
        var cs=latest.flight||latest.reg||latest.key||'???';
        var tsMs=latest.last_seen*1000;
        if(!lastFlight||tsMs>lastFlight.t){
          lastFlight={cs:cs,gs:gsNames[latest.gs_id]||'',t:tsMs,key:latest.key,
                      gsid:latest.gs_id!=null?latest.gs_id:null};
          showToast();
          glowGSfn(latest.gs_id!=null?latest.gs_id:null);
          glowACfn(latest.key);
          if(snapOn)pendingFit={acKey:latest.key,gsid:latest.gs_id!=null?latest.gs_id:null};
        }
      }
      var cur={};
      ac.forEach(function(a){
        if(!a.key||a.lat==null||a.lon==null)return;
        cur[a.key]=1;
        var hdg=(a.true_trk_valid&&a.true_trk_deg!=null)?a.true_trk_deg:(a.bearing||0);
        var pop=buildACPopup(a,a.lat,a.lon,hdg);
        // icon signature: only swap the icon when its rendering changes —
        // otherwise setLatLng alone rides the CSS transition (GPU glide)
        var sig=acColour(a.last_seen,glowAC===a.key)+'|'+Math.round(hdg/3);
        if(acM[a.key]){
          acM[a.key].setLatLng([a.lat,a.lon]);
          acM[a.key]._d={bearing:hdg,last_seen:a.last_seen};
          if(acM[a.key]._sigr!==sig){
            acM[a.key]._sigr=sig;
            acM[a.key].setIcon(icon(acSVG(glowAC===a.key,hdg,a.last_seen),26,26,13,13));
            if(glowAC===a.key){try{acM[a.key].getElement().classList.add('pulse-ac');}catch(e){}}
          }
          if(acM[a.key].getPopup())acM[a.key].setPopupContent(pop);
        }else{
          var mk=L.marker([a.lat,a.lon],{icon:icon(acSVG(glowAC===a.key,hdg,a.last_seen),26,26,13,13)});
          mk._d={bearing:hdg,last_seen:a.last_seen};
          mk._sigr=sig;
          mk.addTo(map).bindPopup(pop,{maxWidth:220});
          acM[a.key]=mk;
        }
      });
      Object.keys(acM).forEach(function(k){
        if(!cur[k]){try{map.removeLayer(acM[k]);}catch(e){}delete acM[k];if(glowAC===k)glowAC=null;}
      });
      fetchGS();
    }).catch(function(){stat.textContent='hfdl addon unavailable';});
  }
  fetchAC();
  setInterval(fetchAC,5000);
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
    <Modal
      visible
      transparent={false}
      animationType="slide"
      onRequestClose={onClose}
      supportedOrientations={['portrait', 'portrait-upside-down', 'landscape-left', 'landscape-right']}
    >
      <View style={mo.root}>
        <View style={[mo.titleBar, {
          paddingTop: insets.top + 6,
          paddingLeft: Math.max(14, insets.left),
          paddingRight: Math.max(14, insets.right),
        }]}>
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
    paddingBottom: 8,
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
