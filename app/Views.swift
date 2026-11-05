import SwiftUI

// MARK: Labels shared by every screen

private let dayFormat: DateFormatter = { let f = DateFormatter(); f.locale = Locale(identifier: "en_GB"); f.dateFormat = "EEE d MMM"; return f }()
private let longFormat: DateFormatter = { let f = DateFormatter(); f.locale = Locale(identifier: "en_GB"); f.dateFormat = "EEEE d MMMM"; return f }()
private let clock: DateFormatter = { let f = DateFormatter(); f.dateFormat = "HH:mm"; return f }()

func dayLabel(_ date: Date) -> String {
  let cal = Calendar.current
  if cal.isDateInToday(date) { return "Today" }
  if cal.isDateInTomorrow(date) { return "Tomorrow" }
  if cal.isDateInYesterday(date) { return "Yesterday" }
  return dayFormat.string(from: date)
}
func dayLabel(_ iso: String) -> String { isoDay.date(from: iso).map(dayLabel) ?? iso }
func timeLabel(_ ts: Int) -> String { clock.string(from: Date(timeIntervalSince1970: TimeInterval(ts))) }
func dateLabel(_ ts: Int) -> String { dayFormat.string(from: Date(timeIntervalSince1970: TimeInterval(ts))) }

// How a waiting thing reads in plain words: what it is, then who is waiting and since when.
extension Card {
  // Show the action itself without an introductory ownership phrase.
  var headline: String {
    var s = summary ?? text ?? ""
    if let r = s.range(of: #"^(Claude|Codex|Astra|Sol) asked: "#, options: .regularExpression) { s = String(s[r.upperBound...]) }
    if let r = s.range(of: #"^\w+ (commits to|promises to|will|plans to|agrees to|offers to|is going to) "#, options: .regularExpression) {
      s = String(s[r.upperBound...])
    }
    return s.prefix(1).uppercased() + s.dropFirst()
  }

  // Remove directional isolate marks and render the notification’s sender and channel plainly.
  var who: String {
    let clean = (sender ?? "Someone").replacingOccurrences(of: "\u{2068}", with: "").replacingOccurrences(of: "\u{2069}", with: "")
    guard clean.hasSuffix(")"), let open = clean.range(of: " (#") else { return clean }
    let channel = clean[open.upperBound...].prefix { $0 != "," && $0 != ")" }
    return "\(clean[..<open.lowerBound]) in #\(channel)"
  }

  // Where Reply goes: the chat's own link when there is one, else the app the conversation lives in, if installed.
  var chatURL: URL? { safeLink(url) }
  var app: URL? { open_app.flatMap { NSWorkspace.shared.urlForApplication(withBundleIdentifier: $0) } }
  var canReply: Bool { chatURL != nil || app != nil }
  // "Open chat", or the app's name when only the app can be opened ("Open Spark").
  var openLabel: String {
    if card == "reply" { return "Reply" }
    if card == "stalled" { return "Open PR" }
    if chatURL == nil, let app { return "Open \(FileManager.default.displayName(atPath: app.path).replacingOccurrences(of: ".app", with: ""))" }
    return "Open chat"
  }

  var kicker: String {
    // One of your own reminders ("Your reminders" in Setup): its list, not a chat.
    if source == "reminders" { return needsConfirmation ? suggestionLabel : "Your reminder in \(thread ?? "Reminders")" }
    let when = "\(dateLabel(ts)) \(timeLabel(ts))"
    let who = self.who
    // A reply on Threads or X is filed under its conversation's id ("Threads:4020…"): the site is the place.
    let place = source == "social" ? " on \(thread?.split(separator: ":").first.map(String.init) ?? "the web")"
      : thread.flatMap { $0.isEmpty || $0 == sender ? nil : " in \($0)" } ?? ""
    switch card {
    case "callback":
      let details = meta.flatMap { $0.data(using: .utf8) }.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
      if details?["promiseId"] != nil {
        let at = details?["promiseTs"] as? Int ?? ts
        return "You promised to call \(thread ?? who), \(dateLabel(at)) \(timeLabel(at))"
      }
      let count = details?["count"] as? Int ?? 1
      return "\(count == 1 ? "Missed call" : "\(count) missed calls") from \(thread ?? who), \(when)"
    case "ask": return "\(who) is waiting on your answer, \(when)"
    case "promise": return "You promised\(place), \(when)"
    case "reply": return "\(who) is waiting for your reply\(place), \(when)"
    case "payment": return "\(who) is waiting for payment, \(when)"
    case "appointment": return "Appointment, from \(who)\(place), \(when)"
    case "stalled": return "\(who) left this in “\(thread ?? "a session")”, \(when)"
    default:
      if source == "notifications" { return "\(thread ?? "An app"): \(who), \(when)" }
      return "\(who) asked you\(place), \(when)"
    }
  }
}

// Each kind of task shows the one action that fits it; the local models pick the kind.
struct Kind {
  let label: String
  let symbol: String
  let main: String
  static func of(_ card: String?) -> Kind {
    switch card {
    case "payment": Kind(label: "Payment", symbol: "creditcard", main: "Paid")
    case "appointment": Kind(label: "Appointment", symbol: "calendar", main: "Add to calendar")
    case "reply": Kind(label: "Reply needed", symbol: "arrowshape.turn.up.left", main: "Reply")
    case "promise": Kind(label: "You promised", symbol: "hand.raised", main: "Mark done")
    case "ask": Kind(label: "Waiting on your answer", symbol: "questionmark.bubble", main: "Mark done")
    case "callback": Kind(label: "Call back", symbol: "phone.arrow.up.right", main: "Called")
    case "stalled": Kind(label: "Left unfinished", symbol: "arrow.triangle.pull", main: "Mark done")
    default: Kind(label: "To do", symbol: "checkmark.circle", main: "Mark done")
    }
  }
}

// MARK: Window

struct ContentView: View {
  @Environment(Store.self) var store
  @State private var visited: Set<Page> = []

  var body: some View {
    @Bindable var store = store
    NavigationSplitView {
      Sidebar()
        .navigationSplitViewColumnWidth(min: 200, ideal: 240, max: 320)
    } detail: {
      // Every page you've opened stays built, stacked in one place: switching only cross-fades, softly, like
      // CodeNotch's settings, with nothing rebuilt, and each page keeps where you'd scrolled to.
      ZStack {
        ForEach(Page.allCases) { p in
          if visited.contains(p) || store.page == p {
            page(p)
              .frame(maxWidth: .infinity, maxHeight: .infinity)
              .opacity(store.page == p ? 1 : 0)
              .blur(radius: store.page == p ? 0 : 8)
              .allowsHitTesting(store.page == p)
              .accessibilityHidden(store.page != p)
          }
        }
      }
      .animation(.easeOut(duration: 0.22), value: store.page)
      .onChange(of: store.page, initial: true) { visited.insert(store.page) }
      // A card's side panel, for the brief. Here rather than on the brief itself, so its split view is built once and
      // not again every time you come back to the brief.
      .inspector(isPresented: Binding(get: { store.selected != nil && (store.page == .brief || store.page == .done) }, set: { if !$0 { store.select(nil) } })) {
        ContextView().inspectorColumnWidth(min: 300, ideal: 360, max: 480)
      }
    }
    .task(id: store.page) { await store.refresh() }
    .task { await store.loadConversations() }
    .background(Kier.page.ignoresSafeArea())
    .toolbarBackground(.hidden, for: .windowToolbar)
    .environment(\.colorScheme, .dark)
    // The title, the search and the Timeline's own controls live here, not in the pages: every page stays built, and a
    // hidden page's toolbar would otherwise show on all of them. Search covers everything, so typing opens the Timeline.
    .navigationTitle(title)
    .searchable(text: $store.query, placement: .toolbar, prompt: "Search everything")
    .onChange(of: store.query) {
      store.search(store.query)
      if !store.query.trimmingCharacters(in: .whitespaces).isEmpty && store.page != .timeline { store.page = .timeline }
    }
    // One toolbar for every screen: without it, screens with no buttons of their own redraw the window differently.
    .toolbar {
      if store.page == .timeline {
        ToolbarItemGroup(placement: .navigation) {
          Button { store.shiftDay(-1) } label: { Label("Previous day", systemImage: "chevron.left") }
          Button("Today") { store.goToday() }
          Button { store.shiftDay(1) } label: { Label("Next day", systemImage: "chevron.right") }
        }
        // In the toolbar with the day and search, not in a box of its own under it.
        ToolbarItem(placement: .principal) {
          Picker("Show", selection: $store.filter) { ForEach(filters, id: \.name) { Text($0.name).tag($0.name) } }
            .pickerStyle(.segmented).labelsHidden().fixedSize()
        }
      }
      ToolbarItem(placement: .primaryAction) {
        // Reading the brief aloud is switched off for now ; store.speak() still works.
        Button { store.checkNow() } label: { Label("Check now", systemImage: "arrow.clockwise") }
          .disabled(store.checking).help("Check now: read new messages and see what's been done")
      }
    }
  }

  private var title: String {
    switch store.page {
    case .brief: "Brief"
    case .done: "Done"
    case .chats: store.conversations.first { $0.key == store.chatKey }?.q ?? "New chat"
    case .timeline: "Timeline"
    case .vault: "Vault"
    case .setup: "Setup"
    }
  }

  @ViewBuilder private func page(_ page: Page) -> some View {
    switch page {
    case .brief: BriefView()
    case .done: CompletedView()
    case .chats: ChatsView()
    case .timeline: TimelineView()
    case .vault: VaultView()
    case .setup: SetupView()
    }
  }
}

// Like the ChatGPT app: the pages, then New chat and your recent chats. Drawn by hand rather than with a List, the way
// CodeNotch does its sidebar, so the selection is one pill that slides to the row you pick on a spring, and a row
// answers the moment it's pressed rather than when the click ends.
private struct Sidebar: View {
  @Environment(Store.self) var store
  @Namespace private var pill

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 2) {
        row(.brief, "Brief", "checklist", count: store.waiting)
        row(.done, "Done", "checkmark.circle")
        row(.timeline, "Timeline", "clock")
        row(.vault, "Vault", "archivebox")
        row(.setup, "Setup", "gearshape", count: store.setupLeft)
        Text("Chats")
          .font(.kierLabel)
          .foregroundStyle(Kier.faint)
          .padding(.leading, 10).padding(.top, 18).padding(.bottom, 4)
        SidebarRow(title: "New chat", symbol: "square.and.pencil", selected: chatOpen(nil), pill: pill) { go { store.newChat() } }
        ForEach(store.conversations.prefix(40)) { c in
          SidebarRow(title: c.q ?? "New chat", selected: chatOpen(c.key), pill: pill) { go { store.openChat(c.key) } }
            .contextMenu { Button("Put away") { store.archive(c.key); if store.chatKey == c.key { store.newChat() } } }
        }
      }
      .padding(.horizontal, 10)
      .padding(.vertical, 6)
    }
    .scrollIndicators(.never)
    .background(Kier.sidebar)
    .safeAreaInset(edge: .bottom) {
      if store.offline {
        Label("Kier is restarting", systemImage: "arrow.triangle.2.circlepath").font(.caption).foregroundStyle(.secondary).padding(12)
      }
    }
  }

  private func row(_ page: Page, _ title: String, _ symbol: String, count: Int = 0) -> some View {
    SidebarRow(title: title, symbol: symbol, count: count, selected: store.page == page, pill: pill) { go { store.page = page } }
  }

  // A chat (or New chat, with no key) is selected while it's the one open.
  private func chatOpen(_ key: String?) -> Bool {
    store.page == .chats && (key == nil ? store.chatKey.map { k in !store.conversations.contains { $0.key == k } } ?? true : store.chatKey == key)
  }

  private func go(_ change: () -> Void) { withAnimation(.spring(response: 0.34, dampingFraction: 0.82)) { change() } }
}

private struct SidebarRow: View {
  let title: String
  var symbol: String? = nil
  var count = 0
  let selected: Bool
  let pill: Namespace.ID
  let select: () -> Void
  @State private var hovered = false
  @State private var pressed = false
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  private static let shape = RoundedRectangle(cornerRadius: 8, style: .continuous)

  var body: some View {
    HStack(spacing: 10) {
      if let symbol {
        Image(systemName: symbol)
          .frame(width: 18)
          .foregroundStyle(Color.white.opacity(selected ? 0.95 : hovered ? 0.85 : 0.6))
      }
      Text(title)
        .font(selected ? .kierRowSelected : .kierRow)
        .foregroundStyle(selected ? Kier.bright : hovered ? Color.white.opacity(0.92) : Kier.text)
        .lineLimit(1)
      Spacer(minLength: 4)
      if count > 0 {
        Text("\(count)")
          .font(.kierCount)
          .foregroundStyle(hovered || selected ? Color.white.opacity(0.55) : Kier.faint)
          .contentTransition(.numericText())
      }
    }
    .padding(.horizontal, 10)
    .padding(.vertical, 6)
    .background {
      ZStack {
        if hovered && !selected { Self.shape.fill(Kier.hovered).transition(.opacity) }
        if selected {
          Self.shape.fill(Kier.selected)
            .overlay(Self.shape.strokeBorder(LinearGradient(colors: [.white.opacity(0.10), .white.opacity(0.02)], startPoint: .top, endPoint: .bottom), lineWidth: 0.5))
            .matchedGeometryEffect(id: "selection", in: pill)
        }
      }
    }
    .contentShape(Rectangle())
    .scaleEffect(pressed && !reduceMotion ? 0.97 : 1)
    .animation(.spring(response: 0.22, dampingFraction: 0.6), value: pressed)
    .onHover { h in withAnimation(.easeOut(duration: 0.14)) { hovered = h } }
    // Down is when it reacts; up is when it selects, unless the pointer moved off to drag or scroll.
    .gesture(
      DragGesture(minimumDistance: 0)
        .onChanged { _ in if !pressed { pressed = true } }
        .onEnded { v in
          pressed = false
          if abs(v.translation.width) < 6, abs(v.translation.height) < 6 { select() }
        }
    )
    .accessibilityElement(children: .combine)
    .accessibilityAddTraits(selected ? [.isButton, .isSelected] : .isButton)
    .accessibilityAction { select() }
  }
}

// MARK: Brief

struct BriefView: View {
  @Environment(Store.self) var store
  @State private var showWaiting = false
  @State private var showMaybe = false

  var body: some View {
    Group {
      if let b = store.brief {
        // The most pressing card leads, with the rest of what's waiting tucked behind it.
        let queue = b.forgotten + b.today.tasks + b.open
        let rest = { (cards: [Card]) in cards.filter { $0.id != queue.first?.id } }
        PageScroll {
          PageHeader(title: headline(b, queue.count), lede: "\(longFormat.string(from: Date())). \(lede(b))")
          if let top = queue.first {
            VStack(alignment: .leading, spacing: 10) {
              Text(b.forgotten.first?.id == top.id ? "Maybe forgotten" : "Next up").font(.kierLabel).foregroundStyle(Kier.dim).padding(.horizontal, 4)
              CardStack(behind: queue.count - 1) { CardRow(card: top, hero: true).padding(.horizontal, 22).padding(.vertical, 18) }
            }
          }
          if !b.today.events.isEmpty || !rest(b.today.tasks).isEmpty {
            Panel(title: "Today") {
              ForEach(b.today.events, id: \.key) { EventRow(event: $0) }
              ForEach(rest(b.today.tasks)) { CardRow(card: $0) }
            }
          }
          if !rest(b.forgotten).isEmpty {
            Panel(title: "Maybe forgotten", count: b.forgotten.count + (b.more.forgotten ?? 0)) {
              ForEach(rest(b.forgotten)) { CardRow(card: $0) }
              if let n = b.more.forgotten, n > 0 { more(n) }
            }
          }
          if !rest(b.open).isEmpty {
            Panel(title: "Still open", count: b.open.count + (b.more.open ?? 0)) {
              ForEach(rest(b.open)) { CardRow(card: $0) }
              if let n = b.more.open, n > 0 { more(n) }
            }
          }
          if !b.soon.events.isEmpty || !b.soon.tasks.isEmpty {
            Panel(title: "Coming up") {
              ForEach(b.soon.events, id: \.key) { EventRow(event: $0, withDay: true) }
              ForEach(b.soon.tasks) { CardRow(card: $0) }
            }
          }
          // Closed by a reply, a call or a commit: one click puts a wrong guess back.
          if let done = b.done, !done.isEmpty {
            Panel(title: "Done by Kier", count: done.count, footer: "Closed by what happened after: a reply, a payment, a call, a merged fix. Put back anything Kier got wrong.") {
              ForEach(done) { DoneLine(card: $0) }
              Button("View more") { store.page = .done }.buttonStyle(TextButton()).padding(.vertical, 12)
            }
          }
          // What you asked others for: quiet, folded away, gone after a week or once they deliver.
          if let waiting = b.waiting, !waiting.isEmpty {
            Panel(title: "Waiting on others", count: waiting.count, accessory: { Fold(open: $showWaiting) }) {
              if showWaiting { ForEach(waiting) { WaitingRow(item: $0) } } else { note("What you asked others for. It lets go after a week, or once they deliver.") }
            }
          }
          // Tasks the second opinion doubts: out of the way, one click to see.
          if !b.maybe.isEmpty {
            Panel(title: "Maybe yours", count: b.maybe.count + (b.more.maybe ?? 0), accessory: { Fold(open: $showMaybe) }) {
              if showMaybe { ForEach(b.maybe) { CardRow(card: $0) } } else { note("Things the second opinion doubts are yours. Tick any that are, and Kier learns.") }
            }
          }
        }
      } else {
        ProgressView()
      }
    }
  }

  private func headline(_ b: Brief, _ shown: Int) -> String {
    let n = shown + (b.more.forgotten ?? 0) + (b.more.open ?? 0)
    return n == 0 ? "Nothing waiting on you" : n == 1 ? "One thing waits on you" : "\(n) things wait on you"
  }

  // One calm line: what's on today, what may have slipped, and what Kier already ticked off.
  private func lede(_ b: Brief) -> String {
    var parts: [String] = []
    let events = b.today.events.count
    if events > 0 { parts.append(events == 1 ? "One thing on your calendar today" : "\(events) things on your calendar today") }
    if !b.forgotten.isEmpty { parts.append("\(b.forgotten.count) may have slipped") }
    if let done = b.done, !done.isEmpty { parts.append("Kier ticked off \(done.count) for you") }
    if parts.isEmpty { return "Kier keeps watch and taps the orb when something needs you." }
    let line = parts.joined(separator: ", ")
    return line.prefix(1).uppercased() + line.dropFirst() + "."
  }

  private func more(_ n: Int) -> some View {
    Text("and \(n) more").font(.kierSmall).foregroundStyle(Kier.faint).padding(.vertical, 12)
  }

  private func note(_ text: String) -> some View {
    Text(text).font(.kierSmall).foregroundStyle(Kier.faint).padding(.vertical, 12)
  }
}

// Completed history belongs in the main window; the island keeps just a small preview.
struct CompletedView: View {
  @Environment(Store.self) var store

  var body: some View {
    Group {
      if let cards = store.completed {
        PageScroll {
          PageHeader(title: "Done", lede: "Completed in the past year, newest first. Put back anything that needs another look.")
          if cards.isEmpty {
            Text("Nothing completed yet.").font(.kierBody).foregroundStyle(Kier.dim)
          } else {
            Panel(title: "Completed", count: store.completedTotal) {
              ForEach(cards) { card in DoneLine(card: card, showSource: true) }
            }
            if store.completedNext != nil {
              Button(store.loadingCompleted ? "Loading…" : "Load more") {
                Task { await store.loadCompleted(reset: false) }
              }
              .buttonStyle(PillButton()).disabled(store.loadingCompleted)
            }
          }
        }
      } else {
        ProgressView()
      }
    }
  }
}

struct EventRow: View {
  let event: Event
  var withDay = false

  var body: some View {
    HStack(alignment: .center, spacing: 14) {
      IconTile(symbol: "calendar")
      VStack(alignment: .leading, spacing: 2) {
        Text(event.text).font(.kierCardTitle)
        Text((withDay ? dayLabel(event.day) + ", " : "") + (event.allDay == true ? "all day" : timeLabel(event.ts)))
          .font(.kierSmall).foregroundStyle(Kier.faint)
      }
      Spacer(minLength: 0)
    }
    .padding(.vertical, 12)
  }
}

// One thing Kier closed: a ring with a dot, the task struck through, and how it knew.
struct DoneLine: View {
  @Environment(Store.self) var store
  let card: Card
  var showSource = false

  var body: some View {
    HStack(alignment: .center, spacing: 14) {
      Circle().strokeBorder(Kier.peri.opacity(0.8), lineWidth: 1.5)
        .overlay(Circle().fill(Kier.peri).padding(4.5))
        .frame(width: 16, height: 16)
        .frame(width: 30)
      VStack(alignment: .leading, spacing: 2) {
        Text(card.headline).font(.system(size: 14.5)).strikethrough(color: Kier.faint).foregroundStyle(Kier.dim).lineLimit(showSource ? 2 : 1)
        if showSource {
          Text("\(dateLabel(card.done_at ?? card.ts)) · \(card.state == "done" ? "You marked it done" : howDone(card.reason) ?? "Done")")
            .font(.kierSmall).foregroundStyle(Kier.faint).lineLimit(1)
          Text(card.kicker).font(.kierSmall).foregroundStyle(Kier.faint).lineLimit(1)
        } else if let how = howDone(card.reason) { Text(how).font(.kierSmall).foregroundStyle(Kier.faint).lineLimit(1) }
      }
      Spacer(minLength: 12)
      Button("Put back") { store.mark(card, "open") }.buttonStyle(TextButton()).help("Not done: put the card back")
    }
    .padding(.vertical, 11)
    .contentShape(Rectangle())
    .onTapGesture { store.select(store.selected?.id == card.id ? nil : card) }
  }
}

struct CardRow: View {
  @Environment(Store.self) var store
  let card: Card
  // The lead card at the top of the brief: a bigger headline, its buttons always underneath.
  var hero = false
  @State private var added = false

  var body: some View {
    let kind = Kind.of(card.card)
    Group {
      if hero {
        HStack(alignment: .top, spacing: 16) {
          IconTile(symbol: kind.symbol, brand: card.brand, size: 34)
          VStack(alignment: .leading, spacing: 14) {
            details(kind)
            actions(kind)
          }
          Spacer(minLength: 0)
        }
      } else {
        // Buttons sit beside the card when there's room, and drop below it when the inspector makes the list narrow. The
        // text wraps beside them rather than deciding, so every row in the list puts them in the same place.
        ViewThatFits(in: .horizontal) {
          HStack(alignment: .top, spacing: 14) {
            IconTile(symbol: kind.symbol, brand: card.brand)
            details(kind).frame(minWidth: 300, idealWidth: 300, maxWidth: .infinity, alignment: .leading)
            Spacer(minLength: 16)
            actions(kind)
          }
          HStack(alignment: .top, spacing: 14) {
            IconTile(symbol: kind.symbol, brand: card.brand)
            VStack(alignment: .leading, spacing: 10) {
              details(kind)
              actions(kind)
            }
            Spacer(minLength: 0)
          }
        }
        .padding(.vertical, 13)
      }
    }
    .background(alignment: .center) {
      if store.selected?.id == card.id && !hero { RoundedRectangle(cornerRadius: 12, style: .continuous).fill(Glass.selected).padding(.horizontal, -10) }
    }
    .contentShape(Rectangle())
    .onTapGesture { store.select(store.selected?.id == card.id ? nil : card) }
    .contextMenu {
      Button("Show the chat") { store.select(card) }
      Divider()
      Button { store.mark(card, "done") } label: { Label("Mark done", systemImage: "checkmark") }
      Button("Tomorrow") { store.mark(card, "snoozed") }
      if card.maybe?.on == true { Button("Mine") { store.mark(card, "mine") } }
      Button("Not mine") { store.mark(card, "dismissed") }
    }
  }

  private func details(_ kind: Kind) -> some View {
    VStack(alignment: .leading, spacing: hero ? 6 : 3) {
      Text((card.needsConfirmation ? card.suggestionLabel : kind.label) + (card.due.flatMap { $0.isEmpty ? nil : ", " + dayLabel($0) } ?? ""))
        .font(.kierSmall).foregroundStyle(Kier.faint)
      HStack(alignment: .firstTextBaseline, spacing: 8) {
        Text(card.headline).font(hero ? .kierHeadline : .kierCardTitle).fixedSize(horizontal: false, vertical: true)
        if let amount = card.amount { Text(amount).font(hero ? .kierHeadline : .kierCardTitle).foregroundStyle(Kier.lavender) }
      }
      // Where it came from, so a surprising card can be checked at a glance.
      if card.card != "ask", let said = card.text, said != card.summary {
        Text("“\(said.replacingOccurrences(of: "\n", with: " / "))”").font(.system(size: hero ? 14.5 : 13)).foregroundStyle(Kier.dim).lineLimit(hero ? 3 : 2)
      }
      Text(origin).font(.kierSmall).foregroundStyle(Kier.faint)
      if card.state == "handled" || card.needsConfirmation, let reason = card.reason {
        Label(reason, systemImage: "checkmark.seal").font(.kierSmall).foregroundStyle(.green).lineLimit(2)
      } else if let hint = card.hint {
        // A commit made right after the promise that may be the fix: one click confirms it.
        HStack(alignment: .firstTextBaseline, spacing: 8) {
          Label("Maybe done by: \(hint)", systemImage: "arrow.triangle.branch").font(.kierSmall).foregroundStyle(.teal).lineLimit(2)
          if let link = safeLink(card.hint_url) { Link("Open", destination: link).font(.kierSmall) }
          Button("Yes, done") { store.mark(card, "done") }.buttonStyle(TextButton())
        }
      }
    }
  }

  @ViewBuilder private func actions(_ kind: Kind) -> some View {
    HStack(spacing: 14) {
      if card.needsConfirmation {
        Button("Confirm") { store.mark(card, card.confirmStatus) }.buttonStyle(PillButton(prominent: true))
        Button(card.looksUnneeded ? "Keep" : "Not done") { store.mark(card, "open") }.buttonStyle(TextButton())
      } else if card.state == "handled" {
        Button("Not done") { store.mark(card, "open") }.buttonStyle(PillButton(prominent: true))
        Button { store.mark(card, "done") } label: { Label("Mark done", systemImage: "checkmark") }.buttonStyle(TextButton())
      } else {
        main(kind)
        if kind.main != "Mark done" && kind.main != "Paid" { Button { store.mark(card, "done") } label: { Label("Mark done", systemImage: "checkmark") }.buttonStyle(TextButton()) }
        if card.card != "appointment" { Button("Tomorrow") { store.mark(card, "snoozed") }.buttonStyle(TextButton()) }
        if card.maybe?.on == true { Button("Mine") { store.mark(card, "mine") }.buttonStyle(TextButton()) }
        if card.card != "promise" && card.card != "stalled" { Button("Not mine") { store.mark(card, "dismissed") }.buttonStyle(TextButton()) }
      }
    }
    .fixedSize()
  }

  // Group messages include the person, group, source and time; direct chats need only the person.
  private var origin: String {
    let who = card.mine ? "you" : card.sender ?? ""
    let place = card.thread.flatMap { $0.isEmpty || $0 == card.sender ? nil : $0 }
    return [place.map { "\(who) in \($0)" } ?? who, sourceName(card.source), "\(dateLabel(card.ts)) \(timeLabel(card.ts))"].joined(separator: ", ")
  }

  @ViewBuilder private func main(_ kind: Kind) -> some View {
    switch card.card {
    case "appointment":
      Button(added ? "Added" : kind.main) { store.addToCalendar(card); added = true }.buttonStyle(PillButton(prominent: true)).disabled(added)
    case "reply":
      if card.canReply { Button(kind.main) { store.reply(card) }.buttonStyle(PillButton(prominent: true)) }
    default:
      Button { store.mark(card, "done") } label: {
        if kind.main == "Mark done" { Label(kind.main, systemImage: "checkmark") } else { Text(kind.main) }
      }.buttonStyle(PillButton(prominent: true))
    }
  }
}

struct WaitingRow: View {
  @Environment(Store.self) var store
  let item: Waiting

  var body: some View {
    HStack(alignment: .top, spacing: 14) {
      IconTile(symbol: "hourglass")
      VStack(alignment: .leading, spacing: 3) {
        Text("\(item.who): \(item.what)").font(.kierCardTitle)
        if let said = item.text {
          Text("“\(said.replacingOccurrences(of: "\n", with: " / "))”").font(.system(size: 13)).foregroundStyle(Kier.dim).lineLimit(2)
        }
        Text("you asked in \(item.thread ?? sourceName(item.source)), \(dateLabel(item.ts)) \(timeLabel(item.ts))").font(.kierSmall).foregroundStyle(Kier.faint)
      }
      Spacer(minLength: 12)
      HStack(spacing: 14) {
        if let url = safeLink(item.url) { Button("Ping") { LinkPolicy.open(url) }.buttonStyle(PillButton(prominent: true)) }
        Button("Got it") { store.mark(id: item.id, "done") }.buttonStyle(TextButton())
        Button("Drop") { store.mark(id: item.id, "dismissed") }.buttonStyle(TextButton())
      }
      .fixedSize()
    }
    .padding(.vertical, 13)
  }
}

// MARK: Chats

// A chat with Kier, laid out like the ChatGPT app: an empty chat is one question in the middle with the box under it
// and a few starters; a running one is a readable column with your messages in soft bubbles and the answers as plain
// text, and the box pinned at the bottom.
private let starters = ["What's waiting on me today?", "What did I promise people this week?", "What's still open with my team?", "What did I miss yesterday?"]

struct ChatsView: View {
  @Environment(Store.self) var store
  @AppStorage("kierAgent") private var agent = "claude"

  var body: some View {
    let key = store.chatKey ?? ""
    let empty = (store.chats[key] ?? []).isEmpty && !store.asking.contains(key)
    VStack(spacing: 0) {
      if empty {
        Spacer()
        VStack(spacing: 24) {
          Text("What do you want to know?").font(.system(size: 28, weight: .medium))
          Composer(agent: $agent) { send($0, key) }
          Flow(spacing: 8) {
            ForEach(starters, id: \.self) { q in
              Button(q) { send(q, key) }.buttonStyle(PillButton())
            }
          }
        }
        .frame(maxWidth: 720)
        .padding(.horizontal, 32)
        Spacer()
        Spacer()
      } else {
        ScrollViewReader { scroll in
          ScrollView {
            ChatMessages(key: key).frame(maxWidth: 720).padding(.horizontal, 32).padding(.vertical, 28).frame(maxWidth: .infinity)
          }
          .onChange(of: store.chats[key]?.count ?? 0) { withAnimation { scroll.scrollTo("end", anchor: .bottom) } }
          .onChange(of: store.asking.contains(key)) { withAnimation { scroll.scrollTo("end", anchor: .bottom) } }
          .onChange(of: store.partial[key]?.count ?? 0) { scroll.scrollTo("end", anchor: .bottom) }
          .onAppear { scroll.scrollTo("end", anchor: .bottom) }
        }
        Composer(agent: $agent) { send($0, key) }.frame(maxWidth: 720).padding(.horizontal, 32)
      }
      Text("Claude and Codex read your vault through Kier. Kier on this Mac answers from today's brief.")
        .font(.kierSmall).foregroundStyle(Kier.faint).padding(.top, 10).padding(.bottom, 14)
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .onAppear { if store.chatKey == nil { store.chatKey = store.newChatKey() } }
    .task(id: key) { if !key.isEmpty { await store.loadChat(key) } }
    // A new chat shows up in the sidebar once its first answer is in.
    .onChange(of: store.asking.contains(key)) { if !store.asking.contains(key) { Task { await store.loadConversations() } } }
  }

  private func send(_ q: String, _ key: String) {
    let k = key.isEmpty ? store.newChatKey() : key
    store.chatKey = k
    store.ask(q, agent: agent, key: k)
  }
}

// The messages of one chat: yours on the right in a soft bubble, the answers as plain text, then what's on its way.
struct ChatMessages: View {
  @Environment(Store.self) var store
  let key: String
  var compact = false

  var body: some View {
    VStack(alignment: .leading, spacing: compact ? 18 : 28) {
      ForEach(store.chats[key] ?? []) { turn in
        mine(turn.q)
        answer(turn.a, from: turn.from, note: turn.note, actions: turn.actions)
      }
      if store.asking.contains(key) {
        if let q = store.pending[key] { mine(q) }
        if let text = store.partial[key], !text.isEmpty {
          answer(text, from: nil, note: nil)
        } else {
          HStack(spacing: 10) {
            TypingDots()
            if let step = store.step[key] { WorkingLine(step: step, font: .kierSmall, tint: Kier.faint) }
          }
          .animation(.easeOut(duration: 0.25), value: store.step[key])
        }
      }
      Color.clear.frame(height: 1).id("end")
    }
  }

  private var size: CGFloat { compact ? 13.5 : 15 }

  private func mine(_ q: String) -> some View {
    HStack {
      Spacer(minLength: compact ? 30 : 90)
      Text(q).font(.system(size: size)).textSelection(.enabled)
        .padding(.horizontal, 16).padding(.vertical, 10)
        .background(RoundedRectangle(cornerRadius: 20, style: .continuous).fill(Kier.raised))
    }
  }

  private func answer(_ text: String, from: String?, note: String?, actions: [ChatAction] = []) -> some View {
    VStack(alignment: .leading, spacing: 8) {
      Text(markdown(text)).font(.system(size: size)).lineSpacing(compact ? 3 : 5).textSelection(.enabled)
        .frame(maxWidth: .infinity, alignment: .leading)
      ActionButtons(actions: actions)
      if let from {
        HStack(spacing: 12) {
          Button { store.copy(text) } label: { Image(systemName: "doc.on.doc") }.buttonStyle(.borderless).help("Copy")
          Text(from).font(.kierSmall)
        }
        .foregroundStyle(Kier.faint)
      }
      if let note {
        Label("Kier will remember: \(note)", systemImage: "person.text.rectangle").font(.kierSmall).foregroundStyle(.teal)
          .help("Saved to Who you are on the Setup page, where you can change it")
      }
    }
  }
}

// The message box: a big rounded box with the question on top and, inside it, who answers and a round send button.
struct Composer: View {
  @Binding var agent: String
  var placeholder = "Ask anything"
  let send: (String) -> Void
  @State private var text = ""
  @FocusState private var focused: Bool

  private var ready: Bool { !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      TextField(placeholder, text: $text, axis: .vertical)
        .textFieldStyle(.plain).font(.system(size: 15)).lineLimit(1...8)
        .focused($focused).onSubmit(submit)
      HStack(spacing: 8) {
        Menu {
          Button("Claude") { agent = "claude" }
          Button("Codex unavailable: access cannot be limited to Kier") {}.disabled(true)
          Button("Kier, on this Mac") { agent = "kier" }
        } label: {
          Text(["claude": "Claude", "codex": "Codex"][agent] ?? "Kier").font(.system(size: 12.5, weight: .medium))
        }
        .onAppear { if agent == "codex" { agent = "claude" } }
        .menuStyle(.borderlessButton).fixedSize()
        .padding(.horizontal, 10).padding(.vertical, 4)
        .background(Capsule().fill(Color.white.opacity(0.07)))
        Spacer()
        Button(action: submit) {
          Image(systemName: "arrow.up").font(.system(size: 14, weight: .bold)).foregroundStyle(Color.black)
            .frame(width: 32, height: 32).background(Circle().fill(Color.white.opacity(ready ? 0.95 : 0.28)))
        }
        .buttonStyle(.plain).disabled(!ready).help("Send")
      }
    }
    .padding(.horizontal, 18).padding(.top, 14).padding(.bottom, 12)
    .background(RoundedRectangle(cornerRadius: 26, style: .continuous).fill(Kier.raised))
    .contentShape(Rectangle())
    .onTapGesture { focused = true }
    .task { try? await Task.sleep(for: .milliseconds(250)); focused = true }
  }

  private func submit() {
    let q = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !q.isEmpty else { return }
    text = ""
    send(q)
  }
}

// MARK: The chat around a card

struct ContextView: View {
  @Environment(Store.self) var store
  @AppStorage("kierAgent") private var agent = "claude"

  var body: some View {
    VStack(spacing: 0) {
      ScrollViewReader { scroll in
        ScrollView {
          content
          // Ask about this card right here, as in the orb's panel.
          if let id = store.selected?.id {
            ChatMessages(key: id, compact: true).padding(.horizontal, 16).padding(.bottom, 12)
          }
        }
        .onChange(of: store.chats[store.selected?.id ?? ""]?.count ?? 0) { withAnimation { scroll.scrollTo("end", anchor: .bottom) } }
        .onChange(of: store.partial[store.selected?.id ?? ""]?.count ?? 0) { scroll.scrollTo("end", anchor: .bottom) }
      }
      if let id = store.selected?.id {
        Composer(agent: $agent, placeholder: "Ask about this…") { q in store.ask(q, agent: agent, key: id, item: id) }.padding(12)
      }
    }
    .task(id: store.selected?.id) {
      if let id = store.selected?.id {
        await store.loadChat(id)
        if store.selected?.source == "ai" { await store.loadHandoff(id) }
      }
    }
    // Use the window’s opaque black so wallpaper cannot tint the inspector; separate it with a hairline.
    .background(Kier.page.ignoresSafeArea())
    .overlay(alignment: .leading) { Rectangle().fill(Glass.hairline).frame(width: 0.5).ignoresSafeArea() }
  }

  @ViewBuilder private var content: some View {
    Group {
      if let c = store.context {
        VStack(alignment: .leading, spacing: 16) {
          VStack(alignment: .leading, spacing: 2) {
            Text(c.item.conversationLabel).font(.headline)
            Text("\(c.item.originLabel), \(dateLabel(c.item.ts)) \(timeLabel(c.item.ts))").font(.caption).foregroundStyle(.secondary)
          }
          if c.item.source == "ai" { SessionOpenButton(id: c.item.id) }
          if let tag = c.tag { why(tag) }
          if c.messages.isEmpty, let text = c.item.text {
            Text(text).textSelection(.enabled)
          } else {
            VStack(spacing: 8) { ForEach(c.messages) { Bubble(message: $0) } }
          }
          if !c.since.isEmpty {
            VStack(alignment: .leading, spacing: 6) {
              Text("Since then").font(.caption.weight(.medium)).foregroundStyle(.secondary)
              ForEach(c.since) { s in
                if let link = s.url.flatMap(URL.init(string:)) {
                  Link(destination: link) { Text(s.line).font(.callout).multilineTextAlignment(.leading) }
                } else {
                  Text(s.line).font(.callout)
                }
              }
            }
          }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
      } else {
        ProgressView().padding(40)
      }
    }
  }

  // Why the card exists: what the models decided, in words.
  @ViewBuilder private func why(_ tag: Context.Tag) -> some View {
    VStack(alignment: .leading, spacing: 4) {
      if let p = tag.second, tag.card != "ask" {
        Label("The second opinion is \(Int((p * 100).rounded()))% sure this is yours", systemImage: "scalemass").font(.caption)
      }
      if let w = tag.when_words, !w.isEmpty { Label("Due from \"\(w)\"", systemImage: "calendar").font(.caption) }
      if let r = tag.reason { Label(r, systemImage: "checkmark.seal").font(.caption).foregroundStyle(.green) }
    }
    .foregroundStyle(.secondary)
  }
}

// Session cards can be reopened from the main window as well as the island.
struct SessionOpenButton: View {
  @Environment(Store.self) var store
  let id: String
  @State private var why: String?

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      if let session = store.handoffs[id]?.session, session.opensIn != nil {
        Button(why ?? "Open in \(session.product)") {
          store.openSession(id, session) { error in why = error }
        }
        .buttonStyle(PillButton())
        .help(session.opensIn == "app" ? "Open this conversation in \(session.product)" : "Resume this session in Terminal")
      }
    }
    .task(id: id) { why = nil; await store.loadHandoff(id) }
  }
}

struct Bubble: View {
  let message: Context.Message

  var body: some View {
    HStack {
      if message.from_me { Spacer(minLength: 40) }
      VStack(alignment: message.from_me ? .trailing : .leading, spacing: 2) {
        if !message.from_me { Text(message.sender ?? "").font(.caption2.weight(.medium)).foregroundStyle(.secondary) }
        Text(markdown(message.text ?? ""))
          .textSelection(.enabled)
          .padding(.horizontal, 10).padding(.vertical, 6)
          .background(RoundedRectangle(cornerRadius: 12).fill(message.from_me ? Color.accentColor.opacity(0.22) : Color.secondary.opacity(0.14)))
          .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(message.picked ? Color.orange : .clear, lineWidth: 1.5))
        Text(timeLabel(message.ts)).font(.caption2).foregroundStyle(.tertiary)
      }
      if !message.from_me { Spacer(minLength: 40) }
    }
  }
}

// MARK: Timeline

let filters: [(name: String, sources: [String]?)] = [
  ("All", nil), ("Messages", ["whatsapp", "imessage", "mail", "discord", "social", "notifications", "screen", "ai"]), ("Calls", ["calls"]),
  ("Calendar", ["calendar"]), ("Web", ["browser", "apps"]), ("Files", ["downloads", "clipboard"]),
]

struct TimelineView: View {
  @Environment(Store.self) var store
  @State private var open: Set<String> = []

  private var shown: [Item] {
    let list = store.results ?? store.items
    guard let sources = filters.first(where: { $0.name == store.filter })?.sources else { return list }
    return list.filter { sources.contains($0.source) }
  }

  // Newest first, one glass card per hour (per day and hour for search results).
  private var hours: [(key: String, items: [Item])] {
    var order: [String] = []
    var groups: [String: [Item]] = [:]
    for i in shown {
      let k = (store.results != nil ? dateLabel(i.ts) + ", " : "") + String(timeLabel(i.ts).prefix(2)) + ":00"
      if groups[k] == nil { order.append(k) }
      groups[k, default: []].append(i)
    }
    return order.map { ($0, groups[$0] ?? []) }
  }

  private var rows: [(hour: String, item: Item, first: Bool, last: Bool)] {
    hours.flatMap { h in h.items.enumerated().map { (h.key, $0.element, $0.offset == 0, $0.offset == h.items.count - 1) } }
  }

  // "214 messages, 3 calls and 41 pages": the day at a glance.
  private var summary: String? {
    guard store.results == nil, !store.items.isEmpty else { return nil }
    let count = { (name: String) in store.items.filter { filters.first { $0.name == name }?.sources?.contains($0.source) == true }.count }
    let parts = [(count("Messages"), "message"), (count("Calls"), "call"), (count("Calendar"), "event"), (count("Web"), "page"), (count("Files"), "file")]
      .filter { $0.0 > 0 }.map { "\($0.0.formatted()) \($0.1)\($0.0 == 1 ? "" : "s")" }
    guard let last = parts.last else { return nil }
    return parts.count == 1 ? last : parts.dropLast().joined(separator: ", ") + " and " + last
  }

  var body: some View {
    let search = store.results != nil
    ScrollView {
      LazyVStack(alignment: .leading, spacing: 0) {
        PageHeader(title: search ? (shown.isEmpty ? "Nothing found" : "\(shown.count.formatted()) found") : dayLabel(store.day),
                   lede: search ? nil : (summary ?? "Nothing from this day."))
          .padding(.bottom, 10)
        // One lazy row per item rather than one card per hour: a busy hour used to build every one of its rows before
        // the page could show. Each row draws its slice of the hour's card, rounded at the hour's first and last row.
        ForEach(rows, id: \.item.id) { r in
          HStack(alignment: .top, spacing: 14) {
            Text(r.first ? r.hour : "").font(.kierSmall.monospacedDigit()).foregroundStyle(Kier.faint)
              .frame(width: search ? 116 : 44, alignment: .trailing).padding(.top, 17)
            VStack(spacing: 0) {
              if !r.first { Rectangle().fill(Kier.hair).frame(height: 1) }
              ItemRow(item: r.item, withDay: false, open: open.contains(r.item.id))
                .contentShape(Rectangle())
                .onTapGesture { if open.remove(r.item.id) == nil { open.insert(r.item.id) } }
            }
            .padding(.horizontal, 16)
            .background(
              UnevenRoundedRectangle(topLeadingRadius: r.first ? 14 : 0, bottomLeadingRadius: r.last ? 14 : 0,
                                     bottomTrailingRadius: r.last ? 14 : 0, topTrailingRadius: r.first ? 14 : 0, style: .continuous)
                .fill(Color.white.opacity(0.045)))
          }
          .padding(.top, r.first ? 14 : 0)
        }
      }
      .frame(maxWidth: 900, alignment: .leading)
      .padding(.horizontal, 32).padding(.top, 18).padding(.bottom, 48)
      .frame(maxWidth: .infinity)
    }
    .scrollContentBackground(.hidden)
  }
}

struct ItemRow: View {
  @Environment(Store.self) var store
  let item: Item
  let withDay: Bool
  let open: Bool
  @State private var confirm = false

  var body: some View {
    let who = item.from_me?.on == true ? "You" : item.sender ?? ""
    let task = item.is_task?.on == true
    HStack(alignment: .top, spacing: 12) {
      IconTile(symbol: sourceSymbol(item.source), brand: item.brand, tint: task ? Kier.periLight : Kier.dim, size: 26).padding(.top, 1)
      VStack(alignment: .leading, spacing: 3) {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
          Text(item.conversationLabel).font(.system(size: 13, weight: .medium))
          if !who.isEmpty && who != item.thread { Text(who).font(.system(size: 13)).foregroundStyle(Kier.dim) }
          Text(item.originLabel).font(.system(size: 12)).foregroundStyle(Kier.faint)
          if task { Text("Task").font(.system(size: 11.5, weight: .medium)).foregroundStyle(Kier.periLight) }
          Spacer(minLength: 8)
          Text((withDay ? dateLabel(item.ts) + " " : "") + timeLabel(item.ts)).font(.kierSmall.monospacedDigit()).foregroundStyle(Kier.faint)
        }
        .lineLimit(1)
        Text(item.text ?? "").font(.kierBody).foregroundStyle(Color.white.opacity(0.86)).lineLimit(open ? nil : 3)
          .fixedSize(horizontal: false, vertical: true)
      }
    }
    .padding(.vertical, 11)
    .contextMenu {
      if let s = item.url, s.hasPrefix("http"), let url = URL(string: s) { Button("Open") { LinkPolicy.open(url) } }
      Button("Copy") {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(item.text ?? "", forType: .string)
      }
      Divider()
      Button("Forget", role: .destructive) { confirm = true }
    }
    .confirmationDialog("Forget this? It is deleted now.", isPresented: $confirm) {
      Button("Forget", role: .destructive) { store.forget(item: item.id) }
    }
  }
}

// MARK: Vault

// Describe each source in plain language. What it never keeps is listed once, under "Never kept".
private let keeps = [
  "whatsapp": "Every message, read from WhatsApp on this Mac.", "imessage": "Every message, read from Messages on this Mac.",
  "calls": "Who called whom and for how long. Never what was said.", "calendar": "Events from every calendar this Mac syncs.",
  "notifications": "What apps show in Notification Center, before you dismiss it.", "browser": "Pages you open and what you search for.",
  "downloads": "File names and sizes. Never what is inside.", "clipboard": "What you copy.", "apps": "Which app you use, and for how long.",
  "screen": "Conversation text in chat apps while they are in front.", "mail": "Email.",
  "ai": "Questions Claude or Codex asked you that are still unanswered, and what each session was about. Never the chat itself.",
  "git": "Your commits in every repository on this Mac: the message and a link, never the code.",
  "discord": "Conversations read from Discord's window while it's in front. Never what you're typing.",
  "social": "Your replies on Threads and X and the posts they answer, from the Kier extension in your browser. It never posts, likes or marks anything seen.",
]

struct Forgettable: Identifiable {
  let id = UUID()
  let title: String
  let run: () -> Void
}

struct VaultView: View {
  @Environment(Store.self) var store
  @State private var query = ""
  @State private var found: [Item] = []
  @State private var pending: Forgettable?

  var body: some View {
    Group {
      if let v = store.vault {
        PageScroll(width: 960) {
          PageHeader(title: "\(v.sources.reduce(0) { $0 + $1.n }.formatted()) memories", lede: lede(v))
          Masonry {
            ForEach(v.sources) { source($0, v) }
          }
          Panel(title: "Never kept") {
            never("key", "Passwords, codes and card numbers, and anything a password manager copies")
            never("building.columns", "Banking, password and health apps, not even their notifications")
            never("eye.slash", "Adult sites, searches, downloads and copies")
            never("hand.raised", "Private and incognito windows")
            never("keyboard", "What you type in text fields. Kier never logs keystrokes.")
            never("trash", v.forgotten > 0 ? "\(v.forgotten) things you forgot here, kept only as a fingerprint Kier can't read back" : "Things you forget here")
          }
          Panel(title: "Forget one thing") {
            HStack(spacing: 10) {
              Image(systemName: "magnifyingglass").foregroundStyle(Kier.faint)
              TextField("Find a message, page, copy or file", text: $query).textFieldStyle(.plain).font(.kierBody)
                .onChange(of: query) { Task { found = await store.find(query) } }
            }
            .padding(.vertical, 13)
            ForEach(found.prefix(40)) { i in
              HStack(alignment: .center, spacing: 12) {
                IconTile(symbol: sourceSymbol(i.source), brand: i.brand, size: 26)
                VStack(alignment: .leading, spacing: 2) {
                  Text(i.text ?? "").font(.kierBody).lineLimit(1)
                  Text("\(dateLabel(i.ts)), \(i.conversationLabel), \(i.originLabel)").font(.kierSmall).foregroundStyle(Kier.faint)
                }
                Spacer(minLength: 12)
                Button("Forget") {
                  pending = Forgettable(title: "Forget this? It is deleted now.") {
                    store.forget(item: i.id)
                    found.removeAll { $0.id == i.id }
                  }
                }
                .buttonStyle(PillButton())
              }
              .padding(.vertical, 10)
            }
          }
          Panel(title: "Who read your vault", count: v.reads.recent.isEmpty ? nil : v.reads.week,
                footer: v.reads.recent.isEmpty ? nil : "\(v.reads.week) reads in the last 7 days. Only what you allow each AI to see, and every read is listed here.") {
            if v.reads.recent.isEmpty {
              Text("No AI has read your vault yet.").font(.kierBody).foregroundStyle(Kier.dim).padding(.vertical, 13)
            } else {
              ForEach(v.reads.recent) { r in
                HStack(alignment: .firstTextBaseline, spacing: 14) {
                  Text("\(dateLabel(r.ts)) \(timeLabel(r.ts))").font(.kierSmall.monospacedDigit()).foregroundStyle(Kier.faint).frame(width: 96, alignment: .leading)
                  VStack(alignment: .leading, spacing: 2) {
                    Text("\(r.client.map { $0.prefix(1).uppercased() + $0.dropFirst() } ?? "An AI") used \(r.tool ?? "Kier")").font(.kierBody)
                    Text("\(r.args ?? ""), \(r.rows ?? 0) items").font(.kierSmall).foregroundStyle(Kier.faint).lineLimit(1)
                  }
                }
                .padding(.vertical, 10)
              }
            }
          }
        }
      } else {
        ProgressView()
      }
    }
    .confirmationDialog(pending?.title ?? "", isPresented: Binding(get: { pending != nil }, set: { if !$0 { pending = nil } }), presenting: pending) { p in
      Button("Forget", role: .destructive) { p.run() }
    }
  }

  // One source as a tile: what it keeps, how much, and the chats it came from, each of which can be forgotten.
  private func source(_ s: Vault.Source, _ v: Vault) -> some View {
    VStack(alignment: .leading, spacing: 12) {
      HStack(spacing: 10) {
        IconTile(symbol: sourceSymbol(s.source), brand: Brand.of(source: s.source, thread: nil, sender: nil))
        Text(sourceName(s.source)).font(.kierCardTitle)
      }
      VStack(alignment: .leading, spacing: 1) {
        Text(s.n.formatted()).font(.kierStat).monospacedDigit()
        Text("kept, \(s.recent.formatted()) in the last 30 days").font(.kierSmall).foregroundStyle(Kier.faint)
      }
      if let k = keeps[s.source] { Text(k).font(.kierSmall).foregroundStyle(Kier.dim).fixedSize(horizontal: false, vertical: true) }
      if let threads = v.threads[s.source], !threads.isEmpty {
        Flow(spacing: 6) {
          ForEach(threads) { t in
            Chip(text: t.thread, count: t.n) {
              pending = Forgettable(title: "Forget everything from \(t.thread)? It is deleted now, and Kier stops keeping it.") {
                store.forget(source: t.source, thread: t.thread)
              }
            }
          }
        }
      }
    }
    .padding(18)
    .frame(maxWidth: .infinity, alignment: .topLeading)
    .surface(radius: 16)
  }

  private func never(_ symbol: String, _ text: String) -> some View {
    HStack(spacing: 14) {
      IconTile(symbol: symbol, size: 28)
      Text(text).font(.kierBody).foregroundStyle(Kier.dim)
      Spacer(minLength: 0)
    }
    .padding(.vertical, 9)
  }

  private func lede(_ v: Vault) -> String {
    let oldest = v.sources.map(\.oldest).min() ?? 0
    let size = ByteCountFormatter.string(fromByteCount: Int64(v.bytes), countStyle: .file)
    return "Since \(dateLabel(oldest)), \(size), all on this Mac. Nothing leaves it unless you ask an AI to read it, and every read is listed below."
  }
}

struct Chip: View {
  let text: String
  let count: Int
  let forget: () -> Void

  var body: some View {
    HStack(spacing: 5) {
      Text(text).lineLimit(1)
      Text("\(count)").foregroundStyle(Kier.faint).monospacedDigit()
      Button(action: forget) { Image(systemName: "xmark").font(.system(size: 9, weight: .bold)) }
        .buttonStyle(.plain).foregroundStyle(Kier.faint).help("Forget \(text) and stop keeping it")
    }
    .font(.system(size: 12))
    .padding(.leading, 10).padding(.trailing, 7).padding(.vertical, 4)
    .background(Capsule().fill(Color.white.opacity(0.07)))
  }
}

// Chips wrap onto as many lines as they need.
struct Flow: Layout {
  var spacing: CGFloat = 6

  // A chip's size doesn't depend on the width it wraps in, so each is measured once, not on every ask.
  func makeCache(subviews: Subviews) -> [CGSize] { subviews.map { $0.sizeThatFits(.unspecified) } }
  func updateCache(_ cache: inout [CGSize], subviews: Subviews) { cache = makeCache(subviews: subviews) }

  func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout [CGSize]) -> CGSize {
    let rows = arrange(width: proposal.width ?? .infinity, cache)
    return CGSize(width: proposal.width ?? rows.map(\.width).max() ?? 0, height: rows.last.map { $0.y + $0.height } ?? 0)
  }

  func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout [CGSize]) {
    for row in arrange(width: bounds.width, cache) {
      for (index, x) in row.items { subviews[index].place(at: CGPoint(x: bounds.minX + x, y: bounds.minY + row.y), proposal: .unspecified) }
    }
  }

  private func arrange(width: CGFloat, _ sizes: [CGSize]) -> [(items: [(Int, CGFloat)], y: CGFloat, width: CGFloat, height: CGFloat)] {
    var rows: [(items: [(Int, CGFloat)], y: CGFloat, width: CGFloat, height: CGFloat)] = []
    var x: CGFloat = 0, y: CGFloat = 0, height: CGFloat = 0, items: [(Int, CGFloat)] = []
    for (i, size) in sizes.enumerated() {
      if x > 0 && x + size.width > width {
        rows.append((items, y, x - spacing, height))
        y += height + spacing
        x = 0; height = 0; items = []
      }
      items.append((i, x))
      x += size.width + spacing
      height = max(height, size.height)
    }
    if !items.isEmpty { rows.append((items, y, x - spacing, height)) }
    return rows
  }
}

// MARK: Setup

struct SetupView: View {
  @Environment(Store.self) var store
  // Read by the island (Companion in Orb.swift), which follows changes as they're made.
  @AppStorage("kierIslandMode") private var islandMode = IslandMode.always.rawValue
  @AppStorage("kierSound") private var sound = true
  @AppStorage("kierAppearance") private var appearance = Appearance.hour.rawValue
  @State private var report: String?
  @State private var copied = false
  @State private var draft: Profile?

  @State private var tab = SetupTab.permissions
  @State private var profileBaseline: Profile?

  private enum SetupTab: String, CaseIterable {
    case permissions = "Permissions"
    case sources = "Sources & Sync"
    case you = "About You"
    case appearance = "Appearance"
    case system = "System"

    var detail: String {
      switch self {
      case .permissions: "Give Kier access to the parts of your Mac you want it to use."
      case .sources: "Choose what Kier reads and what it adds to Calendar and Reminders."
      case .you: "Help Kier understand you, the people you work with, and your chats."
      case .appearance: "Make the island, sounds, and shortcuts feel right for you."
      case .system: "Local models, optional online helpers, and troubleshooting."
      }
    }
  }
  private let permissionIDs = ["fda", "screen"]
  private let syncIDs = ["phonecal", "phonerem", "myrem"]
  private let connectionIDs = ["claude", "imessage", "calls", "calendar", "whatsapp", "notifications", "eyes", "chatapps", "mail", "gmail"]

  var body: some View {
    VStack(spacing: 0) {
      VStack(alignment: .leading, spacing: 16) {
        PageHeader(title: "Setup", lede: store.setupLeft == 0 ? "Kier is set up. Make it work your way." : "\(store.setupLeft) things left to switch on.")
        Flow(spacing: 6) {
          ForEach(SetupTab.allCases, id: \.self) { section in
            Button(section.rawValue) { tab = section }
              .buttonStyle(PillButton(prominent: tab == section))
              .accessibilityAddTraits(tab == section ? .isSelected : [])
          }
        }
      }
      .frame(maxWidth: 860, alignment: .leading)
      .padding(.horizontal, 32).padding(.top, 18).padding(.bottom, 14)
      .frame(maxWidth: .infinity)

      PageScroll {
        Text(tab.detail).font(.kierSmall).foregroundStyle(Kier.dim)
        switch tab {
        case .permissions: permissions
        case .sources: sources
        case .you: aboutYou
        case .appearance: appearanceSettings
        case .system: systemSettings
        }
      }
      .id(tab)
    }
    .onChange(of: store.profile) {
      if draft == nil || draft == profileBaseline { draft = store.profile }
      profileBaseline = store.profile
    }
    .task(id: store.page == .setup) {
      guard store.page == .setup else { return }
      await store.loadSettings()
      await store.loadProfile()
      if draft == nil { draft = store.profile; profileBaseline = store.profile }
      while !Task.isCancelled {
        await store.loadSetup()
        await store.loadPrivacy()
        try? await Task.sleep(for: .seconds(3))
      }
    }
  }

  private var permissions: some View {
    Group {
      setupSteps("Before you start", steps: store.steps.filter { $0.id == "terms" })
      setupSteps("macOS permissions", steps: store.steps.filter { permissionIDs.contains($0.id) })
    }
  }

  @ViewBuilder private var sources: some View {
    if let settings = store.settings {
        Panel(title: "What Kier reads",
              footer: "Switched off, a source isn't read or kept from then on, its cards leave the brief, and no AI can read it through Kier. What's already in your vault stays.") {
          ForEach(settings.sources) { s in
            row(s.label, [s.detail, s.count > 0 ? "\(s.count.formatted()) in the last 30 days" : nil].compactMap { $0 }.joined(separator: ". "), symbol: sourceSymbol(s.id)) {
              Toggle("", isOn: Binding(get: { s.on }, set: { store.setSource(s.id, on: $0) })).toggleStyle(.switch).labelsHidden().controlSize(.small)
            }
          }
        }
    }
    setupSteps("Calendar & Reminders", steps: store.steps.filter { syncIDs.contains($0.id) })
    setupSteps("Connected apps", steps: store.steps.filter { connectionIDs.contains($0.id) })
    MCPSourcesView()
  }

  private var aboutYou: some View {
      Panel(title: "Who you are",
            footer: "Drafted by Kier's local model from your own messages, chats and projects; nothing leaves this Mac. Fix anything that's wrong: what you write is kept when it learns again each week.",
            accessory: {
              if draft != nil {
                HStack(spacing: 14) {
                  Button(store.profile?.building == true ? "Learning…" : "Learn again") { store.rebuildProfile() }.buttonStyle(TextButton()).disabled(store.profile?.building == true)
                  Button("Save") { if let d = draft { store.saveProfile(d) } }.buttonStyle(PillButton(prominent: true)).disabled(draft == store.profile)
                }
              }
            }) {
        if let p = draft {
          VStack(alignment: .leading, spacing: 4) {
            Text("What you do").font(.kierSmall).foregroundStyle(Kier.faint)
            TextField("What you do", text: Binding(get: { p.about }, set: { draft?.about = $0 }), axis: .vertical)
              .textFieldStyle(.plain).font(.kierBody).lineLimit(2...8)
            if let names = p.aliases, !names.isEmpty {
              Text("Also goes by \(names.joined(separator: ", "))").font(.kierSmall).foregroundStyle(Kier.faint)
            }
          }
          .padding(.vertical, 12)
          ForEach(p.people.indices, id: \.self) { i in
            note(p.people[i].name, "Who they are to you", Binding(get: { draft?.people[i].text ?? "" }, set: { draft?.people[i].text = $0 }))
          }
          ForEach(p.groups.indices, id: \.self) { i in
            note(p.groups[i].name, "What this group is for", Binding(get: { draft?.groups[i].text ?? "" }, set: { draft?.groups[i].text = $0 }))
          }
        } else {
          Text("Kier is learning who you are from your messages. This takes a few minutes the first time.").font(.kierBody).foregroundStyle(Kier.dim).padding(.vertical, 12)
        }
      }
  }

  @ViewBuilder private var appearanceSettings: some View {
      Panel(title: "The island", footer: "The ting stays quiet from 22:00 to 08:00.") {
        row("At the screen edge", "Always there, tucked into the notch until you hover, or hidden.", symbol: "capsule") {
          Picker("", selection: $islandMode) {
            ForEach(IslandMode.allCases, id: \.rawValue) { Text($0.title).tag($0.rawValue) }
          }
          .labelsHidden().fixedSize()
        }
        row("Appearance", "The orb's sky and sea. By the hour follows the sun where you are: day, golden hour, then night with stars.", symbol: "sun.horizon") {
          Picker("", selection: $appearance) {
            ForEach(Appearance.allCases, id: \.rawValue) { Text($0.title).tag($0.rawValue) }
          }
          .labelsHidden().fixedSize()
        }
        row("Ting when something new comes in", nil, symbol: "bell") {
          Toggle("", isOn: $sound).toggleStyle(.switch).labelsHidden().controlSize(.small)
        }
      }
          Panel(title: "Shortcuts", footer: "Click one and press the keys you'd like, with Command, Option or Control. Escape keeps it as it was.") {
        row("Open Kier", "From anywhere, even with the island hidden.", symbol: "capsule") {
          ShortcutField(name: "open", fallback: .open)
        }
        row("Find anything", "Search everything Kier has read, the way you'd ask for it.", symbol: "magnifyingglass") {
          ShortcutField(name: "find", fallback: .find)
        }
      }

  }

  @ViewBuilder private var systemSettings: some View {
      // What the site promises, shown live: what Kier read, the model doing it here, and what left this Mac.
      if let p = store.privacy {
        VStack(alignment: .leading, spacing: 10) {
          Text("On this Mac").font(.kierLabel).foregroundStyle(Kier.dim).padding(.horizontal, 4)
          LazyVGrid(columns: [GridItem(.adaptive(minimum: 170), spacing: 12)], spacing: 12) {
            Stat(label: "Messages read today", value: p.read.formatted())
            Stat(label: p.yours == true ? "Your model" : "Local model", value: p.running ? "Running" : "Not running",
                 under: p.yours == true ? "\(p.model)\(p.local == true ? ", on this Mac" : p.server.map { ", on \($0)" } ?? "")" : p.model, ok: p.running)
            Stat(label: "Sent to the cloud", value: bytes(p.sent), under: p.sent == 0 ? "today" : "today, to \(Set(p.to.compactMap(\.agent)).map(\.capitalized).sorted().joined(separator: " and "))")
            Stat(label: "Account", value: "None needed")
          }
          Text(p.yours == true && p.local != true
               ? "Kier has no servers and no account. Your model runs on the server you chose, so what Kier reads goes there to be read; the search index and the second opinion stay on this Mac. Nothing else leaves it unless you hand it to Claude or Codex or turn on online helpers below."
               : "Kier has no servers and no account, and its models run on this Mac. Nothing leaves it unless you hand it to Claude or Codex (chats with them, hand-offs, what they read through Kier) or turn on online helpers below.")
            .font(.kierSmall).foregroundStyle(Kier.faint).padding(.horizontal, 4).fixedSize(horizontal: false, vertical: true)
        }
      }

    setupSteps("Models & background service", steps: store.steps.filter { $0.id != "terms" && !permissionIDs.contains($0.id) && !syncIDs.contains($0.id) && !connectionIDs.contains($0.id) })
    ModelPanel()
    if let settings = store.settings {
        // Kier is a local model end to end; these are the only connections it makes of its own, and they start off.
        Panel(title: "Online helpers",
              footer: settings.online
                ? "On: Kier uses the internet only for the helpers above. Handing a card to Claude or Codex, or picking them in a chat, is always your choice."
                : "Off: Kier makes no internet connections of its own. Everything it reads and thinks stays on this Mac. Handing a card to Claude or Codex, or picking them in a chat, is always your choice.") {
          row("Online helpers", "Let Kier check a few things on the internet to notice more of what's done.", symbol: "network") {
            Toggle("", isOn: Binding(get: { settings.online }, set: { store.setOnline($0) })).toggleStyle(.switch).labelsHidden().controlSize(.small)
          }
          helper("GitHub", "Sees whether your pull requests are still open or merged, using your gh login.", symbol: "arrow.triangle.pull", on: settings.online)
          helper("Your pages and feeds", "Opens the blog or feed you publish to, to see whether a promised post went out.", symbol: "doc.richtext", on: settings.online)
          if settings.claude {
            row("Let Claude double-check stuck cards",
                "When a card is still open hours later and you committed code after it, Kier asks your Claude once whether one of those commits fixed it. That sends the card's chat and those commits to Claude.",
                symbol: "sparkles") {
              Toggle("", isOn: Binding(get: { settings.claudeCheck }, set: { store.setClaudeCheck($0) })).toggleStyle(.switch).labelsHidden().controlSize(.small)
                .disabled(!settings.online)
            }
            .opacity(settings.online ? 1 : 0.5)
          }
        }
          }
      // Shown whole before it's copied, and never sent by Kier: you paste it where you report the bug.
      Panel(title: "Diagnostics", footer: "Only what's shown here: versions, which parts run, counts, and the kinds of trouble in Kier's log, never their words. No names, messages, chats, files or paths. Kier never sends it; you copy it into your bug report.") {
        row("Report for a bug", report == nil ? "See exactly what it holds before you copy it." : nil, symbol: "stethoscope") {
          HStack(spacing: 10) {
            if report != nil {
              Button(copied ? "Copied" : "Copy") {
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString(report ?? "", forType: .string)
                copied = true
              }
              .buttonStyle(PillButton(prominent: true))
            }
            Button(report == nil ? "Show" : "Hide") {
              if report == nil { Task { report = await store.diagnostics(); copied = false } } else { report = nil }
            }
            .buttonStyle(TextButton())
          }
        }
        if let report {
          ScrollView {
            Text(report).font(.system(size: 11.5, design: .monospaced)).foregroundStyle(Kier.dim).textSelection(.enabled)
              .frame(maxWidth: .infinity, alignment: .leading).padding(12)
          }
          .frame(maxHeight: 280)
          .background(Color.white.opacity(0.04), in: RoundedRectangle(cornerRadius: 10))
          .padding(.bottom, 12)
        }
      }

  }

  private func setupSteps(_ title: String, steps: [Step]) -> some View {
    Panel(title: title) {
      ForEach(steps) { s in
        HStack(alignment: .top, spacing: 14) {
          status(s.status)
          VStack(alignment: .leading, spacing: 3) {
            Text(s.title).font(.kierCardTitle)
            if let d = s.detail { Text(d).font(.system(size: 13)).foregroundStyle(Kier.dim).fixedSize(horizontal: false, vertical: true) }
            if let l = s.link, let url = s.linkURL {
              Button(l.label) { LinkPolicy.open(url) }.buttonStyle(TextButton()).padding(.top, 2)
            }
          }
          Spacer(minLength: 12)
          if let a = s.action { Button(a.label) { store.act(a) }.buttonStyle(PillButton(prominent: s.status == "todo")) }
        }
        .padding(.vertical, 12)
      }
    }
  }

  // A setting: its symbol, what it is and a line about it, and its control on the right.
  private func row<Control: View>(_ title: String, _ detail: String?, symbol: String, @ViewBuilder control: () -> Control) -> some View {
    HStack(alignment: .center, spacing: 14) {
      IconTile(symbol: symbol)
      VStack(alignment: .leading, spacing: 2) {
        Text(title).font(.kierCardTitle)
        if let detail, !detail.isEmpty { Text(detail).font(.system(size: 12.5)).foregroundStyle(Kier.dim).fixedSize(horizontal: false, vertical: true) }
      }
      Spacer(minLength: 12)
      control()
    }
    .padding(.vertical, 11)
  }

  // One online helper, described; it follows the switch above.
  private func helper(_ title: String, _ detail: String, symbol: String, on: Bool) -> some View {
    row(title, detail, symbol: symbol) {
      Text(on ? "On" : "Off").font(.kierSmall).foregroundStyle(on ? Kier.dim : Kier.faint)
    }
    .opacity(on ? 1 : 0.5)
  }

  // A person or group, then what Kier knows about them, written underneath and left-aligned like a note.
  private func note(_ name: String, _ prompt: String, _ text: Binding<String>) -> some View {
    VStack(alignment: .leading, spacing: 4) {
      Text(name).font(.kierCardTitle)
      TextField(prompt, text: text, prompt: Text(prompt), axis: .vertical)
        .labelsHidden().textFieldStyle(.plain).multilineTextAlignment(.leading).font(.system(size: 13)).foregroundStyle(Kier.dim).lineLimit(1...6)
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .padding(.vertical, 11)
  }

  @ViewBuilder private func status(_ s: String) -> some View {
    switch s {
    case "done": IconTile(symbol: "checkmark", tint: .green)
    case "todo": IconTile(symbol: "exclamationmark", tint: .orange)
    case "later": IconTile(symbol: "clock", tint: Kier.faint)
    default: IconTile(symbol: "circle.dashed", tint: Kier.faint)
    }
  }

  private func bytes(_ n: Int) -> String { n == 0 ? "0 bytes" : ByteCountFormatter.string(fromByteCount: Int64(n), countStyle: .file) }
}

// A global shortcut you change by pressing it: click, then press the keys. Escape keeps the old one, Reset brings back
// Kier's own. While it listens the shortcuts let go (Shortcut.recording), so the current one can be pressed again.
struct ShortcutField: View {
  let name: String
  let fallback: Shortcut
  @State private var current: Shortcut
  @State private var listening = false
  @State private var monitor: Any?

  init(name: String, fallback: Shortcut) {
    self.name = name
    self.fallback = fallback
    _current = State(initialValue: Shortcut.saved(name, or: fallback))
  }

  var body: some View {
    HStack(spacing: 10) {
      if current != fallback && !listening { Button("Reset") { set(nil) }.buttonStyle(TextButton()) }
      Button(listening ? "Press keys…" : current.symbols) { listening ? stop() : listen() }
        .buttonStyle(PillButton(prominent: listening))
    }
    .onDisappear { stop() }
  }

  private func listen() {
    listening = true
    NotificationCenter.default.post(name: Shortcut.recording, object: true)
    monitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { e in
      if e.keyCode == 53 { stop(); return nil }  // Escape
      guard let s = Shortcut(e) else { NSSound.beep(); return nil }
      set(s)
      stop()
      return nil
    }
  }

  private func stop() {
    if let monitor { NSEvent.removeMonitor(monitor) }
    monitor = nil
    guard listening else { return }
    listening = false
    NotificationCenter.default.post(name: Shortcut.recording, object: false)
  }

  private func set(_ s: Shortcut?) {
    Shortcut.save(s, as: name)
    current = s ?? fallback
  }
}

// Model settings select the built-in local runtime or an owner-supplied compatible server.
// Saving verifies connectivity before restarting Kier.
struct ModelPanel: View {
  @Environment(Store.self) var store
  @State private var draft: ModelDraft?
  @State private var models: [String] = []
  @State private var busy: String?
  @State private var message: String?
  @State private var failed = false

  var body: some View {
    Panel(title: "Model", footer: footer) {
      if let s = store.modelSettings, var d = draft {
        row("Reads your messages", s.mode == "custom" ? "\(s.activeModel), on your server." : "\(s.activeModel), Kier's own model, on this Mac.", symbol: "cpu") {
          Picker("", selection: Binding(get: { d.mode }, set: { d.mode = $0; draft = d; message = nil })) {
            Text("Kier's own").tag("builtin")
            Text("Your model").tag("custom")
          }
          .labelsHidden().fixedSize()
        }
        if d.mode == "custom" {
          row("Kind of server", "Ollama, or OpenAI-compatible: LM Studio, llama.cpp, vLLM, DeepSeek and most others.", symbol: "server.rack") {
            Picker("", selection: Binding(get: { d.connection }, set: { c in
              if d.endpoint.isEmpty || d.endpoint == d.connection.defaultEndpoint { d.endpoint = c.defaultEndpoint }
              d.connection = c; draft = d; models = []; message = nil
            })) {
              ForEach(ModelConnection.allCases, id: \.self) { Text($0.title).tag($0) }
            }
            .labelsHidden().fixedSize()
          }
          field("Address", "Where the server answers, like \(d.connection.defaultEndpoint)") {
            TextField("", text: Binding(get: { d.endpoint }, set: { d.endpoint = $0; draft = d }), prompt: Text(d.connection.defaultEndpoint))
          }
          field("API key", s.hasKey && d.apiKey.isEmpty && !d.clearKey ? "Saved. Leave it empty to keep it." : "Only if the server asks for one. It stays in Kier's settings on this Mac.") {
            HStack {
              SecureField("", text: Binding(get: { d.apiKey }, set: { d.apiKey = $0; d.clearKey = false; draft = d }), prompt: Text(s.hasKey ? "Saved" : "None"))
              if s.hasKey && !d.clearKey { Button("Remove") { d.apiKey = ""; d.clearKey = true; draft = d }.buttonStyle(TextButton()) }
            }
          }
          field("Model", models.isEmpty ? "Check the server to pick from its models, or type the name." : "\(models.count) on this server.") {
            HStack {
              TextField("", text: Binding(get: { d.model }, set: { d.model = $0; draft = d }), prompt: Text("qwen3.5:9b"))
              if !models.isEmpty {
                Menu("Pick") { ForEach(models, id: \.self) { m in Button(m) { d.model = m; draft = d } } }.fixedSize()
              }
            }
          }
        }
        HStack(spacing: 12) {
          if let message {
            Text(message).font(.kierSmall).foregroundStyle(failed ? .orange : Kier.dim).fixedSize(horizontal: false, vertical: true)
          }
          Spacer(minLength: 12)
          if d.mode == "custom" {
            Button(busy == "test" ? "Checking…" : "Check") { Task { await check(d) } }
              .buttonStyle(TextButton()).disabled(busy != nil || d.endpoint.isEmpty)
          }
          Button(busy == "save" ? "Switching…" : d.mode == "custom" ? "Use this model" : "Use Kier's own") { Task { await save(d) } }
            .buttonStyle(PillButton(prominent: true))
            .disabled(busy != nil || !changed(d, s) || (d.mode == "custom" && d.model.trimmingCharacters(in: .whitespaces).isEmpty))
        }
        .padding(.vertical, 11)
      } else {
        Text("Reading the model settings…").font(.kierBody).foregroundStyle(Kier.dim).padding(.vertical, 12)
      }
    }
    .task {
      await store.loadModelSettings()
      if draft == nil, let s = store.modelSettings { draft = ModelDraft(s) }
    }
    .onChange(of: store.modelSettings?.activeModel) { if let s = store.modelSettings, busy == nil { draft = ModelDraft(s) } }
  }

  private var footer: String {
    guard let d = draft, d.mode == "custom" else {
      return "Kier's own model runs on this Mac, and nothing it reads leaves it."
    }
    return d.sameMac
      ? "A server on this Mac: what Kier reads still stays here. The search index and the second opinion stay on this Mac either way."
      : "A server elsewhere: Kier sends it the messages it reads, to find your tasks and answer you. What it sends is counted under Sent to the cloud. The search index and the second opinion stay on this Mac."
  }

  // Something to save: another mode, or a different server, model or key than the one in use.
  private func changed(_ d: ModelDraft, _ s: ModelSettings) -> Bool {
    if d.mode != s.mode { return true }
    guard d.mode == "custom" else { return false }
    return d.connection != s.connection || d.endpoint != s.endpoint || d.model != s.model || !d.apiKey.isEmpty || d.clearKey
  }

  private func check(_ d: ModelDraft) async {
    busy = "test"; defer { busy = nil }
    let answer = await store.testModel(d)
    failed = answer?.ok != true
    models = answer?.models ?? []
    if failed { message = answer?.error ?? "Kier couldn't reach it." }
    else if d.model.isEmpty { message = models.isEmpty ? "It answers, but lists no models." : "It answers. Pick a model." }
    else { message = "It answers, and \(d.model) replies the way Kier needs." }
  }

  private func save(_ d: ModelDraft) async {
    busy = "save"; defer { busy = nil }
    let answer = await store.configureModel(d)
    failed = answer?.ok != true
    message = failed ? (answer?.error ?? "Kier couldn't switch.") : "Switched. Kier is restarting on it."
    if !failed { draft?.apiKey = ""; draft?.clearKey = false }
  }

  private func row<Control: View>(_ title: String, _ detail: String?, symbol: String, @ViewBuilder control: () -> Control) -> some View {
    HStack(alignment: .center, spacing: 14) {
      IconTile(symbol: symbol)
      VStack(alignment: .leading, spacing: 2) {
        Text(title).font(.kierCardTitle)
        if let detail, !detail.isEmpty { Text(detail).font(.system(size: 12.5)).foregroundStyle(Kier.dim).fixedSize(horizontal: false, vertical: true) }
      }
      Spacer(minLength: 12)
      control()
    }
    .padding(.vertical, 11)
  }

  private func field<Input: View>(_ title: String, _ detail: String, @ViewBuilder input: () -> Input) -> some View {
    VStack(alignment: .leading, spacing: 5) {
      Text(title).font(.kierCardTitle)
      input().textFieldStyle(.roundedBorder).font(.system(size: 13))
      Text(detail).font(.kierSmall).foregroundStyle(Kier.faint).fixedSize(horizontal: false, vertical: true)
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .padding(.vertical, 11)
  }
}


struct MCPSourcesView: View {
  @Environment(Store.self) var store
  @State private var sources: [MCPSource] = []
  @State private var name = ""
  @State private var endpoint = ""
  @State private var error: String?
  @State private var busy = false

  var body: some View {
    Panel(title: "MCP sources", footer: "Off until you enable a source. Kier sends your chosen tool name and JSON arguments to that server every 10 minutes. HTTP goes directly to its URL. Local commands may contact services using the credentials you configure. Results stay on this Mac; nothing goes to a Kier server. Choose servers and read tools you trust. On timeout or daemon exit, Kier kills the process group, observed descendants and detached children retaining its inherited marker. Local programs can evade cleanup by clearing the marker and detaching before observation; this is not a sandbox.") {
      ForEach(sources) { source in
        MCPSourceRow(source: source) { sources = await store.mcpSources() }
      }
      VStack(alignment: .leading, spacing: 10) {
        TextField("Source name", text: $name)
        TextField("HTTPS URL, http://127.0.0.1 URL, or command with arguments", text: $endpoint)
        Button(busy ? "Adding..." : "Add source") {
          Task {
            busy = true
            let reply = await store.mcpAction("", ["name": name, "endpoint": endpoint])
            error = reply?.ok == true ? nil : reply?.error ?? "Could not add the source."
            if reply?.ok == true { name = ""; endpoint = ""; sources = await store.mcpSources() }
            busy = false
          }
        }.disabled(busy || name.isEmpty || endpoint.isEmpty)
        if let error { Text(error).font(.kierSmall).foregroundStyle(.red) }
        Text("For per-server environment variables, edit mcpSources in config.json. Commands run directly, without a shell. Tool arguments are sent exactly as entered.").font(.kierSmall).foregroundStyle(Kier.dim)
      }.padding(.vertical, 12)
    }.task { sources = await store.mcpSources() }
  }
}

struct MCPSourceRow: View {
  @Environment(Store.self) var store
  let source: MCPSource
  let reload: () async -> Void
  @State private var tools: [MCPTool] = []
  @State private var tool = ""
  @State private var arguments = "{}"
  @State private var error: String?
  @State private var busy = false

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      HStack {
        VStack(alignment: .leading) {
          Text(source.name).font(.kierCardTitle)
          Text(source.destination).font(.kierSmall).foregroundStyle(Kier.dim)
        }
        Spacer()
        Toggle("On", isOn: Binding(get: { source.enabled }, set: { on in
          Task { await action("", ["id": source.id, "enabled": on]) }
        })).disabled(busy || source.tool.isEmpty)
        Button("Remove") { Task { await action("", ["id": source.id, "remove": true]) } }.disabled(busy)
      }
      HStack {
        Button(busy ? "Working..." : "List read tools") {
          Task {
            busy = true
            let reply = await store.mcpAction("/tools", ["id": source.id])
            tools = reply?.tools ?? []
            error = reply?.ok == true ? (tools.isEmpty ? "No tools marked read only were found." : nil) : reply?.error ?? "Could not list tools."
            busy = false
          }
        }.disabled(busy)
        if !tools.isEmpty {
          Picker("Read tool", selection: $tool) {
            Text("Choose a tool").tag("")
            ForEach(tools) { Text($0.name).tag($0.name) }
          }
        } else if !source.tool.isEmpty { Text(source.tool).font(.kierSmall) }
        Button("Sync now") { Task { await action("/sync", ["id": source.id]) } }.disabled(busy || !source.enabled)
      }
      if let selected = tools.first(where: { $0.name == tool }) {
        Text(selected.description).font(.kierSmall).foregroundStyle(Kier.dim)
      }
      TextField("Tool arguments as a JSON object", text: $arguments, axis: .vertical).lineLimit(2...5)
      Button("Save read tool") {
        Task {
          guard let data = arguments.data(using: .utf8), let args = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            error = "Arguments must be a JSON object."; return
          }
          await action("", ["id": source.id, "tool": tool, "arguments": args])
        }
      }.disabled(busy || tool.isEmpty)
      if let error { Text(error).font(.kierSmall).foregroundStyle(.red) }
    }.padding(.vertical, 12)
      .task(id: source.id) { tool = source.tool; arguments = source.arguments }
  }

  private func action(_ path: String, _ body: [String: Any]) async {
    busy = true
    let reply = await store.mcpAction(path, body)
    error = reply?.ok == true ? nil : reply?.error ?? "Could not update this source."
    await reload()
    busy = false
  }
}
