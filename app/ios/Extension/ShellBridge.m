// React Native's only way to the shell: ask it to enter secure mode (with options that pre-fill its sheet).
#import <React/RCTBridgeModule.h>

@interface ShellBridge : NSObject <RCTBridgeModule>
@end

@implementation ShellBridge
RCT_EXPORT_MODULE();
+ (BOOL)requiresMainQueueSetup { return NO; }

RCT_EXPORT_METHOD(requestSecureMode:(NSString *)options)
{
  dispatch_async(dispatch_get_main_queue(), ^{
    [[NSNotificationCenter defaultCenter] postNotificationName:@"JarvisShellCall" object:nil
                                                      userInfo:@{@"method": @"secure", @"arg": options ?: @"{}"}];
  });
}
@end
