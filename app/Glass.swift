import AppKit
import SwiftUI

// Kier's look: black glass. Whatever is behind the window shows through a heavy blur under a deep black tint, a faint
// sheen catches the top edge, the rim is a white hairline, and nothing inside sits on a grey fill.
enum Glass {
  static let tint = Color.black.opacity(0.78)
  static let hairline = Color.white.opacity(0.11)
  static let rim = Color.white.opacity(0.16)
  static let hover = Color.white.opacity(0.06)
  static let selected = Color.white.opacity(0.08)
}

// The blur of what's behind the window; SwiftUI's own materials only blur what's inside it.
struct BlurBehind: NSViewRepresentable {
  func makeNSView(context: NSViewRepresentableContext<BlurBehind>) -> NSVisualEffectView {
    let v = NSVisualEffectView()
    v.material = .hudWindow
    v.blendingMode = .behindWindow
    v.state = .active
    v.appearance = NSAppearance(named: .darkAqua)
    return v
  }

  func updateNSView(_ nsView: NSVisualEffectView, context: NSViewRepresentableContext<BlurBehind>) {}
}

struct BlackGlass: View {
  var radius: CGFloat = 0

  var body: some View {
    let shape = RoundedRectangle(cornerRadius: radius, style: .continuous)
    ZStack {
      BlurBehind()
      Glass.tint
      LinearGradient(colors: [Color.white.opacity(0.07), .clear], startPoint: .top, endPoint: .center)
    }
    .clipShape(shape)
    .overlay(shape.strokeBorder(Glass.rim, lineWidth: 0.5))
  }
}

extension View {
  // A panel or window body in black glass, always in dark mode so text and controls read on it.
  func blackGlass(radius: CGFloat = 0) -> some View {
    background(BlackGlass(radius: radius)).environment(\.colorScheme, .dark)
  }
}
