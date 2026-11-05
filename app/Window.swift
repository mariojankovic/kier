import AppKit
import SwiftUI

// MARK: Kier's window, shown by the daemon: a Dock icon while it's open, the menu bar otherwise

extension Notification.Name {
  static let kierWindowShown = Notification.Name("kierWindowShown")
}

@MainActor
final class Viewer: NSObject, NSWindowDelegate {
  private var window: NSWindow?
  let store = Store()

  func show(_ path: String) {
    // The floating panel steps aside, so opening Kier (or its Setup) from it shows just the window.
    NotificationCenter.default.post(name: .kierWindowShown, object: nil)
    open(path)
    NSApp.setActivationPolicy(.regular)
    window?.makeKeyAndOrderFront(nil)
    NSApp.activate(ignoringOtherApps: true)
  }

  // For a screenshot while you work: the window placed behind everything, never taking focus, then put away.
  func peek(_ path: String) {
    open(path)
    window?.orderBack(nil)
  }

  private func open(_ path: String) {
    store.page = Page(path: path)
    if window == nil {
      let host = NSHostingController(rootView: ContentView().environment(store).environment(\.openURL, LinkPolicy.action))
      // The SwiftUI toolbar, title and search field belong in the window's own title bar.
      host.sceneBridgingOptions = [.toolbars, .title]
      let w = NSWindow(contentViewController: host)
      w.styleMask = [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView]
      // Black glass all the way to the edges, title bar included (see Glass.swift).
      w.titlebarAppearsTransparent = true
      w.isOpaque = false
      w.backgroundColor = .clear
      w.appearance = NSAppearance(named: .darkAqua)
      w.setContentSize(NSSize(width: 980, height: 720))
      w.minSize = NSSize(width: 640, height: 480)
      w.isReleasedWhenClosed = false
      w.delegate = self
      w.center()
      w.setFrameAutosaveName("Kier")
      window = w
    }
    Task { await store.refresh() }
  }

  func unpeek() { if !NSApp.isActive { window?.orderOut(nil) } }

  @objc func reload() { Task { await store.refresh() } }

  func windowWillClose(_ notification: Notification) { NSApp.setActivationPolicy(.accessory) }

  // Stop the current login-agent job without removing its plist: reopening Kier starts it again.
  @objc func quit() {
    let target = "gui/\(getuid())/com.getkier.agent"
    let probe = Process()
    probe.executableURL = URL(fileURLWithPath: "/bin/launchctl")
    probe.environment = child.environment
    probe.arguments = ["print", target]
    probe.standardOutput = FileHandle.nullDevice
    probe.standardError = FileHandle.nullDevice
    do { try probe.run(); probe.waitUntilExit() } catch { showQuitError(); return }
    guard probe.terminationStatus == 0 else { NSApp.terminate(nil); return }
    let stop = Process()
    stop.executableURL = URL(fileURLWithPath: "/bin/launchctl")
    stop.environment = child.environment
    stop.arguments = ["bootout", target]
    stop.standardOutput = FileHandle.nullDevice
    stop.standardError = FileHandle.nullDevice
    stop.terminationHandler = { [weak self] process in
      let success = process.terminationStatus == 0
      DispatchQueue.main.async {
        if success { NSApp.terminate(nil) }
        else { self?.showQuitError() }
      }
    }
    do { try stop.run() } catch { showQuitError() }
  }

  private func showQuitError() {
    let alert = NSAlert()
    alert.messageText = "Kier couldn’t quit"
    alert.informativeText = "The background service couldn’t stop. Try Quit Kier again."
    alert.addButton(withTitle: "OK")
    alert.runModal()
  }

  // Copy, paste and close need a menu once Kier is a regular app with a window.
  func installMenu() {
    let main = NSMenu()
    func submenu(_ title: String, _ items: [NSMenuItem]) {
      let holder = NSMenuItem()
      let menu = NSMenu(title: title)
      items.forEach(menu.addItem)
      holder.submenu = menu
      main.addItem(holder)
    }
    func item(_ title: String, _ action: Selector, _ key: String, target: AnyObject? = nil) -> NSMenuItem {
      let m = NSMenuItem(title: title, action: action, keyEquivalent: key)
      m.target = target
      return m
    }
    submenu("Kier", [item("Hide Kier", #selector(NSApplication.hide(_:)), "h"), item("Quit Kier", #selector(quit), "q", target: self)])
    submenu("Edit", [
      item("Undo", Selector(("undo:")), "z"), item("Redo", Selector(("redo:")), "Z"), .separator(),
      item("Cut", #selector(NSText.cut(_:)), "x"), item("Copy", #selector(NSText.copy(_:)), "c"),
      item("Paste", #selector(NSText.paste(_:)), "v"), item("Select All", #selector(NSText.selectAll(_:)), "a"),
    ])
    submenu("View", [item("Reload", #selector(reload), "r", target: self)])
    submenu("Window", [item("Close", #selector(NSWindow.performClose(_:)), "w"), item("Minimize", #selector(NSWindow.performMiniaturize(_:)), "m")])
    NSApp.mainMenu = main
  }
}
