import Foundation

// The managed runner contract (docs/managed-runner-design.md, "Server and three client
// interfaces"), mirrored from src/shared/src/managedRunner.ts. Every state and code here is a
// String, never a closed enum: a newer server can add a management state or a reason code, and its
// answer must still decode. What a client shows for them is `ManagedRunnerLogic.display`, held to
// src/shared/src/managed-runner-states.fixture.json like the web's.

/// `GET /api/auth/capabilities` → `managedRunners`. Read leniently: a malformed member is no
/// capability rather than an answer that fails to decode.
public struct ManagedRunnerCapability: Decodable, Equatable, Sendable {
    public let enabled: Bool
    public let contractVersion: Int?

    public init(enabled: Bool, contractVersion: Int?) {
        self.enabled = enabled
        self.contractVersion = contractVersion
    }

    private enum CodingKeys: String, CodingKey { case enabled, contractVersion }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        enabled = (try? values.decode(Bool.self, forKey: .enabled)) ?? false
        contractVersion = try? values.decode(Int.self, forKey: .contractVersion)
    }
}

/// `GET /api/auth/capabilities`: the optional features this server offers a signed-in client.
/// Reading it allocates nothing on the server.
public struct ServerCapabilities: Decodable, Equatable, Sendable {
    public let managedRunners: ManagedRunnerCapability?
    /// Drive (the drive, `/drive`), the deployment switch ORBIT_DRIVE_ENABLED. A server from before
    /// the switch omits it; `DriveLogic.shown` reads that as on.
    public let documents: DriveCapability?

    public init(managedRunners: ManagedRunnerCapability?, documents: DriveCapability? = nil) {
        self.managedRunners = managedRunners
        self.documents = documents
    }

    private enum CodingKeys: String, CodingKey { case managedRunners, documents }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        managedRunners = try? values.decode(ManagedRunnerCapability.self, forKey: .managedRunners)
        documents = try? values.decode(DriveCapability.self, forKey: .documents)
    }
}

/// A safe, structured cause: the server's own sentence, never a raw infrastructure error.
public struct ManagedRunnerReason: Decodable, Equatable, Sendable {
    public let code: String
    public let message: String
    public let retryable: Bool

    private enum CodingKeys: String, CodingKey { case code, message, retryable }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        code = try values.decode(String.self, forKey: .code)
        message = try values.decode(String.self, forKey: .message)
        retryable = (try? values.decode(Bool.self, forKey: .retryable)) ?? false
    }
}

/// What the server allows the owner to ask for now.
public struct ManagedRunnerActions: Decodable, Equatable, Sendable {
    public let canEnsure: Bool
    public let canWake: Bool
    public let canSleep: Bool
    public let canRetry: Bool
    public let canDelete: Bool

    private enum CodingKeys: String, CodingKey { case canEnsure, canWake, canSleep, canRetry, canDelete }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        canEnsure = (try? values.decode(Bool.self, forKey: .canEnsure)) ?? false
        canWake = (try? values.decode(Bool.self, forKey: .canWake)) ?? false
        canSleep = (try? values.decode(Bool.self, forKey: .canSleep)) ?? false
        canRetry = (try? values.decode(Bool.self, forKey: .canRetry)) ?? false
        canDelete = (try? values.decode(Bool.self, forKey: .canDelete)) ?? false
    }
}

/// `GET /api/managed-runner`, and the body of every accepted managed runner write: the signed-in
/// owner's mapping as stored and derived. Ids are public ids, timestamps ISO 8601; the ids are nil
/// before a mapping exists.
public struct ManagedRunnerStatus: Decodable, Equatable, Sendable {
    public let contractVersion: Int
    /// The server's switch. False: management is frozen and no client shows managed UI.
    public let enabled: Bool
    /// The mapping's compare-and-set revision, which a retry names; 0 when there is none.
    public let revision: Int
    /// A management state, or `NOT_PROVISIONED`.
    public let managementState: String
    public let desiredState: String?
    public let runnerId: String?
    public let workspaceId: String?
    /// The runner row's own heartbeat observation; the display never reads it.
    public let heartbeatStatus: String?
    public let lastHeartbeatAt: String?
    /// READY with a fresh heartbeat: new turns can be claimed.
    public let usable: Bool
    public let reason: ManagedRunnerReason?
    public let retryAfter: String?
    /// Its next automatic try, as the server stored it: a restart's backoff, or a FAILED runner's slow retry (which may
    /// be past: it is taken once work is waiting). Nil when none is scheduled, and from a server that predates the field.
    public let nextAttemptAt: String?
    /// What the runner was found ready with, which its first session starts on:
    /// a runtime signed in on it, or one of the owner's model keys (its slug). Nil until the runner
    /// has been READY.
    public let initialProvider: String?
    /// What a first session on this runner, sent with nothing named, starts on now:
    /// `initialProvider` once the runner has been READY, before that the owner's model key the
    /// session waits for the runner on. Nil when there is none (the server would refuse it with
    /// MODEL_UNAVAILABLE), and from a server that predates the field.
    public let firstSessionProvider: String?
    /// The runner runs an older build than the current image's (docs/managed-runner-update-now-design.md).
    /// Nil when it runs the current one, is not running, or the server cannot tell or predates the field.
    public let update: ManagedRunnerUpdate?
    public let actions: ManagedRunnerActions
}

/// One build of the managed runner image: its source commit, and when it was built, if known. `version` is the
/// release it was published for (`0.1.261-beta.83`); absent for an image built from a checkout.
public struct ManagedRunnerBuild: Decodable, Equatable, Sendable {
    public let sha: String
    public let builtAt: String?
    public let version: String?

    public init(sha: String, builtAt: String? = nil, version: String? = nil) {
        self.sha = sha
        self.builtAt = builtAt
        self.version = version
    }
}

/// The managed runner's container was made from an older image than the current one. `available`: READY on
/// the older build. `updating`: Update Now, or an image roll, is on its way to the next container.
public struct ManagedRunnerUpdate: Decodable, Equatable, Sendable {
    public let running: ManagedRunnerBuild
    public let current: ManagedRunnerBuild
    /// `available` or `updating`; a string, so a newer phase still decodes.
    public let phase: String
    /// `updating` on a busy runner whose backend cannot stop it: the update waits for idle.
    public let waitsForIdle: Bool

    public init(running: ManagedRunnerBuild, current: ManagedRunnerBuild, phase: String, waitsForIdle: Bool = false) {
        self.running = running
        self.current = current
        self.phase = phase
        self.waitsForIdle = waitsForIdle
    }

    private enum CodingKeys: String, CodingKey { case running, current, phase, waitsForIdle }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        running = try values.decode(ManagedRunnerBuild.self, forKey: .running)
        current = try values.decode(ManagedRunnerBuild.self, forKey: .current)
        phase = try values.decode(String.self, forKey: .phase)
        waitsForIdle = (try? values.decode(Bool.self, forKey: .waitsForIdle)) ?? false
    }
}

/// The body of POST /api/managed-runner/update-now.
public struct ManagedRunnerUpdateNowRequest: Encodable, Equatable, Sendable {
    public let interruptTurns: Bool

    public init(interruptTurns: Bool) { self.interruptTurns = interruptTurns }
}

/// A turn running on the managed runner, as a busy Update Now's 409 lists it.
public struct ManagedRunnerBusyTurn: Decodable, Equatable, Sendable {
    public let sessionId: String
    public let title: String?
    public let startedAt: String?
}

/// The 409 `MANAGED_RUNNER_BUSY` body: what updating now would stop.
public struct ManagedRunnerBusy: Decodable, Equatable, Sendable {
    public let code: String
    public let turns: [ManagedRunnerBusyTurn]
    public let backgroundJobs: Int

    private enum CodingKeys: String, CodingKey { case code, turns, backgroundJobs }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        code = try values.decode(String.self, forKey: .code)
        turns = (try? values.decode([ManagedRunnerBusyTurn].self, forKey: .turns)) ?? []
        backgroundJobs = (try? values.decode(Int.self, forKey: .backgroundJobs)) ?? 0
    }
}

/// The body of every managed runner write: a key that makes a retried request the same request,
/// and, for a retry, the revision it was read at.
public struct ManagedRunnerWriteRequest: Encodable, Equatable, Sendable {
    public let idempotencyKey: String
    public let revision: Int?

    public init(idempotencyKey: String, revision: Int? = nil) {
        self.idempotencyKey = idempotencyKey
        self.revision = revision
    }
}
