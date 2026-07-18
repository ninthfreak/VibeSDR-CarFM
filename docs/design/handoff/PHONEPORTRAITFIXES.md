# Handoff — Galaxy S21 portrait layout fixes

Scope: make the `tall` layout track hold up at the real Galaxy S21 aspect ratio.
No feature changes — prev/next preset cards and every other behavior are untouched.

## 1. Real device dimensions — `CarFmLive.dc.html`, `aspectDims()`

The two "Galaxy S" entries were invented placeholder sizes. Replaced with the
real S21 screen ratio (20:9, 1080×2400 → scaled representative dims).

```diff
- 'Galaxy S landscape':  { w: 1100, h: 508 },
- 'Galaxy S portrait':   { w: 470,  h: 1018 }
+ 'Galaxy S landscape':  { w: 1080, h: 486 },
+ 'Galaxy S portrait':   { w: 486,  h: 1080 }
```

Note: `tall` is still derived as `dims.w / dims.h < 1`, so the trigger logic is
unchanged — only the numbers moved. Portrait ratio went from ~0.46 to 0.45.

## 2. Vertical distribution in the `tall` track — `RadioFace.dc.html`, `renderVals()`

At the true 1080px height the hero band didn't grow while the preset grid was
bottom-anchored inside a growing band, so all the extra height collapsed into a
dead void between the hero and the presets. Fix: hero band grows and centers;
preset band becomes a fixed-height bottom block; grid aligns to the top of that block.

```diff
  heroBandStyle: {
-   flex: tall ? '0 0 auto' : 1, marginTop: tall ? 26 : 0,
-   display:'flex', flexDirection:'column',
+   flex: tall ? '1 1 auto' : 1, marginTop: tall ? 26 : 0,
+   display:'flex', flexDirection:'column',
+   justifyContent: tall ? 'center' : 'flex-start',
    gap: tall ? 12 : (twoRows ? 8 : 16), minHeight:0 },
```

```diff
  presetsBandStyle: {
    display:'flex', alignItems:'stretch', gap:12,
-   flex: tall ? '1 1 auto' : '0 0 auto',
+   flex: '0 0 auto',
    height: tall ? 'auto' : (twoRows ? 250 : (landscape ? 104 : 140)),
+   maxHeight: tall ? '46%' : 'none',
    minHeight:0, flexShrink:0, ... },
```

```diff
  presetGridStyle: tall
    ? { display:'grid', gridTemplateColumns:'repeat(3, 1fr)', gap:12,
-       alignContent:'end',
+       alignContent:'start',
        gridAutoRows:'min-content', overflowX:'hidden', overflowY:'auto',
        flex:1, height:'100%', padding:'3px 4px', boxSizing:'border-box',
        scrollbarWidth:'none' }
    : ...
```

## Not changed / verify
- Prev/next preset side-card peek (`wideHero`) is left exactly as it was — it
  renders in portrait as before.
- Wide tracks (Dudu7 full, ⅔ slice, Galaxy S landscape) use unchanged pixel
  heights; only the landscape ratio shifted slightly (2.16 → 2.22). Spot-check
  Galaxy S landscape.
- `maxHeight:'46%'` on the preset band is a heuristic for the phone; revisit if a
  longer preset list needs more room before scrolling.
