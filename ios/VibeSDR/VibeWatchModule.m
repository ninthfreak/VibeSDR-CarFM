#import <React/RCTBridgeModule.h>
#import <React/RCTEventEmitter.h>

@interface RCT_EXTERN_MODULE (VibeWatchModule, RCTEventEmitter)

RCT_EXTERN_METHOD(isReachable
                  : (RCTPromiseResolveBlock)resolve rejecter
                  : (RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(sendRow
                  : (NSString *)rowB64 freq
                  : (nonnull NSNumber *)freq span
                  : (nonnull NSNumber *)span snr
                  : (nonnull NSNumber *)snr level
                  : (nonnull NSNumber *)level lo
                  : (nonnull NSNumber *)lo hi
                  : (nonnull NSNumber *)hi)

RCT_EXTERN_METHOD(sendState
                  : (nonnull NSNumber *)freq mode
                  : (NSString *)mode step
                  : (nonnull NSNumber *)step volume
                  : (nonnull NSNumber *)volume)

RCT_EXTERN_METHOD(sendSettings
                  : (NSString *)lutB64 smoothing
                  : (nonnull NSNumber *)smoothing needle
                  : (NSString *)needle needleIntensity
                  : (nonnull NSNumber *)needleIntensity sharpness
                  : (nonnull NSNumber *)sharpness)

@end
