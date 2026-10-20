import Foundation

/// A task's newest `LAND_TASK`, as the server's read model describes it (contract §2.7a) — on the
/// task's page and on the project's integration view, in the same words, from the same fields.
///
/// DONE is the task's status; this is its landing. The two are drawn apart because a DONE task whose
/// work is still waiting, running or stopped is not on its branch yet, and a page that showed only
/// the first read as finished work that had not arrived anywhere.
///
/// Read-only by design: no retry, merge or release button. A port of the web's `LandTaskStatus`, and
/// its words are held to that file by `TaskDetailCopyParityTests`.
public enum TaskLandingCopy {
    public static let landingSection = "Landing"
    /// What each state of a landing attempt is called, wherever one is shown.
    public static let labels: [String: String] = [
        "QUEUED": "Waiting to land",
        "RUNNING": "Landing",
        "LANDED": "Landed",
        "ALREADY_LANDED": "Already landed",
        "NOTHING_TO_LAND": "Nothing to land",
        "READY": "Ready to merge",
        "CONFLICT": "Landing conflict",
        "CHECK_FAILED": "Landing checks failed",
        "ERROR": "Landing error",
        "CANCELLED": "Landing cancelled",
        "SUPERSEDED": "Landing superseded",
    ]
    /// The badge's ink per state: amber, blue, green, muted or red.
    public static let tones: [String: String] = [
        "QUEUED": "amber",
        "RUNNING": "blue",
        "LANDED": "green",
        "ALREADY_LANDED": "green",
        "NOTHING_TO_LAND": "muted",
        "READY": "amber",
        "CONFLICT": "red",
        "CHECK_FAILED": "red",
        "ERROR": "red",
        "CANCELLED": "muted",
        "SUPERSEDED": "muted",
    ]
    public static let taskPrefix = "Task "
    public static let generation = "generation"
    public static let stoppedWhile = "stopped while"
    public static let onPrefix = "On "
    public static let waitingNotQueued = "Waiting to land: the landing has not been queued yet"
    /// The two receipt sentences: a receipt says where the work IS, and no attempt after it takes
    /// that back.
    public static func receiptOn(_ main: String) -> String {
        "Its work is on \(main) by an existing receipt."
    }
    public static let receiptOnBranch = "Its work is on the project branch by an existing receipt."
    /// The fact rows under the badge, in the web's order.
    public static let targetLabel = "Target"
    public static let queueWaitLabel = "Queue wait"
    public static let queuedLabel = "Queued"
    public static let startedLabel = "Started"
    public static let heartbeatLabel = "Heartbeat"
    public static let finishedLabel = "Finished"
    /// The one liveness fact with no other place on this page: a legacy claim reports only between
    /// steps. The web's `LANDING_LIVENESS_WORDS.REPORTS_ONLY_BETWEEN_STEPS`.
    public static let reportsOnlyBetweenSteps = "Reports only between steps"

    /// §2.7a's cadence for the task page: a landing that RUNS is read every 4 s, a queued one every
    /// 15 s, and a settled one not at all.
    public static func refetchInterval(_ integration: TaskIntegrationView?) -> TimeInterval? {
        switch integration?.landTask?.state ?? integration?.state {
        case "RUNNING": return 4
        case "QUEUED": return 15
        default: return nil
        }
    }
}

/// One task's Landing section, as its page draws it.
public struct TaskLandingStatus: Equatable, Sendable {
    public struct Badge: Equatable, Sendable {
        public let label: String
        /// `amber`, `blue`, `green`, `muted` or `red`.
        public let tone: String

        public init(label: String, tone: String) {
            self.label = label
            self.tone = tone
        }
    }

    public struct Fact: Equatable, Sendable {
        public let label: String
        public let value: String

        public init(label: String, value: String) {
            self.label = label
            self.value = value
        }
    }

    public let badge: Badge?
    public let generation: String?
    /// `checking`, or `stopped while checking` for an attempt that stopped at a step.
    public let step: String?
    public let noReport: String?
    public let legacy: String?
    public let reason: String?
    public let receipt: String?
    public let facts: [Fact]
    /// The landing session this task's newest generation belongs to (§2.9 LS6), which the section's
    /// "Open landing ›" opens. Nil on a task that never landed, and on a server that predates it.
    public let landingSessionId: String?

    public init(badge: Badge? = nil, generation: String? = nil, step: String? = nil,
                noReport: String? = nil, legacy: String? = nil, reason: String? = nil,
                receipt: String? = nil, facts: [Fact] = [], landingSessionId: String? = nil) {
        self.badge = badge
        self.generation = generation
        self.step = step
        self.noReport = noReport
        self.legacy = legacy
        self.reason = reason
        self.receipt = receipt
        self.facts = facts
        self.landingSessionId = landingSessionId
    }
}

public enum TaskLandingLogic {
    /// The badge a task's page puts beside its status: the newest attempt when there is one,
    /// otherwise where the receipts say the work is — on `main`, the project's main branch by name.
    /// Nil when the task has no landing to speak of.
    public static func badge(_ integration: TaskIntegrationView?,
                             main: String = "main") -> TaskLandingStatus.Badge? {
        if let job = integration?.landTask {
            return TaskLandingStatus.Badge(
                label: TaskLandingCopy.labels[job.state] ?? job.state,
                tone: TaskLandingCopy.tones[job.state] ?? "muted")
        }
        switch integration?.state {
        // Done code work on a line whose landing has not been queued yet (§2.3 J-T1d).
        case "QUEUED":
            return TaskLandingStatus.Badge(label: TaskLandingCopy.labels["QUEUED"]!,
                                           tone: TaskLandingCopy.tones["QUEUED"]!)
        case "ON_INTEGRATION_LINE":
            return TaskLandingStatus.Badge(label: TaskLandingCopy.labels["LANDED"]!,
                                           tone: TaskLandingCopy.tones["LANDED"]!)
        case "ON_UPSTREAM":
            return TaskLandingStatus.Badge(label: "\(TaskLandingCopy.onPrefix)\(main)", tone: "green")
        default:
            return nil
        }
    }

    /// The stops a page reads a step word for.
    static let stopped: Set<String> = ["CONFLICT", "CHECK_FAILED", "ERROR"]

    /// The section, or nil for a task with no landing to speak of.
    public static func status(_ integration: TaskIntegrationView?, taskStatus: String? = nil,
                              now: Date = Date(), main: String = "main") -> TaskLandingStatus? {
        guard let integration, let badge = badge(integration, main: main) else { return nil }
        let job = integration.landTask
        let phaseWords = ProjectPage.integrationPhaseWords(main)
        let step: String?
        if let job, let phase = job.phase, job.state == "RUNNING" || stopped.contains(job.state) {
            step = phaseWords[phase]
        } else {
            step = nil
        }
        let receipt = integration.state == "ON_INTEGRATION_LINE" || integration.state == "ON_UPSTREAM"
        // A claimed job whose runner has gone quiet: no report at all, or none since the claim
        // lease the server itself uses. A silent runner is neither a stop nor a timeout — the
        // job's own verdict is the only thing that ever says "timed out".
        let heartbeat = job?.heartbeatAt.flatMap(RelativeTime.parse)
        let reported = heartbeat != nil
        let minutes = heartbeat.map { max(0, Int(now.timeIntervalSince($0) / 60)) } ?? 0
        let liveness = job?.liveness
        let runner = job?.runnerName
        let silent = liveness.map { $0 == "SILENT" }
            ?? (job?.state == "RUNNING" && (heartbeat == nil || now.timeIntervalSince(heartbeat!) > 600))
        let noReport: String?
        if let liveness {
            switch liveness {
            case "LEASE_EXPIRED":
                noReport = reported
                    ? ProjectPage.landingNoReportFor(minutes) : ProjectPage.landingNoReportYet
            case "SILENT":
                let who = (runner.flatMap { $0.isEmpty ? nil : $0 })
                    .map { "\(ProjectPage.landingNoWordFromRunner) \($0)" }
                    ?? ProjectPage.landingNoWordFromTheRunner
                noReport = "\(who) for \(minutes)m"
            default:
                noReport = nil
            }
        } else if silent {
            noReport = reported
                ? ProjectPage.landingNoReportFor(minutes) : ProjectPage.landingNoReportYet
        } else {
            noReport = nil
        }
        let legacy = liveness == "LEGACY" ? TaskLandingCopy.reportsOnlyBetweenSteps : nil
        let receiptLine: String?
        if receipt, let job, job.state != "LANDED", job.state != "ALREADY_LANDED" {
            receiptLine = integration.state == "ON_UPSTREAM"
                ? TaskLandingCopy.receiptOn(main) : TaskLandingCopy.receiptOnBranch
        } else {
            receiptLine = nil
        }
        return TaskLandingStatus(
            badge: badge,
            generation: job?.generation,
            step: step.map { job?.state == "RUNNING" ? $0 : "\(TaskLandingCopy.stoppedWhile) \($0)" },
            noReport: noReport, legacy: legacy,
            reason: job?.blockingReason?.summary,
            receipt: receiptLine,
            facts: facts(job),
            landingSessionId: job?.landingSessionId)
    }

    /// The six rows under the badge, from the job row's own columns.
    static func facts(_ job: LandTaskIntegrationView?) -> [TaskLandingStatus.Fact] {
        guard let job else { return [] }
        func time(_ iso: String?) -> String {
            guard let iso, let date = RelativeTime.parse(iso) else { return "—" }
            return instant.string(from: date)
        }
        let wait = job.waitMs.map { $0 < 1_000 ? "0s" : RelativeTime.span(Double($0) / 1_000) } ?? "0s"
        return [
            TaskLandingStatus.Fact(label: TaskLandingCopy.targetLabel, value: branch(job.targetRef)),
            TaskLandingStatus.Fact(label: TaskLandingCopy.queueWaitLabel, value: wait),
            TaskLandingStatus.Fact(label: TaskLandingCopy.queuedLabel, value: time(job.queuedAt)),
            TaskLandingStatus.Fact(label: TaskLandingCopy.startedLabel, value: time(job.startedAt)),
            TaskLandingStatus.Fact(label: TaskLandingCopy.heartbeatLabel, value: time(job.heartbeatAt)),
            TaskLandingStatus.Fact(label: TaskLandingCopy.finishedLabel, value: time(job.finishedAt)),
        ]
    }

    /// `refs/heads/project/x` as a branch is spoken of.
    public static func branch(_ ref: String) -> String {
        ref.replacingOccurrences(of: "refs/heads/", with: "")
    }

    /// One formatter for every fact instant, built once: the section redraws on each read.
    private static let instant: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US")
        f.dateFormat = "MMM d, h:mm:ss a"
        return f
    }()
}
