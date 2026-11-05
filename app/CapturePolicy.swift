import Foundation

// The daemon supplies the same origin mapping used for storage and reads.
struct CapturePolicy {
  let disabled: Set<String>
  let appSources: [String: String]

  init?(json: [String: Any]) {
    guard let disabled = json["disabled"] as? [String],
          let sources = json["appSources"] as? [String: String] else { return nil }
    self.disabled = Set(disabled)
    self.appSources = sources
  }

  func permits(source: String, app: String, name: String = "") -> Bool {
    if disabled.contains(source) { return false }
    for identity in [app, String(name.split(separator: ":").first ?? "")] {
      if let origin = appSources[identity.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()], disabled.contains(origin) { return false }
    }
    return true
  }
}
