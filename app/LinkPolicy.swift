import AppKit
import SwiftUI

// All message, model and feed links share this policy, including direct opens.
enum LinkPolicy {
  static func allows(_ url: URL) -> Bool {
    guard let scheme = url.scheme?.lowercased() else { return false }
    return ["https", "http", "mailto"].contains(scheme)
  }

  static let action = OpenURLAction { url in
    allows(url) ? .systemAction : .discarded
  }

  @discardableResult
  static func open(_ url: URL) -> Bool {
    guard allows(url) else { return false }
    return NSWorkspace.shared.open(url)
  }
}

func safeLink(_ text: String?) -> URL? {
  guard let text, let url = URL(string: text), LinkPolicy.allows(url) else { return nil }
  return url
}

// Keep formatting and visible labels while removing unsafe link destinations.
func markdown(_ text: String) -> AttributedString {
  var value = (try? AttributedString(markdown: text, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(text)
  for run in value.runs {
    if let url = run.link, !LinkPolicy.allows(url) { value[run.range].link = nil }
  }
  return value
}
