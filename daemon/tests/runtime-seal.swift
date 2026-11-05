import Foundation
import Security

@main struct RuntimeSealTest {
  static func main() async throws {
    let bundle = URL(fileURLWithPath: CommandLine.arguments[1])
    let node = bundle.appendingPathComponent("Contents/Resources/runtime/node")
    let daemon = bundle.appendingPathComponent("Contents/Resources/daemon/bin/kier.mjs")
    var requirement: SecRequirement?
    precondition(SecRequirementCreateWithString("identifier com.getkier.fixture" as CFString, [], &requirement) == errSecSuccess)
    func seal(_ runtime: URL? = nil) throws -> GmailRuntimeSeal {
      try GmailRuntimeSeal(bundle: bundle, requirement: requirement!, node: node, daemon: runtime ?? daemon)
    }
    func denied(_ block: () throws -> Void) {
      do { try block(); fatalError("Expected refusal") } catch {}
    }
    let launch = try seal()
    try launch.verify()
    denied { _ = try seal(URL(fileURLWithPath: "/tmp/checkout/bin/kier.mjs")) }
    try Data("modified JavaScript".utf8).write(to: daemon)
    denied { try launch.verify() }
    denied { _ = try seal() }
    // A correctly sealed replacement still cannot use the old launch's credential pipe.
    let sign = Process()
    sign.executableURL = URL(fileURLWithPath: "/usr/bin/codesign")
    sign.arguments = ["--force", "--sign", "-", bundle.path]
    try sign.run(); sign.waitUntilExit(); precondition(sign.terminationStatus == 0)
    denied { try launch.verify() }
    try seal().verify()
    precondition(SecRequirementCreateWithString("identifier com.getkier.other" as CFString, [], &requirement) == errSecSuccess)
    denied { _ = try seal() }
    // This fails before any Keychain operation, including legacy migration.
    let dev = GmailVault(directory: "/tmp/fixture", bundled: false)
    for operation in ["get", "set", "legacy-get", "delete", "legacy-delete"] {
      do { _ = try await dev.perform(operation); fatalError("Expected refusal") } catch {}
    }
    print("runtime seal checks passed")
  }
}
