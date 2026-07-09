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

def dump(buf):
    print("\nraw:", buf[:96].hex(" "), "\n")
    off = 0
    while off + 8 <= len(buf):
        mtype, blen = struct.unpack_from("<II", buf, off)
        body = buf[off+8: off+8+blen]
        print(f"  msg type={mtype} (0x{mtype:08x}) body={blen}")
        if body:
            print(f"    hex : {body[:64].hex(' ')}")
            if blen % 4 == 0:
                u = struct.unpack("<" + "I"*(blen//4), body[:blen - blen % 4])
                print(f"    u32s: {list(u)}")
            printable = bytes(c if 32 <= c < 127 else 46 for c in body[:48])
            print(f"    ascii: {printable.decode()}")
        if blen == 0 or off + 8 + blen > len(buf):
            break
        off += 8 + blen

for label, name in (("no-NUL (as SDR++)", b"VibeSDR-probe"),
                    ("NUL-terminated",    b"VibeSDR-probe\x00")):
    buf = attempt(label, hello(name))
    if buf:
        dump(buf)
        sys.exit(0)
    time.sleep(0.3)

print("\nNo reply to either hello form. Server has no usable device.")
sys.exit(1)
