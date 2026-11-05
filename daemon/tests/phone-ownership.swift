import Foundation

@main struct OwnershipTests {
  static func main() throws {
    var ledger = PhoneOwnership()
    // An already-adopted legacy container has no creation provenance.
    assert(!ledger.canDeleteContainer("legacy", remaining: 0, completeInventory: true))
    assert(!ledger.owns(itemID: "unrelated", externalID: nil, containerID: "legacy", logicalID: "fixture"))
    ledger.containers.insert("created")
    ledger.record(.init(logicalID: "fixture", itemID: "local", externalID: "external", containerID: "created", kind: "event"))
    assert(ledger.owns(itemID: "local", externalID: nil, containerID: "created", logicalID: "fixture"))
    assert(ledger.owns(itemID: "changed", externalID: "external", containerID: "created", logicalID: "fixture"))
    assert(!ledger.owns(itemID: "other", externalID: nil, containerID: "created", logicalID: "fixture"))
    assert(!ledger.owns(itemID: "local", externalID: "external", containerID: "legacy", logicalID: "fixture"))
    assert(!ledger.canDeleteContainer("created", remaining: 1, completeInventory: true))
    assert(!ledger.canDeleteContainer("created", remaining: 0, completeInventory: false))
    assert(ledger.canDeleteContainer("created", remaining: 0, completeInventory: true))
    let restored = try JSONDecoder().decode(PhoneOwnership.self, from: JSONEncoder().encode(ledger))
    assert(restored.entries == ledger.entries && restored.containers == ledger.containers)
  }
}
