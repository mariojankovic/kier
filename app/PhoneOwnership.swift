import Foundation

// Persisted provenance, independent of EventKit so migration and deletion policy can be tested.
struct PhoneOwnership: Codable {
  struct Entry: Codable, Equatable {
    var logicalID: String
    var itemID: String
    var externalID: String?
    var containerID: String
    var kind: String
  }
  var containers: Set<String> = []
  var entries: [Entry] = []

  func owns(itemID: String, externalID: String?, containerID: String, logicalID: String?) -> Bool {
    guard let logicalID else { return false }
    return entries.contains { entry in
      entry.containerID == containerID && entry.logicalID == logicalID &&
        (entry.itemID == itemID || (entry.externalID != nil && entry.externalID == externalID))
    }
  }
  func canDeleteContainer(_ id: String, remaining: Int, completeInventory: Bool) -> Bool {
    containers.contains(id) && completeInventory && remaining == 0
  }
  mutating func record(_ entry: Entry) {
    entries.removeAll { $0.itemID == entry.itemID }
    entries.append(entry)
  }
}
