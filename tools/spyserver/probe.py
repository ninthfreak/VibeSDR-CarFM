#!/usr/bin/env python3
"""Send a SpyServer hello and dump the reply.

Hello framing is CONFIRMED from a real SDR++ capture (c2s.bin):
  header: <u32 command_type=0><u32 body_size>
  body:   <u32 protocol_version><client name>
SDR++ sends the name with NO NUL terminator. We try that first, then a
NUL-terminated variant, so a silent server can't be confused with a bad hello.

A healthy server answers with device-info + client-sync. A server with no radio
accepts the hello and closes.
"""
import socket, struct, sys, time

HOST, PORT = sys.argv[1], int(sys.argv[2])
VERSION = 0x020006A4                      # 2.0.1700 — what SDR++ sends

def hello(name: bytes) -> bytes:
    body = struct.pack("<I", VERSION) + name
    return struct.pack("<II", 0, len(body)) + body

def attempt(label, payload):
    s = socket.socket(); s.settimeout(4)
    try:
        s.connect((HOST, PORT))
    except OSError as e:
        print(f"[{label}] connect failed: {e}"); return None
    s.sendall(payload)
    buf = b""
    end = time.time() + 4
    while time.time() < end and len(buf) < 8192:
        try:
            d = s.recv(65536)
        except socket.timeout:
            break
        if not d:
            print(f"[{label}] server CLOSED after hello -> no device (or hello rejected)")
            s.close(); return None
        buf += d
    s.close()
    if not buf:
        print(f"[{label}] server silent (held open)")
        return None
    print(f"[{label}] GOT {len(buf)} bytes")
    return buf

DEV = {0: "Invalid", 1: "Airspy One / Mini", 2: "Airspy HF+", 3: "RTL-SDR"}

def dump(buf):
    # Server messages use a 20-byte header, unlike the client's 8-byte one.
    off = 0
    while off + 20 <= len(buf):
        pid, mt, st, seq, bl = struct.unpack_from("<IIIII", buf, off)
        if pid >> 16 != 0x0200 or off + 20 + bl > len(buf):
            break
        body = buf[off+20: off+20+bl]
        low = mt & 0xFFFF
        if low == 0 and bl >= 48:
            f = struct.unpack("<12I", body[:48])
            ser = f[1]
            # Some devices put ASCII in the serial field.
            asc = ser.to_bytes(4, "little")
            ser_s = asc.decode() if all(32 <= c < 127 for c in asc) else f"0x{ser:08x}"
            print("  DEVICE INFO")
            print(f"    device            : {DEV.get(f[0], f'unknown({f[0]})')}")
            print(f"    serial            : {ser_s}")
            print(f"    max sample rate   : {f[2]:,} S/s")
            print(f"    max bandwidth     : {f[3]:,} Hz   (this is the FFT/waterfall span)")
            print(f"    decimation stages : {f[4]}   (min stage {f[10]})")
            print(f"    gain steps        : 0..{f[6]}")
            print(f"    frequency range   : {f[7]/1e6:,.3f} .. {f[8]/1e6:,.3f} MHz")
            print(f"    ADC resolution    : {f[9]} bits  -> use "
                  f"{'int16' if f[9] > 8 else 'uint8'} IQ")
            print(f"    forced IQ format  : {f[11] or 'none (client chooses)'}")
            lo = f[2] / (1 << f[4])
            print(f"    narrowest IQ rate : {lo:,.0f} S/s "
                  f"({lo * (2 if f[9] <= 8 else 4) / 1024:,.0f} KB/s)")
        elif low == 1 and bl >= 40:
            c = struct.unpack("<10I", body[:40])
            print("  CLIENT SYNC")
            print(f"    can control       : {'YES' if c[0] else 'NO (read-only: someone else holds the tuner)'}")
            print(f"    gain index        : {c[1]}")
            print(f"    device centre     : {c[2]/1e6:,.4f} MHz")
            print(f"    IQ centre         : {c[3]/1e6:,.4f} MHz")
            print(f"    FFT centre        : {c[4]/1e6:,.4f} MHz")
            print(f"    tunable range     : {c[5]/1e6:,.3f} .. {c[6]/1e6:,.3f} MHz")
        off += 20 + bl

for label, name in (("no-NUL (as SDR++)", b"VibeSDR-probe"),
                    ("NUL-terminated",    b"VibeSDR-probe\x00")):
    buf = attempt(label, hello(name))
    if buf:
        dump(buf)
        sys.exit(0)
    time.sleep(0.3)

print("\nNo reply to either hello form. Server has no usable device.")
sys.exit(1)
