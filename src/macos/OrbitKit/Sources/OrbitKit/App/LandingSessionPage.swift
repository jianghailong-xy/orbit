import Foundation

/// The landing session page's model (contract §2.9 LS1, LS6, LS7; design §3; mockups v4
/// `docs/mocks/landing-session/v4/05-landing-session-page`): what a LANDING session's page says, and
/// the conditions its owner doors appear under.
///
/// Everything here is read from `GET /sessions/:id`'s landing view — the subject, its newest
/// attempt, the phase/round/check facts the runner reported, and the timeline the server already
/// wrote in English. The one exception is the merge round's own sentence (`onPass`) and the receipt
/// a settled round shows: those are the promotion row's, read beside the landing the way the merge
/// card reads it, because the landing view neither copies a decision (LS4) nor carries the
/// candidate's tasks.
///
/// A direct port of `src/web/src/lib/landingSession.ts`: the words live here once so the three
/// clients can say the same thing, and `LandingPageCopyParityTests` holds every literal to the web's.
public enum LandingPageCopy {
    /// The page's own word for the subject, beside the title (mockup 05's `Landing` chip).
    public static let chip = "Landing"
    public static let runByOrbit = "Run by Orbit"
    public static let settled = "settled"

    /// A TASK subject's title when no session row exists yet and the task is not read.
    public static let land = "Land"
    /// A PROMOTION subject's title while its row does not exist: `Merge project/<id> → main · #n`.
    public static let mergeRound = "Merge project"
    public static let intoMain = "main"

    public static let landed = "Landed"
    public static let alreadyLanded = "Already landed"
    public static let nothingToLand = "Nothing to land"
    public static let handled = "Handled"
    public static let declined = "Declined"
    public static let cancelled = "Cancelled"
    public static let deleted = "Deleted"
    public static let mergedInto = "Merged into"
    public static let nowOn = "Now on"
    public static let landedOn = "Landed on"
    public static let alreadyOn = "Already on"
    public static let notLanded = "Not landed"
    public static let notMerged = "Not merged"
    public static let ready = "Ready"
    public static let passedCheck = "Passed the check · waiting for the owner"
    public static let passedOnTheTree = "✓ Passed on the combined tree"
    public static let landedExactly = "Landed exactly the tested tree"
    public static let asAMergeCommit = "as a merge commit"
    public static let byFastForward = "by fast-forward"
    public static let automatically = "automatically"
    public static let byYou = "by you"

    public static let queued = "queued"
    public static let cancelling = "Cancelling"
    public static let timedOut = "Timed out"
    public static let updateUnavailable = "Update unavailable"
    public static let taskAcceptance = "Task acceptance"
    public static let mergeCheck = "Merge check"
    public static let running = "running"
    public static let checksFailed = "checks failed"
    public static let exit = "exit"
    public static let after = "after"
    public static let onTheCombinedTree = "on the combined tree"
    public static let nothingPushedClause = "nothing was pushed"
    public static let stoppedWithAnError = "Stopped with an error"
    public static let couldNotMerge = "Could not merge"
    public static let conflict = "conflict"
    public static let stoppedNotLanded = "Stopped · not landed"
    public static func taskAcceptanceExited(_ code: String, expected: String) -> String {
        "Task acceptance exited \(code) (expected \(expected)) on the combined tree"
    }
    public static let checksTimedOut = "A check timed out on the combined tree"

    /// The timed-out card's one line about the claim: who took it, when, and where it stopped.
    public static let tookItAt = "took it at"
    public static let stoppedAt = "stopped at"
    public static let theRunner = "The runner"
    public static let runner = "Runner"
    public static let noReportFor = "No report for"
    public static let noReportFrom = "No report from"
    public static let since = "since"
    public static let limit = "limit"
    public static let nothingWasPushed = "Nothing was pushed"
    public static let mayHaveBeenPushed = "May have been pushed"
    public static let nothingPushedSentence =
        "Nothing was pushed — the runner reports before it pushes, and it never did."
    public static let mayHavePushedSentence =
        "May have been pushed — an older runner reports only between steps, so Orbit can’t rule it out."
    public static func mayHavePushedAt(_ time: String) -> String {
        "May have been pushed — it reported starting the push at \(time), then went silent."
    }

    /// The menu and the two presses that leave this page (design §3, LS6).
    public static let openTask = "Open Task"
    public static let openSourceSession = "Open Source Session"
    public static let openCoordinator = "Open Coordinator"
    /// The footer's way in, which the board draws with a lower-case word.
    public static let openCoordinatorLink = "Open coordinator"
    public static let reviewCard = "Review Card"
    public static let stopLanding = "Stop Landing"
    public static let cancelMerge = "Cancel Merge"
    public static let abandon = "Abandon"
    public static let retry = "Retry"
    public static let rerunTheCheck = "Re-run the check"
    /// What this page's Re-run the check records as its reason (web's `RERUN_LANDING_CHECK_REASON`): the owner
    /// route takes one (`RetryIntegrationDto.reason`), and the sentence names the page the door was pressed on.
    public static let rerunLandingCheckReason = "Re-run the timed-out check from the landing page."
    /// What the merge card's Re-run the check records instead (web's `RERUN_CHECK_REASON`): the same
    /// door, naming the card it was pressed on.
    public static let rerunCheckReason = "Re-run the timed-out check from the merge card."
    public static let beforePushOnly = "Before the push only · nothing pushed yet"
    public static let cancelBeforePush = "Before the push only · stops at the runner’s next report"
    public static let endsNothingPushed = "Ends this attempt · nothing was pushed"
    public static let endsMayHavePushed = "Ends this attempt · it may have been pushed"
    public static let stopFailed = "Stop failed"
    public static let cancelFailed = "Cancel failed"
    public static let abandonFailed = "Abandon failed"
    public static let retryFailed = "Retry failed"
    public static let rerunFailed = "Re-run failed"
    public static let rerunEnd = "Re-run ends this check and queues the next one on the same candidate."
    public static let abandonEnd = "Abandon only ends it; the candidate goes back to you."
    public static let noRetryMerge =
        "No Retry: a confirmed merge ends by Abandon, or finishes when a new process on the runner takes it over."
    public static let legacyPushVariant =
        "An older runner (reports only between steps): may have been pushed — Orbit can’t rule it out."

    /// The read-only footer (LS6: nothing to type here).
    public static let orbitRunsThisLanding = "Orbit runs this landing — nothing to type here."
    public static let thisLandingIsComplete = "This landing is complete — nothing to type here."
    public static let loadingLanding = "Loading this landing…"
    public static let loadingLog = "Loading the log…"
    public static let logUnavailable = "Couldn’t read this log"
    public static let logEmpty = "This check printed nothing."
    public static let showMore = "Show more"
    public static let log = "Log"
    public static let olderAttemptsHidden = "Older attempts are not shown here."
    public static func bytesOmitted(_ bytes: Int) -> String { "\(bytes) bytes omitted" }
    public static let decisionsTheCoordinator = "Decisions: the coordinator"
    public static let aCleanPassMergesOnItsOwn = "A clean pass merges on its own"
    public static let mergingIsDecidedOnTheCard = "Merging is decided on the merge card"
    public static func nextMergeOpens(_ next: Int) -> String {
        "The next merge into main opens a new landing (#\(next))."
    }

    // The ways into a landing session (contract §2.9 LS6, owner 2026-10-19: 方案 A). Held to the
    // web's `LANDING_OPEN` / `LANDING_NO_PAGE` / `LANDING_ALL_JOBS` by the same parity suite.
    public static let openLanding = "Open landing"
    public static let noLandingPage = "No landing page on this server yet"
    public static let allJobs = "All jobs"
    /// `+N job queued` — the other jobs a merge round stands for, beside its `All jobs ›`.
    public static func moreJobsQueued(_ count: Int) -> String? {
        let others = count - 1
        guard others > 0 else { return nil }
        return "+\(others) job\(others == 1 ? "" : "s") queued"
    }
}

public extension LandingPageCopy {
    /// §2.7a's cadence for a landing page: a RUNNING attempt four seconds, a queued one (or a
    /// stopped one waiting for its next attempt) fifteen, and nothing once the subject has settled.
    public static func refetchInterval(_ landing: SessionLandingView?) -> TimeInterval? {
        guard let landing, landing.settledAt == nil else { return nil }
        return landing.currentAttempt?.state == "RUNNING" ? 4 : 15
    }

    /// Whether this device has lost the server: its last read failed, or is more than 90 s old.
    public static func readUnavailable(now: Date, updatedAt: Date?, failed: Bool) -> Bool {
        let stale = updatedAt.map { now.timeIntervalSince($0) > 90 } ?? false
        return failed || stale
    }

    /// The page title: the session row's own (server-managed) title, or the one the view can spell.
    public static func headerTitle(_ landing: SessionLandingView?, rowTitle: String?,
                                   taskTitle: String? = nil) -> String {
        if let rowTitle, !rowTitle.isEmpty { return rowTitle }
        guard let landing else { return LandingPageCopy.chip }
        if landing.subject == "PROMOTION" {
            let project = PublicID.toPublic(landing.projectId)
            return "\(LandingPageCopy.mergeRound) \(project) → \(LandingPageCopy.intoMain) · #\(landing.episode)"
        }
        if let taskTitle, !taskTitle.isEmpty {
            return "\(LandingPageCopy.land) · \(taskTitle)"
        }
        return LandingPageCopy.land
    }

    /// `Run by Orbit · runner <name>` while it runs, `Run by Orbit · settled 9:51` once it has.
    public static func headerSub(_ landing: SessionLandingView?) -> String {
        guard let landing else { return LandingPageCopy.runByOrbit }
        if let settledAt = landing.settledAt, let at = RelativeTime.parse(settledAt) {
            return "\(LandingPageCopy.runByOrbit) · \(LandingPageCopy.settled) \(ProjectPage.landingClockTime(at))"
        }
        if let runner = landing.currentAttempt?.runnerName, !runner.isEmpty {
            return "\(LandingPageCopy.runByOrbit) · runner \(runner)"
        }
        return LandingPageCopy.runByOrbit
    }

    /// `17m 41s`, `1h 05m` — the check's own duration, as the timeline's sentences spell one.
    public static func duration(ms: Int?) -> String {
        let total = max(0, Int(((Double(ms ?? 0)) / 1_000).rounded()))
        let hours = total / 3_600
        let mins = (total % 3_600) / 60
        let seconds = total % 60
        if hours > 0 {
            return "\(hours)h \(String(format: "%02d", mins))m"
        }
        return "\(mins)m \(String(format: "%02d", seconds))s"
    }

    /// `Merge check` / `Task acceptance`, the names the check rows use.
    public static func checkLabel(_ name: String?) -> String {
        name == "MERGE_CHECK" ? LandingPageCopy.mergeCheck : LandingPageCopy.taskAcceptance
    }

    /// The attempt's section of the timeline, when the view carries one.
    public static func section(of landing: SessionLandingView, jobId: String) -> IntegrationTimelineSection? {
        landing.timeline?.sections.first { $0.jobId == jobId }
    }

    /// When the attempt FIRST started: the claim it is on now minus the takeovers. The landing view
    /// carries the current claim's start only, so the timeline's own first claim line is the fact —
    /// and it is the same fact the head says as `first started 17:03`.
    public static func firstStartedAt(_ landing: SessionLandingView, jobId: String) -> String? {
        guard let section = section(of: landing, jobId: jobId) else { return nil }
        return section.entries
            .filter { $0.kind == "CLAIMED" || $0.kind == "TAKEN_OVER" }
            .compactMap { entry in RelativeTime.parse(entry.at).map { (at: $0, text: entry.at) } }
            .min { $0.at < $1.at }?
            .text
    }

    /// The first line that says the runner reported starting a push, if the timeline holds one.
    static func pushReport(_ landing: SessionLandingView, jobId: String) -> (reported: Bool, at: String?) {
        let entry = section(of: landing, jobId: jobId)?.entries.first {
            $0.kind == "PUSH_REFUSED" || $0.phase == "PUSH" || $0.phase == "VERIFY"
        }
        return (entry != nil, entry?.at)
    }

    /// Whether a stop or cancel has been ASKED for and the runner has not answered yet (J-T8/M-T10).
    public static func cancelling(_ landing: SessionLandingView) -> Bool {
        guard let attempt = landing.currentAttempt, attempt.state == "RUNNING" else { return false }
        let entries = section(of: landing, jobId: attempt.jobId)?.entries ?? []
        return entries.contains { $0.kind == "STOP_REQUESTED" && $0.claim == attempt.claim }
    }
}

/// The read-time facts §7.2 V6 takes from the project's integration read (the landing view does not
/// carry them): the step's start, the merge check's usual duration, and the project's main branch.
public struct LandingFacts: Equatable, Sendable {
    public let stepStartedAt: String?
    public let typicalMs: Int?
    public let main: String?

    public init(stepStartedAt: String? = nil, typicalMs: Int? = nil, main: String? = nil) {
        self.stepStartedAt = stepStartedAt
        self.typicalMs = typicalMs
        self.main = main
    }

    public var mainBranch: String { main ?? "main" }
}

/// The facts a landing status card renders.
public struct LandingAttemptCard: Equatable, Sendable {
    /// `Landing`, `Merge check`, `Merge to main` — the head's word.
    public let word: String
    /// The step, `queued`, `Timed out`, `Update unavailable`, or the terminal verdict.
    public let state: String
    /// The head's right slot: the step's clock, or a word (`Timed out`, `Not landed`, …).
    public let right: String
    public let rightIsClock: Bool
    /// The line under the word: state, the V6 clauses, the claim and the freshness.
    public let detail: String
    /// `Merge check 2m 40s of 60m · usually ~18m`, under the head; nil for a queued attempt.
    public let budget: String?
    /// How far through its budget the current step is, for the quiet meter under the head.
    public let progress: Double?
    /// `Output 3s ago · Updated just now` — the two server facts, in §7.2 V6's words.
    public let live: String?
    /// The heartbeat is fresh (LIVE or QUIET): the card draws the green freshness dot.
    public let fresh: Bool
    /// Where the check's USUAL duration sits on its budget bar, for the board's little tick.
    public let usualProgress: Double?
    /// What stopped it, in a sentence under the head (a failed check, a conflict, an error).
    public let failure: String?
    public let running: Bool
    public let timedOut: Bool

    public init(word: String = "", state: String = "", right: String = "", rightIsClock: Bool = false,
                detail: String = "", budget: String? = nil, progress: Double? = nil,
                live: String? = nil, fresh: Bool = false, usualProgress: Double? = nil,
                failure: String? = nil, running: Bool = false, timedOut: Bool = false) {
        self.word = word
        self.state = state
        self.right = right
        self.rightIsClock = rightIsClock
        self.detail = detail
        self.budget = budget
        self.progress = progress
        self.live = live
        self.fresh = fresh
        self.usualProgress = usualProgress
        self.failure = failure
        self.running = running
        self.timedOut = timedOut
    }
}

/// A settled subject's card: the outcome the round (or the task's segment) reached.
public struct LandingOutcomeCard: Equatable, Sendable {
    public let title: String
    public let right: String
    public let detail: String?
    /// `Now on main · 2 tasks`, and the titles under it.
    public let tasksHeading: String?
    public let tasks: [String]
    public let checkLine: String?
    public let treeLine: String?
    public let ok: Bool

    public init(title: String = "", right: String = "", detail: String? = nil,
                tasksHeading: String? = nil, tasks: [String] = [], checkLine: String? = nil,
                treeLine: String? = nil, ok: Bool = false) {
        self.title = title
        self.right = right
        self.detail = detail
        self.tasksHeading = tasksHeading
        self.tasks = tasks
        self.checkLine = checkLine
        self.treeLine = treeLine
        self.ok = ok
    }
}

public extension LandingPageCopy {
    /// The status card over the subject's newest attempt: the landing row's head (owner 2026-10-11)
    /// with §7.2 V6's rows under it.
    ///
    /// Liveness is the server's word, read at the moment of the view: LIVE and QUIET let the local
    /// clock run, SILENT freezes it at the runner's last word, LEGACY freezes it at the read, and
    /// LEASE_EXPIRED is the one timeout — the card then draws the server's own `Timed out` head.
    static func attemptCard(_ landing: SessionLandingView, now: Date,
                            updatedAt: Date? = nil, failed: Bool = false,
                            facts: LandingFacts = LandingFacts()) -> LandingAttemptCard? {
        guard let attempt = landing.currentAttempt else { return nil }
        let main = facts.mainBranch
        let word = ProjectPage.integrationJobWords(main)[attempt.kind] ?? LandingPageCopy.chip
        let unavailable = readUnavailable(now: now, updatedAt: updatedAt, failed: failed)
        let timedOut = attempt.timedOut || attempt.liveness == "LEASE_EXPIRED"
        let readAt = updatedAt

        // A read this device could not make is said first: whatever the last read said — even a
        // timeout the server judged — is frozen at `Update unavailable`, and no door opens on it.
        if unavailable {
            let stepStart = RelativeTime.parse(facts.stepStartedAt ?? "")
                ?? RelativeTime.parse(attempt.check?.startedAt ?? "")
                ?? RelativeTime.parse(attempt.startedAt)
            let frozenAt = min(now, readAt ?? now)
            let stepClock = stepStart.map {
                ProjectPage.landingClock(max(0, frozenAt.timeIntervalSince($0)))
            } ?? "0m 0s"
            let budgetMinutes = attempt.check.map {
                Int((Double($0.budgetSeconds) / 60).rounded())
            }
            let updated = readAt.map { Int(max(0, now.timeIntervalSince($0)) / 60) }
            return LandingAttemptCard(
                word: word, state: LandingPageCopy.updateUnavailable, right: stepClock,
                rightIsClock: true, detail: LandingPageCopy.updateUnavailable,
                budget: attempt.check != nil && budgetMinutes != nil
                    ? "\(checkLabel(attempt.check?.name)) \(stepClock) \(ProjectPage.landingOf) \(budgetMinutes!)m"
                    : nil,
                progress: nil,
                live: updated.map { "Updated \($0)m ago" },
                fresh: false, usualProgress: nil, failure: nil, running: false, timedOut: false)
        }

        if timedOut {
            let silentSince = RelativeTime.parse(attempt.heartbeatAt ?? "")
                ?? RelativeTime.parse(attempt.startedAt)
            let silent = silentSince.map { Int(max(0, now.timeIntervalSince($0)) / 60) } ?? 0
            let limit = attempt.limitSeconds.map {
                "\(LandingPageCopy.limit) \(Int((Double($0) / 60).rounded()))m"
            }
            return LandingAttemptCard(
                word: word, state: LandingPageCopy.timedOut, right: LandingPageCopy.timedOut,
                rightIsClock: false,
                detail: ["\(LandingPageCopy.noReportFor) \(silent)m", limit]
                    .compactMap { $0 }.joined(separator: " · "),
                budget: nil, progress: nil, live: nil, fresh: false, usualProgress: nil,
                failure: nil, running: false, timedOut: true)
        }

        if attempt.state == "QUEUED" || attempt.claim == 0 {
            let queuedAt = RelativeTime.parse(attempt.startedAt)
            return LandingAttemptCard(
                word: word, state: LandingPageCopy.queued,
                right: queuedAt.map { ProjectPage.landingClock(now.timeIntervalSince($0)) } ?? "0m 0s",
                rightIsClock: true,
                detail: [LandingPageCopy.queued, attempt.blockingReason?.summary]
                    .compactMap { $0 }.joined(separator: " · "),
                budget: nil, progress: nil, live: nil, fresh: false, usualProgress: nil,
                failure: nil, running: false, timedOut: false)
        }

        if attempt.state != "RUNNING" {
            return terminalCard(landing, attempt: attempt, word: word, unavailable: false)
        }

        // The current step's clock: the check's own start when one is in flight, else the step's,
        // and the claim's as the last fallback. SILENT freezes it at the runner's last word and
        // LEGACY at the read.
        let stepStart = RelativeTime.parse(facts.stepStartedAt ?? "")
            ?? RelativeTime.parse(attempt.check?.startedAt ?? "")
            ?? RelativeTime.parse(attempt.startedAt)
        let heartbeat = RelativeTime.parse(attempt.heartbeatAt ?? "")
        let liveness = attempt.liveness
        let elapsedAt: Date
        if liveness == "SILENT" {
            elapsedAt = heartbeat ?? stepStart ?? now
        } else if liveness == "LEGACY" {
            elapsedAt = readAt ?? now
        } else {
            elapsedAt = now
        }
        let stepClock = stepStart.map {
            ProjectPage.landingClock(max(0, elapsedAt.timeIntervalSince($0)))
        } ?? "0m 0s"
        let budgetMinutes = attempt.check.map { Int((Double($0.budgetSeconds) / 60).rounded()) }
        func minutes(_ at: Date) -> Int { max(0, Int(now.timeIntervalSince(at)) / 60) }
        func lowercaseFirst(_ text: String) -> String {
            guard let first = text.first else { return text }
            return first.lowercased() + text.dropFirst()
        }

        var clauses: [String] = []
        if liveness == "LIVE" {
            if let moved = RelativeTime.parse(attempt.outputMovedAt ?? "") {
                clauses.append("\(lowercaseFirst(ProjectPage.landingOutput)) "
                    + "\(max(0, Int(now.timeIntervalSince(moved).rounded())))s ago")
            }
        } else if liveness == "QUIET" {
            if let moved = RelativeTime.parse(attempt.outputMovedAt ?? "") {
                clauses.append("\(lowercaseFirst(ProjectPage.landingNoOutputFor)) \(minutes(moved))m")
            }
            if let budgetMinutes {
                clauses.append("\(ProjectPage.landingWithinIts) \(budgetMinutes)m \(ProjectPage.landingBudget)")
            }
        } else if liveness == "SILENT" {
            let since = heartbeat ?? stepStart ?? now
            let who = (attempt.runnerName.flatMap { $0.isEmpty ? nil : $0 })
                .map { "\(lowercaseFirst(ProjectPage.landingNoWordFromRunner)) \($0)" }
                ?? lowercaseFirst(ProjectPage.landingNoWordFromTheRunner)
            clauses.append("\(who) for \(minutes(since))m")
        } else if liveness == "LEGACY" {
            clauses.append(lowercaseFirst(ProjectPage.landingReportsOnlyBetweenSteps))
        }
        if facts.typicalMs != nil {
            clauses.append("\(ProjectPage.landingUsually) ~\(Int((Double(facts.typicalMs!) / 60_000).rounded()))m")
        }
        if attempt.claim >= 1 {
            clauses.append("\(ProjectPage.landingClaim) \(attempt.claim)")
            if let round = attempt.round {
                clauses.append(ProjectPage.landingRoundClause(round, kind: attempt.kind))
            }
        }
        if attempt.claim > 1 {
            let started = RelativeTime.parse(attempt.startedAt)
                .map { ProjectPage.landingClockTime($0) } ?? "--:--"
            if let first = firstStartedAt(landing, jobId: attempt.jobId),
               let firstAt = RelativeTime.parse(first) {
                clauses.append("\(ProjectPage.landingTakenOver) \(started) · "
                    + "\(ProjectPage.landingFirstStarted) \(ProjectPage.landingClockTime(firstAt))")
            } else {
                clauses.append("\(ProjectPage.landingTakenOver) \(started)")
            }
        }
        // Freshness is the runner's own last report, not this app's read: a successful refresh does
        // not make a silent job look active.
        let freshnessAt = heartbeat ?? (readAt ?? now)
        let age = liveness == "SILENT" ? nil : minutes(freshnessAt)
        if let age {
            clauses.append(age == 0 ? "updated just now" : "updated \(age)m ago")
        }

        let phase: String? = (attempt.phase?.isEmpty == false)
            ? ProjectPage.integrationPhaseWords(main)[attempt.phase!] ?? LandingPageCopy.running
            : nil
        let state = cancelling(landing) ? LandingPageCopy.cancelling
            : phase ?? LandingPageCopy.running
        let outputMoved = RelativeTime.parse(attempt.outputMovedAt ?? "")
        let outputAge = outputMoved.map { max(0, Int(now.timeIntervalSince($0).rounded())) }
        let updatedWord = age.map { $0 == 0 ? "Updated just now" : "Updated \($0)m ago" }
        let live: String?
        switch liveness {
        case "LIVE":
            live = [outputAge.map { "Output \($0)s ago" }, updatedWord]
                .compactMap { $0 }.joined(separator: " · ")
        case "QUIET":
            live = [outputMoved.map { "No output for \(minutes($0))m" },
                    budgetMinutes.map { "within its \($0)m budget" },
                    updatedWord].compactMap { $0 }.joined(separator: " · ")
        case "SILENT":
            let since = heartbeat ?? stepStart ?? now
            let who = (attempt.runnerName.flatMap { $0.isEmpty ? nil : $0 })
                .map { "runner \($0)" } ?? "the runner"
            live = "No word from \(who) for \(minutes(since))m"
        case "LEGACY":
            live = ["Reports only between steps", updatedWord]
                .compactMap { $0 }.joined(separator: " · ")
        default:
            live = updatedWord
        }

        let progress: Double?
        if let check = attempt.check, let stepStart {
            let budget = Double(check.budgetSeconds) * 1_000
            progress = budget > 0
                ? min(1, max(0, elapsedAt.timeIntervalSince(stepStart) / budget)) : nil
        } else {
            progress = nil
        }
        let usualProgress: Double?
        if let check = attempt.check, let typical = facts.typicalMs {
            let budget = Double(check.budgetSeconds) * 1_000
            usualProgress = budget > 0 ? min(1, max(0, Double(typical) / budget)) : nil
        } else {
            usualProgress = nil
        }
        let budget: String?
        if let check = attempt.check, let budgetMinutes {
            budget = "\(checkLabel(check.name)) \(stepClock) \(ProjectPage.landingOf) \(budgetMinutes)m"
                + (facts.typicalMs.map { " · usually ~\(Int((Double($0) / 60_000).rounded()))m" } ?? "")
        } else {
            budget = nil
        }

        return LandingAttemptCard(
            word: word, state: state,
            right: budgetMinutes == nil ? stepClock
                : "\(stepClock) \(ProjectPage.landingOf) \(budgetMinutes!)m",
            rightIsClock: true,
            detail: ([state] + clauses).joined(separator: " · "),
            budget: budget, progress: progress, live: live,
            fresh: liveness == "LIVE" || liveness == "QUIET",
            usualProgress: usualProgress, failure: nil, running: true, timedOut: false)
    }

    /// The card for an attempt that has ended but whose subject has not: what stopped it.
    static func terminalCard(_ landing: SessionLandingView,
                             attempt: SessionLandingAttempt,
                             word: String, unavailable: Bool) -> LandingAttemptCard {
        let mergeJob = attempt.kind != "LAND_TASK"
        let checks = landing.checks
        let failed = checks.first { $0.timedOut == true
            || ($0.exitCode != nil && $0.exitCode != $0.expectedExitCode) }
        let label = checkLabel(failed?.name)
        let clause: String
        if failed?.timedOut == true {
            clause = "\(LandingPageCopy.checksFailed) · "
                + LandingPageCopy.checksTimedOut.lowercasedFirst()
        } else if let failed {
            clause = "\(LandingPageCopy.checksFailed) · \(LandingPageCopy.exit) "
                + "\(failed.exitCode.map(String.init) ?? "—") "
                + "\(LandingPageCopy.after) \(duration(ms: failed.durationMs))"
        } else if attempt.state == "CONFLICT" {
            clause = "\(LandingPageCopy.couldNotMerge) · \(LandingPageCopy.conflict)"
        } else if attempt.state == "ERROR" {
            clause = LandingPageCopy.stoppedWithAnError
        } else {
            clause = LandingPageCopy.stoppedNotLanded
        }
        let failure: String
        if let failed {
            let head = failed.timedOut == true
                ? "\(label) \(LandingPageCopy.timedOut.lowercasedFirst()) \(LandingPageCopy.onTheCombinedTree)"
                : taskAcceptanceExited(failed.exitCode.map(String.init) ?? "—",
                                       expected: String(failed.expectedExitCode ?? 0))
            failure = "\(head) · \(LandingPageCopy.nothingPushedClause)"
        } else if attempt.state == "CONFLICT" {
            failure = "\(LandingPageCopy.couldNotMerge) · \(LandingPageCopy.conflict)"
        } else if attempt.state == "ERROR" {
            failure = "\(LandingPageCopy.stoppedWithAnError) · \(LandingPageCopy.nothingPushedClause)"
        } else {
            failure = LandingPageCopy.stoppedNotLanded
        }
        let ready = attempt.state == "READY"
        return LandingAttemptCard(
            word: word,
            state: ready ? LandingPageCopy.ready : clause,
            right: ready ? LandingPageCopy.ready
                : mergeJob ? LandingPageCopy.notMerged : LandingPageCopy.notLanded,
            rightIsClock: false,
            detail: ready ? LandingPageCopy.passedCheck : clause,
            budget: nil, progress: nil, live: nil, fresh: false, usualProgress: nil,
            failure: unavailable ? nil : failure, running: false, timedOut: false)
    }

    /// The settled page's head (mockup 05c): the outcome, the commit it landed, the tasks that are
    /// now on main, the check that passed and the tree it tested.
    static func outcomeCard(_ landing: SessionLandingView,
                            promotion: ProjectPromotionView?) -> LandingOutcomeCard? {
        guard let settledAtText = landing.settledAt,
              let settledAt = RelativeTime.parse(settledAtText) else { return nil }
        let settledClock = ProjectPage.landingClockTime(settledAt)
        let main = RunSettings.mainBranchName(promotion?.upstreamRef)
        let target = landing.currentAttempt?.targetRef
        let checks = landing.checks
        let durationMs = checks.reduce(0) { $0 + ($1.durationMs ?? 0) }
        let passed = !checks.isEmpty && checks.allSatisfy { $0.timedOut != true && $0.passed }
        let checkLine = passed
            ? "\(LandingPageCopy.passedOnTheTree) · \(duration(ms: durationMs))" : nil
        let tree = promotion?.landsTreeSha.flatMap { $0.isEmpty ? nil : String($0.prefix(7)) }
        let treeLine = tree.map {
            "\(LandingPageCopy.landedExactly) \($0) · "
                + (promotion?.landsAs == "MERGE_COMMIT"
                    ? LandingPageCopy.asAMergeCommit : LandingPageCopy.byFastForward)
        }
        switch landing.settledAs {
        case "MERGED":
            let merged = promotion?.merged
            let titles = (promotion?.tasks ?? []).map(\.title)
            let detail = [
                merged.map { String($0.sha.prefix(7)) },
                promotion.map { plural($0.taskIds.count, "task") },
                merged.map { ($0.automatic == true) ? LandingPageCopy.automatically : LandingPageCopy.byYou },
            ].compactMap { $0 }.joined(separator: " · ")
            return LandingOutcomeCard(
                title: "\(LandingPageCopy.mergedInto) \(main)",
                right: merged.flatMap { RelativeTime.parse($0.at) }
                    .map { ProjectPage.landingClockTime($0) } ?? settledClock,
                detail: detail.isEmpty ? nil : detail,
                tasksHeading: promotion.map {
                    "\(LandingPageCopy.nowOn) \(main) · \(plural($0.taskIds.count, "task"))"
                } ?? "\(LandingPageCopy.nowOn) \(main)",
                tasks: titles, checkLine: checkLine, treeLine: treeLine, ok: true)
        case "LANDED":
            return LandingOutcomeCard(
                title: LandingPageCopy.landed, right: settledClock,
                detail: target.flatMap(branchName).map { "\(LandingPageCopy.landedOn) \($0)" },
                tasksHeading: nil, tasks: [], checkLine: checkLine, treeLine: nil, ok: true)
        case "ALREADY_LANDED":
            return LandingOutcomeCard(
                title: LandingPageCopy.alreadyLanded, right: settledClock,
                detail: target.flatMap(branchName).map { "\(LandingPageCopy.alreadyOn) \($0)" },
                tasksHeading: nil, tasks: [], checkLine: checkLine, treeLine: nil, ok: true)
        case "NOTHING_TO_LAND":
            return LandingOutcomeCard(title: LandingPageCopy.nothingToLand, right: settledClock,
                                      ok: true)
        case "HANDLED":
            return LandingOutcomeCard(title: LandingPageCopy.handled, right: settledClock)
        case "DECLINED":
            return LandingOutcomeCard(title: LandingPageCopy.declined, right: settledClock)
        case "CANCELLED":
            return LandingOutcomeCard(title: LandingPageCopy.cancelled, right: settledClock)
        case "DELETED":
            return LandingOutcomeCard(title: LandingPageCopy.deleted, right: settledClock)
        default:
            return LandingOutcomeCard(title: landing.settledAs ?? LandingPageCopy.handled,
                                      right: settledClock)
        }
    }

    private static func branchName(_ ref: String) -> String? {
        ref.isEmpty ? nil : ref.replacingOccurrences(of: "refs/heads/", with: "")
    }

    private static func plural(_ n: Int, _ one: String) -> String {
        "\(n) \(one)\(n == 1 ? "" : "s")"
    }
}

/// Which of the owner's doors the landing view's own facts open (LS6: none is inferred here).
public struct LandingGates: Equatable, Sendable {
    public var stop: Bool
    public var cancel: Bool
    public var abandon: Bool
    public var retry: Bool
    public var recheck: Bool

    public init(stop: Bool = false, cancel: Bool = false, abandon: Bool = false,
                retry: Bool = false, recheck: Bool = false) {
        self.stop = stop
        self.cancel = cancel
        self.abandon = abandon
        self.retry = retry
        self.recheck = recheck
    }

    public static let none = LandingGates()
}

public extension LandingPageCopy {
    /// The doors the newest attempt's own facts open. Every condition is the view's: the job's kind,
    /// whether it is in flight, the server's `timedOut`/`liveness`, the phase the runner reported,
    /// and the push boundary the server computed. A read this device could not make opens nothing —
    /// a door pressed against a stale fact is a decision made on nothing.
    static func gates(_ landing: SessionLandingView, now: Date,
                      updatedAt: Date? = nil, failed: Bool = false) -> LandingGates {
        guard landing.settledAt == nil,
              !readUnavailable(now: now, updatedAt: updatedAt, failed: failed),
              let attempt = landing.currentAttempt else { return .none }
        let expired = attempt.timedOut || attempt.liveness == "LEASE_EXPIRED"
        let inFlight = attempt.state == "RUNNING" || attempt.state == "QUEUED"
        guard inFlight else { return .none }
        // The two facts the server publishes for exactly this decision (§2.9 LS6): `retryable` is
        // the queue's own answer to whether the owner's Retry takes this attempt, and
        // `pushBoundaryPassed` is J-T4's boundary computed from the claim.
        let pastPush = attempt.pushBoundaryPassed
        let cancelling = cancelling(landing)
        return LandingGates(
            stop: attempt.kind == "LAND_TASK" && !expired && !pastPush && !cancelling,
            cancel: attempt.kind == "LAND_PROMOTION" && !expired && !pastPush && !cancelling,
            abandon: attempt.state == "RUNNING" && expired,
            retry: attempt.retryable,
            recheck: attempt.timedOut && attempt.kind == "CHECK_PROMOTION"
                && landing.promotionId != nil)
    }
}

/// What a landing menu row does; the page owns the navigation and the press.
public enum LandingMenuAction: String, Sendable, CaseIterable {
    case openTask = "OPEN_TASK"
    case openSourceSession = "OPEN_SOURCE_SESSION"
    case openCoordinator = "OPEN_COORDINATOR"
    case reviewCard = "REVIEW_CARD"
    case stop = "STOP"
    case cancel = "CANCEL"
    case abandon = "ABANDON"
    case retry = "RETRY"
    case rerunTheCheck = "RERUN_THE_CHECK"

    /// The doors that write, which the menu separates from the ways to look.
    public var isDoor: Bool {
        switch self {
        case .stop, .cancel, .abandon, .retry, .rerunTheCheck: return true
        case .openTask, .openSourceSession, .openCoordinator, .reviewCard: return false
        }
    }
}

/// One row of the ⋯ menu the landing page draws (mockups v4 05 d, h).
public struct LandingMenuItem: Equatable, Sendable, Identifiable {
    public let key: String
    public let action: LandingMenuAction
    public let label: String
    /// The consequence line under the label — the two stop doors and Abandon carry one.
    public let sub: String?
    public let danger: Bool

    public var id: String { key }

    public init(key: String, action: LandingMenuAction, label: String,
                sub: String? = nil, danger: Bool = false) {
        self.key = key
        self.action = action
        self.label = label
        self.sub = sub
        self.danger = danger
    }
}

public extension LandingPageCopy {
    /// The ⋯ menu's rows, in the order the board draws them: the ways to look at this work, then the
    /// doors the landing view's facts open. No Copy Link (design §3, owner 2026-10-19) and no other
    /// row invented by the client.
    static func menuItems(_ landing: SessionLandingView, gates: LandingGates,
                          hasCoordinator: Bool, hasReview: Bool,
                          nothingPushed: Bool) -> [LandingMenuItem] {
        var items: [LandingMenuItem] = []
        if let taskId = landing.taskId, !taskId.isEmpty {
            items.append(LandingMenuItem(key: "task", action: .openTask, label: openTask))
        }
        // A merge round names the session of the task that landed last, not a source this round
        // worked in: the board's merge-round menu is Review Card and Open Coordinator alone.
        if landing.subject == "TASK",
           let source = landing.currentAttempt?.sourceSessionId, !source.isEmpty {
            items.append(LandingMenuItem(key: "source", action: .openSourceSession,
                                         label: openSourceSession))
        }
        if hasCoordinator {
            items.append(LandingMenuItem(key: "coordinator", action: .openCoordinator,
                                         label: openCoordinator))
        }
        if landing.subject == "PROMOTION" && hasReview {
            items.append(LandingMenuItem(key: "review", action: .reviewCard, label: reviewCard))
        }
        if gates.stop {
            items.append(LandingMenuItem(key: "stop", action: .stop, label: stopLanding,
                                         sub: beforePushOnly, danger: true))
        }
        if gates.cancel {
            items.append(LandingMenuItem(key: "cancel", action: .cancel, label: cancelMerge,
                                         sub: cancelBeforePush, danger: true))
        }
        if gates.abandon {
            items.append(LandingMenuItem(
                key: "abandon", action: .abandon, label: abandon,
                // J12's verdict, not the sentence the card draws: a check never pushes, so its
                // Abandon ends an attempt that provably never reached main.
                sub: nothingPushed ? endsNothingPushed : endsMayHavePushed, danger: true))
        }
        if gates.retry {
            items.append(LandingMenuItem(key: "retry", action: .retry, label: retry))
        }
        if gates.recheck {
            items.append(LandingMenuItem(key: "recheck", action: .rerunTheCheck,
                                         label: rerunTheCheck))
        }
        return items
    }

    /// The J12 sentence under a timed-out attempt: which jobs can prove nothing was pushed and
    /// which cannot. A merge check gets NO sentence (owner 2026-10-19): CHECK_PROMOTION never
    /// pushes, so a push sentence about it is noise on a card that already says what stopped.
    static func pushSentence(_ landing: SessionLandingView,
                             attempt: SessionLandingAttempt) -> String? {
        if attempt.kind == "CHECK_PROMOTION" { return nil }
        let reported = pushReport(landing, jobId: attempt.jobId)
        if attempt.progressProtocol == "v2" && !reported.reported {
            return nothingPushedSentence
        }
        if let at = reported.at, let instant = RelativeTime.parse(at) {
            return mayHavePushedAt(ProjectPage.landingClockTime(instant))
        }
        return mayHavePushedSentence
    }

    /// The timed-out card's line about the claim: who took it, when, and where it stopped.
    static func timeoutLine(_ landing: SessionLandingView, attempt: SessionLandingAttempt,
                            main: String = "main") -> String {
        let who = attempt.runnerName.flatMap { $0.isEmpty ? nil : "\(LandingPageCopy.runner) \($0)" }
            ?? LandingPageCopy.theRunner
        let took = RelativeTime.parse(attempt.startedAt)
            .map { ProjectPage.landingClockTime($0) } ?? "--:--"
        let stopped = attempt.phase.flatMap { ProjectPage.integrationPhaseWords(main)[$0] }
            ?? LandingPageCopy.running
        var parts = ["\(who) \(LandingPageCopy.tookItAt) \(took) · "
            + "\(LandingPageCopy.stoppedAt) \(stopped)",
            "\(ProjectPage.landingClaim) \(attempt.claim)"]
        if let round = attempt.round {
            parts.append(ProjectPage.landingRoundClause(round, kind: attempt.kind))
        }
        return parts.joined(separator: " · ")
    }

    /// The grey band a timed-out attempt's section ends with (mockups 05 e, f, i): the runner's last
    /// word that never came. Nil for an attempt the server has not judged timed out.
    static func noReportBand(_ landing: SessionLandingView) -> (text: String, at: String)? {
        guard let attempt = landing.currentAttempt, attempt.timedOut else { return nil }
        let at = attempt.heartbeatAt ?? attempt.startedAt
        let who = attempt.runnerName.flatMap { $0.isEmpty ? nil : $0 }
            .map { "\(LandingPageCopy.noReportFrom) \($0)" }
            ?? "\(LandingPageCopy.noReportFrom) the runner"
        let clock = RelativeTime.parse(at).map { ProjectPage.landingClockTime($0) } ?? "--:--"
        return ("\(who) \(LandingPageCopy.since) \(clock)", at)
    }

    /// The footer: what this page is, and the one way out of it that matters.
    static func footer(_ landing: SessionLandingView, onPass: String?) -> LandingFooter {
        if landing.settledAt != nil {
            return LandingFooter(
                line: thisLandingIsComplete, detail: nil, link: nil,
                next: landing.subject == "PROMOTION" ? nextMergeOpens(landing.episode + 1) : nil)
        }
        if landing.subject == "TASK" {
            return LandingFooter(line: orbitRunsThisLanding, detail: decisionsTheCoordinator,
                                 link: .coordinator, next: nil)
        }
        return LandingFooter(
            line: orbitRunsThisLanding,
            detail: onPass == "MERGE" ? aCleanPassMergesOnItsOwn : mergingIsDecidedOnTheCard,
            link: .reviewCard, next: nil)
    }

    /// A section's state after its title (`Generation 1 · not landed · CHECK_FAILED`).
    static func sectionState(_ state: String) -> String? {
        switch state {
        case "CHECK_FAILED", "CONFLICT": return "not landed · \(state)"
        case "ERROR": return "stopped · \(state)"
        case "CANCELLED": return "stopped"
        default: return nil
        }
    }

    /// `Open landing ›` or, on a server that names none, the grey sentence in the same slot — the
    /// one rule every entrance wears (owner 2026-10-19, 方案 A).
    static func landingEntry(_ landingSessionId: String?) -> LandingEntry {
        guard let landingSessionId, !landingSessionId.isEmpty else { return .noPage }
        return .link(landingSessionId)
    }

    /// The read-only page a device that cannot reach the server opens from the inFlight snapshot it
    /// already holds: the attempt as the integration read last described it, with the clock frozen,
    /// `Update unavailable` in the head, and — by `gates`' own rule for a failed read — no door.
    /// Nil when nothing was cached, which leaves the page's own "Update unavailable" note.
    static func offlinePlaceholder(sessionId: String, projectId: String?,
                                   inFlight: ProjectIntegrationInFlight?) -> SessionLandingView? {
        guard let inFlight else { return nil }
        let attempt = SessionLandingAttempt(
            jobId: inFlight.jobId ?? "", kind: inFlight.kind ?? "", state: inFlight.state,
            generation: 1, phase: inFlight.phase, round: inFlight.round, claim: inFlight.claim ?? 0,
            runnerName: inFlight.runner, sourceSessionId: inFlight.taskId,
            targetRef: "", startedAt: inFlight.startedAt, heartbeatAt: inFlight.heartbeatAt,
            outputMovedAt: inFlight.outputMovedAt, progressProtocol: inFlight.progressProtocol,
            check: inFlight.check.map {
                LandingAttemptCheck(name: $0.name, index: $0.index, count: $0.count,
                                    budgetSeconds: $0.budgetSeconds, startedAt: $0.startedAt)
            },
            liveness: inFlight.liveness, blockingReason: inFlight.blockingReason,
            timedOut: false, limitSeconds: nil, retryable: false, pushBoundaryPassed: false)
        return SessionLandingView(
            sessionId: sessionId, projectId: projectId ?? "", subject: "TASK",
            taskId: inFlight.taskId, openedAt: inFlight.startedAt,
            currentAttempt: attempt)
    }
}

/// A landing entrance's two answers: a session id to open, or the fact that this server names none.
public enum LandingEntry: Equatable, Sendable {
    case link(String)
    case noPage

    public var sessionId: String? {
        if case .link(let id) = self { return id }
        return nil
    }

    /// The words beside the press, or in its place.
    public var label: String {
        switch self {
        case .link: return LandingPageCopy.openLanding
        case .noPage: return LandingPageCopy.noLandingPage
        }
    }
}

/// The footer's shape: which way out it names, and what comes next.
public struct LandingFooter: Equatable, Sendable {
    public enum Link: Equatable, Sendable { case coordinator, reviewCard }
    public let line: String
    public let detail: String?
    public let link: Link?
    public let next: String?

    public init(line: String = "", detail: String? = nil, link: Link? = nil, next: String? = nil) {
        self.line = line
        self.detail = detail
        self.link = link
        self.next = next
    }
}

extension String {
    /// The web's `toLowerCase()` on the first character: a word that opens a sentence when alone and
    /// folds into one mid-line.
    func lowercasedFirst() -> String {
        guard let first = self.first else { return self }
        return first.lowercased() + dropFirst()
    }
}
