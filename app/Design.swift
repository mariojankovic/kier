import SwiftUI

// Flat and quiet, after CodeNotch (github.com/vinzdg/codenotch, MIT): near-black greys, cards that are just a lighter
// fill with no rim or shadow, plain icons, Apple's own system font at a Mac app's sizes, and text in white at a few
// stepped opacities instead of system greys. Semibold only for page titles and card titles; everything else regular
// or medium.
enum Kier {
  static let peri = Color(red: 0.557, green: 0.608, blue: 0.890)       // #8e9be3
  static let periLight = Color(red: 0.690, green: 0.725, blue: 0.957)  // a step lighter, for peri on black
  static let lavender = Color(red: 0.812, green: 0.784, blue: 0.949)   // #cfc8f2
  // White at stepped opacities: titles and the selected row, rows and body text, a page's one dim line, counts and
  // quiet metadata.
  static let bright = Color.white.opacity(0.95)
  static let text = Color.white.opacity(0.78)
  static let dim = Color.white.opacity(0.5)
  static let faint = Color.white.opacity(0.42)
  static let hair = Color.white.opacity(0.07)
  static let edge = Color.white.opacity(0.09)      // the window's own edge
  static let selected = Color.white.opacity(0.10)  // the selected row's pill
  static let hovered = Color.white.opacity(0.05)   // a row under the pointer
  // The window #0E0E10, the sidebar a step lighter at #161618, and a card or the message box a step above that.
  static let page = Color(red: 0.055, green: 0.055, blue: 0.063)
  static let sidebar = Color(red: 0.086, green: 0.086, blue: 0.094)
  static let raised = Color(red: 0.118, green: 0.118, blue: 0.129)
}

extension Font {
  static let kierTitle = Font.system(size: 19, weight: .medium)       // a page's title
  static let kierHeadline = Font.system(size: 14, weight: .medium)    // the app's name, a sheet's title
  static let kierCardTitle = Font.system(size: 13, weight: .medium)
  static let kierBody = Font.system(size: 13)
  static let kierRow = Font.system(size: 13)                            // a sidebar row
  static let kierRowSelected = Font.system(size: 13, weight: .medium)   // the selected one
  static let kierSmall = Font.system(size: 12)
  static let kierLabel = Font.system(size: 12, weight: .medium)         // a section's name above its rows
  static let kierCount = Font.system(size: 11, weight: .medium).monospacedDigit()
  static let kierMono = Font.system(size: 11, design: .monospaced)      // only for code-like values
  static let kierStat = Font.system(size: 20, weight: .medium).monospacedDigit()
}

// A card: a flat, slightly lighter fill with rounded corners. No rim, no gradient, no shadow.
extension View {
  func surface(radius: CGFloat = 16) -> some View {
    background(RoundedRectangle(cornerRadius: radius, style: .continuous).fill(Color.white.opacity(0.045)))
  }
}

// The top of every page: a plain title and one dim line saying what's here.
struct PageHeader: View {
  let title: String
  var lede: String? = nil

  var body: some View {
    VStack(alignment: .leading, spacing: 3) {
      Text(title).font(.kierTitle).foregroundStyle(Kier.bright)
      if let lede { Text(lede).font(.kierSmall).foregroundStyle(Kier.dim).fixedSize(horizontal: false, vertical: true) }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }
}

// A titled glass card holding rows split by hairlines, like the site's done list and vault card.
struct Panel<Content: View, Accessory: View>: View {
  let title: String
  var count: Int? = nil
  var footer: String? = nil
  @ViewBuilder let accessory: () -> Accessory
  @ViewBuilder let content: () -> Content

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      HStack(alignment: .firstTextBaseline, spacing: 8) {
        Text(title).font(.kierLabel).foregroundStyle(Kier.dim)
        if let count { Text("\(count)").font(.kierSmall.monospacedDigit()).foregroundStyle(Kier.faint) }
        Spacer()
        accessory()
      }
      .padding(.horizontal, 4)
      VStack(alignment: .leading, spacing: 0) {
        _VariadicView.Tree(Hairlines()) { content() }
      }
      .padding(.horizontal, 18).padding(.vertical, 6)
      .surface()
      if let footer { Text(footer).font(.kierSmall).foregroundStyle(Kier.faint).padding(.horizontal, 4).fixedSize(horizontal: false, vertical: true) }
    }
  }
}

extension Panel where Accessory == EmptyView {
  init(title: String, count: Int? = nil, footer: String? = nil, @ViewBuilder content: @escaping () -> Content) {
    self.init(title: title, count: count, footer: footer, accessory: { EmptyView() }, content: content)
  }
}

// Each row of a panel gets a hairline above it, except the first.
struct Hairlines: _VariadicView_MultiViewRoot {
  func body(children: _VariadicView.Children) -> some View {
    ForEach(children) { child in
      if child.id != children.first?.id { Rectangle().fill(Kier.hair).frame(height: 1) }
      child
    }
  }
}

// A front card with the next ones tucked behind it: each a step smaller and fainter, peeking out below, so a stack of
// waiting things reads as a stack (the site's.mini.back).
struct CardStack<Front: View>: View {
  let behind: Int
  @ViewBuilder let front: () -> Front

  var body: some View {
    front()
      .background(RoundedRectangle(cornerRadius: 20, style: .continuous).fill(Kier.raised))
      .background(alignment: .bottom) {
        ZStack(alignment: .bottom) {
          ForEach(Array((0..<min(behind, 2)).reversed()), id: \.self) { i in
            RoundedRectangle(cornerRadius: 20, style: .continuous)
              .fill(Color(white: 0.17 - Double(i) * 0.02))
              .frame(height: 40)
              .padding(.horizontal, CGFloat(i + 1) * 14)
              .offset(y: CGFloat(i + 1) * 10)
          }
        }
      }
      .padding(.bottom, CGFloat(min(behind, 2)) * 10)
  }
}

// Where something came from as the app's own mark, in one colour like the symbols beside it: Simple Icons' brand
// glyphs (simpleicons.org, CC0), plus the official OpenAI app template mark.
// Calls, the calendar and the web keep their symbol when there is no matching brand.
enum Brand {
  static func of(source: String, thread: String?, sender: String?, meta: String? = nil, url: String? = nil) -> String? {
    let t = (thread ?? "").lowercased()
    switch source {
    case "whatsapp", "imessage", "discord", "git": return source
    case "browser": return url.flatMap(URL.init(string:))?.host?.lowercased() == "chatgpt.com" ? "openai" : nil
    case "social": return t.hasPrefix("threads:") ? "threads" : t.hasPrefix("x:") ? "x" : nil
    case "ai":
      let fields = meta.flatMap { $0.data(using: .utf8) }.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
      if let provider = fields?["provider"] as? String {
        if provider == "codex" || provider == "chatgpt" { return "openai" }
        if provider == "claude" { return "claude" }
      }
      let agent = (fields?["agent"] as? String) ?? sender ?? ""
      if agent.range(of: "^(codex|sol|astra|gpt|chatgpt)(\\b|-)", options: [.regularExpression, .caseInsensitive]) != nil { return "openai" }
      return agent.lowercased().hasPrefix("claude") ? "claude" : nil
    // A notification or a chat read off the screen is named after its app: "Discord", "Discord: #general", "Claude".
    case "notifications", "screen", "chat":
      let apps = ["whatsapp": "whatsapp", "discord": "discord", "telegram": "telegram", "signal": "signal", "viber": "viber",
                  "messenger": "messenger", "messages": "imessage", "claude": "claude", "threads": "threads", "gmail": "gmail",
                  "wechat": "wechat", "微信": "wechat", "codex": "openai", "chatgpt": "openai"]
      return apps.first { t.hasPrefix($0.key) }?.value
    default: return nil
    }
  }

  @MainActor private static var images: [String: NSImage] = [:]
  @MainActor static func image(_ slug: String?) -> NSImage? {
    guard let slug else { return nil }
    if let hit = images[slug] { return hit }
    guard let url = Bundle.main.url(forResource: slug, withExtension: "svg", subdirectory: "brands")
      ?? Bundle.main.url(forResource: slug, withExtension: "png", subdirectory: "brands"), let image = NSImage(contentsOf: url) else { return nil }
    image.isTemplate = true
    images[slug] = image
    return image
  }
}

// Logos share a visible height; their natural width stays intact inside each row's icon slot.
struct BrandMark: View {
  let image: NSImage
  let height: CGFloat

  var body: some View {
    Image(nsImage: image)
      .renderingMode(.template)
      .resizable()
      .scaledToFit()
      .frame(width: height * image.size.width / max(image.size.height, 1), height: height)
      .fixedSize()
  }
}

extension Card { var brand: String? { Brand.of(source: source, thread: thread, sender: sender, meta: meta, url: url) } }
extension Item { var brand: String? { Brand.of(source: source, thread: thread, sender: sender, meta: meta, url: url) } }

// The symbol for a kind of card or source, plain, in a fixed width so rows line up; the brand's mark when it has one.
struct IconTile: View {
  let symbol: String
  var brand: String? = nil
  var tint: Color = Kier.dim
  var size: CGFloat = 30

  var body: some View {
    Group {
      if let mark = Brand.image(brand) {
        BrandMark(image: mark, height: size * 0.46)
      } else {
        Image(systemName: symbol).font(.system(size: size * 0.5, weight: .regular))
      }
    }
    .foregroundStyle(tint)
    .frame(width: size, height: size)
  }
}

// A number with its label, as on the site's "On this Mac" card.
struct Stat: View {
  let label: String
  let value: String
  var under: String? = nil
  var ok: Bool? = nil

  var body: some View {
    VStack(alignment: .leading, spacing: 4) {
      Text(label).font(.kierSmall).foregroundStyle(Kier.dim)
      HStack(spacing: 7) {
        if let ok { Circle().fill(ok ? Color.green : Color.orange).frame(width: 7, height: 7) }
        Text(value).font(.kierStat).monospacedDigit().lineLimit(1).minimumScaleFactor(0.6)
      }
      // Always a line here, so tiles side by side are the same height.
      Text(under ?? " ").font(.kierSmall).foregroundStyle(Kier.faint).lineLimit(1)
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .padding(16)
    .surface(radius: 14)
  }
}

// The page's own scroll: content in a readable column, centred, with room around it.
struct PageScroll<Content: View>: View {
  var width: CGFloat = 860
  @ViewBuilder let content: () -> Content

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 28) { content() }
        .frame(maxWidth: width, alignment: .leading)
        .padding(.horizontal, 32).padding(.top, 18).padding(.bottom, 48)
        .frame(maxWidth: .infinity)
    }
    .scrollContentBackground(.hidden)
  }
}

let sourceSymbols = [
  "whatsapp": "message", "imessage": "message.fill", "discord": "bubble.left.and.bubble.right", "mail": "envelope",
  "notifications": "bell", "calls": "phone", "calendar": "calendar", "browser": "globe", "downloads": "arrow.down.circle",
  "clipboard": "doc.on.clipboard", "apps": "macwindow", "screen": "text.viewfinder", "ai": "sparkles", "git": "arrow.triangle.branch",
  "social": "at",
]
func sourceSymbol(_ s: String) -> String { sourceSymbols[s] ?? "circle" }

// The site's buttons: the one thing to do as a white pill, everything else as quiet text.
struct PillButton: ButtonStyle {
  var prominent = false

  func makeBody(configuration: Configuration) -> some View { Pill(configuration: configuration, prominent: prominent) }

  private struct Pill: View {
    let configuration: Configuration
    let prominent: Bool
    @Environment(\.isEnabled) private var enabled

    var body: some View {
      configuration.label
        .font(.system(size: 12, weight: .medium)).lineLimit(1)
        .padding(.horizontal, 12).padding(.vertical, 5)
        .foregroundStyle(prominent ? Color.black : Color.white.opacity(0.85))
        .background(Capsule().fill(prominent ? Color.white.opacity(configuration.isPressed ? 0.72 : 0.92) : Color.white.opacity(configuration.isPressed ? 0.16 : 0.09)))
        .contentShape(Capsule())
        .opacity(enabled ? 1 : 0.45)
    }
  }
}

struct TextButton: ButtonStyle {
  func makeBody(configuration: Configuration) -> some View {
    configuration.label
      .font(.system(size: 12.5, weight: .medium)).lineLimit(1)
      .foregroundStyle(Color.white.opacity(configuration.isPressed ? 0.95 : 0.55))
      .padding(.vertical, 5)
      .contentShape(Rectangle())
  }
}

// "Show" and "Hide" for a panel that starts folded.
struct Fold: View {
  @Binding var open: Bool

  var body: some View {
    Button { withAnimation(.snappy(duration: 0.25)) { open.toggle() } } label: {
      HStack(spacing: 4) {
        Text(open ? "Hide" : "Show")
        Image(systemName: "chevron.down").rotationEffect(.degrees(open ? 180 : 0))
      }
    }
    .buttonStyle(TextButton())
  }
}

// Tiles in columns that each fill on their own, like Pinterest: every tile goes under the shortest column so far, so
// a tall card (WhatsApp with its chats) doesn't leave a hole beside a short one.
struct Masonry: Layout {
  var minWidth: CGFloat = 270
  var spacing: CGFloat = 16

  private func columns(_ width: CGFloat) -> (count: Int, width: CGFloat) {
    let n = max(1, Int((width + spacing) / (minWidth + spacing)))
    return (n, (width - spacing * CGFloat(n - 1)) / CGFloat(n))
  }

  // Each tile's height at the last column width. SwiftUI asks for the size, often more than once, and then places the
  // tiles; without this every ask measured every tile and every chip inside it again.
  struct Cache { var width: CGFloat = -1; var heights: [CGFloat] = [] }
  func makeCache(subviews: Subviews) -> Cache { Cache() }
  func updateCache(_ cache: inout Cache, subviews: Subviews) { cache = Cache() }

  // Where each tile goes: its column and its top, and how tall the tallest column ends up.
  private func arrange(_ width: CGFloat, _ subviews: Subviews, _ cache: inout Cache) -> (spots: [(x: CGFloat, y: CGFloat)], column: CGFloat, height: CGFloat) {
    let (n, w) = columns(width)
    if cache.width != w || cache.heights.count != subviews.count {
      cache.heights = subviews.map { $0.sizeThatFits(ProposedViewSize(width: w, height: nil)).height }
      cache.width = w
    }
    var heights = Array(repeating: CGFloat(0), count: n)
    var spots: [(x: CGFloat, y: CGFloat)] = []
    for tile in cache.heights {
      let c = heights.indices.min { heights[$0] < heights[$1] } ?? 0
      spots.append((CGFloat(c) * (w + spacing), heights[c]))
      heights[c] += tile + spacing
    }
    return (spots, w, max(0, (heights.max() ?? 0) - spacing))
  }

  func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout Cache) -> CGSize {
    let width = proposal.width ?? minWidth * 3 + spacing * 2
    return CGSize(width: width, height: arrange(width, subviews, &cache).height)
  }

  func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout Cache) {
    let (spots, w, _) = arrange(bounds.width, subviews, &cache)
    for (view, spot) in zip(subviews, spots) {
      view.place(at: CGPoint(x: bounds.minX + spot.x, y: bounds.minY + spot.y), proposal: ProposedViewSize(width: w, height: nil))
    }
  }
}

// Show the assistant’s current search or reading step with an icon, a soft highlight and a crossfade.
struct WorkingLine: View {
  let step: String
  var font: Font = .caption
  var tint: Color = .secondary

  private var symbol: String {
    let s = step.lowercased()
    if s.hasPrefix("search") { return "magnifyingglass" }
    if s.hasPrefix("reading") { return "text.bubble" }
    if s.hasPrefix("looking at your day") { return "calendar" }
    if s.hasPrefix("going through") { return "checklist" }
    if s.hasPrefix("thinking") { return "sparkle" }
    return "tray.full"
  }

  var body: some View {
    HStack(spacing: 5) {
      Image(systemName: symbol).symbolEffect(.pulse, options: .repeating)
      Text(step).lineLimit(1).truncationMode(.middle)
    }
    .font(font)
    .foregroundStyle(tint)
    .modifier(Shimmer())
    .id(step)
    .transition(.opacity.combined(with: .offset(y: 3)))
  }
}

// A band of light that passes over its content every couple of seconds, so waiting reads as working.
struct Shimmer: ViewModifier {
  @State private var phase: CGFloat = -0.6

  func body(content: Content) -> some View {
    content
      .mask(
        LinearGradient(stops: [.init(color: .black.opacity(0.45), location: 0), .init(color: .black, location: 0.5), .init(color: .black.opacity(0.45), location: 1)],
                       startPoint: UnitPoint(x: phase - 0.6, y: 0.5), endPoint: UnitPoint(x: phase + 0.6, y: 0.5))
      )
      .onAppear { withAnimation(.linear(duration: 1.8).repeatForever(autoreverses: false)) { phase = 1.6 } }
  }
}

// What Kier offers to change for a chat question: one pill each, the first the main one; clicked, it says it took.
struct ActionButtons: View {
  @Environment(Store.self) var store
  let actions: [ChatAction]

  private func symbol(_ status: String) -> String {
    switch status {
    case "open": "arrow.uturn.backward"
    case "done": "checkmark"
    case "snoozed": "clock"
    default: "xmark"
    }
  }

  var body: some View {
    if !actions.isEmpty {
      HStack(spacing: 8) {
        ForEach(Array(actions.enumerated()), id: \.element.id) { i, a in
          if store.applied.contains(a.id) {
            Label(a.status == "open" ? "Back on your list" : a.status == "done" ? "Marked done" : a.status == "snoozed" ? "Moved to tomorrow" : "Taken off", systemImage: "checkmark")
              .font(.caption.weight(.medium)).foregroundStyle(.secondary)
          } else {
            Button { store.apply(a) } label: { Label(a.label, systemImage: symbol(a.status)) }
              .buttonStyle(PillButton(prominent: i == 0))
              .help(a.summary)
          }
        }
      }
      .animation(.easeOut(duration: 0.2), value: store.applied)
    }
  }
}
