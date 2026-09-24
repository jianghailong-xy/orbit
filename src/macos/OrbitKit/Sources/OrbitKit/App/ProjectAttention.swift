import Foundation

/// The projects index as an execution-and-attention router — a port of the web's
/// `src/web/src/lib/projectAttention.ts`, so both clients put the same project in the same lane,
/// in the same order, under the same words.
///
/// A row first answers whether something requires a person, then whether work is actively running;
/// when neither applies it answers who must act next, and time orders the rows that need the same
/// kind of action. Raw `ready` counts never rank projects: splitting one unit of work into ten
/// thousand shards must not make a project ten thousand times more important.
///
/// Pure (the clock is a parameter) and view-free, so it is tested on Linux; the copy is held to
/// the web source by `ProjectAttentionCopyParityTests`.

/// The six lanes, in next-actor order.
public enum ProjectAttentionSection: String, CaseIterable, Sendable, Identifiable {
    case attention, running, ready, waiting, definition, completed

    public var id: String { rawValue }

    public var title: String {
        switch self {
        case .attention: return "Needs attention"
        case .running: return "Running"
        case .ready: return "Ready"
        case .waiting: return "Waiting"
        case .definition: return "Needs definition"
        case .completed: return "Completed"
        }
    }

    /// Why a row is in this lane and how the lane is ordered, as the web's section header says it.
    public var note: String {
        switch self {
        case .attention:
            return "Owner-only decisions, stale coordination, non-convergence, quiet work, or closure · reason/severity first, then oldest signal"
        case .running: return "Fresh work in flight · newest task activity first"
        case .ready: return "Can start now, nothing running · oldest task activity first"
        case .waiting:
            return "Dependency-blocked or verification-gated work remains · oldest task activity first"
        case .definition: return "No tasks filed yet · title A–Z"
        case .completed: return "Closed projects · newest task activity first · folded by default"
        }
    }

    public var defaultCollapsed: Bool { self == .completed }
}

/// Why an OPEN project carries a signal. The first four are the items a project waits on its
/// OWNER for, named after the item's own kind in the words the needs-you banner and push use.
public enum ProjectAttentionReason: String, Sendable {
    case approveMergeToMain = "approve-merge-to-main"
    case coordinatorQuestion = "coordinator-question"
    case escalatedToYou = "escalated-to-you"
    case fusePaused = "fuse-paused"
    /// The coordinator is working an exception: the project is moving, so it explains a chip and
    /// never moves a row.
    case coordinatorHandling = "coordinator-handling"
    case needsUser = "needs-user"
    case autoRemediation = "auto-remediation"
    case noActivityRunning = "no-activity-running"
    case noActivityReady = "no-activity-ready"
    case readyToClose = "ready-to-close"

    public var isOwnerItem: Bool {
        switch self {
        case .approveMergeToMain, .coordinatorQuestion, .escalatedToYou, .fusePaused: return true
        default: return false
        }
    }

    /// One tier for the four owner items — which of them is asked is a fact about the project,
    /// the reader's queue is that they are asked at all.
    fileprivate var rank: Int {
        switch self {
        case .approveMergeToMain, .coordinatorQuestion, .escalatedToYou, .fusePaused: return 1
        case .needsUser: return 2
        case .autoRemediation: return 3
        case .noActivityRunning: return 4
        case .noActivityReady: return 5
        case .readyToClose: return 6
        case .coordinatorHandling: return 7
        }
    }
}

/// The row-level explanation for why a project leads the page.
public struct ProjectAttentionChip: Equatable, Sendable {
    public enum Tone: Sendable {
        /// Something a person should look at.
        case warning
        /// Informational: the coordinator is on it, or the work is all settled.
        case brand
    }

    public let tone: Tone
    public let text: String

    public init(tone: Tone, text: String) {
        self.tone = tone
        self.text = text
    }
}

/// Where a project's finished work lands, as a row states it beside the title.
public struct ProjectIntegrationChip: Equatable, Sendable {
    /// The branch's own name — on a `MAIN` line, the upstream the project merges into.
    public let text: String
    /// Whether to draw the branch mark: a project branch is a branch, the upstream is where
    /// everything ends up.
    public let isBranch: Bool

    public init(text: String, isBranch: Bool) {
        self.text = text
        self.isBranch = isBranch
    }
}

/// One lane of the index with its rows in display order.
public struct ProjectAttentionGroup: Equatable, Sendable, Identifiable {
    public let section: ProjectAttentionSection
    public let projects: [ProjectSummary]
    public var id: ProjectAttentionSection { section }

    public init(section: ProjectAttentionSection, projects: [ProjectSummary]) {
        self.section = section
        self.projects = projects
    }
}

/// How a project reads as one line of the navigation drawer.
public enum ProjectDrawerMark: Equatable, Sendable {
    /// One of the four owner items is waiting on the reader.
    case needsYou
    /// Tasks are running.
    case running
    case idle
}

public enum ProjectAttention {
    private static let minute: TimeInterval = 60
    private static let hour: TimeInterval = 3_600
    private static let day: TimeInterval = 86_400

    /// One full day without a task write is an operational exception, not ordinary turn latency.
    public static let quietInterval: TimeInterval = day

    /// Every owner item kind in the order a tie between them is settled — the contract's own order.
    private static let ownerItemOrder: [OwnerItemKind] = [
        .promotionApproval, .coordinatorQuestion, .escalated, .fusePaused,
    ]

    // MARK: instants

    /// A readable instant as seconds since 1970; missing or unreadable is unknown and sorts last.
    private static func rank(_ iso: String?) -> Double {
        guard let iso, let date = RelativeTime.parse(iso) else { return -.infinity }
        return date.timeIntervalSince1970
    }

    private static func byInstantDesc(_ left: String?, _ right: String?) -> Int {
        let l = rank(left), r = rank(right)
        if l == r { return 0 }
        return r > l ? 1 : -1
    }

    /// Oldest real instant first; missing or invalid instants are unknown and therefore sort last.
    private static func byInstantAsc(_ left: String?, _ right: String?) -> Int {
        let l = rank(left), r = rank(right)
        if l == r { return 0 }
        if l == -.infinity { return 1 }
        if r == -.infinity { return -1 }
        return l < r ? -1 : 1
    }

    private static func byID(_ a: ProjectSummary, _ b: ProjectSummary) -> Int {
        a.id == b.id ? 0 : (a.id < b.id ? -1 : 1)
    }

    /// Whole quiet days, or nil when the timestamp is missing, invalid, future, or still fresh.
    private static func quietDays(_ lastActivityAt: String?, now: Date) -> Int? {
        let at = rank(lastActivityAt)
        if at == -.infinity { return nil }
        let quiet = now.timeIntervalSince1970 - at
        return quiet < quietInterval ? nil : Int((quiet / day).rounded(.down))
    }

    /// Compact age for a blocker chip. Future or unreadable instants make no age claim.
    private static func elapsedDayLabel(_ iso: String?, now: Date) -> String? {
        let at = rank(iso)
        let nowSeconds = now.timeIntervalSince1970
        if at == -.infinity || at > nowSeconds { return nil }
        let days = Int(((nowSeconds - at) / day).rounded(.down))
        return days == 0 ? "<1d" : "\(days)d"
    }

    /// How long an item has been waiting, for the chips that name one: `20m`, `2h`, `3d`.
    private static func elapsedLabel(_ iso: String?, now: Date) -> String? {
        let at = rank(iso)
        let nowSeconds = now.timeIntervalSince1970
        if at == -.infinity || at > nowSeconds { return nil }
        let waited = nowSeconds - at
        if waited < minute { return "<1m" }
        if waited < hour { return "\(Int((waited / minute).rounded(.down)))m" }
        if waited < day { return "\(Int((waited / hour).rounded(.down)))h" }
        return "\(Int((waited / day).rounded(.down)))d"
    }

    // MARK: facts about one row

    /// Current servers report FAILED explicitly; the remainder is derived only for an older server.
    public static func failedTaskCount(_ project: ProjectSummary) -> Int {
        if let failed = project.buckets.failed { return failed }
        let b = project.buckets
        return max(0, project.taskCount - b.running - b.ready - b.blocked
            - b.awaitingVerification - b.done - b.cancelled)
    }

    private static func autoRemediationBlockerCount(_ project: ProjectSummary) -> Int {
        (project.attention?.coordinatorBlockers ?? 0) + (project.attention?.systemBlockers ?? 0)
    }

    /// The owner item the row leads with: the one that has waited longest, with a fixed kind order
    /// settling a tie so two equally old items produce the same chip on every read.
    public static func leadOwnerItem(_ project: ProjectSummary) -> ProjectListOwnerItem? {
        let items = project.attention?.ownerItems ?? []
        var lead: ProjectListOwnerItem?
        for kind in ownerItemOrder {
            guard let item = items.first(where: { $0.kind == kind }) else { continue }
            if let current = lead {
                if byInstantAsc(item.oldestWaitingSince, current.oldestWaitingSince) < 0 { lead = item }
            } else {
                lead = item
            }
        }
        return lead
    }

    private static func reason(for kind: OwnerItemKind) -> ProjectAttentionReason? {
        switch kind {
        case .promotionApproval: return .approveMergeToMain
        case .coordinatorQuestion: return .coordinatorQuestion
        case .escalated: return .escalatedToYou
        case .fusePaused: return .fusePaused
        case .unknown: return nil
        }
    }

    /// Why an OPEN project needs a visible signal, or nil when it does not.
    public static func reason(of project: ProjectSummary, now: Date) -> ProjectAttentionReason? {
        guard project.status == .open else { return nil }

        // An item sitting on the OWNER outranks everything else the row could say.
        if let lead = leadOwnerItem(project), let reason = reason(for: lead.kind) { return reason }

        if autoRemediationBlockerCount(project) > 0 { return .autoRemediation }
        if (project.attention?.userBlockers ?? 0) > 0 { return .needsUser }

        let b = project.buckets
        let quiet = quietDays(project.lastActivityAt, now: now)
        if b.running > 0, quiet != nil { return .noActivityRunning }
        if b.running == 0, b.ready > 0, quiet != nil { return .noActivityReady }

        if b.running + b.ready + b.blocked + b.awaitingVerification + failedTaskCount(project) == 0,
           b.done + b.cancelled > 0 {
            return .readyToClose
        }

        // Last, and only when nothing else is wrong: the coordinator working an exception is the
        // project moving.
        if project.attention?.coordinatorItems != nil { return .coordinatorHandling }
        return nil
    }

    /// Every project lands in exactly one lane.
    public static func section(of project: ProjectSummary, now: Date) -> ProjectAttentionSection {
        guard project.status == .open else { return .completed }
        let reason = reason(of: project, now: now)
        let b = project.buckets

        // Work Orbit already routed to its coordinator/system, or an item waiting on a person, is
        // stronger than fresh activity in the same project.
        if reason == .autoRemediation { return .attention }
        if let reason, reason.isOwnerItem { return .attention }

        let quietRunning = b.running > 0 && quietDays(project.lastActivityAt, now: now) != nil
        if b.running > 0, !quietRunning { return .running }

        // A coordinator working an exception earns the lane its activity earns.
        if let reason, reason != .coordinatorHandling { return .attention }
        if project.taskCount == 0 { return .definition }
        if b.ready > 0 { return .ready }
        if b.blocked > 0 || b.awaitingVerification > 0 { return .waiting }
        // A normal failure is waiting on its automatic continuation, not on the owner.
        if failedTaskCount(project) > 0 { return .waiting }
        // Only an inconsistent or mixed-version payload reaches here.
        return .definition
    }

    private static func severityRank(_ severity: ProjectAttentionSeverity?) -> Int {
        switch severity {
        case .critical?: return 0
        case .warning?: return 1
        case .info?: return 2
        case .unknown?, nil: return Int.max
        }
    }

    private static func severityLabel(_ severity: ProjectAttentionSeverity?) -> String? {
        switch severity {
        case .critical?: return "Critical"
        case .warning?: return "Warning"
        case .info?: return "Info"
        case .unknown?, nil: return nil
        }
    }

    /// The visible order inside one lane. Returns a new array.
    public static func ordered(_ projects: [ProjectSummary], in section: ProjectAttentionSection,
                               now: Date) -> [ProjectSummary] {
        projects.sorted { compare($0, $1, in: section, now: now) < 0 }
    }

    private static func compare(_ a: ProjectSummary, _ b: ProjectSummary,
                                in section: ProjectAttentionSection, now: Date) -> Int {
        switch section {
        case .attention:
            let left = reason(of: a, now: now)
            let right = reason(of: b, now: now)
            let byReason = (left?.rank ?? Int.max) - (right?.rank ?? Int.max)
            if byReason != 0 { return byReason < 0 ? -1 : 1 }
            if let left, let right, left.isOwnerItem, right.isOwnerItem {
                let byWait = byInstantAsc(leadOwnerItem(a)?.oldestWaitingSince,
                                          leadOwnerItem(b)?.oldestWaitingSince)
                if byWait != 0 { return byWait }
            }
            if (left == .needsUser && right == .needsUser)
                || (left == .autoRemediation && right == .autoRemediation) {
                let l = severityRank(a.attention?.maxSeverity)
                let r = severityRank(b.attention?.maxSeverity)
                if l != r { return l < r ? -1 : 1 }
                let byAge = byInstantAsc(a.attention?.attentionSinceAt, b.attention?.attentionSinceAt)
                if byAge != 0 { return byAge }
            }
            let byActivity = byInstantAsc(a.lastActivityAt, b.lastActivityAt)
            return byActivity != 0 ? byActivity : byID(a, b)
        case .running, .completed:
            let byActivity = byInstantDesc(a.lastActivityAt, b.lastActivityAt)
            return byActivity != 0 ? byActivity : byID(a, b)
        case .definition:
            let byTitle = a.title.compare(b.title, options: [.caseInsensitive])
            if byTitle != .orderedSame { return byTitle == .orderedAscending ? -1 : 1 }
            return byID(a, b)
        case .ready, .waiting:
            let byActivity = byInstantAsc(a.lastActivityAt, b.lastActivityAt)
            return byActivity != 0 ? byActivity : byID(a, b)
        }
    }

    /// The complete index: all six lanes in order (empty ones included — the view drops them),
    /// each ordered for display.
    public static func sections(_ all: [ProjectSummary], now: Date) -> [ProjectAttentionGroup] {
        var grouped: [ProjectAttentionSection: [ProjectSummary]] = [:]
        for project in all { grouped[section(of: project, now: now), default: []].append(project) }
        return ProjectAttentionSection.allCases.map { section in
            ProjectAttentionGroup(section: section,
                                  projects: ordered(grouped[section] ?? [], in: section, now: now))
        }
    }

    // MARK: words

    private static func coordinatorLeadCopy(_ kind: CoordinatorLeadKind) -> String? {
        switch kind {
        case .integrationConflict: return "resolving a merge conflict"
        case .integrationCheckFailed: return "checks failed"
        case .integrationError: return "handling an integration error"
        case .taskFailed: return "handling a failed task"
        case .unknown: return nil
        }
    }

    /// What the row says the owner must do, by the item's kind.
    public static func ownerItemSays(_ item: ProjectListOwnerItem) -> String? {
        switch item.kind {
        case .promotionApproval: return "Needs you · Approve merge to main"
        case .coordinatorQuestion:
            return "Needs you · \(item.count) question\(item.count == 1 ? "" : "s") from coordinator"
        case .escalated: return "Needs you · \(item.count) escalated to you"
        case .fusePaused: return "Paused · coordinator stopped itself"
        case .unknown: return nil
        }
    }

    private static func joined(_ parts: [String?]) -> String {
        parts.compactMap { $0 }.joined(separator: " · ")
    }

    /// The chip beside the title, or nil for a row that needs none.
    public static func chip(of project: ProjectSummary, now: Date) -> ProjectAttentionChip? {
        guard let reason = reason(of: project, now: now) else { return nil }
        let b = project.buckets

        switch reason {
        case .approveMergeToMain, .coordinatorQuestion, .escalatedToYou, .fusePaused:
            guard let item = leadOwnerItem(project), let says = ownerItemSays(item) else { return nil }
            return ProjectAttentionChip(
                tone: .warning,
                text: joined([says, elapsedLabel(item.oldestWaitingSince, now: now)]))

        case .coordinatorHandling:
            guard let held = project.attention?.coordinatorItems else { return nil }
            return ProjectAttentionChip(
                tone: .brand,
                text: joined(["Coordinator", coordinatorLeadCopy(held.leadKind),
                              elapsedLabel(held.oldestWaitingSince, now: now)]))

        case .needsUser:
            let blockers = project.attention?.userBlockers ?? 0
            return ProjectAttentionChip(
                tone: .warning,
                text: joined([
                    "Needs you",
                    severityLabel(project.attention?.maxSeverity),
                    elapsedDayLabel(project.attention?.attentionSinceAt, now: now),
                    "\(blockers) blocker\(blockers == 1 ? "" : "s")",
                ]))

        case .autoRemediation:
            let blockers = autoRemediationBlockerCount(project)
            let userBlockers = project.attention?.userBlockers ?? 0
            return ProjectAttentionChip(
                tone: .warning,
                text: joined([
                    "Auto-remediation",
                    "Coordinator-owned",
                    severityLabel(project.attention?.maxSeverity),
                    elapsedDayLabel(project.attention?.attentionSinceAt, now: now),
                    "\(blockers) blocker\(blockers == 1 ? "" : "s")",
                    userBlockers > 0 ? "\(userBlockers) need you" : nil,
                ]))

        case .readyToClose:
            let settled = b.done + b.cancelled
            let total = b.running + b.ready + b.blocked + b.awaitingVerification
                + failedTaskCount(project) + settled
            return ProjectAttentionChip(tone: .brand, text: "\(settled)/\(total) settled · still open")

        case .noActivityRunning:
            guard let days = quietDays(project.lastActivityAt, now: now) else { return nil }
            return ProjectAttentionChip(tone: .warning, text: "Running · no activity \(days)d")

        case .noActivityReady:
            guard let days = quietDays(project.lastActivityAt, now: now) else { return nil }
            return ProjectAttentionChip(tone: .warning, text: "Ready · no activity \(days)d")
        }
    }

    /// The line a row lands on, in the branch's own name; nil when no line has been decided.
    public static func integrationChip(of project: ProjectSummary) -> ProjectIntegrationChip? {
        guard let integration = project.integration, !integration.ref.isEmpty else { return nil }
        return ProjectIntegrationChip(text: integration.ref,
                                      isBranch: integration.line == .projectBranch)
    }

    // MARK: the drawer

    /// Whether one of the four owner items is waiting on the reader in this project.
    public static func needsYou(_ project: ProjectSummary) -> Bool {
        project.status == .open
            && (project.attention?.ownerItems ?? []).contains { $0.kind != .unknown && $0.count > 0 }
    }

    /// How many projects have something waiting on the reader in person — the drawer's count.
    /// Deliberately not the Needs attention lane's size: a project that merely went quiet is not
    /// something the reader was asked for.
    public static func needsYouCount(_ all: [ProjectSummary]) -> Int {
        all.filter(needsYou).count
    }

    public static func drawerMark(_ project: ProjectSummary) -> ProjectDrawerMark {
        if needsYou(project) { return .needsYou }
        if project.buckets.running > 0 { return .running }
        return .idle
    }

    /// The drawer's project rows: open projects only, the ones waiting on the reader first (longest
    /// wait first), then by most recent task activity.
    public static func drawerProjects(_ all: [ProjectSummary]) -> [ProjectSummary] {
        all.filter { $0.status == .open }.sorted { a, b in
            let aNeeds = needsYou(a), bNeeds = needsYou(b)
            if aNeeds != bNeeds { return aNeeds }
            if aNeeds {
                let byWait = byInstantAsc(leadOwnerItem(a)?.oldestWaitingSince,
                                          leadOwnerItem(b)?.oldestWaitingSince)
                if byWait != 0 { return byWait < 0 }
            }
            let byActivity = byInstantDesc(a.lastActivityAt, b.lastActivityAt)
            if byActivity != 0 { return byActivity < 0 }
            let byCreated = byInstantDesc(a.createdAt, b.createdAt)
            if byCreated != 0 { return byCreated < 0 }
            return a.id < b.id
        }
    }
}
