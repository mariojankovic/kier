import AppKit
import Sparkle
import SwiftUI

// Sparkle reads the signed appcast from the configured release feed. The island offers Update and Later.
// Update downloads, checks the signature, installs and restarts with progress shown in Kier.
// Only packaged builds update themselves; development builds run the daemon from a checkout.
@MainActor final class Updater: NSObject, SPUUpdaterDelegate {
  enum Phase: Equatable { case available, downloading(Double?), installing, latest, failed(String) }

  final class Offer: ObservableObject {
    @Published var version = ""
    @Published var notes = ""
    @Published var phase = Phase.available
  }

  let offer = Offer()
  // A newer Kier found and not taken: hovering the island brings the card back, and the menu bar says so.
  private(set) var pending: String?
  // The card's in the middle of an update, so nothing else may take its place.
  var busy: Bool { offer.phase.working }
  // The island shows the card, and puts it away.
  var show: (() -> Void)?
  var hide: (() -> Void)?

  private var answer: ((SPUUserUpdateChoice) -> Void)?
  private lazy var driver = CardDriver(updater: self)
  private lazy var sparkle = SPUUpdater(hostBundle: .main, applicationBundle: .main, userDriver: driver, delegate: self)

  var current: String { Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "" }

  // Checks now, so an update out since Kier last started is offered straight away, then on Sparkle's schedule
  // (SUScheduledCheckInterval in Info.plist). Never downloads unasked.
  func start() {
    sparkle.automaticallyDownloadsUpdates = false
    do { try sparkle.start() } catch { NSLog("Kier updater: \(error.localizedDescription)"); return }
    if sparkle.automaticallyChecksForUpdates { sparkle.checkForUpdatesInBackground() }
  }

  // From the menus. Asked for, so it always answers: the update, "you have the latest", or why it couldn't look.
  func checkNow() {
    if pending != nil, answer != nil { show?(); return }
    sparkle.checkForUpdates()
  }

  func install() {
    guard offer.phase == .available else { return }
    offer.phase = .downloading(nil)
    guard let reply = answer else {
      // Put off with Later, then Update from the card on hover: Sparkle has let that offer go, so ask it again and take
      // the answer straight away, still one click.
      installFound = true
      sparkle.checkForUpdates()
      return
    }
    answer = nil
    reply(.install)
  }
  private var installFound = false

  // Asked again at the next check, and on hover until then.
  func later() {
    hide?()
    guard let reply = answer else { return }
    answer = nil
    reply(.dismiss)
  }

  fileprivate func found(_ item: SUAppcastItem, reply: @escaping (SPUUserUpdateChoice) -> Void) {
    pending = item.displayVersionString
    offer.version = item.displayVersionString
    offer.notes = Self.line(item.itemDescription ?? "")
    if installFound {
      installFound = false
      reply(.install)
      return
    }
    answer = reply
    offer.phase = .available
    show?()
  }

  fileprivate func notes(_ html: String) { if offer.notes.isEmpty { offer.notes = Self.line(html) } }

  fileprivate func progressed(_ phase: Phase) { offer.phase = phase }

  fileprivate func latest() {
    installFound = false
    pending = nil
    offer.version = current
    offer.phase = .latest
    show?()
  }

  fileprivate func failed(_ error: Error, asked: Bool) {
    NSLog("Kier updater: %@", String(describing: error))
    let was = busy
    answer = nil
    installFound = false
    guard asked || was else { return }
    offer.phase = .failed(Self.unreachable(error) ? "Couldn't reach the update server. Kier AI tries again on its own." : error.localizedDescription)
    show?()
  }

  // Under the login agent, launchd relaunches Kier. Once Sparkle is ready, quit so the installer
  // can replace the bundle and launchd can start the updated app.
  fileprivate func readyToInstall() {
    quitToInstall = !Self.relaunches
    offer.phase = .installing
  }
  private var quitToInstall = false

  fileprivate func ended() {
    answer = nil
    if quitToInstall {
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { NSApp.terminate(nil) }
      return
    }
    hide?()
  }

  // The first paragraph of the release notes, as one plain line.
  static func line(_ html: String) -> String {
    let first = html.components(separatedBy: "</p>").first ?? html
    var text = first.replacingOccurrences(of: "<[^>]+>", with: " ", options: .regularExpression)
    for (entity, char) in [("&amp;", "&"), ("&lt;", "<"), ("&gt;", ">"), ("&quot;", "\""), ("&#39;", "'"), ("&nbsp;", " ")] {
      text = text.replacingOccurrences(of: entity, with: char)
    }
    return text.replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression).trimmingCharacters(in: .whitespacesAndNewlines)
  }

  static func unreachable(_ error: Error) -> Bool { (error as NSError).code == Int(SUError.appcastError.rawValue) }

  // MARK: SPUUpdaterDelegate

  // KIER_UPDATE_FEED points a copy at another appcast, for trying an update out without publishing one.
  nonisolated func feedURLString(for updater: SPUUpdater) -> String? { ProcessInfo.processInfo.environment["KIER_UPDATE_FEED"] }

  // The login agent keeps Kier running (KeepAlive), so launchd brings it back once it quits for the install, and main.swift
  // restarts it if launchd was quicker than the install. Sparkle relaunching it as well would open a second copy.
  nonisolated static var relaunches: Bool { ProcessInfo.processInfo.environment["XPC_SERVICE_NAME"] != "com.getkier.agent" }
  nonisolated func updaterShouldRelaunchApplication(_ updater: SPUUpdater) -> Bool { Self.relaunches }

  nonisolated func updaterDidNotFindUpdate(_ updater: SPUUpdater) {
    Task { @MainActor in self.pending = nil }
  }
}

// Sparkle's windows, replaced by the card: Sparkle calls this for every moment of an update it would show a window for.
// Called on the main thread.
final class CardDriver: NSObject, SPUUserDriver {
  private weak var updater: Updater?
  private var expected: UInt64 = 0
  private var received: UInt64 = 0
  private var asked = false

  init(updater: Updater) { self.updater = updater }

  private func main(_ work: @MainActor (Updater) -> Void) {
    MainActor.assumeIsolated { if let updater { work(updater) } }
  }

  func show(_ request: SPUUpdatePermissionRequest, reply: @escaping (SUUpdatePermissionResponse) -> Void) {
    reply(SUUpdatePermissionResponse(automaticUpdateChecks: true, sendSystemProfile: false))
  }

  func showUserInitiatedUpdateCheck(cancellation: @escaping () -> Void) { asked = true }

  func showUpdateFound(with appcastItem: SUAppcastItem, state: SPUUserUpdateState, reply: @escaping (SPUUserUpdateChoice) -> Void) {
    asked = false
    main { $0.found(appcastItem, reply: reply) }
  }

  func showUpdateReleaseNotes(with downloadData: SPUDownloadData) {
    let html = String(data: downloadData.data, encoding: .utf8) ?? ""
    main { $0.notes(html) }
  }

  func showUpdateReleaseNotesFailedToDownloadWithError(_ error: Error) {}

  func showUpdateNotFoundWithError(_ error: Error, acknowledgement: @escaping () -> Void) {
    if asked { main { $0.latest() } }
    asked = false
    acknowledgement()
  }

  func showUpdaterError(_ error: Error, acknowledgement: @escaping () -> Void) {
    let wasAsked = asked
    asked = false
    main { $0.failed(error, asked: wasAsked) }
    acknowledgement()
  }

  func showDownloadInitiated(cancellation: @escaping () -> Void) {
    expected = 0
    received = 0
    main { $0.progressed(.downloading(nil)) }
  }

  func showDownloadDidReceiveExpectedContentLength(_ expectedContentLength: UInt64) {
    expected = expectedContentLength
    received = 0
    main { $0.progressed(.downloading(0)) }
  }

  func showDownloadDidReceiveData(ofLength length: UInt64) {
    received += length
    guard expected > 0 else { return }
    let share = min(1, Double(received) / Double(expected))
    main { $0.progressed(.downloading(share)) }
  }

  func showDownloadDidStartExtractingUpdate() { main { $0.progressed(.installing) } }

  func showExtractionReceivedProgress(_ progress: Double) {}

  // Already asked for in the card: straight on to installing.
  func showReady(toInstallAndRelaunch reply: @escaping (SPUUserUpdateChoice) -> Void) {
    main { $0.readyToInstall() }
    reply(.install)
  }

  func showInstallingUpdate(withApplicationTerminated applicationTerminated: Bool, retryTerminatingApplication: @escaping () -> Void) {
    main { $0.progressed(.installing) }
  }

  func showUpdateInstalledAndRelaunched(_ relaunched: Bool, acknowledgement: @escaping () -> Void) {
    main { $0.ended() }
    acknowledgement()
  }

  func showUpdateInFocus() { main { $0.show?() } }

  func dismissUpdateInstallation() { main { $0.ended() } }
}

// The card beside the island, in the nudges' black glass: which Kier, a line of what's new, Update and Later; then its
// progress in place, and Kier restarts on its own.
struct UpdateView: View {
  @ObservedObject var model: ToastModel
  @ObservedObject var offer: Updater.Offer
  let install: () -> Void
  let later: () -> Void
  let hovered: (Bool) -> Void

  private var line: String {
    switch offer.phase {
    case .available: return "Kier AI \(offer.version) is out"
    case .downloading: return "Downloading Kier AI \(offer.version)"
    case .installing: return "Installing Kier AI \(offer.version)"
    case .latest: return "Kier AI \(offer.version)"
    case .failed: return "Couldn't update"
    }
  }

  private var text: String {
    switch offer.phase {
    case .available: return offer.notes.isEmpty ? "A new version is ready to install." : offer.notes
    case .downloading: return "Kier AI restarts on its own when it's in."
    case .installing: return "Restarting in a moment."
    case .latest: return "You have the latest Kier AI."
    case let .failed(why): return why
    }
  }

  var body: some View {
    HStack(spacing: 10) {
      VStack(alignment: .leading, spacing: 4) {
        Text(line).font(.system(size: 11, weight: .medium)).foregroundStyle(.secondary).lineLimit(1)
        Text(text).font(.system(size: 13, weight: .medium)).lineLimit(2, reservesSpace: true).fixedSize(horizontal: false, vertical: true)
        Track(phase: offer.phase)
      }
      Spacer(minLength: 2)
      if offer.phase == .available {
        Button(action: install) {
          Text("Update").font(.system(size: 12, weight: .medium))
            .padding(.horizontal, 12).frame(height: 26)
            .background(Capsule().fill(Color.white.opacity(0.16)))
            .overlay(Capsule().strokeBorder(Glass.rim, lineWidth: 0.5))
        }
        .buttonStyle(.plain)
        RoundButton(symbol: "xmark", help: "Later", action: later)
      } else if !offer.phase.working {
        RoundButton(symbol: "xmark", help: "Close", action: later)
      }
    }
    .padding(.leading, 14).padding(.trailing, 10).padding(.vertical, 10)
    .frame(width: 320, alignment: .leading)
    .onHover(perform: hovered)
    .blackGlass(radius: 16)
    .modifier(CardMotion(model: model))
  }

  // A hairline track under the text, while it downloads and installs; without a share yet it runs a short light along
  // it. Always there, so the card keeps its height from offer to install (present() measures it once).
  struct Track: View {
    let phase: Updater.Phase
    @State private var run = false

    private var share: Double? { if case let .downloading(s) = phase { return s }; return nil }

    var body: some View {
      GeometryReader { g in
        ZStack(alignment: .leading) {
          Capsule().fill(Color.white.opacity(0.12))
          if let share {
            Capsule().fill(Color.white.opacity(0.85)).frame(width: max(4, g.size.width * share))
              .animation(.easeOut(duration: 0.2), value: share)
          } else {
            Capsule().fill(Color.white.opacity(0.7)).frame(width: g.size.width * 0.3)
              .offset(x: run ? g.size.width * 0.7 : 0)
              .animation(.easeInOut(duration: 0.9).repeatForever(autoreverses: true), value: run)
              .onAppear { run = true }
          }
        }
      }
      .frame(height: 3)
      .padding(.top, 3)
      .opacity(phase.working ? 1 : 0)
    }
  }
}

extension Updater.Phase {
  var working: Bool {
    switch self {
    case .downloading, .installing: return true
    default: return false
    }
  }
}
