import AppKit
import Carbon
import Observation
import SwiftUI

// MARK: The companion: Kier's island at the right edge of the screen, a small sky over a calm sea with the chrome orb
// floating in it. Click it or press Command-Option-K for the panel: what's waiting, each thing's own page, and a chat.

// A borderless panel that can still take typing, for the Ask field.
final class KeyPanel: NSPanel {
  override var canBecomeKey: Bool { true }
}

// What the island shows. Every change is passed on to the island's own layer (Island.swift), which draws and animates it.
@MainActor
final class OrbModel: ObservableObject {
  @Published var attention: Float = 0 { didSet { sync() } }
  @Published var working = false { didSet { sync() } }
  @Published var hover = false { didSet { sync() } }
  // The mouse is down on it: the orb gives a little at once, so a click shows it landed even when the Mac is busy.
  @Published var pressed = false { didSet { sync() } }
  @Published var glance: String? { didSet { sync() } }
  // Tucked into a thin notch at the edge, until you hover it.
  @Published var tucked = false { didSet { sync() } }
  // A nudge is waiting behind the tucked notch; the notch widens a little and breathes until you hover it.
  @Published var nudging = false { didSet { sync() } }
  // Kier's panel is open beside the island; the orb turns toward it.
  @Published var panel = false { didSet { sync() } }
  // When something new last came in; the rim runs wild for a few seconds after.
  @Published var burst = Date.distantPast { didSet { sync() } }
  // When Kier last saw something done; a green ring ripples out from the orb.
  @Published var celebrated = Date.distantPast { didSet { sync() } }
  var center = NSPoint.zero { didSet { sync() } }
  weak var renderer: IslandRenderer? { didSet { sync() } }

  private func sync() {
    // The island's thread reads the pointer in screen points from the top left, so the orb's middle goes over that way.
    let top = NSScreen.screens.first?.frame.maxY ?? 0
    renderer?.set { g in
      g.tucked = tucked
      g.hover = hover
      g.pressed = pressed
      g.nudging = nudging
      g.panel = panel
      g.glance = glance != nil
      g.attention = attention
      g.working = working
      g.burst = burst
      g.celebrated = celebrated
      g.center = CGPoint(x: center.x, y: top - center.y)
    }
  }

  // How much of its window the island fills: a notch when tucked, taller with a line under the orb. The window itself
  // stays at the biggest size, so changes are drawn as one smooth spring and never resize a window.
  nonisolated static let window = CGSize(width: 78, height: 136)
  nonisolated static func size(tucked: Bool, nudging: Bool, glance: Bool) -> CGSize {
    if tucked { return nudging ? CGSize(width: 18, height: 76) : CGSize(width: 12, height: 64) }
    return CGSize(width: 78, height: glance ? 136 : 104)
  }
  var size: CGSize { OrbModel.size(tucked: tucked, nudging: nudging, glance: glance != nil) }
}

// Every change in the island's shape springs, never snaps.
let islandSpring = Animation.spring(response: 0.42, dampingFraction: 0.84)

// Where the island lives: always out, tucked into a notch that opens on hover, or hidden (Command-Option-K still works).
enum IslandMode: String, CaseIterable {
  case always, hover, hidden
  var title: String { ["always": "Always shown", "hover": "Tucked away, shown on hover", "hidden": "Hidden"][rawValue]! }
}

// How the orb's world is lit. "Hour" follows the sun where you are, like getkier.com: day, golden hour, then night.
enum Appearance: String, CaseIterable {
  case hour, light, dark, system
  var title: String { ["hour": "By the hour", "light": "Light", "dark": "Dark", "system": "System"][rawValue]! }
}

// Golden hour, twilight and night, each 0 to 1, for the shaders, as getkier.com draws them.
@MainActor
enum Daylight {
  // What the shaders draw now, eased toward where the sun is over about a second (the site's 1.4 per second), so a
  // change of phase, or of the setting, glides instead of jumping.
  private static var shown: SIMD3<Float>?
  private static var tick = Date()
  private static var target: (at: Date, value: SIMD3<Float>)?

  static var now: (dusk: Float, twilight: Float, night: Float) {
    let goal = aim()
    let dt = Float(min(1, Date().timeIntervalSince(tick)))
    tick = Date()
    var s = shown ?? goal
    s += (goal - s) * min(1, dt * 1.4)
    shown = s
    return (s.x, s.y, s.z)
  }

  // Where the light is heading; the island's own layer eases toward it itself.
  static var goal: SIMD3<Float> { aim() }

  private static func aim() -> SIMD3<Float> {
    switch Appearance(rawValue: UserDefaults.standard.string(forKey: "kierAppearance") ?? "") ?? .hour {
    case .light: return [0, 0, 0]
    case .dark: return [1, 0, 1]
    case .system: return NSApp.effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua ? [1, 0, 1] : [0, 0, 0]
    case .hour:
      // The sun moves slowly: worked out again every half minute, not every frame.
      if let t = target, Date().timeIntervalSince(t.at) < 30 { return t.value }
      let v = sun(Date())
      target = (Date(), v)
      return v
    }
  }

  // The sun's height from the date, the clock and the time zone (which gives the longitude), at a mid-northern
  // latitude: no location permission needed. Night once it's 6 degrees below the horizon, twilight from 4 above to
  // 6 below, and golden hour building from 14 degrees down, held through twilight and night.
  static func sun(_ date: Date, zone: TimeZone = .current) -> SIMD3<Float> {
    var cal = Calendar(identifier: .gregorian)
    cal.timeZone = zone
    let year = cal.component(.year, from: date)
    let offsets = [1, 7].compactMap { cal.date(from: DateComponents(year: year, month: $0, day: 1)) }.map { zone.secondsFromGMT(for: $0) }
    let standard = Double(offsets.min() ?? zone.secondsFromGMT(for: date)) / 3600
    var utc = Calendar(identifier: .gregorian)
    utc.timeZone = TimeZone(identifier: "UTC")!
    let hours = Double(utc.component(.hour, from: date)) + Double(utc.component(.minute, from: date)) / 60
    let day = Double(cal.ordinality(of: .day, in: .year, for: date) ?? 1)
    let rad = Double.pi / 180
    let decl = -23.44 * cos(2 * Double.pi * (day + 10) / 365) * rad
    let lat = 45 * rad
    let hourAngle = (hours + standard - 12) * 15 * rad
    let elevation = asin(sin(lat) * sin(decl) + cos(lat) * cos(decl) * cos(hourAngle)) / rad
    let night: Float = elevation <= -6 ? 1 : 0
    let twilight: Float = elevation > -6 && elevation < 4 ? 1 : 0
    let t = min(1, max(0, (elevation - 14) / (2 - 14)))
    let dusk: Float = night + twilight > 0 ? 1 : Float(t * t * (3 - 2 * t))
    return [dusk, twilight, night]
  }
}

// The island's outline: flush with the screen edge on the right, rounded on the left, and flaring into the edge at the
// top and bottom with concave curves, so it reads as growing out of the screen.
struct IslandShape: Shape {
  var fillet: CGFloat = 16
  var radius: CGFloat = 24

  // The curves morph too, from the notch's tight ones to the island's wide ones.
  var animatableData: AnimatablePair<CGFloat, CGFloat> {
    get { AnimatablePair(fillet, radius) }
    set { fillet = newValue.first; radius = newValue.second }
  }

  func path(in r: CGRect) -> Path {
    let W = r.width, H = r.height, f = fillet, R = radius
    var p = Path()
    p.move(to: CGPoint(x: W, y: 0))
    p.addLine(to: CGPoint(x: W, y: H))
    p.addQuadCurve(to: CGPoint(x: W - f, y: H - f), control: CGPoint(x: W, y: H - f))
    p.addLine(to: CGPoint(x: R, y: H - f))
    p.addQuadCurve(to: CGPoint(x: 0, y: H - f - R), control: CGPoint(x: 0, y: H - f))
    p.addLine(to: CGPoint(x: 0, y: f + R))
    p.addQuadCurve(to: CGPoint(x: R, y: f), control: CGPoint(x: 0, y: f))
    p.addLine(to: CGPoint(x: W - f, y: f))
    p.addQuadCurve(to: CGPoint(x: W, y: 0), control: CGPoint(x: W, y: f))
    p.closeSubpath()
    return p
  }
}

// Kier's mark inside its windows: a white disc with the icon's thin compass star cut out, the diagonals at half strength.
// The chrome orb lives only in the island; everywhere else it's this, as on getkier.com.
struct KierMark: View {
  // Rotate the mark in quarter turns while working and finish square.
  var working = false
  @State private var turns = 0.0

  var body: some View {
    Canvas { ctx, size in
      let s = min(size.width, size.height) / 24
      ctx.translateBy(x: (size.width - 24 * s) / 2, y: (size.height - 24 * s) / 2)
      ctx.scaleBy(x: s, y: s)
      ctx.fill(Path(ellipseIn: CGRect(x: 0.8, y: 0.8, width: 22.4, height: 22.4)), with: .color(Kier.bright))
      ctx.blendMode = .destinationOut
      ctx.fill(Self.star(rv: 5.6, rh: 5.6, waist: 0.75, turn: 45), with: .color(.black.opacity(0.55)))
      ctx.fill(Self.star(rv: 9.4, rh: 8.9, waist: 1.15, turn: 0), with: .color(.black))
    }
    .rotationEffect(.degrees(turns * 90))
    .task(id: working) {
      while working && !Task.isCancelled {
        withAnimation(.spring(duration: 0.6, bounce: 0.3)) { turns += 1 }
        try? await Task.sleep(for: .milliseconds(850))
      }
    }
  }

  // The same mark for the menu bar, as a template the bar tints for light or dark.
  static func barImage(size: CGFloat = 16) -> NSImage {
    let image = NSImage(size: NSSize(width: size, height: size), flipped: true) { rect in
      guard let ctx = NSGraphicsContext.current?.cgContext else { return false }
      ctx.scaleBy(x: rect.width / 24, y: rect.height / 24)
      ctx.setFillColor(NSColor.black.cgColor)
      ctx.fillEllipse(in: CGRect(x: 0.8, y: 0.8, width: 22.4, height: 22.4))
      ctx.setBlendMode(.destinationOut)
      ctx.addPath(star(rv: 5.6, rh: 5.6, waist: 0.75, turn: 45).cgPath)
      ctx.setFillColor(NSColor.black.withAlphaComponent(0.55).cgColor)
      ctx.fillPath()
      ctx.addPath(star(rv: 9.4, rh: 8.9, waist: 1.15, turn: 0).cgPath)
      ctx.setFillColor(NSColor.black.cgColor)
      ctx.fillPath()
      return true
    }
    image.isTemplate = true
    image.accessibilityDescription = "Kier AI"
    return image
  }

  // Four thin points round the middle of a 24 point square, each edge hugging its axis down to a small waist.
  static func star(rv: CGFloat, rh: CGFloat, waist w: CGFloat, turn: CGFloat) -> Path {
    let a = turn * .pi / 180
    func p(_ x: CGFloat, _ y: CGFloat) -> CGPoint { CGPoint(x: 12 + x * cos(a) - y * sin(a), y: 12 + x * sin(a) + y * cos(a)) }
    let tips = [p(0, -rv), p(rh, 0), p(0, rv), p(-rh, 0)]
    let sides: [(CGFloat, CGFloat)] = [(1, -1), (1, 1), (-1, 1), (-1, -1)]
    var path = Path()
    path.move(to: tips[0])
    for (k, (x, y)) in sides.enumerated() {
      let (near, far) = k % 2 == 0 ? ((0.25, 1.7), (1.7, 0.25)) : ((1.7, 0.25), (0.25, 1.7))
      path.addQuadCurve(to: p(x * w, y * w), control: p(x * w * near.0, y * w * near.1))
      path.addQuadCurve(to: tips[(k + 1) % 4], control: p(x * w * far.0, y * w * far.1))
    }
    path.closeSubpath()
    return path
  }
}

// Over the island's own Metal layer (Island.swift), the one thing SwiftUI still draws: the glance, one short line under
// the orb when something is worth a glance ("in 5 min", "2 overdue", "Claude asks"). It fades and shrinks into the notch
// with the orb as the island tucks away.
struct IslandView: View {
  @ObservedObject var model: OrbModel

  var body: some View {
    let shape = model.tucked ? IslandShape(fillet: 6, radius: 4) : IslandShape()
    let size = model.size
    ZStack {
      if let glance = model.glance {
        Text(glance)
          .font(.system(size: 10, weight: .medium, design: .rounded))
          .foregroundStyle(Color(white: Daylight.now.night + Daylight.now.twilight > 0.5 ? 0.9 : 0.18).opacity(0.75))
          .lineLimit(1)
          .offset(x: -2, y: 38)
          .transition(.opacity)
          .opacity(model.tucked ? 0 : 1)
          .scaleEffect(model.tucked ? 0.35 : 1)
      }
    }
    .frame(width: size.width, height: size.height)
    .clipShape(shape)
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .trailing)
  }
}

// The island's window content: the drawing on top, and all the clicking, dragging and hovering handled here.
final class IslandHost: NSView {
  var onClick: () -> Void = {}
  var onDrag: (CGFloat) -> Void = { _ in }
  var menuFor: () -> NSMenu = { NSMenu() }
  var onHover: (Bool) -> Void = { _ in }
  let model = OrbModel()
  private var start: NSPoint?
  private var moved = false
  private var pointerTimer: Timer?
  private var pointerMonitors: [Any] = []

  override init(frame: NSRect) {
    super.init(frame: frame)
    if let renderer = IslandRenderer(size: bounds.size) {
      let canvas = IslandCanvas(renderer, frame: bounds)
      canvas.autoresizingMask = [.width, .height]
      addSubview(canvas)
      model.renderer = canvas.renderer
      // The hour's light, looked at every couple of seconds; the island only wakes for it when it has changed.
      canvas.renderer.set { $0.light = Daylight.goal }
      Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak canvas] _ in
        MainActor.assumeIsolated { canvas?.renderer.set { $0.light = Daylight.goal } }
      }
    }
    let host = NSHostingView(rootView: IslandView(model: model).environment(\.openURL, LinkPolicy.action))
    // The window never changes size, so SwiftUI mustn't report sizes to AppKit: by default every frame of the open and
    // close animation made AppKit lay the window out again, which under load cost most of the main thread.
    host.sizingOptions = []
    host.frame = bounds
    host.autoresizingMask = [.width, .height]
    addSubview(host)
  }

  required init?(coder: NSCoder) { fatalError() }

  // The part of the window the island covers right now; around it the window is see-through and lets the mouse past.
  var shown: NSRect {
    let s = model.size
    return NSRect(x: bounds.maxX - s.width, y: bounds.midY - s.height / 2, width: s.width, height: s.height)
  }

  // Returning nil from hitTest only skips views in this window; it does not pass a click
  // to another app. Make the window itself transparent outside the painted outline.
  func containsIsland(_ point: NSPoint) -> Bool {
    let geometry = model.renderer?.hitGeometry ?? IslandHitGeometry(
      width: model.size.width, height: model.size.height,
      fillet: model.tucked ? 6 : 16, radius: model.tucked ? 4 : 24)
    let local = CGPoint(x: point.x - bounds.maxX + geometry.width,
                        y: point.y - bounds.midY + geometry.height / 2)
    return IslandShape(fillet: geometry.fillet, radius: geometry.radius)
      .path(in: CGRect(x: 0, y: 0, width: geometry.width, height: geometry.height)).contains(local)
  }

  override func hitTest(_ point: NSPoint) -> NSView? {
    containsIsland(convert(point, from: superview)) ? self : nil
  }

  override func viewDidMoveToWindow() {
    super.viewDidMoveToWindow()
    pointerTimer?.invalidate()
    pointerMonitors.forEach(NSEvent.removeMonitor)
    pointerMonitors = []
    guard window != nil else { return }
    // Movement restores input even while the panel is click-through. The timer also
    // follows animated shape changes beneath a stationary pointer, in menu tracking too.
    if let m = NSEvent.addGlobalMonitorForEvents(matching: [.mouseMoved, .leftMouseDragged, .rightMouseDragged]) { [weak self] _ in
      self?.syncPointer()
    } { pointerMonitors.append(m) }
    if let m = NSEvent.addLocalMonitorForEvents(matching: [.mouseMoved, .leftMouseDragged, .rightMouseDragged]) { [weak self] event in
      self?.syncPointer()
      return event
    } { pointerMonitors.append(m) }
    let timer = Timer(timeInterval: 1.0 / 60, repeats: true) { [weak self] _ in
      MainActor.assumeIsolated { self?.syncPointer() }
    }
    pointerTimer = timer
    RunLoop.main.add(timer, forMode: .common)
    syncPointer()
  }

  deinit {
    pointerTimer?.invalidate()
    pointerMonitors.forEach(NSEvent.removeMonitor)
  }

  func syncPointer() {
    guard let window else { return }
    let point = convert(window.convertPoint(fromScreen: NSEvent.mouseLocation), from: nil)
    let inside = window.isVisible && containsIsland(point)
    // Keep a drag that began on Kier until mouseUp, even outside its outline.
    let ignore = !inside && start == nil
    if window.ignoresMouseEvents != ignore { window.ignoresMouseEvents = ignore }
    if model.hover != inside {
      model.hover = inside
      onHover(inside)
    }
  }

  func track() { if let w = window { model.center = NSPoint(x: w.frame.midX - 2, y: w.frame.midY + (model.glance == nil ? 0 : 8)) } }

  override func mouseDown(with event: NSEvent) {
    start = NSEvent.mouseLocation
    moved = false
    model.pressed = true
    Lag.input("A click on the island", event)
  }
  override func mouseDragged(with event: NSEvent) {
    guard let s = start else { return }
    let now = NSEvent.mouseLocation
    if abs(now.y - s.y) > 3 { moved = true; model.pressed = false }
    if moved { onDrag(now.y - s.y); start = now }
  }
  override func mouseUp(with event: NSEvent) {
    model.pressed = false
    start = nil
    if !moved { onClick() }
    syncPointer()
  }
  override func rightMouseDown(with event: NSEvent) { NSMenu.popUpContextMenu(menuFor(), with: event, for: self) }
  override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
}

// Record slow event delivery and main-thread stalls in lag.log, without message content.
enum Lag {
  private static let queue = DispatchQueue(label: "Kier lag")
  private static let url = URL(fileURLWithPath: NSHomeDirectory() + "/Library/Application Support/Kier/lag.log")

  static func note(_ line: String) {
    let stamp = Date().formatted(.iso8601.year().month().day().time(includingFractionalSeconds: false).dateTimeSeparator(.space))
    queue.async {
      let data = Data("\(stamp) \(line)\n".utf8)
      if let h = try? FileHandle(forWritingTo: url) { h.seekToEndOfFile(); h.write(data); try? h.close() } else { try? data.write(to: url) }
    }
  }

  // From the press itself to Kier seeing it: the window server and the main thread both have to let it through.
  static func input(_ what: String, _ event: NSEvent) {
    let ms = (ProcessInfo.processInfo.systemUptime - event.timestamp) * 1000
    if ms > 60 { note("\(what) reached Kier \(Int(ms)) ms after the press") }
  }

  // A thread of its own asks the main thread to answer twice a second and notes when it was too busy to.
  static func watch() {
    let t = Thread {
      while true {
        let sent = CACurrentMediaTime()
        let answered = DispatchSemaphore(value: 0)
        DispatchQueue.main.async { answered.signal() }
        answered.wait()
        let ms = (CACurrentMediaTime() - sent) * 1000
        if ms > 200 { note("Kier's main thread was stuck for \(Int(ms)) ms") }
        Thread.sleep(forTimeInterval: 0.5)
      }
    }
    t.name = "Kier lag watch"
    t.qualityOfService = .utility
    t.start()
  }
}

// A global shortcut as Settings keeps it (Views.swift ShortcutField): the key, Carbon's modifiers, and how it reads.
struct Shortcut: Codable, Equatable {
  var key: Int
  var modifiers: Int
  var label: String

  static let open = Shortcut(key: kVK_ANSI_K, modifiers: cmdKey | optionKey, label: "K")
  static let find = Shortcut(key: kVK_Space, modifiers: cmdKey | optionKey, label: "Space")
  static let changed = Notification.Name("KierShortcutChanged")
  // While one is being recorded the shortcuts let go, so pressing the current one records it instead of running it.
  static let recording = Notification.Name("KierShortcutRecording")

  var symbols: String {
    (modifiers & controlKey != 0 ? "⌃" : "") + (modifiers & optionKey != 0 ? "⌥" : "") + (modifiers & shiftKey != 0 ? "⇧" : "")
      + (modifiers & cmdKey != 0 ? "⌘" : "") + label
  }

  static func saved(_ name: String, or fallback: Shortcut) -> Shortcut {
    guard let data = UserDefaults.standard.data(forKey: "shortcut.\(name)"), let s = try? JSONDecoder().decode(Shortcut.self, from: data) else { return fallback }
    return s
  }

  static func save(_ s: Shortcut?, as name: String) {
    if let s, let data = try? JSONEncoder().encode(s) { UserDefaults.standard.set(data, forKey: "shortcut.\(name)") } else { UserDefaults.standard.removeObject(forKey: "shortcut.\(name)") }
    NotificationCenter.default.post(name: changed, object: nil)
  }

  // A key pressed with Command, Option or Control; anything else would take that key from every app.
  init?(_ e: NSEvent) {
    let f = e.modifierFlags.intersection(.deviceIndependentFlagsMask)
    guard !f.isDisjoint(with: [.command, .option, .control]) else { return nil }
    let named = [kVK_Space: "Space", kVK_Return: "↩", kVK_Tab: "⇥", kVK_Delete: "⌫", kVK_LeftArrow: "←", kVK_RightArrow: "→", kVK_UpArrow: "↑",
                 kVK_DownArrow: "↓", kVK_F1: "F1", kVK_F2: "F2", kVK_F3: "F3", kVK_F4: "F4", kVK_F5: "F5", kVK_F6: "F6", kVK_F7: "F7", kVK_F8: "F8",
                 kVK_F9: "F9", kVK_F10: "F10", kVK_F11: "F11", kVK_F12: "F12"]
    self.init(key: Int(e.keyCode),
              modifiers: (f.contains(.command) ? cmdKey : 0) | (f.contains(.option) ? optionKey : 0) | (f.contains(.control) ? controlKey : 0) | (f.contains(.shift) ? shiftKey : 0),
              label: named[Int(e.keyCode)] ?? (e.charactersIgnoringModifiers ?? "?").uppercased())
  }

  init(key: Int, modifiers: Int, label: String) {
    self.key = key
    self.modifiers = modifiers
    self.label = label
  }
}

// Global shortcuts (⌥⌘K for the panel, ⌥⌘Space for search, unless changed in Settings). Carbon hot keys need no
// permission and don't see any other keystroke. Each has its own id, and one handler sends a press to the shortcut it
// belongs to: with one shared action, a second shortcut took over the first. Letting one go frees its keys.
final class HotKey {
  nonisolated(unsafe) private static var actions: [UInt32: () -> Void] = [:]
  nonisolated(unsafe) private static var installed = false
  nonisolated(unsafe) private static var last: UInt32 = 0
  private var ref: EventHotKeyRef?
  private let id: UInt32

  convenience init(_ s: Shortcut, action: @escaping () -> Void) { self.init(key: s.key, modifiers: s.modifiers, action: action) }

  init(key: Int, modifiers: Int, action: @escaping () -> Void) {
    HotKey.last += 1
    id = HotKey.last
    HotKey.actions[id] = action
    if !HotKey.installed {
      HotKey.installed = true
      var spec = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
      InstallEventHandler(GetApplicationEventTarget(), { _, event, _ in
        var pressed = EventHotKeyID()
        GetEventParameter(event, EventParamName(kEventParamDirectObject), EventParamType(typeEventHotKeyID), nil, MemoryLayout<EventHotKeyID>.size, nil, &pressed)
        let id = pressed.id
        DispatchQueue.main.async { HotKey.actions[id]?() }
        return noErr
      }, 1, &spec, nil, nil)
    }
    let status = RegisterEventHotKey(UInt32(key), UInt32(modifiers), EventHotKeyID(signature: OSType(0x4B49_4552), id: id), GetApplicationEventTarget(), 0, &ref)
    if status != noErr { NSLog("Kier: shortcut \(key) is taken by another app (\(status))") }
  }

  deinit {
    if let ref { UnregisterEventHotKey(ref) }
    HotKey.actions[id] = nil
  }
}

@MainActor
final class Companion: NSObject {
  private let store: Store
  private var islandPanel: NSPanel!
  private var island: IslandHost!
  private var chatPanel: KeyPanel?
  private var bubble: NSPanel?
  private var hotKey: HotKey?
  // The search bar (FindBar.swift), on ⌥⌘Space unless changed.
  private var findKey: HotKey?
  private var findPanel: KeyPanel?
  private let find = FindModel()
  private var findResign: Any?
  private var monitors: [Any] = []
  private var openedAt = 0.0
  private let defaults = UserDefaults.standard
  // The island's window: always the island's biggest size; what's drawn inside it changes (see OrbModel.size).
  private let size = NSSize(width: OrbModel.window.width, height: OrbModel.window.height)
  private var tuckTimer: Timer?
  // The nudge's toast: its slide, the nudge waiting behind a tucked notch, and whether the pointer is on it.
  private var toast = ToastModel()
  private var waiting: (card: Card, overdue: Bool)?
  private var toastCard: (card: Card, overdue: Bool)?
  private var toastSeen = false
  private var toastTimer: Timer?
  private var onToast = false
  // What the glance is about, and whether the card out beside the island is that rather than a nudge.
  private var glanceAbout: GlanceAbout?
  private var glanceOut = false
  // The card out beside the island is the update's (Updater.swift).
  private var updateOut = false
  private var glanceTimer: Timer?
  // The cards seen at the last look, so a new one can ting; nil until the first look, so starting up is quiet.
  private var seen: Set<String>?

  var mode: IslandMode {
    get { IslandMode(rawValue: defaults.string(forKey: "kierIslandMode") ?? "") ?? (defaults.bool(forKey: "kierOrbHidden") ? .hidden : .always) }
    set { defaults.set(newValue.rawValue, forKey: "kierIslandMode") }
  }
  private var sound: Bool { defaults.object(forKey: "kierSound") as? Bool ?? true }
  private let panelSize = NSSize(width: 400, height: 580)
  // Nudges: at most one every half hour, in the daytime; overdue things come back after three hours, up to three times.
  private let gap: TimeInterval = 30 * 60
  private let again: TimeInterval = 3 * 3600

  init(store: Store) {
    self.store = store
    super.init()
    Lag.watch()
    islandPanel = NSPanel(contentRect: NSRect(origin: .zero, size: size), styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
    islandPanel.isFloatingPanel = true
    islandPanel.level = .floating
    islandPanel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
    islandPanel.backgroundColor = .clear
    islandPanel.isOpaque = false
    islandPanel.hasShadow = false
    islandPanel.ignoresMouseEvents = true
    islandPanel.acceptsMouseMovedEvents = true
    island = IslandHost(frame: NSRect(origin: .zero, size: size))
    island.onClick = { [weak self] in self?.toggleChat() }
    island.onDrag = { [weak self] in self?.drag($0) }
    island.menuFor = { [weak self] in self?.menu() ?? NSMenu() }
    island.onHover = { [weak self] inside in self?.hovered(inside) }
    islandPanel.contentView = island
    island.model.tucked = mode == .hover
    place()
    apply()
    NotificationCenter.default.addObserver(forName: .kierWindowShown, object: nil, queue: .main) { [weak self] _ in
      MainActor.assumeIsolated { if self?.chatPanel?.isVisible == true { self?.closeChat() } }
    }
    // The mode can also be changed on the Setup page.
    var last = mode
    NotificationCenter.default.addObserver(forName: UserDefaults.didChangeNotification, object: nil, queue: .main) { [weak self] _ in
      MainActor.assumeIsolated {
        guard let self, self.mode != last else { return }
        last = self.mode
        self.apply()
      }
    }
    shortcuts()
    NotificationCenter.default.addObserver(forName: Shortcut.changed, object: nil, queue: .main) { [weak self] _ in MainActor.assumeIsolated { self?.shortcuts() } }
    NotificationCenter.default.addObserver(forName: Shortcut.recording, object: nil, queue: .main) { [weak self] note in
      let recording = note.object as? Bool == true
      MainActor.assumeIsolated {
        if recording { self?.hotKey = nil; self?.findKey = nil } else { self?.shortcuts() }
      }
    }
    Timer.scheduledTimer(withTimeInterval: 20, repeats: true) { [weak self] _ in MainActor.assumeIsolated { self?.check() } }
    Timer.scheduledTimer(withTimeInterval: 8, repeats: false) { [weak self] _ in MainActor.assumeIsolated { self?.check() } }
    observeWorking()
  }

  // Follow the same request states as the window's thinking mark, without polling or doing work on the draw thread.
  private func observeWorking() {
    withObservationTracking {
      let asking = !store.asking.isEmpty
      let reading = find.reading
      island.model.working = asking || reading
    } onChange: { [weak self] in
      Task { @MainActor [weak self] in self?.observeWorking() }
    }
  }

  var visible: Bool { islandPanel.isVisible }

  // The menu bar's Show/Hide: hidden, or back to how it was shown before.
  func toggleOrb() {
    if mode == .hidden { mode = IslandMode(rawValue: defaults.string(forKey: "kierIslandShown") ?? "") ?? .always }
    else { defaults.set(mode.rawValue, forKey: "kierIslandShown"); mode = .hidden }
    apply()
  }

  private func apply() {
    tuckTimer?.invalidate()
    switch mode {
    case .hidden:
      islandPanel.orderOut(nil); closeChat(); bubble?.orderOut(nil)
      return
    case .always: setTucked(false)
    case .hover: setTucked(!island.model.hover && chatPanel?.isVisible != true)
    }
    islandPanel.orderFrontRegardless()
  }

  // In hover mode: out of the notch while the pointer is on it, back in a moment after it leaves.
  private func hovered(_ inside: Bool) {
    glanceTimer?.invalidate()
    if inside {
      // A moment on the island, not just passing over it, slides out what the glance is about.
      glanceTimer = Timer.scheduledTimer(withTimeInterval: mode == .hover ? 0.45 : 0.35, repeats: false) { [weak self] _ in
        MainActor.assumeIsolated { if self?.island.model.hover == true { self?.showGlance() } }
      }
    } else if mode != .hover, glanceOut {
      toastTimer?.invalidate()
      toastTimer = Timer.scheduledTimer(withTimeInterval: 1, repeats: false) { [weak self] _ in
        MainActor.assumeIsolated { if self?.onToast == false, self?.island.model.hover == false { self?.hideToast() } }
      }
    }
    guard mode == .hover else { return }
    tuckTimer?.invalidate()
    if inside {
      if bubble?.isVisible == true { toastSeen = true }
      setTucked(false)
      // The nudge that was waiting behind the notch slides out once the island is open.
      if let w = waiting {
        Timer.scheduledTimer(withTimeInterval: 0.2, repeats: false) { [weak self] _ in
          MainActor.assumeIsolated { if self?.island.model.hover == true { self?.showToast(w.card, overdue: w.overdue, linger: nil) } }
        }
      }
    } else { tuckSoon(after: 1.2) }
  }

  private func tuckSoon(after seconds: TimeInterval) {
    tuckTimer?.invalidate()
    tuckTimer = Timer.scheduledTimer(withTimeInterval: seconds, repeats: false) { [weak self] _ in
      MainActor.assumeIsolated {
        guard let self, self.mode == .hover, !self.island.model.hover, !self.onToast, self.chatPanel?.isVisible != true else { return }
        // A toast you didn't answer goes back behind the notch, which breathes until you hover it.
        if let c = self.toastCard, !self.toastSeen, self.bubble?.isVisible == true { self.waiting = c; withAnimation(islandSpring) { self.island.model.nudging = true } }
        self.hideToast()
        self.setTucked(true)
      }
    }
  }

  private func setTucked(_ tucked: Bool) {
    guard island.model.tucked != tucked else { return }
    // Keep the island visible while an update is downloading or installing so its attached card has an anchor.
    if tucked, updater?.busy == true { return }
    withAnimation(islandSpring) { island.model.tucked = tucked }
    reshaped()
  }

  // Something new came in: a ting, the rim runs wild, a tucked island pops out for a few seconds, and its toast comes
  // with it, straight away; the reminder schedule's half hour gap is for reminders, not for news.
  private func arrived(_ card: Card) {
    island.model.burst = Date()
    let hour = Calendar.current.component(.hour, from: Date())
    if sound, hour >= 8, hour < 22, let ting = NSSound(named: "Glass") { ting.volume = 0.4; ting.play() }
    guard chatPanel?.isVisible != true else { return }
    remember(card)
    if mode == .hover { setTucked(false); showToast(card, overdue: false, linger: nil); tuckSoon(after: 5) }
    else { showToast(card, overdue: false, linger: 25) }
  }

  // MARK: Where the island sits

  private var screen: NSRect { (islandPanel.screen ?? NSScreen.main)?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900) }

  // Its middle is what's remembered, so growing out of the notch and back never moves it.
  private func place() {
    let s = screen
    let mid = defaults.double(forKey: "kierIslandMid")
    let old = defaults.double(forKey: "kierIslandY")
    let center = mid > 0 ? mid : old > 0 ? old + 52 : s.minY + s.height * 0.3
    let y = min(max(center - size.height / 2, s.minY + 4), s.maxY - size.height - 4)
    islandPanel.setFrame(NSRect(x: s.maxX - size.width, y: y, width: size.width, height: size.height), display: true)
    island.track()
  }

  // The island grew or shrank inside its window: hovering and clicking follow its new outline.
  private func reshaped() {
    island.syncPointer()
    island.track()
  }

  // Up and down the edge; the panel and the nudge go with it.
  private func drag(_ dy: CGFloat) {
    var f = islandPanel.frame
    f.origin.y = min(max(f.origin.y + dy, screen.minY + 4), screen.maxY - size.height - 4)
    islandPanel.setFrame(f, display: true)
    defaults.set(f.midY, forKey: "kierIslandMid")
    island.track()
    if let p = chatPanel, p.isVisible { beside(p, size: p.frame.size) }
    if let b = bubble, b.isVisible { beside(b, size: b.frame.size) }
  }

  private func menu() -> NSMenu {
    let m = NSMenu()
    func add(_ title: String, _ run: @escaping () -> Void) {
      let item = NSMenuItem(title: title, action: #selector(Companion.fire(_:)), keyEquivalent: "")
      item.target = self
      item.representedObject = run
      m.addItem(item)
    }
    for option in IslandMode.allCases {
      add(option.title) { [weak self] in self?.mode = option; self?.apply() }
      m.items.last?.state = option == mode ? .on : .off
    }
    add("Ting when something new comes in") { [weak self] in self?.defaults.set(!(self?.sound ?? true), forKey: "kierSound") }
    m.items.last?.state = sound ? .on : .off
    m.addItem(.separator())
    add("Open Kier AI") { viewer.show("/") }
    add("What's New") { [weak self] in self?.openNotes() }
    if let u = updater { add(u.pending.map { "Update to Kier AI \($0)" } ?? "Check for Updates…") { u.checkNow() } }
    m.addItem(.separator())
    add("Quit Kier AI") { viewer.quit() }
    return m
  }

  @objc private func fire(_ item: NSMenuItem) { (item.representedObject as? () -> Void)?() }

  // MARK: The panel

  // The search bar: in the upper middle of the screen you're on, gone again on Escape or a click anywhere else.
  // The shortcuts as Settings has them; the old ones let go first, so changing one never holds both.
  private func shortcuts() {
    hotKey = nil
    findKey = nil
    hotKey = HotKey(Shortcut.saved("open", or: .open)) { [weak self] in MainActor.assumeIsolated { self?.toggleChat() } }
    findKey = HotKey(Shortcut.saved("find", or: .find)) { [weak self] in MainActor.assumeIsolated { self?.toggleFind() } }
  }

  func toggleFind() {
    if let p = findPanel, p.isVisible { closeFind(); return }
    if findPanel == nil {
      let view = FindView(model: find, open: { [weak self] r in self?.openFound(r) }, ask: { [weak self] q in self?.askFound(q) },
                          close: { [weak self] in self?.closeFind() })
      let host = NSHostingView(rootView: view.environment(\.openURL, LinkPolicy.action))
      let p = KeyPanel(contentRect: NSRect(origin: .zero, size: FindView.size), styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
      p.isFloatingPanel = true
      p.level = .floating
      p.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
      p.backgroundColor = .clear
      p.isOpaque = false
      // The bar draws its own shadow (FindView); the window's would trace an old outline.
      p.hasShadow = false
      p.appearance = NSAppearance(named: .darkAqua)
      p.contentView = host
      findPanel = p
    }
    find.reset()
    placeFind()
    findPanel?.makeKeyAndOrderFront(nil)
    find.shown += 1
    findResign = NotificationCenter.default.addObserver(forName: NSWindow.didResignKeyNotification, object: findPanel, queue: .main) { [weak self] _ in
      MainActor.assumeIsolated { self?.closeFind() }
    }
    Task { await find.warm() }
  }

  private func closeFind() {
    if let o = findResign { NotificationCenter.default.removeObserver(o); findResign = nil }
    findPanel?.orderOut(nil)
  }

  // In the upper middle of the screen the pointer is on. The window is tall and clear and never resizes; the bar sits
  // at its top and grows down inside it.
  private func placeFind() {
    guard let p = findPanel, let screen = NSScreen.screens.first(where: { $0.frame.contains(NSEvent.mouseLocation) }) ?? NSScreen.main else { return }
    let area = screen.visibleFrame
    let size = FindView.size
    let top = area.maxY - area.height * 0.2 + FindView.margin
    p.setFrame(NSRect(x: area.midX - size.width / 2, y: top - size.height, width: size.width, height: size.height), display: true)
  }

  // Where each result lives: a card or an event in Kier's panel, a session in the Claude app, a file in Finder, a page
  // or a message in its app.
  private func openFound(_ r: FindResult) {
    closeFind()
    if let id = r.open.card { store.show = id; if chatPanel?.isVisible != true { toggleChat() } }
    else if let id = r.open.event { store.showEvent = id; if chatPanel?.isVisible != true { toggleChat() } }
    else if let s = r.open.file, let url = URL(string: s) { NSWorkspace.shared.activateFileViewerSelecting([url]) }
    else if let s = r.open.url, let url = URL(string: s) { LinkPolicy.open(url) }
    else if let id = r.open.app, let app = NSWorkspace.shared.urlForApplication(withBundleIdentifier: id) {
      NSWorkspace.shared.openApplication(at: app, configuration: NSWorkspace.OpenConfiguration())
    }
  }

  // ⌘Return: the request as a question to Kier, answered in a new chat in the panel.
  private func askFound(_ q: String) {
    closeFind()
    let key = store.newChatKey()
    store.ask(q, agent: "kier", key: key)
    store.showChat = key
    if chatPanel?.isVisible != true { toggleChat() }
  }

  func toggleChat() {
    // A second click right after opening is someone who wasn't sure the first one landed, not someone closing it.
    if let p = chatPanel, p.isVisible {
      if CACurrentMediaTime() - openedAt > 0.5 { closeChat() }
      return
    }
    openedAt = CACurrentMediaTime()
    // Crossfade the hover card into the panel, growing from slightly smaller around the card’s centre.
    let card = bubble?.isVisible == true ? bubble?.frame : nil
    hideToast(intoPanel: card != nil)
    if mode == .hover { setTucked(false) }
    if chatPanel == nil {
      let host = NSHostingView(rootView: CompanionView(close: { [weak self] in self?.closeChat() }).environment(store).environment(\.openURL, LinkPolicy.action))
      let p = KeyPanel(contentRect: NSRect(origin: .zero, size: panelSize), styleMask: [.borderless, .nonactivatingPanel, .resizable],
                       backing: .buffered, defer: false)
      p.isFloatingPanel = true
      p.level = .floating
      p.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
      p.backgroundColor = .clear
      p.isOpaque = false
      p.hasShadow = true
      p.appearance = NSAppearance(named: .darkAqua)
      p.contentView = host
      chatPanel = p
    }
    Task { await store.refresh() }
    beside(chatPanel!, size: panelSize)
    if let card, let p = chatPanel { grow(p, from: card) }
    chatPanel?.makeKeyAndOrderFront(nil)
    island.model.panel = true
    let shown = openedAt
    DispatchQueue.main.async {
      let ms = (CACurrentMediaTime() - shown) * 1000
      if ms > 60 { Lag.note("The panel took \(Int(ms)) ms to open") }
    }
    // A click anywhere else, in another app or in Kier's own window, or Escape, puts the panel away.
    let outside: (NSEvent) -> Void = { [weak self] _ in MainActor.assumeIsolated { self?.closeChat() } }
    let inside: (NSEvent) -> NSEvent? = { [weak self] event in MainActor.assumeIsolated { self?.handle(event) ?? event } }
    var added: [Any] = []
    if let m = NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown], handler: outside) { added.append(m) }
    if let m = NSEvent.addLocalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown, .keyDown], handler: inside) { added.append(m) }
    monitors = added
  }

  // The panel's first fifth of a second: from 94% around the card's middle to full size, and from clear to solid. A
  // layer transform and the window's alpha, so nothing is laid out again while it runs.
  private func grow(_ p: NSPanel, from card: NSRect) {
    guard let view = p.contentView else { return }
    view.wantsLayer = true
    guard let layer = view.layer else { return }
    let f = p.frame
    let at = CGPoint(x: min(max(card.midX - f.minX, 0), f.width), y: min(max(card.midY - f.minY, 0), f.height))
    var from = CATransform3DMakeTranslation(at.x, at.y, 0)
    from = CATransform3DScale(from, 0.94, 0.94, 1)
    from = CATransform3DTranslate(from, -at.x, -at.y, 0)
    let scale = CABasicAnimation(keyPath: "transform")
    scale.fromValue = NSValue(caTransform3D: from)
    scale.toValue = NSValue(caTransform3D: CATransform3DIdentity)
    scale.duration = 0.24
    scale.timingFunction = CAMediaTimingFunction(controlPoints: 0.2, 0.9, 0.3, 1)
    layer.add(scale, forKey: "grow")
    p.alphaValue = 0
    NSAnimationContext.runAnimationGroup { ctx in
      ctx.duration = 0.18
      ctx.timingFunction = CAMediaTimingFunction(name: .easeOut)
      p.animator().alphaValue = 1
    }
  }

  private func handle(_ event: NSEvent) -> NSEvent? {
    if event.type == .leftMouseDown, event.window === chatPanel { Lag.input("A click in the panel", event) }
    if event.type == .keyDown {
      if event.keyCode == UInt16(kVK_Escape) { closeChat(); return nil }
      return event
    }
    if event.window !== chatPanel && event.window !== islandPanel { closeChat() }
    return event
  }

  private func closeChat() {
    monitors.forEach(NSEvent.removeMonitor)
    monitors = []
    chatPanel?.orderOut(nil)
    island.model.panel = false
    if mode == .hover { tuckSoon(after: 1.2) }
  }

  // To the left of the island, centred on it as far as the screen allows.
  // Its window is wider than a tucked island, so this measures from the island as it's drawn, not from the window.
  private func beside(_ panel: NSPanel, size: NSSize) {
    let s = screen
    let o = islandPanel.frame
    let left = o.maxX - island.model.size.width
    let y = min(max(o.midY - size.height / 2, s.minY + 8), s.maxY - size.height - 8)
    panel.setFrame(NSRect(x: left - size.width - 8, y: y, width: size.width, height: size.height), display: true)
  }

  // MARK: Nudges

  private var nudges: [String: [Double]] {
    get { (defaults.dictionary(forKey: "kierNudges") as? [String: [Double]]) ?? [:] }
    set { defaults.set(newValue, forKey: "kierNudges") }
  }

  // Overdue first, then due today, then waiting; each once, and an overdue one again after a few hours if it's still there.
  private func due(_ b: Brief) -> Card? {
    let now = Date().timeIntervalSince1970
    func ok(_ c: Card, repeatable: Bool) -> Bool {
      guard let n = nudges[c.id] else { return true }
      return repeatable && n[0] < 3 && now - n[1] > again
    }
    return b.forgotten.first { ok($0, repeatable: true) } ?? b.today.tasks.first { ok($0, repeatable: true) } ?? b.open.first { ok($0, repeatable: false) }
  }

  private func check() {
    Task {
      await store.loadBrief()
      // Calendar and Reminders on the phone, kept in step every few minutes (PhoneSync).
      PhoneSync.shared.tick()
      guard let b = store.brief else { return }
      let cards = b.panel
      // Work a session left behind hasn't just arrived: it waits for a quiet nudge instead of a ting.
      if let seen, mode != .hidden, let fresh = cards.filter({ !seen.contains($0.id) && $0.card != "stalled" }).max(by: { $0.ts < $1.ts }) { arrived(fresh) }
      // A card that left the list because Kier saw it done (not one you ticked yourself) gets its own moment.
      else if let seen, mode != .hidden, chatPanel?.isVisible != true,
              let gone = (b.done ?? []).filter({ $0.state == "handled" && seen.contains($0.id) && !cards.map(\.id).contains($0.id) && $0.reason?.hasPrefix("Merged into") != true })
                .max(by: { $0.ts < $1.ts }) { closed(gone) }
      // Someone you owe something wrote again: what you owe them comes out, once per message.
      else if seen != nil, mode != .hidden, chatPanel?.isVisible != true, let o = (b.owed ?? []).first(where: { !owedSeen($0) }) { remindOwed(o) }
      // The morning and evening brief, once each.
      else if seen != nil, mode != .hidden, chatPanel?.isVisible != true, let m = b.moment, defaults.integer(forKey: "kierBriefSeen") != m.at { remindBrief(m) }
      seen = Set(cards.map(\.id))
      guard islandPanel.isVisible else { return }
      offerNotes()
      offerOwnModel()
      if b.glance != island.model.glance { withAnimation(islandSpring) { island.model.glance = b.glance }; reshaped() }
      glanceAbout = b.glanceAbout
      let next = due(b)
      island.model.attention = next != nil ? 1 : 0
      let hour = Calendar.current.component(.hour, from: Date())
      guard let next, hour >= 9, hour < 21, Date().timeIntervalSince1970 - defaults.double(forKey: "kierLastNudge") > gap,
            chatPanel?.isVisible != true else { return }
      nudge(next, overdue: b.forgotten.contains { $0.id == next.id })
    }
  }

  // Offer the built-in runtime when it is missing. Download installs it in the background;
  // Later leaves installation available in Setup.
  private var lastOffer = 0.0
  func openNotes() {
    store.showNotes = true
    if chatPanel?.isVisible != true { toggleChat() }
  }

  // After an update, once: a card with what's new, which opens the notes in the panel. Tried again on the next check
  // while something else is out; on a fresh install it's only marked seen.
  private func offerNotes() {
    let version = Changelog.current
    guard !version.isEmpty, defaults.string(forKey: "kierNotesSeen") != version else { return }
    guard Changelog.updated, let release = Changelog.all.first(where: { $0.version == version }) else {
      defaults.set(version, forKey: "kierNotesSeen")
      return
    }
    guard mode != .hidden, bubble?.isVisible != true, chatPanel?.isVisible != true, updater?.pending == nil else { return }
    defaults.set(version, forKey: "kierNotesSeen")
    waiting = nil
    toastCard = nil
    toastSeen = true
    glanceOut = false
    let model = ToastModel()
    toast = model
    // Said as what it is: under a bare "Kier 0.4.1", the release title in the nudge's place read as a task.
    let host = FirstClickHost(rootView: NudgeView(model: model, line: "What's new in Kier AI \(version)", text: release.title, actions: [
      .init(symbol: "doc.text", help: "What's new") { [weak self] in self?.hideToast(); self?.openNotes() },
      .init(symbol: "xmark", help: "Later, from the island's menu") { [weak self] in self?.hideToast() },
    ], open: { [weak self] in self?.hideToast(); self?.openNotes() }, hovered: { [weak self] inside in self?.toastHovered(inside) }))
    if mode == .hover { setTucked(false); tuckSoon(after: 30) }
    present(host, linger: 30)
  }

  private func offerOwnModel() {
    let now = Date().timeIntervalSince1970
    let hour = Calendar.current.component(.hour, from: Date())
    guard !defaults.bool(forKey: "kierModelOffered"), mode != .hidden, hour >= 9, hour < 21, now - lastOffer > 600,
          bubble?.isVisible != true, chatPanel?.isVisible != true, updater?.pending == nil else { return }
    lastOffer = now
    Task {
      await store.loadSetup()
      guard let action = store.steps.first(where: { $0.id == "model" })?.action, action.id == "mlx",
            bubble?.isVisible != true, chatPanel?.isVisible != true else { return }
      defaults.set(true, forKey: "kierModelOffered")
      waiting = nil
      toastCard = nil
      toastSeen = true
      glanceOut = false
      let model = ToastModel()
      toast = model
      let host = FirstClickHost(rootView: NudgeView(model: model, line: "Kier's own AI", text: "Run it inside Kier: half the memory, no Ollama. A 6 GB download.", actions: [
        .init(symbol: "arrow.down", help: "Download") { [weak self] in self?.store.act(action); self?.hideToast() },
        .init(symbol: "xmark", help: "Later, from Setup") { [weak self] in self?.hideToast() },
      ], open: { [weak self] in self?.hideToast(); viewer.show("/setup") }, hovered: { [weak self] inside in self?.toastHovered(inside) }))
      if mode == .hover { setTucked(false); tuckSoon(after: 30) }
      present(host, linger: 30)
    }
  }

  // Each card is shown once, overdue ones again after a few hours; and nothing else for half an hour after.
  private func remember(_ card: Card) {
    let now = Date().timeIntervalSince1970
    var n = nudges
    n[card.id] = [(n[card.id]?[0] ?? 0) + 1, now]
    nudges = n
    defaults.set(now, forKey: "kierLastNudge")
  }

  private func nudge(_ card: Card, overdue: Bool) {
    remember(card)
    // Tucked away, it doesn't throw a toast at you: the notch breathes, and the toast comes out when you hover it.
    if mode == .hover && island.model.tucked {
      waiting = (card, overdue)
      withAnimation(islandSpring) { island.model.nudging = true }
      reshaped()
      return
    }
    showToast(card, overdue: overdue, linger: 25)
  }

  // The hover card names the event or task behind the compact glance. Suppress it while another
  // nudge or done card is visible or waiting behind the notch.
  private func showGlance() {
    guard waiting == nil, bubble?.isVisible != true, chatPanel?.isVisible != true else { return }
    if updater?.pending != nil { showUpdate(); return }
    if let day = store.brief?.day, !day.isEmpty { showToday(day); return }
    guard island.model.glance != nil, let g = glanceAbout, !g.text.isEmpty else { return }
    toastCard = nil
    toastSeen = true
    let model = ToastModel()
    toast = model
    let host = FirstClickHost(rootView: NudgeView(model: model, line: g.line, text: g.text, actions: [], open: { [weak self] in
      self?.hideToast(); self?.toggleChat()
    }, hovered: { [weak self] inside in self?.toastHovered(inside) }))
    present(host, linger: nil)
    glanceOut = true
  }

  // Hovering on a day with something on it: the Today card instead of the one glance, and it stays while you're on it.
  // A line opens its card in the panel; an event opens the panel.
  private func showToday(_ day: [DayLine]) {
    toastCard = nil
    toastSeen = true
    let model = ToastModel()
    toast = model
    let host = FirstClickHost(rootView: TodayView(model: model, lines: day, open: { [weak self] line in
      self?.hideToast()
      if let card = line.card { self?.store.show = card } else { self?.store.showEvent = line.id }
      self?.toggleChat()
    }, hovered: { [weak self] inside in self?.toastHovered(inside) }))
    present(host, linger: nil)
    glanceOut = true
  }

  // For measuring the island's open and close: as if the pointer came onto it, or left.
  func pretendHover(_ inside: Bool) {
    island.model.hover = inside
    hovered(inside)
  }

  // For trying the nudge out: the most pressing waiting card, now, whatever the hour.
  func nudgeNow() {
    guard let b = store.brief, let card = b.forgotten.first ?? b.today.tasks.first ?? b.open.first else { return }
    nudge(card, overdue: b.forgotten.contains { $0.id == card.id })
  }

  // The toast fades in beside the island and sits against it; hovering it keeps it, and it fades away after
  // `linger` seconds, or as soon as you leave it when it came out of the notch.
  private func owedSeen(_ o: Owed) -> Bool { (defaults.stringArray(forKey: "kierOwedSeen") ?? []).contains("\(o.card.id)@\(o.at)") }

  // Show the relevant card with Done and Later when a reminder matters. Scheduled briefs use
  // the island too; osascript notifications would open Script Editor instead of Kier.
  private func remindBrief(_ m: BriefMoment) {
    defaults.set(m.at, forKey: "kierBriefSeen")
    island.model.burst = Date()
    waiting = nil
    toastCard = nil
    toastSeen = island.model.hover
    glanceOut = false
    let model = ToastModel()
    toast = model
    let host = FirstClickHost(rootView: NudgeView(model: model, line: m.line, text: m.text, actions: [
      .init(symbol: "xmark", help: "Dismiss") { [weak self] in self?.hideToast() },
    ], open: { [weak self] in self?.hideToast(); self?.toggleChat() }, hovered: { [weak self] inside in self?.toastHovered(inside) }))
    if mode == .hover { setTucked(false); tuckSoon(after: 8) }
    present(host, linger: 25)
  }

  private func remindOwed(_ o: Owed) {
    defaults.set(Array(((defaults.stringArray(forKey: "kierOwedSeen") ?? []) + ["\(o.card.id)@\(o.at)"]).suffix(200)), forKey: "kierOwedSeen")
    island.model.burst = Date()
    let line = "\(o.who) just wrote. You still owe this"
    if mode == .hover { setTucked(false); showToast(o.card, overdue: false, linger: nil, line: line); tuckSoon(after: 8) }
    else { showToast(o.card, overdue: false, linger: 25, line: line) }
  }

  private func showToast(_ card: Card, overdue: Bool, linger: TimeInterval?, line custom: String? = nil) {
    waiting = nil
    glanceOut = false
    toastCard = (card, overdue)
    toastSeen = island.model.hover
    if island.model.nudging { withAnimation(islandSpring) { island.model.nudging = false }; reshaped() }
    let model = ToastModel()
    toast = model
    let line: String = custom ?? (overdue ? "Overdue, from \(card.who)" : card.who)
    let host = FirstClickHost(rootView: NudgeView(model: model, line: line, text: card.headline, actions: [
      .init(symbol: "checkmark", help: "Mark done") { [weak self] in self?.toastCard = nil; self?.store.mark(card, "done"); self?.hideToast() },
      .init(symbol: "clock", help: "Later") { [weak self] in self?.toastCard = nil; self?.store.mark(card, "snoozed"); self?.hideToast() },
    ], open: { [weak self] in
      // Open the referenced card, even when the panel is already visible; this action is never a toggle.
      self?.toastCard = nil; self?.hideToast(); self?.store.show = card.id
      if self?.chatPanel?.isVisible != true { self?.toggleChat() }
    }, hovered: { [weak self] inside in self?.toastHovered(inside) }))
    present(host, linger: linger)
  }

  // Kier ticked something off on its own: its chime, a green ripple from the orb, and a toast where the check draws
  // itself and the task is struck through, with how Kier knows and a way to undo it.
  private func closed(_ card: Card) {
    let hour = Calendar.current.component(.hour, from: Date())
    if sound, hour >= 8, hour < 22 { Chime.done() }
    island.model.celebrated = Date()
    waiting = nil
    glanceOut = false
    toastCard = nil
    toastSeen = true
    let model = ToastModel()
    toast = model
    let host = FirstClickHost(rootView: DoneView(model: model, headline: card.headline, how: howDone(card.reason), undo: { [weak self] in
      self?.store.mark(card, "open"); self?.hideToast()
    }, hovered: { [weak self] inside in self?.toastHovered(inside) }))
    if mode == .hover { setTucked(false); tuckSoon(after: 5) }
    present(host, linger: mode == .hover ? nil : 5)
  }

  // A newer Kier (Updater.swift), out beside the island like a nudge. Unanswered, it slides back after half a minute and
  // comes out again on hover; once Update is clicked it stays until Kier restarts.
  func showUpdate() {
    guard let u = updater, chatPanel?.isVisible != true || u.offer.phase != .available else { return }
    waiting = nil
    toastCard = nil
    toastSeen = true
    glanceOut = false
    let model = ToastModel()
    toast = model
    let host = FirstClickHost(rootView: UpdateView(model: model, offer: u.offer, install: { u.install() }, later: { u.later() },
      hovered: { [weak self] inside in self?.toastHovered(inside) }))
    if mode == .hover { setTucked(false); tuckSoon(after: 30) }
    present(host, linger: u.offer.phase == .available ? 30 : u.offer.phase.working ? nil : 6)
  }

  func hideUpdate() {
    updateOut = false
    hideToast()
  }

  private func present<V: View>(_ host: NSHostingView<V>, linger: TimeInterval?) {
    // Keep downloading or installing update cards above hover cards. Never open a card over the panel.
    if updateOut, updater?.busy == true, V.self != UpdateView.self { return }
    if chatPanel?.isVisible == true, V.self != UpdateView.self { return }
    updateOut = V.self == UpdateView.self
    let model = toast
    // As tall as its one or two lines need, measured once; then it's fixed, so its slide doesn't re-lay the window out.
    let size = NSSize(width: ceil(host.fittingSize.width), height: ceil(host.fittingSize.height))
    host.sizingOptions = []
    let p = bubble ?? NSPanel(contentRect: NSRect(origin: .zero, size: size), styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
    p.isFloatingPanel = true
    p.level = .floating
    p.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
    p.backgroundColor = .clear
    p.isOpaque = false
    p.hasShadow = true
    p.appearance = NSAppearance(named: .darkAqua)
    p.contentView = host
    bubble = p
    beside(p, size: size)
    p.orderFrontRegardless()
    DispatchQueue.main.async { withAnimation(.spring(response: 0.38, dampingFraction: 0.86)) { model.shown = true } }
    toastTimer?.invalidate()
    if let linger { toastTimer = Timer.scheduledTimer(withTimeInterval: linger, repeats: false) { [weak self] _ in MainActor.assumeIsolated { self?.hideToast() } } }
  }

  private func hideToast(intoPanel: Bool = false) {
    if updateOut, updater?.busy == true { return }
    toastTimer?.invalidate()
    onToast = false
    glanceOut = false
    guard let p = bubble, p.isVisible else { return }
    let model = toast
    if intoPanel { withAnimation(.easeOut(duration: 0.2)) { model.absorbed = true; model.shown = false } }
    else { withAnimation(.easeIn(duration: 0.18)) { model.shown = false } }
    Timer.scheduledTimer(withTimeInterval: 0.22, repeats: false) { [weak self] _ in
      MainActor.assumeIsolated { if self?.toast === model, !model.shown { p.orderOut(nil) } }
    }
  }

  private func toastHovered(_ inside: Bool) {
    onToast = inside
    if inside { toastSeen = true }
    toastTimer?.invalidate()
    tuckTimer?.invalidate()
    guard !inside else { return }
    if mode == .hover { tuckSoon(after: 1.2) }
    else { toastTimer = Timer.scheduledTimer(withTimeInterval: 4, repeats: false) { [weak self] _ in MainActor.assumeIsolated { self?.hideToast() } } }
  }
}

// These panels never become key, so their views must explicitly accept first clicks.
// The island uses the same behavior in IslandHost.
final class FirstClickHost: NSHostingView<AnyView> {
  convenience init<Content: View>(rootView: Content) { self.init(rootView: AnyView(rootView)) }
  required init(rootView: AnyView) {
    super.init(rootView: AnyView(rootView.environment(\.openURL, LinkPolicy.action)))
  }
  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError("Unavailable") }
  override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
}

// The nudge: one slim line of black glass beside the island. Who it's from and what, a tick and a clock on the right,
// and a click anywhere else opens it.
final class ToastModel: ObservableObject {
  @Published var shown = false
  // Going into the panel rather than back behind the island (see toggleChat).
  @Published var absorbed = false
}

// Cards fade and scale toward the island. Transitioning into the panel only fades them.
// Avoid horizontal movement, which would clip against the card-sized window.
struct CardMotion: ViewModifier {
  @ObservedObject var model: ToastModel

  func body(content: Content) -> some View {
    content
      .scaleEffect(model.shown || model.absorbed ? 1 : 0.96, anchor: .trailing)
      .opacity(model.shown ? 1 : 0)
  }
}

// Format completion evidence as the speaker and their quoted message, without the internal evidence prefix.
func howDone(_ reason: String?) -> String? {
  guard var r = reason?.trimmingCharacters(in: .whitespaces), !r.isEmpty else { return nil }
  if r.hasPrefix("you said so: ") { return "You said \(r.dropFirst(13))" }
  if r == "you replied in this chat" { return "You replied in the chat" }
  r = r.replacingOccurrences(of: "Looks done: ", with: "")
  if let stamp = r.range(of: #"^[^:]*\d{1,2}:\d{2}: "#, options: .regularExpression) { r = String(r[stamp.upperBound...]) }
  if let colon = r.range(of: ": "), r.distance(from: r.startIndex, to: colon.lowerBound) < 40 {
    return "\(r[..<colon.lowerBound]): “\(r[colon.upperBound...])”"
  }
  return r
}

// The toast for something done: a green circle blooms, the tick draws itself, the task is struck through, and under
// it how Kier knows. Only Undo, since there's nothing else to do; it slides away on its own.
struct DoneView: View {
  @ObservedObject var model: ToastModel
  let headline: String
  let how: String?
  let undo: () -> Void
  let hovered: (Bool) -> Void
  @State private var bloom = false
  @State private var tick = false
  @State private var struck = false

  var body: some View {
    HStack(spacing: 12) {
      ZStack {
        Circle().fill(Color(red: 0.2, green: 0.78, blue: 0.45)).scaleEffect(bloom ? 1 : 0.3).opacity(bloom ? 1 : 0)
        Circle().strokeBorder(Color(red: 0.45, green: 0.95, blue: 0.62).opacity(0.9), lineWidth: 1.2)
        Tick().trim(from: 0, to: tick ? 1 : 0)
          .stroke(Color.white, style: StrokeStyle(lineWidth: 2.2, lineCap: .round, lineJoin: .round))
          .frame(width: 11, height: 9)
      }
      .frame(width: 26, height: 26)
      VStack(alignment: .leading, spacing: 2) {
        Text("Done").font(.system(size: 11, weight: .medium)).foregroundStyle(Color(red: 0.45, green: 0.95, blue: 0.62))
        Text(headline).font(.system(size: 13, weight: .medium)).lineLimit(1)
          .foregroundStyle(struck ? Color.secondary : Color.primary)
          .overlay(alignment: .leading) {
            GeometryReader { g in
              Rectangle().fill(Color.secondary).frame(width: struck ? g.size.width : 0, height: 1.2).offset(y: g.size.height / 2)
            }
          }
        if let how { Text(how).font(.system(size: 11)).foregroundStyle(.secondary).lineLimit(1) }
      }
      Spacer(minLength: 2)
      RoundButton(symbol: "arrow.uturn.backward", help: "Not done, put it back", action: undo)
    }
    .padding(.leading, 12).padding(.trailing, 10).padding(.vertical, 10)
    .frame(width: 320, alignment: .leading)
    .onHover(perform: hovered)
    .blackGlass(radius: 16)
    .modifier(CardMotion(model: model))
    .onAppear {
      withAnimation(.spring(response: 0.34, dampingFraction: 0.58).delay(0.12)) { bloom = true }
      withAnimation(.easeOut(duration: 0.28).delay(0.3)) { tick = true }
      withAnimation(.easeInOut(duration: 0.5).delay(0.55)) { struck = true }
    }
  }
}

// A tick mark, drawn from its short arm to its long one.
struct Tick: Shape {
  func path(in r: CGRect) -> Path {
    var p = Path()
    p.move(to: CGPoint(x: r.minX, y: r.minY + r.height * 0.55))
    p.addLine(to: CGPoint(x: r.minX + r.width * 0.37, y: r.maxY))
    p.addLine(to: CGPoint(x: r.maxX, y: r.minY))
    return p
  }
}

struct NudgeView: View {
  struct Action { let symbol: String; let help: String; let run: () -> Void }
  @ObservedObject var model: ToastModel
  var badge: String? = nil
  let line: String
  let text: String
  let actions: [Action]
  let open: () -> Void
  let hovered: (Bool) -> Void

  var body: some View {
    HStack(spacing: 10) {
      if let badge { Image(systemName: badge).font(.system(size: 18)).foregroundStyle(.green) }
      VStack(alignment: .leading, spacing: 1) {
        Text(line).font(.system(size: 11, weight: .medium)).foregroundStyle(.secondary).lineLimit(1)
        Text(text).font(.system(size: 13, weight: .medium)).lineLimit(2).fixedSize(horizontal: false, vertical: true)
      }
      Spacer(minLength: 2)
      ForEach(actions.indices, id: \.self) { i in RoundButton(symbol: actions[i].symbol, help: actions[i].help, action: actions[i].run) }
    }
    .padding(.leading, 14).padding(.trailing, 10).padding(.vertical, 10)
    .frame(width: 280, alignment: .leading)
    .contentShape(Rectangle())
    .onTapGesture(perform: open)
    .onHover(perform: hovered)
    .blackGlass(radius: 16)
    .modifier(CardMotion(model: model))
  }
}

// The Today hover card shows today’s events and tomorrow’s relevant heads-ups.
// It appears quietly on hover and uses the same black glass as nudges.
struct TodayView: View {
  @ObservedObject var model: ToastModel
  let lines: [DayLine]
  let open: (DayLine) -> Void
  let hovered: (Bool) -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: 2) {
      ForEach(lines, id: \.self) { line in TodayRow(line: line) { open(line) } }
    }
    .padding(6)
    .frame(width: 330, alignment: .leading)
    .onHover(perform: hovered)
    .blackGlass(radius: 16)
    .modifier(CardMotion(model: model))
  }
}

struct TodayRow: View {
  let line: DayLine
  let open: () -> Void
  @State private var hover = false

  var body: some View {
    HStack(alignment: .firstTextBaseline, spacing: 10) {
      Text(line.when).font(.system(size: 11, weight: .medium)).foregroundStyle(.secondary).lineLimit(1)
        .frame(width: 88, alignment: .leading)
      VStack(alignment: .leading, spacing: 2) {
        Text(line.text).font(.system(size: 13, weight: .medium)).lineLimit(2).fixedSize(horizontal: false, vertical: true)
        if let detail = line.detail, !detail.isEmpty {
          Text(detail).font(.system(size: 11)).foregroundStyle(.secondary).lineLimit(2).fixedSize(horizontal: false, vertical: true)
        }
      }
      .frame(maxWidth: .infinity, alignment: .leading)
    }
    .padding(.horizontal, 10).padding(.vertical, 7)
    .background(RoundedRectangle(cornerRadius: 10).fill(hover ? Glass.hover : .clear))
    .contentShape(Rectangle())
    .onHover { hover = $0 }
    .onTapGesture(perform: open)
  }
}

// A small round button drawn as a hairline ring, lit on hover.
struct RoundButton: View {
  let symbol: String
  let help: String
  let action: () -> Void
  @State private var hover = false

  var body: some View {
    Button(action: action) {
      Image(systemName: symbol).font(.system(size: 11, weight: .semibold))
        .frame(width: 26, height: 26)
        .background(Circle().fill(hover ? Glass.hover : .clear))
        .overlay(Circle().strokeBorder(Glass.rim, lineWidth: 0.5))
    }
    .buttonStyle(.plain)
    .onHover { hover = $0 }
    .help(help)
  }
}

// MARK: The panel, laid out like a phone app: a list, a page per item with a way back, and a chat.

enum Screen: Equatable {
  case home
  case item(String)
  case event(String)
  case chat(String)
  case notes
}

// What changed in each version, newest first: app/changelog.json, the same file getkier.com/changelog and the update's
// description are made from.
struct Release: Codable, Identifiable {
  let version: String
  let date: String
  let title: String
  let notes: [String]
  var id: String { version }
}

enum Changelog {
  static let all: [Release] = {
    guard let url = Bundle.main.url(forResource: "changelog", withExtension: "json"), let data = try? Data(contentsOf: url) else { return [] }
    return (try? JSONDecoder().decode([Release].self, from: data)) ?? []
  }()
  static var current: String { Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "" }
  // Kier was on this Mac before this version: its vault is older than a few hours. A fresh install has nothing new to tell.
  static var updated: Bool {
    let vault = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/Kier/kier.db")
    guard let made = (try? FileManager.default.attributesOfItem(atPath: vault.path))?[.creationDate] as? Date else { return false }
    return Date().timeIntervalSince(made) > 6 * 3600
  }
}

struct CompanionView: View {
  @Environment(Store.self) var store
  let close: () -> Void
  @State private var screen: Screen = .home
  // Cards asked for by id that the lists don't hold, fetched once.
  @State private var fetched: [String: Card] = [:]
  @AppStorage("kierAgent") private var agent = "claude"
  @AppStorage("kierShowDone") private var showDone = false

  private var panel: [Card] {
    guard let b = store.brief else { return [] }
    return Array(b.panel.prefix(12))
  }
  // Still yours to do. What Kier thinks is already done or not needed goes under "Probably done" instead.
  private var waiting: [Card] { panel.filter { !$0.needsConfirmation } }
  private var probablyDone: [Card] { panel.filter(\.needsConfirmation) }

  // The ones the second opinion doubts: listed quietly under the rest, so nothing real goes missing.
  private var maybe: [Card] { Array((store.brief?.maybe ?? []).prefix(6)) }

  // What Kier ticked off on its own lately, so a toast you missed can be read again, and undone.
  private var doneByKier: [Card] { Array((store.brief?.done ?? []).prefix(5)) }
  // The calendar's side of the Today card: events and timed reminders still ahead today, tomorrow's worth knowing, the
  // next one after; each opens its page (they showed on the card but led nowhere).
  private var comingUp: [DayLine] { (store.brief?.day ?? []).filter { $0.card == nil && $0.id != nil } }
  // The next timed thing on the calendar, today or in the coming days.
  private var nextEvent: Event? {
    let now = Int(Date().timeIntervalSince1970)
    return store.brief?.today.events.first { $0.allDay != true && $0.ts > now } ?? store.brief?.soon.events.first
  }

  var body: some View {
    ZStack {
      switch screen {
      case .home: home.transition(.move(edge: .leading).combined(with: .opacity))
      case .item(let id):
        if let c = (waiting + maybe + doneByKier).first(where: { $0.id == id }) ?? fetched[id] { ItemPage(card: c, agent: $agent, back: { go(.home) }).transition(.move(edge: .trailing)) }
        // Fetch cards missing from the current lists by id, including distant dates and search results.
        else { Color.clear.task(id: id) { if let c = await store.card(id) { fetched[id] = c } else { go(.home) } } }
      case .event(let id): EventPage(id: id, agent: $agent, back: { go(.home) }).transition(.move(edge: .trailing))
      case .chat(let key): ChatPage(key: key, agent: $agent, back: { go(.home) }, new: { go(.chat(store.newChatKey())) }).transition(.move(edge: .trailing))
      case .notes: NotesPage(back: { go(.home) }).transition(.move(edge: .trailing))
      }
    }
    .frame(minWidth: 360, minHeight: 440)
    .task { await store.loadConversations() }
    // A line clicked on the Today card opens straight to its card.
    .onAppear {
      if let id = store.show { screen = .item(id); store.show = nil }
      else if let id = store.showEvent { screen = .event(id); store.showEvent = nil }
      else if store.showNotes { screen = .notes; store.showNotes = false }
      else if let key = store.showChat { screen = .chat(key); store.showChat = nil }
    }
    .onChange(of: store.show) { if let id = store.show { go(.item(id)); store.show = nil } }
    .onChange(of: store.showEvent) { if let id = store.showEvent { go(.event(id)); store.showEvent = nil } }
    .onChange(of: store.showNotes) { if store.showNotes { go(.notes); store.showNotes = false } }
    .onChange(of: store.showChat) { if let key = store.showChat { go(.chat(key)); store.showChat = nil } }
    // Hand-offs for the cards on the list are worked out ahead, so the menu is ready when an item opens.
    .task(id: waiting.map(\.id)) { store.warmHandoffs(waiting.map(\.id)) }
    .blackGlass(radius: 20)
    .clipShape(RoundedRectangle(cornerRadius: 20, style: .continuous))
  }

  private func go(_ s: Screen) { withAnimation(.easeOut(duration: 0.18)) { screen = s } }

  private var home: some View {
    VStack(spacing: 0) {
      HStack(spacing: 10) {
        KierMark().frame(width: 28, height: 28)
        VStack(alignment: .leading, spacing: 0) {
          Text("Kier").font(.headline)
          Text(waiting.isEmpty ? "Nothing waiting" : "\(waiting.count) waiting on you").font(.caption).foregroundStyle(.secondary)
        }
        Spacer()
        Group {
          Menu {
            Button { store.checkNow() } label: { Label(store.checking ? "Checking…" : "Refresh", systemImage: "arrow.clockwise") }
              .disabled(store.checking)
            Button { viewer.show("/setup") } label: { Label("Settings", systemImage: "gearshape") }
            Button { viewer.show("/") } label: { Label("Open Kier AI", systemImage: "macwindow") }
            Divider()
            Button { viewer.quit() } label: { Label("Quit Kier AI", systemImage: "power") }
          } label: { Image(systemName: "ellipsis").frame(width: 24, height: 24).contentShape(Rectangle()) }
          .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize()
          .accessibilityLabel("More options").help("More options")
          Button(action: close) { Image(systemName: "xmark").frame(width: 24, height: 24).contentShape(Rectangle()) }
            .accessibilityLabel("Close panel").help("Close panel, return to notch (Esc)")
        }
        .buttonStyle(.borderless)
        .focusable(false)
      }
      .padding(.horizontal, 16).padding(.top, 14).padding(.bottom, 10)

      ScrollView {
        VStack(spacing: 2) {
          ForEach(store.conversations) { c in
            HomeRow(icon: "bubble.left.and.bubble.right", kicker: "Your chat with Kier, \(dateLabel(c.last)) \(timeLabel(c.last))", title: c.q ?? "",
                    done: { store.archive(c.key) }, doneHelp: "Put this chat away") { go(.chat(c.key)) }
          }
          ForEach(waiting) { c in
            HomeRow(icon: Kind.of(c.card).symbol, brand: c.brand, kicker: c.kicker, title: c.headline, done: { store.mark(c, "done") }) { go(.item(c.id)) }
          }
          if waiting.isEmpty { AllClear(done: doneByKier.filter { $0.state == "handled" }.count, next: comingUp.isEmpty ? nextEvent : nil) }
          // What Kier thinks is already settled, with why: the tick agrees, the card itself has Not done or Keep.
          if !probablyDone.isEmpty {
            Text("Probably done").font(.caption.weight(.medium)).foregroundStyle(.secondary)
              .frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 8).padding(.top, 14).padding(.bottom, 2)
            ForEach(probablyDone) { c in
              HomeRow(icon: Kind.of(c.card).symbol, brand: c.brand, kicker: c.kicker, title: c.headline, done: { store.mark(c, c.confirmStatus) }, doneHelp: c.confirmAnswer, evidence: c.reason) { go(.item(c.id)) }
            }
          }
          if !comingUp.isEmpty {
            Text("Coming up").font(.caption.weight(.medium)).foregroundStyle(.secondary)
              .frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 8).padding(.top, 14).padding(.bottom, 2)
            ForEach(comingUp, id: \.self) { line in
              HomeRow(icon: "calendar", kicker: [line.when, line.detail].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · "), title: line.text) {
                if let id = line.id { go(.event(id)) }
              }
            }
          }
          if !maybe.isEmpty {
            Text("Maybe yours").font(.caption.weight(.medium)).foregroundStyle(.secondary)
              .frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 8).padding(.top, 14).padding(.bottom, 2)
            ForEach(maybe) { c in
              HomeRow(icon: Kind.of(c.card).symbol, brand: c.brand, kicker: c.kicker, title: c.headline, done: { store.mark(c, c.confirmStatus) }, doneHelp: c.needsConfirmation ? c.confirmAnswer : "Mark done", evidence: c.needsConfirmation ? c.reason : nil) { go(.item(c.id)) }
                .opacity(0.75)
            }
          }
          // Folded away by default: one quiet row that opens the list of what Kier ticked off.
          if !doneByKier.isEmpty {
            Button { withAnimation(.easeOut(duration: 0.18)) { showDone.toggle() } } label: {
              HStack(spacing: 6) {
                Image(systemName: "checkmark.circle").foregroundStyle(Color(red: 0.45, green: 0.95, blue: 0.62).opacity(0.8))
                Text("Done").font(.caption.weight(.medium)).foregroundStyle(.secondary)
                Text("\(doneByKier.count)").font(.caption).foregroundStyle(.tertiary)
                Spacer()
                Image(systemName: "chevron.right").font(.caption2).foregroundStyle(.tertiary).rotationEffect(.degrees(showDone ? 90 : 0))
              }
              .padding(.horizontal, 8).padding(.vertical, 6).contentShape(Rectangle())
            }
            .buttonStyle(.plain).focusable(false).padding(.top, 10)
            if showDone {
              ForEach(doneByKier) { c in DoneRow(card: c, undo: { store.mark(c, "open") }) { go(.item(c.id)) } }
              Button("View more") { viewer.show("/done") }
                .buttonStyle(.borderless).font(.caption.weight(.medium))
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 8).padding(.vertical, 8)
                .help("Open the full Done list in Kier AI")
            }
          }
        }
        .padding(.horizontal, 8)
      }

      // A question from here starts a new conversation; inside a chat, the box continues that one.
      InputBar(placeholder: "Ask Kier anything…", agent: $agent) { q in
        let key = store.newChatKey()
        go(.chat(key))
        store.ask(q, agent: agent, key: key)
      }
      .padding(12)
    }
  }
}

// Nothing waiting: a calm tick in the orb's colours, what Kier already handled, and what's next on the calendar.
struct AllClear: View {
  let done: Int
  let next: Event?

  var body: some View {
    VStack(spacing: 10) {
      Image(systemName: "checkmark")
        .font(.system(size: 18, weight: .medium)).foregroundStyle(Kier.periLight)
        .frame(width: 48, height: 48)
        .background(Circle().fill(Kier.peri.opacity(0.10)))
        .overlay(Circle().strokeBorder(LinearGradient(colors: [Kier.periLight, Kier.lavender.opacity(0.35)], startPoint: .topLeading, endPoint: .bottomTrailing), lineWidth: 1.5))
      Text("All clear").font(.system(size: 20, weight: .medium)).tracking(-0.4)
      Text(done > 0 ? "Nothing is waiting on you, and Kier ticked off \(done) for you." : "Nothing is waiting on you. Kier taps the orb when something needs you.")
        .font(.system(size: 13)).foregroundStyle(Kier.dim).multilineTextAlignment(.center).fixedSize(horizontal: false, vertical: true)
      if let next {
        Label("Next: \(next.text), \(next.allDay == true ? dayLabel(next.day) : (dayLabel(next.day) == "Today" ? timeLabel(next.ts) : "\(dayLabel(next.day)) \(timeLabel(next.ts))"))", systemImage: "calendar")
          .font(.system(size: 12)).foregroundStyle(Kier.faint).lineLimit(1)
          .padding(.horizontal, 11).padding(.vertical, 5)
          .overlay(Capsule().strokeBorder(Color.white.opacity(0.12), lineWidth: 1))
          .padding(.top, 4)
      }
    }
    .frame(maxWidth: .infinity)
    .padding(.horizontal, 24).padding(.top, 30).padding(.bottom, 16)
  }
}

// Something Kier ticked off: struck through, with how it knows, and a way to put it back.
struct DoneRow: View {
  let card: Card
  let undo: () -> Void
  let open: () -> Void
  @State private var hover = false
  // Folded into another card rather than done.
  private var merged: Bool { card.reason?.hasPrefix("Merged into") == true }

  var body: some View {
    HStack(alignment: .center, spacing: 10) {
      Image(systemName: merged ? "arrow.triangle.merge" : "checkmark.circle.fill").font(.system(size: 15))
        .foregroundStyle(merged ? Color.secondary : Color(red: 0.45, green: 0.95, blue: 0.62).opacity(0.8))
      VStack(alignment: .leading, spacing: 2) {
        Text(card.state == "done" ? "You marked it done" : howDone(card.reason) ?? "Done").font(.caption).foregroundStyle(.secondary).lineLimit(1)
        Text(card.headline).font(.callout).strikethrough().foregroundStyle(.secondary).lineLimit(1)
      }
      Spacer(minLength: 4)
      Button(action: undo) { Image(systemName: "arrow.uturn.backward").font(.caption) }
        .buttonStyle(.borderless).foregroundStyle(.secondary).help("Not done, put it back").focusable(false)
        .opacity(hover ? 1 : 0.5)
    }
    .padding(.horizontal, 8).padding(.vertical, 6)
    .background(RoundedRectangle(cornerRadius: 10).fill(hover ? Glass.hover : .clear))
    .contentShape(Rectangle())
    .onHover { hover = $0 }
    .onTapGesture(perform: open)
  }
}

// Rotate the symbol about its own circle, not its asymmetric image bounds.
// Use a continuous effect that stops cleanly when refresh ends.
struct RefreshIcon: View {
  let spinning: Bool

  var body: some View {
    if #available(macOS 15, *) {
      Image(systemName: "arrow.clockwise").symbolEffect(.rotate.wholeSymbol, options: .repeat(.continuous), isActive: spinning)
    } else if spinning {
      ProgressView().controlSize(.small)
    } else {
      Image(systemName: "arrow.clockwise")
    }
  }
}

// One waiting thing on the home screen: what it is, who's waiting, a quick check-off, and a tap to open it.
struct HomeRow: View {
  let icon: String
  var brand: String? = nil
  let kicker: String
  let title: String
  var done: (() -> Void)?
  var doneHelp = "Mark done"
  var evidence: String? = nil
  let open: () -> Void
  @State private var hover = false

  var body: some View {
    HStack(alignment: .center, spacing: 10) {
      if let done {
        Button(action: done) {
          Image(systemName: hover ? "checkmark.circle" : "circle").font(.system(size: 15))
        }
          .buttonStyle(.borderless).foregroundStyle(.secondary).help(doneHelp).focusable(false)
      } else {
        Image(systemName: icon).foregroundStyle(.secondary).frame(width: 18)
      }
      VStack(alignment: .leading, spacing: 2) {
        HStack(spacing: 4) {
          // Where it came from, as the app's mark (Brand), before "You promised in …".
          if let mark = Brand.image(brand) { BrandMark(image: mark, height: 10) }
          Text(kicker).lineLimit(1)
        }
        .font(.caption).foregroundStyle(.secondary)
        Text(title).font(.callout).lineLimit(2).foregroundStyle(.primary)
        if let evidence { Text(evidence).font(.caption).foregroundStyle(.secondary).lineLimit(3) }
      }
      Spacer(minLength: 4)
      Image(systemName: "chevron.right").font(.caption).foregroundStyle(.tertiary)
    }
    .padding(.horizontal, 8).padding(.vertical, 8)
    .background(RoundedRectangle(cornerRadius: 10).fill(hover ? Glass.hover : .clear))
    .contentShape(Rectangle())
    .onHover { hover = $0 }
    .onTapGesture(perform: open)
  }
}

// A calendar event or timed reminder opens with its time, place, context and related messages,
// plus a link to Calendar or Reminders and an item-specific chat.
// Changelog entries are newest first; the full history is also on the product website.
struct NotesPage: View {
  let back: () -> Void

  private func day(_ iso: String) -> String {
    let f = DateFormatter()
    f.dateFormat = "yyyy-MM-dd"
    guard let d = f.date(from: iso) else { return iso }
    f.dateFormat = "MMM d"
    return f.string(from: d)
  }

  var body: some View {
    VStack(spacing: 0) {
      HStack {
        Button(action: back) { Label("Back", systemImage: "chevron.left") }.buttonStyle(.borderless).focusable(false)
        Spacer()
        Button("All changes") { if let url = URL(string: "https://kier.so/ai/changelog/") { LinkPolicy.open(url) } }
          .buttonStyle(.borderless).focusable(false)
      }
      .padding(.horizontal, 16).padding(.top, 14).padding(.bottom, 8)

      ScrollView {
        VStack(alignment: .leading, spacing: 20) {
          Text("What's new").font(.title3.weight(.medium))
          ForEach(Changelog.all.prefix(6)) { r in
            VStack(alignment: .leading, spacing: 6) {
              Text("Kier AI \(r.version), \(day(r.date))").font(.caption).foregroundStyle(.secondary)
              Text(r.title).font(.callout.weight(.medium)).fixedSize(horizontal: false, vertical: true)
              ForEach(r.notes, id: \.self) { note in
                Text(note).font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
              }
            }
          }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 16).padding(.bottom, 16)
      }
    }
  }
}

struct EventPage: View {
  @Environment(Store.self) var store
  let id: String
  @Binding var agent: String
  let back: () -> Void
  @State private var info: EventInfo?
  @State private var missing = false

  // Reminders with a time reach Calendar as "Scheduled Reminders"; they're reminders to the owner, not events.
  private var reminder: Bool { info?.calendar == "Scheduled Reminders" }

  private var when: String {
    guard let info else { return "" }
    return info.allDay ? dateLabel(info.ts) : "\(dateLabel(info.ts)), \(timeLabel(info.ts))"
  }

  var body: some View {
    VStack(spacing: 0) {
      HStack {
        Button(action: back) { Label("Back", systemImage: "chevron.left") }.buttonStyle(.borderless).focusable(false)
        Spacer()
        if let info {
          Button(reminder ? "Open in Reminders" : "Open in Calendar") {
            if reminder, let app = NSWorkspace.shared.urlForApplication(withBundleIdentifier: "com.apple.reminders") {
              NSWorkspace.shared.openApplication(at: app, configuration: .init())
            } else if let url = URL(string: "calshow:\(Double(info.ts) - Date.timeIntervalBetween1970AndReferenceDate)") {
              LinkPolicy.open(url)
            }
          }
          .buttonStyle(.borderless).focusable(false)
        }
      }
      .padding(.horizontal, 16).padding(.top, 14).padding(.bottom, 8)

      ScrollView {
        VStack(alignment: .leading, spacing: 12) {
          if let info {
            Text("\(reminder ? "Reminder" : info.calendar) · \(when)").font(.caption).foregroundStyle(.secondary)
            Text(info.label ?? info.title).font(.title3.weight(.medium)).fixedSize(horizontal: false, vertical: true)
            if info.label != nil, info.label != info.title {
              Text("“\(info.title)”").font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
            if let place = info.place { Label(place, systemImage: "mappin.and.ellipse").font(.callout).foregroundStyle(.secondary) }
            if let context = info.context, !context.isEmpty {
              Label(context, systemImage: "text.bubble").font(.callout).fixedSize(horizontal: false, vertical: true)
            }
            if !info.related.isEmpty {
              Text("From your chats").font(.caption.weight(.medium)).foregroundStyle(.secondary).padding(.top, 6)
              VStack(alignment: .leading, spacing: 10) {
                ForEach(info.related) { m in
                  VStack(alignment: .leading, spacing: 2) {
                    Text("\(m.who), \(sourceName(m.source)), \(dateLabel(m.ts))").font(.caption).foregroundStyle(.secondary).lineLimit(1)
                    Text(m.text).font(.callout).lineLimit(3).fixedSize(horizontal: false, vertical: true)
                  }
                }
              }
              .padding(10)
              .frame(maxWidth: .infinity, alignment: .leading)
              .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Glass.hairline, lineWidth: 0.5))
            }
            Divider().padding(.vertical, 4)
            ChatThread(key: info.id, empty: "Ask anything about this: what to bring, who it's with, what was agreed.")
          } else if missing {
            Text("This isn't on the calendar any more.").font(.callout).foregroundStyle(.secondary).padding(.top, 30)
          } else {
            ProgressView().controlSize(.small).frame(maxWidth: .infinity).padding(.top, 40)
          }
        }
        .padding(.horizontal, 16).padding(.bottom, 8)
      }

      if let info {
        InputBar(placeholder: "Ask about this…", agent: $agent) { q in store.ask(q, agent: agent, key: info.id, item: info.id) }
          .padding(.horizontal, 12).padding(.top, 8).padding(.bottom, 12)
          .overlay(alignment: .top) { Rectangle().fill(Glass.hairline).frame(height: 0.5) }
      }
    }
    .task(id: id) {
      info = await store.event(id)
      missing = info == nil
    }
  }
}

// A page for one waiting thing: where it came from, the chat around it, what to do with it, and a chat about it.
struct ItemPage: View {
  @Environment(Store.self) var store
  let card: Card
  @Binding var agent: String
  let back: () -> Void
  // Once you're talking about it, what was said folds away so the conversation has the room; one tap brings it back.
  @State private var showContext = false
  // Renaming it by hand: a double-click on the title, or the pencil beside it. Return keeps it, Escape doesn't.
  @State private var renaming = false
  @State private var newTitle = ""
  @FocusState private var titleFocused: Bool
  // Finished, whoever finished it: a card you marked done or not yours offered "Mark done" again.
  private var ticked: Bool { ["handled", "done", "dismissed"].contains(card.state ?? "") }
  // Show whether the owner or Kier closed a card, and the supporting evidence when Kier closed it.
  private var closedBy: String {
    if card.reason == "marked in the timeline" { return card.state == "dismissed" ? "You marked it not yours" : "You marked it done" }
    if card.reason == "ticked off in Reminders" { return "You ticked it off in Reminders" }
    if card.reason == "deleted in Reminders" { return "You deleted it in Reminders" }
    return howDone(card.reason).map { "Kier saw it done: \($0)" } ?? "Done"
  }
  @State private var copied = false
  @State private var handed: String?
  @State private var handedWhy: String?
  @State private var openWhy: String?

  var body: some View {
    let chatting = !(store.chats[card.id] ?? []).isEmpty || store.asking.contains(card.id)
    VStack(spacing: 0) {
      HStack {
        Button(action: back) { Label("Waiting", systemImage: "chevron.left") }.buttonStyle(.borderless).focusable(false)
        Spacer()
        if ticked {
          Button("Put back") { store.mark(card, "open"); back() }.buttonStyle(.borderless).focusable(false).help("Not done: back on the list")
        } else {
          Button { store.mark(card, card.confirmStatus); back() } label: { Label(card.needsConfirmation ? card.confirmAnswer : "Mark done", systemImage: "checkmark") }.buttonStyle(.borderless).focusable(false)
        }
      }
      .padding(.horizontal, 16).padding(.top, 14).padding(.bottom, 8)

      ScrollViewReader { scroll in
        ScrollView {
          VStack(alignment: .leading, spacing: 12) {
            Text(card.kicker).font(.caption).foregroundStyle(.secondary)
            if renaming {
              TextField("Title", text: $newTitle)
                .textFieldStyle(.plain).font(.title3.weight(.medium))
                .focused($titleFocused)
                .onSubmit {
                  let t = newTitle.trimmingCharacters(in: .whitespacesAndNewlines)
                  if t.count > 1, t != card.headline { store.rename(card, to: t) }
                  renaming = false
                }
                .onKeyPress(.escape) { renaming = false; return .handled }
            } else {
              HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(card.headline).font(.title3.weight(.medium)).fixedSize(horizontal: false, vertical: true)
                  .onTapGesture(count: 2) { newTitle = card.headline; renaming = true; titleFocused = true }
                Button { newTitle = card.headline; renaming = true; titleFocused = true } label: { Image(systemName: "pencil") }
                  .buttonStyle(.borderless).foregroundStyle(.tertiary).help("Rename")
              }
            }
            if let hint = card.hint, !ticked { Label("Maybe done by: \(hint)", systemImage: "arrow.triangle.branch").font(.caption).foregroundStyle(.teal) }
            if card.needsConfirmation {
              VStack(alignment: .leading, spacing: 4) {
                Text(card.suggestionLabel).font(.caption.weight(.medium))
                if let reason = card.reason { Text(howDone(reason) ?? reason).font(.caption).foregroundStyle(.secondary) }
                Button(card.looksUnneeded ? "Keep" : "Not done") { store.mark(card, "open"); back() }.buttonStyle(.borderless)
              }
            }
            // Ticked off by Kier: how it knows, and the proof itself when it's a link (a commit, a pull request).
            if ticked {
              HStack(alignment: .firstTextBaseline, spacing: 6) {
                Image(systemName: "checkmark.circle.fill").foregroundStyle(Color(red: 0.45, green: 0.95, blue: 0.62))
                if let url = safeLink(card.evidence_url) {
                  Link(destination: url) { Text(closedBy).multilineTextAlignment(.leading) }
                } else {
                  Text(closedBy).foregroundStyle(.secondary)
                }
              }
              .font(.caption)
            }

            if chatting {
              Button { withAnimation(.easeOut(duration: 0.2)) { showContext.toggle() } } label: {
                Label(showContext ? "Hide what was said" : "What was said, and since", systemImage: showContext ? "chevron.up" : "chevron.down").font(.caption)
              }
              .buttonStyle(.borderless).focusable(false)
            }

            if chatting && !showContext {
              EmptyView()
            } else if let ctx = store.context, ctx.item.id == card.id, !ctx.messages.isEmpty {
              VStack(spacing: 4) { ForEach(ctx.messages) { MiniBubble(message: $0) } }
                .padding(10)
                .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Glass.hairline, lineWidth: 0.5))
              ForEach(ctx.since.prefix(4)) { since in
                if let link = since.url.flatMap(URL.init(string:)) {
                  Link(destination: link) { Text(since.line).font(.caption).multilineTextAlignment(.leading) }
                } else {
                  Text(since.line).font(.caption).foregroundStyle(.secondary)
                }
              }
            } else if let said = card.text, card.card != "ask" {
              Text("“\(said.replacingOccurrences(of: "\n", with: " / "))”").font(.callout).foregroundStyle(.secondary)
            }

            Divider().padding(.vertical, 4)
            ChatThread(key: card.id, empty: "Ask anything about this: is it done, what they meant, what was agreed, what to reply.")
          }
          .padding(.horizontal, 16).padding(.bottom, 8)
        }
        // Follow the conversation: when you send, and when the answer comes.
        .onChange(of: store.chats[card.id]?.count ?? 0) { withAnimation { scroll.scrollTo("end", anchor: .bottom) } }
        .onChange(of: store.asking.contains(card.id)) { withAnimation { scroll.scrollTo("end", anchor: .bottom) } }
        .onChange(of: store.partial[card.id]?.count ?? 0) { scroll.scrollTo("end", anchor: .bottom) }
      }

      // What you can do with it stays at the bottom with the chat box, however far the page scrolls.
      HStack(spacing: 8) {
        openSession
        if card.canReply { Button(card.openLabel) { store.reply(card) } }
        Button("Tomorrow") { store.mark(card, "snoozed"); back() }
        // Work your own session left behind is yours by definition. One the second opinion doubts can be claimed.
        if card.maybe?.on == true { Button("Mine") { store.mark(card, "mine"); back() } }
        if card.card != "promise" && card.card != "stalled" { Button("Not mine") { store.mark(card, "dismissed"); back() } }
        Spacer()
        handOff
      }
      .buttonStyle(.bordered).controlSize(.small).focusable(false)
      .padding(.horizontal, 12).padding(.top, 8)
      .overlay(alignment: .top) { Rectangle().fill(Glass.hairline).frame(height: 0.5) }

      InputBar(placeholder: "Ask about this…", agent: $agent) { q in
        withAnimation(.easeOut(duration: 0.2)) { showContext = false }
        store.ask(q, agent: agent, key: card.id, item: card.id)
      }
      .padding(.horizontal, 12).padding(.top, 8).padding(.bottom, 12)
    }
    .onAppear { store.select(card) }
    .task { await store.loadChat(card.id) }
    .task { await store.loadHandoff(card.id) }
  }

  // A card from an AI session (its question, or work it left unfinished) opens that session as it was: in the Claude
  // app when it ran there, else resumed in Terminal, when Claude Code or Codex is installed.
  @ViewBuilder private var openSession: some View {
    if card.source == "ai", let s = store.handoffs[card.id]?.session, s.opensIn != nil {
      Button(openWhy != nil ? "Couldn't open" : "Open in \(s.product)") {
        store.openSession(card.id, s) { why in openWhy = why.map { "Couldn't open it: \($0)." } }
      }
      .help(openWhy ?? (s.opensIn == "app" ? "Opens “\(s.title)” in \(s.product)." : "Resumes “\(s.title)” in Terminal."))
      .onChange(of: openWhy) { if openWhy != nil { Task { try? await Task.sleep(for: .seconds(6)); openWhy = nil } } }
    }
  }

  // One button: a new Claude session working on it; the arrow for Codex, or a note for a session that's already running.
  private var handOff: some View {
    let h = store.handoffs[card.id]
    return Menu {
      Button("Start a Claude session") { store.startSession(card.id, agent: "claude") }
      Button("Start a Codex session") { store.startSession(card.id, agent: "codex") }
      Divider()
      // The note works in any agent's chat; paste it wherever you want the work done.
      Button("Copy a note for any agent") { if let h { store.copy(h.short); copied = true } }.disabled(h == nil)
      Button("Copy the full brief") { Task { if await store.copyFullBrief(card.id) { copied = true } } }
      // Only what Kier does in a running session itself needs to know which one.
      if let h, let s = h.session {
        Divider()
        if s.codex || s.provider == "chatgpt", s.opensIn == "app" {
          Button("Open “\(s.title)” in \(s.product) and copy note") {
            store.copy(h.short)
            copied = true
            store.openSession(card.id, s) { why in handedWhy = why }
          }
        }
        Button("Branch “\(s.title)” in Terminal") { store.startSession(card.id, agent: "claude", branch: true) }
      } else if h == nil {
        Divider()
        Text("Finding the session it belongs to…")
      }
      Divider()
      Button("Show in Kier AI") { viewer.show("/"); store.select(card) }
    } label: {
      Label(handed ?? (copied ? "Copied, paste with ⌘V" : "Hand off"), systemImage: handed != nil || copied ? "checkmark" : "arrow.up.forward")
    } primaryAction: {
      store.startSession(card.id, agent: "claude")
    }
    .fixedSize()
    .help(handedWhy ?? h?.session.map { "Starts a new Claude session with everything Kier knows. Probably belongs to “\($0.title)”." } ?? "Starts a new Claude session with everything Kier knows about this.")
    .onChange(of: copied) { if copied { Task { try? await Task.sleep(for: .seconds(4)); copied = false } } }
    .onChange(of: handed) { if handed != nil { Task { try? await Task.sleep(for: .seconds(7)); handed = nil; handedWhy = nil } } }
  }
}

struct ChatPage: View {
  @Environment(Store.self) var store
  let key: String
  @Binding var agent: String
  let back: () -> Void
  let new: () -> Void

  var body: some View {
    VStack(spacing: 0) {
      HStack {
        Button(action: back) { Label("Waiting", systemImage: "chevron.left") }.buttonStyle(.borderless).focusable(false)
        Spacer()
        Text("Chat").font(.headline)
        Spacer()
        Button(action: new) { Image(systemName: "square.and.pencil") }.buttonStyle(.borderless).focusable(false).help("New chat")
      }
      .padding(.horizontal, 16).padding(.top, 14).padding(.bottom, 8)
      ScrollViewReader { scroll in
        ScrollView {
          ChatThread(key: key, empty: "Ask about your day, a person, a promise, a chat. Claude and Codex search your vault; Kier answers from today's brief, and about an item from everything the vault shows about it.")
            .padding(.horizontal, 16)
        }
        .onChange(of: store.chats[key]?.count ?? 0) { withAnimation { scroll.scrollTo("end", anchor: .bottom) } }
        .onChange(of: store.asking.contains(key)) { withAnimation { scroll.scrollTo("end", anchor: .bottom) } }
        .onChange(of: store.partial[key]?.count ?? 0) { scroll.scrollTo("end", anchor: .bottom) }
      }
      InputBar(placeholder: "Ask Kier…", agent: $agent) { q in store.ask(q, agent: agent, key: key) }.padding(12)
    }
    .task(id: key) { await store.loadChat(key) }
  }
}

// MARK: Chat

// A conversation: your questions on the right, Kier's answers on the left beside the orb, and dots while it thinks.
struct ChatThread: View {
  @Environment(Store.self) var store
  let key: String
  let empty: String

  var body: some View {
    VStack(alignment: .leading, spacing: 14) {
      let turns = store.chats[key] ?? []
      if turns.isEmpty && !store.asking.contains(key) {
        Text(empty).font(.callout).foregroundStyle(.secondary)
      }
      ForEach(turns) { turn in
        VStack(alignment: .leading, spacing: 8) {
          mine(turn.q)
          HStack(alignment: .top, spacing: 8) {
            KierMark().frame(width: 22, height: 22).padding(.top, 2)
            VStack(alignment: .leading, spacing: 4) {
              Text(markdown(turn.a))
                .font(.callout)
                .textSelection(.enabled)
                .padding(.horizontal, 12).padding(.vertical, 8)
                .background(Color.primary.opacity(0.07), in: RoundedRectangle(cornerRadius: 16))
              ActionButtons(actions: turn.actions).padding(.top, 2)
              HStack(spacing: 8) {
                Text(turn.from).font(.caption2).foregroundStyle(.tertiary)
                Button { store.say(turn.a) } label: { Image(systemName: "speaker.wave.2").font(.caption2) }.buttonStyle(.borderless).help("Say it")
              }
              .padding(.leading, 4)
              if let note = turn.note {
                Label("Kier will remember: \(note)", systemImage: "person.text.rectangle").font(.caption2).foregroundStyle(.teal).padding(.leading, 4)
                  .help("Saved to Who you are on the Setup page, where you can change it")
              }
            }
            Spacer(minLength: 30)
          }
        }
      }
      if store.asking.contains(key) {
        if let q = store.pending[key] { mine(q) }
        // The answer grows in place as it's written; until the first words, dots and what it's doing.
        if let text = store.partial[key], !text.isEmpty {
          HStack(alignment: .top, spacing: 8) {
            KierMark().frame(width: 22, height: 22).padding(.top, 2)
            Text(markdown(text))
              .font(.callout)
              .padding(.horizontal, 12).padding(.vertical, 8)
              .background(Color.primary.opacity(0.07), in: RoundedRectangle(cornerRadius: 16))
            Spacer(minLength: 30)
          }
        } else {
          HStack(alignment: .center, spacing: 8) {
            KierMark().frame(width: 22, height: 22)
            TypingDots()
              .padding(.horizontal, 12).padding(.vertical, 10)
              .background(Color.primary.opacity(0.07), in: RoundedRectangle(cornerRadius: 16))
            if let step = store.step[key] { WorkingLine(step: step) }
          }
          .animation(.easeOut(duration: 0.25), value: store.step[key])
        }
      }
      Color.clear.frame(height: 1).id("end")
    }
  }
}


extension ChatThread {
  // Your side of the conversation.
  func mine(_ q: String) -> some View {
    HStack {
      Spacer(minLength: 50)
      Text(q)
        .font(.callout)
        .foregroundStyle(.white)
        .padding(.horizontal, 12).padding(.vertical, 8)
        .background(LinearGradient(colors: [Color(red: 0.36, green: 0.48, blue: 0.95), Color(red: 0.50, green: 0.40, blue: 0.92)], startPoint: .topLeading, endPoint: .bottomTrailing),
                    in: RoundedRectangle(cornerRadius: 16))
    }
  }
}

struct TypingDots: View {
  var body: some View {
    SwiftUI.TimelineView(.animation(minimumInterval: 1.0 / 30)) { ctx in
      let t = ctx.date.timeIntervalSinceReferenceDate
      HStack(spacing: 4) {
        ForEach(0..<3) { i in
          Circle().frame(width: 6, height: 6)
            .opacity(0.3 + 0.7 * max(0, sin(t * 5 - Double(i) * 0.7)))
        }
      }
      .foregroundStyle(.secondary)
    }
  }
}

// The box you type into: who answers, the question, and a send button.
struct InputBar: View {
  let placeholder: String
  @Binding var agent: String
  let send: (String) -> Void
  @State private var text = ""
  @FocusState private var focused: Bool

  var body: some View {
    HStack(spacing: 8) {
      Menu {
        Button("Claude") { agent = "claude" }
        Button("Codex unavailable: access cannot be limited to Kier") {}.disabled(true)
        Button("Kier, on this Mac") { agent = "kier" }
      } label: {
        Text(["claude": "Claude", "codex": "Codex"][agent] ?? "Kier").font(.caption.weight(.medium))
      }
      .onAppear { if agent == "codex" { agent = "claude" } }
      .menuStyle(.borderlessButton)
      .fixedSize()
      .focusable(false)
      TextField(placeholder, text: $text)
        .textFieldStyle(.plain)
        .focused($focused)
        .onSubmit(submit)
      Button(action: submit) {
        Image(systemName: "arrow.up.circle.fill").font(.system(size: 20))
          .foregroundStyle(text.trimmingCharacters(in: .whitespaces).isEmpty ? Color.secondary : Color.accentColor)
      }
      .buttonStyle(.borderless)
      .disabled(text.trimmingCharacters(in: .whitespaces).isEmpty)
      .focusable(false)
    }
    .padding(.leading, 12).padding(.trailing, 6).padding(.vertical, 6)
    .background(Color.white.opacity(0.05), in: Capsule())
    .overlay(Capsule().strokeBorder(focused ? Glass.rim : Glass.hairline, lineWidth: 0.5))
    // Ready to type on every page you open; asked for once the page has slid in, or the request is lost mid-slide.
    .task {
      try? await Task.sleep(for: .milliseconds(260))
      focused = true
    }
  }

  private func submit() {
    let q = text.trimmingCharacters(in: .whitespaces)
    guard !q.isEmpty else { return }
    text = ""
    send(q)
  }
}

// A compact chat bubble for an item's context.
struct MiniBubble: View {
  let message: Context.Message

  var body: some View {
    HStack {
      if message.from_me { Spacer(minLength: 30) }
      VStack(alignment: message.from_me ? .trailing : .leading, spacing: 1) {
        if !message.from_me { Text(message.sender ?? "").font(.caption2.weight(.medium)).foregroundStyle(.secondary) }
        Text(markdown(message.text ?? ""))
          .font(.caption)
          .padding(.horizontal, 8).padding(.vertical, 4)
          .background(RoundedRectangle(cornerRadius: 9).fill(message.from_me ? Color.accentColor.opacity(0.22) : Color.secondary.opacity(0.14)))
          .overlay(RoundedRectangle(cornerRadius: 9).strokeBorder(message.picked ? Color.orange : .clear, lineWidth: 1.2))
      }
      if !message.from_me { Spacer(minLength: 30) }
    }
  }
}
