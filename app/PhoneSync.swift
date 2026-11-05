import AppKit
import EventKit

// Opt-in sync writes plans to a Kier calendar and dated tasks to a Kier reminder list.
// Apple account sync carries them to other devices. Deleted items stay deleted; completed reminders
// are marked done in Kier. The daemon decides which items qualify (lib/phone.mjs).
@MainActor
final class PhoneSync {
  static let shared = PhoneSync()

  struct Item: Decodable {
    let id: String
    let kind: String
    let title: String
    let notes: String?
    let start: Double?
    let end: Double?
    let due: String?
    let time: String?
    // Done in Kier: its reminder is ticked off, not removed.
    let done: Bool?
  }
  // Three independent switches, off by default: plans, dated tasks, and reading existing reminders.
  // Older daemons send only `on`, which controls the first two.
  private struct Wanted: Decodable { let on: Bool; let calendar: Bool?; let reminders: Bool?; let mine: Bool?; let items: [Item] }
  private struct Mine: Decodable { let close: [String]; let reopen: [String]; let completionPolicy: String? }

  private let ek = EKEventStore()
  private let defaults = UserDefaults.standard
  private let base = "http://127.0.0.1:4777"
  private var ownership: PhoneOwnership = {
    guard let data = UserDefaults.standard.data(forKey: "kierPhoneOwnershipV1"),
          let value = try? JSONDecoder().decode(PhoneOwnership.self, from: data) else { return PhoneOwnership() }
    return value
  }()
  private func saveOwnership() {
    if let data = try? JSONEncoder().encode(ownership) { defaults.set(data, forKey: "kierPhoneOwnershipV1") }
  }
  private func owns(_ item: EKCalendarItem) -> Bool {
    ownership.owns(itemID: item.calendarItemIdentifier, externalID: item.calendarItemExternalIdentifier,
                   containerID: item.calendar.calendarIdentifier, logicalID: Self.kierId(item))
  }
  private func record(_ item: EKCalendarItem, logicalID: String, kind: String) {
    ownership.record(.init(logicalID: logicalID, itemID: item.calendarItemIdentifier,
                           externalID: item.calendarItemExternalIdentifier, containerID: item.calendar.calendarIdentifier, kind: kind))
    saveOwnership()
  }
  private var last = Date.distantPast
  private var running = false

  // Reported to the daemon with what the eyes see, for the Setup steps.
  nonisolated static var eventsAllowed: Bool { EKEventStore.authorizationStatus(for: .event) == .fullAccess }
  nonisolated static var remindersAllowed: Bool { EKEventStore.authorizationStatus(for: .reminder) == .fullAccess }
  nonisolated static var allowed: Bool { eventsAllowed && remindersAllowed }

  // Asked when you turn a switch on in Setup, for what that switch needs only. Once refused, macOS only lets you change
  // it in System Settings, so it opens there.
  func requestAccess(events: Bool, reminders: Bool) async -> Bool {
    let e = events ? ((try? await ek.requestFullAccessToEvents()) ?? false) : true
    let r = reminders ? ((try? await ek.requestFullAccessToReminders()) ?? false) : true
    if !(e && r), let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_\(e ? "Reminders" : "Calendars")") {
      LinkPolicy.open(url)
    }
    return e && r
  }

  // Every five minutes at most, or right away after a change in Setup.
  func tick(force: Bool = false) {
    guard force || Date().timeIntervalSince(last) > 300, !running else { return }
    last = Date()
    running = true
    Task {
      await sync()
      running = false
    }
  }

  private func sync() async {
    guard let wanted: Wanted = await fetch() else { return }
    let useCalendar = wanted.calendar ?? wanted.on, useList = wanted.reminders ?? wanted.on
    // What changed on the phone since the last look reaches this Mac through iCloud; forget what was cached.
    ek.refreshSourcesIfNecessary()
    // A switch turned off removes only items with persisted creation provenance.
    if !useCalendar { await removeKier(.event) }
    if !useList { await removeKier(.reminder) }
    if wanted.mine == true, Self.remindersAllowed, !(await syncMine()) { return }
    let calendar = useCalendar && Self.eventsAllowed ? kierCalendar(.event) : nil
    let list = useList && Self.remindersAllowed ? kierCalendar(.reminder) : nil
    guard calendar != nil || list != nil else { return }
    // Use each item’s kier://item/<id> link as its stable identity; EventKit identifiers can change
    // after a restart, which would otherwise duplicate events.
    var there: [String: EKCalendarItem] = [:]
    let events = calendar.map { ek.events(matching: ek.predicateForEvents(withStart: Date().addingTimeInterval(-86400), end: Date().addingTimeInterval(16 * 86400), calendars: [$0])) } ?? []
    let listed = list == nil ? [] : await reminders(in: list!)
    for found in (events as [EKCalendarItem]) + listed {
      guard owns(found), let id = Self.kierId(found) else { continue }
      // A copy (made twice by an earlier version): one stays.
      if there[id] != nil { remove(found); continue }
      there[id] = found
    }
    var made = Set(defaults.stringArray(forKey: "kierPhoneMadeV1") ?? [])
    var gone = Set(defaults.stringArray(forKey: "kierPhoneGone") ?? [])
    // Only what has its calendar or list here: without macOS's say-so for one, its items wait rather than read as deleted.
    for item in wanted.items where !gone.contains(item.id) && (item.kind == "event" ? calendar : list) != nil {
      if let existing = there[item.id] {
        // Done in Kier: ticked off on the phone too.
        if item.done == true {
          if let reminder = existing as? EKReminder, !reminder.isCompleted {
            reminder.isCompleted = true
            try? ek.save(reminder, commit: true)
          }
          continue
        }
        // Ticked off on the phone: done in Kier too.
        if let reminder = existing as? EKReminder, reminder.isCompleted {
          gone.insert(item.id)
          made.remove(item.id)
          await post("/api/mark", ["id": item.id, "status": "done"])
          continue
        }
        update(existing, item)
      } else if item.done == true {
        // Done before it ever reached the phone: nothing to add.
        continue
      } else if made.contains(item.id) {
        // Made before and missing now: deleted on the phone, and it stays deleted.
        gone.insert(item.id)
        made.remove(item.id)
      } else if create(item, calendar: calendar, list: list) {
        made.insert(item.id)
      }
    }
    // What left Kier's list leaves the phone: done or set aside here, or a plan that moved. Past events stay as they were.
    let wantedIds = Set(wanted.items.map(\.id))
    for (id, found) in there where !wantedIds.contains(id) {
      if let reminder = found as? EKReminder, !reminder.isCompleted { remove(reminder) }
      if let event = found as? EKEvent, event.endDate > Date() { remove(event) }
      made.remove(id)
    }
    made.formIntersection(wantedIds)
    // Persist plain arrays: UserDefaults cannot store an ArraySlice.
    defaults.set(Array(made), forKey: "kierPhoneMadeV1")
    defaults.set(Array(Array(gone).suffix(500)), forKey: "kierPhoneGone")
  }

  private static let scheme = "kier://item/"
  private static func link(_ id: String) -> URL? { URL(string: scheme + (id.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? id)) }
  private static func kierId(_ item: EKCalendarItem) -> String? {
    guard let url = item.url?.absoluteString, url.hasPrefix(scheme) else { return nil }
    return String(url.dropFirst(scheme.count)).removingPercentEncoding
  }

  private func reminders(in list: EKCalendar) async -> [EKCalendarItem] {
    await withCheckedContinuation { done in
      ek.fetchReminders(matching: ek.predicateForReminders(in: [list])) { found in done.resume(returning: (found ?? []) as [EKCalendarItem]) }
    }
  }

  @discardableResult
  private func remove(_ item: EKCalendarItem) -> Bool {
    guard owns(item) else { return false }
    let containerID = item.calendar.calendarIdentifier
    let itemID = item.calendarItemIdentifier
    let externalID = item.calendarItemExternalIdentifier
    do {
      if let event = item as? EKEvent { try ek.remove(event, span: .thisEvent, commit: true) }
      else if let reminder = item as? EKReminder { try ek.remove(reminder, commit: true) }
      else { return false }
      ownership.entries.removeAll { $0.containerID == containerID &&
        ($0.itemID == itemID || ($0.externalID != nil && $0.externalID == externalID)) }
      saveOwnership()
      return true
    } catch { NSLog("Kier phone: PHONE_REMOVE_FAILED"); return false }
  }

  // Each carries its Kier link, which is how the next look finds it.
  private func create(_ item: Item, calendar: EKCalendar?, list: EKCalendar?) -> Bool {
    if item.kind == "event", item.start != nil, let calendar {
      let event = EKEvent(eventStore: ek)
      event.calendar = calendar
      fill(event, item)
      event.url = Self.link(item.id)
      event.addAlarm(EKAlarm(relativeOffset: -30 * 60))
      do { try ek.save(event, span: .thisEvent, commit: true) } catch { NSLog("Kier phone: PHONE_EVENT_SAVE_FAILED"); return false }
      record(event, logicalID: item.id, kind: "event")
      return true
    }
    if item.kind == "reminder", item.due != nil, let list {
      let reminder = EKReminder(eventStore: ek)
      reminder.calendar = list
      fill(reminder, item)
      reminder.url = Self.link(item.id)
      do { try ek.save(reminder, commit: true) } catch { NSLog("Kier phone: PHONE_REMINDER_SAVE_FAILED"); return false }
      record(reminder, logicalID: item.id, kind: "reminder")
      return true
    }
    return false
  }

  // The same thing said again with a new time or wording updates it in place.
  private func update(_ existing: EKCalendarItem, _ item: Item) {
    guard owns(existing) else { return }
    if let event = existing as? EKEvent, let start = item.start {
      guard event.title != item.title || event.startDate != Date(timeIntervalSince1970: start) else { return }
      fill(event, item)
      try? ek.save(event, span: .thisEvent, commit: true)
    } else if let reminder = existing as? EKReminder {
      guard reminder.title != item.title || !same(reminder.dueDateComponents, dueParts(item)) else { return }
      fill(reminder, item)
      try? ek.save(reminder, commit: true)
    }
  }

  private func fill(_ event: EKEvent, _ item: Item) {
    let start = Date(timeIntervalSince1970: item.start ?? 0)
    event.title = item.title
    event.notes = item.notes
    event.startDate = start
    event.endDate = Date(timeIntervalSince1970: item.end ?? (item.start ?? 0) + 3600)
  }

  // Due that day, with an alert at its own time or else at 9 in the morning; none once that has passed, so a reminder
  // made in the evening doesn't ring the moment it lands.
  private func fill(_ reminder: EKReminder, _ item: Item) {
    reminder.title = item.title
    reminder.notes = item.notes
    reminder.dueDateComponents = dueParts(item)
    reminder.alarms?.forEach { reminder.removeAlarm($0) }
    var at = dueParts(item) ?? DateComponents()
    if at.hour == nil { at.hour = 9; at.minute = 0 }
    if let when = Calendar.current.date(from: at), when > Date() { reminder.addAlarm(EKAlarm(absoluteDate: when)) }
  }

  // Apple's stored date carries its own calendar and time zone, so only what Kier sets is compared.
  private func same(_ a: DateComponents?, _ b: DateComponents?) -> Bool {
    a?.year == b?.year && a?.month == b?.month && a?.day == b?.day && a?.hour == b?.hour && a?.minute == b?.minute
  }

  private func dueParts(_ item: Item) -> DateComponents? {
    guard let due = item.due else { return nil }
    let d = due.split(separator: "-").compactMap { Int($0) }
    guard d.count == 3 else { return nil }
    var parts = DateComponents(calendar: Calendar.current, year: d[0], month: d[1], day: d[2])
    if let time = item.time {
      let t = time.split(separator: ":").compactMap { Int($0) }
      if t.count == 2 { parts.hour = t[0]; parts.minute = t[1] }
    }
    return parts
  }

  // Kier's own calendar and list, in the account new events and reminders go to (iCloud, usually), made once.
  private func kierCalendar(_ type: EKEntityType) -> EKCalendar? {
    let key = type == .event ? "kierPhoneCalendar" : "kierPhoneList"
    if let id = defaults.string(forKey: key), ownership.containers.contains(id),
       let found = ek.calendar(withIdentifier: id) { return found }
    // Legacy IDs and title matches are not proof of creation. Leave those containers
    // and all their entries untouched; future sync uses a newly created container.
    // Prefer iCloud for device sync, then the default account, then any account accepting a new calendar.
    // Some accounts refuse calendar creation with EKError 17.
    let fallback = type == .event ? ek.defaultCalendarForNewEvents?.source : ek.defaultCalendarForNewReminders()?.source
    let icloud = ek.sources.filter { $0.sourceType == .calDAV && $0.title.localizedCaseInsensitiveContains("icloud") }
    let others = ek.sources.filter { [.calDAV, .exchange, .local].contains($0.sourceType) }
    var tried = Set<String>()
    for source in icloud + [fallback].compactMap({ $0 }) + others where tried.insert(source.sourceIdentifier).inserted {
      let made = EKCalendar(for: type, eventStore: ek)
      made.title = "Kier"
      made.source = source
      made.cgColor = NSColor(red: 0.45, green: 0.47, blue: 0.95, alpha: 1).cgColor
      do {
        try ek.saveCalendar(made, commit: true)
        ownership.containers.insert(made.calendarIdentifier)
        saveOwnership()
        defaults.set(made.calendarIdentifier, forKey: key)
        return made
      } catch {
        NSLog("Kier phone: PHONE_CONTAINER_SAVE_FAILED")
      }
    }
    return nil
  }

  // EventKit cannot provide an exhaustive inventory of an event calendar across all
  // dates (event predicates have bounded ranges). Retain that container even after
  // removing our known events. Reminder lists support a complete inventory.
  private func removeKier(_ type: EKEntityType) async {
    guard type == .event ? Self.eventsAllowed : Self.remindersAllowed else { return }
    let key = type == .event ? "kierPhoneCalendar" : "kierPhoneList"
    let kind = type == .event ? "event" : "reminder"
    let entries = ownership.entries.filter { $0.kind == kind }
    for entry in entries {
      var candidates: [EKCalendarItem] = []
      if let item = ek.calendarItem(withIdentifier: entry.itemID) { candidates.append(item) }
      if let external = entry.externalID { candidates += ek.calendarItems(withExternalIdentifier: external) }
      for item in candidates where owns(item) { remove(item) }
    }
    if let id = defaults.string(forKey: key), ownership.containers.contains(id), let container = ek.calendar(withIdentifier: id) {
      if type == .reminder,
         let remaining = await fetchReminders(ek.predicateForReminders(in: [container])),
         ownership.canDeleteContainer(id, remaining: remaining.count, completeInventory: true) {
        do {
          try ek.removeCalendar(container, commit: true)
          ownership.containers.remove(id)
          defaults.removeObject(forKey: key)
          saveOwnership()
        } catch { NSLog("Kier phone: PHONE_CONTAINER_REMOVE_FAILED") }
      }
    }
    let made = (defaults.stringArray(forKey: "kierPhoneMadeV1") ?? []).filter { id in
      !entries.contains { $0.logicalID == id }
    }
    defaults.set(made, forKey: "kierPhoneMadeV1")
  }

  // Read dated reminders from every list except Kier’s when enabled. Completion is synchronized both
  // ways using the reminder’s stable iCloud identifier.
  private func syncMine() async -> Bool {
    let kier = defaults.string(forKey: "kierPhoneList")
    let lists = ek.calendars(for: .reminder).filter { $0.calendarIdentifier != kier }
    guard !lists.isEmpty else { return true }
    let day = Calendar.current.startOfDay(for: Date())
    // A read that failed sends nothing: an empty answer would read as every reminder deleted.
    guard let open = await fetchReminders(ek.predicateForIncompleteReminders(withDueDateStarting: day.addingTimeInterval(-30 * 86400), ending: day.addingTimeInterval(61 * 86400), calendars: lists)),
          let closed = await fetchReminders(ek.predicateForCompletedReminders(withCompletionDateStarting: Date().addingTimeInterval(-3 * 86400), ending: Date(), calendars: lists))
    else { return false }
    let rows: [[String: Any]] = (open + closed).compactMap { r in
      guard let title = r.title, !title.isEmpty, let parts = r.dueDateComponents, let y = parts.year, let m = parts.month, let d = parts.day else { return nil }
      var row: [String: Any] = ["id": Self.key(r), "title": title, "due": String(format: "%04d-%02d-%02d", y, m, d), "list": r.calendar?.title ?? "Reminders",
                                "created": (r.creationDate ?? Date()).timeIntervalSince1970, "done": r.isCompleted]
      if let h = parts.hour, let min = parts.minute { row["time"] = String(format: "%02d:%02d", h, min) }
      if let c = r.completionDate { row["completed"] = c.timeIntervalSince1970 }
      return row
    }
    guard let answer: Mine = await send("/api/reminders", ["reminders": rows]) else { return false }
    // Older daemons did not distinguish model verdicts from owner completion. Fail closed.
    for r in open where answer.completionPolicy == "owner-verified" && answer.close.contains(Self.key(r)) { r.isCompleted = true; try? ek.save(r, commit: true) }
    for r in closed where answer.reopen.contains(Self.key(r)) { r.isCompleted = false; try? ek.save(r, commit: true) }
    return true
  }

  private static func key(_ r: EKReminder) -> String { r.calendarItemExternalIdentifier ?? r.calendarItemIdentifier }

  private func fetchReminders(_ predicate: NSPredicate) async -> [EKReminder]? {
    await withCheckedContinuation { done in ek.fetchReminders(matching: predicate) { found in done.resume(returning: found) } }
  }

  private func send<T: Decodable>(_ path: String, _ body: [String: Any]) async -> T? {
    guard let url = URL(string: base + path) else { return nil }
    var request = daemonRequest(url)
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "content-type")
    request.httpBody = try? JSONSerialization.data(withJSONObject: body)
    guard let (data, _) = try? await daemonClient.data(for: request) else { return nil }
    return try? JSONDecoder().decode(T.self, from: data)
  }

  private func fetch<T: Decodable>() async -> T? {
    guard let url = URL(string: base + "/api/phone"), let (data, _) = try? await daemonClient.data(for: daemonRequest(url)) else { return nil }
    return try? JSONDecoder().decode(T.self, from: data)
  }

  private func post(_ path: String, _ body: [String: Any]) async {
    guard let url = URL(string: base + path) else { return }
    var request = daemonRequest(url)
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "content-type")
    request.httpBody = try? JSONSerialization.data(withJSONObject: body)
    _ = try? await daemonClient.data(for: request)
  }
}
