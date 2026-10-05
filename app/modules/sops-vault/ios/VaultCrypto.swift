// Decrypts one value of a sops file whose data key is also encrypted to this phone's age1tag1 recipient
// (a P-256 key held in the Secure Enclave). Platform-neutral: the only Enclave operation, the P-256
// key agreement, comes in as a closure, so this file also builds against swift-crypto on Linux, where
// tests/ checks it against files made by the real sops + age-plugin-tag.
//
// Formats (pinned against sops 3.13 / age 1.3, 2026-10-03):
//   sops.age[].enc  armored age file whose payload is the 32-byte sops data key
//   p256tag stanza  "-> p256tag <tag b64> <enc b64>" + body = HPKE(DHKEM-P256, HKDF-SHA256,
//                   ChaCha20-Poly1305, info "age-encryption.org/p256tag") of the age file key
//   value           ENC[AES256_GCM,data:…,iv:…(32 bytes),tag:…,type:str], AAD "<path joined by :>:"
#if canImport(CryptoKit)
import CryptoKit
#else
import Crypto
#endif
import Foundation

enum VaultError: Error, CustomStringConvertible {
  case format(String)
  case notForThisKey
  var description: String {
    switch self {
    case .format(let s): return "malformed sops data: \(s)"
    case .notForThisKey: return "this store isn't encrypted to this phone's key"
    }
  }
}

enum VaultCrypto {
  // MARK: recipient string (Bech32, HRP "age1tag", as age's plugin.EncodeRecipient)
  private static let charset = Array("qpzry9x8gf2tvdw0s3jn54khce6mua7l")
  private static func polymod(_ values: [UInt8]) -> UInt32 {
    let gen: [UInt32] = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3]
    var chk: UInt32 = 1
    for v in values {
      let b = chk >> 25
      chk = ((chk & 0x1ffffff) << 5) ^ UInt32(v)
      for i in 0..<5 where (b >> UInt32(i)) & 1 == 1 { chk ^= gen[i] }
    }
    return chk
  }
  static func recipient(compressedPublicKey key: Data) -> String {
    let hrp = Array("age1tag".utf8)
    var data: [UInt8] = [], acc: UInt32 = 0, bits = 0
    for byte in key {
      acc = (acc << 8) | UInt32(byte); bits += 8
      while bits >= 5 { bits -= 5; data.append(UInt8((acc >> UInt32(bits)) & 31)) }
    }
    if bits > 0 { data.append(UInt8((acc << UInt32(5 - bits)) & 31)) }
    let expanded = hrp.map { $0 >> 5 } + [0] + hrp.map { $0 & 31 }
    let mod = polymod(expanded + data + [0, 0, 0, 0, 0, 0]) ^ 1
    let checksum = (0..<6).map { UInt8((mod >> UInt32(5 * (5 - $0))) & 31) }
    return "age1tag1" + String((data + checksum).map { charset[Int($0)] })
  }

  // MARK: HKDF / HPKE helpers (RFC 5869, RFC 9180)
  private static func extract(salt: Data, ikm: Data) -> Data {
    Data(HMAC<SHA256>.authenticationCode(for: ikm, using: SymmetricKey(data: salt)))
  }
  private static func expand(prk: Data, info: Data, length: Int) -> Data {
    var out = Data(), t = Data(), counter: UInt8 = 1
    let key = SymmetricKey(data: prk)
    while out.count < length {
      t = Data(HMAC<SHA256>.authenticationCode(for: t + info + Data([counter]), using: key))
      out += t; counter += 1
    }
    return out.prefix(length)
  }
  private static let hpkeV1 = Data("HPKE-v1".utf8)
  private static let kemSuite = Data("KEM".utf8) + Data([0x00, 0x10])                         // DHKEM(P-256)
  private static let hpkeSuite = Data("HPKE".utf8) + Data([0x00, 0x10, 0x00, 0x01, 0x00, 0x03]) // + HKDF-SHA256 + ChaCha20Poly1305
  private static func labeledExtract(_ suite: Data, salt: Data, _ label: String, _ ikm: Data) -> Data {
    extract(salt: salt, ikm: hpkeV1 + suite + Data(label.utf8) + ikm)
  }
  private static func labeledExpand(_ suite: Data, prk: Data, _ label: String, _ info: Data, _ length: Int) -> Data {
    expand(prk: prk, info: Data([UInt8(length >> 8), UInt8(length & 0xff)]) + hpkeV1 + suite + Data(label.utf8) + info, length: length)
  }

  private static func b64(_ s: Substring) throws -> Data {
    var t = String(s); while t.count % 4 != 0 { t += "=" }
    guard let d = Data(base64Encoded: t) else { throw VaultError.format("bad base64") }
    return d
  }

  /// The sops data key from one `sops.age[].enc` armored age file.
  /// `ecdh(peer)` = the raw P-256 shared secret (x coordinate) of this phone's key with `peer` (65-byte X9.63).
  static func dataKey(armored: String, recipientX963: Data, ecdh: (Data) throws -> Data) throws -> Data {
    let body = armored.split(whereSeparator: \.isNewline)
      .filter { !$0.hasPrefix("-----") }.joined()
    guard let file = Data(base64Encoded: body) else { throw VaultError.format("age armor") }
    // header = everything up to and including the "---" of the MAC line
    guard let macAt = file.range(of: Data("\n--- ".utf8)) else { throw VaultError.format("age header") }
    let headerEnd = macAt.lowerBound + 1
    guard let lineEnd = file[macAt.upperBound...].firstIndex(of: 0x0a) else { throw VaultError.format("age mac line") }
    guard let header = String(data: file[..<headerEnd], encoding: .utf8) else { throw VaultError.format("age header text") }
    let macB64 = file[macAt.upperBound..<lineEnd]
    let payload = file[(lineEnd + 1)...]
    var lines = header.split(separator: "\n", omittingEmptySubsequences: false)[...]
    guard lines.popFirst() == "age-encryption.org/v1" else { throw VaultError.format("age version") }

    var fileKey: Data?
    while let line = lines.first, line.hasPrefix("-> ") {
      lines = lines.dropFirst()
      let args = line.dropFirst(3).split(separator: " ")
      var body = Data()
      while let l = lines.popFirst() { body += try b64(l); if l.count < 64 { break } }
      guard args.first == "p256tag", args.count == 3 else { continue }
      let enc = try b64(args[2])
      // DHKEM(P-256): shared_secret from dh(skR, pkE) and kem_context = enc || pkR
      let dh = try ecdh(enc)
      let eae = labeledExtract(kemSuite, salt: Data(), "eae_prk", dh)
      let shared = labeledExpand(kemSuite, prk: eae, "shared_secret", enc + recipientX963, 32)
      // key schedule, mode base, empty psk
      let info = Data("age-encryption.org/p256tag".utf8)
      let ctx = Data([0]) + labeledExtract(hpkeSuite, salt: Data(), "psk_id_hash", Data())
        + labeledExtract(hpkeSuite, salt: Data(), "info_hash", info)
      let secret = labeledExtract(hpkeSuite, salt: shared, "secret", Data())
      let key = labeledExpand(hpkeSuite, prk: secret, "key", ctx, 32)
      let nonce = labeledExpand(hpkeSuite, prk: secret, "base_nonce", ctx, 12)
      guard body.count > 16 else { throw VaultError.format("p256tag body") }
      let box = try ChaChaPoly.SealedBox(nonce: ChaChaPoly.Nonce(data: nonce), ciphertext: body.dropLast(16), tag: body.suffix(16))
      fileKey = try? ChaChaPoly.open(box, using: SymmetricKey(data: key))
      if fileKey != nil { break }
    }
    guard let fk = fileKey else { throw VaultError.notForThisKey }

    // header MAC
    let hmacKey = expand(prk: extract(salt: Data(), ikm: fk), info: Data("header".utf8), length: 32)
    let mac = Data(HMAC<SHA256>.authenticationCode(for: file[..<(headerEnd + 3)], using: SymmetricKey(data: hmacKey)))
    guard mac == (try b64(Substring(String(decoding: macB64, as: UTF8.self)))) else {
      throw VaultError.format("age header MAC")
    }
    // payload: 16-byte nonce, then STREAM chunks; a data key fits in the single (last) chunk
    guard payload.count > 16 + 16 else { throw VaultError.format("age payload") }
    let payloadKey = expand(prk: extract(salt: Data(payload.prefix(16)), ikm: fk), info: Data("payload".utf8), length: 32)
    let chunk = payload.dropFirst(16)
    var chunkNonce = Data(count: 12); chunkNonce[11] = 1
    let box = try ChaChaPoly.SealedBox(nonce: ChaChaPoly.Nonce(data: chunkNonce), ciphertext: chunk.dropLast(16), tag: chunk.suffix(16))
    return try ChaChaPoly.open(box, using: SymmetricKey(data: payloadKey))
  }

  /// One sops value, e.g. ENC[AES256_GCM,data:…,iv:…,tag:…,type:str] at path ["stringData", "FOO"].
  static func value(_ enc: String, dataKey: Data, path: [String]) throws -> String {
    guard enc.hasPrefix("ENC[AES256_GCM,"), enc.hasSuffix("]") else { throw VaultError.format("value") }
    var parts: [String: Substring] = [:]
    for p in enc.dropFirst("ENC[AES256_GCM,".count).dropLast().split(separator: ",") {
      if let i = p.firstIndex(of: ":") { parts[String(p[..<i])] = p[p.index(after: i)...] }
    }
    guard let d = parts["data"], let iv = parts["iv"], let tag = parts["tag"] else { throw VaultError.format("value fields") }
    let box = try AES.GCM.SealedBox(nonce: AES.GCM.Nonce(data: try b64(iv)), ciphertext: try b64(d), tag: try b64(tag))
    let plain = try AES.GCM.open(box, using: SymmetricKey(data: dataKey),
                                 authenticating: Data((path.joined(separator: ":") + ":").utf8))
    return String(decoding: plain, as: UTF8.self)
  }
}
