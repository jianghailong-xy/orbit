import Foundation

// The message telling a coordinator its project was started, as the control plane recorded it
// beside the turn's echo (`projectStarted`, apiserver `projects/project-started.ts`).
//
// The message itself is prose written for the AGENT — tool names, ids, `autoRunWhenReady` — and
// drawn as a message it fills a phone screen in the reader's own name. A person watching needs
// three facts from it: how the project was started, which project, and which of its tasks now wait
// on the coordinator. The web reads the same payload with `parseProjectStarted`
// (src/web/src/lib/projectStarted.ts) and draws it as `ProjectStartedCard.tsx`; this is that rule for
// iOS and macOS. A payload that is not a card parses as NOTHING rather than as half a card, which
// leaves a message with no payload (every one stored before this existed) drawn as it was.
// `ProjectStartedCopyParityTests` holds the words to the web's. Nothing here is derived from the prose.

/// How the project was started: "Start the project" (the owner confirming the criteria), or the
/// project page's Automatic switch.
public enum ProjectStartedBy: String, Sendable, Equatable, Codable {
    case confirmation = "CONFIRMATION"
    case `switch` = "SWITCH"
}

/// An open task nothing starts but the coordinator.
public struct ProjectStartedTask: Sendable, Equatable, Codable {
    public let id: String
    public let title: String

    public init(id: String, title: String) {
        self.id = id
        self.title = title
    }
}

/// One project start, as the control plane recorded it — a snapshot of what the platform knew when
/// the message reached the conversation. Mirrors `@orbit/shared`'s `ProjectStartedCard`.
public struct ProjectStarted: Sendable, Equatable, Codable {
    public let by: ProjectStartedBy
    /// The project, in the uuid spelling every other read of one uses.
    public let projectId: String
    public let projectTitle: String
    /// How many criteria the confirmation named; nil for the switch, which confirmed nothing.
    public let criteriaCount: Int?
    /// The waiting tasks the message listed, oldest first.
    public let held: [ProjectStartedTask]
    /// How many wait in all — never fewer than `held` lists.
    public let heldCount: Int

    public init(by: ProjectStartedBy, projectId: String, projectTitle: String,
                criteriaCount: Int? = nil, held: [ProjectStartedTask] = [], heldCount: Int? = nil) {
        self.by = by
        self.projectId = projectId
        self.projectTitle = projectTitle
        self.criteriaCount = criteriaCount
        self.held = held
        self.heldCount = max(heldCount ?? 0, held.count)
    }

    /// The card a `user` event's payload carries, or nil for every other turn.
    public static func parse(_ payload: JSONValue) -> ProjectStarted? {
        parseCard(payload["projectStarted"])
    }

    /// The same reading for the card itself: the queued-turn projection
    /// (`QueuedTurnInfo.projectStarted`) hands over the object the echo would carry under that key,
    /// and one function reads both, so the card drawn while the message waits is the one the echo
    /// is drawn as. How it was started and which project are what make it one.
    public static func parseCard(_ value: JSONValue?) -> ProjectStarted? {
        guard case .object(let card)? = value,
              let raw = card["by"]?.stringValue, let by = ProjectStartedBy(rawValue: raw),
              let projectId = card["projectId"]?.stringValue, !projectId.isEmpty,
              let projectTitle = card["projectTitle"]?.stringValue else { return nil }
        var held: [ProjectStartedTask] = []
        if case .array(let rows)? = card["held"] {
            held = rows.compactMap { row in
                guard case .object(let task) = row,
                      let id = task["id"]?.stringValue, !id.isEmpty,
                      let title = task["title"]?.stringValue else { return nil }
                return ProjectStartedTask(id: id, title: title)
            }
        }
        return ProjectStarted(by: by, projectId: projectId, projectTitle: projectTitle,
                              criteriaCount: count(card["criteriaCount"]), held: held,
                              heldCount: count(card["heldCount"]))
    }

    private static func count(_ value: JSONValue?) -> Int? {
        guard let n = value?.intValue, n >= 0 else { return nil }
        return n
    }
}

/// What the card says, in the web's own words: `ProjectStartedCard.tsx`, which
/// `ProjectStartedCopyParityTests` holds the other end to.
public enum ProjectStartedCard {
    /// How many waiting tasks the card lists before folding the rest away.
    public static let tasksShown = 3

    public static let startedLabel = "Project started"
    public static let switchedOnLabel = "Project switched on"
    public static let kindConfirmation = "Criteria confirmed"
    public static let kindSwitch = "Automatic on"
    /// What the card says when no task waits on the coordinator.
    public static let noneHeld = "Every open task starts on its own."
    public static let notification = "a notification, not an interruption"
    public static let undelivered = "The session has not confirmed it received this."
    /// The fold the words the agent read stay behind.
    public static let told = "What the coordinator was told"
    public static let showFewer = "Show fewer"

    public static func label(_ by: ProjectStartedBy) -> String {
        by == .confirmation ? startedLabel : switchedOnLabel
    }

    /// The chip beside the label: what the press was.
    public static func kind(_ by: ProjectStartedBy) -> String {
        by == .confirmation ? kindConfirmation : kindSwitch
    }

    /// The line over the waiting tasks.
    public static func heldLead(_ count: Int) -> String {
        count == 1
            ? "1 task is set to start by hand, so it waits for the coordinator:"
            : "\(count) tasks are set to start by hand, so they wait for the coordinator:"
    }

    /// Who started it and how, as the foot line opens.
    public static func startedBy(_ card: ProjectStarted) -> String {
        if card.by == .switch { return "Switched on by you" }
        guard let criteria = card.criteriaCount else { return "Started by you" }
        return criteria == 1
            ? "Started by you, confirming 1 criterion"
            : "Started by you, confirming \(criteria) criteria"
    }

    public static func showMore(_ count: Int) -> String { "Show \(count) more" }

    /// The waiting tasks beyond the ones the message listed, which only the project page names.
    public static func moreInProject(_ count: Int) -> String { "\(count) more in the project ↗" }

    /// "Show 5 more" / "Show fewer" — nil when every listed task is already on screen.
    public static func tasksToggle(_ card: ProjectStarted, expanded: Bool) -> String? {
        guard card.held.count > tasksShown else { return nil }
        return expanded ? showFewer : showMore(card.held.count - tasksShown)
    }

    /// "Started by you, confirming 8 criteria · a notification, not an interruption · 3m ago".
    public static func meta(_ card: ProjectStarted, ts: String? = nil, now: Date = Date()) -> String {
        var line = "\(startedBy(card)) · \(notification)"
        if let ts, let relative = RelativeTime.format(ts, now: now) { line += " · \(relative)" }
        return line
    }

    /// What the bar pinned to the top of a console says about this turn — the card's own words,
    /// as the web's `data-sticky-label` / `data-sticky-text` say them.
    public static func sticky(_ card: ProjectStarted) -> (label: String, text: String) {
        (label(card.by), card.projectTitle)
    }

    /// A waiting task, as the app's own `orbit-task:` door; nil for an id that names no task.
    public static func taskLink(_ task: ProjectStartedTask) -> URL? { link(task.id, scheme: "orbit-task") }

    /// The project, for the tasks the message did not list.
    public static func projectLink(_ card: ProjectStarted) -> URL? {
        link(card.projectId, scheme: "orbit-project")
    }

    private static func link(_ id: String, scheme: String) -> URL? {
        guard PublicID.toUUID(id) != nil else { return nil }
        return URL(string: "\(scheme):\(id)")
    }
}
