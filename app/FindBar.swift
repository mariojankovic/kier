import AppKit
import SwiftUI

// Search from anywhere with ⌥⌘Space. Results arrive from words and semantic search, then from
// the interpreted query (daemon/lib/find.mjs). Return opens a result; ⌘Return asks Kier.
struct FindResult: Decodable, Identifiable, Hashable {
  struct Open: Decodable, Hashable {
    let card: String?
    let event: String?
    let url: String?
    let file: String?
    let app: String?
  }
  let id: String
  let kind: String
  let title: String
  let detail: String
  let open: Open
}

private struct FindQuick: Decodable { let results: [FindResult] }
private struct FindRefined: Decodable {
  struct Understood: Decodable { let kind: String; let person: String?; let topic: String }
  let results: [FindResult]
  let understood: Understood?
}

@MainActor
@Observable
final class FindModel {
  var query = ""
  var results: [FindResult] = []
  var selected = 0
  var reading = false
  var understood: String?
  // Counts each time the bar is shown, once its window takes the keys (Orb.swift toggleFind).
  var shown = 0
  private var typing: Task<Void, Never>?
  private var thinking: Task<Void, Never>?
  private var refined: String?
  private let base = "http://127.0.0.1:4777"

  var current: FindResult? { results.indices.contains(selected) ? results[selected] : nil }

  func reset() {
    typing?.cancel()
    thinking?.cancel()
    query = ""
    results = []
    selected = 0
    reading = false
    understood = nil
  }

  func move(_ by: Int) {
    guard !results.isEmpty else { return }
    selected = min(max(selected + by, 0), results.count - 1)
  }

  // Run keyword and semantic search while typing, then interpret the query after a short pause.
  // Start the activity indicator with the request so it covers both phases.
  func changed() {
    typing?.cancel()
    thinking?.cancel()
    refined = nil
    let q = query.trimmingCharacters(in: .whitespaces)
    // A few words are already the topic: the daemon answers those from the quick pass, so there's nothing to think about.
    let ask = q.count >= 2 && q.split(whereSeparator: \.isWhitespace).count >= 4
    reading = ask
    guard q.count >= 2 else { results = []; understood = nil; return }
    typing = Task {
      try? await Task.sleep(for: .milliseconds(60))
      guard !Task.isCancelled, let r: FindQuick = await get("/api/find", q), !Task.isCancelled, refined != q else { return }
      results = r.results
      selected = 0
      understood = nil
    }
    guard ask else { return }
    thinking = Task {
      try? await Task.sleep(for: .milliseconds(250))
      guard !Task.isCancelled else { return }
      let r: FindRefined? = await get("/api/find/ai", q)
      guard !Task.isCancelled else { return }
      reading = false
      guard let r, !r.results.isEmpty else { return }
      refined = q
      results = r.results
      selected = 0
      understood = r.understood.map(Self.describe)
    }
  }

  // Opening the bar loads the search model, so the first letters already search by meaning.
  func warm() async { let _: [String: Bool]? = await get("/api/find/warm", "") }

  private static func describe(_ u: FindRefined.Understood) -> String {
    let what = ["ai": "a Claude or Codex session", "chat": "a message", "mail": "an email", "file": "a file", "page": "a web page",
                "event": "an event", "call": "a call", "task": "a card"][u.kind] ?? "anything"
    return "Looking for \(what)\(u.person.map { " with \($0)" } ?? "") about \(u.topic)"
  }

  private func get<T: Decodable>(_ path: String, _ q: String) async -> T? {
    var parts = URLComponents(string: base + path)
    if !q.isEmpty { parts?.queryItems = [URLQueryItem(name: "q", value: q)] }
    guard let url = parts?.url, let (data, _) = try? await daemonClient.data(for: daemonRequest(url)) else { return nil }
    return try? JSONDecoder().decode(T.self, from: data)
  }
}

struct FindView: View {
  @Bindable var model: FindModel
  let open: (FindResult) -> Void
  let ask: (String) -> Void
  let close: () -> Void
  static let margin: CGFloat = 48
  static let size = CGSize(width: 680 + 2 * margin, height: 600 + 2 * margin)
  @FocusState private var focused: Bool

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      HStack(spacing: 12) {
        KierMark(working: model.reading).frame(width: 22, height: 22)
        TextField("Find anything, or ask Kier", text: $model.query)
          .textFieldStyle(.plain)
          .font(.system(size: 21))
          .focused($focused)
          .onChange(of: model.query) { model.changed() }
          .onKeyPress(.downArrow) { model.move(1); return .handled }
          .onKeyPress(.upArrow) { model.move(-1); return .handled }
          .onKeyPress(.escape) { close(); return .handled }
          .onKeyPress(keys: [.return], phases: .down) { press in
            let q = model.query.trimmingCharacters(in: .whitespaces)
            if press.modifiers.contains(.command) { if !q.isEmpty { ask(q) }; return .handled }
            if let r = model.current { open(r) } else if !q.isEmpty { ask(q) }
            return .handled
          }
      }
      .padding(.horizontal, 18)
      .padding(.vertical, 16)

      if !model.results.isEmpty {
        Divider().opacity(0.35)
        ScrollViewReader { scroll in
          ScrollView {
            VStack(spacing: 2) {
              ForEach(Array(model.results.enumerated()), id: \.element.id) { i, r in
                row(r, selected: i == model.selected)
                  .id(i)
                  .contentShape(Rectangle())
                  .onTapGesture { open(r) }
                  .onHover { if $0 { model.selected = i } }
              }
            }
            .padding(8)
          }
          .frame(maxHeight: 400)
          .fixedSize(horizontal: false, vertical: true)
          .onChange(of: model.selected) { withAnimation(.easeOut(duration: 0.12)) { scroll.scrollTo(model.selected) } }
        }
        // What Kier made of the request sits with the hints, in a row that's already there, so nothing moves when it comes.
        HStack(spacing: 16) {
          Text(model.understood ?? "").font(.caption2).foregroundStyle(.tertiary).lineLimit(1).truncationMode(.tail)
          Spacer(minLength: 0)
          hint("↩", "Open")
          hint("⌘↩", "Ask Kier")
          hint("esc", "Close")
        }
        .padding(.horizontal, 18)
        .padding(.bottom, 10)
      }
    }
    .frame(width: 680)
    // Clipped to its own corners, like the panel, with the shadow drawn here so it always has the bar's shape: the
    // window's own shadow kept an old outline and the rows ran into square corners.
    .blackGlass(radius: 18)
    .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
    // A click on the bar stays in it; one in the clear window around it is a click elsewhere, and closes the bar.
    .contentShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
    .onTapGesture { focused = true }
    .shadow(color: .black.opacity(0.45), radius: 28, y: 14)
    // The window never resizes (it did, in steps, while the bar grew smoothly, and the bar seemed to fly): it's tall
    // and clear, and the bar sits at its top.
    .padding(FindView.margin)
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
    .background { Color.clear.contentShape(Rectangle()).onTapGesture { close() } }
    .onAppear { focused = true }
    // Each time it's shown, the field takes the typing. Focus asked for only as the bar first appeared came before its
    // window took the keys, so the first time typing went nowhere until a click.
    .onChange(of: model.shown) { focused = true }
  }

  private func row(_ r: FindResult, selected: Bool) -> some View {
    HStack(spacing: 12) {
      Image(systemName: Self.symbol[r.kind] ?? "text.bubble")
        .font(.system(size: 14))
        .foregroundStyle(.secondary)
        .frame(width: 22)
      VStack(alignment: .leading, spacing: 2) {
        Text(r.title).font(.system(size: 14)).foregroundStyle(Kier.bright).lineLimit(1)
        Text(r.detail).font(.caption).foregroundStyle(.secondary).lineLimit(1)
      }
      Spacer(minLength: 0)
    }
    .padding(.horizontal, 10)
    .padding(.vertical, 8)
    .background(selected ? Color.white.opacity(0.09) : .clear, in: RoundedRectangle(cornerRadius: 10))
  }

  private func hint(_ key: String, _ label: String) -> some View {
    HStack(spacing: 5) {
      Text(key).font(.caption2.monospaced()).foregroundStyle(.secondary)
      Text(label).font(.caption2).foregroundStyle(.tertiary)
    }
  }

  private static let symbol = ["card": "checkmark.circle", "plan": "calendar", "event": "calendar", "session": "sparkles",
                               "file": "doc", "page": "globe", "message": "text.bubble"]
}
