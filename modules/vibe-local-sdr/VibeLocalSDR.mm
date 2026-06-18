// VibeLocalSDR — iOS native module (ObjC++) bridging the shared C++ local-SDR
// shim to React Native as `NativeModules.VibeLocalSDR`, mirroring the Android
// Kotlin module so the existing JS works unchanged. iOS supports the RTL-TCP path
// only (no USB host SDR); USB methods (startSpectrum/listDevices/openAndProbe)
// reject. The DSP/shim lives in libvibelocalsdr_ios.a (+ volk/fftw3f/zstd).
#import <React/RCTBridgeModule.h>
#import <Foundation/Foundation.h>
#include <string>
#include <vector>
#include "local_sdr_shim.h"

@interface VibeLocalSDR : NSObject <RCTBridgeModule>
@end

@implementation VibeLocalSDR

RCT_EXPORT_MODULE();

+ (BOOL)requiresMainQueueSetup { return NO; }

static double numOr(NSDictionary *o, NSString *k, double dflt) {
  id v = o[k]; return [v isKindOfClass:[NSNumber class]] ? [v doubleValue] : dflt;
}

// ── RTL-TCP ─────────────────────────────────────────────────────────────────
RCT_EXPORT_METHOD(startTcp:(NSDictionary *)opts
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject) {
  NSString *host = opts[@"host"];
  if (![host isKindOfClass:[NSString class]] || host.length == 0) {
    reject(@"no_host", @"host required", nil); return;
  }
  int port = (int)numOr(opts, @"port", 1234);
  double centerFreq = numOr(opts, @"centerFreq", 14100000.0);
  double sampleRate = numOr(opts, @"sampleRate", 2400000.0);
  int gain          = opts[@"gainTenthDb"] ? (int)numOr(opts, @"gainTenthDb", -1) : -1;
  int fftSize       = (int)numOr(opts, @"fftSize", 1024);
  double fftRate    = numOr(opts, @"fftRate", 20.0);
  NSString *mode    = [opts[@"mode"] isKindOfClass:[NSString class]] ? opts[@"mode"] : @"nfm";

  std::string err;
  int bound = vibe::LocalSdrShim::instance().startTcp(
      std::string(host.UTF8String), port, centerFreq, sampleRate, gain,
      fftSize, fftRate, std::string(mode.UTF8String), err);
  if (bound <= 0) {
    reject(@"start_failed",
           [NSString stringWithFormat:@"rtl_tcp %@:%d failed: %s", host, port, err.c_str()], nil);
    return;
  }
  resolve(@{ @"port": @(bound),
             @"wsBaseUrl": [NSString stringWithFormat:@"http://127.0.0.1:%d", bound] });
}

RCT_EXPORT_METHOD(stopSpectrum:(RCTPromiseResolveBlock)resolve
                      rejecter:(RCTPromiseRejectBlock)reject) {
  vibe::LocalSdrShim::instance().stop();
  resolve(nil);
}

// ── Decoder sidecar (Kiwi/OWRX FT8 etc.) ────────────────────────────────────
RCT_EXPORT_METHOD(startDecoderService:(RCTPromiseResolveBlock)resolve
                             rejecter:(RCTPromiseRejectBlock)reject) {
  std::string err;
  int port = vibe::LocalSdrShim::instance().startDecoderService(err);
  if (port <= 0) { reject(@"start_failed", [NSString stringWithUTF8String:err.c_str()], nil); return; }
  resolve(@(port));
}
RCT_EXPORT_METHOD(stopDecoderService) { vibe::LocalSdrShim::instance().stop(); }
RCT_EXPORT_METHOD(feedDecoderPcm:(NSString *)b64 rate:(nonnull NSNumber *)rate) {
  NSData *data = [[NSData alloc] initWithBase64EncodedString:b64 options:0];
  if (!data) return;
  int n = (int)(data.length / 2);
  if (n < 2) return;
  vibe::LocalSdrShim::instance().feedDecoderPcm((const int16_t *)data.bytes, n, rate.intValue);
}
RCT_EXPORT_METHOD(setDecoderFreq:(double)hz) { vibe::LocalSdrShim::instance().setDecoderFreq(hz); }

// ── Hardware controls ───────────────────────────────────────────────────────
RCT_EXPORT_METHOD(setGain:(double)g)            { vibe::LocalSdrShim::instance().setGain((int)g); }
RCT_EXPORT_METHOD(setPpm:(double)p)             { vibe::LocalSdrShim::instance().setPpm((int)p); }
RCT_EXPORT_METHOD(setBiasTee:(BOOL)on)          { vibe::LocalSdrShim::instance().setBiasTee(on); }
RCT_EXPORT_METHOD(setAgc:(BOOL)on)              { vibe::LocalSdrShim::instance().setAgc(on); }
RCT_EXPORT_METHOD(setDirectSampling:(double)m)  { vibe::LocalSdrShim::instance().setDirectSampling((int)m); }
RCT_EXPORT_METHOD(setSampleRate:(double)r)      { vibe::LocalSdrShim::instance().setSampleRate(r); }
RCT_EXPORT_METHOD(setDeemphasis:(double)tau)    { vibe::LocalSdrShim::instance().setDeemphasis(tau); }
RCT_EXPORT_METHOD(setSquelch:(BOOL)on db:(double)db) { vibe::LocalSdrShim::instance().setSquelch(on, (float)db); }
RCT_EXPORT_METHOD(setNR:(BOOL)on)               { vibe::LocalSdrShim::instance().setNR(on); }
RCT_EXPORT_METHOD(setNotch:(BOOL)on)            { vibe::LocalSdrShim::instance().setNotch(on); }
RCT_EXPORT_METHOD(setNrStrength:(double)s)      { vibe::LocalSdrShim::instance().setNrStrength((float)s); }
RCT_EXPORT_METHOD(getNrCpu:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject) {
  resolve(@(vibe::LocalSdrShim::instance().getNrCpu()));
}
RCT_EXPORT_METHOD(getTunerGains:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject) {
  std::vector<int> g = vibe::LocalSdrShim::instance().getTunerGains();
  NSMutableArray *out = [NSMutableArray arrayWithCapacity:g.size()];
  for (int v : g) [out addObject:@(v)];
  resolve(out);
}

// ── USB (Android-only) — reject on iOS ──────────────────────────────────────
RCT_EXPORT_METHOD(startSpectrum:(NSDictionary *)opts
                       resolver:(RCTPromiseResolveBlock)resolve
                       rejecter:(RCTPromiseRejectBlock)reject) {
  reject(@"unsupported", @"Local USB hardware is not available on iOS (use RTL-TCP)", nil);
}
RCT_EXPORT_METHOD(listDevices:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject) {
  resolve(@[]);
}

@end
