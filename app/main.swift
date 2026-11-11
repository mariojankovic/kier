import AppKit
import ApplicationServices
import Foundation


// Kier.app is a thin shell around the Node daemon. macOS grants permissions such as Full Disk Access and
// Accessibility to "Kier"; the Node process it starts inherits file access, and everything that needs
// Accessibility or AppKit (the clipboard, which app is in front, text on screen) runs here in Kier itself.
let info = Bundle.main.infoDictionary ?? [:]
// A downloaded Kier carries its own Node and daemon inside the app; a development build points at the repo instead.
let resources = Bundle.main.resourcePath ?? ""
let bundled = FileManager.default.fileExists(atPath: resources + "/daemon/bin/kier.mjs")
let root = bundled ? resources + "/daemon" : info["KierRoot"] as? String ?? ""
let node = bundled ? resources + "/runtime/node" : info["KierNode"] as? String ?? "/opt/homebrew/bin/node"
var args = Array(CommandLine.arguments.dropFirst())
// Opened from Finder or Launchpad: make sure Kier runs at login and show setup or the timeline.
if args.isEmpty || args[0].hasPrefix("-psn") { args = ["open"] }
let daemon = args.first == "run"
let daemonClient = DaemonClient(dataDirectory: !bundled ? (ProcessInfo.processInfo.environment["KIER_DATA_DIR"] ??
  FileManager.default.homeDirectoryForCurrentUser.path + "/Library/Application Support/Kier") :
  FileManager.default.homeDirectoryForCurrentUser.path + "/Library/Application Support/Kier")

let child = Process()
child.executableURL = URL(fileURLWithPath: node)
child.arguments = ["--disable-warning=ExperimentalWarning", root + "/bin/kier.mjs"] + args
// Node takes code from its environment (NODE_OPTIONS=--import=…), and the daemon runs with Kier's Full Disk Access, so
// none of that is passed on; nor, in a downloaded Kier, where its data lives.
child.environment = [
  "HOME": FileManager.default.homeDirectoryForCurrentUser.path,
  "PATH": "/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin",
  "LANG": "en_US.UTF-8", "TMPDIR": "/tmp",
  "KIER_APP": Bundle.main.bundlePath,
]
if !bundled, let data = ProcessInfo.processInfo.environment["KIER_DATA_DIR"] {
  child.environment?["KIER_DATA_DIR"] = data
}
// Opened from Finder: the daemon owns Kier's window, so this copy only says which page to show, then quits.
let output = Pipe()
if args.first == "open" { child.standardOutput = output }
// Run owns private credential pipes. The environment flag contains no secret.
let vaultInput = Pipe(), vaultOutput = Pipe()
let vaultDirectory = child.environment?["KIER_DATA_DIR"] ?? FileManager.default.homeDirectoryForCurrentUser.path + "/Library/Application Support/Kier"
let gmailVault = GmailVault(directory: vaultDirectory, bundled: bundled)
if daemon {
  child.standardInput = vaultInput
  child.standardOutput = vaultOutput
  child.environment?["KIER_NATIVE_VAULT"] = bundled ? "1" : "0"
  gmailVault.serve(output: vaultOutput.fileHandleForReading, input: vaultInput.fileHandleForWriting)
}
// MARK: When Kier can't start

// The background copy's last failure to start, so the login agent's restarts log it once and wait longer each time,
// and opening Kier can say what went wrong.
struct LaunchFailure: Codable { var message: String; var count: Int; var since: Double; var logged: Double }
let failureURL = URL(fileURLWithPath: vaultDirectory).appendingPathComponent("launch-failure.json")
func lastFailure() -> LaunchFailure? { (try? Data(contentsOf: failureURL)).flatMap { try? JSONDecoder().decode(LaunchFailure.self, from: $0) } }
func launchLog(_ line: String) { FileHandle.standardError.write("\(line)\n".data(using: .utf8)!) }

// The login agent restarts Kier whenever it exits. Without a pause and a memory of what was already said, a Kier that
// can't start wrote the same line every ten seconds, for days.
func failedToStart(_ message: String) -> Never {
  let now = Date().timeIntervalSince1970
  var failure = lastFailure().flatMap { $0.message == message ? $0 : nil } ?? LaunchFailure(message: message, count: 0, since: now, logged: 0)
  failure.count += 1
  if failure.count == 1 { launchLog("Kier could not start \(message)") }
  else if now - failure.logged >= 3600 { launchLog("Kier still could not start \(message) (\(failure.count) tries since \(Date(timeIntervalSince1970: failure.since)))") }
  if failure.count == 1 || now - failure.logged >= 3600 { failure.logged = now }
  try? JSONEncoder().encode(failure).write(to: failureURL, options: .atomic)
  // 10 s, 20 s, 40 s… up to five minutes between tries; opening Kier's Try Again starts the next one at once.
  Thread.sleep(forTimeInterval: min(300, 10 * pow(2, Double(min(failure.count, 6) - 1))))
  exit(1)
}

// Opened from Finder and nothing would happen: say so, with a way to try again or find the log.
func showProblem(_ detail: String) -> Never {
  let app = NSApplication.shared
  app.setActivationPolicy(.accessory)
  app.activate()
  let alert = NSAlert()
  alert.alertStyle = .critical
  alert.messageText = "Kier couldn't start"
  alert.informativeText = detail + "\n\nTry again, or look at the log to see what happened. If it keeps failing, download Kier again from getkier.com and replace the copy in Applications."
  alert.addButton(withTitle: "Try Again")
  alert.addButton(withTitle: "Show Log")
  alert.addButton(withTitle: "Quit")
  switch alert.runModal() {
  case .alertFirstButtonReturn:
    // Restart the background copy now rather than after its pause, then open Kier again.
    let kick = Process()
    kick.executableURL = URL(fileURLWithPath: "/bin/launchctl")
    kick.arguments = ["kickstart", "-k", "gui/\(getuid())/com.getkier.agent"]
    try? kick.run()
    kick.waitUntilExit()
    let again = Process()
    again.executableURL = Bundle.main.executableURL
    again.arguments = ["open"]
    try? again.run()
  case .alertSecondButtonReturn:
    // Shown in Finder rather than opened: Kier only opens web links itself (LinkPolicy.swift).
    let log = URL(fileURLWithPath: vaultDirectory).appendingPathComponent("kier.log")
    NSWorkspace.shared.activateFileViewerSelecting([FileManager.default.fileExists(atPath: log.path) ? log : URL(fileURLWithPath: vaultDirectory)])
  default: break
  }
  exit(1)
}

func launchProblem(_ error: Error) -> String {
  let e = error as NSError
  return e.domain == NSURLErrorDomain && e.code == NSURLErrorNoPermissionsToReadFile
    ? "macOS would not run Kier's background part (error \(e.code)). This happens when files inside Kier.app were changed after it was installed."
    : "Kier's background part would not run: \(e.localizedDescription)"
}

child.terminationHandler = { process in
  if args.first == "open", process.terminationStatus == 0 {
    let page = String(data: output.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? "/"
    DistributedNotificationCenter.default().postNotificationName(.init("com.getkier.show"), object: page, userInfo: nil, deliverImmediately: true)
  } else if args.first == "open" {
    // The background copy never answered: usually because it can't start, which it has written down.
    let reason = lastFailure().map { "Kier's background part has failed to start \($0.count == 1 ? "once" : "\($0.count) times") since \(Date(timeIntervalSince1970: $0.since).formatted(date: .omitted, time: .shortened))." }
    DispatchQueue.main.async { showProblem(reason ?? "Kier's background part didn't answer.") }
    return
  }
  exit(process.terminationStatus)
}
// Python run from inside the app once wrote bytecode caches beside the sidecars. That breaks Kier.app's signature, and
// after a while macOS refuses to start the bundled Node, so Kier never opens. The sidecars run with -B now; a cache left
// from before goes here, before Node starts.
if bundled { try? FileManager.default.removeItem(atPath: root + "/sidecar/__pycache__") }
do {
  if daemon && bundled {
    try gmailVault.prepareForLaunch(node: URL(fileURLWithPath: node), daemon: URL(fileURLWithPath: root + "/bin/kier.mjs"))
  }
  try child.run()
} catch {
  if daemon { failedToStart("\(node): \(error)") }
  if args.first == "open" { showProblem(launchProblem(error)) }
  FileHandle.standardError.write("Kier could not start \(node): \(error)\n".data(using: .utf8)!)
  exit(1)
}
if daemon, let failure = lastFailure() {
  launchLog("Kier started again after \(failure.count) failed \(failure.count == 1 ? "try" : "tries")")
  try? FileManager.default.removeItem(at: failureURL)
}

var forwarders: [DispatchSourceSignal] = []
for sig in [SIGTERM, SIGINT, SIGHUP] {
  signal(sig, SIG_IGN)
  let source = DispatchSource.makeSignalSource(signal: sig, queue: .main)
  source.setEventHandler { kill(child.processIdentifier, sig) }
  source.resume()
  forwarders.append(source)
}

// MARK: Eyes, only while Kier runs in the background

final class Eyes {
  private var pending: [[String: Any]] = []
  private let ingest = URL(string: "http://127.0.0.1:4777/api/ingest")!

  // Clipboard: macOS has no change notification, so poll the change counter once a second.
  private var lastChange = NSPasteboard.general.changeCount
  // Password managers mark what they copy (nspasteboard.org); those items are never read.
  private let secretTypes: Set<String> = [
    "org.nspasteboard.ConcealedType", "org.nspasteboard.TransientType", "org.nspasteboard.AutoGeneratedType",
    "com.agilebits.onepassword", "com.bitwarden.desktop", "com.apple.Passwords",
  ]

  // App sessions: which app was in front, from when, for how long.
  private var front: (name: String, bundle: String, since: Date)?

  // Screen text: chat apps whose windows Kier may read through Accessibility. Both lists come from the
  // daemon's app discovery (what each installed app is for), refreshed every minute.
  private var screenApps: Set<String> = []
  private var capturePolicy: CapturePolicy?
  private var flushing = false
  // Banking, password and health apps: nothing is read while they're in front, not even the clipboard.
  private var quietApps: Set<String> = []
  private var browsers: Set<String> = []
  private var seen: [String: Set<String>] = [:]
  private var seenOrder: [String: [String]] = [:]
  private var electronReady: Set<pid_t> = []
  private let dataDir = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/Kier")

  private func loadLists() {
    func list(_ name: String) -> Set<String>? {
      guard let data = try? Data(contentsOf: dataDir.appendingPathComponent(name)) else { return nil }
      return (try? JSONSerialization.jsonObject(with: data) as? [String]).map(Set.init)
    }
    screenApps = list("screen-apps.json") ?? []
    quietApps = list("quiet-apps.json") ?? []
    // A browser is any app macOS would open a web link with, so new ones count without a list.
    browsers = Set(NSWorkspace.shared.urlsForApplications(toOpen: URL(string: "https://example.com")!).compactMap { Bundle(url: $0)?.bundleIdentifier })
  }

  func start() {
    let center = NSWorkspace.shared.notificationCenter
    center.addObserver(forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main) { [weak self] note in
      guard let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication else { return }
      self?.switched(to: app)
    }
    for name in [NSWorkspace.screensDidSleepNotification, NSWorkspace.sessionDidResignActiveNotification] {
      center.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in self?.endSession() }
    }
    if let app = NSWorkspace.shared.frontmostApplication { switched(to: app) }
    loadLists()
    Timer.scheduledTimer(withTimeInterval: 60, repeats: true) { [weak self] _ in self?.loadLists() }
    Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in self?.clipboard() }
    Timer.scheduledTimer(withTimeInterval: 4, repeats: true) { [weak self] _ in self?.screen() }
    Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in self?.flush() }
  }

  private func emit(_ source: String, thread: String, text: String, at: Date = Date(), meta: [String: Any] = [:]) {
    guard capturePolicy?.permits(source: source, app: meta["app"] as? String ?? "", name: thread) == true else { return }
    pending.append(["source": source, "thread": thread, "text": text, "ts": Int(at.timeIntervalSince1970), "meta": meta])
    if pending.count > 500 { pending.removeFirst(pending.count - 500) }
  }

  // MARK: Clipboard

  private func clipboard() {
    let pb = NSPasteboard.general
    guard pb.changeCount != lastChange else { return }
    lastChange = pb.changeCount
    guard capturePolicy?.permits(source: "clipboard", app: front?.bundle ?? "", name: front?.name ?? "") == true else { return }
    if let f = front, quietApps.contains(f.bundle) || f.bundle == Bundle.main.bundleIdentifier { return }
    // Private and incognito windows keep no history, so what is copied in them isn't kept either.
    if let f = front, browsers.contains(f.bundle), privateWindow() { return }
    let types = (pb.types ?? []).map(\.rawValue)
    if types.contains(where: { secretTypes.contains($0) || $0.lowercased().contains("password") }) { return }
    guard let raw = pb.string(forType: .string)?.trimmingCharacters(in: .whitespacesAndNewlines), raw.count > 1 else { return }
    emit("clipboard", thread: front?.name ?? "Clipboard", text: String(raw.prefix(4000)), meta: ["app": front?.bundle ?? ""])
  }

  private func privateWindow() -> Bool {
    guard AXIsProcessTrusted(), let app = NSWorkspace.shared.frontmostApplication else { return false }
    let element = AXUIElementCreateApplication(app.processIdentifier)
    AXUIElementSetMessagingTimeout(element, 0.3)
    guard let window = attribute(element, kAXFocusedWindowAttribute) else { return false }
    var searched = 0
    return marked(window as! AXUIElement, searched: &searched)
  }

  // Browsers say so in their own frame: the window title, the toolbar's profile button. The page itself is
  // skipped, since an article about incognito mode isn't an incognito window.
  private func marked(_ el: AXUIElement, searched: inout Int) -> Bool {
    searched += 1
    guard searched < 800, attribute(el, kAXRoleAttribute) as? String != "AXWebArea" else { return false }
    for attr in [kAXTitleAttribute, kAXDescriptionAttribute, kAXHelpAttribute] {
      if let s = attribute(el, attr) as? String,
         s.range(of: #"\b(incognito|inprivate|private browsing)\b"#, options: [.regularExpression, .caseInsensitive]) != nil { return true }
    }
    for c in attribute(el, kAXChildrenAttribute) as? [AXUIElement] ?? [] where marked(c, searched: &searched) { return true }
    return false
  }

  // MARK: Apps

  private func switched(to app: NSRunningApplication) {
    endSession()
    guard app.activationPolicy == .regular, let bundle = app.bundleIdentifier else { return }
    front = (app.localizedName ?? bundle, bundle, Date())
  }

  private func endSession() {
    guard let f = front else { return }
    front = nil
    let seconds = Int(Date().timeIntervalSince(f.since))
    // Short hops between windows are noise; a minute or more is "using" the app.
    guard seconds >= 60 else { return }
    let minutes = max(1, Int((Double(seconds) / 60).rounded()))
    emit("apps", thread: f.name, text: "Used \(f.name) for \(minutes) min", at: f.since, meta: ["app": f.bundle, "seconds": seconds])
  }

  // MARK: Chat text through Accessibility

  // Read chat apps without database collectors through Accessibility: the focused app every four
  // seconds and other running chat apps every twenty seconds, including minimized windows.
  // Accessible message roles supply author, time and text. Fall back to lines when roles are missing.
  // Never read text fields or quiet apps.
  private let reader = DispatchQueue(label: "kier.eyes.chats", qos: .utility)
  private var lastBackground = Date.distantPast

  private func screen() {
    guard AXIsProcessTrusted() else { return }
    let frontBundle = NSWorkspace.shared.frontmostApplication?.bundleIdentifier
    var targets: [(app: NSRunningApplication, all: Bool)] = []
    if let f = front, screenApps.contains(f.bundle), capturePolicy?.permits(source: "screen", app: f.bundle, name: f.name) == true, let app = NSWorkspace.shared.frontmostApplication, app.bundleIdentifier == f.bundle {
      targets.append((app, false))
    }
    if Date().timeIntervalSince(lastBackground) >= 20 {
      lastBackground = Date()
      for app in NSWorkspace.shared.runningApplications {
        guard let b = app.bundleIdentifier, b != frontBundle, screenApps.contains(b), !quietApps.contains(b), capturePolicy?.permits(source: "screen", app: b, name: app.localizedName ?? "") == true else { continue }
        targets.append((app, true))
      }
    }
    guard !targets.isEmpty else { return }
    let ready = electronReady
    reader.async { [weak self] in
      guard let self else { return }
      var woke: [pid_t] = []
      var captures: [Capture] = []
      for t in targets {
        let element = AXUIElementCreateApplication(t.app.processIdentifier)
        AXUIElementSetMessagingTimeout(element, 0.5)
        // Electron apps (Discord, Slack, Teams, Signal) only build an accessibility tree when asked.
        if !ready.contains(t.app.processIdentifier) {
          AXUIElementSetAttributeValue(element, "AXManualAccessibility" as CFString, kCFBooleanTrue)
          woke.append(t.app.processIdentifier)
          continue  // the tree appears on the next pass
        }
        let windows: [AXUIElement] = t.all
          ? (self.attribute(element, kAXWindowsAttribute) as? [AXUIElement] ?? [])
          : [self.attribute(element, kAXFocusedWindowAttribute)].compactMap { $0 as! AXUIElement? }
        let name = t.app.localizedName ?? t.app.bundleIdentifier ?? "App"
        for w in windows.prefix(4) { captures.append(self.read(w, app: name, bundle: t.app.bundleIdentifier ?? "")) }
      }
      DispatchQueue.main.async {
        self.electronReady.formUnion(woke)
        for c in captures { self.keep(c) }
      }
    }
  }

  private struct Message { let name: String; let heading: String; let when: [String]; let text: [String] }
  private struct Capture { let app: String; let bundle: String; let title: String; let messages: [Message]; let lines: [String] }

  // One window: its messages when the app marks them, otherwise its lines.
  private func read(_ window: AXUIElement, app: String, bundle: String) -> Capture {
    let title = (attribute(window, kAXTitleAttribute) as? String) ?? ""
    var searched = 0
    // Web and Electron apps mark the conversation as the page's main region; reading only that leaves out server
    // lists, channel names and buttons. Native apps have no such region, so the whole window is read.
    let content = main(in: window, searched: &searched) ?? window
    var found: [AXUIElement] = []
    var visited = 0
    containers(content, depth: 0, visited: &visited, into: &found)
    let messages = found.suffix(80).map(message)
    var lines: [String] = []
    if messages.isEmpty {
      var v = 0
      walk(content, depth: 0, visited: &v, into: &lines)
      // Reaction shortcodes like ":joy:" carry nothing worth keeping.
      lines.removeAll { $0.range(of: #"^(:[\w+-]+:\s*)+$"#, options: .regularExpression) != nil }
    }
    return Capture(app: app, bundle: bundle, title: title, messages: messages, lines: lines)
  }

  // A message, as screen readers are told: an article (web and Electron apps) or a row (native lists).
  private func containers(_ el: AXUIElement, depth: Int, visited: inout Int, into found: inout [AXUIElement]) {
    visited += 1
    guard depth < 60, visited < 8000 else { return }
    let role = attribute(el, kAXRoleAttribute) as? String ?? ""
    if skipRoles.contains(role) { return }
    if attribute(el, kAXSubroleAttribute) as? String == "AXDocumentArticle" || role == "AXRow" { found.append(el); return }
    for c in attribute(el, kAXChildrenAttribute) as? [AXUIElement] ?? [] { containers(c, depth: depth + 1, visited: &visited, into: &found) }
  }

  private func message(_ el: AXUIElement) -> Message {
    let name = (attribute(el, kAXTitleAttribute) as? String) ?? (attribute(el, kAXDescriptionAttribute) as? String) ?? ""
    var heading = ""
    var when: [String] = []
    var text: [String] = []
    func visit(_ e: AXUIElement, depth: Int, inHeading: Bool, inTime: Bool) {
      guard depth < 24 else { return }
      let role = attribute(e, kAXRoleAttribute) as? String ?? ""
      let sub = attribute(e, kAXSubroleAttribute) as? String ?? ""
      // Toolbars on hover ("Message Actions": react, reply, forward) and anything you type into are never the message.
      if skipRoles.contains(role) || sub == "AXApplicationGroup" || role == "AXToolbar" { return }
      if role == "AXHeading", heading.isEmpty { heading = (attribute(e, kAXTitleAttribute) as? String) ?? "" }
      let timeGroup = inTime || sub == "AXTimeGroup"
      let value: String? = role == "AXStaticText" ? attribute(e, kAXValueAttribute) as? String
        : (role == "AXButton" || role == "AXLink") ? attribute(e, kAXTitleAttribute) as? String : nil
      if let v = value?.trimmingCharacters(in: .whitespacesAndNewlines), !v.isEmpty {
        if timeGroup || inHeading { if role == "AXStaticText" { when.append(v) } }
        else { text.append(String(v.prefix(1000))) }
      }
      for c in attribute(e, kAXChildrenAttribute) as? [AXUIElement] ?? [] {
        visit(c, depth: depth + 1, inHeading: inHeading || role == "AXHeading", inTime: timeGroup)
      }
    }
    visit(el, depth: 0, inHeading: false, inTime: false)
    return Message(name: name, heading: heading, when: when, text: text)
  }

  // Back on the main thread: only what wasn't seen before in that app goes to the daemon.
  private func keep(_ c: Capture) {
    let key = c.bundle
    var known = seen[key, default: []]
    var order = seenOrder[key, default: []]
    let thread = c.title.isEmpty ? c.app : "\(c.app): \(c.title)"
    if !c.messages.isEmpty {
      let fresh = c.messages.filter { known.insert("\(c.title)|\($0.name)|\($0.heading)|\($0.text.joined(separator: " "))").inserted }
      order.append(contentsOf: fresh.map { "\(c.title)|\($0.name)|\($0.heading)|\($0.text.joined(separator: " "))" })
      trim(key, &known, &order)
      guard !fresh.isEmpty else { return }
      let text = fresh.map { m in ([m.heading] + m.text).filter { !$0.isEmpty }.joined(separator: " ") }.joined(separator: "\n")
      emit("screen", thread: thread, text: String(text.prefix(6000)), meta: [
        "app": c.bundle, "messages": fresh.map { ["name": $0.name, "heading": $0.heading, "when": $0.when, "text": $0.text] },
      ])
      return
    }
    let fresh = c.lines.filter { known.insert($0).inserted }
    order.append(contentsOf: fresh)
    trim(key, &known, &order)
    guard !fresh.isEmpty else { return }
    emit("screen", thread: thread, text: String(fresh.joined(separator: "\n").prefix(6000)), meta: ["app": c.bundle, "lines": fresh.count])
  }

  // Remember the last 20,000 lines or messages per app, so scrolling back doesn't re-save old ones.
  private func trim(_ key: String, _ known: inout Set<String>, _ order: inout [String]) {
    if order.count > 20000 {
      for gone in order.prefix(order.count - 20000) { known.remove(gone) }
      order.removeFirst(order.count - 20000)
    }
    seen[key] = known
    seenOrder[key] = order
  }

  // Reads labels and message text; never text fields, so drafts and passwords stay out.
  private let skipRoles: Set<String> = ["AXTextField", "AXTextArea", "AXSecureTextField", "AXComboBox", "AXSearchField", "AXMenuBar", "AXMenu"]

  private func walk(_ el: AXUIElement, depth: Int, visited: inout Int, into lines: inout [String]) {
    visited += 1
    guard depth < 60, visited < 5000 else { return }
    let role = attribute(el, kAXRoleAttribute) as? String ?? ""
    if skipRoles.contains(role) { return }
    if role == "AXStaticText" || role == "AXHeading" || role == "AXLink" {
      for attr in [kAXValueAttribute, kAXTitleAttribute, kAXDescriptionAttribute] {
        if let s = attribute(el, attr) as? String {
          let t = s.trimmingCharacters(in: .whitespacesAndNewlines)
          if t.count > 1 { lines.append(String(t.prefix(1000))); break }
        }
      }
    }
    guard let children = attribute(el, kAXChildrenAttribute) as? [AXUIElement] else { return }
    for c in children { walk(c, depth: depth + 1, visited: &visited, into: &lines) }
  }

  private func main(in el: AXUIElement, searched: inout Int) -> AXUIElement? {
    searched += 1
    guard searched < 3000 else { return nil }
    if attribute(el, kAXSubroleAttribute) as? String == "AXLandmarkMain" { return el }
    for c in attribute(el, kAXChildrenAttribute) as? [AXUIElement] ?? [] {
      if let found = main(in: c, searched: &searched) { return found }
    }
    return nil
  }

  private func attribute(_ el: AXUIElement, _ name: String) -> AnyObject? {
    var value: AnyObject?
    return AXUIElementCopyAttributeValue(el, name as CFString, &value) == .success ? value : nil
  }

  // MARK: Hand over to the daemon

  private func flush() {
    guard !flushing else { return }
    flushing = true
    let policyURL = ingest.deletingLastPathComponent().appendingPathComponent("capture-policy")
    var request = URLRequest(url: policyURL)
    request.timeoutInterval = 10
    daemonClient.send(request) { [weak self] data, response, _ in
      let json = data.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
      DispatchQueue.main.async {
        guard let self else { return }
        guard (response as? HTTPURLResponse)?.statusCode == 200, let json, let policy = CapturePolicy(json: json) else {
          self.capturePolicy = nil
          self.pending.removeAll()
          self.flushing = false
          return
        }
        self.capturePolicy = policy
        self.pending.removeAll { item in
          let meta = item["meta"] as? [String: Any] ?? [:]
          return !policy.permits(source: item["source"] as? String ?? "", app: meta["app"] as? String ?? "", name: item["thread"] as? String ?? "")
        }
        self.sendPermitted()
      }
    }
  }

  private func sendPermitted() {
    var body: [String: Any] = ["status": ["accessibility": AXIsProcessTrusted(), "front": front?.bundle ?? "", "phone": PhoneSync.allowed, "events": PhoneSync.eventsAllowed, "reminders": PhoneSync.remindersAllowed]]
    let batch = pending
    body["items"] = batch
    var request = URLRequest(url: ingest)
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "content-type")
    request.httpBody = try? JSONSerialization.data(withJSONObject: body)
    request.timeoutInterval = 10
    daemonClient.send(request) { [weak self] _, response, _ in
      DispatchQueue.main.async { self?.flushing = false }
      guard (response as? HTTPURLResponse)?.statusCode == 200 else {
        DispatchQueue.main.async { self?.capturePolicy = nil; self?.pending.removeAll() }
        return
      }
      // Only what the daemon accepted leaves the queue; the rest is retried in 5 seconds.
      DispatchQueue.main.async { self?.pending.removeFirst(min(batch.count, self?.pending.count ?? 0)) }
    }
  }
}

// MARK: Menu bar: how much is waiting, today's cards, and the brief out loud

final class Bar: NSObject, NSMenuDelegate {
  private let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
  private let menu = NSMenu()
  private var events: [String] = []
  private var tasks: [String] = []
  private var maybe = 0
  private let base = "http://127.0.0.1:4777"

  override init() {
    super.init()
    item.button?.image = KierMark.barImage()
    item.button?.imagePosition = .imageLeading
    menu.delegate = self
    item.menu = menu
    refresh()
    Timer.scheduledTimer(withTimeInterval: 60, repeats: true) { [weak self] _ in self?.refresh() }
  }

  private func refresh() {
    guard let url = URL(string: "\(base)/api/brief") else { return }
    daemonClient.send(daemonRequest(url)) { [weak self] data, _, _ in
      guard let data, let b = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return }
      let today = b["today"] as? [String: Any] ?? [:]
      let summaries = { (key: Any?) in (key as? [[String: Any]] ?? []).compactMap { $0["summary"] as? String } }
      let clock = DateFormatter()
      clock.dateFormat = "HH:mm"
      let ev = (today["events"] as? [[String: Any]] ?? []).compactMap { e -> String? in
        guard let text = e["text"] as? String else { return nil }
        if e["allDay"] as? Bool == true { return "All day: \(text)" }
        guard let ts = e["ts"] as? Double else { return text }
        return "\(clock.string(from: Date(timeIntervalSince1970: ts))) \(text)"
      }
      let list = summaries(today["tasks"]) + summaries(b["forgotten"]) + summaries(b["open"])
      let more = b["more"] as? [String: Any] ?? [:]
      let maybeCount = summaries(b["maybe"]).count + (more["maybe"] as? Int ?? 0)
      DispatchQueue.main.async {
        self?.events = ev
        self?.tasks = list
        self?.maybe = maybeCount
        self?.item.button?.title = list.isEmpty ? "" : " \(list.count)"
      }
    }
  }

  func menuNeedsUpdate(_ menu: NSMenu) {
    menu.removeAllItems()
    let header = NSMenuItem(title: tasks.isEmpty ? "Nothing waiting on you" : "\(tasks.count) waiting on you", action: nil, keyEquivalent: "")
    header.isEnabled = false
    menu.addItem(header)
    for e in events.prefix(4) { menu.addItem(entry(e, #selector(openTimeline))) }
    for t in tasks.prefix(10) { menu.addItem(entry(t, #selector(openTimeline))) }
    if maybe > 0 { menu.addItem(entry("Maybe yours: \(maybe)", #selector(openTimeline))) }
    menu.addItem(.separator())
    // Reading the brief aloud is switched off for now ; speak() and stopTalking() stay for when it's back.
    menu.addItem(entry(MainActor.assumeIsolated { companion?.visible ?? false } ? "Hide the orb" : "Show the orb", #selector(toggleOrb)))
    menu.addItem(entry("Open Kier", #selector(openTimeline)))
    menu.addItem(entry("Vault", #selector(openVault)))
    menu.addItem(entry("Setup", #selector(openSetup)))
    if let u = MainActor.assumeIsolated({ updater }) {
      menu.addItem(.separator())
      menu.addItem(entry(MainActor.assumeIsolated { u.pending.map { "Update to Kier \($0)" } ?? "Check for Updates…" }, #selector(checkUpdates)))
    }
    menu.addItem(.separator())
    menu.addItem(entry("Quit Kier", #selector(quitKier)))
  }

  private func entry(_ title: String, _ action: Selector) -> NSMenuItem {
    let short = title.count > 60 ? String(title.prefix(59)) + "…" : title
    let m = NSMenuItem(title: short, action: action, keyEquivalent: "")
    m.target = self
    return m
  }

  @MainActor @objc private func quitKier() { viewer.quit() }
  @MainActor @objc private func openTimeline() { viewer.show("/") }
  @MainActor @objc private func openSetup() { viewer.show("/setup") }
  @MainActor @objc private func openVault() { viewer.show("/vault") }
  @MainActor @objc private func toggleOrb() { companion?.toggleOrb() }
  @MainActor @objc private func checkUpdates() { updater?.checkNow() }
  @objc private func stopTalking() {
    var request = daemonRequest(URL(string: "\(base)/api/speak/stop")!)
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "content-type")
    request.httpBody = Data("{}".utf8)
    daemonClient.send(request)
  }
  @objc private func speak() {
    var request = daemonRequest(URL(string: "\(base)/api/speak")!)
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "content-type")
    request.httpBody = Data("{}".utf8)
    daemonClient.send(request)
  }
}

// Double-clicking Kier.app while it runs lands here instead of starting a second copy.
final class Delegate: NSObject, NSApplicationDelegate {
  @MainActor func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
    viewer.show("/")
    return false
  }

  // Quitting for an update (Updater.swift) takes the daemon with it, so the new Kier starts its own.
  func applicationWillTerminate(_ notification: Notification) { kill(child.processIdentifier, SIGTERM) }
}

let app = NSApplication.shared
// The background copy lives in the menu bar; any other launch (opened from Finder, setup commands) stays invisible.
app.setActivationPolicy(daemon ? .accessory : .prohibited)
let viewer = MainActor.assumeIsolated { Viewer() }
let delegate = Delegate()
var eyes: Eyes?
var bar: Bar?
var companion: Companion?
var updater: Updater?
if daemon {
  app.delegate = delegate
  MainActor.assumeIsolated { viewer.installMenu() }
  DistributedNotificationCenter.default().addObserver(forName: .init("com.getkier.show"), object: nil, queue: .main) { note in
    let page = note.object as? String ?? "/"
    // "companion" opens the orb's panel, so a script can show it without a keystroke; "peek:/" and "unpeek" show the
    // window behind everything for a screenshot and put it away.
    MainActor.assumeIsolated {
      if page == "companion" { companion?.toggleChat() }
      else if page == "nudge" { companion?.nudgeNow() }
      // "hover:on" and "hover:off" act as if the pointer came onto the island and left, for measuring its animation.
      else if page.hasPrefix("hover:") { companion?.pretendHover(page == "hover:on") }
      else if page.hasPrefix("peek:") { viewer.peek(String(page.dropFirst(5))) }
      else if page == "unpeek" { viewer.unpeek() }
      else { viewer.show(page) }
    }
  }
  eyes = Eyes()
  eyes?.start()
  bar = Bar()
  companion = MainActor.assumeIsolated { Companion(store: viewer.store) }
  // Only the downloaded Kier updates itself; a development build runs the daemon from a checkout.
  if bundled {
    MainActor.assumeIsolated {
      updater = Updater()
      updater?.show = { companion?.showUpdate() }
      updater?.hide = { companion?.hideUpdate() }
      updater?.start()
    }
  }
  // A new Kier put in this one's place while it runs (an update, or a newer copy dragged into Applications): quit, and
  // the login agent starts the new one. This also catches launchd restarting the old copy before an update had finished
  // installing.
  let build = info["CFBundleVersion"] as? String
  Timer.scheduledTimer(withTimeInterval: 10, repeats: true) { _ in
    let plist = Bundle.main.bundleURL.appendingPathComponent("Contents/Info.plist")
    guard let now = NSDictionary(contentsOf: plist)?["CFBundleVersion"] as? String, now != build else { return }
    kill(child.processIdentifier, SIGTERM)
  }
}
app.run()
