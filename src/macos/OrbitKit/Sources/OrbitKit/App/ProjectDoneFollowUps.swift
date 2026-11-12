import Foundation

/* ─────────────────────────────────────────────────────────────────────────────────────────────
   THE DONE CARD'S FOLLOW-UPS — THIS CLIENT'S HALF OF THE SECOND PART OF WEB'S `lib/projectDone.ts`
   ─────────────────────────────────────────────────────────────────────────────────────────────

   What the decided board (01-done-card-landing) and the follow-up boards
   (docs/mocks/project-done-followups/01–03) added to "Is this project done?" and the project page:

   - THE NON-CODE MARK. Set by the coordinator (`project_update`) or the owner (How it runs'
     Delivers row), never inferred. A marked project reads no landing: the card says so in a banner,
     its rows and tallies carry no landing words, and the check finds no unlanded criterion.
   - NO_BRANCH. In a project that is not marked, serving work that ran without a branch is its own
     reason — "Ran without a branch", a yellow gap — never "No code to land" and never "not on main".
   - FINDINGS BY CRITERION. What stands in the way (each unmet criterion, naming its open tasks with
     Open, and Move to a follow-up…; then the other refusals), apart from what Orbit cannot prove.
   - CRITERIA MET BY CONFIRMATION. Who confirmed it (the owner, the coordinator, an Agent check),
     when, what they said, and the Confirm sheet; a confirmation of an earlier wording is stale.

   Every word is one of `lib/projectDone.ts`'s named constants, word for word, and
   `ProjectDoneCopyParityTests` reads that file back against the ones below. Every derivation is
   held to the browser's own examples by `ProjectDoneFollowUpsTests`.
   ───────────────────────────────────────────────────────────────────────────────────────────── */

// MARK: - the wire

/// How a criterion is met (migration 0545): by the work filed under it, or by a confirmation.
public enum CriterionSatisfiedBy: String, Codable, Sendable {
    case tasks = "TASKS"
    case confirmation = "CONFIRMATION"

    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = CriterionSatisfiedBy(rawValue: raw) ?? .tasks
    }
}

/// One confirmation of a criterion met by confirmation (server `CriterionConfirmationView`).
public struct CriterionConfirmationView: Codable, Equatable, Sendable {
    /// `OWNER`, `COORDINATOR` or `AGENT_CHECK`.
    public let confirmerKind: String
    /// `PENDING`, `CONFIRMED` or `FAILED`.
    public let outcome: String
    public let revision: Int
    /// The coordinator conversation that confirmed, or the Agent check's run.
    public let sessionId: String?
    public let checkTaskId: String?
    public let note: String?
    public let attachmentIds: [String]
    public let at: String
    /// The criterion's wording and verification method at `revision`, kept with the confirmation;
    /// nil on an older row. What a stale row's What changed shows.
    public let criterionText: String?
    public let criterionVerificationMethod: String?

    public init(confirmerKind: String, outcome: String = "CONFIRMED", revision: Int = 1,
                sessionId: String? = nil, checkTaskId: String? = nil, note: String? = nil,
                attachmentIds: [String] = [], at: String, criterionText: String? = nil,
                criterionVerificationMethod: String? = nil) {
        self.confirmerKind = confirmerKind
        self.outcome = outcome
        self.revision = revision
        self.sessionId = sessionId
        self.checkTaskId = checkTaskId
        self.note = note
        self.attachmentIds = attachmentIds
        self.at = at
        self.criterionText = criterionText
        self.criterionVerificationMethod = criterionVerificationMethod
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        confirmerKind = try c.decodeIfPresent(String.self, forKey: .confirmerKind) ?? "OWNER"
        outcome = try c.decodeIfPresent(String.self, forKey: .outcome) ?? "CONFIRMED"
        revision = try c.decodeIfPresent(Int.self, forKey: .revision) ?? 0
        sessionId = try c.decodeIfPresent(String.self, forKey: .sessionId)
        checkTaskId = try c.decodeIfPresent(String.self, forKey: .checkTaskId)
        note = try c.decodeIfPresent(String.self, forKey: .note)
        attachmentIds = (try? c.decodeIfPresent([String].self, forKey: .attachmentIds)) ?? []
        at = try c.decodeIfPresent(String.self, forKey: .at) ?? ""
        criterionText = try c.decodeIfPresent(String.self, forKey: .criterionText)
        criterionVerificationMethod = try c.decodeIfPresent(String.self, forKey: .criterionVerificationMethod)
    }
}

/// Where one criterion met by confirmation stands (server `CriterionConfirmationStanding`).
public struct CriterionConfirmationStanding: Codable, Equatable, Sendable {
    /// `CONFIRMED`, `CHECK_FAILED`, `STALE` or `UNCONFIRMED`.
    public let state: String
    public let current: CriterionConfirmationView?
    public let stale: Bool
    public let checkRunning: CriterionConfirmationView?

    public init(state: String, current: CriterionConfirmationView? = nil, stale: Bool = false,
                checkRunning: CriterionConfirmationView? = nil) {
        self.state = state
        self.current = current
        self.stale = stale
        self.checkRunning = checkRunning
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        state = try c.decodeIfPresent(String.self, forKey: .state) ?? "UNCONFIRMED"
        current = try c.decodeIfPresent(CriterionConfirmationView.self, forKey: .current)
        stale = try c.decodeIfPresent(Bool.self, forKey: .stale) ?? false
        checkRunning = try c.decodeIfPresent(CriterionConfirmationView.self, forKey: .checkRunning)
    }
}

/// Board 02 I: the project a criterion was moved from, and when. Only the owner moves one.
public struct CriterionMovedFrom: Codable, Equatable, Sendable {
    public let fromProjectId: String
    public let fromProjectTitle: String
    public let movedAt: String

    public init(fromProjectId: String, fromProjectTitle: String, movedAt: String) {
        self.fromProjectId = fromProjectId
        self.fromProjectTitle = fromProjectTitle
        self.movedAt = movedAt
    }
}

/// Board 02 G: one criterion this project moved out to a follow-up.
public struct CriterionMovedOut: Codable, Equatable, Sendable, Identifiable {
    public let criterionKey: String
    public let definitionId: String
    /// Its number on this project's cards when it moved; nil on an older record.
    public let ordinal: Int?
    public let text: String
    public let toProjectId: String
    public let toProjectTitle: String
    public let movedAt: String

    public var id: String { definitionId }

    public init(criterionKey: String, definitionId: String, ordinal: Int?, text: String,
                toProjectId: String, toProjectTitle: String, movedAt: String) {
        self.criterionKey = criterionKey
        self.definitionId = definitionId
        self.ordinal = ordinal
        self.text = text
        self.toProjectId = toProjectId
        self.toProjectTitle = toProjectTitle
        self.movedAt = movedAt
    }
}

/// The explicit non-code mark (migration 0535): who set it, when, and the reason given with it.
public struct NonCodeMark: Equatable, Sendable {
    /// `OWNER` or `COORDINATOR`; nil when the read did not say.
    public let setBy: String?
    public let setAt: String?
    public let reason: String?

    public init(setBy: String? = nil, setAt: String? = nil, reason: String? = nil) {
        self.setBy = setBy
        self.setAt = setAt
        self.reason = reason
    }
}

/// `POST /projects/:id/criteria/:criterionKey/move`: exactly one destination.
public struct MoveCriterionBody: Encodable, Equatable, Sendable {
    public struct NewProject: Encodable, Equatable, Sendable {
        public let title: String
        public let goal: String?
    }
    public let toProjectId: String?
    public let newProject: NewProject?

    public static func existing(_ projectID: String) -> MoveCriterionBody {
        MoveCriterionBody(toProjectId: projectID, newProject: nil)
    }

    public static func new(title: String, goal: String?) -> MoveCriterionBody {
        MoveCriterionBody(toProjectId: nil, newProject: NewProject(title: title, goal: goal))
    }
}

/// What a move answers: where the criterion went and what went with it.
public struct MoveCriterionResult: Codable, Equatable, Sendable {
    public let fromProjectId: String
    public let toProjectId: String
    public let createdProject: Bool
    public let criterionKey: String
    public let movedTaskIds: [String]
    public let keptTaskIds: [String]
}

/// `POST /projects/:id/criteria/:criterionId/confirmations` — the owner's Confirm sheet.
public struct ConfirmCriterionBody: Encodable, Equatable, Sendable {
    public let note: String?
    public let revision: Int?
    public let attachmentIds: [String]?

    public init(note: String?, revision: Int?, attachmentIds: [String]?) {
        let trimmed = note?.trimmingCharacters(in: .whitespacesAndNewlines)
        self.note = trimmed?.isEmpty == false ? trimmed : nil
        self.revision = revision
        self.attachmentIds = attachmentIds?.isEmpty == false ? attachmentIds : nil
    }
}

// MARK: - the words

public extension ProjectDone {
    // The non-code mark (decided board ③ A, board 01).
    static let nonCodeBadge = "Non-code"
    static let nonCodeLead = "Non-code project."
    static let nonCodeBody = "Orbit checks the criteria only, not where work landed."
    static let nonCodeProjectLine = "Non-code project · Orbit checks the criteria only, not where work landed"
    static let nonCodeMarkedByCoordinator = "Marked by the coordinator"
    static let nonCodeMarkedByYou = "Marked by you"
    static let nonCodeChange = "Change"
    /// The project page's Delivers row, which the done card's Change opens.
    static let nonCodeAnchor = "delivers"
    static let runDelivers = "Delivers"
    static let runDeliversCode = "Code"
    static let runDeliversCodeHint = "Tasks land on a branch, and the done card checks the work reached {main}."
    static let runDeliversNotCode = "Not code"
    static let runDeliversNotCodeHint = "Documents, accounts, approvals. Orbit checks the criteria only; nothing lands."
    static let runLanding = "Landing"
    static let runLandingOffHint = "Off for a non-code project: Tasks land on, Delivery, Main branch and Merge check don’t apply. Switch Delivers to Code to bring them back."
    static let runToNotCode = "The done card stops reading where work landed. Work already on {branch} stays there."
    static let runToCode = "The done card will check where work landed again. Work that ran without a branch will show as “Ran without a branch”."
    /// The two alerts iOS asks before a press of Delivers writes (board 01 ③), titles and presses
    /// over the browser's `RUN_TO_NOT_CODE` / `RUN_TO_CODE` — the browser has Save instead. The web
    /// declares them for the native clients as `RUN_TO_NOT_CODE_TITLE` / `_ACTION` and
    /// `RUN_TO_CODE_TITLE` / `_ACTION`.
    static let runMarkNotCodeTitle = "Mark as not code?"
    static let runMarkNotCodeAction = "Mark as not code"
    static let runMarkCodeTitle = "Treat this project as code?"
    static let runMarkCodeAction = "Mark as code"
    static let runMarkNotSaved = "What this project delivers was not saved"

    // The follow-up details (boards 01 B, 02 G/I, 03 Confirm sheet and stale row).
    static let nonCodeReasonTemplate = "“{reason}”"
    static let movedOutCriterion = "Criterion {n} moved to"
    static let movedOutUnnumbered = "A criterion moved to"
    static let movedFrom = "Moved from"
    static let movedByYou = "by you"
    static let confirmSheetScreenshot = "Screenshot"
    static let confirmSheetAttach = "Attach a screenshot"
    static let confirmSheetDrop = "Drop an image or paste it here"
    static let confirmSheetNotAnImage = "Attach an image: a PNG, JPEG, GIF or WebP file."
    static let confirmSheetUploading = "Uploading…"
    static let confirmSheetRemove = "Remove"
    static let confirmSheetNotUploaded = "The screenshot was not uploaded"
    static let criterionScreenshot = "Screenshot"
    static let criterionOneScreenshot = "1 screenshot"
    static let criterionScreenshots = "{n} screenshots"
    static let criterionWhatChanged = "What changed"
    static let criterionHideChanges = "Hide changes"
    static let criterionWordingConfirmed = "Confirmed · revision {r}"
    static let criterionWordingNow = "Now · revision {r}"
    static let criterionWordingNotKept = "The wording confirmed then was not kept."

    // The done card's findings, grouped by criterion with the unmet ones first (decided board ③ B–D).
    static let standsInWayOne = "1 thing stands in the way"
    static let standsInWay = "{n} things stand in the way"
    static let findingsHeadingOne = "Orbit can’t prove 1 thing"
    static let checkUnmetOpenTask = "Criterion {n} is not met — 1 task is still open"
    static let checkUnmetOpenTasks = "Criterion {n} is not met — {m} tasks are still open"
    static let checkUnmetNoTask = "Criterion {n} is not met — no task serves it"
    static let checkUnmetUnconfirmed = "Criterion {n} is not met — it waits for confirmation"
    static let checkNoBranch = "Criterion {n}: {tasks} ran without a branch, so Orbit can’t see whether their changes reached {main}. Check {main} yourself before recording it done."
    static let checkOnProjectBranch = "Criterion {n} is on the project branch, not on {main} yet"
    static let checkInFlight = "Criterion {n} is being landed on {main}"
    static let checkNothingToLand = "Criterion {n} has nothing to land"
    static let checkCodeless = "Criterion {n} has no code to land"
    static let cardOpen = "Open"
    static let moveToFollowUp = "Move to a follow-up…"
    static let moveHint = "takes criterion {n} and its open tasks out of this project"
    static let anywayKeeps = "If you record it done anyway, Orbit keeps {criteria} as the gap you accepted."
    static let cardTallyOf = "{met} of {n} met"
    static let cardWaitConfirmation = "{n} wait for confirmation"
    static let landingRanWithoutBranch = "Ran without a branch"
    static let landingNoCodeToLand = "No code to land"

    // A criterion met by confirmation (board 03).
    static let criterionMetBy = "Met by"
    static let criterionMetByTasks = "its tasks"
    static let criterionMetByConfirmation = "confirmation"
    static let criterionModeTasks = "Its tasks"
    static let criterionModeTasksHint = "Met when the work filed under it is done."
    static let criterionModeConfirmation = "Confirmation"
    static let criterionModeConfirmationHint = "Met when you, the coordinator or an Agent check confirms it. For facts outside the code: filings, approvals, accounts."
    static let criterionModeNotChanged = "How this criterion is met was not changed"
    static let criterionConfirmedByYou = "Met · confirmed by you"
    static let criterionConfirmedByCoordinator = "Met · confirmed by the coordinator"
    static let criterionCheckPassed = "Met · Agent check passed"
    static let criterionCheckFailed = "Not met · Agent check failed"
    static let criterionCheckRunning = "Checking… · Agent check running"
    static let criterionStale = "Not met · confirmed for an earlier wording"
    static let criterionStaleDetail = "{who} confirmed revision {r} on {date}. The wording has changed since."
    static let criterionWaitsConfirmation = "Waits for confirmation"
    static let criterionCheckStarted = "started {ago}"
    static let criterionPassNote = "PASS — {note}"
    static let criterionFailNote = "FAIL — {note}"
    static let criterionWhoYou = "You"
    static let criterionWhoCoordinator = "The coordinator"
    static let criterionWhoCheck = "An Agent check"
    static let checkItsWork = "its work"
    static let criterionWithdraw = "Withdraw"
    static let criterionViewRun = "View run"
    static let criterionOpenConversation = "Open conversation"
    static let criterionConfirm = "Confirm…"
    static let criterionConfirmAgain = "Confirm again…"
    static let criterionRunCheck = "Run an Agent check"
    static let criterionRunCheckAgain = "Run the check again"
    static let criterionActionFailed = "That did not go through"
    static let confirmSheetTitle = "Confirm criterion {n}"
    static let confirmSheetHowChecked = "How it’s checked:"
    static let confirmSheetWhatChecked = "What did you check?"
    static let confirmSheetOptional = "optional"
    static let confirmSheetPlaceholder = "e.g. the filing number you saw, and where"
    static let confirmSheetFootnote = "Your name and the time are kept with it. If the wording of this criterion changes, it goes back to not met until someone confirms it again."
    static let confirmSheetConfirm = "Confirm"
    static let confirmSheetCancel = "Cancel"
    static let confirmSheetNotRecorded = "The confirmation was not recorded"
    static let rowByYou = "by you"
    static let rowByCoordinator = "by the coordinator"
    static let rowCheckPass = "Agent check PASS"
    static let rowCheckFailed = "Agent check failed"
    static let rowWaits = "waits for confirmation"
    static let rowStale = "confirmed for an earlier wording"
    static let rowChecking = "checking…"
    static let rowConfirmedByYou = "Confirmed by you"
    static let rowConfirmedByCoordinator = "Confirmed by the coordinator"
    static let rowConfirmedByCheck = "Confirmed by an Agent check"
    static let acceptanceStandingMixed = "{n} criteria stated. {a} met by their tasks; {b} by a confirmation — from you, the coordinator, or an Agent check."
    static let acceptanceNoteMixed = "A criterion met by its tasks is read off the work filed under it. A criterion met by confirmation says who confirmed it, when, and what they checked; it goes back to not met when its wording changes or the confirmation is withdrawn."

    // Move to a follow-up… (board 02 ⑥): one sheet, two steps.
    static let moveTitle = "Move to a follow-up"
    static let moveMoves = "Moves"
    static let moveAndOneOpenTask = "and its 1 open task"
    static let moveAndOpenTasks = "and its {n} open tasks"
    static let moveStays = "Stays here: its done and cancelled tasks, as this project’s history."
    static let moveKeeps = "This project keeps {n} criteria."
    static let moveKeepsAllMet = "This project keeps {n} criteria, all met."
    static let moveTo = "To"
    static let moveNewProject = "New project"
    static let moveExistingProject = "Existing project"
    static let moveFollowUpTitle = "{title} · follow-up"
    static let moveFollowUpGoal = "Follow-up of “{title}”: criterion {n}."
    static let moveNewHint = "It starts not started, in the same workspace, with this criterion and its tasks. You start it when you’re ready."
    static let moveSearch = "Search open projects"
    static let moveOpenOnly = "Open projects only."
    static let moveProjectTasks = "{n} tasks"
    static let moveNoOpenProjects = "No other open project."
    static let moveNext = "Next"
    static let moveCancel = "Cancel"
    static let moveBack = "Back"
    static let moveConfirmTitle = "Move criterion {n} to “{project}”?"
    static let moveConfirmThisAllMet = "This project keeps {n} criteria, all met. You can record it as done right after."
    static let moveConfirmNew = "{project} is created, not started, and gets criterion {n} {tasks}."
    static let moveConfirmExisting = "{project} gets criterion {n} {tasks}, after its own criteria."
    static let moveConfirmRecord = "Both projects record the move: who moved it and when. Nothing is deleted."
    static let moveConfirmAction = "Move criterion {n}"
    static let moveNotMoved = "The criterion was not moved"
}

// MARK: - the derivations

public extension ProjectDone {
    /// `nonCodeProvenance` — "Marked by the coordinator · Nov 11", or nil for an unmarked project.
    /// `dateTime` says it with the time, as How it runs does.
    static func nonCodeProvenance(_ mark: NonCodeMark?, withTime: Bool = false,
                                  timeZone: TimeZone = .current) -> String? {
        guard let mark else { return nil }
        let who = mark.setBy == "COORDINATOR" ? nonCodeMarkedByCoordinator : nonCodeMarkedByYou
        let when = withTime ? dateTime(mark.setAt, timeZone: timeZone) : date(mark.setAt, timeZone: timeZone)
        return when.map { "\(who) · \($0)" } ?? who
    }

    /// `nonCodeReasonLine` — the mark's reason, quoted, or nil when none was given.
    static func nonCodeReasonLine(_ mark: NonCodeMark?) -> String? {
        guard let reason = mark?.reason?.trimmingCharacters(in: .whitespacesAndNewlines), !reason.isEmpty
        else { return nil }
        return nonCodeReasonTemplate.replacingOccurrences(of: "{reason}", with: reason)
    }

    /// `movedOutLead` — "Criterion 4 moved to", the words before the destination's name.
    static func movedOutLead(_ moved: CriterionMovedOut) -> String {
        guard let ordinal = moved.ordinal, ordinal > 0 else { return movedOutUnnumbered }
        return movedOutCriterion.replacingOccurrences(of: "{n}", with: String(ordinal))
    }

    /// `movedByLine` — "by you · Nov 11, 19:40" (or with the date only), the words after the name.
    static func movedByLine(_ movedAt: String, withTime: Bool = true, timeZone: TimeZone = .current) -> String {
        let when = withTime ? dateTime(movedAt, timeZone: timeZone) : date(movedAt, timeZone: timeZone)
        return when.map { "\(movedByYou) · \($0)" } ?? movedByYou
    }

    /// `screenshotCount` — "1 screenshot", "2 screenshots", or nil for none.
    static func screenshotCount(_ count: Int) -> String? {
        guard count > 0 else { return nil }
        return count == 1 ? criterionOneScreenshot
            : criterionScreenshots.replacingOccurrences(of: "{n}", with: String(count))
    }

    /// `criteriaPhrase` — "criterion 4", "criteria 3 and 4", "criteria 2, 3 and 4".
    static func criteriaPhrase(_ ordinals: [Int]) -> String {
        guard ordinals.count > 1, let last = ordinals.last else {
            return "criterion \(ordinals.first ?? 0)"
        }
        return "criteria \(ordinals.dropLast().map(String.init).joined(separator: ", ")) and \(last)"
    }

    /// How many criteria met by confirmation are not met yet — the tally's "2 wait for confirmation".
    static func waitingConfirmation(_ derivedDone: ProjectDerivedDone?) -> Int {
        (derivedDone?.criteria ?? []).filter { $0.satisfiedBy == .confirmation && !$0.satisfied }.count
    }

    /// The card's tally for a subject: its counts, its mark, and what waits for a confirmation.
    static func cardTally(_ subject: ProjectDoneSubject) -> String {
        cardTally(subject.counts, main: subject.main, nonCode: subject.nonCode,
                  waitingConfirmation: waitingConfirmation(subject.derivedDone))
    }

    /// `doneCriterionRowState`: one criterion's state on the done card's rows — met or not, then,
    /// for a criterion met by confirmation, who confirmed it, or, for one met by its tasks in a
    /// project that reads landing, where its work is. An unmet criterion is "not met" and nothing
    /// more. A non-code project's rows carry no landing at all. `warn` is the yellow gap.
    static func criterionRowState(_ criterion: ProjectDoneCriterion, nonCode: Bool = false,
                                  main: String = RunSettings.defaultMainBranch) -> (text: String, warn: Bool) {
        let met = criterion.satisfied ? "met" : "not met"
        if criterion.satisfiedBy == .confirmation {
            let standing = criterion.confirmation
            if criterion.satisfied {
                let kind = standing?.current?.confirmerKind
                let by = kind == "COORDINATOR" ? rowByCoordinator : kind == "AGENT_CHECK" ? rowCheckPass : rowByYou
                return ("\(met) · \(by)", false)
            }
            let why = standing?.checkRunning != nil ? rowChecking
                : standing?.state == "CHECK_FAILED" ? rowCheckFailed
                : standing?.state == "STALE" ? rowStale : rowWaits
            return ("\(met) · \(why)", standing?.state == "STALE")
        }
        if !criterion.satisfied || nonCode { return (met, false) }
        return ("\(met) · \(landingReasonLabel(criterion.landingReason, main: main))",
                criterion.landingReason == .noBranch)
    }

    /// `confirmationLine` — the line under a confirmed criterion's row: who confirmed it, when, what
    /// they said, and how many screenshots.
    static func confirmationLine(_ view: CriterionConfirmationView?, timeZone: TimeZone = .current) -> String? {
        guard let view else { return nil }
        let who = view.confirmerKind == "COORDINATOR" ? rowConfirmedByCoordinator
            : view.confirmerKind == "AGENT_CHECK" ? rowConfirmedByCheck : rowConfirmedByYou
        return [who, date(view.at, timeZone: timeZone), view.note.map { "“\($0)”" },
                screenshotCount(view.attachmentIds.count)]
            .compactMap { $0 }.joined(separator: " · ")
    }

    /// What the check found, grouped the way the decided board ③ draws it: everything that stands
    /// in the way — the unmet criteria by ordinal, then the other refusals — and apart from it what
    /// Orbit cannot prove about where work landed.
    struct Findings: Equatable, Sendable {
        public let unmet: [ProjectDoneFinding]
        public let otherRefusals: [ProjectDoneFinding]
        public let warnings: [ProjectDoneFinding]

        public init(_ findings: [ProjectDoneFinding]) {
            unmet = findings.filter { $0.code == "DONE_CRITERION_UNSATISFIED" }
                .sorted { ($0.criterion?.ordinal ?? 0) < ($1.criterion?.ordinal ?? 0) }
            // A finding from an older server says no severity: every code but the unlanded one refuses.
            otherRefusals = findings.filter {
                $0.code != "DONE_CRITERION_UNSATISFIED"
                    && ($0.severity == "REFUSE" || ($0.severity == nil && $0.code != "DONE_CRITERION_UNLANDED"))
            }
            warnings = findings.filter {
                $0.severity == "WARN" || ($0.severity == nil && $0.code == "DONE_CRITERION_UNLANDED")
            }
        }

        public var blocking: [ProjectDoneFinding] { unmet + otherRefusals }

        /// "1 thing stands in the way", "2 things stand in the way"; nil when nothing does.
        public var blockingHeading: String? {
            switch blocking.count {
            case 0: return nil
            case 1: return ProjectDone.standsInWayOne
            default: return ProjectDone.standsInWay.replacingOccurrences(of: "{n}", with: String(blocking.count))
            }
        }

        /// "Orbit can’t prove 1 thing", "Orbit can’t prove 2 things"; nil when there is nothing.
        public var warningsHeading: String? {
            switch warnings.count {
            case 0: return nil
            case 1: return ProjectDone.findingsHeadingOne
            default: return ProjectDone.findingsHeading.replacingOccurrences(of: "{n}", with: String(warnings.count))
            }
        }

        /// What pressing anyway keeps: the unmet criteria by number, or the gaps in general.
        public var explanation: String {
            unmet.isEmpty ? ProjectDone.findingsAccepted
                : ProjectDone.anywayKeeps.replacingOccurrences(
                    of: "{criteria}", with: ProjectDone.criteriaPhrase(unmet.map { $0.criterion?.ordinal ?? 0 }))
        }
    }

    /// Whether a finding is about a criterion met by confirmation — its line then says it waits for
    /// one, not that no task serves it.
    static func confirmationMode(_ finding: ProjectDoneFinding, subject: ProjectDoneSubject) -> Bool {
        guard let key = finding.criterion?.key, let item = subject.criterion(key) else { return false }
        return subject.derivedDone?.criteria.first { $0.definitionId == item.id }?.satisfiedBy == .confirmation
    }

    /// "takes criterion 4 and its open tasks out of this project".
    static func moveHint(_ ordinal: Int) -> String {
        moveHint.replacingOccurrences(of: "{n}", with: String(ordinal))
    }

    /// The Confirm sheet's title: "Confirm criterion 6".
    static func confirmSheetTitle(_ ordinal: Int) -> String {
        confirmSheetTitle.replacingOccurrences(of: "{n}", with: String(ordinal))
    }

    /// The press on an unmet criterion met by confirmation: Confirm again… on a stale one.
    static func confirmLabel(_ standing: CriterionConfirmationStanding?) -> String {
        standing?.state == "STALE" ? criterionConfirmAgain : criterionConfirm
    }

    // MARK: the acceptance criteria's confirmation rows (board 03 ⑤)

    /// One criterion met by confirmation, as the project page's row says it: the state sentence,
    /// the instant beside it, the line under it, and which presses it offers.
    struct ConfirmationRow: Equatable, Sendable {
        public let sentence: String
        public let met: Bool
        public let stale: Bool
        public let failed: Bool
        public let running: Bool
        /// "Nov 11, 10:42", or "started 2m ago" for a running check.
        public let when: String?
        /// The quoted note, PASS — / FAIL — the check's verdict, or the stale detail.
        public let note: String?
        /// The Agent check's run, or the coordinator's conversation, the row opens.
        public let viewRun: String?
        public let openConversation: String?
        /// The confirmation of an earlier wording, when stale: What changed compares it.
        public let staleConfirmation: CriterionConfirmationView?
        public let screenshots: [String]
    }

    static func confirmationRow(_ standing: CriterionConfirmationStanding?, now: Date = Date(),
                                timeZone: TimeZone = .current) -> ConfirmationRow {
        let current = standing?.current
        let running = standing?.checkRunning
        let state = standing?.state ?? "UNCONFIRMED"
        var sentence: String
        var met = false
        var note: String?
        if state == "CONFIRMED", let current {
            sentence = current.confirmerKind == "COORDINATOR" ? criterionConfirmedByCoordinator
                : current.confirmerKind == "AGENT_CHECK" ? criterionCheckPassed : criterionConfirmedByYou
            met = true
            if let said = current.note {
                note = current.confirmerKind == "AGENT_CHECK"
                    ? criterionPassNote.replacingOccurrences(of: "{note}", with: said) : "“\(said)”"
            }
        } else if state == "CHECK_FAILED", let current {
            sentence = criterionCheckFailed
            note = current.note.map { criterionFailNote.replacingOccurrences(of: "{note}", with: $0) }
        } else if state == "STALE", let current {
            sentence = criterionStale
            let who = current.confirmerKind == "OWNER" ? criterionWhoYou
                : current.confirmerKind == "COORDINATOR" ? criterionWhoCoordinator : criterionWhoCheck
            note = criterionStaleDetail
                .replacingOccurrences(of: "{who}", with: who)
                .replacingOccurrences(of: "{r}", with: String(current.revision))
                .replacingOccurrences(of: "{date}", with: date(current.at, timeZone: timeZone) ?? "")
        } else {
            sentence = running != nil ? criterionCheckRunning : criterionWaitsConfirmation
        }
        let shown = running != nil && state != "CONFIRMED" ? running : current
        let when: String?
        if let shown, let running, shown == running {
            when = criterionCheckStarted.replacingOccurrences(
                of: "{ago}", with: RelativeTime.ago(running.at, now: now) ?? "")
        } else {
            when = shown.flatMap { dateTime($0.at, timeZone: timeZone) }
        }
        return ConfirmationRow(
            sentence: sentence, met: met, stale: state == "STALE", failed: state == "CHECK_FAILED",
            running: running != nil, when: when, note: note,
            viewRun: shown?.confirmerKind == "AGENT_CHECK" ? shown?.sessionId : nil,
            openConversation: shown?.confirmerKind == "COORDINATOR" ? shown?.sessionId : nil,
            staleConfirmation: state == "STALE" ? current : nil,
            screenshots: current?.attachmentIds ?? [])
    }

    /// The press that starts an Agent check: again, after a failed one.
    static func runCheckLabel(_ standing: CriterionConfirmationStanding?) -> String {
        standing?.state == "CHECK_FAILED" ? criterionRunCheckAgain : criterionRunCheck
    }

    /// The acceptance criteria's standing line when some are met by confirmation.
    static func acceptanceStanding(total: Int, confirmed: Int) -> String {
        acceptanceStandingMixed
            .replacingOccurrences(of: "{n}", with: String(total))
            .replacingOccurrences(of: "{a}", with: String(total - confirmed))
            .replacingOccurrences(of: "{b}", with: String(confirmed))
    }

    /// "Met by: its tasks" — the mode menu's label.
    static func metByLabel(_ mode: CriterionSatisfiedBy) -> String {
        "\(criterionMetBy): \(mode == .confirmation ? criterionMetByConfirmation : criterionMetByTasks)"
    }

    // MARK: Move to a follow-up…

    /// "and its 1 open task", "and its 3 open tasks".
    static func moveTasksPhrase(_ count: Int) -> String {
        count == 1 ? moveAndOneOpenTask : moveAndOpenTasks.replacingOccurrences(of: "{n}", with: String(count))
    }

    /// The follow-up a new project is called by default: "<title> · follow-up".
    static func moveFollowUpTitle(_ title: String) -> String {
        moveFollowUpTitle.replacingOccurrences(of: "{title}", with: title)
    }

    static func moveFollowUpGoal(_ title: String, ordinal: Int) -> String {
        moveFollowUpGoal.replacingOccurrences(of: "{title}", with: title)
            .replacingOccurrences(of: "{n}", with: String(ordinal))
    }

    /// "This project keeps 3 criteria, all met." — under Moves; and the confirm step's own line.
    static func moveKeepsLine(_ keeps: Int, allMet: Bool, confirming: Bool = false) -> String {
        let template = allMet ? (confirming ? moveConfirmThisAllMet : moveKeepsAllMet) : moveKeeps
        return template.replacingOccurrences(of: "{n}", with: String(keeps))
    }

    static func moveConfirmTitle(_ ordinal: Int, project: String) -> String {
        moveConfirmTitle.replacingOccurrences(of: "{n}", with: String(ordinal))
            .replacingOccurrences(of: "{project}", with: project)
    }

    /// What the destination becomes: "<project> is created, not started, and gets criterion 4 and
    /// its 1 open task."
    static func moveConfirmDestination(_ project: String, ordinal: Int, openTasks: Int, newProject: Bool) -> String {
        (newProject ? moveConfirmNew : moveConfirmExisting)
            .replacingOccurrences(of: "{project}", with: project)
            .replacingOccurrences(of: "{n}", with: String(ordinal))
            .replacingOccurrences(of: "{tasks}", with: openTasks > 0 ? moveTasksPhrase(openTasks) : "")
            .replacingOccurrences(of: " ,", with: ",")
            .replacingOccurrences(of: " .", with: ".")
    }

    static func moveConfirmAction(_ ordinal: Int) -> String {
        moveConfirmAction.replacingOccurrences(of: "{n}", with: String(ordinal))
    }
}

/// The fields of a project document the follow-ups read — the mark and the criteria moved out —
/// decoded off the same document as whichever read carries them (the project page's, the
/// coordinator conversation's). A shape this build cannot read is none of them.
public struct ProjectDoneFollowUpFields: Decodable, Equatable, Sendable {
    public let nonCodeMark: NonCodeMark?
    public let criteriaMovedOut: [CriterionMovedOut]

    public init(nonCodeMark: NonCodeMark? = nil, criteriaMovedOut: [CriterionMovedOut] = []) {
        self.nonCodeMark = nonCodeMark
        self.criteriaMovedOut = criteriaMovedOut
    }

    private enum CodingKeys: String, CodingKey {
        case nonCode, nonCodeSetBy, nonCodeSetAt, nonCodeReason, criteriaMovedOut
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let marked = (try? c.decodeIfPresent(Bool.self, forKey: .nonCode)) ?? false
        nonCodeMark = marked
            ? NonCodeMark(setBy: try? c.decodeIfPresent(String.self, forKey: .nonCodeSetBy),
                          setAt: try? c.decodeIfPresent(String.self, forKey: .nonCodeSetAt),
                          reason: try? c.decodeIfPresent(String.self, forKey: .nonCodeReason))
            : nil
        criteriaMovedOut = ((try? c.decodeIfPresent([CriterionMovedOut].self, forKey: .criteriaMovedOut)) ?? nil) ?? []
    }

    /// Put back on an encoded document, so a round trip keeps them.
    func encode(into encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        if let nonCodeMark {
            try c.encode(true, forKey: .nonCode)
            try c.encodeIfPresent(nonCodeMark.setBy, forKey: .nonCodeSetBy)
            try c.encodeIfPresent(nonCodeMark.setAt, forKey: .nonCodeSetAt)
            try c.encodeIfPresent(nonCodeMark.reason, forKey: .nonCodeReason)
        }
        if !criteriaMovedOut.isEmpty { try c.encode(criteriaMovedOut, forKey: .criteriaMovedOut) }
    }
}

/// `PATCH /projects/:id` with the owner's non-code mark.
public struct ProjectNonCodeBody: Encodable, Equatable, Sendable {
    public let nonCode: Bool
}

/// `PATCH /projects/:id` restating the criteria with one criterion's mode changed — the browser's
/// `CriterionModeMenu` write.
public struct CriteriaModeBody: Encodable, Equatable, Sendable {
    public struct Item: Encodable, Equatable, Sendable {
        public let id: String
        public let text: String
        public let verificationMethod: String
        public let completionCriterionOverrideReason: String?
        public let satisfiedBy: CriterionSatisfiedBy
    }
    public let acceptanceCriteriaItems: [Item]

    /// The set as it stands, with `criterionID`'s mode set to `mode`.
    public init(criteria: [ProjectCriterion], criterionID: String, mode: CriterionSatisfiedBy) {
        acceptanceCriteriaItems = criteria.map { item in
            Item(id: item.id, text: item.text, verificationMethod: item.verificationMethod ?? "",
                 completionCriterionOverrideReason: item.completionCriterionOverrideReason?.isEmpty == false
                    ? item.completionCriterionOverrideReason : nil,
                 satisfiedBy: item.id == criterionID ? mode : item.satisfiedBy)
        }
    }
}

/// What a change of mode answers: the server's notice when it held the change for a decision.
public struct CriteriaModeAnswer: Decodable, Equatable, Sendable {
    public struct Hold: Decodable, Equatable, Sendable { public let notice: String? }
    public let acceptanceCriteriaHold: Hold?
}
