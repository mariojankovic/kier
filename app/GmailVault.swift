import Foundation
import Security
import CryptoKit

// A fresh static-code object checks sealed resources, including daemon JavaScript,
// on every use. Pin the launch CDHash so even a valid replacement requires restart.
final class GmailRuntimeSeal {
  private let bundle: URL
  private let requirement: SecRequirement
  private let launchHash: Data
  private static func inspect(_ bundle: URL, _ requirement: SecRequirement) throws -> Data {
    var code: SecStaticCode?
    var info: CFDictionary?
    let flags = SecCSFlags(rawValue: kSecCSStrictValidate | kSecCSCheckAllArchitectures | kSecCSCheckNestedCode)
    guard SecStaticCodeCreateWithPath(bundle as CFURL, [], &code) == errSecSuccess, let code,
          SecStaticCodeCheckValidity(code, flags, requirement) == errSecSuccess,
          SecCodeCopySigningInformation(code, SecCSFlags(rawValue: kSecCSSigningInformation), &info) == errSecSuccess,
          let details = info as? [String: Any], let hash = details[kSecCodeInfoUnique as String] as? Data
    else { throw URLError(.noPermissionsToReadFile) }
    return hash
  }
  init(bundle: URL, requirement: SecRequirement, node: URL, daemon: URL) throws {
    let resources = bundle.appendingPathComponent("Contents/Resources").resolvingSymlinksInPath()
    guard node.resolvingSymlinksInPath() == resources.appendingPathComponent("runtime/node"),
          daemon.resolvingSymlinksInPath() == resources.appendingPathComponent("daemon/bin/kier.mjs")
    else { throw URLError(.noPermissionsToReadFile) }
    self.bundle = bundle
    self.requirement = requirement
    launchHash = try Self.inspect(bundle, requirement)
  }
  func verify() throws {
    guard try Self.inspect(bundle, requirement) == launchHash else { throw URLError(.noPermissionsToReadFile) }
  }
}

// This service is reachable only through pipes inherited by our own daemon.
// There is no credential CLI mode, listener, token file or diagnostic payload.
final class GmailVault: @unchecked Sendable {
  private let replies = DispatchQueue(label: "com.getkier.gmail-replies")
  private let service: String
  private let bundled: Bool
  private var runtime: GmailRuntimeSeal?
  init(directory: String, bundled: Bool) {
    self.bundled = bundled
    let digest = SHA256.hash(data: Data(directory.utf8)).map { String(format: "%02x", $0) }.joined()
    service = "com.getkier.gmail." + digest.prefix(16) + (bundled ? ".native-v2" : ".development-v1")
  }
  // Called immediately before launching the exact process receiving our pipes.
  func prepareForLaunch(node: URL, daemon: URL) throws {
    guard bundled else { throw URLError(.noPermissionsToReadFile) }
    var code: SecCode?
    var staticCode: SecStaticCode?
    var info: CFDictionary?
    var requirement: SecRequirement?
    guard SecCodeCopySelf([], &code) == errSecSuccess, let code,
          SecCodeCopyStaticCode(code, [], &staticCode) == errSecSuccess, let staticCode,
          SecCodeCopySigningInformation(staticCode, SecCSFlags(rawValue: kSecCSSigningInformation), &info) == errSecSuccess,
          let details = info as? [String: Any],
          details[kSecCodeInfoIdentifier as String] as? String == "com.getkier.kier",
          let team = details[kSecCodeInfoTeamIdentifier as String] as? String, !team.isEmpty,
          SecCodeCopyDesignatedRequirement(staticCode, [], &requirement) == errSecSuccess, let requirement
    else { throw URLError(.noPermissionsToReadFile) }
    _ = google
    runtime = try GmailRuntimeSeal(bundle: Bundle.main.bundleURL, requirement: requirement, node: node, daemon: daemon)
  }
  private func trustedAccess() throws -> SecAccess {
    var code: SecCode?
    var info: CFDictionary?
    var staticCode: SecStaticCode?
    guard SecCodeCopySelf([], &code) == errSecSuccess, let code,
          SecCodeCheckValidity(code, [], nil) == errSecSuccess,
          SecCodeCopyStaticCode(code, [], &staticCode) == errSecSuccess, let staticCode,
          SecCodeCopySigningInformation(staticCode, SecCSFlags(rawValue: kSecCSSigningInformation), &info) == errSecSuccess,
          let details = info as? [String: Any],
          details[kSecCodeInfoIdentifier as String] as? String == "com.getkier.kier",
          let team = details[kSecCodeInfoTeamIdentifier as String] as? String, !team.isEmpty,
          let path = Bundle.main.executablePath else { throw URLError(.noPermissionsToReadFile) }
    var app: SecTrustedApplication?
    var access: SecAccess?
    guard SecTrustedApplicationCreateFromPath(path, &app) == errSecSuccess, let app,
          SecAccessCreate("Kier Gmail" as CFString, [app] as CFArray, &access) == errSecSuccess,
          let access else { throw URLError(.noPermissionsToReadFile) }
    return access
  }
  private func credential(_ operation: String, token: String? = nil) throws -> String {
    let access = try trustedAccess()
    // Never offer another process an interactive grant to this credential.
    SecKeychainSetUserInteractionAllowed(false)
    let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service, kSecAttrAccount as String: bundled ? "refresh" : "development-refresh"]
    switch operation {
    case "get":
      var value: CFTypeRef?
      let status = SecItemCopyMatching(query.merging([kSecReturnData as String: true]) { _, b in b } as CFDictionary, &value)
      if status == errSecItemNotFound { return "" }
      guard status == errSecSuccess, let data = value as? Data,
            let result = String(data: data, encoding: .utf8) else { throw URLError(.noPermissionsToReadFile) }
      return result
    case "set":
      guard let token, !token.isEmpty, token.utf8.count <= 8192,
            token.range(of: "^[A-Za-z0-9._~+/-]+$", options: .regularExpression) != nil else { throw URLError(.badURL) }
      // Delete then create so every new credential receives exactly our signed application's ACL.
      let deleted = SecItemDelete(query as CFDictionary)
      guard deleted == errSecSuccess || deleted == errSecItemNotFound else { throw URLError(.noPermissionsToReadFile) }
      let attributes = query.merging([kSecValueData as String: Data(token.utf8), kSecAttrAccess as String: access]) { _, b in b }
      guard SecItemAdd(attributes as CFDictionary, nil) == errSecSuccess else { throw URLError(.noPermissionsToReadFile) }
      return ""
    case "delete":
      let status = SecItemDelete(query as CFDictionary)
      guard status == errSecSuccess || status == errSecItemNotFound else { throw URLError(.noPermissionsToReadFile) }
      return ""
    default: throw URLError(.unsupportedURL)
    }
  }
  private lazy var google = NativeGoogleSession(
    clientID: Bundle.main.object(forInfoDictionaryKey: "KierGoogleClientID") as? String ?? "",
    credential: { [unowned self] operation, token in try self.credential(operation, token: token) })
  func perform(_ operation: String) async throws -> [String: Any] {
    // Reject credential requests before any Keychain access, even from a replaced runtime.
    guard ["status", "connect", "disconnect", "access"].contains(operation), bundled,
          let runtime else { throw URLError(.noPermissionsToReadFile) }
    try runtime.verify()
    return try await google.perform(operation)
  }
  func serve(output: FileHandle, input: FileHandle) {
    DispatchQueue(label: "com.getkier.gmail-vault").async {
      var buffer = Data()
      while true {
        let chunk = output.availableData
        if chunk.isEmpty { return }
        buffer.append(chunk)
        if buffer.count > 65536 { buffer.removeAll(); continue }
        while let end = buffer.firstIndex(of: 10) {
          let line = Data(buffer[..<end]); buffer.removeSubrange(...end)
          guard let text = String(data: line, encoding: .utf8), text.hasPrefix("KIER_VAULT ") else {
            FileHandle.standardOutput.write(line + Data([10])); continue
          }
          // Protocol frames, including malformed ones, are never forwarded to logs.
          guard let json = text.dropFirst(11).data(using: .utf8),
                let request = try? JSONSerialization.jsonObject(with: json) as? [String: String],
                let id = request["id"], let operation = request["operation"] else { continue }
          Task {
            var response: [String: Any] = ["id": id]
            do { response["value"] = try await self.perform(operation); response["ok"] = true }
            catch { response["ok"] = false }
            if let data = try? JSONSerialization.data(withJSONObject: response) {
              self.replies.sync { try? input.write(contentsOf: data + Data([10])) }
            }
          }
        }
      }
    }
  }
}
