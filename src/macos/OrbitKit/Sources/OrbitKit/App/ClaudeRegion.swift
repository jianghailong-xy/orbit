import Foundation

/// The Claude region check as these apps read it (docs/claude-region-check-contract.md) — the web's
/// `src/web/src/lib/claudeRegion.ts`. The verdict is the runner's (`Runner.region`, §6), never an
/// engine's health; a session's own state says only that it is held, by the code its error starts
/// with (§9, §10). A runner that reads no region — one without claude-region/v1, one no check has
/// decided yet, or an older control plane — is never gated, and every surface draws what it drew
/// before. The words are `ClaudeRegionCopy`.
public enum ClaudeRegion {
    /// The one engine the check gates (owner decision ⑥).
    public static let engine = "claude"

    /// What a region refusal or stop starts with: `CLAUDE_REGION_UNSUPPORTED: `.
    static let coded = "\(ClaudeRegionCopy.CLAUDE_REGION_UNSUPPORTED): "

    /// Whether a runner's Anthropic-bound Claude turns are gated now. `region.verdict` is already the
    /// effective verdict (§5): the server answers blocked only for a blocked check under 24 hours old.
    public static func blocked(_ region: RunnerRegionView?) -> Bool { region?.blocked == true }

    /// Whether an error is a region refusal or stop: `CLAUDE_REGION_UNSUPPORTED: <sentence>`.
    public static func isRegionError(_ error: String?) -> Bool {
        error?.trimmingCharacters(in: .whitespacesAndNewlines).hasPrefix(coded) == true
    }

    /// The stopped sentence's words around the machine and the place (the shared
    /// `claudeRegionStoppedError`, owner decision ④): matched by its whole shape, so a refusal from a
    /// machine whose name starts like it is still a refusal.
    static let stoppedLead = coded + "Claude Code stopped on "
    static let stoppedMiddle = ": its connection to Anthropic is now in "
    static let stoppedTail = ", where Anthropic doesn’t offer Claude."

    private static let stoppedShape: NSRegularExpression = {
        let literal = NSRegularExpression.escapedPattern(for:)
        // Escaped literals around two any-character runs: a pattern that cannot fail to compile.
        return try! NSRegularExpression(
            pattern: "^\(literal(stoppedLead))[\\s\\S]+\(literal(stoppedMiddle))[\\s\\S]+\(literal(stoppedTail))$")
    }()

    static func isStoppedSentence(_ text: String) -> Bool {
        stoppedShape.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)) != nil
    }

    /// What the transcript draws for an error event the runner wrote (the web's `claudeRegionErrorLine`).
    public enum ErrorLine: Equatable, Sendable {
        /// No region error: drawn as ever.
        case notRegion
        /// A refusal: the held session's card says it, with its ways out, so a red line with the raw
        /// code would only repeat it.
        case refusal
        /// A turn stopped by a confirmed flip, which has no card: its sentence, without its code.
        case stopped(String)
    }

    public static func errorLine(_ message: String) -> ErrorLine {
        let text = message.trimmingCharacters(in: .whitespacesAndNewlines)
        guard text.hasPrefix(coded) else { return .notRegion }
        return isStoppedSentence(text) ? .stopped(String(text.dropFirst(coded.count))) : .refusal
    }

    /// A session the control plane holds for the region (§10, §11): in the queue, with a region error.
    /// Its message waits, and nothing is working on it.
    public static func held(runState: SessionRunState, error: String?) -> Bool {
        runState == .queued && isRegionError(error)
    }

    public static func held(_ session: Session) -> Bool {
        held(runState: session.effectiveRunState, error: session.error)
    }

    /// The same, for a caller that holds the run's status (a console): queued is PENDING.
    public static func held(status: RunStatus, error: String?) -> Bool {
        status == .pending && isRegionError(error)
    }

    /// A held session's status words — `Anthropic unavailable on {machine}` — or nil for any other
    /// session, and where the machine is not known.
    public static func heldWords(_ session: Session, machine: String?) -> String? {
        guard let machine, !machine.isEmpty, held(session) else { return nil }
        return ClaudeRegionCopy.anthropicUnavailableOn(machine: machine)
    }

    /// A credential as `credentialIsAnthropicBound` reads it: an engine's own sign-in or an account
    /// pool by the engine it runs on, a key by its preset — a picker row knows a key's preset, not its
    /// endpoint (GET /providers leaves the URL out) — and OpenCode's own configuration.
    public enum Credential: Equatable, Sendable {
        case login(engine: String)
        case pool(engine: String)
        case key(presetSlug: String?)
        case opencode
    }

    /// Whether a credential talks to Anthropic (owner decision ①, contract §8, the shared
    /// `credentialIsAnthropicBound`): Claude Code's own sign-in, a Claude pool, or a key on the
    /// Anthropic preset. A DeepSeek, Moonshot or local vLLM key is not, even under Claude Code; nor is
    /// another engine's sign-in or pool, or OpenCode's own configuration.
    public static func credentialIsAnthropicBound(_ credential: Credential) -> Bool {
        switch credential {
        case .login(let engine), .pool(let engine): return engine == Self.engine
        case .key(let preset): return preset == "anthropic"
        case .opencode: return false
        }
    }

    /// How often Check again reads the runner while its check is on the way, and for how long (§7):
    /// the answer lands in `Runner.region` like any other check's.
    public static let checkPollInterval: TimeInterval = 2
    public static let checkWait: TimeInterval = 30

    /// Whether the runner's region reflects a check made at or after the one Check again asked for.
    public static func checkAnswered(checkedAt: String?, askedAt: String) -> Bool {
        guard let checked = checkedAt.flatMap(RelativeTime.parse), let asked = RelativeTime.parse(askedAt) else {
            return false
        }
        return checked >= asked
    }
}
