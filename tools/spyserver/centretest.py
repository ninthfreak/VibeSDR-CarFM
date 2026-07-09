#!/usr/bin/env python3
"""Do IQ and FFT centres move independently? SDR# sets them differently
(FFT=96.3M, IQ=96.6M), so they should. Confirm, and find where the server is
forced to retune the dongle underneath us."""
import socket, struct, time, sys
HOST,PORT="192.168.86.99",5555
VER=0x020006A4
def cmd(t,b): return struct.pack("<II",t,len(b))+b
def setting(i,v): return cmd(2,struct.pack("<II",i,v))
CS=["canControl","gain","deviceCenterFrequency","iqCenterFrequency","fftCenterFrequency",
    "minIQfc","maxIQfc","minFFTfc","maxFFTfc","reserved"]
s=socket.socket(); s.settimeout(5)
try: s.connect((HOST,PORT))
except Exception as e: print("connect failed:",e); sys.exit(0)
s.sendall(cmd(0,struct.pack("<I",VER)+b"VibeSDR-centre"))
buf=b""
def pump(sec=1.0):
    global buf
    t0=time.time(); syncs=[]
    while time.time()-t0<sec:
        try: d=s.recv(1<<16)
        except socket.timeout: break
        if not d: return None
        buf+=d
        while len(buf)>=20:
            pid,mt,st,sq,bl=struct.unpack_from("<IIIII",buf,0)
            if len(buf)<20+bl: break
            body=buf[20:20+bl]; buf=buf[20+bl:]
            if mt&0xffff==1 and bl>=40: syncs.append(struct.unpack("<10I",body[:40]))
    return syncs
sy=pump(1.0)
if sy is None or not sy: print("closed / busy (is VibeSDR or SDR# connected?)"); sys.exit(0)
print("initial:", {k:v for k,v in zip(CS,sy[-1])})

FFTC=96_300_000
for m in (setting(1,0),setting(100,1),setting(102,4),setting(201,FFTC),setting(200,1),
          setting(205,1024),setting(203,0),setting(204,140),setting(101,96_600_000),
          setting(0,5),setting(2,20),setting(103,0),setting(1,1)):
    s.sendall(m)
sy=pump(1.5)
if sy: print(f"\nafter FFT={FFTC/1e6}MHz IQ=96.6MHz:", {k:v for k,v in zip(CS,sy[-1])})

# Now walk the IQ centre far away and watch deviceCenterFrequency / fftCenter.
for iq in (95_600_000, 97_400_000, 99_000_000):
    s.sendall(setting(101, iq))
    sy=pump(1.0)
    if sy:
        d=dict(zip(CS,sy[-1]))
        print(f"  IQ->{iq/1e6:7.3f} MHz  device={d['deviceCenterFrequency']/1e6:8.3f}  "
              f"iq={d['iqCenterFrequency']/1e6:8.3f}  fft={d['fftCenterFrequency']/1e6:8.3f}")
    else:
        print(f"  IQ->{iq/1e6:7.3f} MHz  (no client_sync emitted)")
s.close()
print("\nIf fftCenterFrequency stays put while iqCenterFrequency moves, the two are independent")
print("and the wide-waterfall + narrow-IQ design works as intended.")
