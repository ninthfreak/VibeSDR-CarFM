#!/usr/bin/env python3
"""Measure the ACTUAL IQ sample rate at a given decimation. Settles the question
of whether decimation 0 means maximumSampleRate or maximumBandwidth."""
import socket, struct, sys, time
HOST, PORT = "192.168.86.99", 5555
VER = 0x020006A4
def cmd(t, body): return struct.pack("<II", t, len(body)) + body
def setting(i, v): return cmd(2, struct.pack("<II", i, v))

for decim in (0, 1):
    s = socket.socket(); s.settimeout(6)
    try: s.connect((HOST, PORT))
    except Exception as e: print("connect failed (SDR# still holding the slot?):", e); sys.exit(0)
    s.sendall(cmd(0, struct.pack("<I", VER) + b"VibeSDR-rate"))
    time.sleep(0.4)
    dev = None
    try:
        d = s.recv(65536)
        if not d: print("closed after hello — server busy or no radio"); sys.exit(0)
        pid, mt, st, sq, bl = struct.unpack_from("<IIIII", d, 0)
        if mt == 0:
            f = struct.unpack_from("<12I", d, 20)
            dev = f
    except Exception as e:
        print("no device info:", e); sys.exit(0)
    if dev: print(f"maximumSampleRate={dev[2]:,}  maximumBandwidth={dev[3]:,}")

    for m in (setting(1,0), setting(100,1), setting(102,decim), setting(101,96600000),
              setting(0,1), setting(2,20), setting(103,0), setting(1,1)):
        s.sendall(m)
    # Count IQ payload bytes for 4 seconds.
    t0=time.time(); iq=0; buf=b""
    while time.time()-t0 < 4.0:
        try: d=s.recv(1<<16)
        except socket.timeout: break
        if not d: break
        buf += d
        while len(buf) >= 20:
            pid,mt,st,sq,bl = struct.unpack_from("<IIIII", buf, 0)
            if len(buf) < 20+bl: break
            if st == 1: iq += bl
            buf = buf[20+bl:]
    s.close()
    dt = time.time()-t0
    sps = iq/2/dt   # uint8 => 2 bytes per IQ sample
    print(f"decim={decim}: {iq/dt/1e6:.2f} MB/s -> {sps:,.0f} samples/s   "
          f"(2.4M/2^{decim} = {2400000/2**decim:,.0f}; 2.0M/2^{decim} = {2000000/2**decim:,.0f})")
    time.sleep(0.5)
