// The shell's side of the secrets-controller core (server/core.js): an ordinary network path, with
// integrity from signatures at both ends — every answer from the core is checked against the core's key
// before it is shown or signed, and every answer from the phone is signed by its Secure Enclave key.
import CryptoKit
import Foundation
import LocalAuthentication
import Security

struct SignedDoc: Codable { let payload: String; let sig: String }

enum CoreError: LocalizedError {
  case badSignature, http(String), mismatch(String), noKey(String)
  var errorDescription: String? {
    switch self {
    case .badSignature: return "The core's signature didn't check out — refusing to continue."
    case .http(let s): return s
    case .mismatch(let s): return "The core's challenge doesn't match what you chose (\(s)) — refusing to sign."
    case .noKey(let s): return s
    }
  }
}

struct StoreInfo: Codable, Identifiable, Hashable { let name: String; let keys: Int; let sensitive: Bool; var id: String { name } }
struct ImageInfo: Codable, Hashable { let hash: String; let builtAt: String; let label: String }
struct StartedMachine: Codable, Hashable { let id: String; let imageHash: String; let encryptionKey: String; let signingKey: String }

final class Core {
  static let shared = Core()
  let base: URL = {
    let s = (Bundle.main.object(forInfoDictionaryKey: "JarvisBase") as? String).flatMap { $0.isEmpty ? nil : $0 } ?? "http://127.0.0.1:18080/"
    return URL(string: s.hasSuffix("/") ? s : s + "/")!
  }()

  // ---- the core's public key (mock: learned on first use; setup is undesigned) ----
  private var coreKey: P256.Signing.PublicKey?
  private func key() async throws -> P256.Signing.PublicKey {
    if let coreKey { return coreKey }
    let d = UserDefaults.standard
    let raw: String
    if let stored = d.string(forKey: "core.key") { raw = stored }
    else {
      let j: [String: String] = try await get("core/key")
      guard let k = j["key"] else { throw CoreError.http("no core key") }
      d.set(k, forKey: "core.key"); raw = k
    }
    guard let data = Data(base64Encoded: raw) else { throw CoreError.badSignature }
    let k = try P256.Signing.PublicKey(x963Representation: data)
    coreKey = k
    return k
  }

  /// the payload of a document only if the core signed it
  func verified<T: Decodable>(_ doc: SignedDoc, as type: T.Type) async throws -> T {
    let k = try await key()
    guard let sig = Data(base64Encoded: doc.sig), let s = try? P256.Signing.ECDSASignature(derRepresentation: sig),
          k.isValidSignature(s, for: Data(doc.payload.utf8)) else { throw CoreError.badSignature }
    return try JSONDecoder().decode(T.self, from: Data(doc.payload.utf8))
  }

  // ---- network ----
  private func get<T: Decodable>(_ path: String) async throws -> T {
    let (data, resp) = try await URLSession.shared.data(from: base.appendingPathComponent(path))
    return try decode(data, resp)
  }
  func post<T: Decodable>(_ path: String, _ body: [String: Any]) async throws -> T {
    var r = URLRequest(url: base.appendingPathComponent(path))
    r.httpMethod = "POST"; r.setValue("application/json", forHTTPHeaderField: "Content-Type")
    r.httpBody = try JSONSerialization.data(withJSONObject: body)
    r.timeoutInterval = 30
    let (data, resp) = try await URLSession.shared.data(for: r)
    return try decode(data, resp)
  }
  private func decode<T: Decodable>(_ data: Data, _ resp: URLResponse) throws -> T {
    let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
    if code != 200 {
      // the core signs its errors too; show the message either way
      let msg = (try? JSONDecoder().decode(SignedDoc.self, from: data)).flatMap { try? JSONSerialization.jsonObject(with: Data($0.payload.utf8)) as? [String: Any] }?["error"] as? String
      throw CoreError.http(msg ?? "HTTP \(code)")
    }
    return try JSONDecoder().decode(T.self, from: data)
  }

  // ---- primitives ----
  struct StoresPayload: Decodable { let kind: String; let nonce: String; let stores: [StoreInfo]; let image: ImageInfo }
  func stores() async throws -> StoresPayload {
    let nonce = UUID().uuidString
    let p = try await verified(try await post("core/stores", ["nonce": nonce]) as SignedDoc, as: StoresPayload.self)
    guard p.kind == "stores", p.nonce == nonce else { throw CoreError.badSignature }
    return p
  }

  struct StartedPayload: Decodable { let kind: String; let machine: StartedMachine }
  func start() async throws -> StartedMachine {
    let p = try await verified(try await post("core/start", [:]) as SignedDoc, as: StartedPayload.self)
    guard p.kind == "started" else { throw CoreError.badSignature }
    return p.machine
  }

  struct Options: Codable, Hashable { let harness: String }
  struct Request: Decodable { let kind: String; let machine: StartedMachine; let stores: [String]; let sensitive: [String]; let options: Options; let image: ImageInfo }
  struct Challenge: Decodable { let kind: String; let nonce: String; let request: Request }
  /// a new line (predecessor null); returns the signed challenge and its checked contents
  func succession(machine: StartedMachine, stores: [String], harness: String) async throws -> (SignedDoc, Challenge) {
    let doc: SignedDoc = try await post("core/succession", ["predecessor": NSNull(), "machine": machine.id, "stores": stores, "options": ["harness": harness]])
    let c = try await verified(doc, as: Challenge.self)
    guard c.kind == "challenge" else { throw CoreError.badSignature }
    return (doc, c)
  }

  struct Cert: Decodable { let kind: String; let machine: StartedMachine; let stores: [String] }
  struct RespondAnswer: Decodable { let cert: SignedDoc; let id: String }
  func respond(challenge: SignedDoc, signature: Data, phoneKey: Data, session: [String: Any]) async throws -> String {
    let a: RespondAnswer = try await post("core/respond", [
      "challenge": ["payload": challenge.payload, "sig": challenge.sig],
      "phoneKey": phoneKey.base64EncodedString(), "phoneSig": signature.base64EncodedString(), "session": session,
    ])
    let cert = try await verified(a.cert, as: Cert.self)
    guard cert.kind == "succession-cert" else { throw CoreError.badSignature }
    return a.id
  }
}

/// The phone's signing key: made inside the Secure Enclave (Face ID on every use). The simulator has no
/// Enclave, so there the mock falls back to a software key — the UI says so.
final class PhoneKey {
  static let shared = PhoneKey()
  private let tag = "dev.de0ch.jarvis2.phone-signing"
  var usesEnclave: Bool { SecureEnclave.isAvailable }

  private func loadBlob() -> Data? {
    let q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: tag, kSecAttrAccount as String: usesEnclave ? "se" : "sw", kSecReturnData as String: true]
    var out: CFTypeRef?
    return SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess ? out as? Data : nil
  }
  private func saveBlob(_ d: Data) {
    let q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: tag, kSecAttrAccount as String: usesEnclave ? "se" : "sw", kSecValueData as String: d, kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly]
    SecItemAdd(q as CFDictionary, nil)
  }

  /// sign `payload` (one Face ID) → (DER signature, public key X9.63)
  func sign(_ payload: String, reason: String) async throws -> (Data, Data) {
    if usesEnclave {
      let ctx = LAContext()
      ctx.localizedReason = reason
      let k: SecureEnclave.P256.Signing.PrivateKey
      if let blob = loadBlob() { k = try SecureEnclave.P256.Signing.PrivateKey(dataRepresentation: blob, authenticationContext: ctx) }
      else {
        var err: Unmanaged<CFError>?
        guard let ac = SecAccessControlCreateWithFlags(nil, kSecAttrAccessibleWhenUnlockedThisDeviceOnly, [.privateKeyUsage, .biometryAny], &err) else { throw CoreError.noKey("no access control") }
        k = try SecureEnclave.P256.Signing.PrivateKey(accessControl: ac, authenticationContext: ctx)
        saveBlob(k.dataRepresentation)
      }
      let s = try k.signature(for: Data(payload.utf8))
      return (s.derRepresentation, k.publicKey.x963Representation)
    }
    let k: P256.Signing.PrivateKey
    if let blob = loadBlob(), let x = try? P256.Signing.PrivateKey(rawRepresentation: blob) { k = x }
    else { k = P256.Signing.PrivateKey(); saveBlob(k.rawRepresentation) }
    let s = try k.signature(for: Data(payload.utf8))
    return (s.derRepresentation, k.publicKey.x963Representation)
  }
}
