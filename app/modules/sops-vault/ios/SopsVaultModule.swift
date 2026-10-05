// The phone's vault key: a P-256 key made INSIDE the Secure Enclave (it never leaves it), usable only
// after Face ID. Its public half is an age1tag1 recipient listed in .sops.yaml, so every secret store is
// also encrypted to it. Only the key agreement runs in the Enclave; the store's data key and values are
// decrypted in app memory (VaultCrypto.swift) and live only as long as the screen showing them.
import CryptoKit
import ExpoModulesCore
import Foundation
import LocalAuthentication
import Security

private let keychainService = "dev.de0ch.jarvis.vault"
private let keychainAccount = "enclave-key"

// The Enclave key's dataRepresentation is an opaque blob only this phone's Enclave can use; it is kept
// in the Keychain (this device only, never backed up).
private func loadBlob() -> Data? {
  let q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: keychainService,
                          kSecAttrAccount as String: keychainAccount, kSecReturnData as String: true]
  var out: CFTypeRef?
  return SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess ? out as? Data : nil
}
private func deleteBlob() {
  let q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: keychainService,
                          kSecAttrAccount as String: keychainAccount]
  SecItemDelete(q as CFDictionary)
}
private func saveBlob(_ d: Data) throws {
  deleteBlob()
  let q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: keychainService,
                          kSecAttrAccount as String: keychainAccount, kSecValueData as String: d,
                          kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly]
  let st = SecItemAdd(q as CFDictionary, nil)
  guard st == errSecSuccess else { throw Exception(name: "Keychain", description: "saving the vault key failed (\(st))") }
}
private func key(context: LAContext? = nil) throws -> SecureEnclave.P256.KeyAgreement.PrivateKey? {
  guard let blob = loadBlob() else { return nil }
  return try SecureEnclave.P256.KeyAgreement.PrivateKey(dataRepresentation: blob, authenticationContext: context)
}
private func recipient(_ k: SecureEnclave.P256.KeyAgreement.PrivateKey) -> String {
  VaultCrypto.recipient(compressedPublicKey: k.publicKey.compressedRepresentation)
}

public class SopsVaultModule: Module {
  public func definition() -> ModuleDefinition {
    Name("SopsVault")

    Function("isAvailable") { SecureEnclave.isAvailable }

    // this phone's age1tag1 recipient, or null before a key was made (no Face ID needed: public half)
    Function("recipient") { () -> String? in try key().map(recipient) }

    AsyncFunction("createKey") { () -> String in
      guard SecureEnclave.isAvailable else { throw Exception(name: "NoEnclave", description: "this device has no Secure Enclave") }
      var err: Unmanaged<CFError>?
      guard let ac = SecAccessControlCreateWithFlags(nil, kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
                                                     [.privateKeyUsage, .biometryAny], &err) else {
        throw Exception(name: "AccessControl", description: String(describing: err?.takeRetainedValue()))
      }
      let k = try SecureEnclave.P256.KeyAgreement.PrivateKey(accessControl: ac)
      try saveBlob(k.dataRepresentation)
      return recipient(k)
    }

    AsyncFunction("deleteKey") { deleteBlob() }

    // values: {KEY: "ENC[...]"} under `prefix` (e.g. "stringData"); age: [{recipient, enc}] from the file's
    // sops metadata. One Face ID prompt per call. → {KEY: plaintext}
    AsyncFunction("decrypt") { (reason: String, prefix: String, values: [String: String], age: [[String: String]]) -> [String: String] in
      let ctx = LAContext()
      ctx.localizedReason = reason
      guard let k = try key(context: ctx) else { throw Exception(name: "NoKey", description: "this phone has no vault key yet") }
      let me = recipient(k)
      guard let entry = age.first(where: { $0["recipient"] == me }), let enc = entry["enc"] else {
        throw Exception(name: "NotEncrypted", description: "this store isn't encrypted to this phone's key yet")
      }
      let dataKey = try VaultCrypto.dataKey(armored: enc, recipientX963: k.publicKey.x963Representation) { peer in
        let s = try k.sharedSecretFromKeyAgreement(with: P256.KeyAgreement.PublicKey(x963Representation: peer))
        return s.withUnsafeBytes { Data($0) }
      }
      var out: [String: String] = [:]
      for (name, v) in values { out[name] = try VaultCrypto.value(v, dataKey: dataKey, path: [prefix, name]) }
      return out
    }
  }
}
