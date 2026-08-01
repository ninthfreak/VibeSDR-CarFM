/**
 * Tuner-source capabilities — what a source CAN tell us, not how to draw it.
 *
 * CarFM drives one face from several tuner sources: the head unit's built-in NWD
 * chip, an RTL-SDR dongle, and remote SDR servers. They differ in what they can
 * report, and those differences currently leak through the app as branches on
 * source IDENTITY — `nwdActive ? … : …` — in 59 places in RadioScreen, 21 in
 * SettingsPanel and 10 in CarFmFace.
 *
 * That doesn't scale past two sources: every new engine has to be taught to
 * every branch, and the UI ends up knowing each backend by name.
 *
 * THE RULE HERE — a source declares FACTS about itself. The app owns BEHAVIOUR
 * and decides what each fact means visually. A source never says "hide the
 * RadioText field" or "render the meter grey"; it says `radioText: 'unsupported'`
 * and `signal: 'estimated'`, and the face decides. Otherwise the tuner module
 * has to know CarFM's layout, and every new source inherits that burden.
 *
 * Every field below traces to a divergence we have actually hit on device. This
 * is deliberately not a speculative capability model — if a flag isn't backed by
 * a real difference in real hardware, it doesn't belong here yet.
 *
 * NOT YET WIRED. This file defines the vocabulary and the two profiles; the
 * existing branches still run. Migration is listed per-field below so it can be
 * done mechanically, one call site at a time, against a build that has been
 * device-verified.
 */

/** Which tuner is behind the face. */
export type TunerSourceId = 'nwd' | 'sdr';

export interface TunerCapabilities {
  readonly id: TunerSourceId;
  /** User-facing name. */
  readonly label: string;

  /**
   * Provenance of the signal level.
   *   'measured'  — a real level from the receiver; render live (amber + dB).
   *   'estimated' — computed, e.g. FCC DB + GPS; render as not-live (grey, "EST").
   *   'none'      — no level available at all; render empty.
   * MIGRATES: CarFmFace.tsx:1070-1072, which branches on `nwdActive` to pick
   * colour and to swap the dB readout for "EST".
   */
  readonly signal: 'measured' | 'estimated' | 'none';

  /**
   * RadioText availability.
   *   'live'        — RT arrives and can be displayed.
   *   'unsupported' — never arrives; the field should not occupy layout.
   * NWD is 'unsupported' on current evidence: ArmRadioManager.getRtMessage() is
   * a hardcoded `return ""`, and the Allwinner path gates RDS on
   * mcu_radio_area_current being 0 or 5. Revisit if probeNwdFmManager finds raw
   * groups on com.nwd.app.NwdFmManager — see BUILTIN-TUNER-FINDINGS.md.
   */
  readonly radioText: 'live' | 'unsupported';

  /**
   * How stereo state arrives.
   *   'live'      — readable at any time; trustworthy on demand.
   *   'on-change' — pushed ONLY when it changes, so it is unknown until the
   *                 first callback. This is why the pill has a blank state.
   *   'none'      — not reported.
   * MIGRATES: RadioScreen.tsx `fmStereo` init and the CarFmFace `stereo` prop,
   * which today encode 'on-change' implicitly as `boolean | null`.
   */
  readonly stereo: 'live' | 'on-change' | 'none';

  /**
   * Where station identity comes from.
   *   'rds-pi'       — the broadcast's own PI code; authoritative.
   *   'frequency-db' — looked up from the dial frequency (FCC DB + GPS), so it
   *                    fails without a location fix and can disagree with reality.
   * NWD exposes no getPI() over the AIDL, hence 'frequency-db'.
   */
  readonly stationIdentity: 'rds-pi' | 'frequency-db';

  /**
   * How long metadata takes to settle after a tune, in ms. Drives debounces so
   * a fringe station doesn't strobe the UI. A source with instant metadata
   * declares 0 and the same code does the right thing with no branch.
   * MIGRATES: the hardcoded 2000ms stereo debounce in RadioScreen.
   */
  readonly metadataSettleMs: number;

  /**
   * True when the source blanks the station name mid-retune, so the UI must
   * derive identity from the frequency rather than wait for a name.
   * MIGRATES: the commit-to-target hold behind the hero swap.
   */
  readonly dropsStationNameDuringTune: boolean;

  /**
   * Whether a per-channel lock/sync indication exists.
   * NWD is 'none': radioState is a global idle/active flag, not per-channel.
   * The "X when not locked" face design is blocked on this and stays unbuilt
   * while the only source says 'none'.
   */
  readonly lockState: 'reported' | 'none';

  /**
   * Who advances presets.
   *   'app'      — CarFM owns the list and the index.
   *   'external' — hardware also steps its own banks (the NWD steering wheel
   *                broadcast), so the app must reconcile rather than assume.
   */
  readonly presetStepping: 'app' | 'external';

  /**
   * Seek implementation.
   *   'hardware'   — the tuner scans and stops on a station.
   *   'station-db' — the app retunes to the next known station.
   */
  readonly seek: 'hardware' | 'station-db';

  /**
   * Channel spacing in Hz, or null when the source tunes continuously.
   * NWD is UNRESOLVED — NewRdsManager.transformFlagToFreq implies a 0.1 MHz
   * grid, but that is a preset-flag encoding, not proof of the tune step.
   */
  readonly tuneStepHz: number | null;
}

/**
 * The head unit's built-in NOWADA FM chip, over the com.nwd.radio.service AIDL.
 * Every value is evidenced in docs/BUILTIN-TUNER-FINDINGS.md.
 */
export const NWD_CAPABILITIES: TunerCapabilities = {
  id: 'nwd',
  label: 'Built-in FM radio',
  // No RSSI *yet*. getCurrentFrequency() returns 0, but that only rules out that
  // method as the source of the packed freq+strength int — an xref shows the sole
  // producer is NwdFmManager.seek(freq), whose return value AWNative.seek() splits
  // into frequency and strength. Untested because seek() commands the tuner rather
  // than reading it. See task #58.
  signal: 'estimated',
  // LIVE as of 2026-08-01 — not via the AIDL (getRtMessage() is still hardcoded
  // "" and RDS is still region-gated at mcu_radio_area_current=1), but by reading
  // raw groups off NwdFmManager.getRadioRDSDataArm() and decoding them ourselves.
  radioText: 'live',
  stereo: 'on-change',            // notifyStereo fires on change; isStreroOn() stuck true
  // PI is now decoded from block A of the raw groups, so this COULD be 'rds-pi'.
  // Left as-is because the callsign and logo lookup still resolves from frequency
  // + GPS; flip it when that is rewired, not before.
  stationIdentity: 'frequency-db',
  metadataSettleMs: 2000,
  dropsStationNameDuringTune: true,
  lockState: 'none',              // radioState is global, not per-channel
  presetStepping: 'external',     // the wheel drives the vendor service's own banks
  seek: 'hardware',               // search(), not seek() — seek nudges one step
  tuneStepHz: null,               // open: see task #52
};

/**
 * RTL-SDR dongle and remote SDR servers. These share a profile because the
 * differences that remain between them are SDR-shaped (profiles, zoom,
 * bandwidth) and already live in BackendCapabilities in SDRBackend.ts — this
 * descriptor covers only what the FACE needs to know.
 */
export const SDR_CAPABILITIES: TunerCapabilities = {
  id: 'sdr',
  label: 'SDR receiver',
  signal: 'measured',
  radioText: 'live',              // RdsDecoder produces PS/RT/RT+/PTY/TA/AF
  stereo: 'live',
  stationIdentity: 'rds-pi',
  metadataSettleMs: 0,
  dropsStationNameDuringTune: false,
  lockState: 'reported',
  presetStepping: 'app',
  seek: 'station-db',
  tuneStepHz: null,
};

/** Capabilities for the active source. */
export function tunerCapabilities(nwdActive: boolean): TunerCapabilities {
  return nwdActive ? NWD_CAPABILITIES : SDR_CAPABILITIES;
}
