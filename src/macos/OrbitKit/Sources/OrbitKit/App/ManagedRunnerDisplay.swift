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
    /// A first session on the managed runner can start: the server names what it starts
    /// on (`firstSessionProvider` — what the runner was found ready with, or before that the owner's
    /// key the session waits for the runner on). With none the server refuses it with MODEL_UNAVAILABLE.
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
            return "None of its runtimes is signed in yet and none of your model keys runs on it, so it cannot start a session. Sign one in, or add a model key, from the Machines & models page."
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
    public static let signIn = "Open Machines & models"
    public static let registerOwn = "Register your own machine"

    /// The state as a machine row's short label, in place of the heartbeat's Online/Offline: a managed
    /// runner asleep is Asleep, never Offline (docs/managed-runner-existing-account-entry-design.md, D4).
    /// `notOffered` has no row (D2), so no label.
    public static func short(_ kind: ManagedRunnerDisplayKind) -> String? {
        switch kind {
        case .setup: return "Set up"
        case .preparing: return "Preparing"
        case .waking: return "Waking up…"
        case .modelUnavailable: return "Needs a model"
        case .waitingCapacity: return "Waiting for capacity"
        case .available: return "Ready"
        case .unresponsive: return "Not responding"
        case .stopping: return "Going to sleep"
        case .sleeping: return "Asleep"
        case .waitingOperator: return "Waiting for an operator"
        case .failed: return "Failed"
        case .removing: return "Removing"
        case .removed: return "Removed"
        case .notOffered: return nil
        }
    }

    /// The machine list's entry for an account with no mapping that the server offers one (D1).
    public enum Entry {
        public static let title = "Managed runner"
        public static let action = "Set up"
        /// The row's subtitle on iPhone and Android.
        public static let subtitle = "Orbit runs a runner for you on this server."
        /// The web's Set up page, beside the notice.
        public static let page = "Your own machines are not changed. Setting it up adds one machine and its workspace to this list."
        /// On Register a machine, linking to the Set up entry.
        public static let register = "Or let Orbit run one for you"
    }

    /// Asked before Set up on an account that already has a runner or a workspace (D3).
    public enum Confirm {
        public static let title = "Set up a managed runner?"
        public static let body = "Orbit will start a runner for you on this server. Your own machines and workspaces stay as they are."
        public static let cancel = "Cancel"
        public static let action = "Set up"
    }

    /// Sleep is not a fault: a sending client wakes it, and nothing warns that it is offline.
    public enum Setup {
        /// The managed runner's home, fixed by its image: a new folder goes here before it has reported
        /// (@orbit/shared MANAGED_RUNNER_HOME).
        public static let home = "/home/orbit"
        public enum Notice {
            public static let preparing = "Orbit is setting up your managed runner. You can create the workspace now; your first session starts when it’s ready."
            public static let asleep = "Your managed runner is asleep. Your first message wakes it (about 10 s)."
        }
        public enum FolderUnchecked {
            public static let preparing = "Not checked until your managed runner is up: used if it’s there, created if not."
            public static let asleep = "Not checked while it’s asleep: used if it’s there, created if not."
        }
    }

    public enum Asleep {
        /// The machine row's detail line beside Asleep.
        public static let row = "Wakes automatically when you start a session"
        /// Above the composer of a workspace whose managed runner is asleep.
        public static let composer = "Your managed runner is asleep. Sending wakes it (about 10 s)."
    }

    /// A managed runner that has not reported yet (preparing, waiting): its Resources and Engines say
    /// only this (the web's `MANAGED_RUNNER_NOT_REPORTED`).
    public static let notReported = RunnerPageCopy.MANAGED_RUNNER_NOT_REPORTED
}

/// How a machine row marks the managed runner's state: `ready` green, `progress` a spinner, `idle`
/// grey (asleep is neutral, never the colour of a fault), `attention` orange.
public enum ManagedRunnerRowTone: String, Equatable, Sendable, CaseIterable {
    case ready, progress, idle, attention

    init(_ kind: ManagedRunnerDisplayKind) {
        switch kind {
        case .available: self = .ready
        case .preparing, .waking, .waitingCapacity, .unresponsive, .stopping, .removing: self = .progress
        case .modelUnavailable, .waitingOperator, .failed: self = .attention
        case .setup, .sleeping, .removed, .notOffered: self = .idle
        }
    }
}

/// A machine row's reading of the account's managed runner: the shared short label in place of the
/// heartbeat's Online/Offline, how the row marks it, and the calm line an asleep runner carries.
public struct ManagedRunnerRow: Equatable, Sendable {
    public let kind: ManagedRunnerDisplayKind
    public let label: String
    public let tone: ManagedRunnerRowTone
    /// A calm line under the label, where the state has one (asleep); else nil.
    public let detail: String?
    /// Sending to it is accepted and wakes or waits for it: no "runner offline" warning.
    public let acceptsWork: Bool
    /// Asleep or going to sleep, and a message would wake it.
    public let asleep: Bool
    /// The managed runner's id, as the row was matched on: what a page names Orbit Cloud by.
    public let runnerID: String
}

/// A managed runner as one console sees it: only the console of the managed runner's own
/// workspaces has one.
public struct ManagedRunnerConsole: Equatable, Sendable {
    public let display: ManagedRunnerDisplay
    public let runnerID: String
    /// The state stands above the composer unless the runner is simply ready.
    public var showsBanner: Bool { display.kind != .available }
}

/// The managed runner as every client reads it (docs/managed-runner-design.md, "Server and three
/// client interfaces"). Only the capability and the status fields are read — never a runner's name
/// or its heartbeat. With the capability missing, switched off or of another contract, or a status
/// that says the switch is off, there is no managed UI and every screen behaves as it did before.
public enum ManagedSetupState: String, Equatable, Sendable, CaseIterable {
    case preparing, asleep
}

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
        // FAILED with its slow retry scheduled comes back by itself too (managed-runner-demand.ts `slowRetryScheduled`).
        let slowRetry = status.managementState == "FAILED" && status.nextAttemptAt?.isEmpty == false
            && status.reason?.retryable == true
        let acceptsWork = !frozen && wakeable && (comingBack.contains(status.managementState) || slowRetry)
        let said = kind == .available ? nil : reason?.message
        return ManagedRunnerDisplay(
            kind: kind,
            title: ManagedRunnerCopy.title(kind),
            detail: (said?.isEmpty == false ? said : nil) ?? ManagedRunnerCopy.detail(kind),
            retry: status.managementState == "FAILED" && status.actions.canRetry,
            ensure: status.managementState == "NOT_PROVISIONED" && status.actions.canEnsure,
            signIn: reason?.code == modelUnavailable && status.runnerId != nil,
            acceptsWork: acceptsWork,
            startsNewSession: acceptsWork && firstSessionProvider(status) != nil,
            moving: !frozen && movingKinds.contains(kind))
    }

    /// What a first session on the managed runner starts on, as the server says: its
    /// `firstSessionProvider`, or from a server that predates that field, `initialProvider` (which
    /// the field equals whenever the runner has one).
    public static func firstSessionProvider(_ status: ManagedRunnerStatus) -> String? {
        status.firstSessionProvider ?? status.initialProvider
    }

    public static func managedSetupState(runnerID: String?, status: ManagedRunnerStatus?) -> ManagedSetupState? {
        guard let row = row(runnerID: runnerID, status: status), row.acceptsWork,
              row.kind != .available, row.kind != .unresponsive, row.kind != .failed else { return nil }
        return status?.initialProvider?.isEmpty == false ? .asleep : .preparing
    }

    /// When to read the status again after this display.
    public static func refreshInterval(_ display: ManagedRunnerDisplay?) -> TimeInterval {
        display?.moving == true ? pollSeconds.moving : pollSeconds.settled
    }

    /// What a console shows for the managed runner: nil unless `runnerID` is the managed runner.
    public static func console(status: ManagedRunnerStatus?,
                               runnerID: String?,
                               agentID: String?,
                               isDraft: Bool) -> ManagedRunnerConsole? {
        guard let status, let display = display(status),
              let managedRunner = status.runnerId, let runnerID,
              PublicID.storageKey(managedRunner) == PublicID.storageKey(runnerID) else { return nil }
        return ManagedRunnerConsole(display: display, runnerID: runnerID)
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

    /// Whether the runner a client is about to show — a machine row, or a workspace's runner — is the
    /// account's managed runner, and how to show it. Nil when it is not, when the server offers no
    /// managed UI, or for `notOffered` (D2, which has no row): the client then shows that runner by
    /// its heartbeat, as before.
    public static func row(runnerID: String?, status: ManagedRunnerStatus?) -> ManagedRunnerRow? {
        guard let status, let managed = status.runnerId, let runnerID,
              PublicID.storageKey(managed) == PublicID.storageKey(runnerID),
              let display = display(status), let label = ManagedRunnerCopy.short(display.kind)
        else { return nil }
        // A spinner only while it moves by itself (not while the environment is unavailable).
        let tone = ManagedRunnerRowTone(display.kind)
        return ManagedRunnerRow(
            kind: display.kind,
            label: label,
            tone: tone == .progress && !display.moving ? .idle : tone,
            detail: display.kind == .sleeping && display.acceptsWork ? ManagedRunnerCopy.Asleep.row : nil,
            acceptsWork: display.acceptsWork,
            asleep: (display.kind == .sleeping || display.kind == .stopping) && display.acceptsWork,
            runnerID: runnerID)
    }

    /// Set up asks first on an account that already has a runner or a workspace (D3): a workspace
    /// appears in an established list, and no client can remove a managed runner.
    public static func confirmsSetup(runnerCount: Int, workspaceCount: Int) -> Bool {
        runnerCount > 0 || workspaceCount > 0
    }

    /// The managed runner Machines & models shows above its runners: to an account with no runner at
    /// all, where the web's default landing shows it too, and to an existing account while the server
    /// offers it one (`display.ensure`, D1). With a mapping it is one machine in the list instead (D4).
    public static func onboarding(_ display: ManagedRunnerDisplay?, runnerCount: Int) -> ManagedRunnerDisplay? {
        guard let display else { return nil }
        return runnerCount == 0 || display.ensure ? display : nil
    }
}
