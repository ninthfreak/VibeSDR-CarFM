// Base64 <-> bytes with no dependencies (React Native lacks a reliable Buffer /
// atob for binary). Used for logo image blobs stored in / shared into the app.

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export function bytesToBase64(bytes: Uint8Array): string {
  let out = '';
  let i = 0;
  for (; i + 3 <= bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + B64[n & 63];
  }
  const rem = bytes.length - i;
  if (rem === 1) { const n = bytes[i] << 16; out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + '=='; }
  else if (rem === 2) { const n = (bytes[i] << 16) | (bytes[i + 1] << 8); out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + '='; }
  return out;
}

export function base64ToBytes(b64: string): Uint8Array {
  const s = b64.replace(/[^A-Za-z0-9+/]/g, '');
  const n = s.length;
  const out = new Uint8Array((n >> 2) * 3 + (n % 4 ? (n % 4) - 1 : 0));
  let o = 0, i = 0;
  for (; i + 4 <= n; i += 4) {
    const w = (B64.indexOf(s[i]) << 18) | (B64.indexOf(s[i + 1]) << 12)
      | (B64.indexOf(s[i + 2]) << 6) | B64.indexOf(s[i + 3]);
    out[o++] = (w >> 16) & 255; out[o++] = (w >> 8) & 255; out[o++] = w & 255;
  }
  const rem = n - i;
  if (rem === 2) { const w = (B64.indexOf(s[i]) << 18) | (B64.indexOf(s[i + 1]) << 12); out[o++] = (w >> 16) & 255; }
  else if (rem === 3) {
    const w = (B64.indexOf(s[i]) << 18) | (B64.indexOf(s[i + 1]) << 12) | (B64.indexOf(s[i + 2]) << 6);
    out[o++] = (w >> 16) & 255; out[o++] = (w >> 8) & 255;
  }
  return out;
}
