import Foundation

/// What the clients need to know about DeepSeek Harness (`dsh`) that no other engine shares.
///
/// Harness has no sign-in on the runner: its credential is a configured provider's API key (the
/// `deepseek-harness` preset, runtime `dsh`), handed to the session at dispatch. So a runner can only
/// be asked whether it can START Harness — it declares `provider:dsh`, and its engine report says the
/// pinned CLI is installed on a platform it admits — never whether a key works; an invalid key shows
/// in the session that used it. The existing `deepseek` preset is Claude Code on DeepSeek's
/// Anthropic-compatible endpoint, and nothing here applies to it.
///
/// Mirrors web's `lib/dshRuntime.ts`; keep the two in sync.
public enum DshRuntime {
    /// The preset a Harness key is connected from.
    public static let presetSlug = "deepseek-harness"
    /// The heartbeat capability the server requires before it creates, resumes or hands out a dsh
    /// session.
    public static let runnerCapability = "provider:dsh"
    /// The `fixEngine` of the picker's connect-a-key row: fixed by connecting the key in Infrastructure
    /// (web `/providers/new/deepseek-harness`), not on any runner.
    public static let connectFix = "dsh-connect"
    /// The permission modes Harness enforces (shared `DSH_PERMISSION_MODES`, measured in P4). The
    /// server rejects a session configured with any other.
    public static let permissionModes: [PermissionMode] = [.default, .auto, .dontAsk]

    /// Why a runner can't start Harness, most fundamental first, or `ready`.
    public enum RunnerState: String, Equatable, Sendable {
        case ready, updateRunner, unsupportedPlatform, notInstalled, unsupportedVersion

        /// The words a picker row or a runner line uses for a state that blocks a session.
        public var label: String? {
            switch self {
            case .ready: return nil
            case .updateRunner: return "Update runner"
            case .unsupportedPlatform: return "Not supported here"
            case .notInstalled: return "Not installed"
            case .unsupportedVersion: return "Unsupported version"
            }
        }

        /// One sentence on what to do about it.
        public var hint: String? {
            switch self {
            case .ready: return nil
            case .updateRunner:
                return "This runner predates DeepSeek Harness. It updates itself when no session is running on it."
            case .unsupportedPlatform:
                return "DeepSeek Harness 0.2.0-rc.2 runs on Linux x64 runners with Node 26 only."
            case .notInstalled: return "Install DeepSeek Harness on this runner from Infrastructure."
            case .unsupportedVersion:
                return "This runner has a DeepSeek Harness version Orbit does not support. Reinstall it from Infrastructure."
            }
        }

        /// The one state a client can fix from here: install the pinned CLI on that machine.
        public var installable: Bool { self == .notInstalled || self == .unsupportedVersion }
    }

    /// Whether this runner can start a Harness session. The capability is the server's own gate;
    /// with it, the engine report decides, and a runner that hasn't reported Harness yet claims
    /// nothing and stays `ready`.
    public static func state(capabilities: [String]?, engines: [RunnerEngineHealth]?) -> RunnerState {
        guard capabilities?.contains(runnerCapability) == true else { return .updateRunner }
        guard let health = engines?.first(where: { $0.engine == "dsh" }) else { return .ready }
        let error = health.installationError ?? ""
        if error.hasPrefix("DSH_PLATFORM_UNSUPPORTED") || error.hasPrefix("DSH_NODE_UNSUPPORTED") {
            return .unsupportedPlatform
        }
        if health.installed == false { return .notInstalled }
        if let dsh = health.dsh, !dsh.versionCompatible { return .unsupportedVersion }
        return .ready
    }

    public static func state(of runner: Runner?) -> RunnerState {
        state(capabilities: runner?.capabilities, engines: runner?.engines)
    }

    /// What went wrong in a Harness session, when the runner's message says so.
    public enum Repair: String, Equatable, Sendable {
        case needsKey, invalidKey, updateRunner, notInstalled, unsupportedPlatform

        public var title: String {
            switch self {
            case .needsKey: return "DeepSeek Harness needs a DeepSeek key"
            case .invalidKey: return "DeepSeek rejected this API key"
            case .updateRunner: return "Waiting for a newer runner"
            case .notInstalled: return "DeepSeek Harness isn't installed on this runner"
            case .unsupportedPlatform: return "DeepSeek Harness can't run on this runner"
            }
        }

        public var detail: String { detail(keyName: nil) }

        /// The same, naming the session's key where the caller knows it — as a sentence names it,
        /// `the DeepSeek key “DeepSeek 2”` (web `keyName`): one DeepSeek key runs on Claude Code, OpenCode
        /// and Harness alike, and there can be several, so neither the engine nor "the key" says which.
        public func detail(keyName: String?) -> String {
            switch self {
            case .needsKey:
                return "This session has no DeepSeek key to run on. Add or re-enable a DeepSeek key in Infrastructure, then send your message again."
            case .invalidKey:
                return "Update \(keyName ?? "the DeepSeek key") in Infrastructure, then send your message again."
            case .updateRunner:
                return "This runner predates DeepSeek Harness. It updates itself when no session is running on it."
            case .notInstalled: return "Install it from Infrastructure, then send your message again."
            case .unsupportedPlatform:
                return "DeepSeek Harness 0.2.0-rc.2 runs on Linux x64 runners with Node 26 only. Move this work to a runner that can."
            }
        }

        /// Fixed on the session's own key, in Infrastructure.
        public var isKeyProblem: Bool { self == .needsKey || self == .invalidKey }
    }

    /// The same evidence the runner's own `dshRequestValidation` accepts as a bad key; anything
    /// vaguer (a rate limit, a 5xx, a dropped connection) is not treated as one.
    static let keyRejected = [
        "invalid api key", "api key is invalid", "authentication_error", "authentication fails", "unauthorized",
        "status 401", "status code 401", "http 401", "revoked api key", "api key has been revoked",
        "invalid credentials",
    ]
    /// The real DeepSeek 401 puts the masked key in between: "Your api key: ****0000 is invalid"
    /// (runner `dshKeyRejectedPattern`, web `DSH_KEY_REJECTED_PATTERN`).
    static let keyRejectedPattern = #"api key(?:: *\S+)? is invalid"#

    /// Read a runner or server message about a Harness session for the remedy it implies. A
    /// `DSH_REQUEST_FAILED` lead is the runner's verdict from an upstream status and wins over wording.
    public static func repair(_ message: String?) -> Repair? {
        let text = message ?? ""
        if text.hasPrefix("DSH_REQUEST_FAILED") { return nil }
        if text.contains("DSH_CREDENTIAL_MISSING") { return .needsKey }
        if text.contains("DSH_CREDENTIAL_INVALID") { return .invalidKey }
        if text.hasPrefix("DeepSeek Harness requires a newer Orbit runner") { return .updateRunner }
        if text.contains("DSH_NOT_INSTALLED") { return .notInstalled }
        if text.contains("DSH_PLATFORM_UNSUPPORTED") || text.contains("DSH_NODE_UNSUPPORTED") {
            return .unsupportedPlatform
        }
        let lower = text.lowercased()
        guard lower.hasPrefix("dsh ") else { return nil }
        if lower.contains("no api key") || lower.contains("missing api key") { return .needsKey }
        if keyRejected.contains(where: { lower.contains($0) }) { return .invalidKey }
        return lower.range(of: keyRejectedPattern, options: .regularExpression) != nil ? .invalidKey : nil
    }
}
