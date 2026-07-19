/**
 * SdrLinkHandler — parse the de-facto `sdr://host[:port]` SpyServer URI used by
 * SDR#, gqrx and the Airspy directory (<https://airspy.com/directory/>).
 *
 * Kept OUT of DeepLinkHandler.ts on purpose: that file is the `carfm://`
 * contract and shouldn't grow a second grammar. Pure logic, no UI — returns a
 * validated {host, port} or null. All input is untrusted; the caller toasts a
 * fixed string and only ever sees validated fields, never the raw URL.
 *
 * Grammar (brief §2):  sdr://<host>[:<port>]
 *   - scheme case-insensitive; host lowercased
 *   - port optional, defaults to 5555, range 1–65535
 *   - path/query/fragment after the authority are ignored, not a parse failure
 *   - bracketed IPv6 literals are rejected (Phase 1 out of scope)
 */

export interface SdrLinkTarget { host: string; port: number }

const MAX_URL_LEN  = 2048;
const DEFAULT_PORT = 5555;
// Hostname or IPv4 literal: dot-separated labels of [a-z0-9-], each starting and
// ending alphanumeric (kills hyphen-only labels, leading/trailing dots, and any
// host containing '/', '%' or whitespace). Total length 1–253.
const HOST_RE = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;

export function parseSdrUrl(raw: string): SdrLinkTarget | null {
  if (typeof raw !== 'string' || raw.length > MAX_URL_LEN) return null;

  // Authority = everything after `sdr://` up to the first '/', '?' or '#'
  // (trailing path/query/fragment junk is silently dropped, not rejected).
  const m = /^sdr:\/\/([^/?#]*)/i.exec(raw);
  if (!m) return null;
  const authority = m[1];
  if (!authority) return null;                              // sdr:// with no host
  if (authority.includes('[') || authority.includes(']')) return null; // IPv6 → out of scope

  let host = authority;
  let port = DEFAULT_PORT;
  const colon = authority.lastIndexOf(':');
  if (colon !== -1) {
    host = authority.slice(0, colon);
    const portStr = authority.slice(colon + 1);
    if (!/^\d{1,5}$/.test(portStr)) return null;
    port = parseInt(portStr, 10);
    if (port < 1 || port > 65535) return null;
  }

  host = host.toLowerCase();
  if (!HOST_RE.test(host)) return null;
  return { host, port };
}
