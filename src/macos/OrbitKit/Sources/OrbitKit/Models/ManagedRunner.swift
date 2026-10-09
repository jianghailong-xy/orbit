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

    public init(managedRunners: ManagedRunnerCapability?) {
        self.managedRunners = managedRunners
    }

    private enum CodingKeys: String, CodingKey { case managedRunners }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        managedRunners = try? values.decode(ManagedRunnerCapability.self, forKey: .managedRunners)
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
    /// The runtime the runner was found ready with, which its default workspace's first session
    /// starts on. Nil until the runner has been READY.
    public let initialProvider: String?
    public let actions: ManagedRunnerActions
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
