import Foundation

/* ─────────────────────────────────────────────────────────────────────────────────────────────
   WHO SET THE LANDING CHECK, THE TASK EXEMPTION, AND THE COORDINATOR'S CHANGES
   ─────────────────────────────────────────────────────────────────────────────────────────────

   Contract revision 42, part two (docs/project-integration-line-contract.md §12.15 P-C1, P-C2,
   P-R1, read model §12.16), drawn as the owner ruled on docs/mocks/landing-measured (D3–D7, D9,
   2026-11-20):

   - D3/D9: the project's landing check carries who set it last — You, Coordinator, Approved on a
     card, Set at start — and when, one line under the command.
   - D4: three values, not two: the merge check (no command), a command, or No check.
   - D5: a task exempt from the landing check says so in its Landing section, with the reason and
     who marked it; the landing's check list reads the check Skipped, never failed.
   - D6/D7: the coordinator's cardless changes are one page under Settings, newest first; the owner
     reverts a change that is still the field's value, after a confirmation that says what follows.

   Every field read here is new on the wire and optional: an older server draws today's page.
   Nothing here decides whether a project has code — the line and the checks are the server's facts.
   ───────────────────────────────────────────────────────────────────────────────────────────── */

// MARK: - the wire

/// `integration.landingCheck` on `GET /projects/:id` and `GET /projects/:id/integration` (§12.16).
public struct ProjectLandingCheck: Codable, Equatable, Sendable {
    /// The command; `NONE` when the project runs no landing check; nil when it falls back to the
    /// merge check.
    public let command: String?
    /// `OWNER`, `CARD`, `START` or `COORDINATOR`; nil when nobody has written it.
    public let setBy: String?
    public let setBySessionId: String?
    /// When it was last written; nil when nobody has, or for a value from before the record.
    public let setAt: String?

    public init(command: String? = nil, setBy: String? = nil, setBySessionId: String? = nil,
                setAt: String? = nil) {
        self.command = command
        self.setBy = setBy
        self.setBySessionId = setBySessionId
        self.setAt = setAt
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        command = try? c.decodeIfPresent(String.self, forKey: .command)
        setBy = try? c.decodeIfPresent(String.self, forKey: .setBy)
        setBySessionId = try? c.decodeIfPresent(String.self, forKey: .setBySessionId)
        setAt = try? c.decodeIfPresent(String.self, forKey: .setAt)
    }
}

/// One value a recorded change moved: the project's landing check, or one task's exemption.
public struct SettingChangeValue: Codable, Equatable, Sendable {
    // LANDING_CHECK
    public let command: String?
    public let timeoutSeconds: Int?
    public let none: Bool
    // TASK_LANDING_CHECK_EXEMPT
    public let exempt: Bool?
    public let reason: String?

    public init(command: String? = nil, timeoutSeconds: Int? = nil, none: Bool = false,
                exempt: Bool? = nil, reason: String? = nil) {
        self.command = command
        self.timeoutSeconds = timeoutSeconds
        self.none = none
        self.exempt = exempt
        self.reason = reason
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        command = try? c.decodeIfPresent(String.self, forKey: .command)
        timeoutSeconds = try? c.decodeIfPresent(Int.self, forKey: .timeoutSeconds)
        none = ((try? c.decodeIfPresent(Bool.self, forKey: .none)) ?? nil) ?? false
        exempt = try? c.decodeIfPresent(Bool.self, forKey: .exempt)
        reason = try? c.decodeIfPresent(String.self, forKey: .reason)
    }
}

/// One entry of `GET /projects/:id`'s `settingChanges`, newest first (§12.15 P-R1).
public struct ProjectSettingChange: Codable, Equatable, Sendable, Identifiable {
    public let id: String
    public let taskId: String?
    /// `LANDING_CHECK` or `TASK_LANDING_CHECK_EXEMPT`.
    public let field: String
    /// `COORDINATOR`, `OWNER` or `CARD`.
    public let origin: String
    public let oldValue: SettingChangeValue
    public let newValue: SettingChangeValue
    public let reason: String?
    public let writtenBySessionId: String?
    /// On an owner's revert, the change it put back.
    public let revertsChangeId: String?
    /// When an owner's revert put this change back.
    public let revertedAt: String?
    /// Whether Revert is offered: a coordinator change nothing reverted, still the field's value.
    public let revertible: Bool
    public let createdAt: String

    public init(id: String, taskId: String? = nil, field: String, origin: String,
                oldValue: SettingChangeValue, newValue: SettingChangeValue, reason: String? = nil,
                writtenBySessionId: String? = nil, revertsChangeId: String? = nil,
                revertedAt: String? = nil, revertible: Bool = false, createdAt: String) {
        self.id = id
        self.taskId = taskId
        self.field = field
        self.origin = origin
        self.oldValue = oldValue
        self.newValue = newValue
        self.reason = reason
        self.writtenBySessionId = writtenBySessionId
        self.revertsChangeId = revertsChangeId
        self.revertedAt = revertedAt
        self.revertible = revertible
        self.createdAt = createdAt
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        taskId = try? c.decodeIfPresent(String.self, forKey: .taskId)
        field = try c.decode(String.self, forKey: .field)
        // A server from before the origin column only recorded the coordinator's writes.
        origin = ((try? c.decodeIfPresent(String.self, forKey: .origin)) ?? nil) ?? "COORDINATOR"
        oldValue = (try? c.decode(SettingChangeValue.self, forKey: .oldValue)) ?? SettingChangeValue()
        newValue = (try? c.decode(SettingChangeValue.self, forKey: .newValue)) ?? SettingChangeValue()
        reason = try? c.decodeIfPresent(String.self, forKey: .reason)
        writtenBySessionId = try? c.decodeIfPresent(String.self, forKey: .writtenBySessionId)
        revertsChangeId = try? c.decodeIfPresent(String.self, forKey: .revertsChangeId)
        revertedAt = try? c.decodeIfPresent(String.self, forKey: .revertedAt)
        revertible = ((try? c.decodeIfPresent(Bool.self, forKey: .revertible)) ?? nil) ?? false
        createdAt = (try? c.decode(String.self, forKey: .createdAt)) ?? ""
    }
}

// MARK: - the words

/// The board's words (docs/mocks/landing-measured 03–05), held to web's `lib/landingCheck.ts`
/// (`LANDING_MODE_COPY`, `LANDING_CHECK_ORIGIN_COPY`, `CHANGES_COPY`, `TASK_EXEMPT_COPY`) by
/// `LandingCheckTests.testEveryWebCopyKeyHasAnExactNativeCounterpart`.
public enum LandingProvenanceCopy {
    // Who set it (D3, D9).
    public static let you = "You"
    public static let coordinator = "Coordinator"
    public static let card = "Approved on a card"
    public static let start = "Set at start"
    /// "set 12m ago"
    public static func setAgo(_ ago: String) -> String { "set \(ago)" }
    /// "marked 20m ago" — a task's exemption.
    public static func markedAgo(_ ago: String) -> String { "marked \(ago)" }

    // The three values (D4).
    public static let modeMergeCheck = "Merge check"
    public static let modeCommand = "Command"
    public static let modeNone = "No check"
    public static let noneLead = "No check."
    public static let noneBody = "Tasks land with only their own acceptance. The merge check still runs before main."
    /// Where the coordinator's changes are listed.
    public static let commandNote = "Changes the coordinator makes are listed under Coordinator’s changes."
    /// Under a command the coordinator set.
    public static let coordinatorHint = "\(LandingCheckCopy.hint) \(commandNote)"
    /// The board's explanation of the four badges; web keeps the words, neither client draws it.
    public static let whoCanSet = "Who can set it"
    /// Under "Who can set it": each badge and what it means, in web's order and words
    /// (`LANDING_CHECK_ORIGIN_NOTES`). `kind` is the badge's, as `ProvenanceBadge` draws it.
    public struct OriginNote: Equatable, Sendable, Identifiable {
        public let by: String
        public let kind: String
        public let label: String
        public let note: String
        public var id: String { by }
    }
    public static let originNotes: [OriginNote] = [
        OriginNote(by: "OWNER", kind: "you", label: you,
                   note: "Anything you set; the coordinator then needs a card to change it."),
        OriginNote(by: "COORDINATOR", kind: "coordinator", label: coordinator,
                   note: "No card, while the merge check exists."),
        OriginNote(by: "CARD", kind: "card", label: card, note: "A change you confirmed on a card."),
        OriginNote(by: "START", kind: "start", label: start,
                   note: "The coordinator proposed it and you pressed Start; it may still change without a card. A value you typed on the start card reads as You."),
    ]
    /// The link an exemption row in the change list carries to its task.
    public static let openTask = "Open task"

    // The change list (D6, D7).
    public static let changesTitle = "Coordinator’s changes"
    public static let changesIntro = "What the coordinator changed on its own since the project started. "
        + "Revert puts the old value back and takes the field away from the coordinator: it needs a card from then on."
    public static func changesCount(_ count: Int) -> String { count == 1 ? "1 change" : "\(count) changes" }
    public static let noChanges = "The coordinator has not changed anything on its own."
    public static let landingCheck = "Landing check"
    public static let checkExemptHead = "Check exempt"
    public static func checkExempt(_ task: String) -> String { "\(checkExemptHead) · \(task)" }
    public static let exemptValue = "exempt"
    public static let notExemptValue = "not exempt"
    public static let usesMergeCheck = "Uses merge check"
    public static let revert = "Revert"
    public static let cancel = "Cancel"
    public static let yourChangeHead = "Your change"
    public static let yourChange = "Your change · nothing to revert"
    public static func revertedByYou(_ ago: String) -> String {
        "Reverted by you · \(ago) · coordinator needs a card for this field"
    }
    public static let revertTitle = "Revert this change?"
    public static let revertAfter = "The coordinator can no longer change this field without a card."

    // The task's exemption (D5).
    public static let exempt = "Exempt"
    public static let removeExemption = "Remove exemption"
    public static let skipped = "Skipped"
    /// "Landing check · Skipped"
    public static let checkSkipped = "\(landingCheck) · \(skipped)"
    public static func exemptBecause(_ reason: String) -> String { "Exempt: \(reason)" }
    /// Under a skipped landing check: the merge check still runs on the way into main (board 04 b).
    public static let mergeCheckStillRuns = "Merge check before main"
    public static let stillRuns = "Still runs"
    /// "Landing check skipped" — the Landing section's fact line.
    public static let landingCheckSkipped = "Landing check skipped"
}

// MARK: - the landing check in Settings

/// The project's landing check as Settings draws it: which of the three values, the command, and
/// who set it and when.
public struct LandingCheckSetting: Equatable, Sendable {
    public enum Mode: String, CaseIterable, Equatable, Sendable {
        case mergeCheck, command, none

        public var label: String {
            switch self {
            case .mergeCheck: return LandingProvenanceCopy.modeMergeCheck
            case .command: return LandingProvenanceCopy.modeCommand
            case .none: return LandingProvenanceCopy.modeNone
            }
        }
    }

    public struct Origin: Equatable, Sendable {
        /// `you`, `coordinator`, `card`, `start`: the badge's ink.
        public let kind: String
        public let label: String
        /// "set 12m ago"; nil when the server keeps no time for it.
        public let when: String?
    }

    public let mode: Mode
    /// The command, for `.command`.
    public let command: String?
    public let origin: Origin?

    /// Read off the integration view: the new `landingCheck` where the server sends it, else the two
    /// fields every server has (`landingCheckCommand`, `landingCheckCommandAbsentReason`).
    public static func of(_ view: ProjectIntegrationView, now: Date = Date()) -> LandingCheckSetting {
        let check = view.landingCheck
        // Where the server sends `landingCheck`, it decides, a null command included (web's
        // `landingCheckModeOf`); the older field is read only without it.
        let command: String? = check.map { $0.command } ?? view.landingCheckCommand
        let mode: Mode
        if command == "NONE" || view.landingCheckCommandAbsentReason == "NONE" {
            mode = .none
        } else if let command, !command.isEmpty {
            mode = .command
        } else {
            mode = .mergeCheck
        }
        return LandingCheckSetting(mode: mode, command: mode == .command ? command : nil,
                                   origin: origin(check, now: now))
    }

    static func origin(_ check: ProjectLandingCheck?, now: Date) -> Origin? {
        guard let check, let by = check.setBy else { return nil }
        let when = check.setAt.flatMap { RelativeTime.ago($0, now: now) }.map(LandingProvenanceCopy.setAgo)
        switch by {
        case "OWNER": return Origin(kind: "you", label: LandingProvenanceCopy.you, when: when)
        case "COORDINATOR": return Origin(kind: "coordinator", label: LandingProvenanceCopy.coordinator, when: when)
        case "CARD": return Origin(kind: "card", label: LandingProvenanceCopy.card, when: when)
        case "START": return Origin(kind: "start", label: LandingProvenanceCopy.start, when: when)
        default: return nil
        }
    }

    /// The owner's write for choosing a value: the merge check is a null command, No check is
    /// `landingCheck: NONE`; a command is typed in its editor.
    public static func write(_ mode: Mode) -> UpdateProjectIntegrationRequest? {
        switch mode {
        case .mergeCheck: return UpdateProjectIntegrationRequest(landingCheckCommand: .some(nil))
        case .none: return UpdateProjectIntegrationRequest(landingCheck: "NONE")
        case .command: return nil
        }
    }
}

// MARK: - the coordinator's changes

/// One row of the Coordinator's changes page.
public struct SettingChangeRow: Equatable, Sendable, Identifiable {
    public let id: String
    /// "Landing check", or "Check exempt · Move cron jobs…".
    public let title: String
    /// "12m ago"
    public let when: String?
    /// The old value, drawn struck through; `oldIsCode` draws it in the mono face.
    public let old: String
    public let oldIsCode: Bool
    public let new: String
    public let newIsCode: Bool
    public let reason: String?
    /// `coordinator`, `you` or `card`: the badge.
    public let originKind: String
    public let originLabel: String
    /// Revert is offered.
    public let revertible: Bool
    /// What stands beside the badge where no Revert is: "Your change · nothing to revert", or
    /// "Reverted by you · just now · coordinator needs a card for this field".
    public let note: String?
    /// The row was put back: drawn dimmed.
    public let reverted: Bool
    /// The task an exemption row is about, which the row opens ("Open task", as web's list links it).
    public var taskID: String? = nil
}

public enum CoordinatorChanges {
    /// The fields this build can say something true about. `field` stays a string, so a server that
    /// records a new one still decodes; its rows are left out rather than drawn as a landing check.
    public static let drawnFields: Set<String> = ["LANDING_CHECK", "TASK_LANDING_CHECK_EXEMPT"]

    /// The page's rows, newest first. The owner's revert is not a row of its own: it is the line on
    /// the change it put back.
    public static func rows(_ changes: [ProjectSettingChange], taskTitles: [String: String] = [:],
                            now: Date = Date()) -> [SettingChangeRow] {
        changes.filter { $0.revertsChangeId == nil && drawnFields.contains($0.field) }.map { change in
            let exempt = change.field == "TASK_LANDING_CHECK_EXEMPT"
            let title = exempt
                ? LandingProvenanceCopy.checkExempt(taskTitles[change.taskId ?? ""].map(shortTitle) ?? "a task")
                : LandingProvenanceCopy.landingCheck
            let old = value(change.oldValue, exempt: exempt)
            let new = value(change.newValue, exempt: exempt)
            let (kind, label): (String, String)
            switch change.origin {
            case "OWNER": (kind, label) = ("you", LandingProvenanceCopy.you)
            case "CARD": (kind, label) = ("card", LandingProvenanceCopy.card)
            default: (kind, label) = ("coordinator", LandingProvenanceCopy.coordinator)
            }
            let reverted = change.revertedAt != nil
            let note: String?
            if let at = change.revertedAt {
                note = LandingProvenanceCopy.revertedByYou(RelativeTime.ago(at, now: now) ?? "just now")
            } else if kind != "coordinator" {
                // The owner's own and the ones the owner approved on a card: nothing to revert (web's
                // `change.origin !== 'COORDINATOR'`).
                note = LandingProvenanceCopy.yourChange
            } else {
                note = nil
            }
            return SettingChangeRow(
                id: change.id, title: title, when: RelativeTime.ago(change.createdAt, now: now),
                old: old.text, oldIsCode: old.code, new: new.text, newIsCode: new.code,
                reason: change.reason.flatMap { $0.isEmpty ? nil : $0 },
                originKind: kind, originLabel: label,
                revertible: change.revertible && kind == "coordinator" && !reverted,
                note: note, reverted: reverted, taskID: exempt ? change.taskId : nil)
        }
    }

    /// How many rows the Settings entry counts.
    public static func count(_ changes: [ProjectSettingChange]) -> Int {
        changes.filter { $0.revertsChangeId == nil && drawnFields.contains($0.field) }.count
    }

    /// A value as the row says it: a command in the mono face, or the words for the other values.
    public static func value(_ value: SettingChangeValue, exempt: Bool) -> (text: String, code: Bool) {
        if exempt {
            return (value.exempt == true ? LandingProvenanceCopy.exemptValue : LandingProvenanceCopy.notExemptValue, false)
        }
        if value.none { return (LandingProvenanceCopy.modeNone, false) }
        if let command = value.command, !command.isEmpty { return (command, true) }
        return (LandingProvenanceCopy.usesMergeCheck, false)
    }

    /// The confirmation's first sentence: "Landing check goes back from No check to npm run
    /// check:landing." — the two values, as the row draws them.
    public static func revertSentence(_ change: ProjectSettingChange,
                                      taskTitles: [String: String] = [:]) -> (subject: String, from: String, to: String) {
        let exempt = change.field == "TASK_LANDING_CHECK_EXEMPT"
        let subject = exempt
            ? LandingProvenanceCopy.checkExempt(taskTitles[change.taskId ?? ""].map(shortTitle) ?? "a task")
            : LandingProvenanceCopy.landingCheck
        return (subject, value(change.newValue, exempt: exempt).text, value(change.oldValue, exempt: exempt).text)
    }

    /// The whole of it, for a reader who cannot see the faces.
    public static func revertText(_ change: ProjectSettingChange, taskTitles: [String: String] = [:]) -> String {
        let parts = revertSentence(change, taskTitles: taskTitles)
        return "\(parts.subject) goes back from \(parts.from) to \(parts.to)."
    }

    /// A long task title cut where the row's title would wrap: the board's "Move cron jobs…".
    static func shortTitle(_ title: String) -> String {
        let limit = 16
        guard title.count > limit else { return title }
        let cut = title.prefix(limit)
        let word = cut.lastIndex(of: " ").map { cut[..<$0] } ?? cut
        return word.trimmingCharacters(in: .whitespaces) + "…"
    }
}

// MARK: - a task's exemption

/// A task exempt from its project's landing check, as its Landing section draws it (D5).
public struct TaskLandingCheckExemption: Equatable, Sendable {
    public let reason: String
    /// `coordinator`, `card` or `you`, as `ProvenanceBadge` draws it.
    public let originKind: String
    public let originLabel: String
    /// "marked 20m ago"; nil when no time is known.
    public let when: String?

    /// Nil for a task that is not exempt, and from a server that does not say. `marked` is the
    /// project's record of the exemption (`marked(taskID:changes:)`), where the page has read it: who
    /// and when are the record's, as web's `TaskLandingExempt` reads them. With no record, the
    /// task's own fields say: a coordinator's mark names its session, the owner's its time.
    public static func of(_ task: TaskItem, marked: ProjectSettingChange? = nil,
                          now: Date = Date()) -> TaskLandingCheckExemption? {
        guard task.landingCheckExempt == true else { return nil }
        let kind: String
        let at: String?
        if let marked {
            kind = marked.origin == "COORDINATOR" ? "coordinator" : marked.origin == "CARD" ? "card" : "you"
            at = marked.createdAt
        } else {
            kind = task.landingCheckExemptBySessionId != nil ? "coordinator" : "you"
            at = kind == "you" ? task.landingCheckExemptOwnerSetAt : nil
        }
        let label = kind == "coordinator" ? LandingProvenanceCopy.coordinator
            : kind == "card" ? LandingProvenanceCopy.card : LandingProvenanceCopy.you
        return TaskLandingCheckExemption(
            reason: task.landingCheckExemptReason ?? "",
            originKind: kind,
            originLabel: label,
            when: at.flatMap { RelativeTime.ago($0, now: now) }.map(LandingProvenanceCopy.markedAgo))
    }

    /// Who marked it and when: the newest record (the list is newest first) of this task's
    /// exemption that set it and that no revert put back.
    public static func marked(taskID: String, changes: [ProjectSettingChange]) -> ProjectSettingChange? {
        changes.first {
            $0.field == "TASK_LANDING_CHECK_EXEMPT" && $0.taskId == taskID && $0.newValue.exempt == true
                && $0.revertedAt == nil
        }
    }

    /// The owner's Remove exemption.
    public static let removeRequest = UpdateTaskRequest(landingCheckExempt: false)
}

// MARK: - a skipped landing check in the landing's list

public enum LandingCheckSkip {
    /// The two skips a landing records in place of running the landing check: the repository's
    /// exempt paths (K2) and the task's exemption (P-C2). Neither is a failure.
    public static func isSkip(_ entry: IntegrationTimelineEntry) -> Bool {
        let skipped = entry.data?["skipped"]?.stringValue
        return skipped == "PATHS_EXEMPT" || skipped == "TASK_EXEMPT"
    }

    /// A TASK_EXEMPT skip's reason, "Exempt: …"; nil for any other line.
    public static func exemptLine(_ entry: IntegrationTimelineEntry) -> String? {
        guard entry.data?["skipped"]?.stringValue == "TASK_EXEMPT" else { return nil }
        let reason = entry.data?["reason"]?.stringValue ?? ""
        return LandingProvenanceCopy.exemptBecause(reason)
    }

    /// The step a TASK_EXEMPT skip is in: its row reads "Landing check · Skipped" with the reason.
    public static func taskExempt(_ step: LandingStep) -> IntegrationTimelineEntry? {
        guard step.key == "check:LANDING_CHECK" else { return nil }
        return step.entries.map(\.entry).last { $0.data?["skipped"]?.stringValue == "TASK_EXEMPT" }
    }

    /// Whether a finished check's line opens the tail it ended on, inline: a check that did not pass,
    /// unless it never ran because its task is exempt (web's `TimelineLine`) — there is no output to read.
    public static func showsInlineOutput(_ entry: IntegrationTimelineEntry) -> Bool {
        entry.kind == "CHECK_FINISHED" && entry.check != nil && !entry.checkPassed && exemptLine(entry) == nil
    }
}

/// How one step of a landing's check list reads (web's `StepStatus`): its mark and, when skipped,
/// "Landing check · Skipped" with "Exempt: <reason>".
public enum LandingStepStatus: Equatable, Sendable {
    case ok, failed, running, pending, skipped

    /// In web's order: a line that stopped short fails the step, even beside a skip; then a task's
    /// exempt landing check is skipped; then the last step runs or waits while its attempt does.
    public static func of(_ step: LandingStep, kind: String, isLast: Bool, live: Bool,
                          queued: Bool) -> LandingStepStatus {
        if LandingSteps.failed(step, kind: kind) { return .failed }
        if LandingCheckSkip.taskExempt(step) != nil { return .skipped }
        if isLast && live { return .running }
        if isLast && queued { return .pending }
        return .ok
    }

    /// The step's name: "Landing check · Skipped" for a skip, else its own.
    public static func name(_ step: LandingStep, _ status: LandingStepStatus) -> String {
        status == .skipped ? "\(step.name) · \(LandingProvenanceCopy.skipped)" : step.name
    }

    /// The step's summary: "Exempt: <reason>" for a skip, else its summary line's words.
    public static func summary(_ step: LandingStep, _ status: LandingStepStatus) -> String {
        if status == .skipped, let line = LandingCheckSkip.taskExempt(step).flatMap(LandingCheckSkip.exemptLine) {
            return line
        }
        return LandingCheckCopy.timelineText(step.summary)
    }
}

// MARK: - a project whose line has not started

extension ProjectPage {
    /// The server says the project has no line yet (§12.16: no code binding, so the integration
    /// read names none): its page draws no landing card, no Landings row and no landing segment
    /// (board D2). Read off the server's line alone — never off what the project looks like — and
    /// false while the read has not answered.
    public static func noLineYet(_ view: ProjectIntegrationView?) -> Bool {
        guard let view else { return false }
        return view.line == nil
    }
}
