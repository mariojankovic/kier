import Foundation
import CryptoKit
import Darwin

// Protocol v1 uses newline-delimited fields and the URL's encoded path and query.
enum DaemonProof {
  static func hash(_ data: Data) -> String { SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() }
  static func mac(_ secret: Data, _ text: String) -> String {
    HMAC<SHA256>.authenticationCode(for: Data(text.utf8), using: SymmetricKey(data: secret)).map { String(format: "%02x", $0) }.joined()
  }
  static func request(_ secret: Data, method: String, target: String, timestamp: String, nonce: String, body: Data) -> String {
    mac(secret, [method, target, timestamp, nonce, hash(body)].joined(separator: "\n"))
  }
  // Pure verifier, also compiled by the daemon's Swift policy tests.
  static func accepts(_ secret: Data, nonce: String, status: Int, body: Data, signature: String?) -> Bool {
    guard let signature, signature.utf8.count == 64 else { return false }
    let expected = mac(secret, [nonce, String(status), hash(body)].joined(separator: "\n"))
    var difference: UInt8 = 0
    for (a, b) in zip(signature.utf8, expected.utf8) { difference |= a ^ b }
    return difference == 0
  }
  static func seal(_ secret: Data, body: Data) throws -> Data {
    let key = HMAC<SHA256>.authenticationCode(for: Data("kier-request-body-v1".utf8), using: SymmetricKey(data: secret))
    return try AES.GCM.seal(body, using: SymmetricKey(data: Data(key))).combined!
  }
}

func daemonRequest(_ url: URL) -> URLRequest { URLRequest(url: url) }

private final class NoDaemonRedirect: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
  func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                  newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
    completionHandler(nil)
  }
}

final class DaemonClient: @unchecked Sendable {
  private let directory: String
  private let session: URLSession
  init(dataDirectory: String) {
    directory = dataDirectory
    let config = URLSessionConfiguration.ephemeral
    config.connectionProxyDictionary = [:]
    config.httpShouldSetCookies = false
    config.urlCache = nil
    session = URLSession(configuration: config, delegate: NoDaemonRedirect(), delegateQueue: nil)
  }
  private func secret() throws -> Data {
    let dir = open(directory, O_RDONLY | O_NOFOLLOW | O_DIRECTORY)
    guard dir >= 0 else { throw URLError(.cannotConnectToHost) }
    defer { close(dir) }
    var st = stat()
    guard fstat(dir, &st) == 0, st.st_uid == getuid(), st.st_mode & 0o777 == 0o700 else { throw URLError(.cannotConnectToHost) }
    let fd = openat(dir, "token", O_RDONLY | O_NOFOLLOW)
    guard fd >= 0 else { throw URLError(.cannotConnectToHost) }
    defer { close(fd) }
    guard fstat(fd, &st) == 0, st.st_uid == getuid(), st.st_mode & S_IFMT == S_IFREG,
          st.st_mode & 0o777 == 0o600, st.st_nlink == 1, st.st_size >= 32, st.st_size <= 256 else { throw URLError(.cannotConnectToHost) }
    var bytes = [UInt8](repeating: 0, count: Int(st.st_size))
    let count = bytes.withUnsafeMutableBytes { read(fd, $0.baseAddress, $0.count) }
    guard count == bytes.count else { throw URLError(.cannotConnectToHost) }
    return Data(bytes)
  }
  func data(for original: URLRequest) async throws -> (Data, URLResponse) {
    guard let url = original.url, url.scheme == "http", url.host == "127.0.0.1", url.port != nil,
          url.user == nil, url.password == nil, url.fragment == nil,
          let parts = URLComponents(url: url, resolvingAgainstBaseURL: false) else { throw URLError(.badURL) }
    let key = try secret()
    var request = original
    let body = try original.httpBody.map { try DaemonProof.seal(key, body: $0) } ?? Data()
    request.httpBody = original.httpBody == nil ? nil : body
    let target = (parts.percentEncodedPath.isEmpty ? "/" : parts.percentEncodedPath) + (parts.percentEncodedQuery.map { "?" + $0 } ?? "")
    let nonce = UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased()
    let timestamp = String(Int(Date().timeIntervalSince1970))
    request.setValue(nil, forHTTPHeaderField: "x-kier-token")
    request.setValue(timestamp, forHTTPHeaderField: "x-kier-time")
    request.setValue(nonce, forHTTPHeaderField: "x-kier-nonce")
    request.setValue(DaemonProof.request(key, method: request.httpMethod ?? "GET", target: target, timestamp: timestamp, nonce: nonce, body: body), forHTTPHeaderField: "x-kier-signature")
    let (data, response) = try await session.data(for: request)
    guard let http = response as? HTTPURLResponse,
          DaemonProof.accepts(key, nonce: nonce, status: http.statusCode, body: data, signature: http.value(forHTTPHeaderField: "x-kier-response")) else {
      throw URLError(.cannotConnectToHost)
    }
    return (data, response)
  }
  func send(_ request: URLRequest, completion: @escaping @Sendable (Data?, URLResponse?, Error?) -> Void = { _, _, _ in }) {
    Task {
      do { let (data, response) = try await data(for: request); completion(data, response, nil) }
      catch { completion(nil, nil, error) }
    }
  }
}
