import Foundation

private final class Fixture: @unchecked Sendable {
  var token = "fixture-refresh", events: [String] = []
  var expires: Double = 3600, scope = "https://www.googleapis.com/auth/gmail.readonly"
  var offline = false, paused: CheckedContinuation<Void, Never>?
  var pause = false
  func credential(_ op: String, _ value: String?) throws -> String {
    events.append(op)
    switch op {
    case "get": return token
    case "set": token = value!; return ""
    case "delete": token = ""; return ""
    default: fatalError("Unexpected credential operation")
    }
  }
  func request(_ path: String, _ fields: [String: String]) async throws -> [String: Any] {
    events.append(path)
    if offline { throw URLError(.notConnectedToInternet) }
    if path == "revoke" { return [:] }
    if pause { await withCheckedContinuation { paused = $0 } }
    if fields["grant_type"] == "authorization_code" {
      precondition(fields["code_verifier"]!.count >= 43)
      return ["refresh_token": "fixture-new-refresh"]
    }
    precondition(fields["refresh_token"] == "fixture-refresh")
    return ["access_token": "fixture-access", "expires_in": expires, "token_type": "Bearer", "scope": scope]
  }
  func session(deny: Bool = false) -> NativeGoogleSession {
    NativeGoogleSession(clientID: "fixture-client", credential: credential, request: request, authorize: { url, state in
      let fields = URLComponents(url: url, resolvingAgainstBaseURL: false)!.queryItems!
      precondition(fields.first { $0.name == "scope" }?.value == "https://www.googleapis.com/auth/gmail.readonly")
      precondition(fields.first { $0.name == "code_challenge_method" }?.value == "S256")
      precondition(fields.first { $0.name == "code_challenge" }!.value!.count == 43)
      return "http://127.0.0.1:12345/oauth/callback?state=\(state)&\(deny ? "error=access_denied" : "code=fixture-code")"
    })
  }
}
@main struct NativeGoogleTest {
  static func rejected(_ body: () async throws -> Void) async {
    do { try await body(); fatalError("Expected rejection") } catch {}
  }
  static func main() async throws {
    let f = Fixture(), service = f.session()
    for op in ["get", "set", "legacy-get", "delete", "legacy-delete"] {
      await rejected { _ = try await service.perform(op) }
    }
    precondition(f.events.isEmpty) // 1: no credential access for forbidden operations
    let access = try await service.perform("access")
    precondition(access.count == 2 && access["accessToken"] as? String == "fixture-access") // 2
    let expiry = access["expiresAt"] as! Double
    precondition(expiry <= Date().timeIntervalSince1970 * 1000 + 3600000) // 3
    for seconds in [0.0, -1, 3601, Double.infinity] {
      f.expires = seconds; await rejected { _ = try await service.perform("access") }
    } // 4
    f.expires = 3600; f.scope = "https://mail.google.com/"
    await rejected { _ = try await service.perform("access") } // 5
    f.scope = "https://www.googleapis.com/auth/gmail.readonly"
    let connected = try await service.perform("connect")
    precondition(f.token == "fixture-new-refresh" && connected["connected"] as? Bool == true)
    precondition(!String(describing: connected).contains(f.token)) // 6
    let status = try await service.perform("status")
    precondition(status["generation"] as? String == connected["generation"] as? String) // 7
    f.offline = true
    let disconnected = try await service.perform("disconnect")
    precondition(f.token.isEmpty && disconnected["revoked"] as? Bool == false) // 8
    // Each public operation starts a fresh session and can access only native storage.
    for op in ["status", "access", "connect", "disconnect"] {
      let fresh = Fixture()
      _ = try await fresh.session().perform(op)
      let expected = ["status": ["get"], "access": ["get", "token"],
                      "connect": ["token", "set"], "disconnect": ["get", "delete", "revoke"]]
      precondition(fresh.events == expected[op]!)
    } // 9: no migration, legacy reads, deletes or revocations
    let denied = Fixture()
    await rejected { _ = try await denied.session(deny: true).perform("connect") }
    precondition(!denied.events.contains("set")) // 10
    let racing = Fixture(), raceService = racing.session()
    racing.pause = true
    let refreshing = Task { try await raceService.perform("access") }
    while racing.paused == nil { await Task.yield() }
    _ = try await raceService.perform("disconnect")
    racing.paused?.resume()
    await rejected { _ = try await refreshing.value } // 11
    let late = Fixture(), lateService = late.session()
    late.pause = true
    let connecting = Task { try await lateService.perform("connect") }
    while late.paused == nil { await Task.yield() }
    _ = try await lateService.perform("disconnect")
    late.paused?.resume()
    await rejected { _ = try await connecting.value }
    precondition(late.token.isEmpty && !late.events.contains("set")) // 12
    print("12 native Google checks passed")
  }
}
