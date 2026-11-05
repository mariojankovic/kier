import AppKit
import Metal
import QuartzCore

// MARK: The island on its own thread
// A dedicated display-link thread draws the island with one Metal layer, keeping animation
// independent of main-thread UI work. The main thread supplies IslandGoal; springs and
// rendering are updated here.

// What the island should look like. The main thread sets it; the island's thread springs toward it.
struct IslandGoal: Equatable {
  var tucked = false
  var hover = false
  var pressed = false
  var nudging = false
  var glance = false
  // Kier's panel is open beside the island: the orb turns toward it.
  var panel = false
  var attention: Float = 0
  var working = false
  var burst = Date.distantPast
  var celebrated = Date.distantPast
  // The orb's middle in screen points from the top left, for the highlight that leans toward the pointer.
  var center = CGPoint.zero
  var light = SIMD3<Float>(0, 0, 0)
  // Pixels per point, and whether the island can be seen at all (not hidden, covered, or on a sleeping screen).
  var scale: Float = 2
  var visible = true
}

// SwiftUI's spring(response:dampingFraction:), stepped by hand, so the island moves as it did.
struct Spring {
  var value: Double
  var velocity = 0.0
  var response = 0.42
  var damping = 0.84

  // One frame toward `target`; false once it has settled there.
  mutating func step(to target: Double, _ dt: Double) -> Bool {
    let stiffness = pow(2 * .pi / response, 2), friction = 4 * .pi * damping / response
    var left = dt
    while left > 0 {
      let h = min(left, 1.0 / 240)
      velocity += (stiffness * (target - value) - friction * velocity) * h
      value += velocity * h
      left -= h
    }
    if abs(target - value) < 0.001 && abs(velocity) < 0.01 { value = target; velocity = 0; return false }
    return true
  }
}

// A synchronized snapshot of the dimensions actually sent to the shader, including
// the spring between tucked and expanded. Input follows the painted shape.
struct IslandHitGeometry: Sendable {
  var width: CGFloat = 78
  var height: CGFloat = 104
  var fillet: CGFloat = 16
  var radius: CGFloat = 24
}

// Opt-in hover prototypes. These values match kierIsland's final uniform slots.
enum IslandHoverVariant: Int {
  case none = 0
  case shimmer = 1
  case tilt = 2
  case starWakes = 3
  case pearlRim = 4
}

final class IslandRenderer: NSObject, CAMetalDisplayLinkDelegate, @unchecked Sendable {
  let layer = CAMetalLayer()
  private let queue: MTLCommandQueue
  private let pipeline: MTLRenderPipelineState
  private let artwork: MTLTexture
  private var link: CAMetalDisplayLink!
  private let lock = NSLock()
  private var goal = IslandGoal()
  private var painted = IslandHitGeometry()
  var hitGeometry: IslandHitGeometry { lock.withLock { painted } }
  private var loop: CFRunLoop?

  // Only the island's thread touches these.
  private let start = CACurrentMediaTime()
  private var last = CACurrentMediaTime()
  private var started = false
  private var width = Spring(value: 78), height = Spring(value: 104), fillet = Spring(value: 16), radius = Spring(value: 24)
  private var open = Spring(value: 1), lift = Spring(value: 0)
  private var grow = Spring(value: 1, response: 0.32, damping: 0.55)
  // Pearl rim: a thin pearl edge follows the pointer, and a click tightens and brightens it.
  private let hoverVariant: IslandHoverVariant = .pearlRim
  private var pressAmount = Spring(value: 0, response: 0.14, damping: 0.85)
  private var hoverAmount = Spring(value: 0, response: 0.26, damping: 0.90)
  private var hoverWasInside = false
  private var hoverEnteredAt: CFTimeInterval?
  private var hoverMouse: SIMD2<Double>?
  private var edge = 0.0
  private var working: Float = 0
  private var light: SIMD3<Float>?
  private var rate: Float = 0

  init?(size: CGSize) {
    guard let device = MTLCreateSystemDefaultDevice(), let queue = device.makeCommandQueue(),
          let library = device.makeDefaultLibrary(),
          let url = Bundle.main.url(forResource: "orb", withExtension: "png"),
          let artwork = try? IslandArtwork.load(device: device, url: url) else { return nil }
    let d = MTLRenderPipelineDescriptor()
    d.vertexFunction = library.makeFunction(name: "kierIslandVertex")
    d.fragmentFunction = library.makeFunction(name: "kierIsland")
    d.colorAttachments[0].pixelFormat = .bgra8Unorm
    guard let pipeline = try? device.makeRenderPipelineState(descriptor: d) else { return nil }
    self.queue = queue
    self.pipeline = pipeline
    self.artwork = artwork
    super.init()
    layer.device = device
    layer.pixelFormat = .bgra8Unorm
    layer.colorspace = CGColorSpace(name: CGColorSpace.sRGB)
    layer.isOpaque = false
    layer.framebufferOnly = true
    layer.drawableSize = CGSize(width: size.width * 2, height: size.height * 2)
    link = CAMetalDisplayLink(metalLayer: layer)
    link.delegate = self
    let thread = Thread { [unowned self] in
      self.lock.withLock { self.loop = CFRunLoopGetCurrent() }
      RunLoop.current.add(NSMachPort(), forMode: .default)
      self.link.add(to: .current, forMode: .default)
      RunLoop.current.run()
    }
    thread.name = "Kier island"
    thread.qualityOfService = .userInteractive
    thread.start()
  }

  // From the main thread: what the island should be now. A resting island wakes up to show it.
  func set(_ change: (inout IslandGoal) -> Void) {
    let changed = lock.withLock {
      let old = goal
      change(&goal)
      return goal != old
    }
    guard changed, let loop = lock.withLock({ loop }) else { return }
    CFRunLoopPerformBlock(loop, CFRunLoopMode.defaultMode.rawValue) { [self] in
      if link.isPaused { last = CACurrentMediaTime(); link.isPaused = false }
    }
    CFRunLoopWakeUp(loop)
  }

  func metalDisplayLink(_ link: CAMetalDisplayLink, needsUpdate update: CAMetalDisplayLink.Update) {
    let g = lock.withLock { goal }
    let now = CACurrentMediaTime()
    let dt = min(0.1, now - last)
    last = now
    let t = now - start

    // Every change of shape springs as SwiftUI's islandSpring did; the first frame starts where the island already is.
    let size = OrbModel.size(tucked: g.tucked, nudging: g.nudging, glance: g.glance)
    let targets: [(ReferenceWritableKeyPath<IslandRenderer, Spring>, Double)] = [
      (\.width, size.width), (\.height, size.height), (\.fillet, g.tucked ? 6 : 16), (\.radius, g.tucked ? 4 : 24),
      (\.open, g.tucked ? 0 : 1), (\.lift, g.glance ? -8 : 0), (\.grow, g.pressed ? 0.93 : g.hover ? 1.08 : 1),
    ]
    var moving = false
    for (path, to) in targets {
      if started { moving = self[keyPath: path].step(to: to, dt) || moving } else { self[keyPath: path].value = to }
    }
    started = true
    var hoverAge = 0.0
    if hoverVariant != .none {
      // Open beside it, the panel holds the orb's attention as the pointer does.
      let inside = (g.hover || g.panel) && !g.tucked
      if inside && !hoverWasInside { hoverEnteredAt = now }
      hoverWasInside = inside
      hoverAge = hoverEnteredAt.map { now - $0 } ?? 100
      moving = hoverAmount.step(to: inside ? 1 : 0, dt) || moving
      moving = pressAmount.step(to: inside && g.pressed ? 1 : 0, dt) || moving
    }
    var l = light ?? g.light
    l += (g.light - l) * Float(min(1, dt * 1.4))
    light = l
    let lighting = ((g.light - l) * (g.light - l)).sum() > 1e-6
    let date = Date()
    let fresh = Float(max(0, 1 - date.timeIntervalSince(g.burst) / 5))
    let cheer = Float(max(0, 1 - date.timeIntervalSince(g.celebrated) / 1.5))
    edge += ((g.tucked && (g.attention > 0 || g.working) ? 1 : 0) - edge) * min(1, dt * 8)
    if edge < 0.002 { edge = 0 }
    working += ((g.working ? 1 : 0) - working) * Float(min(1, dt * 8))
    if !g.working && working < 0.002 { working = 0 }

    // The orb sits in the island's middle and slides into the notch, smaller and fading, as it tucks away; it bobs a
    // little, grows when you're on it and for a moment when something new comes in.
    let window = OrbModel.window
    let reveal = 0.35 + 0.65 * open.value
    let midX = window.width - width.value / 2, midY = window.height / 2
    let orbX = midX - 2 * reveal
    let orbY = midY + reveal * (lift.value + sin(t * 1.1) * 1.2)
    let orbScale = reveal * grow.value * (1 + Double(fresh * fresh) * 0.08)
    let cursor = CGEvent(source: nil)?.location ?? .zero
    var mouse = (x: (cursor.x - g.center.x) / 260, y: (g.center.y - cursor.y) / 260)
    if hoverVariant != .none {
      var target = SIMD2<Double>(Double(mouse.x), Double(mouse.y))
      // The panel opens to the left, so the orb turns that way, a little up, and the pointer only leans it from there.
      if g.panel { target = SIMD2(-0.12, 0.02) + target * 0.25 }
      var smoothed = hoverMouse ?? target
      smoothed += (target - smoothed) * (1 - exp(-dt * (g.panel ? 6 : 12)))
      hoverMouse = smoothed
      mouse = (CGFloat(smoothed.x), CGFloat(smoothed.y))
    }
    let glow = g.tucked && g.nudging ? 0.07 + 0.07 * sin(t * 2.4) : 0
    let selectedHover = hoverVariant != .none && !g.tucked
    var u: [Float] = [
      Float(window.width), Float(window.height), g.scale, Float(t),
      Float(width.value), Float(height.value), Float(fillet.value), Float(radius.value),
      Float(orbX), Float(orbY), Float(orbScale), Float(min(1, max(0, open.value))),
      Float(orbX), Float(midY + reveal * lift.value), Float(reveal), cheer,
      Float(mouse.x), Float(mouse.y), g.attention + fresh * 1.5, Float(glow),
      l.x, l.y, l.z, Float(edge),
      working, selectedHover ? Float(hoverVariant.rawValue) : 0,
      selectedHover ? Float(min(1, max(0, hoverAmount.value))) : 0, selectedHover ? Float(hoverAge) : 0,
      selectedHover ? Float(min(1, max(0, pressAmount.value))) : 0, 0, 0, 0,
    ]
    lock.withLock { painted = IslandHitGeometry(width: width.value, height: height.value, fillet: fillet.value, radius: radius.value) }
    let pass = MTLRenderPassDescriptor()
    pass.colorAttachments[0].texture = update.drawable.texture
    pass.colorAttachments[0].loadAction = .clear
    pass.colorAttachments[0].clearColor = MTLClearColor(red: 0, green: 0, blue: 0, alpha: 0)
    pass.colorAttachments[0].storeAction = .store
    if let buffer = queue.makeCommandBuffer(), let encoder = buffer.makeRenderCommandEncoder(descriptor: pass) {
      encoder.setRenderPipelineState(pipeline)
      encoder.setFragmentBytes(&u, length: MemoryLayout<Float>.stride * u.count, index: 0)
      encoder.setFragmentTexture(artwork, index: 0)
      encoder.drawPrimitives(type: .triangle, vertexStart: 0, vertexCount: 3)
      encoder.endEncoding()
      buffer.present(update.drawable)
      buffer.commit()
    }

    // 60 frames a second while you're on it, something just happened or it's moving; 30 for the slow light that orbits
    // it while something waits or Kier works; 24 when still. Tucked and quiet, or out of sight, it rests on its last frame.
    let want: Float = g.hover || g.pressed || fresh > 0 || cheer > 0 || moving ? 60 : g.attention > 0 || g.nudging || working > 0 ? 30 : 24
    if want != rate {
      rate = want
      link.preferredFrameRateRange = CAFrameRateRange(minimum: 8, maximum: want, preferred: want)
    }
    let quiet = g.tucked && !g.hover && !g.nudging && !g.working && g.attention == 0 && fresh == 0 && cheer == 0 && edge == 0
    if !g.visible || (quiet && !moving && !lighting) { link.isPaused = true }
  }
}

// The island's Metal layer, under the one line SwiftUI still draws; it never takes the mouse (IslandHost does).
final class IslandCanvas: NSView {
  let renderer: IslandRenderer
  private var watching: NSObjectProtocol?

  init(_ renderer: IslandRenderer, frame: NSRect) {
    self.renderer = renderer
    super.init(frame: frame)
    wantsLayer = true
  }

  required init?(coder: NSCoder) { fatalError() }

  override func makeBackingLayer() -> CALayer { renderer.layer }
  override func hitTest(_ point: NSPoint) -> NSView? { nil }

  override func viewDidChangeBackingProperties() {
    let s = window?.backingScaleFactor ?? 2
    renderer.layer.contentsScale = s
    renderer.layer.drawableSize = CGSize(width: bounds.width * s, height: bounds.height * s)
    renderer.set { $0.scale = Float(s) }
  }

  override func viewDidMoveToWindow() {
    viewDidChangeBackingProperties()
    if let watching { NotificationCenter.default.removeObserver(watching) }
    guard let w = window else { return }
    watching = NotificationCenter.default.addObserver(forName: NSWindow.didChangeOcclusionStateNotification, object: w, queue: .main) { [weak self] _ in
      MainActor.assumeIsolated { self?.renderer.set { $0.visible = w.occlusionState.contains(.visible) } }
    }
  }
}
