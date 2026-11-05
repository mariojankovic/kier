import Foundation
import CryptoKit
import Network
import AppKit

// This actor is the only owner of refresh credentials. Its replies are deliberately
// limited to connection state and a freshly minted, short-lived read-only token.
actor NativeGoogleSession {
  typealias Request = (String, [String: String]) async throws -> [String: Any]
  private let clientID: String
  private let credential: (String, String?) throws -> String
  private let request: Request
  private let authorize: (URL, String) async throws -> String
  private var epoch = UUID()
  private var connecting = false
  init(clientID: String, credential: @escaping (String, String?) throws -> String,
       request: @escaping Request = googleRequest,
       authorize: @escaping (URL, String) async throws -> String = GoogleLoopback.authorize) {
    self.clientID = clientID; self.credential = credential
    self.request = request; self.authorize = authorize
  }
  static func googleRequest(_ path: String, _ fields: [String: String]) async throws -> [String: Any] {
    guard ["token", "revoke"].contains(path) else { throw URLError(.badURL) }
    var request = URLRequest(url: URL(string: "https://oauth2.googleapis.com/" + path)!)
    request.httpMethod = "POST"; request.timeoutInterval = 15
    var form = URLComponents()
    form.queryItems = fields.map { URLQueryItem(name: $0.key, value: $0.value) }
    request.httpBody = form.percentEncodedQuery?.replacingOccurrences(of: "+", with: "%2B").data(using: .utf8)
    request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
    let config = URLSessionConfiguration.ephemeral
    config.httpCookieStorage = nil; config.urlCache = nil; config.connectionProxyDictionary = [:]
    let session = URLSession(configuration: config, delegate: GoogleNoRedirect(), delegateQueue: nil)
    defer { session.invalidateAndCancel() }
    let (data, response) = try await session.data(for: request)
    guard (response as? HTTPURLResponse)?.statusCode == 200, data.count <= 65536 else { throw URLError(.badServerResponse) }
    return data.isEmpty ? [:] : (try JSONSerialization.jsonObject(with: data) as? [String: Any] ?? [:])
  }
  private func revoke(_ token: String) async -> Bool {
    if token.isEmpty { return true }
    do { _ = try await request("revoke", ["token": token]); return true } catch { return false }
  }
  func perform(_ operation: String) async throws -> [String: Any] {
    guard ["status", "connect", "disconnect", "access"].contains(operation) else { throw URLError(.unsupportedURL) }
    switch operation {
    case "status":
      let token = try credential("get", nil)
      return ["connected": !token.isEmpty, "generation": Self.generation(token)]
    case "disconnect":
      epoch = UUID(); connecting = false
      let token = try credential("get", nil)
      _ = try credential("delete", nil)
      return ["connected": false, "revoked": await revoke(token)]
    case "connect":
      guard !connecting, !clientID.isEmpty else { throw URLError(.cannotLoadFromNetwork) }
      connecting = true
      let attempt = UUID(); epoch = attempt
      defer { if epoch == attempt { connecting = false } }
      let verifier = Self.random(), state = Self.random()
      var url = URLComponents(string: "https://accounts.google.com/o/oauth2/v2/auth")!
      url.queryItems = ["client_id": clientID, "response_type": "code", "scope": "https://www.googleapis.com/auth/gmail.readonly",
        "code_challenge": Data(SHA256.hash(data: Data(verifier.utf8))).base64URL, "code_challenge_method": "S256",
        "state": state, "access_type": "offline", "prompt": "consent"].map { URLQueryItem(name: $0.key, value: $0.value) }
      // The native listener adds its own ephemeral loopback redirect URI.
      let callback = try await authorize(url.url!, state)
      guard epoch == attempt, let parts = URLComponents(string: callback),
            let fields = parts.queryItems, fields.filter({ $0.name == "state" }).count == 1,
            fields.first(where: { $0.name == "state" })?.value == state,
            fields.filter({ $0.name == "code" }).count == 1,
            !fields.contains(where: { $0.name == "error" }),
            let code = fields.first(where: { $0.name == "code" })?.value, !code.isEmpty else { throw URLError(.cancelled) }
      var redirect = parts; redirect.query = nil
      let result = try await request("token", ["client_id": clientID, "code": code, "code_verifier": verifier,
        "redirect_uri": redirect.string!, "grant_type": "authorization_code"])
      guard let token = result["refresh_token"] as? String, !token.isEmpty else { throw URLError(.badServerResponse) }
      guard epoch == attempt else { _ = await revoke(token); throw URLError(.cancelled) }
      _ = try credential("set", token)
      return ["connected": true, "generation": Self.generation(token)]
    case "access":
      let attempt = epoch, token = try credential("get", nil)
      guard !token.isEmpty, !clientID.isEmpty else { throw URLError(.userAuthenticationRequired) }
      let started = Date().timeIntervalSince1970
      let result = try await request("token", ["client_id": clientID, "refresh_token": token, "grant_type": "refresh_token"])
      guard epoch == attempt, let access = result["access_token"] as? String, !access.isEmpty,
            let expiry = result["expires_in"] as? NSNumber, expiry.doubleValue > 0, expiry.doubleValue <= 3600,
            result["token_type"] as? String == "Bearer",
            result["scope"] == nil || result["scope"] as? String == "https://www.googleapis.com/auth/gmail.readonly"
      else { throw URLError(.badServerResponse) }
      // Use request start, not response time; never extend Google's lifetime.
      return ["accessToken": access, "expiresAt": (started + expiry.doubleValue) * 1000]
    default: throw URLError(.unsupportedURL)
    }
  }
  private static func generation(_ token: String) -> String { Data(SHA256.hash(data: Data(token.utf8))).base64URL }
  private static func random() -> String {
    var bytes = [UInt8](repeating: 0, count: 32)
    precondition(SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess)
    return Data(bytes).base64URL
  }
}
private extension Data {
  var base64URL: String { base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "") }
}
private final class GoogleNoRedirect: NSObject, URLSessionTaskDelegate {
  func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                  newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
}

// Bounded native-only PKCE callback. Invalid traffic never consumes the pending login.
private final class GoogleLoopback: @unchecked Sendable {
  static func authorize(_ url: URL, _ state: String) async throws -> String {
    let flow = GoogleLoopback()
    return try await flow.start(url, state)
  }
  private let queue = DispatchQueue(label: "com.getkier.google-login")
  private var listener: NWListener?
  private var completion: CheckedContinuation<String, Error>?
  private var timer: DispatchWorkItem?
  private func finish(_ result: Result<String, Error>) {
    guard let completion else { return }
    self.completion = nil; timer?.cancel(); listener?.cancel()
    completion.resume(with: result)
  }
  private func start(_ url: URL, _ state: String) async throws -> String {
    let parameters = NWParameters.tcp
    parameters.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: .any)
    let listener = try NWListener(using: parameters)
    self.listener = listener
    return try await withCheckedThrowingContinuation { continuation in
      queue.async {
        self.completion = continuation
        let timer = DispatchWorkItem { self.finish(.failure(URLError(.timedOut))) }
        self.timer = timer; self.queue.asyncAfter(deadline: .now() + 180, execute: timer)
        listener.stateUpdateHandler = { status in
          if case .failed(let error) = status { self.finish(.failure(error)) }
          if case .ready = status, let port = listener.port {
            var parts = URLComponents(url: url, resolvingAgainstBaseURL: false)!
            parts.queryItems?.append(URLQueryItem(name: "redirect_uri", value: "http://127.0.0.1:\(port.rawValue)/oauth/callback"))
            let browserURL = parts.url!
            DispatchQueue.main.async { LinkPolicy.open(browserURL) }
          }
        }
        listener.newConnectionHandler = { connection in
          connection.start(queue: self.queue)
          self.receive(connection, Data(), state)
          self.queue.asyncAfter(deadline: .now() + 5) { connection.cancel() }
        }
        listener.start(queue: self.queue)
      }
    }
  }
  private func receive(_ connection: NWConnection, _ buffered: Data, _ state: String) {
    connection.receive(minimumIncompleteLength: 1, maximumLength: 16384) { data, _, complete, error in
      let bytes = buffered + (data ?? Data())
      guard bytes.count <= 16384, error == nil else { connection.cancel(); return }
      guard let text = String(data: bytes, encoding: .utf8), text.contains("\r\n\r\n") else {
        if complete { connection.cancel() } else { self.receive(connection, bytes, state) }; return
      }
      let first = text.components(separatedBy: "\r\n")[0].split(separator: " ")
      let base = "http://127.0.0.1:\(self.listener?.port?.rawValue ?? 0)"
      let target = first.count == 3 ? String(first[1]) : ""
      let parts = URLComponents(string: base + target)
      let fields = parts?.queryItems ?? []
      let valid = first.first == "GET" && target.hasPrefix("/oauth/callback?") && parts?.path == "/oauth/callback" &&
        fields.filter { $0.name == "state" }.count == 1 && fields.first { $0.name == "state" }?.value == state &&
        fields.filter { $0.name == "code" }.count <= 1 && fields.filter { $0.name == "error" }.count <= 1 &&
        ((fields.contains { $0.name == "code" && !($0.value ?? "").isEmpty } && !fields.contains { $0.name == "error" }) ||
         (fields.contains { $0.name == "error" && $0.value == "access_denied" } && !fields.contains { $0.name == "code" }))
      let body = valid ? "You can return to Kier." : "Invalid callback."
      let response = "HTTP/1.1 \(valid ? "200 OK" : "400 Bad Request")\r\nConnection: close\r\nContent-Length: \(body.utf8.count)\r\n\r\n\(body)"
      connection.send(content: Data(response.utf8), completion: .contentProcessed { _ in connection.cancel() })
      if valid { self.finish(.success(base + target)) }
    }
  }
}
