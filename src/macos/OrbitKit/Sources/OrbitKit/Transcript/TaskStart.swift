import Foundation

// The turn that STARTS a task's run, as the control plane recorded it beside the echo (`taskStart`,
// apiserver `tasks/task-start-card.ts`).
//
// That turn is the brief written for the AGENT: the task's description and acceptance criteria, then
// four steps of protocol about which tools to call and which statuses never to write. Drawn as a
// message it was the account owner's own bubble — several screens on a phone — in front of the run's
// first action. The payload names the task the brief was built from, recorded only when the task's
// fields rebuild the delivered brief exactly, so everything a card says is what the agent was handed.
//
// The web reads the same payload with `parseTaskStartCard` (src/web/src/lib/taskStartCard.ts) and
// draws it as `TaskStartCard.tsx`. This is that rule for iOS and macOS: the same two fields that make
// a payload a card at all, the same defaults, and a payload that is not a card parses as NOTHING —
// which leaves every turn stored before the payload existed drawn exactly as it was.
// `TaskStartCopyParityTests` holds the two ends' words to each other. Nothing here is read out of the
// brief's text.

/// The judgment a task declares — who or what settles it.
public enum TaskStartCriterion: String, Sendable, Equatable, Codable, CaseIterable {
    case executable = "EXECUTABLE"
    case verification = "VERIFICATION"
    case evidenceJudgment = "EVIDENCE_JUDGMENT"
    case ownerConfirmed = "OWNER_CONFIRMED"
}

/// The project the task is filed under.
public struct TaskStartProject: Sendable, Equatable, Codable {
    public let id: String
    public let title: String

    public init(id: String, title: String) {
        self.id = id
        self.title = title
    }
}

/// A task run's opening turn, as the control plane recorded it. Mirrors `@orbit/shared`'s
/// `TaskStartCard`.
public struct TaskStart: Sendable, Equatable, Codable {
    /// The task, in the uuid spelling every other read of one uses.
    public let taskId: String
    public let title: String
    public let description: String?
    public let acceptanceCriteria: String?
    /// Nil on a row from before every door required a criterion, and for one this build does not know.
    public let completionCriterion: TaskStartCriterion?
    public let acceptanceCommand: String?
    public let acceptanceExpectedExitCode: Int?
    /// The list's standing instructions, when the brief carried them.
    public let listInstructions: String?
    public let project: TaskStartProject?
    /// Started by a schedule, a prerequisite finishing or a first run, rather than by a request.
    public let auto: Bool

    public init(taskId: String, title: String, description: String? = nil,
                acceptanceCriteria: String? = nil, completionCriterion: TaskStartCriterion? = nil,
                acceptanceCommand: String? = nil, acceptanceExpectedExitCode: Int? = nil,
                listInstructions: String? = nil, project: TaskStartProject? = nil, auto: Bool = false) {
        self.taskId = taskId
        self.title = title
        self.description = description
        self.acceptanceCriteria = acceptanceCriteria
        self.completionCriterion = completionCriterion
        self.acceptanceCommand = acceptanceCommand
        self.acceptanceExpectedExitCode = acceptanceExpectedExitCode
        self.listInstructions = listInstructions
        self.project = project
        self.auto = auto
    }

    /// The card a `user` event's payload carries, or nil for the ordinary case — every turn that is
    /// not a run's brief, and every brief stored before the payload existed.
    public static func parse(_ payload: JSONValue) -> TaskStart? {
        parseCard(payload["taskStart"])
    }

    /// A card names its task and what it is called: those two are what make it one, and a value
    /// missing either is not drawn at all — never half a card. Every other field defaults, exactly as
    /// the web's reader defaults it.
    public static func parseCard(_ value: JSONValue?) -> TaskStart? {
        guard case .object(let card)? = value,
              let taskId = nonEmptyString(card["taskId"]),
              let title = nonEmptyString(card["title"]) else { return nil }
        return TaskStart(
            taskId: taskId,
            title: title,
            description: nonEmptyString(card["description"]),
            acceptanceCriteria: nonEmptyString(card["acceptanceCriteria"]),
            completionCriterion: card["completionCriterion"]?.stringValue.flatMap(TaskStartCriterion.init),
            acceptanceCommand: nonEmptyString(card["acceptanceCommand"]),
            acceptanceExpectedExitCode: card["acceptanceExpectedExitCode"]?.intValue,
            listInstructions: nonEmptyString(card["listInstructions"]),
            project: project(card["project"]),
            auto: card["auto"]?.boolValue == true)
    }

    private static func nonEmptyString(_ value: JSONValue?) -> String? {
        guard let text = value?.stringValue, !text.isEmpty else { return nil }
        return text
    }

    private static func project(_ value: JSONValue?) -> TaskStartProject? {
        guard case .object(let fields)? = value,
              let id = nonEmptyString(fields["id"]),
              let title = fields["title"]?.stringValue else { return nil }
        return TaskStartProject(id: id, title: title)
    }
}

/// What the card says, in the web's own words: `lib/taskStartCard.ts`, which
/// `TaskStartCopyParityTests` holds this end to.
public enum TaskStartCard {
    /// The card's name, on its head and on the sticky bar that points back at it.
    public static let header = "Task started"
    /// The chip a run started by one of the automatic doors carries.
    public static let autoLabel = "Auto-started"
    public static let projectLabel = "Project"
    public static let showDetails = "Show details"
    public static let hideDetails = "Hide details"
    public static let criteriaHeading = "Acceptance criteria"
    public static let instructionsHeading = "List instructions"
    public static let showCommand = "Show full command"
    public static let hideCommand = "Show less"
    public static let openTask = "Open the task ↗"
    /// The fold the brief the agent read stays behind.
    public static let rawSummary = "What the agent was told"
    public static let undelivered = "The session has not confirmed it received this."

    /// The judgment the task declared, in the words the task panel's chip already uses
    /// (`TaskJudgmentCopy.completionCriterionChip`); nil when it declared none.
    public static func judgedBy(_ card: TaskStart) -> String? {
        card.completionCriterion.flatMap { TaskJudgmentCopy.completionCriterionChip[$0.rawValue] }
    }

    /// What the declared judgment means for this run, in one line.
    public static func judgedHow(_ card: TaskStart) -> String? {
        switch card.completionCriterion {
        case .executable:
            return "Runs after each turn: exit \(card.acceptanceExpectedExitCode ?? 0) → Done, else Failed."
        case .ownerConfirmed:
            return "You confirm it in Orbit once the run says it is done — or send it back."
        case .evidenceJudgment:
            return "The run submits evidence; an independent session confirms it."
        case .verification:
            return "A separate verification task judges the work; this run does not settle it."
        case nil:
            return nil
        }
    }

    /// The command that judges the run, when it is an EXECUTABLE one.
    public static func command(_ card: TaskStart) -> String? {
        card.completionCriterion == .executable ? card.acceptanceCommand : nil
    }

    /// Past about this many characters a description no longer fits the three lines it is folded to.
    static let descriptionFoldChars = 140

    /// Whether the description is folded to three lines while the card is shut. One that fits is
    /// drawn whole — fading out a sentence that ends there would promise more that is not there.
    public static func foldsDescription(_ card: TaskStart) -> Bool {
        guard let description = card.description else { return false }
        return description.contains("\n") || description.count > descriptionFoldChars
    }

    /// Whether anything is behind "Show details": the criteria and the list's instructions are only
    /// drawn open, a command is clamped until then, and a long description is folded.
    public static func hasDetails(_ card: TaskStart) -> Bool {
        card.acceptanceCriteria != nil
            || card.listInstructions != nil
            || command(card) != nil
            || foldsDescription(card)
    }

    /// "Task 34TcwNgAIo6tGUiIKjqnQ · just now" — the task in the public spelling the web draws it in.
    public static func meta(_ card: TaskStart, ts: String? = nil, now: Date = Date()) -> String {
        var line = "Task \(PublicID.toPublic(card.taskId))"
        if let ts, let relative = RelativeTime.format(ts, now: now) { line += " · \(relative)" }
        return line
    }

    /// What the bar pinned to the top of a console says about this turn: the card's own name and the
    /// task's title (web parity: the `data-sticky-label` / `data-sticky-text` the card's root carries).
    public static func sticky(_ card: TaskStart) -> (label: String, text: String) {
        (header, card.title)
    }

    /// The task, as the app's own `orbit-task:` door.
    public static func taskLink(_ card: TaskStart) -> URL? {
        link(card.taskId, scheme: "orbit-task")
    }

    /// The project the task is filed under, as the app's own `orbit-project:` door.
    public static func projectLink(_ card: TaskStart) -> URL? {
        link(card.project?.id, scheme: "orbit-project")
    }

    private static func link(_ id: String?, scheme: String) -> URL? {
        guard let id, PublicID.toUUID(id) != nil else { return nil }
        return URL(string: "\(scheme):\(id)")
    }
}
