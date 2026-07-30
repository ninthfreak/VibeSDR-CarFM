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
console.log(fail?`\nlogoTrim: ${fail} FAILED`:'\nlogoTrim: ALL PASS');
process.exit(fail?1:0);
