import AppKit
import Foundation

// What Kier's window shows comes from the daemon's local API, the same one Claude reads through.

// SQLite hands booleans over as 0 or 1, the task list as true or false.
struct Flag: Codable, Hashable {
  let on: Bool
  init(from decoder: Decoder) throws {
    let c = try decoder.singleValueContainer()
    if let b = try? c.decode(Bool.self) { on = b } else { on = ((try? c.decode(Int.self)) ?? 0) != 0 }
  }
}

struct Card: Codable, Identifiable, Hashable {
  let id: String
  let source: String
  let meta: String?
  let thread: String?
  let sender: String?
  let from_me: Flag?
  let ts: Int
  let text: String?
  let url: String?
  let due: String?
  // The time it's due, HH:MM, when it has one (a reminder's time, or "at 15:00" said with the date).
  let due_time: String?
  let amount: String?
  let summary: String?
  let card: String?
  let state: String?
  let reason: String?
  let evidence_url: String?
  let done_at: Int?
  let second: Double?
  // Under Maybe yours: the second opinion doubts it's yours. "Mine" puts it on the list.
  let maybe: Flag?
  let hint: String?
  let hint_url: String?
  // The app to open for Reply when the card has no link of its own (Discord, Messages, the app a notification came from).
  let open_app: String?
  var mine: Bool { from_me?.on ?? false }
  var looksDone: Bool { state == "looks_done" }
  var looksUnneeded: Bool { state == "looks_unneeded" }
  var needsConfirmation: Bool { looksDone || looksUnneeded }
  var suggestionLabel: String { looksUnneeded ? "Not needed?" : "Looks done" }
  var confirmStatus: String { looksUnneeded ? "dismissed" : "done" }
}

struct Event: Codable, Identifiable, Hashable {
  let id: String?
  let text: String
  let ts: Int
  let allDay: Bool?
  // When a timed event ends, if the calendar says.
  let end: Int?
  let day: String
  var key: String { id ?? "\(ts)\(text)" }
}

struct Brief: Codable {
  struct Day: Codable { let events: [Event]; let tasks: [Card] }
  struct More: Codable { let forgotten: Int?; let open: Int?; let maybe: Int? }
  let date: String
  let today: Day
  let forgotten: [Card]
  let open: [Card]
  let maybe: [Card]
  let more: More
  let soon: Day
  let done: [Card]?
  let waiting: [Waiting]?
  // The short line under the orb, plus its full event or task for the hover card.
  // A compact time and label alone may not explain the event.
  let glance: String?
  let glanceAbout: GlanceAbout?
  // The Today card for hovering the island: today's timed events still ahead, what's overdue or due today, and
  // tomorrow's heads-ups, at most four lines, most pressing first.
  let day: [DayLine]?
  // Someone you owe something just wrote (tasks.mjs owed): who, when they wrote, and what you still owe them.
  let owed: [Owed]?
  // The 08:00 or 20:00 brief, for two hours after it was due: the island's nudge, not a macOS notification.
  let moment: BriefMoment?
}

struct BriefMoment: Codable {
  let at: Int
  let line: String
  let text: String
}

struct Owed: Codable {
  let who: String
  let at: Int
  let card: Card
}

// One calendar event or timed reminder, for its page (/api/event): when and where, its heads-up line, and the chats
// that mention it.
struct EventInfo: Codable {
  struct Said: Codable, Identifiable { let who: String; let ts: Int; let source: String; let thread: String?; let text: String; var id: String { "\(ts)\(who)\(text.prefix(20))" } }
  let id: String
  let title: String
  let place: String?
  let calendar: String
  let ts: Int
  let allDay: Bool
  let label: String?
  let context: String?
  let related: [Said]
}

struct DayLine: Codable, Hashable {
  let id: String?
  // The task behind the line, which a click opens; nil for a calendar event.
  let card: String?
  let when: String
  let text: String
  // A line of context under it: what the chats say around a heads-up, or who a task is with and where.
  let detail: String?
}

struct GlanceAbout: Codable, Equatable {
  let line: String
  let text: String
}

// Something you asked someone for and haven't got yet.
struct Waiting: Codable, Identifiable, Hashable {
  let id: String
  let source: String
  let thread: String?
  let ts: Int
  let url: String?
  let text: String?
  let who: String
  let what: String
}

// The chat around a card, which messages it was read from, and what happened after it.
struct Context: Codable {
  struct Message: Codable, Identifiable { let id: String; let sender: String?; let from_me: Bool; let ts: Int; let text: String?; let picked: Bool }
  struct Tag: Codable { let summary: String?; let card: String?; let second: Double?; let when_words: String?; let reason: String?; let url: String? }
  struct Since: Codable, Identifiable { let line: String; let url: String?; var id: String { line } }
  struct Origin: Codable {
    let id: String; let source: String; let thread: String?; let sender: String?; let ts: Int; let text: String?; let meta: String?
    var importedMetadata: [String: String] {
      guard let data = meta?.data(using: .utf8), let value = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return [:] }
      return value.compactMapValues { $0 as? String }
    }
    var conversationLabel: String { source == "mcp" ? importedMetadata["channel"] ?? "" : thread ?? "" }
    var originLabel: String { source == "mcp" ? "MCP server: " + (importedMetadata["mcpServer"] ?? "Unknown") : sourceName(source) }
  }
  let item: Origin
  let tag: Tag?
  let messages: [Message]
  let since: [Since]
}

struct Item: Codable, Identifiable, Hashable {
  let id: String
  let source: String
  let meta: String?
  let thread: String?
  let sender: String?
  let from_me: Flag?
  let ts: Int
  let text: String?
  let url: String?
  var importedMetadata: [String: String] {
    guard let data = meta?.data(using: .utf8), let value = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return [:] }
    return value.compactMapValues { $0 as? String }
  }
  var conversationLabel: String { source == "mcp" ? importedMetadata["channel"] ?? "" : thread ?? "" }
  var originLabel: String { source == "mcp" ? "MCP server: " + (importedMetadata["mcpServer"] ?? "Unknown") : sourceName(source) }
  let is_task: Flag?
  let due: String?
  let amount: String?
}

// One exchange with Kier in the orb's panel.
// Who the owner is, drafted by the local model (lib/profile.mjs) and corrected by them.
struct Profile: Codable, Equatable {
  struct Entry: Codable, Identifiable, Equatable {
    var name: String
    var text: String
    var edited: Bool?
    var id: String { name }
  }
  var about: String
  var aliases: [String]?
  var people: [Entry]
  var groups: [Entry]
  var updated: Int?
  var building: Bool?
}

// A card ready to hand to an agent (lib/handoff.mjs): a short note for a running session, the full brief for a new one.
struct OpenResult: Decodable { let ok: Bool?; let error: String? }

struct Handoff: Decodable {
  struct Session: Decodable {
    let title: String; let agent: String; let id: String?; let app: String?; let cli: Bool?
    // The Claude app's own address for the session (claude://claude.ai/epitaxy/local_…), when the daemon found it.
    let link: String?
    let provider: String?
    let model: String?
    var product: String { codex ? "Codex" : provider == "chatgpt" ? "ChatGPT" : "Claude" }
    var codex: Bool { if let provider { return provider == "codex" }; return agent.range(of: "^(codex|sol|astra|gpt)(\\b|-)", options: [.regularExpression, .caseInsensitive]) != nil }
    // Where "Open in …" takes it: the Claude app for its own sessions, else Terminal when that agent's CLI is here.
    var opensIn: String? {
      if (codex || provider == "chatgpt"), link != nil, NSWorkspace.shared.urlForApplication(withBundleIdentifier: "com.openai.codex") != nil { return "app" }
      if app == "desktop", !codex, provider != "chatgpt", NSWorkspace.shared.urlForApplication(withBundleIdentifier: Deliver.claude) != nil { return "app" }
      return id != nil && cli == true ? "terminal" : nil
    }
  }
  let short: String
  // Only when asked for (?full=1): it looks things up live, so the menu doesn't wait for it.
  let full: String?
  let repo: String?
  let briefHash: String?
  let session: Session?
}

// One of your conversations with Kier on the panel's list: its key, the last thing you asked, and when.
struct Conversation: Decodable, Identifiable {
  let key: String
  let q: String?
  let last: Int
  var id: String { key }
}

struct Turn: Identifiable {
  let id = UUID()
  let q: String
  let a: String
  let from: String
  // What Kier took into your profile from what you said, if anything.
  var note: String? = nil
  // Changes Kier offers for what you asked ("put it back", "not mine"): buttons, so nothing changes until you click.
  var actions: [ChatAction] = []
}

struct ChatAction: Identifiable, Hashable {
  let task: String
  let status: String
  let label: String
  let summary: String
  var id: String { "\(task)>\(status)" }
}

// A day also says which date it is; search results don't.
struct Items: Codable { let items: [Item] }

// "On this Mac": what Kier read today, its local model, and what went to Claude or Codex (by size only).
struct Privacy: Decodable {
  struct To: Decodable { let agent: String?; let bytes: Int }
  let read: Int
  let model: String
  let running: Bool
  let sent: Int
  let to: [To]
  // With your own model server: whether it's this Mac, and its host otherwise (never the address or key).
  var yours: Bool? = nil
  var server: String? = nil
  var local: Bool? = nil
}

// What Kier may read, and whether your Claude may double-check stuck cards.
struct Settings: Decodable {
  struct Source: Decodable, Identifiable { let id: String; let label: String; let detail: String?; var on: Bool; let count: Int }
  var sources: [Source]
  var claudeCheck: Bool
  let claude: Bool
  // The internet connections Kier makes of its own: off unless the owner turns them on.
  var online: Bool
}

// Model connections expose only whether a saved key exists; the key never comes back from the daemon.
enum ModelConnection: String, Codable, CaseIterable {
  case ollama, openai
  var title: String { self == .ollama ? "Ollama" : "OpenAI-compatible" }
  var defaultEndpoint: String { self == .ollama ? "http://127.0.0.1:11434" : "http://127.0.0.1:1234/v1" }
}

struct ModelSettings: Decodable {
  let mode: String
  let connection: ModelConnection
  let endpoint: String
  let model: String
  let hasKey: Bool
  let activeModel: String
  let managedReady: Bool
  enum CodingKeys: String, CodingKey {
    case mode, endpoint, model, hasKey, activeModel, managedReady
    case connection = "protocol"
  }
}

struct ModelDraft: Equatable {
  var mode = "builtin"
  var connection = ModelConnection.ollama
  var endpoint = ModelConnection.ollama.defaultEndpoint
  var model = ""
  var apiKey = ""
  var clearKey = false

  init(_ settings: ModelSettings) {
    mode = settings.mode
    connection = settings.connection
    endpoint = settings.endpoint.isEmpty ? settings.connection.defaultEndpoint : settings.endpoint
    model = settings.model
  }

  var request: [String: Any] {
    var body: [String: Any] = ["mode": mode, "protocol": connection.rawValue,
      "endpoint": endpoint.trimmingCharacters(in: .whitespacesAndNewlines),
      "model": model.trimmingCharacters(in: .whitespacesAndNewlines)]
    if !apiKey.isEmpty { body["apiKey"] = apiKey }
    if clearKey { body["clearKey"] = true }
    return body
  }

  var sameMac: Bool {
    guard let host = URL(string: endpoint)?.host?.lowercased() else { return false }
    return ["localhost", "::1", "[::1]"].contains(host) || host.hasPrefix("127.")
  }
}

struct ModelAction: Decodable {
  let ok: Bool
  let models: [String]?
  let error: String?
  let restarting: Bool?
}

struct MCPSource: Decodable, Identifiable {
  let id: String
  let name: String
  let enabled: Bool
  let tool: String
  let arguments: String
  let destination: String
}
struct MCPTool: Decodable, Identifiable {
  let name: String
  let description: String
  var id: String { name }
}
struct MCPReply: Decodable {
  let ok: Bool?
  let sources: [MCPSource]?
  let tools: [MCPTool]?
  let error: String?
}

struct Step: Codable, Identifiable {
  struct Action: Codable { let id: String; let label: String }
  struct Link: Codable { let label: String; let url: String }
  let id: String
  let title: String
  let status: String
  let detail: String?
  let action: Action?
  let link: Link?
  // Only web pages open from Setup, never other schemes.
  var linkURL: URL? { link.flatMap { URL(string: $0.url) }.flatMap { $0.scheme == "https" ? $0 : nil } }
}

struct Vault: Codable {
  struct Source: Codable, Identifiable { let source: String; let n: Int; let recent: Int; let oldest: Int; let newest: Int; var id: String { source } }
  struct Thread: Codable, Identifiable { let source: String; let thread: String; let n: Int; var id: String { source + thread } }
  struct Read: Codable, Identifiable { let ts: Int; let client: String?; let tool: String?; let args: String?; let rows: Int?; var id: String { "\(ts)\(tool ?? "")" } }
  struct Reads: Codable { let week: Int; let recent: [Read] }
  let bytes: Int
  let sources: [Source]
  let threads: [String: [Thread]]
  let forgotten: Int
  let reads: Reads
}

enum Page: String, CaseIterable, Identifiable {
  case brief, done, chats, timeline, vault, setup
  var id: String { rawValue }
  init(path: String) { self = Page(rawValue: path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))) ?? .brief }
}

let sourceNames = [
  "kier": "Kier", "whatsapp": "WhatsApp", "imessage": "iMessage", "calls": "Calls", "calendar": "Calendar", "browser": "Web", "downloads": "Downloads",
  "mcp": "MCP", "mail": "Mail", "notifications": "Notifications", "clipboard": "Copied", "apps": "Apps", "screen": "On screen", "ai": "AI chats", "git": "Code",
  "discord": "Discord", "chat": "Chats", "social": "Threads and X",
]
func sourceName(_ s: String) -> String { sourceNames[s] ?? s }
let isoDay: DateFormatter = { let f = DateFormatter(); f.dateFormat = "yyyy-MM-dd"; return f }()

extension Brief {
  // What the island's panel lists: overdue, due today, open, and what's due in the next two days, which the main
  // window keeps under "Coming up" ("Set goals by tomorrow" never reached the panel).
  var panel: [Card] {
    let soonest = isoDay.string(from: Date().addingTimeInterval(2 * 86400))
    return forgotten + today.tasks + open + soon.tasks.filter { ($0.due ?? "9999") <= soonest }
  }
}

// @Observable rather than ObservableObject: a view redraws only when something it reads changes, not on every change
// to anything here. That's what lets the window keep its pages alive (ContentView) without a streaming chat answer or
// the brief's refresh redrawing all of them.
@MainActor
@Observable
final class Store {
  var page: Page = .brief
  var brief: Brief?
  var completed: [Card]?
  var completedTotal = 0
  var completedNext: Int?
  var loadingCompleted = false
  var day = Calendar.current.startOfDay(for: Date())
  var items: [Item] = []
  var results: [Item]?
  var vault: Vault?
  var steps: [Step] = []
  var privacy: Privacy?
  var settings: Settings?
  var modelSettings: ModelSettings?
  var offline = false
  var selected: Card?
  // A card to open in the panel as it comes up, set from outside it (a line on the Today card).
  var show: String?
  // The same for a calendar event or reminder: its page instead of a card's.
  var showEvent: String?
  // Set to open the panel on a chat (a question asked from the search bar).
  var showChat: String?
  // Set to open the panel on What's new (the card after an update, the island's menu).
  var showNotes = false
  // Conversations with Kier: "general", and one per waiting item, keyed by its id.
  var chats: [String: [Turn]] = [:]
  // The question being answered right now, shown at once instead of after the answer.
  var pending: [String: String] = [:]
  // The answer as it forms, and what the agent is doing meanwhile ("Looking through your vault…").
  var partial: [String: String] = [:]
  var step: [String: String] = [:]
  // Chat buttons already clicked, so each shows it took.
  var applied: Set<String> = []

  func apply(_ a: ChatAction) {
    applied.insert(a.id)
    mark(id: a.task, a.status)
  }
  var profile: Profile?
  var handoffs: [String: Handoff] = [:]
  var conversations: [Conversation] = []
  // The chat open in the window's Chats page.
  var chatKey: String?
  // The Timeline's filter and the window's search, here rather than in the page so the window's toolbar can hold them.
  var filter = "All"
  var query = ""
  var asking: Set<String> = []
  var context: Context?
  private let base = "http://127.0.0.1:4777"
  @ObservationIgnored private var searching: Task<Void, Never>?

  var waiting: Int { brief.map { $0.today.tasks.count + $0.forgotten.count + $0.open.count } ?? 0 }
  var setupLeft: Int { steps.filter { $0.status == "todo" && $0.action != nil }.count }

  // Every published change redraws the whole window, even one that sets the same value again, so nothing is set
  // unless it changed: offline only when it flips, and an answer the same as last time (the island fetches the brief
  // every 20 seconds) isn't decoded or published again.
  @ObservationIgnored private var last: [String: Data] = [:]

  private func data(_ path: String) async -> Data? {
    guard let url = URL(string: base + path), let (data, _) = try? await daemonClient.data(for: daemonRequest(url)) else {
      if !offline { offline = true }
      return nil
    }
    if offline { offline = false }
    return data
  }

  private func get<T: Decodable>(_ path: String) async -> T? {
    guard let data = await data(path) else { return nil }
    return try? JSONDecoder().decode(T.self, from: data)
  }

  // nil when it failed or when the answer is the same as the last one read under this key.
  private func fresh<T: Decodable>(_ path: String, key: String? = nil) async -> T? {
    guard let data = await data(path), last[key ?? path] != data else { return nil }
    last[key ?? path] = data
    return try? JSONDecoder().decode(T.self, from: data)
  }

  // Writes are JSON only: the daemon refuses anything else, so a web page can't forge them.
  @discardableResult
  private func post(_ path: String, _ body: [String: Any] = [:]) async -> Bool {
    await send(path, body) != nil
  }

  // The same, with the daemon's answer.
  private func post<T: Decodable>(_ path: String, _ body: [String: Any] = [:]) async -> T? {
    guard let data = await send(path, body) else { return nil }
    return try? JSONDecoder().decode(T.self, from: data)
  }

  private func send(_ path: String, _ body: [String: Any]) async -> Data? {
    var request = daemonRequest(URL(string: base + path)!)
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "content-type")
    request.httpBody = try? JSONSerialization.data(withJSONObject: body)
    guard let (data, response) = try? await daemonClient.data(for: request), (response as? HTTPURLResponse)?.statusCode == 200 else { return nil }
    return data
  }

  // Just the brief, for the island's look every 20 seconds.
  func loadBrief() async { if let b: Brief = await fresh("/api/brief") { brief = b } }

  func loadModelSettings() async {
    if let settings: ModelSettings = await get("/api/model-settings") { modelSettings = settings }
  }

  // Configuration tests send only a synthetic probe; save is the explicit action that changes the active model.
  func testModel(_ draft: ModelDraft) async -> ModelAction? {
    await modelRequest("/api/model-settings/test", draft.request)
  }

  func configureModel(_ draft: ModelDraft) async -> ModelAction? {
    let answer = await modelRequest("/api/model-settings", draft.request)
    if answer?.ok == true {
      // A successful save restarts the daemon. Retry its public settings without carrying the API key into state.
      Task {
        if answer?.restarting == true { try? await Task.sleep(for: .seconds(1)) }
        for _ in 0..<20 {
          guard !Task.isCancelled else { return }
          if let settings: ModelSettings = await get("/api/model-settings") {
            modelSettings = settings
            await refresh()
            await loadPrivacy()
            return
          }
          try? await Task.sleep(for: .seconds(1))
        }
      }
    }
    return answer
  }

  private func modelRequest(_ path: String, _ body: [String: Any]) async -> ModelAction? {
    var request = daemonRequest(URL(string: base + path)!)
    request.httpMethod = "POST"
    request.timeoutInterval = 120
    request.setValue("application/json", forHTTPHeaderField: "content-type")
    request.httpBody = try? JSONSerialization.data(withJSONObject: body)
    guard let (data, _) = try? await daemonClient.data(for: request) else { return nil }
    // Validation errors have useful text even when the daemon returns a non-2xx status.
    return try? JSONDecoder().decode(ModelAction.self, from: data)
  }

  // The full completed history, paged independently from the six-card brief preview.
  func loadCompleted(reset: Bool = true) async {
    guard !loadingCompleted else { return }
    if !reset && completedNext == nil { return }
    loadingCompleted = true
    defer { loadingCompleted = false }
    struct DonePage: Decodable { let cards: [Card]; let total: Int; let next: Int? }
    let offset = reset ? 0 : completedNext ?? 0
    if let page: DonePage = await get("/api/done?offset=\(offset)") {
      completed = reset ? page.cards : (completed ?? []) + page.cards
      completedTotal = page.total
      completedNext = page.next
    }
  }

  // The report for a bug (daemon lib/diagnostics.mjs), headed with this app's version.
  func diagnostics() async -> String? {
    struct Report: Decodable { let text: String }
    guard let r: Report = await get("/api/diagnostics") else { return nil }
    let info = Bundle.main.infoDictionary
    return "Kier \(info?["CFBundleShortVersionString"] as? String ?? "?") (\(info?["CFBundleVersion"] as? String ?? "?"))\n\(r.text)"
  }

  func card(_ id: String) async -> Card? {
    await get("/api/card?id=\(id.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? id)")
  }

  func event(_ id: String) async -> EventInfo? {
    await get("/api/event?id=\(id.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? id)")
  }

  // Check now: Kier collects everything and the done-check looks at every open card, right away. It takes up to a
  // couple of minutes, so it waits longer than an ordinary request.
  var checking = false
  func checkNow() {
    guard !checking else { return }
    checking = true
    Task {
      var request = daemonRequest(URL(string: base + "/api/refresh")!)
      request.httpMethod = "POST"
      request.timeoutInterval = 300
      request.setValue("application/json", forHTTPHeaderField: "content-type")
      request.httpBody = Data("{}".utf8)
      _ = try? await daemonClient.data(for: request)
      await loadBrief()
      checking = false
    }
  }

  func refresh() async {
    async let b: Brief? = fresh("/api/brief")
    async let s: [String: [Step]]? = fresh("/api/setup")
    if let b = await b { brief = b }
    if let s = await s?["steps"] { steps = s }
    switch page {
    case .done: await loadCompleted()
    case .timeline: await loadDay()
    case .vault: await loadVault()
    default: break
    }
  }

  func loadDay() async {
    // One key for every day, so going back to a day read before still shows it.
    guard let day: Items = await fresh("/api/day?date=\(isoDay.string(from: self.day))", key: "day") else { return }
    // Newest first reads like a feed.
    items = day.items.reversed()
  }

  func shiftDay(_ n: Int) {
    day = Calendar.current.date(byAdding: .day, value: n, to: day) ?? day
    Task { await loadDay() }
  }

  func goToday() {
    day = Calendar.current.startOfDay(for: Date())
    Task { await loadDay() }
  }

  func search(_ q: String) {
    searching?.cancel()
    let q = q.trimmingCharacters(in: .whitespaces)
    guard q.count >= 2 else { results = nil; return }
    searching = Task {
      try? await Task.sleep(for: .milliseconds(250))
      guard !Task.isCancelled, let enc = q.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) else { return }
      let r: Items? = await get("/api/search?q=\(enc)")
      if !Task.isCancelled { results = r?.items ?? [] }
    }
  }

  // The vault's own search, kept apart from the timeline's.
  func find(_ q: String) async -> [Item] {
    let q = q.trimmingCharacters(in: .whitespaces)
    guard q.count >= 2, let enc = q.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) else { return [] }
    let r: Items? = await get("/api/search?q=\(enc)")
    return r?.items ?? []
  }

  func loadVault() async { if let v: Vault = await fresh("/api/vault") { vault = v } }

  func mcpSources() async -> [MCPSource] {
    let reply: MCPReply? = await get("/api/mcp-sources")
    return reply?.sources ?? []
  }

  func mcpAction(_ action: String = "", _ body: [String: Any]) async -> MCPReply? {
    var request = daemonRequest(URL(string: base + "/api/mcp-sources" + action)!)
    request.httpMethod = "POST"
    request.timeoutInterval = 40
    request.setValue("application/json", forHTTPHeaderField: "content-type")
    request.httpBody = try? JSONSerialization.data(withJSONObject: body)
    guard let (data, _) = try? await daemonClient.data(for: request) else { return nil }
    let reply = try? JSONDecoder().decode(MCPReply.self, from: data)
    if reply?.ok == true { await loadBrief() }
    return reply
  }

  func loadSetup() async {
    let s: [String: [Step]]? = await fresh("/api/setup")
    if let s = s?["steps"] { steps = s }
  }

  func loadPrivacy() async { privacy = await get("/api/privacy") ?? privacy }
  func loadSettings() async { settings = await get("/api/settings") ?? settings }

  // Switched at once here, so the toggle doesn't wait on the daemon.
  func setSource(_ id: String, on: Bool) {
    if let i = settings?.sources.firstIndex(where: { $0.id == id }) { settings?.sources[i].on = on }
    Task {
      // Your reminders come through Reminders itself (PhoneSync), which macOS asks about once.
      if id == "reminders", on { _ = await PhoneSync.shared.requestAccess(events: false, reminders: true) }
      await post("/api/settings", ["source": id, "on": on])
      if id == "reminders" { PhoneSync.shared.tick(force: true) }
      await loadBrief()
    }
  }

  func setClaudeCheck(_ on: Bool) {
    settings?.claudeCheck = on
    Task { await post("/api/settings", ["claudeCheck": on]) }
  }

  func setOnline(_ on: Bool) {
    settings?.online = on
    Task { await post("/api/settings", ["online": on]) }
  }

  // Renamed by hand on its page; the list shows the new title once the brief is read again.
  func rename(_ card: Card, to title: String) {
    Task {
      await post("/api/rename", ["id": card.id, "title": title])
      await loadBrief()
      if page == .done { await loadCompleted() }
    }
  }

  func mark(_ card: Card, _ status: String) {
    Task {
      await post("/api/mark", ["id": card.id, "status": status])
      // One of your reminders: ticked off (or reopened) in Reminders now, not on the next five-minute look.
      if card.source == "reminders" { PhoneSync.shared.tick(force: true) }
      if let b: Brief = await fresh("/api/brief") { brief = b }
      if page == .done { await loadCompleted() }
    }
  }

  func select(_ card: Card?) {
    selected = card
    context = nil
    guard let card, let id = card.id.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) else { return }
    Task {
      let c: Context? = await get("/api/context?id=\(id)")
      if selected?.id == card.id { context = c }
    }
  }

  func mark(id: String, _ status: String) {
    Task {
      await post("/api/mark", ["id": id, "status": status])
      if let b: Brief = await fresh("/api/brief") { brief = b }
      if page == .done { await loadCompleted() }
    }
  }

  func addToCalendar(_ card: Card) { Task { await post("/api/calendar", ["id": card.id]) } }

  // The chat itself when the card links to it, else the app the conversation lives in.
  func reply(_ card: Card) {
    if let url = card.chatURL { LinkPolicy.open(url) }
    else if let app = card.app { NSWorkspace.shared.openApplication(at: app, configuration: NSWorkspace.OpenConfiguration()) }
  }

  func speak() { Task { await post("/api/speak") } }
  func stopSpeaking() { Task { await post("/api/speak/stop") } }
  func say(_ text: String) { Task { await post("/api/say", ["text": text]) } }

  func loadHandoff(_ id: String) async {
    guard handoffs[id] == nil, let k = id.addingPercentEncoding(withAllowedCharacters: .alphanumerics) else { return }
    if let h: Handoff = await get("/api/handoff?id=\(k)") { handoffs[id] = h }
  }

  // Review the daemon's exact brief as plain selectable text before approving its hash.
  func startSession(_ id: String, agent: String, branch: Bool = false) {
    Task {
      guard let k = id.addingPercentEncoding(withAllowedCharacters: .alphanumerics),
            let h: Handoff = await get("/api/handoff?id=\(k)&full=1"),
            let full = h.full, let hash = h.briefHash else {
        handoffError("Could not load the brief.")
        return
      }
      let panel = NSAlert()
      panel.messageText = "Review hand-off"
      panel.informativeText = h.repo.map { "Folder: \($0)" } ?? "No task folder. Copy the brief instead."
      panel.addButton(withTitle: "Send")
      panel.addButton(withTitle: "Cancel")
      panel.buttons[0].isEnabled = h.repo != nil
      panel.buttons[0].keyEquivalent = ""
      panel.buttons[1].keyEquivalent = "\u{1b}"
      let scroll = NSScrollView(frame: NSRect(x: 0, y: 0, width: 640, height: 440))
      scroll.hasVerticalScroller = true
      scroll.borderType = .bezelBorder
      let text = NSTextView(frame: scroll.bounds)
      text.isEditable = false
      text.isSelectable = true
      text.isRichText = false
      text.font = .monospacedSystemFont(ofSize: 12, weight: .regular)
      text.string = full
      text.textContainerInset = NSSize(width: 8, height: 8)
      text.isVerticallyResizable = true
      text.autoresizingMask = [.width]
      text.textContainer?.widthTracksTextView = true
      scroll.documentView = text
      panel.accessoryView = scroll
      let response: NSApplication.ModalResponse
      if let window = NSApp.keyWindow ?? NSApp.mainWindow {
        response = await withCheckedContinuation { continuation in
          panel.beginSheetModal(for: window) { continuation.resume(returning: $0) }
        }
      } else {
        response = panel.runModal()
      }
      guard response == .alertFirstButtonReturn else { return }
      let result: OpenResult? = await post("/api/handoff", ["id": id, "agent": agent, "branch": branch, "briefHash": hash])
      if result?.ok != true { handoffError(result?.error ?? "Could not send the brief.") }
    }
  }

  private func handoffError(_ message: String) {
    let panel = NSAlert()
    panel.messageText = "Hand-off not sent"
    panel.informativeText = message
    panel.addButton(withTitle: "OK")
    if let window = NSApp.keyWindow ?? NSApp.mainWindow { panel.beginSheetModal(for: window) }
    else { panel.runModal() }
  }

  // The session a card came from, as it was. `done` gets nil when it opened, or why it didn't.
  func openSession(_ id: String, _ s: Handoff.Session, done: @escaping @MainActor (String?) -> Void) {
    // Straight to it by its address; looking for its row in Claude's sidebar is only for when there's none.
    if s.opensIn == "app", let link = s.link.flatMap(URL.init(string:)) {
      done(LinkPolicy.openSession(link) ? nil : "Link is unavailable")
      return
    }
    if s.opensIn == "app" { Deliver.open(session: s.title, done: done); return }
    Task {
      let r: OpenResult? = await post("/api/handoff", ["id": id, "open": true])
      done(r == nil ? "Kier isn't running" : r?.error)
    }
  }

  func copyFullBrief(_ id: String) async -> Bool {
    guard let k = id.addingPercentEncoding(withAllowedCharacters: .alphanumerics), let h: Handoff = await get("/api/handoff?id=\(k)&full=1"),
          let full = h.full else { return false }
    copy(full)
    return true
  }

  func copy(_ text: String) {
    NSPasteboard.general.clearContents()
    NSPasteboard.general.setString(text, forType: .string)
  }

  func loadProfile() async { profile = await get("/api/profile") ?? profile }

  // Only what you changed is sent, and it's kept as you wrote it when Kier learns again.
  func saveProfile(_ p: Profile) {
    guard let old = profile else { return }
    var body: [String: Any] = [:]
    if p.about != old.about { body["about"] = p.about }
    let changed = { (new: [Profile.Entry], old: [Profile.Entry]) in
      new.filter { e in old.first { $0.name == e.name }?.text != e.text }.map { ["name": $0.name, "text": $0.text] }
    }
    body["people"] = changed(p.people, old.people)
    body["groups"] = changed(p.groups, old.groups)
    profile = p
    Task { await post("/api/profile", body); await loadProfile() }
  }

  func rebuildProfile() {
    profile?.building = true
    Task {
      await post("/api/profile/rebuild")
      while profile?.building == true {
        try? await Task.sleep(for: .seconds(4))
        await loadProfile()
      }
    }
  }

  // A new conversation gets its own key; the earlier ones stay on the list until you put them away.
  func newChatKey() -> String { "chat:\(Int(Date().timeIntervalSince1970 * 1000))" }

  func newChat() { chatKey = newChatKey(); page = .chats }
  func openChat(_ key: String) { chatKey = key; page = .chats }

  func loadConversations() async {
    struct List: Decodable { let conversations: [Conversation] }
    if let r: List = await get("/api/conversations") { conversations = r.conversations }
  }

  // Off the panel's list; still kept in the vault.
  func archive(_ key: String) {
    conversations.removeAll { $0.key == key }
    Task { await post("/api/chat", ["key": key, "archive": true]) }
  }

  // The panel's cards, worked out for hand-off ahead of time.
  func warmHandoffs(_ ids: [String]) { Task { await post("/api/handoff/warm", ["ids": ids]) } }

  // The conversation kept in the vault, read once per screen it's shown on.
  func loadChat(_ key: String) async {
    struct Saved: Decodable { let q: String; let a: String; let agent: String?; let seconds: Int? }
    struct Turns: Decodable { let turns: [Saved] }
    guard chats[key] == nil, let k = key.addingPercentEncoding(withAllowedCharacters: .alphanumerics),
          let r: Turns = await get("/api/chat?key=\(k)") else { return }
    let names = ["claude": "Claude", "codex": "Codex", "kier": "Kier"]
    if chats[key] == nil { chats[key] = r.turns.map { Turn(q: $0.q, a: $0.a, from: "\(names[$0.agent ?? ""] ?? "Kier"), \($0.seconds ?? 0)s") } }
  }

  // Cloud assistants may take longer than normal requests. Include recent exchanges for follow-up
  // questions; item-specific questions receive the vault context from aboutItem in resolve.mjs.
  func ask(_ q: String, agent: String, key: String = "general", item: String? = nil) {
    asking.insert(key)
    pending[key] = q
    let history = (chats[key] ?? []).suffix(6).map { ["q": $0.q, "a": $0.a] }
    Task {
      // Each NDJSON line is authenticated on its own before its text, status or actions are used (DaemonClient.lines).
      var request = daemonRequest(URL(string: base + "/api/ask/stream")!)
      request.httpMethod = "POST"
      request.timeoutInterval = 300
      request.setValue("application/json", forHTTPHeaderField: "content-type")
      var body: [String: Any] = ["q": q, "agent": agent, "history": history, "key": key]
      if let item { body["item"] = item }
      request.httpBody = try? JSONSerialization.data(withJSONObject: body)
      var answered: UUID?
      do {
        for try await line in daemonClient.lines(for: request) {
          guard let o = (try? JSONSerialization.jsonObject(with: line)) as? [String: Any] else { continue }
          if let t = o["text"] as? String { partial[key] = t }
          if let s = o["status"] as? String { step[key] = s }
          if o["done"] as? Bool == true { answered = finish(q, agent: agent, key: key, o) }
          if answered == nil, let e = o["error"] as? String { answered = finish(q, agent: agent, key: key, ["error": e]) }
          // What Kier took into your profile comes a moment after the answer.
          if let noted = o["noted"] as? String, let answered, let i = chats[key]?.firstIndex(where: { $0.id == answered }) {
            chats[key]?[i].note = noted
            await loadProfile()
          }
        }
      } catch {
        if answered == nil { answered = finish(q, agent: agent, key: key, ["error": error.localizedDescription]) }
      }
      if answered == nil { finish(q, agent: agent, key: key, [:]) }
      if key == "general" || key.hasPrefix("chat:") { await loadConversations() }
    }
  }

  // The finished answer takes the place of the one being written in a single step, so nothing shows twice.
  @discardableResult
  private func finish(_ q: String, agent: String, key: String, _ r: [String: Any]) -> UUID {
    let names = ["claude": "Claude", "codex": "Codex", "kier": "Kier"]
    let a = (r["out"] as? String) ?? partial[key].flatMap { $0.isEmpty ? nil : $0 } ?? (r["error"] as? String).map { "Couldn't ask: \($0)" } ?? "No answer."
    let offered = (r["actions"] as? [[String: Any]] ?? []).compactMap { o -> ChatAction? in
      guard let task = o["id"] as? String, let status = o["status"] as? String, let label = o["label"] as? String else { return nil }
      return ChatAction(task: task, status: status, label: label, summary: o["summary"] as? String ?? "")
    }
    let turn = Turn(q: q, a: a, from: "\(names[agent] ?? agent), \(r["seconds"] as? Int ?? 0)s", actions: offered)
    // Renamed from its chat: the card's title follows at once.
    if a.hasPrefix("Renamed it to") || r["created"] is String {
      Task { await loadBrief() }
      if r["created"] is String { PhoneSync.shared.tick(force: true) }
    }
    chats[key, default: []].append(turn)
    pending[key] = nil
    partial[key] = nil
    step[key] = nil
    asking.remove(key)
    return turn.id
  }

  func act(_ step: Step.Action) {
    Task {
      // Calendars and Reminders are the app's to ask for (EventKit), each switch only what it needs; the daemon turns it on after.
      let needs = ["phonecal": (true, false), "phonerem": (false, true), "myrem": (false, true)][step.id]
      if let needs { _ = await PhoneSync.shared.requestAccess(events: needs.0, reminders: needs.1) }
      await post("/api/setup/\(step.id)")
      if step.id.hasPrefix("phone") || step.id.hasPrefix("myrem") { PhoneSync.shared.tick(force: true) }
      await loadSetup()
    }
  }

  func forget(item id: String) {
    Task {
      await post("/api/forget", ["id": id])
      items.removeAll { $0.id == id }
      results?.removeAll { $0.id == id }
      await loadVault()
    }
  }

  func forget(source: String, thread: String) {
    Task {
      await post("/api/forget", ["source": source, "thread": thread])
      await loadVault()
    }
  }
}
