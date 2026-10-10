import Foundation

/// What one project's page says, card by card — ported from the web's project page so both clients
/// describe the same project facts: `ProjectPanoramaHeader.tsx` (Work overview),
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

    /// What Ready's footnote says on a project nobody has started (mock board3 ②): its ready tasks
    /// start when the owner starts the project and not before, so "can start now" would be the one
    /// untrue thing about them.
    public static let readyUntilStarted = "starts when you start"
    public static let readyWhilePaused = "project is paused"

    /// The cells the card draws, in reading order. A project that integrates splits Done into
    /// Pending landing / On project branch / On main (the branch lane dropped on a `MAIN` line), and draws
    /// the lanes outside that sum only when they are non-zero; one that does not draws the seven
    /// lanes, Done carrying its share of the whole. `started` is whether anybody has started the
    /// project; only `false` changes anything — Ready's footnote.
    public static func overviewCells(_ b: ProjectPanoramaBuckets, taskCount: Int,
                                     line: IntegrationLine?, started: Bool? = nil,
                                     paused: Bool = false, manualReadyCount: Int = 0) -> [OverviewCell] {
        let readyFootnote = started == false ? readyUntilStarted : paused ? readyWhilePaused
            : b.ready > 0 && manualReadyCount == b.ready ? "can start manually" : "can start now"
        if reportsIntegrationLanes(b) {
            var lanes: [OverviewCell] = [
                OverviewCell(key: "running", label: "Running", value: b.running,
                             footnote: "task work in progress", glyph: .disc),
                OverviewCell(key: "ready", label: "Ready", value: b.ready,
                             footnote: readyFootnote, glyph: .triangle),
                OverviewCell(key: "blocked", label: "Waiting", value: b.blocked,
                             footnote: (b.waitingForLanding ?? 0) > 0
                                ? "\(b.waitingForLanding ?? 0) waiting for a prerequisite to land" : "waiting on dependencies",
                             glyph: .square),
                OverviewCell(key: "integrating", label: "Pending landing", value: b.integrating ?? 0,
                             footnote: "no landing receipt yet", glyph: .hourglass),
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
                         footnote: "task work in progress", glyph: .disc),
            OverviewCell(key: "ready", label: "Ready", value: b.ready,
                         footnote: readyFootnote, glyph: .triangle),
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

    // MARK: - Work overview: the landing in flight

    /// The landing in flight, in the words the card's live line uses — the one row that says what
    /// the platform itself is doing while a project's numbers stand still.
    ///
    /// The card needed it because its own counts cannot say it: a landing holds no task session, so
    /// `Running` is 0 through the four minutes it takes, and the only non-zero cell is `Integrating`
    /// whose footnote is a term of art. The owner read exactly that page on 2026-09-25 and concluded
    /// the project had stopped.
    public struct LandingLine: Equatable, Sendable {
        public let word: String
        /// The task being landed, "N jobs" (with how many timed out) when more than one is in
        /// flight, or nil when the job names no single task (a promotion, a merge check) — the row
        /// then draws its word and state alone.
        public let what: String?
        /// Whether the job is running, as opposed to still waiting its
        /// turn. What the ring's spin and the two brand-blue words are drawn from; the `state` word
        /// is what carries the same fact to a reader who cannot use motion.
        public let running: Bool
        /// The reported job phase, "queued", or "Timed out".
        public let state: String
        /// "1m 20s" (see `landingClock`), or a timed-out job's silence in whole minutes, "110m".
        public let clock: String
        public let clockLabel: String
        /// When the line was last updated — or, for a timed-out job, its limit ("limit 10m").
        public let updated: String?
        /// "2m 24s" — what the job waited for a runner before the claim, or nil when it never waited,
        /// the read does not say, or it has not been claimed at all (a queued job's whole clock is
        /// that wait, which `clockLabel` says).
        public let wait: String?
        /// The server judged the job's runner silent past its limit: the row says so in the warning
        /// ink, with a triangle where the ring was, and nothing spins.
        public let timedOut: Bool

        public init(what: String?, running: Bool, state: String, clock: String, word: String = "Integration",
                    clockLabel: String = "Elapsed", updated: String? = nil, wait: String? = nil,
                    timedOut: Bool = false) {
            self.word = word
            self.what = what
            self.running = running
            self.state = state
            self.clock = clock
            self.clockLabel = clockLabel
            self.updated = updated
            self.wait = wait
            self.timedOut = timedOut
        }
    }

    /// One job of the list the landing row opens (docs/mocks/landing-jobs-sheet), drawn as the row
    /// itself.
    public struct LandingJobLine: Equatable, Sendable, Identifiable {
        public let jobId: String
        /// The task a press on the row opens; nil for a promotion or a merge check, whose row opens
        /// nothing.
        public let taskId: String?
        public let line: LandingLine
        /// Under a timed-out job, who took it, when, where it stopped and whether a push was
        /// recorded; under a retried one, its generation and who asked. Nil otherwise.
        public let detail: String?
        /// Whether to offer Retry: the server's `retryable`, never inferred from `timedOut`.
        public let retryable: Bool
        public var id: String { jobId }
    }

    // The job list's words, held to the web's by `ProjectPageSectionsCopyParityTests`.
    public static let landingTimedOut = "Timed out"
    public static let landingNoReportFor = "No report for"
    public static let landingRetry = "Retry"
    public static let landingRetryFailed = "Retry failed"
    public static let landingNoPushRecorded = "no push recorded"
    public static let landingMayHaveBeenPushed = "may have been pushed"
    public static let landingRetriedByOwner = "retried by you"
    public static let landingRetriedByCoordinator = "retried by the coordinator"

    public static let integrationJobWords = [
        "LAND_TASK": "Landing", "CHECK_PROMOTION": "Merge check", "LAND_PROMOTION": "Merge to main",
    ]
    public static let integrationPhaseWords = [
        "FETCH": "fetching", "MAIN_SYNC": "syncing main", "REBASE": "rebasing", "MERGE": "merging",
        "CHECK": "checking", "VERIFY": "verifying", "PUSH": "pushing",
    ]

    /// The state word for a job whose runner has stopped reporting — web's `LANDING_NO_REPORT`.
    ///
    /// A fact about the REPORTS and nothing else: the runner is silent, which is not "this job is
    /// broken" and is not "this job timed out". A timeout is the job's own verdict, and the only
    /// thing that ever words one is the server's `blockingReason` (`LandTaskStatus` prints it).
    public static let landingNoReport = "No report"
    /// The same fact with its age, for the row's right-hand slot.
    public static func landingNoReportFor(_ minutes: Int) -> String { "No report for \(minutes)m" }
    /// And for a job claimed whose runner has never reported at all.
    public static let landingNoReportYet = "No report yet"
    /// The landing row's label for what a claimed job waited before its clock began — web's
    /// `LandingRow`, `landingLine`'s own `wait`.
    public static let landingWaitLabel = "Waited"

    /// "1m 20s" — the landing clock, minutes and seconds ALWAYS, at every length.
    ///
    /// Not `RelativeTime.span`, deliberately, and the difference is the point: that one rounds to
    /// the largest unit it needs, so a landing two minutes in reads "2m" and then "2m" again a
    /// minute later. This number is watched while it moves — it is what says the four minutes are
    /// passing rather than stalled — so the seconds are the part that has to be there. Minutes are
    /// not folded into hours either: a wait is read here in the unit it started in, and "65m 0s"
    /// says "over an hour" as honestly as "1h 5m" does.
    public static func landingClock(_ seconds: TimeInterval) -> String {
        let whole = Int(Swift.max(0, seconds))
        return "\(whole / 60)m \(whole % 60)s"
    }

    /// The name slot when more than one job is in flight: "2 jobs", or "2 jobs · 1 timed out".
    public static func landingJobsCount(_ jobs: Int, timedOut: Int) -> String {
        timedOut > 0 ? "\(jobs) jobs · \(timedOut) timed out" : "\(jobs) jobs"
    }

    /// A timed-out job's limit, in minutes rounded as the web's `Math.round` rounds them: "limit 10m".
    public static func landingLimit(_ seconds: Int) -> String {
        "limit \(Int((Double(seconds) / 60).rounded()))m"
    }

    /// The job list's title: "1 job in flight", "2 jobs in flight".
    public static func landingJobsTitle(_ jobs: Int) -> String {
        "\(jobs) \(jobs == 1 ? "job" : "jobs") in flight"
    }

    /// "20:07" — a local 24-hour clock time, as the job list says when a runner took a job and when
    /// a retry was asked for.
    public static func landingClockTime(_ date: Date, timeZone: TimeZone = .current) -> String {
        clockTimes.string(from: date, timeZone: timeZone)
    }

    /// The line, or nil when nothing is landing — which is what removes the row from the card.
    ///
    /// `inFlight` is the server's answer to "is anything in flight", so the whole row is drawn from
    /// it rather than from the two counts: the counts and the job they count are read together, and
    /// a row that appeared on a count while having no job to describe would have to invent one.
    ///
    /// The name slot takes the job's task, or the COUNT when there is more than one: "Landing 2
    /// jobs" says what a single task's title would have pretended to — that this is the oldest of
    /// several, not the only thing the queue is doing — and it says how many of them timed out.
    ///
    /// A server that lists its jobs (`inFlightJobs`) judges a silent runner itself, so the row no
    /// longer guesses from the heartbeat's age: "Update unavailable" is then only this app being
    /// unable to read the server, which outranks what the last read said, and a job the server
    /// judged timed out says so — how long nothing was heard, against its limit. An older server
    /// leaves the reading of the reports here, from the runner's heartbeat: a claimed job whose
    /// runner has gone quiet reads "No report" for as long as it stays quiet — never "timed out",
    /// which is the job's own verdict to give and arrives as the server's `blockingReason`.
    public static func landingLine(_ view: ProjectIntegrationView, now: Date = Date(),
                                   updatedAt: Date? = nil, refreshFailed: Bool = false) -> LandingLine? {
        guard let inFlight = view.inFlight else { return nil }
        let running = inFlight.state == "RUNNING"
        let jobs = view.integratingCount + view.queuedCount
        let listed = view.inFlightJobs
        let timedOutJobs = listed?.filter(\.timedOut).count ?? 0
        let heartbeatAt = inFlight.heartbeatAt.flatMap(RelativeTime.parse)
        // A claimed job whose runner has gone quiet: no report at all, or none since the claim lease
        // the server itself uses. Read only where the server hands over no verdict of its own (a
        // server that does not list its jobs) — one that lists them judges the timeouts, and this
        // row takes that word instead.
        let silent = listed == nil && running
            && (heartbeatAt.map { now.timeIntervalSince($0) > 600 } ?? true)
        let unavailable = cannotRead(now: now, updatedAt: updatedAt, refreshFailed: refreshFailed)
        let word = integrationJobWords[inFlight.kind ?? ""] ?? "Integration"
        let what = jobs > 1 ? landingJobsCount(jobs, timedOut: timedOutJobs) : inFlight.taskTitle
        // What the job waited for a runner before it was claimed — the row's own `inFlight` carries
        // it, and only a CLAIMED job has one to show: a queued job's whole clock is that wait.
        let wait = running ? waitLine(inFlight.waitMs) : nil
        if !unavailable, let lead = listed?.first, lead.timedOut {
            return timedOutLine(lead, word: word, what: what, now: now, wait: wait)
        }
        return liveLine(word: word, what: what, running: running, phase: inFlight.phase,
                        startedAt: inFlight.startedAt, heartbeatAt: inFlight.heartbeatAt, now: now,
                        updatedAt: updatedAt, unavailable: unavailable, silent: silent, wait: wait)
    }

    /// What a job waited for a runner before its clock began, from the server's own measurement:
    /// nil when it never waited, the server does not say, or nothing was waited for.
    private static func waitLine(_ waitMs: Int?) -> String? {
        waitMs.flatMap { $0 > 0 ? landingClock(Double($0) / 1000) : nil }
    }

    /// Every job in flight, one line each in `inFlightJobs`' order; none from a server that does not
    /// list them. Each is the landing row's own rendering of that job, its task's title in the name
    /// slot (never a count), on the row's terms: the app unable to read the server first, then the
    /// server's judgement that the runner went silent, then the job's own clock.
    public static func landingJobLines(_ view: ProjectIntegrationView, now: Date = Date(),
                                       updatedAt: Date? = nil, refreshFailed: Bool = false) -> [LandingJobLine] {
        let unavailable = cannotRead(now: now, updatedAt: updatedAt, refreshFailed: refreshFailed)
        return (view.inFlightJobs ?? []).map { job in
            let word = integrationJobWords[job.kind] ?? "Integration"
            let line = job.timedOut && !unavailable
                ? timedOutLine(job, word: word, what: job.taskTitle, now: now)
                : liveLine(word: word, what: job.taskTitle, running: job.state == "RUNNING", phase: job.phase,
                           startedAt: job.startedAt, heartbeatAt: job.heartbeatAt, now: now,
                           updatedAt: updatedAt, unavailable: unavailable)
            return LandingJobLine(jobId: job.jobId, taskId: job.taskId, line: line,
                                  detail: landingJobDetail(job), retryable: job.retryable)
        }
    }

    /// Whether this app has lost the server: its last read failed, or is more than 90 s old.
    private static func cannotRead(now: Date, updatedAt: Date?, refreshFailed: Bool) -> Bool {
        refreshFailed || updatedAt.map { now.timeIntervalSince($0) > 90 } == true
    }

    /// A job running or waiting its turn, as the row draws it. `unavailable` freezes the clock at the
    /// last update the app had and stops the row claiming activity; `silent` freezes it at the last
    /// REPORT instead — the same freeze, reached from the runner's silence rather than this app's read.
    private static func liveLine(word: String, what: String?, running: Bool, phase: String?,
                                 startedAt: String, heartbeatAt: String?, now: Date, updatedAt: Date?,
                                 unavailable: Bool, silent: Bool = false, wait: String? = nil) -> LandingLine {
        // A queued job's heartbeat and phase can be an earlier claim's: only a running job's count.
        let reported = heartbeatAt.flatMap(RelativeTime.parse)
        let lastUpdate = running ? (reported ?? updatedAt) : updatedAt
        let elapsedAt = unavailable || silent ? min(now, lastUpdate ?? now) : now
        let age = lastUpdate.map { Int(max(0, now.timeIntervalSince($0)) / 60) }
        // An instant this clock cannot read is no elapsed time rather than a wrong one: the row
        // stays up and counts from zero, which is the one thing it can still say truthfully.
        let elapsed = RelativeTime.parse(startedAt).map { elapsedAt.timeIntervalSince($0) } ?? 0
        // The right-hand slot says where the reports stand, which is the whole difference between a
        // job that is working and one nobody has heard from: a silent job says that rather than
        // putting a false "Updated" on itself.
        let report: String?
        if silent {
            report = (reported != nil ? age.map { landingNoReportFor($0) } : nil) ?? landingNoReportYet
        } else {
            report = age.map { $0 == 0 ? "Updated just now" : "Updated \($0)m ago" }
        }
        return LandingLine(what: what, running: running && !unavailable && !silent,
                           state: unavailable ? "Update unavailable"
                               : silent ? landingNoReport
                                   : running ? (integrationPhaseWords[phase ?? ""] ?? "running") : "queued",
                           clock: landingClock(elapsed), word: word,
                           clockLabel: running ? "Elapsed" : "Queued for",
                           updated: report, wait: wait)
    }

    /// A job the server judged timed out: how long its runner has said nothing, in whole minutes,
    /// against the limit it went past — no elapsed clock that only looks like it stopped.
    private static func timedOutLine(_ job: ProjectIntegrationJob, word: String, what: String?,
                                     now: Date, wait: String? = nil) -> LandingLine {
        let silentSince = RelativeTime.parse(job.heartbeatAt ?? job.startedAt)
        let minutes = silentSince.map { max(0, Int(now.timeIntervalSince($0)) / 60) } ?? 0
        return LandingLine(what: what, running: false, state: landingTimedOut, clock: "\(minutes)m",
                           word: word, clockLabel: landingNoReportFor,
                           updated: landingLimit(job.limitSeconds ?? 600), wait: wait, timedOut: true)
    }

    /// The line under a job: what a timed-out job's runner did, or which generation a retried job is
    /// and who asked for it. Whether a push may have happened is read off the step it stopped at.
    private static func landingJobDetail(_ job: ProjectIntegrationJob) -> String? {
        // An instant the clock cannot read is said to be one, as the web says it, never a wrong time.
        func time(_ iso: String) -> String {
            RelativeTime.parse(iso).map { landingClockTime($0) } ?? "--:--"
        }
        if job.timedOut {
            // A runner with no name is "The runner", as the web's truthiness reads an empty one.
            let runner = job.runnerName.flatMap { $0.isEmpty ? nil : "Runner \($0)" } ?? "The runner"
            let step = integrationPhaseWords[job.phase ?? ""] ?? "running"
            let push = job.phase == "PUSH" || job.phase == "VERIFY" ? landingMayHaveBeenPushed : landingNoPushRecorded
            return "\(runner) took it at \(time(job.startedAt)) · stopped at \(step) · \(push)"
        }
        guard let retriedBy = job.retriedBy else { return nil }
        let who = retriedBy == "OWNER" ? landingRetriedByOwner : landingRetriedByCoordinator
        return "Generation \(job.generation) · \(who) at \(time(job.queuedAt))"
    }

    /// One formatter for every clock time, built once: the job list redraws each second, and an ICU
    /// formatter per row per tick is the cost `RelativeTime` describes. Locked, because the zone it
    /// formats in is set on each call.
    private static let clockTimes = ClockTimes()

    private final class ClockTimes: @unchecked Sendable {
        private let lock = NSLock()
        private let formatter: DateFormatter = {
            let f = DateFormatter()
            f.locale = Locale(identifier: "en_US_POSIX")
            f.dateFormat = "HH:mm"
            return f
        }()

        func string(from date: Date, timeZone: TimeZone) -> String {
            lock.lock()
            defer { lock.unlock() }
            if formatter.timeZone != timeZone { formatter.timeZone = timeZone }
            return formatter.string(from: date)
        }
    }

    // MARK: - The ending, where the progress card was

    /// Whether a project page draws the project's ending where its progress card was: a read that
    /// says DONE and carries the unified projection's counts to tally. The same card, and the same
    /// rule, the coordinator conversation's settled branch keeps — and the browser's sessions page
    /// keeps off its own document read (docs/mocks/project-done-sessions-page, owner decision
    /// 2026-10-10). A read without the counts (an older server, whose projection draws none of these
    /// cards) keeps the progress card, which in that state says its status and nothing else.
    public static func drawsEnding(_ subject: ProjectDoneSubject?) -> Bool {
        guard let subject, subject.status == "DONE" else { return false }
        return subject.counts != nil
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
    /// the conversation's timestamps — `lastTurnAt` being the one that moves with every turn, where
    /// `startedAt` is written once; nil when it has none.
    public static func lastActive(_ session: ProjectCoordinatorStatus.Session, readAt: String?) -> String? {
        let stamps = [session.lastTurnAt, session.startedAt, session.finishedAt, session.completedAt]
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

    // MARK: - Open items

    public static let openItemsHeading = "Open items"
    public static let needsYouGroup = "Needs you"
    public static let withCoordinatorGroup = "With the coordinator"

    /// The toolbar counts every open item; only the owner's share raises a reminder on the page.
    public struct OpenItemsSummary: Equatable, Sendable {
        public let needsYou: Int
        public let withCoordinator: Int
        public var count: Int { needsYou + withCoordinator }

        public var attention: String? {
            guard needsYou > 0 else { return nil }
            return needsYou == 1 ? "1 item needs you" : "\(needsYou) items need you"
        }

        public var subtitle: String {
            if count == 0 { return "No open items" }
            let owner = attention ?? "No action needed from you"
            return withCoordinator > 0 ? "\(owner) · \(withCoordinator) with the coordinator" : owner
        }
    }

    /// A missing read is not an empty inbox. A start request counts only while the page can answer
    /// it; the owner's own Start… is an action, not something anybody is waiting on. The
    /// coordinator's request to record the project done counts the same way, while the project is
    /// OPEN — and the owner's own Record as done… no more than their own Start… does.
    public static func openItemsSummary(status: ProjectStatus, started: Bool?,
                                        items: ProjectOpenItemsView?) -> OpenItemsSummary? {
        guard let items else { return nil }
        let start = StartProject.pageRow(status: status, started: started, openItems: items)
        let done = ProjectDone.live(openItems: items, status: status.rawValue)
        return OpenItemsSummary(needsYou: needsYouRows(items).count + (start?.request == nil ? 0 : 1)
                                    + (done == nil ? 0 : 1),
                                withCoordinator: items.withCoordinator.count)
    }

    /// The owner's rows, without the request to record the project done should a server ever list
    /// it there too: it has a row of its own (`ProjectDone.PageRow`), as the browser keeps it out.
    public static func needsYouRows(_ items: ProjectOpenItemsView) -> [ProjectOpenItemRow] {
        items.needsYou.filter { $0.doneRequest == nil }
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
    /// 12m ago", "Running jobs 1 · Queued 0", "Last landing check ✓ passing". Nil when no
    /// line has been decided.
    public static func integrationFacts(_ view: ProjectIntegrationView, now: Date) -> [String]? {
        guard let line = view.line, line != .unknown else { return nil }
        let branchLine = line == .projectBranch
        var facts: [String] = [branchLine ? (view.ref ?? "project branch") : (view.upstreamRef ?? "main")]
        if branchLine, let ahead = view.commitsAheadOfUpstream {
            facts.append("\(ahead) commit\(ahead == 1 ? "" : "s") ahead of main at last measurement")
        }
        if branchLine, let synced = view.lastUpstreamSyncAt, let ago = RelativeTime.ago(synced, now: now) {
            facts.append("synced with main \(ago)")
        }
        facts.append("Running jobs \(view.integratingCount) · Queued \(view.queuedCount)")
        let tip: String
        switch view.mergeCheckOnTip {
        case "PASSING": tip = "✓ passing"
        case "FAILING": tip = "✕ failing"
        default: tip = "not checked"
        }
        facts.append("Last landing check \(tip)")
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
        guard workState(t) == "DONE" else { return nil }
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
            guard integration.checksRunningForMs != nil else { return Tag(text: "Integrating", tone: .brand) }
            return Tag(text: "Integrating · checking", tone: .brand)
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
        add("integrating", "Pending landing", integrating)
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
