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

import { getLogoDataUri, getDarkTreatment, saveDarkLogo, clearDarkLogo } from '../stationDb';
import { processLogoForDark, hexToUnitRgb, treatmentToEnum, type Treatment } from './adapt';

/** Create or refresh the cached dark variant for `base` on background `bgHex`.
 *  Keeps a user override when possible, else stores the pipeline's auto-pick.
 *  Clears the cache if the station has no logo; leaves any prior cache intact if
 *  the logo can't be decoded (render falls back to the white plate). */
export async function regenerateDarkLogo(base: string, bgHex: string): Promise<void> {
  try {
    const uri = await getLogoDataUri(base);
    if (!uri) { await clearDarkLogo(base); return; }

    const res = await processLogoForDark(uri, hexToUnitRgb(bgHex));
    if (!res) return;   // decode/process failed — keep whatever was cached before

    const prior = await getDarkTreatment(base, bgHex);
    let treatment: Treatment = res.pick;
    let chosen = false;
    if (prior?.chosen) {
      const keep = res.candidates.find((c) => treatmentToEnum(c.treatment) === prior.treatment);
      if (keep) { treatment = keep.treatment; chosen = true; }
    }

    const cand = res.candidates.find((c) => c.treatment === treatment) ?? res.candidates[0];
    await saveDarkLogo(base, bgHex, treatmentToEnum(cand.treatment), cand.pngBase64, chosen);
  } catch {
    /* never let logo adaptation break a save */
  }
}
