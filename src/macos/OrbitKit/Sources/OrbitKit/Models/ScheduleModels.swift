import Foundation

// Scheduled tasks (docs/scheduled-tasks-design.md §9.1): the shapes the REST doors answer with
// (src/apiserver/src/schedules/schedule-views.ts), as `src/shared/src/schedule.ts` types them. Read
// leniently: a closed set is a String here, so a state or reason a newer server adds costs one word, not
// the list; the display rules (`ScheduleDisplay`) say what each one draws.

/// A schedule's rule: one slot, every day, some days of the week, or whenever its condition fires
/// (docs/condition-triggers-design.md §6.1).
public enum ScheduleRule: Equatable, Hashable, Sendable, Codable {
    case once(at: String)
    case daily(time: String)
    case weekly(time: String, weekdays: [String])
    /// Sub-daily: a slot every `minutes` from `time` through `until` (inclusive; nil for the end of the day) on
    /// `weekdays`. The server always writes `time` and `weekdays` too, so a build that predates EVERY reads the same
    /// JSON as a weekly rule (design §9.3).
    case every(minutes: Int, time: String, until: String?, weekdays: [String])
    /// A WHEN rule: starts a run each time its condition fires. `conditionId` is nil on a create card, before Create
    /// writes the condition.
    case when(conditionId: String?, runsPerWeek: Int, condition: ScheduleWhenCondition)

    private enum CodingKeys: String, CodingKey { case kind, at, time, weekdays, minutes, until, conditionId, runsPerWeek, condition }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        switch try c.decode(String.self, forKey: .kind) {
        case "ONCE": self = .once(at: try c.decode(String.self, forKey: .at))
        case "DAILY": self = .daily(time: try c.decode(String.self, forKey: .time))
        case "WHEN":
            self = .when(conditionId: try? c.decodeIfPresent(String.self, forKey: .conditionId),
                         runsPerWeek: (try? c.decode(Int.self, forKey: .runsPerWeek)) ?? 0,
                         condition: try c.decode(ScheduleWhenCondition.self, forKey: .condition))
        case "EVERY":
            self = .every(minutes: try c.decode(Int.self, forKey: .minutes),
                          time: try c.decode(String.self, forKey: .time),
                          until: try? c.decodeIfPresent(String.self, forKey: .until),
                          weekdays: (try? c.decode([String].self, forKey: .weekdays)) ?? [])
        default:
            self = .weekly(time: try c.decode(String.self, forKey: .time),
                           weekdays: (try? c.decode([String].self, forKey: .weekdays)) ?? [])
        }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .once(let at):
            try c.encode("ONCE", forKey: .kind)
            try c.encode(at, forKey: .at)
        case .daily(let time):
            try c.encode("DAILY", forKey: .kind)
            try c.encode(time, forKey: .time)
        case .weekly(let time, let weekdays):
            try c.encode("WEEKLY", forKey: .kind)
            try c.encode(time, forKey: .time)
            try c.encode(weekdays, forKey: .weekdays)
        case .every(let minutes, let time, let until, let weekdays):
            try c.encode("EVERY", forKey: .kind)
            try c.encode(minutes, forKey: .minutes)
            try c.encode(time, forKey: .time)
            try c.encodeIfPresent(until, forKey: .until)
            try c.encode(weekdays, forKey: .weekdays)
        case .when(let conditionId, let runsPerWeek, let condition):
            try c.encode("WHEN", forKey: .kind)
            try c.encode(conditionId, forKey: .conditionId)
            try c.encode(runsPerWeek, forKey: .runsPerWeek)
            try c.encode(condition, forKey: .condition)
        }
    }

    /// The rule as JSON, as a change record's before / after carry it.
    public init?(json: JSONValue?) {
        guard let json, let data = try? JSONEncoder().encode(json),
              let rule = try? JSONDecoder().decode(ScheduleRule.self, from: data) else { return nil }
        self = rule
    }

    public var time: String? {
        switch self {
        case .once, .when: return nil
        case .daily(let time), .weekly(let time, _), .every(_, let time, _, _): return time
        }
    }

    /// A WHEN rule's condition; nil for a timed rule.
    public var condition: ScheduleWhenCondition? {
        if case .when(_, _, let condition) = self { return condition }
        return nil
    }

    /// A WHEN rule's condition id, once Create has written it.
    public var conditionId: String? {
        if case .when(let id, _, _) = self { return id }
        return nil
    }
}

/// A comparison a condition's readings are held to: `GT` 90, or `EXIT_ZERO` with no value.
public struct ConditionCompare: Codable, Equatable, Hashable, Sendable {
    public let op: String
    public let value: Double?
    public init(op: String, value: Double?) {
        self.op = op
        self.value = value
    }
    private enum CodingKeys: String, CodingKey { case op, value }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        op = try c.decode(String.self, forKey: .op)
        value = try? c.decodeIfPresent(Double.self, forKey: .value)
    }
}

/// A WHEN rule's condition (shared `ScheduleWhenCondition`), every default written out.
public struct ScheduleWhenCondition: Codable, Equatable, Hashable, Sendable {
    public let text: String
    public let command: String
    public let compare: ConditionCompare
    public let holdSeconds: Int
    public let rearm: ConditionCompare?
    public let intervalSeconds: Int
    public let unit: String?
    public let timeoutSeconds: Int
    /// Fire again every this many seconds while it still holds; nil fires once.
    public let repeatSeconds: Int?

    public init(text: String, command: String, compare: ConditionCompare, holdSeconds: Int = 0,
                rearm: ConditionCompare? = nil, intervalSeconds: Int = 300, unit: String? = nil,
                timeoutSeconds: Int = 20, repeatSeconds: Int? = nil) {
        self.text = text
        self.command = command
        self.compare = compare
        self.holdSeconds = holdSeconds
        self.rearm = rearm
        self.intervalSeconds = intervalSeconds
        self.unit = unit
        self.timeoutSeconds = timeoutSeconds
        self.repeatSeconds = repeatSeconds
    }

    private enum CodingKeys: String, CodingKey {
        case text, command, compare, holdSeconds, rearm, intervalSeconds, unit, timeoutSeconds, repeatSeconds
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        text = try c.decode(String.self, forKey: .text)
        command = (try? c.decode(String.self, forKey: .command)) ?? ""
        compare = try c.decode(ConditionCompare.self, forKey: .compare)
        holdSeconds = (try? c.decode(Int.self, forKey: .holdSeconds)) ?? 0
        rearm = try? c.decodeIfPresent(ConditionCompare.self, forKey: .rearm)
        intervalSeconds = (try? c.decode(Int.self, forKey: .intervalSeconds)) ?? 300
        unit = try? c.decodeIfPresent(String.self, forKey: .unit)
        timeoutSeconds = (try? c.decode(Int.self, forKey: .timeoutSeconds)) ?? 20
        repeatSeconds = try? c.decodeIfPresent(Int.self, forKey: .repeatSeconds)
    }
}

/// A WHEN schedule's condition, or a waiting task's, as a list shows it: the newest reading and its age
/// (condition-triggers board ④).
public struct ScheduleConditionReading: Codable, Equatable, Hashable, Sendable {
    public let id: String
    public let text: String
    public let unit: String?
    /// WAITING, HOLDING, FIRED, UNKNOWN or ENDED.
    public let state: String
    public let lastValue: Double?
    public let lastSampleAt: String?

    public init(id: String, text: String, unit: String? = nil, state: String = "WAITING", lastValue: Double? = nil,
                lastSampleAt: String? = nil) {
        self.id = id
        self.text = text
        self.unit = unit
        self.state = state
        self.lastValue = lastValue
        self.lastSampleAt = lastSampleAt
    }

    private enum CodingKeys: String, CodingKey { case id, text, unit, state, lastValue, lastSampleAt }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        text = (try? c.decode(String.self, forKey: .text)) ?? ""
        unit = try? c.decodeIfPresent(String.self, forKey: .unit)
        state = (try? c.decode(String.self, forKey: .state)) ?? "WAITING"
        lastValue = try? c.decodeIfPresent(Double.self, forKey: .lastValue)
        lastSampleAt = try? c.decodeIfPresent(String.self, forKey: .lastSampleAt)
    }

    /// The probe cannot be read: the row is tagged Can't read, at the head of Waiting for a condition (§5.3).
    public var cantRead: Bool { state == "UNKNOWN" }
}

/// A task that starts when its condition holds, as the Scheduled page lists it (shared `ScheduleWaitingTask`).
public struct ScheduleWaitingTask: Codable, Equatable, Hashable, Sendable, Identifiable {
    public let id: String
    public let title: String
    public let workspaceId: String
    public let workspaceName: String?
    public let condition: ScheduleConditionReading

    public init(id: String, title: String, workspaceId: String, workspaceName: String? = nil,
                condition: ScheduleConditionReading) {
        self.id = id
        self.title = title
        self.workspaceId = workspaceId
        self.workspaceName = workspaceName
        self.condition = condition
    }
}

/// What the owner allowed: where it runs, what it may do, how often and how long.
public struct ScheduleEnvelope: Codable, Equatable, Hashable, Sendable {
    public let workspaceId: String
    public let accessLevel: String
    public let runsPerWeek: Int
    public let runLimitMinutes: Int
    /// A WHEN rule's approved probe command, as its sha256; nil for a timed schedule.
    public var commandHash: String? = nil

    public init(workspaceId: String, accessLevel: String, runsPerWeek: Int, runLimitMinutes: Int,
                commandHash: String? = nil) {
        self.workspaceId = workspaceId
        self.accessLevel = accessLevel
        self.runsPerWeek = runsPerWeek
        self.runLimitMinutes = runLimitMinutes
        self.commandHash = commandHash
    }

    public init?(json: JSONValue?) {
        guard let json, let data = try? JSONEncoder().encode(json),
              let envelope = try? JSONDecoder().decode(ScheduleEnvelope.self, from: data) else { return nil }
        self = envelope
    }
}

/// Where a run's session stands in the history (§7.4).
public struct ScheduleRunSessionRef: Codable, Equatable, Hashable, Sendable {
    public let id: String
    public let state: String
}

/// One run: `GET /schedules/:id/runs`, a row's `lastRun`, the inspector's `recentRuns`.
public struct ScheduleRunView: Codable, Equatable, Hashable, Sendable, Identifiable {
    public let id: String
    public let scheduleId: String
    public let scheduleRevision: Int
    public let plannedAt: String
    public let trigger: String
    public let state: String
    public let attempt: Int
    public let startedAt: String?
    public let endedAt: String?
    public let sessionId: String?
    public let key: String?
    public let summary: String?
    public let failureReason: String?
    public let heldReason: String?
    /// S2d: the server's own line for why the run did not happen; preferred over the client's words.
    public let reasonText: String?
    public let session: ScheduleRunSessionRef?
    /// The list's timeline runs only (`ScheduleTimelineRun`): whether its finding was new, and whether the owner
    /// was told. Nil from the other reads, where `ScheduleDisplay.runFindingFacts` works it out from findings.
    public var newFinding: Bool? = nil
    public var notified: Bool? = nil

    public init(id: String, scheduleId: String, scheduleRevision: Int = 1, plannedAt: String,
                trigger: String = "SCHEDULED", state: String, attempt: Int = 1, startedAt: String? = nil,
                endedAt: String? = nil, sessionId: String? = nil, key: String? = nil, summary: String? = nil,
                failureReason: String? = nil, heldReason: String? = nil, reasonText: String? = nil,
                session: ScheduleRunSessionRef? = nil) {
        self.id = id
        self.scheduleId = scheduleId
        self.scheduleRevision = scheduleRevision
        self.plannedAt = plannedAt
        self.trigger = trigger
        self.state = state
        self.attempt = attempt
        self.startedAt = startedAt
        self.endedAt = endedAt
        self.sessionId = sessionId
        self.key = key
        self.summary = summary
        self.failureReason = failureReason
        self.heldReason = heldReason
        self.reasonText = reasonText
        self.session = session
    }

    private enum CodingKeys: String, CodingKey {
        case id, scheduleId, scheduleRevision, plannedAt, trigger, state, attempt, startedAt, endedAt, sessionId
        case key, summary, failureReason, heldReason, reasonText, session, newFinding, notified
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        scheduleId = try c.decode(String.self, forKey: .scheduleId)
        scheduleRevision = (try? c.decode(Int.self, forKey: .scheduleRevision)) ?? 1
        plannedAt = try c.decode(String.self, forKey: .plannedAt)
        trigger = (try? c.decode(String.self, forKey: .trigger)) ?? "SCHEDULED"
        state = try c.decode(String.self, forKey: .state)
        attempt = (try? c.decode(Int.self, forKey: .attempt)) ?? 1
        startedAt = try? c.decodeIfPresent(String.self, forKey: .startedAt)
        endedAt = try? c.decodeIfPresent(String.self, forKey: .endedAt)
        sessionId = try? c.decodeIfPresent(String.self, forKey: .sessionId)
        key = try? c.decodeIfPresent(String.self, forKey: .key)
        summary = try? c.decodeIfPresent(String.self, forKey: .summary)
        failureReason = try? c.decodeIfPresent(String.self, forKey: .failureReason)
        heldReason = try? c.decodeIfPresent(String.self, forKey: .heldReason)
        reasonText = try? c.decodeIfPresent(String.self, forKey: .reasonText)
        session = try? c.decodeIfPresent(ScheduleRunSessionRef.self, forKey: .session)
        newFinding = try? c.decodeIfPresent(Bool.self, forKey: .newFinding)
        notified = try? c.decodeIfPresent(Bool.self, forKey: .notified)
    }
}

/// A schedule as the list and the inspector read it; the list's rows carry `lastRun` too.
public struct ScheduleView: Codable, Equatable, Hashable, Sendable, Identifiable {
    public let id: String
    public let title: String
    public let intent: String
    public let prompt: String
    public let rule: ScheduleRule
    public let timezone: String
    public let workspaceId: String
    public let workspaceName: String?
    public let agentId: String?
    /// S5: the agent's name, so a hold can say 'the agent "auditor" is disabled'; nil when it names none or is gone.
    public var agentName: String? = nil
    /// S5: the engine its runs start on ("codex"), when the conversation it came from still names one.
    public var engine: String? = nil
    public let accessLevel: String
    public let runLimitMinutes: Int
    public let runsPerWeek: Int
    public let envelope: ScheduleEnvelope
    public let state: String
    public let heldReason: String?
    public let endedReason: String?
    public let note: String?
    public let revision: Int
    public let startAt: String?
    public let endAt: String?
    /// The planned end by count of started runs (§8.5); nil for none or from a server before it.
    public let maxRuns: Int?
    /// maxRuns minus the runs started, at least 0; nil without maxRuns.
    public let runsLeft: Int?
    public let nextDueAt: String?
    public let consecutiveFailures: Int
    public let createdFromSessionId: String?
    public let createdAt: String
    public let endedAt: String?
    /// The list's rows only.
    public let lastRun: ScheduleRunView?
    /// The list's rows only: when a PAUSED schedule was paused.
    public var pausedAt: String? = nil
    /// A WHEN rule's condition and its newest reading; nil for a timed schedule.
    public var condition: ScheduleConditionReading? = nil

    public init(id: String, title: String, intent: String = "", prompt: String = "", rule: ScheduleRule,
                timezone: String, workspaceId: String, workspaceName: String? = nil, agentId: String? = nil,
                accessLevel: String = "CHECK_ONLY", runLimitMinutes: Int = 30, runsPerWeek: Int = 7,
                envelope: ScheduleEnvelope? = nil, state: String = "ACTIVE", heldReason: String? = nil,
                endedReason: String? = nil, note: String? = nil, revision: Int = 1, startAt: String? = nil,
                endAt: String? = nil, maxRuns: Int? = nil, runsLeft: Int? = nil, nextDueAt: String? = nil,
                consecutiveFailures: Int = 0,
                createdFromSessionId: String? = nil, createdAt: String = "2026-11-10T00:00:00.000Z",
                endedAt: String? = nil, lastRun: ScheduleRunView? = nil) {
        self.id = id
        self.title = title
        self.intent = intent
        self.prompt = prompt
        self.rule = rule
        self.timezone = timezone
        self.workspaceId = workspaceId
        self.workspaceName = workspaceName
        self.agentId = agentId
        self.accessLevel = accessLevel
        self.runLimitMinutes = runLimitMinutes
        self.runsPerWeek = runsPerWeek
        self.envelope = envelope ?? ScheduleEnvelope(workspaceId: workspaceId, accessLevel: accessLevel,
                                                     runsPerWeek: runsPerWeek, runLimitMinutes: runLimitMinutes)
        self.state = state
        self.heldReason = heldReason
        self.endedReason = endedReason
        self.note = note
        self.revision = revision
        self.startAt = startAt
        self.endAt = endAt
        self.maxRuns = maxRuns
        self.runsLeft = runsLeft
        self.nextDueAt = nextDueAt
        self.consecutiveFailures = consecutiveFailures
        self.createdFromSessionId = createdFromSessionId
        self.createdAt = createdAt
        self.endedAt = endedAt
        self.lastRun = lastRun
    }

    private enum CodingKeys: String, CodingKey {
        case id, title, intent, prompt, rule, timezone, workspaceId, workspaceName, agentId, agentName, engine, accessLevel
        case runLimitMinutes, runsPerWeek, envelope, state, heldReason, endedReason, note, revision, startAt, endAt
        case maxRuns, runsLeft, nextDueAt, consecutiveFailures, createdFromSessionId, createdAt, endedAt, lastRun, pausedAt, condition
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        title = try c.decode(String.self, forKey: .title)
        intent = (try? c.decode(String.self, forKey: .intent)) ?? ""
        prompt = (try? c.decode(String.self, forKey: .prompt)) ?? ""
        rule = try c.decode(ScheduleRule.self, forKey: .rule)
        timezone = (try? c.decode(String.self, forKey: .timezone)) ?? "UTC"
        workspaceId = try c.decode(String.self, forKey: .workspaceId)
        workspaceName = try? c.decodeIfPresent(String.self, forKey: .workspaceName)
        agentId = try? c.decodeIfPresent(String.self, forKey: .agentId)
        agentName = try? c.decodeIfPresent(String.self, forKey: .agentName)
        engine = try? c.decodeIfPresent(String.self, forKey: .engine)
        accessLevel = (try? c.decode(String.self, forKey: .accessLevel)) ?? "CHECK_ONLY"
        runLimitMinutes = (try? c.decode(Int.self, forKey: .runLimitMinutes)) ?? 30
        runsPerWeek = (try? c.decode(Int.self, forKey: .runsPerWeek)) ?? 7
        envelope = (try? c.decode(ScheduleEnvelope.self, forKey: .envelope))
            ?? ScheduleEnvelope(workspaceId: workspaceId, accessLevel: accessLevel, runsPerWeek: runsPerWeek,
                                runLimitMinutes: runLimitMinutes)
        state = (try? c.decode(String.self, forKey: .state)) ?? "ACTIVE"
        heldReason = try? c.decodeIfPresent(String.self, forKey: .heldReason)
        endedReason = try? c.decodeIfPresent(String.self, forKey: .endedReason)
        note = try? c.decodeIfPresent(String.self, forKey: .note)
        revision = (try? c.decode(Int.self, forKey: .revision)) ?? 1
        startAt = try? c.decodeIfPresent(String.self, forKey: .startAt)
        endAt = try? c.decodeIfPresent(String.self, forKey: .endAt)
        maxRuns = try? c.decodeIfPresent(Int.self, forKey: .maxRuns)
        runsLeft = try? c.decodeIfPresent(Int.self, forKey: .runsLeft)
        nextDueAt = try? c.decodeIfPresent(String.self, forKey: .nextDueAt)
        consecutiveFailures = (try? c.decode(Int.self, forKey: .consecutiveFailures)) ?? 0
        createdFromSessionId = try? c.decodeIfPresent(String.self, forKey: .createdFromSessionId)
        createdAt = (try? c.decode(String.self, forKey: .createdAt)) ?? ""
        endedAt = try? c.decodeIfPresent(String.self, forKey: .endedAt)
        lastRun = try? c.decodeIfPresent(ScheduleRunView.self, forKey: .lastRun)
        pausedAt = try? c.decodeIfPresent(String.self, forKey: .pausedAt)
        condition = try? c.decodeIfPresent(ScheduleConditionReading.self, forKey: .condition)
    }
}

/// `GET /schedules`. A row this build cannot read is dropped, not the list.
public struct ScheduleListResponse: Decodable, Sendable {
    public let schedules: [ScheduleView]
    /// The runs of the page's window, for every listed schedule: each run under way, and the ended runs planned in
    /// the last 24 hours. Nil from a server before W2, where the page reads each schedule's detail instead.
    public let runs: [ScheduleRunView]?
    /// The OPEN tasks waiting for their startWhen condition (condition-triggers board ④); nil from a server before
    /// conditions.
    public let waitingTasks: [ScheduleWaitingTask]?
    private enum CodingKeys: String, CodingKey { case schedules, runs, waitingTasks }
    public init(schedules: [ScheduleView], runs: [ScheduleRunView]? = nil, waitingTasks: [ScheduleWaitingTask]? = nil) {
        self.schedules = schedules
        self.runs = runs
        self.waitingTasks = waitingTasks
    }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        schedules = try c.decode([ScheduleLenient<ScheduleView>].self, forKey: .schedules).compactMap(\.value)
        runs = (try? c.decodeIfPresent([ScheduleLenient<ScheduleRunView>].self, forKey: .runs))?.map { $0.compactMap(\.value) }
        waitingTasks = (try? c.decodeIfPresent([ScheduleLenient<ScheduleWaitingTask>].self, forKey: .waitingTasks))?
            .map { $0.compactMap(\.value) }
    }
}

/// One element read on its own, so a bad one is nil instead of the whole array's failure.
struct ScheduleLenient<T: Decodable>: Decodable {
    let value: T?
    init(from decoder: Decoder) throws { value = try? T(from: decoder) }
}

public struct ScheduleFindingView: Codable, Equatable, Hashable, Sendable {
    public let key: String
    public let summary: String?
    public let firstRunId: String?
    public let lastSeenRunId: String?
    public let notifiedAt: String?
    public let baseline: Bool?
    public let createdAt: String?
}

public struct ScheduleUsageView: Codable, Equatable, Hashable, Sendable {
    public let since: String?
    public let runs: Int
    public let minutes: Int
    public let costUsd: Double?
    public init(since: String? = nil, runs: Int, minutes: Int, costUsd: Double? = nil) {
        self.since = since
        self.runs = runs
        self.minutes = minutes
        self.costUsd = costUsd
    }
}

public struct ScheduleUndoDoor: Codable, Equatable, Hashable, Sendable {
    public let path: String
    public let revision: Int

    private enum CodingKeys: String, CodingKey { case path, body }
    private struct Body: Codable { let revision: Int }

    public init(path: String, revision: Int) {
        self.path = path
        self.revision = revision
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        path = try c.decode(String.self, forKey: .path)
        revision = try c.decode(Body.self, forKey: .body).revision
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(path, forKey: .path)
        try c.encode(Body(revision: revision), forKey: .body)
    }
}

/// A change's record: in the inspector's history and as the change line in the session that made it.
public struct ScheduleChangeRecord: Codable, Equatable, Sendable, Identifiable {
    public let scheduleId: String
    public let title: String
    public let revision: Int
    public let changedBy: String
    public let sessionId: String?
    public let before: [String: JSONValue]?
    public let after: [String: JSONValue]
    public let undoOfRevision: Int?
    public let undoneByRevision: Int?
    /// The person's words that asked for it, when it came from the schedule's change conversation (§8.2).
    public let askedText: String?
    public let createdAt: String
    public let undo: ScheduleUndoDoor?

    public var id: String { "\(scheduleId)@\(revision)" }

    public init(scheduleId: String, title: String, revision: Int, changedBy: String, sessionId: String? = nil,
                before: [String: JSONValue]?, after: [String: JSONValue], undoOfRevision: Int? = nil,
                undoneByRevision: Int? = nil, askedText: String? = nil,
                createdAt: String = "2026-11-14T10:00:00.000Z",
                undo: ScheduleUndoDoor? = nil) {
        self.scheduleId = scheduleId
        self.title = title
        self.revision = revision
        self.changedBy = changedBy
        self.sessionId = sessionId
        self.before = before
        self.after = after
        self.undoOfRevision = undoOfRevision
        self.undoneByRevision = undoneByRevision
        self.askedText = askedText
        self.createdAt = createdAt
        self.undo = undo
    }

    private enum CodingKeys: String, CodingKey {
        case scheduleId, title, revision, changedBy, sessionId, before, after, undoOfRevision, undoneByRevision
        case askedText, createdAt, undo
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        scheduleId = try c.decode(String.self, forKey: .scheduleId)
        title = (try? c.decode(String.self, forKey: .title)) ?? ""
        revision = try c.decode(Int.self, forKey: .revision)
        changedBy = (try? c.decode(String.self, forKey: .changedBy)) ?? "USER"
        sessionId = try? c.decodeIfPresent(String.self, forKey: .sessionId)
        before = try? c.decodeIfPresent([String: JSONValue].self, forKey: .before)
        after = (try? c.decode([String: JSONValue].self, forKey: .after)) ?? [:]
        undoOfRevision = try? c.decodeIfPresent(Int.self, forKey: .undoOfRevision)
        undoneByRevision = try? c.decodeIfPresent(Int.self, forKey: .undoneByRevision)
        askedText = try? c.decodeIfPresent(String.self, forKey: .askedText)
        createdAt = (try? c.decode(String.self, forKey: .createdAt)) ?? ""
        undo = try? c.decodeIfPresent(ScheduleUndoDoor.self, forKey: .undo)
    }
}

/// Orbit's opening of a change conversation (§8.2, board 03-change): the schedule as it was when the
/// conversation was opened, drawn by every client from `ScheduleCopy.ChangeConversation`. Kept on the session,
/// so it still reads as the start of the conversation after the schedule has changed.
public struct ScheduleChangeOpening: Codable, Equatable, Hashable, Sendable {
    public let scheduleId: String
    public let title: String
    public let revision: Int
    /// The read-back ("What it does").
    public let does: String
    /// "Every day at 09:00 · Asia/Shanghai".
    public let when: String
    public let runsIn: String
    public let may: String
    public let costs: String

    public init(scheduleId: String, title: String, revision: Int = 1, does: String, when: String,
                runsIn: String, may: String, costs: String) {
        self.scheduleId = scheduleId
        self.title = title
        self.revision = revision
        self.does = does
        self.when = when
        self.runsIn = runsIn
        self.may = may
        self.costs = costs
    }

    private enum CodingKeys: String, CodingKey { case scheduleId, title, revision, does, when, runsIn, may, costs }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        scheduleId = try c.decode(String.self, forKey: .scheduleId)
        title = (try? c.decode(String.self, forKey: .title)) ?? ""
        revision = (try? c.decode(Int.self, forKey: .revision)) ?? 1
        does = (try? c.decode(String.self, forKey: .does)) ?? ""
        when = (try? c.decode(String.self, forKey: .when)) ?? ""
        runsIn = (try? c.decode(String.self, forKey: .runsIn)) ?? ""
        may = (try? c.decode(String.self, forKey: .may)) ?? ""
        costs = (try? c.decode(String.self, forKey: .costs)) ?? ""
    }
}

/// `GET /schedules/:id/change`: the schedule's open change conversation if it has one, and the opening a new one
/// would start with.
public struct ScheduleChangeConversationResponse: Decodable, Sendable, Equatable {
    public let sessionId: String?
    public let opening: ScheduleChangeOpening

    public init(sessionId: String?, opening: ScheduleChangeOpening) {
        self.sessionId = sessionId
        self.opening = opening
    }

    private enum CodingKeys: String, CodingKey { case sessionId, opening }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        sessionId = try? c.decodeIfPresent(String.self, forKey: .sessionId)
        opening = try c.decode(ScheduleChangeOpening.self, forKey: .opening)
    }
}

/// `POST /schedules/:id/change {text}`: the person's first words.
public struct ScheduleChangeBody: Encodable, Sendable {
    public let text: String
    public init(text: String) { self.text = text }
}

/// Its answer: the change conversation, and whether this press opened it (`false` when another device opened one
/// meanwhile and the words were said there).
public struct ScheduleChangeAnswer: Decodable, Sendable, Equatable {
    public let sessionId: String
    public let created: Bool

    public init(sessionId: String, created: Bool) {
        self.sessionId = sessionId
        self.created = created
    }

    private enum CodingKeys: String, CodingKey { case sessionId, created }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        sessionId = try c.decode(String.self, forKey: .sessionId)
        created = (try? c.decode(Bool.self, forKey: .created)) ?? false
    }
}

public struct ScheduleCardDecision: Codable, Equatable, Hashable, Sendable {
    public let allow: String
    public let decline: String
}

/// One of a card's three envelope lines — Runs in, May, Costs — as the server words and keys it.
public struct ScheduleEnvelopeLines: Codable, Equatable, Hashable, Sendable {
    public struct RunsIn: Codable, Equatable, Hashable, Sendable {
        public let workspaceId: String
        public let workspaceName: String?
        public let engine: String?
        public init(workspaceId: String, workspaceName: String?, engine: String?) {
            self.workspaceId = workspaceId
            self.workspaceName = workspaceName
            self.engine = engine
        }
    }
    public struct May: Codable, Equatable, Hashable, Sendable {
        public let accessLevel: String
        public init(accessLevel: String) { self.accessLevel = accessLevel }
    }
    public struct Costs: Codable, Equatable, Hashable, Sendable {
        public let runsPerWeek: Int
        public let runLimitMinutes: Int
        public init(runsPerWeek: Int, runLimitMinutes: Int) {
            self.runsPerWeek = runsPerWeek
            self.runLimitMinutes = runLimitMinutes
        }
    }
    public let runsIn: RunsIn
    public let may: May
    public let costs: Costs

    public init(runsIn: RunsIn, may: May, costs: Costs) {
        self.runsIn = runsIn
        self.may = may
        self.costs = costs
    }

    /// The envelope these lines describe, for the display rules.
    public var envelope: ScheduleEnvelope {
        ScheduleEnvelope(workspaceId: runsIn.workspaceId, accessLevel: may.accessLevel,
                         runsPerWeek: costs.runsPerWeek, runLimitMinutes: costs.runLimitMinutes)
    }
}

/// A WHEN rule's lines on the create card, as the server words them (shared `ScheduleWhenLines`, board ③).
public struct ScheduleWhenLines: Codable, Equatable, Hashable, Sendable {
    /// "Raw used above 90% for 10 min".
    public let text: String
    /// "Fires again only after it drops below 85%. Checked every 5 min on workstation-gpu, no model."
    public let detail: String
    /// The probe command, verbatim: what Create approves.
    public let command: String
    /// "And again every 2 hours while it stays that way."; nil with no repeat.
    public let `repeat`: String?
    /// "Keeps this cloud workspace awake while it waits."; nil off Orbit Cloud.
    public let awake: String?

    public init(text: String, detail: String, command: String, repeat: String? = nil, awake: String? = nil) {
        self.text = text
        self.detail = detail
        self.command = command
        self.repeat = `repeat`
        self.awake = awake
    }

    private enum CodingKeys: String, CodingKey { case text, detail, command, `repeat`, awake }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        text = try c.decode(String.self, forKey: .text)
        detail = (try? c.decode(String.self, forKey: .detail)) ?? ""
        command = (try? c.decode(String.self, forKey: .command)) ?? ""
        `repeat` = try? c.decodeIfPresent(String.self, forKey: .repeat)
        awake = try? c.decodeIfPresent(String.self, forKey: .awake)
    }
}

/// A create card's When.
public struct ScheduleCardWhen: Codable, Equatable, Hashable, Sendable {
    public let rule: ScheduleRule
    public let timezone: String?
    public let firstRunAt: String?
    /// A WHEN rule's lines: the condition, the re-arm and how it is checked, and the command; nil for a timed rule.
    public var condition: ScheduleWhenLines? = nil
    public init(rule: ScheduleRule, timezone: String?, firstRunAt: String?, condition: ScheduleWhenLines? = nil) {
        self.rule = rule
        self.timezone = timezone
        self.firstRunAt = firstRunAt
        self.condition = condition
    }
}

/// A create card's Today: what the agent found when it did the work once before asking (D2).
public struct ScheduleCardToday: Codable, Equatable, Hashable, Sendable {
    public let key: String
    public let summary: String?
    public init(key: String, summary: String?) {
        self.key = key
        self.summary = summary
    }
}

public struct ScheduleCardEnvelope: Codable, Equatable, Hashable, Sendable {
    public let widens: [String]
    public let now: ScheduleEnvelopeLines?
    public let asked: ScheduleEnvelopeLines
    public init(widens: [String], now: ScheduleEnvelopeLines?, asked: ScheduleEnvelopeLines) {
        self.widens = widens
        self.now = now
        self.asked = asked
    }
}

/// A card the owner answers: the create card (§8.1, `kind` CREATE) or the envelope card (§4, `kind` UPDATE).
/// One shape, because the server sends one: a create card fills When / Runs in / May / Costs / Today, an
/// envelope card fills `envelope` and `proposed`.
public struct ScheduleCard: Codable, Equatable, Sendable, Identifiable {
    public let id: String
    public let kind: String
    public let state: String
    public let askedBy: String?
    public let askedBySessionId: String?
    public let scheduleId: String?
    public let createdAt: String
    public let decidedAt: String?
    public let resultRevision: Int?
    public let decision: ScheduleCardDecision?
    public let title: String?
    public let readBack: String?
    public let intent: String?
    public let when: ScheduleCardWhen?
    public let runsIn: ScheduleEnvelopeLines.RunsIn?
    public let may: ScheduleEnvelopeLines.May?
    public let costs: ScheduleEnvelopeLines.Costs?
    public let today: ScheduleCardToday?
    /// A create card's last line as the server words it (S5's `scheduleCreateNotice`: "You'll hear about new
    /// versions and failures only."); nil from an envelope card.
    public var notice: String? = nil
    public let proposed: [String: JSONValue]?
    public let envelope: ScheduleCardEnvelope?

    public var isCreate: Bool { kind == "CREATE" }
    public var isPending: Bool { state == "PENDING" }

    public init(id: String, kind: String, state: String = "PENDING", askedBy: String? = "SESSION",
                askedBySessionId: String? = nil, scheduleId: String? = nil,
                createdAt: String = "2026-11-14T10:00:00.000Z", decidedAt: String? = nil,
                resultRevision: Int? = nil, decision: ScheduleCardDecision? = nil, title: String? = nil,
                readBack: String? = nil, intent: String? = nil, when: ScheduleCardWhen? = nil,
                runsIn: ScheduleEnvelopeLines.RunsIn? = nil, may: ScheduleEnvelopeLines.May? = nil,
                costs: ScheduleEnvelopeLines.Costs? = nil, today: ScheduleCardToday? = nil,
                proposed: [String: JSONValue]? = nil, envelope: ScheduleCardEnvelope? = nil) {
        self.id = id
        self.kind = kind
        self.state = state
        self.askedBy = askedBy
        self.askedBySessionId = askedBySessionId
        self.scheduleId = scheduleId
        self.createdAt = createdAt
        self.decidedAt = decidedAt
        self.resultRevision = resultRevision
        self.decision = decision
        self.title = title
        self.readBack = readBack
        self.intent = intent
        self.when = when
        self.runsIn = runsIn
        self.may = may
        self.costs = costs
        self.today = today
        self.proposed = proposed
        self.envelope = envelope
    }

    private enum CodingKeys: String, CodingKey {
        case id, kind, state, askedBy, askedBySessionId, scheduleId, createdAt, decidedAt, resultRevision
        case decision, title, readBack, intent, when, runsIn, may, costs, today, notice, proposed, envelope
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        kind = try c.decode(String.self, forKey: .kind)
        state = (try? c.decode(String.self, forKey: .state)) ?? "PENDING"
        askedBy = try? c.decodeIfPresent(String.self, forKey: .askedBy)
        askedBySessionId = try? c.decodeIfPresent(String.self, forKey: .askedBySessionId)
        scheduleId = try? c.decodeIfPresent(String.self, forKey: .scheduleId)
        createdAt = (try? c.decode(String.self, forKey: .createdAt)) ?? ""
        decidedAt = try? c.decodeIfPresent(String.self, forKey: .decidedAt)
        resultRevision = try? c.decodeIfPresent(Int.self, forKey: .resultRevision)
        decision = try? c.decodeIfPresent(ScheduleCardDecision.self, forKey: .decision)
        title = try? c.decodeIfPresent(String.self, forKey: .title)
        readBack = try? c.decodeIfPresent(String.self, forKey: .readBack)
        intent = try? c.decodeIfPresent(String.self, forKey: .intent)
        when = try? c.decodeIfPresent(ScheduleCardWhen.self, forKey: .when)
        runsIn = try? c.decodeIfPresent(ScheduleEnvelopeLines.RunsIn.self, forKey: .runsIn)
        may = try? c.decodeIfPresent(ScheduleEnvelopeLines.May.self, forKey: .may)
        costs = try? c.decodeIfPresent(ScheduleEnvelopeLines.Costs.self, forKey: .costs)
        today = try? c.decodeIfPresent(ScheduleCardToday.self, forKey: .today)
        notice = try? c.decodeIfPresent(String.self, forKey: .notice)
        proposed = try? c.decodeIfPresent([String: JSONValue].self, forKey: .proposed)
        envelope = try? c.decodeIfPresent(ScheduleCardEnvelope.self, forKey: .envelope)
    }
}

/// `GET /schedules/:id`: the inspector.
public struct ScheduleDetailResponse: Decodable, Sendable, Equatable {
    public let schedule: ScheduleView
    public let readBack: String?
    public let lastRun: ScheduleRunView?
    public let recentRuns: [ScheduleRunView]
    public let findings: [ScheduleFindingView]
    public let usage: ScheduleUsageView?
    public let history: [ScheduleChangeRecord]
    public let pendingCards: [ScheduleCard]

    public init(schedule: ScheduleView, readBack: String? = nil, lastRun: ScheduleRunView? = nil,
                recentRuns: [ScheduleRunView] = [], findings: [ScheduleFindingView] = [],
                usage: ScheduleUsageView? = nil, history: [ScheduleChangeRecord] = [],
                pendingCards: [ScheduleCard] = []) {
        self.schedule = schedule
        self.readBack = readBack
        self.lastRun = lastRun
        self.recentRuns = recentRuns
        self.findings = findings
        self.usage = usage
        self.history = history
        self.pendingCards = pendingCards
    }

    private enum CodingKeys: String, CodingKey {
        case schedule, readBack, lastRun, recentRuns, findings, usage, history, pendingCards
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        schedule = try c.decode(ScheduleView.self, forKey: .schedule)
        readBack = try? c.decodeIfPresent(String.self, forKey: .readBack)
        lastRun = try? c.decodeIfPresent(ScheduleRunView.self, forKey: .lastRun)
        recentRuns = ((try? c.decode([ScheduleLenient<ScheduleRunView>].self, forKey: .recentRuns)) ?? []).compactMap(\.value)
        findings = ((try? c.decode([ScheduleLenient<ScheduleFindingView>].self, forKey: .findings)) ?? []).compactMap(\.value)
        usage = try? c.decodeIfPresent(ScheduleUsageView.self, forKey: .usage)
        history = ((try? c.decode([ScheduleLenient<ScheduleChangeRecord>].self, forKey: .history)) ?? []).compactMap(\.value)
        pendingCards = ((try? c.decode([ScheduleLenient<ScheduleCard>].self, forKey: .pendingCards)) ?? []).compactMap(\.value)
    }
}

public struct ScheduleRunsResponse: Decodable, Sendable {
    public let runs: [ScheduleRunView]
    private enum CodingKeys: String, CodingKey { case runs }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        runs = try c.decode([ScheduleLenient<ScheduleRunView>].self, forKey: .runs).compactMap(\.value)
    }
}

public struct ScheduleRunAnswer: Decodable, Sendable {
    public let run: ScheduleRunView
}

/// `POST /schedules/:id/{pause,resume}`, `DELETE /schedules/:id`.
public struct ScheduleControlAnswer: Decodable, Sendable {
    public let schedule: ScheduleView
    public let record: ScheduleChangeRecord?
}

/// `POST /schedules/:id/undo` and `…/rename`: APPLIED, UNCHANGED or PENDING (a card, when undoing would widen).
public struct ScheduleUpdateAnswer: Decodable, Sendable {
    public let outcome: String
    public let schedule: ScheduleView?
    public let card: ScheduleCard?
}

public struct ScheduleUndoBody: Encodable, Sendable {
    public let revision: Int
    public init(revision: Int) { self.revision = revision }
}

public struct ScheduleRenameBody: Encodable, Sendable {
    public let title: String
    public init(title: String) { self.title = title }
}

public struct ScheduleRequestsResponse: Decodable, Sendable {
    public let requests: [ScheduleCard]
    private enum CodingKeys: String, CodingKey { case requests }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        requests = try c.decode([ScheduleLenient<ScheduleCard>].self, forKey: .requests).compactMap(\.value)
    }
}

public struct ScheduleDraftsResponse: Decodable, Sendable {
    public let drafts: [ScheduleCard]
    private enum CodingKeys: String, CodingKey { case drafts }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        drafts = try c.decode([ScheduleLenient<ScheduleCard>].self, forKey: .drafts).compactMap(\.value)
    }
}

/// `POST /schedules/drafts`: the quick-add line opens an ordinary session with the sentence.
public struct ScheduleDraftBody: Encodable, Sendable {
    public let workspaceId: String
    public let text: String
    public init(workspaceId: String, text: String) {
        self.workspaceId = workspaceId
        self.text = text
    }
}

public struct ScheduleDraftAnswer: Decodable, Sendable {
    public let sessionId: String
}

/// `GET /sessions/:id/schedule-cards`: the cards a conversation asked and the changes it made.
public struct SessionScheduleCardsResponse: Decodable, Sendable, Equatable {
    /// A scheduled run's session: the run it serves, however old; nil for any other session.
    public let run: ScheduleRunView?
    public let cards: [ScheduleCard]
    public let records: [ScheduleChangeRecord]
    /// A schedule's change conversation (§8.2): Orbit's opening, as the schedule was when it was opened, for its
    /// strip and its first message. Nil on every other session (and on servers before it).
    public let change: ScheduleChangeOpening?

    public init(run: ScheduleRunView? = nil, cards: [ScheduleCard], records: [ScheduleChangeRecord],
                change: ScheduleChangeOpening? = nil) {
        self.run = run
        self.cards = cards
        self.records = records
        self.change = change
    }

    private enum CodingKeys: String, CodingKey { case run, cards, records, change }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        run = try? c.decodeIfPresent(ScheduleRunView.self, forKey: .run)
        cards = ((try? c.decode([ScheduleLenient<ScheduleCard>].self, forKey: .cards)) ?? []).compactMap(\.value)
        records = ((try? c.decode([ScheduleLenient<ScheduleChangeRecord>].self, forKey: .records)) ?? []).compactMap(\.value)
        change = try? c.decodeIfPresent(ScheduleChangeOpening.self, forKey: .change)
    }
}

/// `POST /schedule-requests/:id/allow`: a zone only for a create card that names none (the device's).
public struct ScheduleAllowBody: Encodable, Sendable {
    public let timezone: String?
    public init(timezone: String?) { self.timezone = timezone }
}

public struct ScheduleDecisionAnswer: Decodable, Sendable {
    public let outcome: String
    public let card: ScheduleCard?
    public let schedule: ScheduleView?
}

/// What a press on a card came back with.
public enum ScheduleDecisionOutcome: Equatable, Sendable {
    case decided(ScheduleCard?)
    /// 409 SCHEDULE_REQUEST_STALE: Allow withdrew the card. Shown, never retried.
    case stale(message: String)
}

/// A Waiting on you item of one of the four kinds no session can file (schedule-attention.ts), read off the
/// owner-request list beside the kinds `OwnerRequest` reads.
public struct ScheduleWaitingItem: Decodable, Equatable, Hashable, Sendable, Identifiable {
    public let id: String
    /// SCHEDULE_FAILED, SCHEDULE_HELD, SCHEDULE_APPROVAL or SCHEDULE_WIDEN.
    public let kind: String
    public let state: String
    public let title: String
    public let why: String
    public let scheduleId: String
    public let scheduleRunId: String?
    public let approvalId: String?
    public let scheduleChangeRequestId: String?
    public let workspaceId: String?
    public let askedBySessionId: String?
    public let expiresAt: String?
    public let createdAt: String

    public static let kinds: [String] = ["SCHEDULE_FAILED", "SCHEDULE_HELD", "SCHEDULE_APPROVAL", "SCHEDULE_WIDEN"]

    public init(id: String, kind: String, state: String = "PENDING", title: String = "", why: String = "",
                scheduleId: String, scheduleRunId: String? = nil, approvalId: String? = nil,
                scheduleChangeRequestId: String? = nil, workspaceId: String? = nil,
                askedBySessionId: String? = nil, expiresAt: String? = nil,
                createdAt: String = "2026-11-14T02:41:00.000Z") {
        self.id = id
        self.kind = kind
        self.state = state
        self.title = title
        self.why = why
        self.scheduleId = scheduleId
        self.scheduleRunId = scheduleRunId
        self.approvalId = approvalId
        self.scheduleChangeRequestId = scheduleChangeRequestId
        self.workspaceId = workspaceId
        self.askedBySessionId = askedBySessionId
        self.expiresAt = expiresAt
        self.createdAt = createdAt
    }

    private enum CodingKeys: String, CodingKey {
        case id, kind, state, title, why, scheduleId, scheduleRunId, approvalId, scheduleChangeRequestId
        case workspaceId, askedBySessionId, expiresAt, createdAt
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let kind = try c.decode(String.self, forKey: .kind)
        guard Self.kinds.contains(kind) else {
            throw DecodingError.dataCorruptedError(forKey: .kind, in: c, debugDescription: "not a schedule item")
        }
        self.kind = kind
        id = try c.decode(String.self, forKey: .id)
        state = try c.decode(String.self, forKey: .state)
        title = (try? c.decode(String.self, forKey: .title)) ?? ""
        why = (try? c.decode(String.self, forKey: .why)) ?? ""
        scheduleId = try c.decode(String.self, forKey: .scheduleId)
        scheduleRunId = try? c.decodeIfPresent(String.self, forKey: .scheduleRunId)
        approvalId = try? c.decodeIfPresent(String.self, forKey: .approvalId)
        scheduleChangeRequestId = try? c.decodeIfPresent(String.self, forKey: .scheduleChangeRequestId)
        workspaceId = try? c.decodeIfPresent(String.self, forKey: .workspaceId)
        askedBySessionId = try? c.decodeIfPresent(String.self, forKey: .askedBySessionId)
        expiresAt = try? c.decodeIfPresent(String.self, forKey: .expiresAt)
        createdAt = (try? c.decode(String.self, forKey: .createdAt)) ?? ""
    }
}
