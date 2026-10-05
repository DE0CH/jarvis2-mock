// React Native's only way to the shell: ask it to enter secure mode (with options that pre-fill its page).
// The shell tells React Native when it has left secure mode again (event "secureFinished").
#import <React/RCTBridgeModule.h>
#import <React/RCTEventEmitter.h>

@interface ShellBridge : RCTEventEmitter <RCTBridgeModule>
@end

@implementation ShellBridge {
  BOOL _observing;
}
RCT_EXPORT_MODULE();
+ (BOOL)requiresMainQueueSetup { return NO; }
- (NSArray<NSString *> *)supportedEvents { return @[@"secureFinished"]; }

- (instancetype)init
{
  if ((self = [super init])) {
    [[NSNotificationCenter defaultCenter] addObserver:self selector:@selector(shellEvent:) name:@"JarvisShellEvent" object:nil];
  }
  return self;
}
- (void)dealloc { [[NSNotificationCenter defaultCenter] removeObserver:self]; }
- (void)startObserving { _observing = YES; }
- (void)stopObserving { _observing = NO; }
- (void)shellEvent:(NSNotification *)n
{
  if (!_observing) return;
  [self sendEventWithName:n.userInfo[@"name"] body:n.userInfo[@"body"]];
}

RCT_EXPORT_METHOD(requestSecureMode:(NSString *)options)
{
  dispatch_async(dispatch_get_main_queue(), ^{
    [[NSNotificationCenter defaultCenter] postNotificationName:@"JarvisShellCall" object:nil
                                                      userInfo:@{@"method": @"secure", @"arg": options ?: @"{}"}];
  });
}
@end
