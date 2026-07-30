// Regression test for the logo display-trim (services/logoPrep.ts markBounds).
// A web logo usually ships with baked-in margin; because every surface renders
// with Fit/contain, that margin is scaled along with the mark and the logo looks
// small in a correctly-sized box (ANDROID §4.5 "prep on assign"). This checks the
// crop fires on real margins and does NOT gut a solid-colour badge.
//
// markBounds/cropRaster are module-private on purpose, so the harness extracts
// them from the SHIPPED source rather than testing a copy.
import { readFileSync } from 'fs';
const src = readFileSync('/home/user/VibeSDR-CarFM/src/services/logoPrep.ts','utf8');
const consts = src.match(/const ALPHA_BG[\s\S]*?const BG_TOL = [^\n]*\n/)[0];
const mb = src.match(/function markBounds[\s\S]*?\n}\n/)[0];
const cr = src.match(/function cropRaster[\s\S]*?\n}\n/)[0];
const code=(consts+mb+cr).replace(/:\s*Raster/g,'').replace(/:\s*\{ x0[^}]*\}\s*\|\s*null/,'').replace(/:\s*number\[\]\[\]/g,'').replace(/:\s*number/g,'');
const fn=new Function(code+'\nreturn {markBounds,cropRaster};')();
function img(w,h,f){const rgba=new Uint8ClampedArray(w*h*4);for(let y=0;y<h;y++)for(let x=0;x<w;x++){const j=(y*w+x)*4;const c=f(x,y);rgba[j]=c[0];rgba[j+1]=c[1];rgba[j+2]=c[2];rgba[j+3]=c[3];}return{w,h,rgba};}
const RED=[200,30,40,255], WHITE=[255,255,255,255], CLEAR=[0,0,0,0];
const cases={
 'white margin':      img(400,400,(x,y)=> (x>=40&&x<=360&&y>=160&&y<=240)?RED:WHITE),
 'transparent margin':img(400,400,(x,y)=> (x>=40&&x<=360&&y>=160&&y<=240)?RED:CLEAR),
 'solid RED badge + white text': img(300,300,(x,y)=> (x>=90&&x<=210&&y>=130&&y<=170)?WHITE:RED),
 'black margin':      img(400,400,(x,y)=> (x>=40&&x<=360&&y>=160&&y<=240)?RED:[0,0,0,255]),
 'edge-to-edge mark': img(320,80,()=>RED),
};
// expected: [croppedW, croppedH] or null to mean "left alone"
const expect={
 'white margin':[321,81], 'transparent margin':[321,81], 'black margin':[321,81],
 'solid RED badge + white text':null, 'edge-to-edge mark':null,
};
let fail=0;
for(const [n,im] of Object.entries(cases)){
  const b=fn.markBounds(im);
  const t=b?fn.cropRaster(im,b.x0,b.y0,b.x1,b.y1):im;
  const gain=1-(t.w*t.h)/(im.w*im.h);
  const kept=!b||gain<0.02;                    // MIN_GAIN in logoPrep
  const e=expect[n];
  const ok=e===null?kept:(!kept&&t.w===e[0]&&t.h===e[1]);
  if(!ok)fail++;
  console.log(`${ok?'ok  ':'FAIL'} ${n.padEnd(30)} ${im.w}x${im.h} -> ${kept?'original kept':t.w+'x'+t.h}`);
}

// ── resampleRaster: the pre-rendered size ladder ───────────────────────────
const rsSrc = src.match(/export function resampleRaster[\s\S]*?\n}\n/)[0]
  .replace('export ','').replace(/:\s*Raster/g,'').replace(/:\s*number/g,'');
const resample = new Function(rsSrc+'\nreturn resampleRaster;')();
{
  // 1px stripes: area-averaging gives a flat mid grey; a single-tap sampler
  // (what Skia's decode scaler does) would alias to hard 0/255 bands.
  const w=512,h=64,rgba=new Uint8ClampedArray(w*h*4);
  for(let y=0;y<h;y++)for(let x=0;x<w;x++){const j=(y*w+x)*4;const v=(x%2)?255:0;rgba[j]=rgba[j+1]=rgba[j+2]=v;rgba[j+3]=255;}
  const o=resample({w,h,rgba},128);
  let min=255,max=0;
  for(let i=0;i<o.w*o.h;i++){const v=o.rgba[i*4];if(v<min)min=v;if(v>max)max=v;}
  const ok = o.w===128 && min>=120 && max<=136;
  if(!ok)fail++;
  console.log(`${ok?'ok  ':'FAIL'} resample antialiases stripes -> ${o.w}px, luma ${min}..${max}`);
}
{
  // Alpha-weighted: transparent padding must not darken the opaque mark.
  const w=256,h=256,rgba=new Uint8ClampedArray(w*h*4);
  for(let y=100;y<156;y++)for(let x=100;x<156;x++){const j=(y*w+x)*4;rgba[j]=255;rgba[j+3]=255;}
  const o=resample({w,h,rgba},64);
  const j=((32*o.w)+32)*4;
  const ok = o.rgba[j]===255 && o.rgba[j+3]===255;
  if(!ok)fail++;
  console.log(`${ok?'ok  ':'FAIL'} resample keeps mark colour over transparent padding rgba(${o.rgba[j]},${o.rgba[j+1]},${o.rgba[j+2]},${o.rgba[j+3]})`);
}

console.log(fail?`\nlogoTrim: ${fail} FAILED`:'\nlogoTrim: ALL PASS');
process.exit(fail?1:0);
