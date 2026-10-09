import Foundation

/// What a client shows for the managed runner's state. The same kinds as @orbit/shared
/// `ManagedRunnerDisplayKind`; `ManagedRunnerFixtureTests` holds this file to the fixture the web
/// is rendered from too (src/shared/src/managed-runner-states.fixture.json).
public enum ManagedRunnerDisplayKind: String, Equatable, Sendable, CaseIterable {
    /// NOT_PROVISIONED, and the server offers one: Set up.
    case setup
    /// NOT_PROVISIONED, and the server does not give this account one (the reason says why).
    case notOffered
    /// REQUESTED, PROVISIONING or STARTING before the runner was ever ready.
    case preparing
    /// Asleep with work asking for it, or starting up again after it had been ready.
    case waking
    /// Starting, but no runtime is installed and signed in on it (MODEL_UNAVAILABLE).
    case modelUnavailable
    case waitingCapacity
    /// READY and usable.
    case available
    /// READY, but its heartbeat is not fresh: unavailable, not proven dead.
    case unresponsive
    /// DRAINING.
    case stopping
    case sleeping
    /// FENCING: no safe retry exists; an operator's proof is awaited.
    case waitingOperator
    case failed
    /// DELETING.
    case removing
    /// DELETED.
    case removed
}

public struct ManagedRunnerDisplay: Equatable, Sendable {
    public let kind: ManagedRunnerDisplayKind
    public let title: String
    /// The server's reason sentence when it gave one, else the state's own sentence.
    public let detail: String
    /// Offer Retry — POST /managed-runner/retry with the read revision: FAILED, and the server allows it.
    public let retry: Bool
    /// Offer Set up — POST /managed-runner/ensure: no mapping, and the server offers one.
    public let ensure: Bool
    /// Point at the runner's runtimes: what it lacks is a runtime signed in.
    public let signIn: Bool
    /// A message or turn sent now is accepted and waits for the runner (the states the server's
    /// demand hook queues work for, and asleep only when the server offers a wake), so a console
    /// does not refuse it as offline.
    public let acceptsWork: Bool
    /// A first session in the managed default workspace can start: the runner was found ready with
    /// `initialProvider`. Before that the server refuses it with MODEL_UNAVAILABLE.
    public let startsNewSession: Bool
    /// The state moves by itself: read the status again soon.
    public let moving: Bool
}

/// The fixed words, the same in every client (@orbit/shared `MANAGED_RUNNER_COPY`).
public enum ManagedRunnerCopy {
    public static func title(_ kind: ManagedRunnerDisplayKind) -> String {
        switch kind {
        case .setup: return "Set up a managed runner"
        case .notOffered: return "No managed runner"
        case .preparing: return "Preparing your managed runner"
        case .waking: return "Waking your managed runner"
        case .modelUnavailable: return "Your managed runner needs a model"
        case .waitingCapacity: return "Waiting for capacity"
        case .available: return "Managed runner ready"
        case .unresponsive: return "Managed runner not responding"
        case .stopping: return "Managed runner going to sleep"
        case .sleeping: return "Managed runner asleep"
        case .waitingOperator: return "Waiting for an operator"
        case .failed: return "Managed runner failed"
        case .removing: return "Removing managed runner"
        case .removed: return "Managed runner removed"
        }
    }

    /// Said when the server gave no reason.
    public static func detail(_ kind: ManagedRunnerDisplayKind) -> String {
        switch kind {
        case .setup:
            return "This Orbit server can run a runner for you, so you can start sessions without setting up a machine of your own."
        case .notOffered:
            return "This Orbit server does not give your account a managed runner. Your own runners are unaffected."
        case .preparing:
            return "Orbit is setting up a runner for you. Sessions can start here once it is ready."
        case .waking:
            return "It is starting again. Messages sent meanwhile wait for it and run once it is up."
        case .modelUnavailable:
            return "None of its runtimes is installed and signed in yet, so it cannot start a session. Sign one in from Infrastructure."
        case .waitingCapacity:
            return "The managed environment has no room for it right now. It starts by itself when room frees up."
        case .available:
            return "Sessions here run on the runner Orbit manages for you."
        case .unresponsive:
            return "Orbit has not heard from it recently. Messages sent meanwhile wait for it."
        case .stopping:
            return "It was idle and is stopping. Work sent now waits, and starts it again once it has stopped."
        case .sleeping:
            return "It went to sleep while idle. Send a message to wake it; its workspace and files are kept."
        case .waitingOperator:
            return "Nothing proves its previous instance stopped, so no new one starts and its data is kept until an operator acts."
        case .failed:
            return "It could not be started."
        case .removing:
            return "It is being removed and is not recreated."
        case .removed:
            return "It was removed. Signing in again does not recreate it."
        }
    }

    public static let retry = "Retry"
    public static let ensure = "Set up"
    public static let signIn = "Open Infrastructure"
    public static let registerOwn = "Register your own machine"
}

/// A managed runner as one console sees it: only the console of the managed runner's own
/// workspaces has one.
public struct ManagedRunnerConsole: Equatable, Sendable {
    public let display: ManagedRunnerDisplay
    public let runnerID: String
    /// A New Session draft in the managed default workspace before its runner was ever ready: the
    /// server would refuse the session, so there is no engine to start it on and nothing to send.
    public let blocksNewSession: Bool

    /// The state stands above the composer unless the runner is simply ready.
    public var showsBanner: Bool { display.kind != .available }
}

/// The managed runner as every client reads it (docs/managed-runner-design.md, "Server and three
/// client interfaces"). Only the capability and the status fields are read — never a runner's name
/// or its heartbeat. With the capability missing, switched off or of another contract, or a status
/// that says the switch is off, there is no managed UI and every screen behaves as it did before.
public enum ManagedRunnerLogic {
    /// The contract this client knows (@orbit/shared `MANAGED_RUNNER_CONTRACT_VERSION`).
    public static let contractVersion = 1

    /// How often the status is read again: soon while it moves by itself, rarely otherwise
    /// (@orbit/shared `MANAGED_RUNNER_STATUS_POLL_SECONDS`).
    public static let pollSeconds: (moving: TimeInterval, settled: TimeInterval) = (5, 30)

    static let modelUnavailable = "MODEL_UNAVAILABLE"
    static let environmentUnavailable = "MANAGED_RUNNER_UNAVAILABLE"

    /// The states the server's demand hook queues work for (managed-runner-demand.ts COMING_BACK).
    static let comingBack: Set<String> = [
        "REQUESTED", "WAITING_CAPACITY", "PROVISIONING", "STARTING", "READY", "DRAINING", "SLEEPING",
    ]

    static let sleepStates: Set<String> = ["DRAINING", "SLEEPING"]

    static let movingKinds: Set<ManagedRunnerDisplayKind> = [
        .preparing, .waking, .modelUnavailable, .waitingCapacity, .unresponsive, .stopping, .removing,
    ]

    /// Whether the server offers managed runners to this client. A failed read (nil, a pre-feature
    /// server's 404 included), a missing member, the switch off or another contract: no.
    public static func offered(_ capabilities: ServerCapabilities?) -> Bool {
        guard let member = capabilities?.managedRunners else { return false }
        return member.enabled && member.contractVersion == contractVersion
    }

    static func kind(_ status: ManagedRunnerStatus) -> ManagedRunnerDisplayKind? {
        switch status.managementState {
        case "NOT_PROVISIONED":
            return status.actions.canEnsure ? .setup : .notOffered
        case "REQUESTED", "PROVISIONING", "STARTING":
            if status.reason?.code == modelUnavailable { return .modelUnavailable }
            // `initialProvider` is recorded when the runner becomes READY and kept: starting with
            // one is starting again.
            return status.initialProvider == nil ? .preparing : .waking
        case "WAITING_CAPACITY":
            return .waitingCapacity
        case "READY":
            return status.usable ? .available : .unresponsive
        case "DRAINING":
            return .stopping
        case "SLEEPING":
            // Demand sets the desired state back to RUNNING before the manager's next pass moves it.
            return status.desiredState == "RUNNING" ? .waking : .sleeping
        case "FENCING":
            return .waitingOperator
        case "FAILED":
            return .failed
        case "DELETING":
            return .removing
        case "DELETED":
            return .removed
        default:
            // A state this contract does not name: no managed UI rather than a guess.
            return nil
        }
    }

    /// The display for a status, or nil when there is no managed UI for it.
    public static func display(_ status: ManagedRunnerStatus?) -> ManagedRunnerDisplay? {
        guard let status, status.enabled, status.contractVersion == contractVersion,
              let kind = kind(status) else { return nil }
        let reason = status.reason
        // Switched on without a usable environment: nothing reconciles, so nothing moves by itself.
        let frozen = reason?.code == environmentUnavailable
        // Asleep, or going to sleep, it comes back only on a wake the server would perform.
        let wakeable = !sleepStates.contains(status.managementState) || status.actions.canWake
        let acceptsWork = !frozen && wakeable && comingBack.contains(status.managementState)
        let said = kind == .available ? nil : reason?.message
        return ManagedRunnerDisplay(
            kind: kind,
            title: ManagedRunnerCopy.title(kind),
            detail: (said?.isEmpty == false ? said : nil) ?? ManagedRunnerCopy.detail(kind),
            retry: status.managementState == "FAILED" && status.actions.canRetry,
            ensure: status.managementState == "NOT_PROVISIONED" && status.actions.canEnsure,
            signIn: reason?.code == modelUnavailable && status.runnerId != nil,
            acceptsWork: acceptsWork,
            startsNewSession: acceptsWork && status.initialProvider != nil,
            moving: !frozen && movingKinds.contains(kind))
    }

    /// When to read the status again after this display.
    public static func refreshInterval(_ display: ManagedRunnerDisplay?) -> TimeInterval {
        display?.moving == true ? pollSeconds.moving : pollSeconds.settled
    }

    /// What a console shows for the managed runner: nil unless `runnerID` is the managed runner.
    /// `agentID` is the console's workspace; a draft in the managed default workspace cannot start a
    /// session until the runner has been ready with a runtime.
    public static func console(status: ManagedRunnerStatus?,
                               runnerID: String?,
                               agentID: String?,
                               isDraft: Bool) -> ManagedRunnerConsole? {
        guard let status, let display = display(status),
              let managedRunner = status.runnerId, let runnerID,
              PublicID.storageKey(managedRunner) == PublicID.storageKey(runnerID) else { return nil }
        let inDefaultWorkspace = status.workspaceId.map { workspace in
            agentID.map { PublicID.storageKey($0) == PublicID.storageKey(workspace) } ?? false
        } ?? false
        return ManagedRunnerConsole(
            display: display,
            runnerID: runnerID,
            blocksNewSession: isDraft && inDefaultWorkspace && !display.startsNewSession)
    }

    /// The session's capabilities as a console acts on them. The server's, except that a managed
    /// runner that comes back by itself does not make an ended session refuse a message as offline:
    /// the server queues a resume for it instead (SessionsService.resume), and sending is what wakes
    /// it. Every other refusal stands.
    public static func sendCapabilities(_ capabilities: SessionCapabilities?,
                                        acceptsWork: Bool) -> SessionCapabilities? {
        guard let capabilities, acceptsWork, capabilities.resumeBlockedReason == .runnerOffline else {
            return capabilities
        }
        return SessionCapabilities(canSend: true, canResume: true, resumeBlockedReason: nil,
                                   canComplete: capabilities.canComplete, canRestore: capabilities.canRestore)
    }

    /// The managed runner Infrastructure shows above its runners: only to an account with no runner
    /// at all, where the web's default landing shows it too. Any other account finds its managed
    /// runner in the console of its workspace.
    public static func onboarding(_ display: ManagedRunnerDisplay?, runnerCount: Int) -> ManagedRunnerDisplay? {
        runnerCount == 0 ? display : nil
    }
}
