import Foundation

/// What one project's page says, card by card — ported from the web's project page so both clients
/// draw the same project the same way: `ProjectPanoramaHeader.tsx` (Work overview),
/// `ProjectAcceptanceCard.tsx` (criteria), `ProjectCoordinatorCard.tsx` (the coordinator's pill),
/// `ProjectProgressStatus.tsx` (Open items), `ProjectIntegrationLine.tsx` (the line row) and
/// `ProjectsPage.tsx`'s task bands and tags.
///
/// Pure and view-free, so it is tested on Linux; `ProjectPageCopyParityTests` holds the words to
/// the web sources.
public enum ProjectPage {

    // MARK: - Work overview

    /// The shape a cell carries beside its label, so lanes can be told apart without colour.
    public enum Glyph: String, Sendable {
        case disc, triangle, square, hourglass, check, cross, slash, spinner, branch
    }

    /// One count on the Work overview card.
    public struct OverviewCell: Equatable, Sendable, Identifiable {
        public let key: String
        public let label: String
        public let value: Int
        public let footnote: String
        public let glyph: Glyph
        public var id: String { key }
    }

    /// Whether the server reported the integration lanes — which decides the card's shape.
    public static func reportsIntegrationLanes(_ b: ProjectPanoramaBuckets) -> Bool {
        b.integrating != nil && b.onIntegrationLine != nil && b.onUpstream != nil
    }

    /// The cells the card draws, in reading order. A project that integrates splits Done into
    /// Integrating / On project branch / On main (the branch lane dropped on a `MAIN` line), and draws
    /// the lanes outside that sum only when they are non-zero; one that does not draws the seven
    /// lanes, Done carrying its share of the whole.
    public static func overviewCells(_ b: ProjectPanoramaBuckets, taskCount: Int,
                                     line: IntegrationLine?) -> [OverviewCell] {
        if reportsIntegrationLanes(b) {
            var lanes: [OverviewCell] = [
                OverviewCell(key: "running", label: "Running", value: b.running,
                             footnote: "active sessions", glyph: .disc),
                OverviewCell(key: "ready", label: "Ready", value: b.ready,
                             footnote: "can start now", glyph: .triangle),
                OverviewCell(key: "blocked", label: "Waiting", value: b.blocked,
                             footnote: (b.waitingForLanding ?? 0) > 0
                                ? "for a prerequisite to land" : "waiting on dependencies",
                             glyph: .square),
                OverviewCell(key: "integrating", label: "Integrating", value: b.integrating ?? 0,
                             footnote: "checks running on the combined tree", glyph: .spinner),
            ]
            if line != .main {
                lanes.append(OverviewCell(key: "onIntegrationLine", label: "On project branch",
                                          value: b.onIntegrationLine ?? 0,
                                          footnote: "not on main yet", glyph: .branch))
            }
            lanes.append(OverviewCell(key: "onUpstream", label: "On main", value: b.onUpstream ?? 0,
                                      footnote: "landed on main", glyph: .check))
            let extras = [
                OverviewCell(key: "doneNotIntegrated", label: "Done", value: b.doneNotIntegrated ?? 0,
                             footnote: "nothing to land", glyph: .check),
                OverviewCell(key: "awaitingVerification", label: "Awaiting verification",
                             value: b.awaitingVerification, footnote: "verifier must conclude",
                             glyph: .hourglass),
                OverviewCell(key: "failed", label: "Failed", value: b.failed,
                             footnote: "coordinated continuation", glyph: .cross),
                OverviewCell(key: "cancelled", label: "Cancelled", value: b.cancelled,
                             footnote: "closed without completion", glyph: .slash),
            ].filter { $0.value > 0 }
            return lanes + extras
        }
        let complete = taskCount > 0
            ? "\(Int((Double(b.done) / Double(taskCount) * 100).rounded()))% complete"
            : "no tasks yet"
        return [
            OverviewCell(key: "running", label: "Running", value: b.running,
                         footnote: "active sessions", glyph: .disc),
            OverviewCell(key: "ready", label: "Ready", value: b.ready,
                         footnote: "can start now", glyph: .triangle),
            OverviewCell(key: "blocked", label: "Waiting", value: b.blocked,
                         footnote: "waiting on dependencies", glyph: .square),
            OverviewCell(key: "awaitingVerification", label: "Awaiting verification",
                         value: b.awaitingVerification, footnote: "verifier must conclude",
                         glyph: .hourglass),
            OverviewCell(key: "done", label: "Done", value: b.done, footnote: complete, glyph: .check),
            OverviewCell(key: "failed", label: "Failed", value: b.failed,
                         footnote: "coordinated continuation", glyph: .cross),
            OverviewCell(key: "cancelled", label: "Cancelled", value: b.cancelled,
                         footnote: "closed without completion", glyph: .slash),
        ]
    }

    /// "7 tasks · 5 dependencies", the card's subtitle.
    public static func overviewSubtitle(_ shape: ProjectPanorama.Shape) -> String {
        "\(plural(shape.taskCount, "task", "tasks")) · "
            + plural(shape.edgeCount, "dependency", "dependencies")
    }

    // MARK: - Acceptance criteria

    public enum CriterionMark: Sendable {
        /// A disc: the read says the work has met it.
        case met
        /// A ring: the work has not. Not red — a criterion stated this morning has failed nothing.
        case unmet
        /// A dashed ring: the read did not answer.
        case unanswered
    }

    /// What the read says about one criterion's work, in the card's words.
    public struct CriterionWork: Equatable, Sendable {
        /// "Met by its work" / "Not met by its work".
        public let state: String
        /// Where met work is ("on main", "on project/x", "no merge receipt either way"); nil for work
        /// that has not met its criterion — nobody is asking where unfinished work merged to.
        public let landing: String?
        /// The part a reader skimming a green row has to see ("not on main yet").
        public let landingWarning: String?
        /// A met criterion with no receipt either way: drawn heavier, it is the false green the
        /// card exists to keep visible.
        public let landingFlagged: Bool
        /// Every reason it has not been met, each with the tasks holding it open.
        public let reasons: [Reason]

        public struct Reason: Equatable, Sendable {
            public let sentence: String
            public let heldUpBy: [HeldUp]
        }

        /// A task holding the criterion open, and what would settle it, in words.
        public struct HeldUp: Equatable, Sendable {
            public let taskId: String
            public let title: String
            public let action: String
        }
    }

    public static let metByItsWork = "Met by its work"
    public static let notMetByItsWork = "Not met by its work"

    public static func criterionMark(_ c: ProjectCriterion) -> CriterionMark {
        guard let satisfied = c.satisfied else { return .unanswered }
        return satisfied ? .met : .unmet
    }

    private static let unmetClause: [String: String] = [
        "NO_WORK_SERVES_IT": "No task says it serves this criterion.",
        "SERVING_WORK_UNSETTLED": "Work filed under it has not settled by the criterion that work declared.",
        "DECLARATION_STALE": "Work here was filed against an earlier wording of this criterion.",
    ]

    private static let requiredActionSentence: [String: String] = [
        "RUN_ACCEPTANCE_COMMAND": "needs its acceptance command to run",
        "OBTAIN_INDEPENDENT_VERIFICATION_PASS": "needs an independent verification pass",
        "RECORD_VERIFICATION_VERDICT": "needs its verdict recorded",
        "SUBMIT_EVIDENCE_AND_AWAIT_INDEPENDENT_DECISION":
            "needs evidence submitted, then an independent decision",
    ]

    /// The criterion's work in words, or nil when the read did not answer for it (which is also
    /// what an older server's document draws). An unrecognised clause or action prints as itself —
    /// dropping it would under-report exactly when there is more to say.
    public static func criterionWork(_ c: ProjectCriterion, integrationRef: String?) -> CriterionWork? {
        guard let satisfied = c.satisfied else { return nil }
        var landing: String?
        var warning: String?
        if satisfied, let raw = c.landing {
            switch raw {
            case "ON_INTEGRATION_LINE":
                landing = "on \(integrationRef ?? "the project branch")"
                warning = "not on main yet"
            case "LANDED": landing = "on main"
            case "UNKNOWN": landing = "no merge receipt either way"
            default: landing = raw
            }
        }
        let reasons = c.unmet.map { reason in
            CriterionWork.Reason(
                sentence: unmetClause[reason.clause] ?? reason.clause,
                heldUpBy: reason.heldUpBy.map {
                    CriterionWork.HeldUp(taskId: $0.taskId, title: $0.title,
                                         action: requiredActionSentence[$0.requiredAction] ?? $0.requiredAction)
                })
        }
        return CriterionWork(state: satisfied ? metByItsWork : notMetByItsWork,
                             landing: landing, landingWarning: warning,
                             landingFlagged: satisfied && c.landing == "UNKNOWN",
                             reasons: reasons)
    }

    // MARK: - Coordinator

    public enum Tone: Sendable {
        case neutral, brand, warning, error
    }

    /// The coordinator card's status pill.
    public struct Pill: Equatable, Sendable {
        public let label: String
        public let tone: Tone
    }

    /// Whether the coordinator conversation is live and not finished — the only state with a reply
    /// to make.
    public static func coordinatorFinished(_ status: ProjectCoordinatorStatus) -> Bool {
        status.state == .live && status.coordination.session?.lifecycleState == .completed
    }

    public static func coordinatorPill(_ status: ProjectCoordinatorStatus) -> Pill {
        if status.state == .live, let session = status.coordination.session,
           !coordinatorFinished(status) {
            // A pending approval blocks INSIDE a turn, so it is asked before "Working".
            if session.pendingApprovals > 0 { return Pill(label: "Needs you", tone: .warning) }
            if session.runState == .running
                || (session.runState == .awaitingInput && session.engineTurnActive) {
                return Pill(label: "Working", tone: .brand)
            }
            if session.runState == .awaitingInput { return Pill(label: "Needs you", tone: .warning) }
            return Pill(label: "Idle", tone: .neutral)
        }
        if coordinatorFinished(status) { return Pill(label: "Completed", tone: .neutral) }
        switch status.state {
        case .neverOpened: return Pill(label: "Not started", tone: .neutral)
        case .trashed: return Pill(label: "Deleted", tone: .neutral)
        default: return Pill(label: "Cannot be opened", tone: .error)
        }
    }

    /// "2nd coordinator of this project" — with the 11th/12th/13th exception.
    public static func coordinatorOrdinal(_ generation: String?) -> String {
        let n = (Int(generation ?? "0") ?? 0) + 1
        let teens = n % 100
        let suffix: String
        if (11...13).contains(teens) {
            suffix = "th"
        } else {
            switch n % 10 {
            case 1: suffix = "st"
            case 2: suffix = "nd"
            case 3: suffix = "rd"
            default: suffix = "th"
            }
        }
        return "\(n)\(suffix) coordinator of this project"
    }

    /// "last active 12m ago", measured against the status read's own `readAt` from the newest of
    /// the conversation's timestamps; nil when it has none.
    public static func lastActive(_ session: ProjectCoordinatorStatus.Session, readAt: String?) -> String? {
        let stamps = [session.startedAt, session.finishedAt, session.completedAt]
            .compactMap { $0.flatMap(RelativeTime.parse) }
        guard let newest = stamps.max(), let now = readAt.flatMap(RelativeTime.parse) else { return nil }
        let diff = now.timeIntervalSince(newest)
        if diff < 60 { return "last active just now" }
        if diff < 3_600 { return "last active \(Int(diff / 60))m ago" }
        if diff < 86_400 { return "last active \(Int(diff / 3_600))h ago" }
        return "last active \(Int(diff / 86_400))d ago"
    }

    private static let wakeupWord: [String: String] = [
        "DELIVERED": "delivered", "QUEUED": "queued", "RETURNED": "returned", "NONE": "none yet",
    ]

    /// "delivered · last 4m ago".
    public static func wakeupsLine(_ w: ProjectCoordinatorStatus.Wakeups, now: Date) -> String {
        let word = wakeupWord[w.state] ?? w.state
        guard let at = w.at, let ago = RelativeTime.ago(at, now: now) else { return word }
        return w.state == "DELIVERED" ? "\(word) · last \(ago)" : "\(word) · \(ago)"
    }

    /// "6 of 30", "6 · no limit", "30 of 30 · paused".
    public static func selfStartedLine(_ f: ProjectCoordinatorStatus.Fuse) -> String {
        let count = f.limit.map { "\(f.selfStartedToday) of \($0)" } ?? "\(f.selfStartedToday) · no limit"
        return f.paused ? "\(count) · paused" : count
    }

    /// How full the day's allowance is, 0…1, or nil when there is no limit to measure against.
    public static func selfStartedFraction(_ f: ProjectCoordinatorStatus.Fuse) -> Double? {
        guard let limit = f.limit, limit > 0 else { return nil }
        return min(1, Double(f.selfStartedToday) / Double(limit))
    }

    /// What the Automatic switch means for this project, and — when it is off — the work standing
    /// behind that: a setting is "nothing starts on its own"; the reason a project went silent is
    /// "and four tasks are waiting".
    public static func automaticExplanation(on: Bool, line: IntegrationLine?, ref: String?,
                                            readyTaskCount: Int?) -> (text: String, warning: String?) {
        guard on else {
            let warning = (readyTaskCount ?? 0) > 0
                ? "⚠ \(readyTaskCount!) ready task\(readyTaskCount == 1 ? " is" : "s are") waiting for someone to press Run."
                : nil
            return ("Nothing here starts or asks on its own.", warning)
        }
        if line == .projectBranch, let ref, !ref.isEmpty {
            return ("Tasks land on \(ref) by themselves and start once their prerequisites land. It also merges \(ref) into main by itself when the checks pass cleanly, and leaves you a receipt with the commit to revert.", nil)
        }
        if line == .main {
            return ("Tasks are checked on main by themselves and start once their prerequisites land. Merging into main always asks you.", nil)
        }
        return ("Starts ready tasks on its own, and opens a judgment session when a criterion needs a decision. If its work lands on a branch of its own, it also merges that branch into main by itself when the checks pass cleanly.", nil)
    }

    // MARK: - Open items

    public static let openItemsHeading = "Open items"
    public static let needsYouGroup = "Needs you"
    public static let withCoordinatorGroup = "With the coordinator"

    /// "1 need you · 2 with the coordinator · oldest first".
    public static func openItemsHint(needsYou: Int, withCoordinator: Int) -> String {
        "\(needsYou) need you · \(withCoordinator) with the coordinator · oldest first"
    }

    /// "You" / "Coordinator".
    public static func who(_ row: ProjectOpenItemRow) -> String {
        row.assignee == .coordinator ? "Coordinator" : "You"
    }

    /// How long an item has waited, and — while it is the coordinator's — when it becomes yours.
    public static func waitingLabel(_ row: ProjectOpenItemRow, now: Date) -> String {
        let since = RelativeTime.parse(row.waitingSince) ?? now
        let waited = RelativeTime.span(now.timeIntervalSince(since))
        if row.assignee == .coordinator {
            guard let escalateAt = row.escalateAt.flatMap(RelativeTime.parse) else {
                return "waiting \(waited)"
            }
            let left = escalateAt.timeIntervalSince(now)
            return left > 0
                ? "\(waited) · goes to you in \(RelativeTime.span(left))"
                : "\(waited) · due to come to you"
        }
        if let escalatedAt = row.escalatedAt, let ago = RelativeTime.ago(escalatedAt, now: now) {
            return "escalated \(ago)"
        }
        return "waiting \(waited)"
    }

    /// The presses a row may lead with, in the web's words. The write actions (Retry, Cancel task,
    /// Ask the coordinator again) live on the item's card in the coordinator conversation.
    public static func actionLabel(_ action: ProjectOpenItemAction) -> String? {
        switch action {
        case .review: return "Review"
        case .answer: return "Answer"
        case .resume: return "Resume"
        case .openCoordinator: return "Open coordinator"
        case .openTaskSession: return "Open task session"
        default: return nil
        }
    }

    /// The press a row leads with: the first the server listed that this client can carry out.
    public static func primaryAction(_ row: ProjectOpenItemRow) -> ProjectOpenItemAction? {
        row.actions.first { action in
            switch action {
            case .review, .answer, .openCoordinator: return true
            case .resume: return row.fuseEpisodeId != nil
            case .openTaskSession: return row.sessionId != nil || row.taskId != nil
            default: return false
            }
        }
    }

    /// Which of the four owner items this row is, as the console that draws its card names them —
    /// what lets a press land on the card rather than only on the conversation.
    public static func ownerItemKind(_ row: ProjectOpenItemRow) -> OwnerItemKind {
        switch row.kind {
        case .promotionApproval: return .promotionApproval
        case .coordinatorQuestion: return .coordinatorQuestion
        case .fusePaused: return .fusePaused
        case .unknown: return .unknown
        case .integrationConflict, .integrationCheckFailed, .integrationError, .taskFailed:
            return .escalated
        }
    }

    // MARK: - Integration line

    /// The line row's facts, in order: "⎇ project/x", "7 commits ahead of main", "synced with main
    /// 12m ago", "Integrating 1 · Queued 0", "Merge check ✓ passing on the branch tip". Nil when no
    /// line has been decided.
    public static func integrationFacts(_ view: ProjectIntegrationView, now: Date) -> [String]? {
        guard let line = view.line, line != .unknown else { return nil }
        let branchLine = line == .projectBranch
        var facts: [String] = [branchLine ? (view.ref ?? "project branch") : (view.upstreamRef ?? "main")]
        if branchLine, let ahead = view.commitsAheadOfUpstream {
            facts.append("\(ahead) commit\(ahead == 1 ? "" : "s") ahead of main")
        }
        if branchLine, let synced = view.lastUpstreamSyncAt, let ago = RelativeTime.ago(synced, now: now) {
            facts.append("synced with main \(ago)")
        }
        facts.append("Integrating \(view.integratingCount) · Queued \(view.queuedCount)")
        let tip: String
        switch view.mergeCheckOnTip {
        case "PASSING": tip = "✓ passing"
        case "FAILING": tip = "✕ failing"
        default: tip = "not run yet"
        }
        facts.append("Merge check \(tip)\(branchLine ? " on the branch tip" : "")")
        return facts
    }

    // MARK: - Tasks

    /// The server's work lane for a row. An older server's row is never promoted to Ready here:
    /// only the canonical classifier may claim "can start now".
    public static func workState(_ t: ProjectTaskRow) -> String {
        if let state = t.workState { return state }
        if t.completionPolicy == "VERIFICATION_PASSED", t.verifiesTaskId == nil {
            return "AWAITING_VERIFICATION"
        }
        switch t.status {
        case "DONE", "CANCELLED", "FAILED": return t.status
        case "IN_PROGRESS": return "RUNNING"
        default: return "BLOCKED"
        }
    }

    /// Held up by nothing but a prerequisite that is finished and not yet landed.
    public static func waitsForLanding(_ t: ProjectTaskRow) -> Bool {
        t.dependencyState != "READY" && (t.landingWaitCount ?? 0) > 0
    }

    private static let integratingStates: Set<String> = [
        "QUEUED", "RUNNING", "CONFLICT", "CHECK_FAILED", "ERROR", "AWAITING_OWNER",
    ]
    private static let landedStates: Set<String> = ["ON_INTEGRATION_LINE", "ON_UPSTREAM"]

    public enum IntegrationStage: Sendable { case integrating, landed }

    public static func integrationStage(_ t: ProjectTaskRow) -> IntegrationStage? {
        guard let state = t.integration?.state else { return nil }
        if integratingStates.contains(state) { return .integrating }
        return landedStates.contains(state) ? .landed : nil
    }

    /// A tag's colour family.
    public enum TagTone: Sendable {
        case neutral, brand, warning, danger, success, verification
    }

    public struct Tag: Equatable, Sendable {
        public let text: String
        public let tone: TagTone
    }

    /// The row's lane as a tag ("Ready · can start now", "Running", "Failed", …), or nil where the
    /// lane goes without saying (done, cancelled, or waiting on a landing the other tag names).
    public static func workTag(_ t: ProjectTaskRow) -> Tag? {
        switch workState(t) {
        case "READY":
            return Tag(text: t.autoRunWhenReady == true ? "Ready · automatic dispatch" : "Ready · can start now",
                       tone: .warning)
        case "RUNNING":
            return Tag(text: "Running", tone: .brand)
        case "BLOCKED":
            return waitsForLanding(t) ? nil : Tag(text: "Blocked", tone: .neutral)
        case "AWAITING_VERIFICATION":
            let text: String
            switch t.verificationState {
            case "FAILED": text = "Verification failed"
            case "MISSING": text = "Missing verifier"
            case "RUNNING": text = "Awaiting verification · verifier running"
            case "BLOCKED": text = "Awaiting verification · verifier blocked"
            case "PASSED": text = "Awaiting verification · applying result"
            default: text = "Awaiting verification"
            }
            return Tag(text: text, tone: t.verificationState == "FAILED" ? .danger : .verification)
        case "FAILED":
            return Tag(text: "Failed", tone: .danger)
        default:
            return nil
        }
    }

    /// Where a row stands between "done" and "on main", naming who has a failure.
    public static func integrationTag(_ t: ProjectTaskRow, ref: String?, upstreamRef: String?) -> Tag? {
        if waitsForLanding(t) {
            let n = t.landingWaitCount ?? 0
            return Tag(text: "Waits for \(n) task\(n == 1 ? "" : "s") to land", tone: .neutral)
        }
        guard let integration = t.integration else { return nil }
        let who = integration.handler == "OWNER" ? "you" : "coordinator"
        switch integration.state {
        case "QUEUED":
            return Tag(text: "Queued for integration", tone: .neutral)
        case "RUNNING":
            guard let ms = integration.checksRunningForMs else { return Tag(text: "Integrating", tone: .brand) }
            return Tag(text: "Integrating · checks \(RelativeTime.span(ms / 1000))", tone: .brand)
        case "CONFLICT": return Tag(text: "Conflict · \(who)", tone: .danger)
        case "CHECK_FAILED": return Tag(text: "Checks failed · \(who)", tone: .danger)
        case "ERROR": return Tag(text: "Integration error · \(who)", tone: .danger)
        case "AWAITING_OWNER": return Tag(text: "Awaiting your approval", tone: .warning)
        case "ON_INTEGRATION_LINE": return Tag(text: "On \(ref ?? "the project branch")", tone: .success)
        case "ON_UPSTREAM": return Tag(text: "On \(upstreamRef ?? "main")", tone: .success)
        default: return nil
        }
    }

    /// One band of the task list.
    public struct TaskGroup: Equatable, Sendable, Identifiable {
        public let key: String
        public let heading: String
        public let tasks: [ProjectTaskRow]
        /// The trailing band of finished work, which the list dims.
        public let settled: Bool
        public var id: String { key }
    }

    /// A page of tasks in the web's bands: what is running, integrating, ready, awaiting
    /// verification, failed or waiting on a landing; then what is blocked, by topological level;
    /// then what has landed; finished work last. It only partitions — the server's order inside a
    /// band is kept.
    public static func taskGroups(_ items: [ProjectTaskRow]) -> [TaskGroup] {
        var running: [ProjectTaskRow] = [], integrating: [ProjectTaskRow] = []
        var ready: [ProjectTaskRow] = [], awaiting: [ProjectTaskRow] = []
        var failed: [ProjectTaskRow] = [], waitingForLanding: [ProjectTaskRow] = []
        var landed: [ProjectTaskRow] = [], settled: [ProjectTaskRow] = []
        var byLevel: [Int: [ProjectTaskRow]] = [:]
        for task in items {
            let stage = integrationStage(task)
            let state = workState(task)
            if state == "RUNNING" { running.append(task) }
            else if stage == .integrating { integrating.append(task) }
            else if stage == .landed { landed.append(task) }
            else if state == "READY" { ready.append(task) }
            else if state == "AWAITING_VERIFICATION" { awaiting.append(task) }
            else if state == "FAILED" { failed.append(task) }
            else if state == "DONE" || state == "CANCELLED" { settled.append(task) }
            else if waitsForLanding(task) { waitingForLanding.append(task) }
            else { byLevel[task.topoLevel, default: []].append(task) }
        }
        var groups: [TaskGroup] = []
        func add(_ key: String, _ heading: String, _ tasks: [ProjectTaskRow], settled: Bool = false) {
            if !tasks.isEmpty { groups.append(TaskGroup(key: key, heading: heading, tasks: tasks, settled: settled)) }
        }
        add("running", "Running", running)
        add("integrating", "Integrating · checks run on the combined tree", integrating)
        add("ready", "Ready · can start now", ready)
        add("awaiting-verification", "Awaiting verification · subject work must not be started", awaiting)
        add("failed", "Failed · coordinated continuation", failed)
        add("waiting-for-landing", "Waiting · for a prerequisite to land", waitingForLanding)
        for level in byLevel.keys.sorted() {
            add("level-\(level)",
                level == 0 ? "Blocked · no executable work at this level" : "Blocked · topology level \(level)",
                byLevel[level] ?? [])
        }
        add("landed", "Landed", landed)
        add("settled", "Done / Cancelled", settled, settled: true)
        return groups
    }

    /// Which way a task row's mark is drawn, by the task's own status.
    public static func taskGlyph(_ t: ProjectTaskRow) -> Glyph {
        switch t.status {
        case "IN_PROGRESS": return .disc
        case "OPEN": return .triangle
        case "DONE": return .check
        case "CANCELLED": return .square
        case "FAILED": return .cross
        default: return .square
        }
    }

    // MARK: - words

    private static func plural(_ n: Int, _ one: String, _ many: String) -> String {
        "\(n) \(n == 1 ? one : many)"
    }
}
