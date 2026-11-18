import Foundation

// Conditions (docs/condition-triggers-design.md): work that starts when something outside Orbit becomes true. The
// shapes the doors answer with, as `src/shared/src/condition.ts` types them, read leniently: a state or kind a newer
// server adds costs one word, never the read. The rules over them are `ConditionDisplay`.

/// One reading the runner reported.
public struct ConditionSampleView: Codable, Equatable, Hashable, Sendable {
    public let at: String
    /// VALUE, EXIT, TIMEOUT or ERROR.
    public let outcome: String
    public let value: Double?
    public let exitCode: Int?

    public init(at: String, outcome: String = "VALUE", value: Double? = nil, exitCode: Int? = nil) {
        self.at = at
        self.outcome = outcome
        self.value = value
        self.exitCode = exitCode
    }

    private enum CodingKeys: String, CodingKey { case at, outcome, value, exitCode }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        at = try c.decode(String.self, forKey: .at)
        outcome = (try? c.decode(String.self, forKey: .outcome)) ?? "VALUE"
        value = try? c.decodeIfPresent(Double.self, forKey: .value)
        exitCode = try? c.decodeIfPresent(Int.self, forKey: .exitCode)
    }
}

/// One line of a condition's history: FIRED, READY_AGAIN, CANT_READ, READ_AGAIN, ASKED_STILL_WAITING.
public struct ConditionEventView: Codable, Equatable, Hashable, Sendable {
    public let at: String
    public let kind: String
    public let value: Double?
    /// The run a FIRED started, on a WHEN schedule.
    public let runId: String?
    /// A FIRED that is a repeat: "Fired again".
    public let `repeat`: Bool

    public init(at: String, kind: String, value: Double? = nil, runId: String? = nil, repeat: Bool = false) {
        self.at = at
        self.kind = kind
        self.value = value
        self.runId = runId
        self.repeat = `repeat`
    }

    private enum CodingKeys: String, CodingKey { case at, kind, value, runId, `repeat` }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        at = try c.decode(String.self, forKey: .at)
        kind = try c.decode(String.self, forKey: .kind)
        value = try? c.decodeIfPresent(Double.self, forKey: .value)
        runId = try? c.decodeIfPresent(String.self, forKey: .runId)
        `repeat` = (try? c.decode(Bool.self, forKey: .repeat)) ?? false
    }
}

/// `GET /conditions/:id`: a condition's state, its newest samples and its events (the inspector's Condition and
/// How it checks blocks, and its history).
public struct ConditionView: Codable, Equatable, Hashable, Sendable, Identifiable {
    public struct Probe: Codable, Equatable, Hashable, Sendable {
        public let command: String
        public let timeoutSeconds: Int
        public init(command: String, timeoutSeconds: Int = 20) {
            self.command = command
            self.timeoutSeconds = timeoutSeconds
        }
    }

    public let id: String
    public let workspaceId: String
    public let text: String
    public let unit: String?
    public let probe: Probe
    public let compare: ConditionCompare
    public let holdSeconds: Int
    public let rearm: ConditionCompare?
    public let intervalSeconds: Int
    public let repeatSeconds: Int?
    public let state: String
    public let lastSampleAt: String?
    public let lastValue: Double?
    public let lastOutcome: String?
    public let lastReadAt: String?
    public let unknownReason: String?
    public let failedChecks: Int
    public let firedAt: String?
    public let approvedAt: String
    public let taskId: String?
    public let scheduleId: String?
    public let keepsWorkspaceAwake: Bool
    /// The runner its probes run on; nil from a server that does not say, or a workspace with none.
    public let runnerName: String?
    /// Newest first.
    public let samples: [ConditionSampleView]
    /// Newest first.
    public let events: [ConditionEventView]

    public init(id: String, workspaceId: String = "w1", text: String, unit: String? = nil, command: String,
                compare: ConditionCompare, holdSeconds: Int = 0, rearm: ConditionCompare? = nil,
                intervalSeconds: Int = 300, repeatSeconds: Int? = nil, state: String = "WAITING",
                lastSampleAt: String? = nil, lastValue: Double? = nil, lastOutcome: String? = nil,
                lastReadAt: String? = nil, unknownReason: String? = nil, failedChecks: Int = 0,
                firedAt: String? = nil, approvedAt: String = "2026-11-17T03:00:00.000Z", taskId: String? = nil,
                scheduleId: String? = nil, keepsWorkspaceAwake: Bool = false, runnerName: String? = nil,
                samples: [ConditionSampleView] = [], events: [ConditionEventView] = []) {
        self.id = id
        self.workspaceId = workspaceId
        self.text = text
        self.unit = unit
        self.probe = Probe(command: command)
        self.compare = compare
        self.holdSeconds = holdSeconds
        self.rearm = rearm
        self.intervalSeconds = intervalSeconds
        self.repeatSeconds = repeatSeconds
        self.state = state
        self.lastSampleAt = lastSampleAt
        self.lastValue = lastValue
        self.lastOutcome = lastOutcome
        self.lastReadAt = lastReadAt
        self.unknownReason = unknownReason
        self.failedChecks = failedChecks
        self.firedAt = firedAt
        self.approvedAt = approvedAt
        self.taskId = taskId
        self.scheduleId = scheduleId
        self.keepsWorkspaceAwake = keepsWorkspaceAwake
        self.runnerName = runnerName
        self.samples = samples
        self.events = events
    }

    private enum CodingKeys: String, CodingKey {
        case id, workspaceId, text, unit, probe, compare, holdSeconds, rearm, intervalSeconds, repeatSeconds, state
        case lastSampleAt, lastValue, lastOutcome, lastReadAt, unknownReason, failedChecks, firedAt, approvedAt
        case taskId, scheduleId, keepsWorkspaceAwake, runnerName, samples, events
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        workspaceId = (try? c.decode(String.self, forKey: .workspaceId)) ?? ""
        text = try c.decode(String.self, forKey: .text)
        unit = try? c.decodeIfPresent(String.self, forKey: .unit)
        probe = (try? c.decode(Probe.self, forKey: .probe)) ?? Probe(command: "")
        compare = try c.decode(ConditionCompare.self, forKey: .compare)
        holdSeconds = (try? c.decode(Int.self, forKey: .holdSeconds)) ?? 0
        rearm = try? c.decodeIfPresent(ConditionCompare.self, forKey: .rearm)
        intervalSeconds = (try? c.decode(Int.self, forKey: .intervalSeconds)) ?? 300
        repeatSeconds = try? c.decodeIfPresent(Int.self, forKey: .repeatSeconds)
        state = (try? c.decode(String.self, forKey: .state)) ?? "WAITING"
        lastSampleAt = try? c.decodeIfPresent(String.self, forKey: .lastSampleAt)
        lastValue = try? c.decodeIfPresent(Double.self, forKey: .lastValue)
        lastOutcome = try? c.decodeIfPresent(String.self, forKey: .lastOutcome)
        lastReadAt = try? c.decodeIfPresent(String.self, forKey: .lastReadAt)
        unknownReason = try? c.decodeIfPresent(String.self, forKey: .unknownReason)
        failedChecks = (try? c.decode(Int.self, forKey: .failedChecks)) ?? 0
        firedAt = try? c.decodeIfPresent(String.self, forKey: .firedAt)
        approvedAt = (try? c.decode(String.self, forKey: .approvedAt)) ?? ""
        taskId = try? c.decodeIfPresent(String.self, forKey: .taskId)
        scheduleId = try? c.decodeIfPresent(String.self, forKey: .scheduleId)
        keepsWorkspaceAwake = (try? c.decode(Bool.self, forKey: .keepsWorkspaceAwake)) ?? false
        runnerName = try? c.decodeIfPresent(String.self, forKey: .runnerName)
        samples = ((try? c.decode([ScheduleLenient<ConditionSampleView>].self, forKey: .samples)) ?? []).compactMap(\.value)
        events = ((try? c.decode([ScheduleLenient<ConditionEventView>].self, forKey: .events)) ?? []).compactMap(\.value)
    }
}

/// A Waiting on you item a condition files (§5.3, §6.2): the can't-read card (CONDITION_UNKNOWN) and the 30-day
/// question (CONDITION_STILL_WAITING), read off the owner-request list beside the kinds `OwnerRequest` reads. Written by
/// the condition, not asked by a session, so it is answered here and nowhere else.
public struct ConditionWaitingItem: Decodable, Equatable, Sendable, Identifiable {
    public static let cantRead = "CONDITION_UNKNOWN"
    public static let stillWaiting = "CONDITION_STILL_WAITING"
    public static let kinds: [String] = [cantRead, stillWaiting]

    public let id: String
    public let kind: String
    public let state: String
    /// "Can't read: Root disk below 5%" / "Still waiting for 3 or more OSDs are in. Keep waiting?".
    public let title: String
    public let why: String
    public let conditionId: String?
    public let workspaceId: String?
    public let askedBySessionId: String?
    /// The 30-day question's two answers: Keep waiting, Stop.
    public let options: [OwnerRequestOption]
    public let createdAt: String

    public init(id: String, kind: String, state: String = "PENDING", title: String, why: String = "",
                conditionId: String? = nil, workspaceId: String? = nil, askedBySessionId: String? = nil,
                options: [OwnerRequestOption] = [], createdAt: String = "2026-11-17T03:40:00.000Z") {
        self.id = id
        self.kind = kind
        self.state = state
        self.title = title
        self.why = why
        self.conditionId = conditionId
        self.workspaceId = workspaceId
        self.askedBySessionId = askedBySessionId
        self.options = options
        self.createdAt = createdAt
    }

    private enum CodingKeys: String, CodingKey {
        case id, kind, state, title, why, conditionId, workspaceId, askedBySessionId, options, createdAt
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let kind = try c.decode(String.self, forKey: .kind)
        guard Self.kinds.contains(kind) else {
            throw DecodingError.dataCorruptedError(forKey: .kind, in: c, debugDescription: "not a condition item")
        }
        self.kind = kind
        id = try c.decode(String.self, forKey: .id)
        state = try c.decode(String.self, forKey: .state)
        title = (try? c.decode(String.self, forKey: .title)) ?? ""
        why = (try? c.decode(String.self, forKey: .why)) ?? ""
        conditionId = try? c.decodeIfPresent(String.self, forKey: .conditionId)
        workspaceId = try? c.decodeIfPresent(String.self, forKey: .workspaceId)
        askedBySessionId = try? c.decodeIfPresent(String.self, forKey: .askedBySessionId)
        options = (try? c.decode([OwnerRequestOption].self, forKey: .options)) ?? []
        createdAt = (try? c.decode(String.self, forKey: .createdAt)) ?? ""
    }

    public var isStillWaiting: Bool { kind == Self.stillWaiting }
}

/// A task's startWhen on its read (shared `TaskStartWhenView`): what it waits for, the newest reading, and the
/// waiting line while it waits.
public struct TaskStartWhenView: Codable, Equatable, Hashable, Sendable {
    public let conditionId: String
    public let text: String
    public let unit: String?
    public let state: String
    public let lastValue: Double?
    public let lastSampleAt: String?
    public let firedAt: String?
    /// "Waiting for: 3 or more OSDs are in" while it waits; nil once it fired or ended.
    public let waitingLine: String?

    public init(conditionId: String, text: String, unit: String? = nil, state: String = "WAITING",
                lastValue: Double? = nil, lastSampleAt: String? = nil, firedAt: String? = nil,
                waitingLine: String? = nil) {
        self.conditionId = conditionId
        self.text = text
        self.unit = unit
        self.state = state
        self.lastValue = lastValue
        self.lastSampleAt = lastSampleAt
        self.firedAt = firedAt
        self.waitingLine = waitingLine
    }

    private enum CodingKeys: String, CodingKey {
        case conditionId, text, unit, state, lastValue, lastSampleAt, firedAt, waitingLine
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        conditionId = try c.decode(String.self, forKey: .conditionId)
        text = (try? c.decode(String.self, forKey: .text)) ?? ""
        unit = try? c.decodeIfPresent(String.self, forKey: .unit)
        state = (try? c.decode(String.self, forKey: .state)) ?? "WAITING"
        lastValue = try? c.decodeIfPresent(Double.self, forKey: .lastValue)
        lastSampleAt = try? c.decodeIfPresent(String.self, forKey: .lastSampleAt)
        firedAt = try? c.decodeIfPresent(String.self, forKey: .firedAt)
        waitingLine = try? c.decodeIfPresent(String.self, forKey: .waitingLine)
    }
}

/// The task create card's condition lines (frame 2 of the board; the server's `startWhenCardLines`): Starts when,
/// how it is checked and the command under it, Today, If never.
public struct StartWhenCardLines: Codable, Equatable, Hashable, Sendable {
    public let startsWhen: String
    public let checked: String
    public let command: String
    public let today: String
    public let ifNever: String
    /// "Keeps this cloud workspace awake while it waits."; nil off Orbit Cloud.
    public let awake: String?

    public init(startsWhen: String, checked: String, command: String, today: String, ifNever: String,
                awake: String? = nil) {
        self.startsWhen = startsWhen
        self.checked = checked
        self.command = command
        self.today = today
        self.ifNever = ifNever
        self.awake = awake
    }

    /// The lines off a JSON object (the card's `preview.tasks[i].startWhen`); nil when it carries none.
    public init?(json: JSONValue?) {
        guard let json, let startsWhen = json["startsWhen"]?.stringValue else { return nil }
        self.init(startsWhen: startsWhen, checked: json["checked"]?.stringValue ?? "",
                  command: json["command"]?.stringValue ?? "", today: json["today"]?.stringValue ?? "",
                  ifNever: json["ifNever"]?.stringValue ?? "", awake: json["awake"]?.stringValue)
    }
}
