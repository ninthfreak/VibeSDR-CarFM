/**
 * deepLinkState — a tiny module-scoped flag shared between the deep-link
 * handler and the instance picker.
 *
 * When a `vibesdr://` link owns the launch (cold or warm start), the handler
 * resets the nav stack to the linked SDR. That reset remounts InstancePicker,
 * whose own load effect would otherwise auto-connect to the user's DEFAULT
 * instance and stomp the link's target (link flashes, then reverts to default).
 * The picker checks this flag to suppress that default auto-connect.
 *
 * COLD START is a race: `Linking.getInitialURL()` is async, so the flag is not
 * set at the instant the app mounts. The picker's own load path is also async
 * (AsyncStorage default + location), and it can reach its auto-connect decision
 * FIRST — sampling `isDeepLinkActive()` while it is still false and opening the
 * default instance. The link then arrives too late to matter.
 *
 * So the picker must not sample the flag; it must WAIT for the initial-URL probe
 * to answer. `whenInitialLinkChecked()` resolves once the handler has inspected
 * `getInitialURL()` (whatever the answer), making the decision deterministic
 * rather than dependent on which async chain wins.
 */

let active = false;

let markChecked: () => void;
const checked = new Promise<void>((resolve) => { markChecked = resolve; });

/** Mark that a deep link is driving this launch (suppress default auto-connect). */
export function markDeepLinkActive() { active = true; }

/** True while a deep link owns the session. */
export function isDeepLinkActive() { return active; }

/** Called once `getInitialURL()` has been inspected — link or no link. */
export function markInitialLinkChecked() { markChecked?.(); }

/**
 * Resolves once the cold-start link probe has answered, or after `timeoutMs` if
 * something goes wrong upstream. The timeout is a safety net, not the mechanism:
 * without it a failure to probe would hang the picker's auto-connect forever.
 */
export function whenInitialLinkChecked(timeoutMs = 2000): Promise<void> {
  return Promise.race([
    checked,
    new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
}
