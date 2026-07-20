// Station logo lookup for the FM-DX tuner (v7, plan §2d).
//
// The Radio-Browser source has been REMOVED — it name-matched user-contributed
// internet streams and was useless for much of the US (wrong or missing logos).
// A logo-search rework is pending; until then `lookupStationLogo` has no source
// and returns null, so the tuner shows a monogram. The caller-facing API is kept
// so the new search can drop straight in.

/** DAB service labels arrive UNSPACED — the ensemble sends "BBC Radio2", not
 *  "BBC Radio 2" (verified on-air). Split the digits back off before display /
 *  lookup so name matching has real word tokens to work with. */
export function tidyStationName(s: string): string {
  return s.replace(/([A-Za-z])(\d)/g, '$1 $2').replace(/\s+/g, ' ').trim();
}

/** Resolve a station logo URL by name (+ optional ISO country). Currently always
 *  null — the source was removed pending the logo-search rework. */
export async function lookupStationLogo(
  _name: string, _iso?: string, _preferIso?: string,
): Promise<string | null> {
  return null;
}
