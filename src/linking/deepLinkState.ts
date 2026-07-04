/**
 * deepLinkState — a tiny module-scoped flag shared between the deep-link
 * handler and the instance picker.
 *
 * When a `vibesdr://` link owns the launch (cold or warm start), the handler
 * resets the nav stack to the linked SDR. That reset remounts InstancePicker,
 * whose own load effect would otherwise auto-connect to the user's DEFAULT
 * instance and stomp the link's target (link flashes, then reverts to default).
 * The picker checks this flag to suppress that default auto-connect.
 */

let active = false;

/** Mark that a deep link is driving this launch (suppress default auto-connect). */
export function markDeepLinkActive() { active = true; }

/** True while a deep link owns the session. */
export function isDeepLinkActive() { return active; }
