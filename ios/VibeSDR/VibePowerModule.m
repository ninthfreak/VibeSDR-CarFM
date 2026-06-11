#import <React/RCTBridgeModule.h>
#import <React/RCTEventEmitter.h>

@interface RCT_EXTERN_MODULE(VibePowerModule, RCTEventEmitter)
RCT_EXTERN_METHOD(startAudioEngine:(NSString *)baseUrl frequency:(NSInteger)frequency mode:(NSString *)mode uuid:(NSString *)uuid)
RCT_EXTERN_METHOD(stopAudioEngine)
RCT_EXTERN_METHOD(revive)
RCT_EXTERN_METHOD(sendTuneCommand:(NSInteger)frequency mode:(NSString *)mode)
RCT_EXTERN_METHOD(sendBandwidth:(NSInteger)low high:(NSInteger)high)
RCT_EXTERN_METHOD(setStep:(NSInteger)hz)
RCT_EXTERN_METHOD(setInstanceName:(NSString *)name)
RCT_EXTERN_METHOD(setMuted:(BOOL)muted)
RCT_EXTERN_METHOD(setVolume:(double)volume)
RCT_EXTERN__BLOCKING_SYNCHRONOUS_METHOD(getDebugInfoSync)
@end
