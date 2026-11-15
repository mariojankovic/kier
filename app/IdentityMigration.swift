import Foundation

// Kier was first released under another bundle identifier. macOS keeps an app's settings by that identifier, so the
// first launch under the new one copies them over once: the phone it syncs with, its shortcuts, how the orb looks.
// The vault, the cards and config.json live in Application Support and never moved.
enum IdentityMigration {
  // The identifiers earlier releases carried, newest first.
  static let former = ["com.getkier.kier"]
  static let marker = "settingsCarriedOver.v1"
  // Set when settings really came from an earlier identifier: macOS then treats Kier as a new app and has forgotten its
  // permissions, so the background copy shows Setup once.
  static let renamed = "showSetupAfterRename.v1"

  static func run(defaults: UserDefaults = .standard, current: String? = Bundle.main.bundleIdentifier, former: [String] = IdentityMigration.former) {
    guard let current, !former.contains(current), !defaults.bool(forKey: marker) else { return }
    for old in former {
      guard let saved = defaults.persistentDomain(forName: old), !saved.isEmpty else { continue }
      var mine = defaults.persistentDomain(forName: current) ?? [:]
      for (key, value) in saved where mine[key] == nil { mine[key] = value }
      mine[renamed] = true
      defaults.setPersistentDomain(mine, forName: current)
      break
    }
    defaults.set(true, forKey: marker)
  }
  // True once, for the background copy's first run after the rename.
  static func setupOwed(defaults: UserDefaults = .standard) -> Bool {
    guard defaults.bool(forKey: renamed) else { return false }
    defaults.set(false, forKey: renamed)
    return true
  }
}
