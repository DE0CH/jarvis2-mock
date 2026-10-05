// The ExtensionKit extension that runs the whole Jarvis React Native UI, in its own process. It can ask
// the shell to enter secure mode (ShellBridge → HostLink → XPC); it can't leave it, and while it is up the
// shell has removed this extension's view.
import ExtensionFoundation
import ExtensionKit
import SwiftUI

struct JarvisUIConfiguration<E: JarvisUIExtensionProtocol>: AppExtensionConfiguration {
  let appExtension: E
  init(_ appExtension: E) { self.appExtension = appExtension }
  func accept(connection: NSXPCConnection) -> Bool { HostLink.shared.attach(connection); return true }
}

protocol JarvisUIExtensionProtocol: AppExtension {
  associatedtype Body: JarvisUIScene
  var body: Body { get }
}
protocol JarvisUIScene: AppExtensionScene {}

struct MainScene<Content: View>: JarvisUIScene {
  private let content: () -> Content
  init(content: @escaping () -> Content) { self.content = content }
  var body: some AppExtensionScene {
    PrimitiveAppExtensionScene(id: "main") { content() } onConnection: { connection in
      HostLink.shared.attach(connection)
      return true
    }
  }
}

extension JarvisUIExtensionProtocol {
  var configuration: AppExtensionSceneConfiguration { AppExtensionSceneConfiguration(self.body, configuration: JarvisUIConfiguration(self)) }
}

@main
final class JarvisUIExtension: JarvisUIExtensionProtocol {
  required init() { _ = HostLink.shared }
  @AppExtensionPoint.Bind
  var boundExtensionPoint: AppExtensionPoint { AppExtensionPoint.Identifier(host: "dev.de0ch.jarvis2", name: "jarvisUI") }
  var body: some JarvisUIScene { MainScene { RNContainer().ignoresSafeArea() } }
}

/// the extension's end of the XPC link; ShellBridge (ObjC, React Native) reaches it via NotificationCenter
final class HostLink: NSObject {
  static let shared = HostLink()
  private var connection: NSXPCConnection?
  private var pending: [(String, String)] = []

  override init() {
    super.init()
    NotificationCenter.default.addObserver(forName: Notification.Name("JarvisShellCall"), object: nil, queue: .main) { [weak self] n in
      self?.call(n.userInfo?["method"] as? String ?? "", n.userInfo?["arg"] as? String ?? "")
    }
  }

  func attach(_ c: NSXPCConnection) {
    c.remoteObjectInterface = NSXPCInterface(with: HostService.self)
    c.exportedInterface = NSXPCInterface(with: ExtensionService.self)
    c.exportedObject = ExtensionServiceImpl()
    c.resume()
    connection = c
    let q = pending; pending = []
    for (m, a) in q { call(m, a) }
  }

  func call(_ method: String, _ arg: String) {
    guard let c = connection else { pending.append((method, arg)); return }
    let proxy = c.remoteObjectProxyWithErrorHandler { e in NSLog("[ext] xpc error %@", String(describing: e)) } as? HostService
    if method == "secure" {
      RN.rootView.window?.endEditing(true) // cosmetic: no keyboard over the shell's snapshot
      proxy?.requestSecureMode(arg)
    } else {
      proxy?.report(arg)
    }
  }
}

final class ExtensionServiceImpl: NSObject, ExtensionService {
  func hello(_ reply: @escaping (String) -> Void) { reply("extension pid \(getpid())") }
}
