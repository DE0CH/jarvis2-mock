import Foundation

/// Exported by the shell; called by the extension. Anything may ask to ENTER secure mode — there is
/// deliberately no call to leave it: only the shell's own code does.
@objc(HostService) public protocol HostService {
  func requestSecureMode(_ options: String)
  func report(_ line: String)
}

/// Exported by the extension. The shell calls `hello` right after connecting: an XPC connection only
/// reaches the other side with its first message.
@objc(ExtensionService) public protocol ExtensionService {
  func hello(_ reply: @escaping (String) -> Void)
}
