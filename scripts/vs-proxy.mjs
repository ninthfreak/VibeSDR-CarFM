/**
 * vs-proxy.mjs — transparent TCP proxy in front of a VibeServer, with WebSocket
 * frame decoding.
 *
 *   node scripts/vs-proxy.mjs 192.168.86.134:48000 [listenPort]
 *   then point the browser at http://<mac-ip>:48555
 *
 * Everything (the page, the WebSockets, the auth) passes through untouched — the
 * PIN handshake still works, because we relay bytes verbatim. We just also DECODE
 * the WebSocket TEXT frames in both directions and log them with timestamps, so
 * the control conversation is visible: what the client asks for (tune/zoom/
 * sampleRate/…) and what the server answers (config/hwinfo/rds).
 *
 * Binary frames (SPEC, audio) are counted, not dumped — with a per-second rate, so
 * a stall or a burst shows up as a gap in the timeline.
 *
 * This is a DEBUG TOOL. It adds latency; tear it down afterwards.
 */

import net from 'node:net';

const target = (process.argv[2] || '192.168.86.134:48000').split(':');
const HOST = target[0];
const PORT = Number(target[1] || 48000);
const LISTEN = Number(process.argv[3] || 48555);

const t0 = Date.now();
const ts = () => ((Date.now() - t0) / 1000).toFixed(2).padStart(7);

/** Decode WS frames out of a byte stream. Returns leftover bytes. */
function makeFrameReader(label, onText, onBinary) {
  let buf = Buffer.alloc(0);
  return (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      if (buf.length < 2) return;
      const opcode = buf[0] & 0x0f;
      const masked = (buf[1] & 0x80) !== 0;
      let len = buf[1] & 0x7f;
      let off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      const maskLen = masked ? 4 : 0;
      if (buf.length < off + maskLen + len) return;
      const mask = masked ? buf.subarray(off, off + 4) : null;
      const payload = Buffer.from(buf.subarray(off + maskLen, off + maskLen + len));
      if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
      buf = buf.subarray(off + maskLen + len);
      if (opcode === 0x1) onText(payload.toString('utf8'));
      else if (opcode === 0x2) onBinary(payload);
    }
  };
}

// Per-second binary counters, so a stall shows as a gap.
const counters = new Map();
function count(key, bytes) {
  const c = counters.get(key) || { n: 0, bytes: 0 };
  c.n++; c.bytes += bytes;
  counters.set(key, c);
}
setInterval(() => {
  const parts = [];
  for (const [k, c] of counters) {
    parts.push(`${k}=${c.n}/s ${(c.bytes / 1024).toFixed(0)}KB/s`);
    counters.set(k, { n: 0, bytes: 0 });
  }
  if (parts.length) console.log(`${ts()}  ·  ${parts.join('  ')}`);
}, 1000);

let connId = 0;

net.createServer((client) => {
  const id = ++connId;
  const server = net.connect(PORT, HOST);
  let path = '?';
  let upgraded = false;
  let headBuf = Buffer.alloc(0);

  let readClient = null;
  let readServer = null;

  client.on('data', (d) => {
    if (!upgraded) {
      headBuf = Buffer.concat([headBuf, d]);
      const s = headBuf.toString('latin1');
      const m = s.match(/^(GET|POST) ([^ ]+)/);
      if (m) path = m[2].split('?')[0];
      if (s.includes('\r\n\r\n')) {
        if (/upgrade:\s*websocket/i.test(s)) {
          console.log(`${ts()}  #${id} WS OPEN  ${path}`);
        } else {
          console.log(`${ts()}  #${id} HTTP     ${path}`);
        }
      }
    } else if (readClient) {
      readClient(d);   // decode for the log — but STILL FORWARD (see below)
    }
    // ALWAYS forward. An early `return` here after parsing meant the server never
    // received a single client frame: no tunes, no pings, no pongs, no configs —
    // and it looked exactly like a server-side bug.
    server.write(d);
  });

  server.on('data', (d) => {
    if (!upgraded) {
      const s = d.toString('latin1');
      if (s.startsWith('HTTP/1.1 101')) {
        upgraded = true;
        const tag = path.includes('audio') ? 'aud' : path.includes('spectrum') ? 'spec' : path.includes('dx') ? 'dx' : 'ws';
        readClient = makeFrameReader('C', (t) => {
          console.log(`${ts()}  #${id} ${tag} C→S  ${t.slice(0, 220)}`);
        }, () => {});
        readServer = makeFrameReader('S', (t) => {
          console.log(`${ts()}  #${id} ${tag} S→C  ${t.slice(0, 220)}`);
        }, (p) => count(tag, p.length));
      } else if (s.startsWith('HTTP/1.1')) {
        console.log(`${ts()}  #${id} ${s.split('\r\n')[0]}  ${path}`);
      }
    } else if (readServer) { readServer(d); }
    client.write(d);
  });

  const bye = () => { client.destroy(); server.destroy(); };
  client.on('error', bye);
  server.on('error', bye);
  client.on('close', bye);
  server.on('close', bye);
}).listen(LISTEN, () => {
  console.log(`proxy  http://localhost:${LISTEN}  ->  ${HOST}:${PORT}`);
  console.log('point the browser at the proxy; the PIN still works (bytes are relayed verbatim)');
});
