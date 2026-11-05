import AppKit
import ApplicationServices

// Puts a hand-off note into a running Claude session and sends it. Claude comes forward, the session is opened from
// its sidebar if another one is showing, and the note is pasted and sent only once that exact session is open and its
// message box is empty, so a draft of yours is never sent along. Anything less and the note stays on the clipboard,
// with the reason. Uses the Accessibility access Kier already has for reading the screen.
enum Deliver {
  static let claude = "com.anthropic.claudefordesktop"

  // Only open the session, nothing pasted: "Open in Claude" on a card from that session.
  @MainActor static func open(session title: String, done: @escaping @MainActor (String?) -> Void) { toClaude(nil, session: title, done: done) }

  @MainActor static func toClaude(_ note: String?, session title: String, done: @escaping @MainActor (String?) -> Void) {
    guard let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: claude) else { done("Claude isn't installed"); return }
    // Opening it through Launch Services brings it forward; a background app asking it to activate is often ignored.
    let config = NSWorkspace.OpenConfiguration()
    config.activates = true
    NSWorkspace.shared.openApplication(at: url, configuration: config) { app, _ in
      DispatchQueue.main.async {
        guard let app else { done("Claude didn't open"); return }
        attempt(app, note, title, opened: false, tries: 0, done: done)
      }
    }
  }

  @MainActor private static func attempt(_ app: NSRunningApplication, _ note: String?, _ title: String, opened: Bool, tries: Int,
                                         done: @escaping @MainActor (String?) -> Void) {
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
      guard front() else {
        if tries < 3 { attempt(app, note, title, opened: opened, tries: tries + 1, done: done) } else { done("Claude didn't come forward") }
        return
      }
      let view = look(app, title)
      // Another session is showing: open this one from the sidebar, once, then give a long session a few seconds to
      // draw before looking again.
      if !view.open {
        if !opened, let row = view.row, AXUIElementPerformAction(row, kAXPressAction as CFString) == .success {
          attempt(app, note, title, opened: true, tries: 0, done: done)
        } else if opened, tries < 8 {
          attempt(app, note, title, opened: true, tries: tries + 1, done: done)
        } else {
          done(view.row == nil ? "couldn't find “\(title)” in Claude" : "“\(title)” didn't open in Claude")
        }
        return
      }
      guard let note else { done(nil); return }
      guard let box = view.box else { done("couldn't find the message box"); return }
      guard view.draft.isEmpty else { done("your message box there had a draft"); return }
      AXUIElementSetAttributeValue(box, kAXFocusedAttribute as CFString, kCFBooleanTrue)
      press(9, .maskCommand)
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.45) {
        let start = String(note.split(separator: "\n").first ?? "").prefix(40).trimmingCharacters(in: .whitespaces)
        guard front() else { done("Claude lost focus before sending"); return }
        guard (text(attr(box, kAXValueAttribute)) ?? "").contains(start) else { done("the paste didn't land"); return }
        press(36, [])
        done(nil)
      }
    }
  }

  private static func front() -> Bool { NSWorkspace.shared.frontmostApplication?.bundleIdentifier == claude }

  // What Claude's window shows: whether `title` is the open session (its title is a heading; the sidebar lists sessions
  // as buttons, never headings), its sidebar row, and the message box with whatever is typed in it.
  private static func look(_ app: NSRunningApplication, _ title: String) -> (open: Bool, row: AXUIElement?, box: AXUIElement?, draft: String) {
    let ax = AXUIElementCreateApplication(app.processIdentifier)
    guard let window = attr(ax, kAXFocusedWindowAttribute) else { return (false, nil, nil, "") }
    var headings: [String] = []
    var boxes: [AXUIElement] = []
    var row: AXUIElement?
    var seen = 0
    func walk(_ e: AXUIElement, _ depth: Int) {
      seen += 1
      if seen > 8000 || depth > 50 { return }
      let role = text(attr(e, kAXRoleAttribute)) ?? ""
      if role == "AXHeading" { headings.append(label(e)) }
      if role == "AXTextArea" { boxes.append(e) }
      if role == "AXButton", row == nil, label(e).hasPrefix(title) { row = e }
      for child in (attr(e, kAXChildrenAttribute) as? [AXUIElement]) ?? [] { walk(child, depth + 1) }
    }
    walk(window as! AXUIElement, 0)
    let open = headings.contains(title)
    let box = boxes.last(where: { label($0).contains("Prompt") }) ?? boxes.last
    let draft = box.flatMap { text(attr($0, kAXValueAttribute)) }?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    return (open, row, box, draft)
  }

  private static func attr(_ e: AXUIElement, _ name: String) -> AnyObject? {
    var value: AnyObject?
    return AXUIElementCopyAttributeValue(e, name as CFString, &value) == .success ? value : nil
  }

  private static func text(_ v: AnyObject?) -> String? { v as? String }

  private static func label(_ e: AXUIElement) -> String {
    [kAXTitleAttribute, kAXValueAttribute, kAXDescriptionAttribute].compactMap { text(attr(e, $0)) }.filter { !$0.isEmpty }.joined(separator: " ")
  }

  private static func press(_ key: CGKeyCode, _ flags: CGEventFlags) {
    let source = CGEventSource(stateID: .combinedSessionState)
    for down in [true, false] {
      let e = CGEvent(keyboardEventSource: source, virtualKey: key, keyDown: down)
      e?.flags = flags
      e?.post(tap: .cghidEventTap)
    }
  }
}
