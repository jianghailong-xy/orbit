import Foundation

// The wiki's server execution as the clients read it — the Swift mirror of `@orbit/shared`'s read types in
// `wikiJobs.ts` and `wikiSystemModel.ts` (contracts/wiki.contract.json `jobs.read`, `jobs.executor.read` and
// `systemModel.read`, P9): whether the server runs this account's wiki, the System model's name and state, and a
// space's server runs with their calls, which Activity's Runs band and a run's page draw.
//
// As in `WikiHealth.swift`, a value this build has never heard of decodes as `.unknown`, and every field reads as
// its default when a server one release apart leaves it out: a page then draws less instead of the read failing.

/// How far the deployment's server execution is switched on (contract `jobs.executor.modes`).
public enum WikiExecutorMode: String, Codable, Sendable, CaseIterable {
    case runner, canary, server
    case unknown

    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = WikiExecutorMode(rawValue: raw) ?? .unknown
    }
}

/// What a read tells the account that asks about the switch (contract `jobs.executor.read`): the mode, and whether
/// the server executes this account's wiki. A control plane older than P9 sends none, which reads as runner.
public struct WikiExecutorView: Codable, Equatable, Sendable {
    public let mode: WikiExecutorMode
    public let serverExecutes: Bool

    public init(mode: WikiExecutorMode, serverExecutes: Bool) {
        self.mode = mode
        self.serverExecutes = serverExecutes
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        mode = (try? c.decodeIfPresent(WikiExecutorMode.self, forKey: .mode)) ?? .unknown
        serverExecutes = (try? c.decodeIfPresent(Bool.self, forKey: .serverExecutes)) ?? false
    }
}

/// The System model's state as the read answers it (contract `systemModel.read.states`).
public enum WikiSystemModelState: String, Codable, Sendable, CaseIterable {
    case up, down
    case authFailed = "auth_failed"
    case unconfigured
    case workerNotRunning = "worker_not_running"
    case unknown

    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = WikiSystemModelState(rawValue: raw) ?? .unknown
    }

    /// The five the contract names, in its order.
    public static let contractOrder: [WikiSystemModelState] = [.up, .down, .authFailed, .unconfigured, .workerNotRunning]
}

/// `GET /wiki/system-model`: the deployment's System model — its name and state, never its address or key — and the
/// executor switch as it stands for the caller (`executor`, absent from a control plane older than P9). The health
/// read carries the same state, without `executor`, beside a space's health.
public struct WikiSystemModelStatus: Codable, Equatable, Sendable {
    public let state: WikiSystemModelState
    public let model: String?
    public let since: String?
    public let checkedAt: String?
    public let workerSeenAt: String?
    public let executor: WikiExecutorView?

    public init(state: WikiSystemModelState, model: String? = nil, since: String? = nil, checkedAt: String? = nil,
                workerSeenAt: String? = nil, executor: WikiExecutorView? = nil) {
        self.state = state
        self.model = model
        self.since = since
        self.checkedAt = checkedAt
        self.workerSeenAt = workerSeenAt
        self.executor = executor
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        state = (try? c.decodeIfPresent(WikiSystemModelState.self, forKey: .state)) ?? .unknown
        model = try? c.decodeIfPresent(String.self, forKey: .model)
        since = try? c.decodeIfPresent(String.self, forKey: .since)
        checkedAt = try? c.decodeIfPresent(String.self, forKey: .checkedAt)
        workerSeenAt = try? c.decodeIfPresent(String.self, forKey: .workerSeenAt)
        executor = try? c.decodeIfPresent(WikiExecutorView.self, forKey: .executor)
    }
}

/// What a server run is (contract `jobs.kinds`).
public enum WikiJobKind: String, Codable, Sendable, CaseIterable {
    case verify, articles, `import`
    case planDraft = "plan_draft"
    case planRevise = "plan_revise"
    case docsBuild = "docs_build"
    case maintain, smoke
    case unknown

    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = WikiJobKind(rawValue: raw) ?? .unknown
    }

    /// The eight the contract names, in its order.
    public static let contractOrder: [WikiJobKind] = [.verify, .articles, .import, .planDraft, .planRevise, .docsBuild, .maintain, .smoke]
}

/// Where a server run is (contract `jobs.states`).
public enum WikiJobState: String, Codable, Sendable, CaseIterable {
    case queued, running, waiting, succeeded, failed, cancelled
    case unknown

    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = WikiJobState(rawValue: raw) ?? .unknown
    }

    public static let contractOrder: [WikiJobState] = [.queued, .running, .waiting, .succeeded, .failed, .cancelled]
}

/// What a model call is doing (contract `modelQueue.states`).
public enum WikiModelCallState: String, Codable, Sendable, CaseIterable {
    case queued, running, succeeded, failed, cancelled
    case unknown

    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = WikiModelCallState(rawValue: raw) ?? .unknown
    }

    public static let contractOrder: [WikiModelCallState] = [.queued, .running, .succeeded, .failed, .cancelled]
}

/// A run's position as its pipeline writes it, read as one step and, when it counts, done of total.
public struct WikiJobProgress: Codable, Equatable, Sendable {
    public let step: String?
    public let done: Int?
    public let total: Int?

    public init(step: String? = nil, done: Int? = nil, total: Int? = nil) {
        self.step = step
        self.done = done
        self.total = total
    }
}

/// A run's calls counted by state, and the tokens they reported.
public struct WikiJobCallCounts: Codable, Equatable, Sendable {
    public let total: Int
    public let queued: Int
    public let running: Int
    public let succeeded: Int
    public let failed: Int
    public let cancelled: Int
    public let inputTokens: Int
    public let outputTokens: Int

    public init(total: Int = 0, queued: Int = 0, running: Int = 0, succeeded: Int = 0, failed: Int = 0, cancelled: Int = 0,
                inputTokens: Int = 0, outputTokens: Int = 0) {
        self.total = total
        self.queued = queued
        self.running = running
        self.succeeded = succeeded
        self.failed = failed
        self.cancelled = cancelled
        self.inputTokens = inputTokens
        self.outputTokens = outputTokens
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        func count(_ key: CodingKeys) -> Int { (try? c.decodeIfPresent(Int.self, forKey: key)) ?? 0 }
        total = count(.total)
        queued = count(.queued)
        running = count(.running)
        succeeded = count(.succeeded)
        failed = count(.failed)
        cancelled = count(.cancelled)
        inputTokens = count(.inputTokens)
        outputTokens = count(.outputTokens)
    }
}

/// One model call of a run, as the call log shows it: its metadata alone (contract `jobs.read.request`).
public struct WikiJobCall: Codable, Equatable, Sendable, Identifiable {
    public let id: String
    public let step: String
    public let unit: String
    public let attempt: Int
    public let attempts: Int
    public let state: WikiModelCallState
    public let enqueuedAt: String
    public let startedAt: String?
    public let endedAt: String?
    public let inputTokens: Int?
    public let outputTokens: Int?
    public let httpStatus: Int?
    public let error: String?
    public let errorKind: String?
    /// While it is queued: how many queued requests the deployment's queue takes before it.
    public let ahead: Int?

    public init(id: String, step: String, unit: String, attempt: Int = 1, attempts: Int = 0, state: WikiModelCallState,
                enqueuedAt: String, startedAt: String? = nil, endedAt: String? = nil, inputTokens: Int? = nil,
                outputTokens: Int? = nil, httpStatus: Int? = nil, error: String? = nil, errorKind: String? = nil, ahead: Int? = nil) {
        self.id = id
        self.step = step
        self.unit = unit
        self.attempt = attempt
        self.attempts = attempts
        self.state = state
        self.enqueuedAt = enqueuedAt
        self.startedAt = startedAt
        self.endedAt = endedAt
        self.inputTokens = inputTokens
        self.outputTokens = outputTokens
        self.httpStatus = httpStatus
        self.error = error
        self.errorKind = errorKind
        self.ahead = ahead
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = (try? c.decodeIfPresent(String.self, forKey: .id)) ?? ""
        step = (try? c.decodeIfPresent(String.self, forKey: .step)) ?? ""
        unit = (try? c.decodeIfPresent(String.self, forKey: .unit)) ?? ""
        attempt = (try? c.decodeIfPresent(Int.self, forKey: .attempt)) ?? 1
        attempts = (try? c.decodeIfPresent(Int.self, forKey: .attempts)) ?? 0
        state = (try? c.decodeIfPresent(WikiModelCallState.self, forKey: .state)) ?? .unknown
        enqueuedAt = (try? c.decodeIfPresent(String.self, forKey: .enqueuedAt)) ?? ""
        startedAt = try? c.decodeIfPresent(String.self, forKey: .startedAt)
        endedAt = try? c.decodeIfPresent(String.self, forKey: .endedAt)
        inputTokens = try? c.decodeIfPresent(Int.self, forKey: .inputTokens)
        outputTokens = try? c.decodeIfPresent(Int.self, forKey: .outputTokens)
        httpStatus = try? c.decodeIfPresent(Int.self, forKey: .httpStatus)
        error = try? c.decodeIfPresent(String.self, forKey: .error)
        errorKind = try? c.decodeIfPresent(String.self, forKey: .errorKind)
        ahead = try? c.decodeIfPresent(Int.self, forKey: .ahead)
    }
}

/// One server run of the space — one `wiki_job` row, as Activity reads it (contract `jobs.read.job`).
public struct WikiJob: Codable, Equatable, Sendable, Identifiable {
    /// Of its calls that wait, the one the queue reaches first.
    public struct NextCall: Codable, Equatable, Sendable {
        public let ahead: Int
        public let enqueuedAt: String

        public init(ahead: Int, enqueuedAt: String) {
            self.ahead = ahead
            self.enqueuedAt = enqueuedAt
        }
    }

    public let id: String
    public let kind: WikiJobKind
    public let state: WikiJobState
    public let waitingFor: String?
    public let priority: Int
    public let attempts: Int
    public let createdAt: String
    public let updatedAt: String
    public let startedAt: String?
    public let endedAt: String?
    public let nextAttemptAt: String?
    public let failureKind: String?
    public let error: String?
    /// While it is queued: how many queued jobs the workers take before it.
    public let ahead: Int?
    public let progress: WikiJobProgress?
    public let calls: WikiJobCallCounts
    public let nextCall: NextCall?
    /// Its newest calls, oldest first.
    public let requests: [WikiJobCall]

    public init(id: String, kind: WikiJobKind, state: WikiJobState, waitingFor: String? = nil, priority: Int = 0,
                attempts: Int = 0, createdAt: String, updatedAt: String? = nil, startedAt: String? = nil, endedAt: String? = nil,
                nextAttemptAt: String? = nil, failureKind: String? = nil, error: String? = nil, ahead: Int? = nil,
                progress: WikiJobProgress? = nil, calls: WikiJobCallCounts = WikiJobCallCounts(), nextCall: NextCall? = nil,
                requests: [WikiJobCall] = []) {
        self.id = id
        self.kind = kind
        self.state = state
        self.waitingFor = waitingFor
        self.priority = priority
        self.attempts = attempts
        self.createdAt = createdAt
        self.updatedAt = updatedAt ?? createdAt
        self.startedAt = startedAt
        self.endedAt = endedAt
        self.nextAttemptAt = nextAttemptAt
        self.failureKind = failureKind
        self.error = error
        self.ahead = ahead
        self.progress = progress
        self.calls = calls
        self.nextCall = nextCall
        self.requests = requests
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = (try? c.decodeIfPresent(String.self, forKey: .id)) ?? ""
        kind = (try? c.decodeIfPresent(WikiJobKind.self, forKey: .kind)) ?? .unknown
        state = (try? c.decodeIfPresent(WikiJobState.self, forKey: .state)) ?? .unknown
        waitingFor = try? c.decodeIfPresent(String.self, forKey: .waitingFor)
        priority = (try? c.decodeIfPresent(Int.self, forKey: .priority)) ?? 0
        attempts = (try? c.decodeIfPresent(Int.self, forKey: .attempts)) ?? 0
        createdAt = (try? c.decodeIfPresent(String.self, forKey: .createdAt)) ?? ""
        updatedAt = (try? c.decodeIfPresent(String.self, forKey: .updatedAt)) ?? createdAt
        startedAt = try? c.decodeIfPresent(String.self, forKey: .startedAt)
        endedAt = try? c.decodeIfPresent(String.self, forKey: .endedAt)
        nextAttemptAt = try? c.decodeIfPresent(String.self, forKey: .nextAttemptAt)
        failureKind = try? c.decodeIfPresent(String.self, forKey: .failureKind)
        error = try? c.decodeIfPresent(String.self, forKey: .error)
        ahead = try? c.decodeIfPresent(Int.self, forKey: .ahead)
        progress = try? c.decodeIfPresent(WikiJobProgress.self, forKey: .progress)
        calls = (try? c.decodeIfPresent(WikiJobCallCounts.self, forKey: .calls)) ?? WikiJobCallCounts()
        nextCall = try? c.decodeIfPresent(NextCall.self, forKey: .nextCall)
        requests = (try? c.decodeIfPresent([WikiJobCall].self, forKey: .requests)) ?? []
    }
}

/// `GET /wiki/spaces/:id/jobs`: the space's newest server runs, newest first (contract `jobs.read`).
public struct WikiJobsRead: Codable, Equatable, Sendable {
    public let spaceId: String
    public let jobs: [WikiJob]

    public init(spaceId: String, jobs: [WikiJob]) {
        self.spaceId = spaceId
        self.jobs = jobs
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        spaceId = (try? c.decodeIfPresent(String.self, forKey: .spaceId)) ?? ""
        jobs = (try? c.decodeIfPresent([WikiJob].self, forKey: .jobs)) ?? []
    }
}

/// The numbers the read answers by (contract `jobs.read.limits`).
public enum WikiJobsReadLimits {
    public static let jobs = 10
    public static let callsPerJob = 40
}
