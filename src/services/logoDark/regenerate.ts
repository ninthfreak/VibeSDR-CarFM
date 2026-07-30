// regenerate.ts — the non-interactive "import hook". Bridges the DB (logo bytes
// in, dark variant out) and the pure pipeline, so a station always has an AUTO
// dark variant cached even before the user ever opens the treatment picker.
//
// Two callers:
//   • right after a logo is set (manual pick / resolver) → an AUTO variant so
//     dark mode looks right immediately;
//   • when the theme background changes → re-adapt for the new bg.
// The interactive picker (LogoTreatmentPicker) does NOT go through here — it runs
// processLogoForDark itself and saves the user's pick with chosen=true.
//
// A prior USER override (chosen=1) is respected: if that treatment is still among
// the candidates for the new run, we keep it; otherwise we fall back to the auto
// pick. Never throws.

import { readOriginalDataUri, getDarkInfo, putDark, clearDark } from '../logoStore';
import { prepareDarkLadder } from '../logoPrep';
import { processLogoForDark, hexToUnitRgb, treatmentToEnum, type Treatment } from './adapt';

/** Create or refresh the cached dark variant for `base`. `gateBg` is the dark
 *  surface the GATE composites onto to choose the auto-pick — the stored PNG
 *  itself is background-independent (paper is cleared to transparency). Keeps a
 *  user override when possible, else stores the pipeline's auto-pick. Clears the
 *  cache if the station has no logo; leaves any prior cache intact if the logo
 *  can't be decoded (render falls back to the white plate). */
export async function regenerateDarkLogo(base: string, gateBg: string): Promise<void> {
  try {
    const uri = await readOriginalDataUri(base);
    if (!uri) { await clearDark(base); return; }

    const res = await processLogoForDark(uri, hexToUnitRgb(gateBg));
    if (!res) return;   // decode/process failed — keep whatever was cached before

    const prior = await getDarkInfo(base);
    let treatment: Treatment = res.pick;
    let chosen = false;
    if (prior?.chosen) {
      const keep = res.candidates.find((c) => treatmentToEnum(c.treatment) === prior.treatment);
      if (keep) { treatment = keep.treatment; chosen = true; }
    }

    const cand = res.candidates.find((c) => c.treatment === treatment) ?? res.candidates[0];
    await putDark(base, treatmentToEnum(cand.treatment), cand.pngBase64, chosen);
    await prepareDarkLadder(base);
  } catch {
    /* never let logo adaptation break a save */
  }
}
