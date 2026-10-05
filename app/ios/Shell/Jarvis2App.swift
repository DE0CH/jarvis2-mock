// Jarvis 2: a small native shell that owns the window. The whole Jarvis React Native UI runs in the
// bundled ExtensionKit extension (JarvisUI), in its own process, shown full-screen in normal mode. Anything
// may ask to ENTER secure mode (XPC requestSecureMode); only this shell's own code leaves it. In secure
// mode the extension's view is removed — it cannot draw or receive taps — and the shell shows its own
// sheet over a still snapshot of the app, so the switch looks seamless.
import ExtensionFoundation
import ExtensionKit
import SwiftUI

extension AppExtensionPoint {
  @Definition
  public static var jarvisUI: AppExtensionPoint {
    Name("jarvisUI")
    UserInterface()
  }
}

@main
struct Jarvis2App: App {
  var body: some Scene { WindowGroup { RootView() } }
}

enum Mode: Equatable { case normal, secure }

@Observable
final class Shell {
  var mode: Mode = .normal
  var secureOptions: [String: Any] = [:]
  var identity: AppExtensionIdentity?
  var snapshot: UIImage?
  var coverWithSnapshot = false
  var loadError: String?
  weak var hostVC: EXHostViewController?
  var lines: [String] = []
  private var monitor: AppExtensionPoint.Monitor?
  private let t0 = Date()

  func log(_ s: String) {
    let line = String(format: "%.1f ", Date().timeIntervalSince(t0)) + s
    NSLog("[shell] %@", line)
    lines.append(line)
  }

  /// the core's signed store list, fetched at launch so the secure sheet is filled at once (it is
  /// fetched again, with a fresh nonce, every time the sheet opens)
  var prefetched: Core.StoresPayload?

  func load() async {
    Task {
      let t = Date()
      do { prefetched = try await Core.shared.stores(); log(String(format: "core stores prefetched in %.2fs", Date().timeIntervalSince(t))) }
      catch { log("core stores prefetch failed: \(error.localizedDescription)") }
    }
    do {
      let m = try await AppExtensionPoint.Monitor(appExtensionPoint: .jarvisUI)
      monitor = m
      identity = m.identities.first
      log("extensions \(m.identities.count)")
    } catch {
      loadError = String(describing: error)
      log("monitor error \(error)")
    }
  }

  func captureSnapshot() {
    guard let v = hostVC?.view, v.bounds.width > 0 else { snapshot = nil; return }
    snapshot = UIGraphicsImageRenderer(bounds: v.bounds).image { _ in _ = v.drawHierarchy(in: v.bounds, afterScreenUpdates: false) }
  }

  /// anyone may ask (the extension, over XPC); the options only pre-fill the shell's sheet
  func enterSecure(_ optionsJSON: String) {
    guard mode == .normal else { return }
    let opts = (try? JSONSerialization.jsonObject(with: Data(optionsJSON.utf8))) as? [String: Any] ?? [:]
    guard (opts["kind"] as? String) == "new-session" else { log("secure request of unknown kind refused"); return }
    log("enter secure")
    secureOptions = opts
    captureSnapshot()
    withAnimation(.spring(duration: 0.4)) { mode = .secure }
  }

  /// only the shell's own code calls this
  func exitSecure(_ why: String) {
    log("exit secure: \(why)")
    coverWithSnapshot = snapshot != nil
    withAnimation(.spring(duration: 0.4)) { mode = .normal }
  }

  func extensionDidActivate() {
    guard coverWithSnapshot else { return }
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { withAnimation(.easeOut(duration: 0.15)) { self.coverWithSnapshot = false } }
  }
}

final class HostServiceImpl: NSObject, HostService {
  let shell: Shell
  init(shell: Shell) { self.shell = shell }
  func requestSecureMode(_ options: String) { DispatchQueue.main.async { [shell] in shell.enterSecure(options) } }
  func report(_ line: String) { DispatchQueue.main.async { [shell] in shell.log("ext: " + line) } }
}

struct RootView: View {
  @State private var shell = Shell()

  var body: some View {
    ZStack {
      Radix.background.ignoresSafeArea()
      if shell.mode == .normal {
        if let identity = shell.identity {
          ExtensionHost(identity: identity, shell: shell)
            .ignoresSafeArea()
            .accessibilityIdentifier("extension-host")
            .transition(.identity)
            .overlay {
              if shell.coverWithSnapshot, let img = shell.snapshot {
                Image(uiImage: img).resizable().ignoresSafeArea().allowsHitTesting(false)
              }
            }
        } else if let e = shell.loadError {
          Text(e).font(.footnote).foregroundStyle(Radix.red.a[11]).padding()
        }
      } else {
        // a still image of the app (shell-owned pixels), dimmed, under the shell's own sheet
        if let img = shell.snapshot {
          Image(uiImage: img).resizable().ignoresSafeArea().transition(.identity).accessibilityHidden(true)
        }
        Radix.overlay.ignoresSafeArea().transition(.opacity)
        SecureNewSession(shell: shell, options: shell.secureOptions)
          .clipShape(UnevenRoundedRectangle(topLeadingRadius: K.radius[6], topTrailingRadius: K.radius[6], style: .continuous))
          .padding(.top, 12)
          .ignoresSafeArea(edges: .bottom)
          .transition(.move(edge: .bottom))
      }
    }
    .task { await shell.load() }
  }
}

struct ExtensionHost: UIViewControllerRepresentable {
  let identity: AppExtensionIdentity
  let shell: Shell

  func makeCoordinator() -> Coordinator { Coordinator(shell: shell) }
  func makeUIViewController(context: Context) -> EXHostViewController {
    let vc = EXHostViewController()
    vc.delegate = context.coordinator
    vc.configuration = EXHostViewController.Configuration(appExtension: identity, sceneID: "main")
    shell.hostVC = vc
    return vc
  }
  func updateUIViewController(_ vc: EXHostViewController, context: Context) {}

  final class Coordinator: NSObject, EXHostViewControllerDelegate {
    let shell: Shell
    var connection: NSXPCConnection?
    init(shell: Shell) { self.shell = shell }

    func hostViewControllerDidActivate(_ viewController: EXHostViewController) {
      shell.extensionDidActivate()
      do {
        let c = try viewController.makeXPCConnection()
        c.exportedInterface = NSXPCInterface(with: HostService.self)
        c.exportedObject = HostServiceImpl(shell: shell)
        c.remoteObjectInterface = NSXPCInterface(with: ExtensionService.self)
        c.resume()
        connection = c
        // an XPC connection only reaches the other side with its first message
        (c.remoteObjectProxyWithErrorHandler { [shell] e in DispatchQueue.main.async { shell.log("xpc error \(e)") } } as? ExtensionService)?
          .hello { [shell] a in DispatchQueue.main.async { shell.log("xpc: \(a)") } }
      } catch {
        shell.log("xpc error \(error)")
      }
    }
    func hostViewControllerWillDeactivate(_ viewController: EXHostViewController, error: (any Error)?) {}
  }
}
