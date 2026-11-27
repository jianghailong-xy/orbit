import Foundation

/// What a warning draws for Fix with an agent.
public enum RunnerAgentFixState: Equatable, Sendable {
    /// The button, pressable; `hint` is the grey line under it (the Install failed panel's only).
    case ready(hint: String?)
    /// The button greyed, and why on the grey line under it.
    case blocked(reason: String)
    /// No button: "An agent is fixing this in <workspace> · " and Open session for this session.
    case fixing(RunnerAgentFixing)
}

/// What the transcript's missing-bubblewrap warning draws (web's `SandboxFixView`): the button and
/// where its session runs, the reason none can start, the agent at work, or the one that already
/// finished with that row — a transcript is history, so it does not offer a second agent.
public enum SandboxFixState: Equatable, Sendable {
    case ready(hint: String?)
    case blocked(reason: String)
    case fixing(RunnerAgentFixing)
    case handled(sessionId: String, workspaceName: String)
}

/// Which warning a press is about: its kind, and the engine for `engineNotUpdating` and `installFailed`.
public struct RunnerAgentFixTarget: Equatable, Sendable {
    public let kind: RunnerAttentionFixKind
    public let engine: String?

    public init(kind: RunnerAttentionFixKind, engine: String?) {
        self.kind = kind
        self.engine = engine
    }
}

/// Where Fix with an agent is drawn and how (the web's and Android's same rules): on a Needs Attention
/// card only for an engine not updating and a runner that can't update itself, on an engine's Install
/// failed panel, and under an Update Engines Now report with a failed line
/// (docs/mocks/engine-update-fix-with-agent/03-mobile.png) — never from a server too old to send `agentFix`.
public enum RunnerAgentFixLogic {
    /// The warning a Needs Attention item's press fixes; nil for every kind the button is not on.
    public static func target(_ item: RunnerAttentionItem) -> RunnerAgentFixTarget? {
        switch item.kind {
        case .engineNotUpdating:
            let engine: String?
            if case .string(let slug)? = item.params["engine"] { engine = slug } else { engine = item.action?.engine }
            guard let engine, !engine.isEmpty else { return nil }
            return RunnerAgentFixTarget(kind: .engineNotUpdating, engine: engine)
        case .cannotSelfUpdate:
            return RunnerAgentFixTarget(kind: .cannotSelfUpdate, engine: nil)
        default:
            return nil
        }
    }

    /// The open session an agent fixes `target` in: the same kind, and for an engine's warning the same
    /// engine.
    public static func fixing(_ fix: RunnerAgentFix, _ target: RunnerAgentFixTarget) -> RunnerAgentFixing? {
        (fix.fixing ?? []).first { entry in
            entry.kind == target.kind.rawValue
                && (target.kind == .cannotSelfUpdate || target.kind == .engineUpdateFailed || entry.engine == target.engine)
        }
    }

    /// A Needs Attention card's Fix with an agent: nil (draw nothing) for a kind it isn't on, from an
    /// older server, and on a machine that is offline.
    public static func attentionState(_ runner: Runner, item: RunnerAttentionItem) -> RunnerAgentFixState? {
        guard let fix = runner.agentFix, let target = target(item), fix.blocked?.code != "offline" else { return nil }
        if let entry = fixing(fix, target) { return .fixing(entry) }
        if let blocked = fix.blocked { return .blocked(reason: blocked.message) }
        return .ready(hint: nil)
    }

    /// An engine's Install failed panel's Fix with an agent: nil unless the engine's row is Install failed
    /// and the server sends `agentFix`. Blocked says why — signed out adds where to sign in — and offline
    /// is a reason like the others; ready says where the session starts.
    public static func installFailedState(_ runner: Runner, engine: String) -> RunnerAgentFixState? {
        guard let fix = runner.agentFix else { return nil }
        let health = LoginEngine(rawValue: engine).map { MachinesAndModels.engineHealth(runner, $0) }
            ?? runner.engines?.first { $0.engine == engine }
        guard MachinesAndModels.rowKind(health, install: runner.install, slug: engine) == .installFailed else {
            return nil
        }
        return panelState(fix, RunnerAgentFixTarget(kind: .installFailed, engine: engine))
    }

    /// Under an Update Engines Now report: nil unless the finished run has a failed line (drawn red) and the
    /// server sends `agentFix`; then as on an Install failed panel, the engine rows being above it here too.
    public static func engineUpdateState(_ runner: Runner) -> RunnerAgentFixState? {
        guard let fix = runner.agentFix,
              RunnerPageFormat.updateRelayLines(runner.install).contains(where: \.failed) else { return nil }
        return panelState(fix, RunnerAgentFixTarget(kind: .engineUpdateFailed, engine: nil))
    }

    /// A panel's state: the fixing line, or the button — blocked with the reason (signed out adds where to
    /// sign in, offline is a reason like the others), or ready with where the session starts.
    private static func panelState(_ fix: RunnerAgentFix, _ target: RunnerAgentFixTarget) -> RunnerAgentFixState {
        if let entry = fixing(fix, target) {
            return .fixing(entry)
        }
        let engineName = fix.engineName ?? fix.engine.map(RunnerPageFormat.engineName)
        if let blocked = fix.blocked {
            guard blocked.code == "engineSignedOut", let engineName else { return .blocked(reason: blocked.message) }
            return .blocked(reason: blocked.message + RunnerPageCopy.agentFixSignInAbove(engine: engineName))
        }
        guard let workspace = fix.workspaceName, let engineName else { return .ready(hint: nil) }
        return .ready(hint: RunnerPageCopy.agentFixStartsIn(workspace: workspace, engine: engineName))
    }

    /// The body a press sends: the engine for an engine's warning, the newest runner release the client
    /// knows of for a runner that can't update itself.
    public static func request(_ target: RunnerAgentFixTarget, latestVersion: String?) -> RunnerAttentionFixRequest {
        switch target.kind {
        case .cannotSelfUpdate:
            let latest = latestVersion?.trimmingCharacters(in: .whitespacesAndNewlines)
            return RunnerAttentionFixRequest(latest: latest?.isEmpty == false ? latest : nil)
        case .engineNotUpdating, .installFailed, .sandboxMissing:
            return RunnerAttentionFixRequest(engine: target.engine)
        case .engineUpdateFailed:
            return RunnerAttentionFixRequest()
        }
    }

    /// The engine whose sandbox names the missing package, in the transcript's warning.
    public static let SANDBOX_FIX_ENGINE = "codex"

    /// The transcript's missing-bubblewrap warning (docs/mocks/codex-sandbox-fix-with-agent): nil from
    /// an older server, which sends no `agentFix`.
    public static func sandboxState(_ fix: RunnerAgentFix?) -> SandboxFixState? {
        guard let fix else { return nil }
        let target = RunnerAgentFixTarget(kind: .sandboxMissing, engine: SANDBOX_FIX_ENGINE)
        if let entry = fixing(fix, target) { return .fixing(entry) }
        if let handled = (fix.handled ?? []).first(where: { $0.kind == target.kind.rawValue && $0.engine == target.engine }) {
            return .handled(sessionId: handled.sessionId, workspaceName: handled.workspaceName)
        }
        let engineName = fix.engineName ?? fix.engine.map(RunnerPageFormat.engineName)
        if let blocked = fix.blocked {
            guard blocked.code == "engineSignedOut", let engineName else { return .blocked(reason: blocked.message) }
            return .blocked(reason: blocked.message + RunnerPageCopy.agentFixSignInOnMachinePage(engine: engineName))
        }
        guard let workspace = fix.workspaceName, let engineName else { return .ready(hint: nil) }
        return .ready(hint: RunnerPageCopy.agentFixStartsIn(workspace: workspace, engine: engineName))
    }
}
