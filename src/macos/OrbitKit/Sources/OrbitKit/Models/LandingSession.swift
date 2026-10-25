import Foundation

// The landing session's reads (contract §2.9 LS1/LS2/LS6), transcribed from `@orbit/shared`'s
// `SessionLandingView` and the log page beside it. A LANDING session is platform work, not a
// conversation: `GET /sessions/:id` answers `sessionKind` and, for one of these, the `landing`
// view a page is drawn from. The subject's row may not exist yet — its id is pre-generated — so
// every field is decoded tolerantly: an older server that sends none of the landing fields still
// reads as a session, and a value this build cannot read is the same absence.

/// One finished check of the current attempt, in the runner's own result shape. Only the fields a
/// page prints are typed; the rest of the object is read past.
public struct LandingCheckResult: Codable, Equatable, Sendable {
    public let name: String?
    public let command: String?
    public let exitCode: Int?
    public let expectedExitCode: Int?
    public let timedOut: Bool?
    public let durationMs: Int?
    public let outputTail: String?

    public init(name: String? = nil, command: String? = nil, exitCode: Int? = nil,
                expectedExitCode: Int? = nil, timedOut: Bool? = nil, durationMs: Int? = nil,
                outputTail: String? = nil) {
        self.name = name
        self.command = command
        self.exitCode = exitCode
        self.expectedExitCode = expectedExitCode
        self.timedOut = timedOut
        self.durationMs = durationMs
        self.outputTail = outputTail
    }

    /// Whether the check finished clean: no timeout, and either no exit code reported or the one
    /// the command was expected to give.
    public var passed: Bool {
        timedOut != true && (exitCode == nil || exitCode == expectedExitCode)
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        name = try? c.decodeIfPresent(String.self, forKey: .name)
        command = try? c.decodeIfPresent(String.self, forKey: .command)
        exitCode = try? c.decodeIfPresent(Int.self, forKey: .exitCode)
        expectedExitCode = try? c.decodeIfPresent(Int.self, forKey: .expectedExitCode)
        timedOut = try? c.decodeIfPresent(Bool.self, forKey: .timedOut)
        durationMs = try? c.decodeIfPresent(Int.self, forKey: .durationMs)
        outputTail = try? c.decodeIfPresent(String.self, forKey: .outputTail)
    }
}

/// The check a v2 claim is running, as its progress reports name it — the same object the project's
/// integration read serves (`ProjectIntegrationCheck`), re-declared here through a tolerant decode
/// so a landing read never fails on it.
public struct LandingAttemptCheck: Codable, Equatable, Sendable {
    public let name: String
    public let index: Int
    public let count: Int
    public let budgetSeconds: Int
    public let startedAt: String

    public init(name: String = "", index: Int = 0, count: Int = 0,
                budgetSeconds: Int = 0, startedAt: String = "") {
        self.name = name
        self.index = index
        self.count = count
        self.budgetSeconds = budgetSeconds
        self.startedAt = startedAt
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        name = try c.decodeIfPresent(String.self, forKey: .name) ?? ""
        index = try c.decodeIfPresent(Int.self, forKey: .index) ?? 0
        count = try c.decodeIfPresent(Int.self, forKey: .count) ?? 0
        budgetSeconds = try c.decodeIfPresent(Int.self, forKey: .budgetSeconds) ?? 0
        startedAt = try c.decodeIfPresent(String.self, forKey: .startedAt) ?? ""
    }

    public var asProjectCheck: ProjectIntegrationCheck {
        ProjectIntegrationCheck(name: name, index: index, count: count,
                                budgetSeconds: budgetSeconds, startedAt: startedAt)
    }
}

/// The newest attempt of a landing subject, as its session's page draws it (`SessionLandingAttempt`).
public struct SessionLandingAttempt: Codable, Equatable, Sendable {
    public let jobId: String
    /// `LAND_TASK`, `CHECK_PROMOTION` or `LAND_PROMOTION`.
    public let kind: String
    /// `QUEUED`, `RUNNING`, `READY`, `CONFIRMED`, `MERGED`, … — drawn as the server spells it.
    public let state: String
    /// Which landing of its subject this attempt is, counting from 1.
    public let generation: Int
    /// The step the runner last reported, or the one it stopped at.
    public let phase: String?
    /// The round inside the current claim, from 1.
    public let round: Int?
    public let step: String?
    /// The claim generation: 0 before the first claim, one more per takeover.
    public let claim: Int
    public let runnerName: String?
    /// The work session this attempt is about; nil once that row was purged.
    public let sourceSessionId: String?
    /// The branch the attempt writes, as the job froze it.
    public let targetRef: String
    public let startedAt: String
    public let heartbeatAt: String?
    public let outputMovedAt: String?
    public let progressProtocol: String?
    public let check: LandingAttemptCheck?
    /// `LIVE`, `QUIET`, `SILENT`, `LEASE_EXPIRED` or `LEGACY`; nil while queued.
    public let liveness: String?
    public let blockingReason: LandTaskBlockingReason?
    /// The server judged the runner silent past its limit. Still RUNNING; only a retry ends it.
    public let timedOut: Bool
    public let limitSeconds: Int?
    /// Whether the owner's Retry takes this attempt now — the server's answer.
    public let retryable: Bool
    /// The current claim is past the push boundary (§2.2 J-T4): Stop and Cancel are refused past it.
    public let pushBoundaryPassed: Bool

    public init(jobId: String, kind: String, state: String, generation: Int = 1,
                phase: String? = nil, round: Int? = nil, step: String? = nil, claim: Int = 0,
                runnerName: String? = nil, sourceSessionId: String? = nil, targetRef: String = "",
                startedAt: String = "", heartbeatAt: String? = nil, outputMovedAt: String? = nil,
                progressProtocol: String? = nil, check: LandingAttemptCheck? = nil,
                liveness: String? = nil, blockingReason: LandTaskBlockingReason? = nil,
                timedOut: Bool = false, limitSeconds: Int? = nil, retryable: Bool = false,
                pushBoundaryPassed: Bool = false) {
        self.jobId = jobId
        self.kind = kind
        self.state = state
        self.generation = generation
        self.phase = phase
        self.round = round
        self.step = step
        self.claim = claim
        self.runnerName = runnerName
        self.sourceSessionId = sourceSessionId
        self.targetRef = targetRef
        self.startedAt = startedAt
        self.heartbeatAt = heartbeatAt
        self.outputMovedAt = outputMovedAt
        self.progressProtocol = progressProtocol
        self.check = check
        self.liveness = liveness
        self.blockingReason = blockingReason
        self.timedOut = timedOut
        self.limitSeconds = limitSeconds
        self.retryable = retryable
        self.pushBoundaryPassed = pushBoundaryPassed
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        jobId = try c.decodeIfPresent(String.self, forKey: .jobId) ?? ""
        kind = try c.decodeIfPresent(String.self, forKey: .kind) ?? ""
        state = try c.decodeIfPresent(String.self, forKey: .state) ?? "QUEUED"
        generation = try c.decodeIfPresent(Int.self, forKey: .generation) ?? 1
        phase = try? c.decodeIfPresent(String.self, forKey: .phase)
        round = try? c.decodeIfPresent(Int.self, forKey: .round)
        step = try? c.decodeIfPresent(String.self, forKey: .step)
        claim = try c.decodeIfPresent(Int.self, forKey: .claim) ?? 0
        runnerName = try? c.decodeIfPresent(String.self, forKey: .runnerName)
        sourceSessionId = try? c.decodeIfPresent(String.self, forKey: .sourceSessionId)
        targetRef = try c.decodeIfPresent(String.self, forKey: .targetRef) ?? ""
        startedAt = try c.decodeIfPresent(String.self, forKey: .startedAt) ?? ""
        heartbeatAt = try? c.decodeIfPresent(String.self, forKey: .heartbeatAt)
        outputMovedAt = try? c.decodeIfPresent(String.self, forKey: .outputMovedAt)
        progressProtocol = try? c.decodeIfPresent(String.self, forKey: .progressProtocol)
        check = try? c.decodeIfPresent(LandingAttemptCheck.self, forKey: .check)
        liveness = try? c.decodeIfPresent(String.self, forKey: .liveness)
        blockingReason = try? c.decodeIfPresent(LandTaskBlockingReason.self, forKey: .blockingReason)
        timedOut = try c.decodeIfPresent(Bool.self, forKey: .timedOut) ?? false
        limitSeconds = try? c.decodeIfPresent(Int.self, forKey: .limitSeconds)
        retryable = try c.decodeIfPresent(Bool.self, forKey: .retryable) ?? false
        pushBoundaryPassed = try c.decodeIfPresent(Bool.self, forKey: .pushBoundaryPassed) ?? false
    }
}

/// One OPEN integration item about the landing's subject that somebody still owes (`SessionLandingTodo`).
public struct SessionLandingTodo: Codable, Equatable, Sendable, Identifiable {
    public let id: String
    public let kind: String
    public let state: String
    public let title: String
    public let waitingSince: String

    public init(id: String, kind: String = "", state: String = "", title: String = "",
                waitingSince: String = "") {
        self.id = id
        self.kind = kind
        self.state = state
        self.title = title
        self.waitingSince = waitingSince
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decodeIfPresent(String.self, forKey: .id) ?? ""
        kind = try c.decodeIfPresent(String.self, forKey: .kind) ?? ""
        state = try c.decodeIfPresent(String.self, forKey: .state) ?? ""
        title = try c.decodeIfPresent(String.self, forKey: .title) ?? ""
        waitingSince = try c.decodeIfPresent(String.self, forKey: .waitingSince) ?? ""
    }
}

/// One generation (segment/round) of the landing subject.
public struct SessionLandingGeneration: Codable, Equatable, Sendable {
    public let sessionId: String
    public let episode: Int
    public let openedAt: String
    public let settledAt: String?
    public let settledAs: String?

    public init(sessionId: String = "", episode: Int = 0, openedAt: String = "",
                settledAt: String? = nil, settledAs: String? = nil) {
        self.sessionId = sessionId
        self.episode = episode
        self.openedAt = openedAt
        self.settledAt = settledAt
        self.settledAs = settledAs
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        sessionId = try c.decodeIfPresent(String.self, forKey: .sessionId) ?? ""
        episode = try c.decodeIfPresent(Int.self, forKey: .episode) ?? 0
        openedAt = try c.decodeIfPresent(String.self, forKey: .openedAt) ?? ""
        settledAt = try? c.decodeIfPresent(String.self, forKey: .settledAt)
        settledAs = try? c.decodeIfPresent(String.self, forKey: .settledAs)
    }
}

/// The check a timeline line names (`{ name, index }`).
public struct LandingTimelineCheck: Codable, Equatable, Sendable {
    public let name: String
    public let index: Int

    public init(name: String = "", index: Int = 0) {
        self.name = name
        self.index = index
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        name = try c.decodeIfPresent(String.self, forKey: .name) ?? ""
        index = try c.decodeIfPresent(Int.self, forKey: .index) ?? 0
    }
}

/// One line of the landing timeline, as the server wrote it. `text` is the whole sentence; a client
/// lays it out and never composes one from the fields.
public struct IntegrationTimelineEntry: Codable, Equatable, Sendable {
    public let id: String?
    /// The ledger's own order; absent on a line derived at read time.
    public let seq: Int?
    /// An `IntegrationJobEventKind`, or one of `DerivedTimelineKind`.
    public let kind: String
    public let at: String
    public let claim: Int
    public let round: Int?
    public let check: LandingTimelineCheck?
    public let phase: String?
    public let step: String?
    public let reason: String?
    /// The structured fields the server wrote the sentence from (a check's exit codes, a result's
    /// state). A value this build cannot read is the same as none.
    public let data: [String: JSONValue]?
    public let text: String
    public let derived: Bool?

    public init(id: String? = nil, seq: Int? = nil, kind: String = "", at: String = "",
                claim: Int = 0, round: Int? = nil, check: LandingTimelineCheck? = nil,
                phase: String? = nil, step: String? = nil, reason: String? = nil,
                data: [String: JSONValue]? = nil, text: String = "", derived: Bool? = nil) {
        self.id = id
        self.seq = seq
        self.kind = kind
        self.at = at
        self.claim = claim
        self.round = round
        self.check = check
        self.phase = phase
        self.step = step
        self.reason = reason
        self.data = data
        self.text = text
        self.derived = derived
    }

    /// A finished check passed: it did not time out and exited with the code it expected. Read off
    /// `data`, never off the sentence; a check with no exit code did not pass (unlike
    /// `LandingCheckResult.passed`, the settled card's rule). Web: `landingCheckPassed`.
    public var checkPassed: Bool {
        guard kind == "CHECK_FINISHED", data?["timedOut"]?.boolValue != true,
              let exitCode = data?["exitCode"]?.intValue else { return false }
        return exitCode == data?["expectedExitCode"]?.intValue
    }

    /// A check or result line that ended well draws ✓, and one that did not draws ✗: a passed
    /// check, or a result whose branch is on its target. `jobKind` is the kind of the section the
    /// line is in: a merge check that ends READY passed, and its round is ready to merge into main.
    /// A merge to main that answers READY handed the candidate back to be checked again and merged
    /// nothing (M-T12, J-T13), so it keeps its ✗. Web: `landingEntryOk`.
    public func succeeded(in jobKind: String) -> Bool {
        switch kind {
        case "CHECK_FINISHED":
            return checkPassed
        case "RESULT", "RESULT_FALLBACK":
            guard let state = data?["state"]?.stringValue else { return false }
            return ["LANDED", "ALREADY_LANDED", "NOTHING_TO_LAND"].contains(state)
                || (jobKind == "CHECK_PROMOTION" && state == "READY")
        default:
            return false
        }
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try? c.decodeIfPresent(String.self, forKey: .id)
        seq = try? c.decodeIfPresent(Int.self, forKey: .seq)
        kind = try c.decodeIfPresent(String.self, forKey: .kind) ?? ""
        at = try c.decodeIfPresent(String.self, forKey: .at) ?? ""
        claim = try c.decodeIfPresent(Int.self, forKey: .claim) ?? 0
        round = try? c.decodeIfPresent(Int.self, forKey: .round)
        check = try? c.decodeIfPresent(LandingTimelineCheck.self, forKey: .check)
        phase = try? c.decodeIfPresent(String.self, forKey: .phase)
        step = try? c.decodeIfPresent(String.self, forKey: .step)
        reason = try? c.decodeIfPresent(String.self, forKey: .reason)
        data = try? c.decodeIfPresent([String: JSONValue].self, forKey: .data)
        text = try c.decodeIfPresent(String.self, forKey: .text) ?? ""
        derived = try? c.decodeIfPresent(Bool.self, forKey: .derived)
    }
}

/// One section of the timeline: a task landing's generation, or one merge round's attempt.
public struct IntegrationTimelineSection: Codable, Equatable, Sendable, Identifiable {
    /// The server-written heading (`Generation 1`, `Merge check · 2`).
    public let title: String
    public let jobId: String
    public let kind: String
    public let generation: Int
    public let state: String
    public var entries: [IntegrationTimelineEntry]

    public var id: String { jobId }

    public init(title: String = "", jobId: String = "", kind: String = "", generation: Int = 0,
                state: String = "", entries: [IntegrationTimelineEntry] = []) {
        self.title = title
        self.jobId = jobId
        self.kind = kind
        self.generation = generation
        self.state = state
        self.entries = entries
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        title = try c.decodeIfPresent(String.self, forKey: .title) ?? ""
        jobId = try c.decodeIfPresent(String.self, forKey: .jobId) ?? ""
        kind = try c.decodeIfPresent(String.self, forKey: .kind) ?? ""
        generation = try c.decodeIfPresent(Int.self, forKey: .generation) ?? 0
        state = try c.decodeIfPresent(String.self, forKey: .state) ?? ""
        entries = try c.decodeIfPresent([IntegrationTimelineEntry].self, forKey: .entries) ?? []
    }
}

/// A subject-level derived fact that belongs to no one attempt.
public struct IntegrationTimelineFact: Codable, Equatable, Sendable {
    public let kind: String
    public let text: String

    public init(kind: String = "", text: String = "") {
        self.kind = kind
        self.text = text
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        kind = try c.decodeIfPresent(String.self, forKey: .kind) ?? ""
        text = try c.decodeIfPresent(String.self, forKey: .text) ?? ""
    }
}

/// The landing subject's whole timeline: one section per attempt, oldest first.
public struct SessionLandingTimeline: Codable, Equatable, Sendable {
    public let sections: [IntegrationTimelineSection]
    public let facts: [IntegrationTimelineFact]
    public let truncated: Bool

    public init(sections: [IntegrationTimelineSection] = [],
                facts: [IntegrationTimelineFact] = [], truncated: Bool = false) {
        self.sections = sections
        self.facts = facts
        self.truncated = truncated
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        sections = try c.decodeIfPresent([IntegrationTimelineSection].self, forKey: .sections) ?? []
        facts = try c.decodeIfPresent([IntegrationTimelineFact].self, forKey: .facts) ?? []
        truncated = try c.decodeIfPresent(Bool.self, forKey: .truncated) ?? false
    }
}

/// The landing view `GET /sessions/:id` answers for a LANDING session (§2.9 LS1, LS6), and — on a
/// project's session list with `includeLanding=1` — the summary a row carries under the same key.
///
/// The two shapes share the key, so this decodes both: a list summary has `state`, no `sessionId`
/// and no attempt; a detail view has the whole subject and no `state`. Every field the two do not
/// share defaults, and nothing here fails a read.
public struct SessionLandingView: Codable, Equatable, Sendable {
    /// The LANDING session's id: pre-generated when the subject opened, present on the detail view.
    public let sessionId: String
    public let projectId: String
    /// `TASK` or `PROMOTION`.
    public let subject: String
    public let taskId: String?
    public let promotionId: String?
    public let episode: Int
    public let openedAt: String
    public let settledAt: String?
    /// `LANDED | ALREADY_LANDED | NOTHING_TO_LAND | MERGED | HANDLED | DECLINED | CANCELLED | DELETED`,
    /// or nil while the subject is open.
    public let settledAs: String?
    /// The list summary's state: `IN_FLIGHT`, `AWAITING_DECISION` or `SETTLED` — nil on a detail view.
    public let state: String?
    /// The newest attempt's phase and round, lifted so a card can draw them without reaching into it.
    public let phase: String?
    public let round: Int?
    /// The newest attempt's finished check results, `[]` when it has none.
    public let checks: [LandingCheckResult]
    public let liveness: String?
    public let blockingReason: LandTaskBlockingReason?
    /// The newest attempt of the subject, whatever its state; nil for a subject no attempt claimed.
    public let currentAttempt: SessionLandingAttempt?
    /// The subject's integration items still OPEN and still owed, oldest first.
    public let todos: [SessionLandingTodo]
    /// Every generation of the subject, oldest first.
    public let generations: [SessionLandingGeneration]
    /// Absent on servers that predate the timeline (§2.9: a new field is optional).
    public let timeline: SessionLandingTimeline?

    public init(sessionId: String = "", projectId: String = "", subject: String = "",
                taskId: String? = nil, promotionId: String? = nil, episode: Int = 0,
                openedAt: String = "", settledAt: String? = nil, settledAs: String? = nil,
                state: String? = nil, phase: String? = nil, round: Int? = nil,
                checks: [LandingCheckResult] = [], liveness: String? = nil,
                blockingReason: LandTaskBlockingReason? = nil,
                currentAttempt: SessionLandingAttempt? = nil,
                todos: [SessionLandingTodo] = [], generations: [SessionLandingGeneration] = [],
                timeline: SessionLandingTimeline? = nil) {
        self.sessionId = sessionId
        self.projectId = projectId
        self.subject = subject
        self.taskId = taskId
        self.promotionId = promotionId
        self.episode = episode
        self.openedAt = openedAt
        self.settledAt = settledAt
        self.settledAs = settledAs
        self.state = state
        self.phase = phase
        self.round = round
        self.checks = checks
        self.liveness = liveness
        self.blockingReason = blockingReason
        self.currentAttempt = currentAttempt
        self.todos = todos
        self.generations = generations
        self.timeline = timeline
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        sessionId = try c.decodeIfPresent(String.self, forKey: .sessionId) ?? ""
        projectId = try c.decodeIfPresent(String.self, forKey: .projectId) ?? ""
        subject = try c.decodeIfPresent(String.self, forKey: .subject) ?? ""
        taskId = try? c.decodeIfPresent(String.self, forKey: .taskId)
        promotionId = try? c.decodeIfPresent(String.self, forKey: .promotionId)
        episode = try c.decodeIfPresent(Int.self, forKey: .episode) ?? 0
        openedAt = try c.decodeIfPresent(String.self, forKey: .openedAt) ?? ""
        settledAt = try? c.decodeIfPresent(String.self, forKey: .settledAt)
        settledAs = try? c.decodeIfPresent(String.self, forKey: .settledAs)
        state = try? c.decodeIfPresent(String.self, forKey: .state)
        phase = try? c.decodeIfPresent(String.self, forKey: .phase)
        round = try? c.decodeIfPresent(Int.self, forKey: .round)
        checks = try c.decodeIfPresent([LandingCheckResult].self, forKey: .checks) ?? []
        liveness = try? c.decodeIfPresent(String.self, forKey: .liveness)
        blockingReason = try? c.decodeIfPresent(LandTaskBlockingReason.self, forKey: .blockingReason)
        currentAttempt = try? c.decodeIfPresent(SessionLandingAttempt.self, forKey: .currentAttempt)
        todos = try c.decodeIfPresent([SessionLandingTodo].self, forKey: .todos) ?? []
        generations = try c.decodeIfPresent([SessionLandingGeneration].self, forKey: .generations) ?? []
        timeline = try? c.decodeIfPresent(SessionLandingTimeline.self, forKey: .timeline)
    }

    /// Whether this is the list row's summary rather than the detail page's view.
    public var isSummary: Bool { state != nil && sessionId.isEmpty }
}

/// One chunk of a check's output (`ProjectIntegrationLogEntry`), already redacted by the runner.
public struct LandingLogEntry: Codable, Equatable, Sendable {
    public let jobId: String
    public let claim: Int
    public let round: Int
    public let check: LandingTimelineCheck
    /// The chunk's number within this check, from 0.
    public let seq: Int
    public let text: String
    /// Bytes dropped from the middle immediately before this chunk; 0 elsewhere.
    public let truncatedBytes: Int
    public let at: String

    public init(jobId: String = "", claim: Int = 0, round: Int = 0,
                check: LandingTimelineCheck = LandingTimelineCheck(), seq: Int = 0,
                text: String = "", truncatedBytes: Int = 0, at: String = "") {
        self.jobId = jobId
        self.claim = claim
        self.round = round
        self.check = check
        self.seq = seq
        self.text = text
        self.truncatedBytes = truncatedBytes
        self.at = at
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        jobId = try c.decodeIfPresent(String.self, forKey: .jobId) ?? ""
        claim = try c.decodeIfPresent(Int.self, forKey: .claim) ?? 0
        round = try c.decodeIfPresent(Int.self, forKey: .round) ?? 0
        check = try c.decodeIfPresent(LandingTimelineCheck.self, forKey: .check)
            ?? LandingTimelineCheck()
        seq = try c.decodeIfPresent(Int.self, forKey: .seq) ?? 0
        text = try c.decodeIfPresent(String.self, forKey: .text) ?? ""
        truncatedBytes = try c.decodeIfPresent(Int.self, forKey: .truncatedBytes) ?? 0
        at = try c.decodeIfPresent(String.self, forKey: .at) ?? ""
    }
}

/// One page of a check's output, as `GET /sessions/:id/landing/log` serves it.
public struct LandingLogPage: Codable, Equatable, Sendable {
    public let jobId: String?
    public let entries: [LandingLogEntry]
    public let nextCursor: String?

    public init(jobId: String? = nil, entries: [LandingLogEntry] = [], nextCursor: String? = nil) {
        self.jobId = jobId
        self.entries = entries
        self.nextCursor = nextCursor
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        jobId = try? c.decodeIfPresent(String.self, forKey: .jobId)
        entries = try c.decodeIfPresent([LandingLogEntry].self, forKey: .entries) ?? []
        nextCursor = try? c.decodeIfPresent(String.self, forKey: .nextCursor)
    }
}

/// The selectors one page of a check's output is read by (§2.2 J-T4, §2.9 LS2).
public struct LandingLogSelectors: Hashable, Sendable {
    public let jobId: String
    public let claim: Int?
    public let round: Int?
    public let check: Int?

    public init(jobId: String, claim: Int? = nil, round: Int? = nil, check: Int? = nil) {
        self.jobId = jobId
        self.claim = claim
        self.round = round
        self.check = check
    }
}
