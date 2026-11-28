import Foundation

/// One durable mode change from the session detail, ordered by the server's clock.
public struct SessionPermissionModeChange: Codable, Equatable, Sendable {
    public let fromMode: String?
    public let toMode: String
    public let cause: String
    public let client: String?
    public let at: String
    /// For a CLAIM that handed another mode than the session asked for: the mode asked for, and why
    /// (`ROOT_RUNNER`, `SCHEDULED_RUN`). Nil otherwise, and from a server that does not say.
    public var requestedMode: String? = nil
    public var reason: String? = nil

    var rowID: String {
        "permission-mode-\(at)-\(fromMode ?? "")-\(toMode)-\(cause)-\(client ?? "")"
    }

    public var line: String {
        let mode = Self.label(toMode)
        switch cause {
        case "CLAIM":
            // The server's own word on why the claim handed another mode than the one asked for.
            let start = fromMode == nil ? "Started in" : "Resumed in"
            switch reason {
            case "SCHEDULED_RUN":
                return "\(start) \(mode) — scheduled runs always use Auto"
            case "ROOT_RUNNER":
                let asked = Self.label(requestedMode ?? PermissionMode.bypass.rawValue)
                return "\(start) \(mode), not \(asked) — \(asked) can't run on a root runner"
            default:
                break
            }
            if let fromMode { return "Claimed in \(mode) — previously \(Self.label(fromMode))" }
            return "Started in \(mode) — assigned at claim"
        case "OWNER_PICK":
            let source: String
            switch client {
            case "ios": source = " on iOS"
            case "macos": source = " on Mac"
            case "web": source = " on the web"
            case "android": source = " on Android"
            case "terminal": source = " in the terminal"
            default: source = ""
            }
            return "Mode set to \(mode) by you\(source)"
        case "ENGINE_REPORT":
            return "Engine reported \(mode)"
        case "RUNNER_CORRECTION":
            if let fromMode {
                return "Mode set back to \(mode) by the runner — the engine had been in \(Self.label(fromMode))"
            }
            return "Mode set to \(mode) by the runner"
        case "RESPAWN":
            return "Engine restarted in \(mode)"
        case "ORBIT_CHANGE":
            return "Mode set to \(mode) by Orbit"
        default:
            return "Mode changed to \(mode)"
        }
    }

    static func label(_ raw: String) -> String {
        PermissionMode(rawValue: raw).map(AgentDefaults.label) ?? raw
    }
}

/// The runner's report that Claude would not take the Auto it asked for (`permission_mode_correction_failed`,
/// runner-go claude_mode_correction.go): `mode` is the mode it stays in, `reason` the CLI's own words. It is a
/// system event of the conversation, not a mode change, so it is read off the events loaded.
public struct PermissionModeRefusal: Equatable, Hashable, Sendable {
    public let seq: Int
    public let at: String
    public let mode: String
    public let requested: String
    public let reason: String

    public static let eventSubtype = "permission_mode_correction_failed"

    public init(seq: Int, at: String, mode: String, requested: String, reason: String) {
        self.seq = seq
        self.at = at
        self.mode = mode
        self.requested = requested
        self.reason = reason
    }

    /// The refusal `event` reports, or nil for any other event.
    public init?(event: RunEvent) {
        guard event.type == .system,
              event.payload["subtype"]?.stringValue == Self.eventSubtype,
              let mode = event.payload["mode"]?.stringValue else { return nil }
        self.init(seq: event.seq, at: event.ts ?? "", mode: mode,
                  requested: event.payload["requested"]?.stringValue ?? PermissionMode.auto.rawValue,
                  reason: (event.payload["reason"]?.stringValue ?? "").trimmingCharacters(in: .whitespacesAndNewlines))
    }

    var rowID: String { "permission-mode-refused-\(seq)" }

    /// Its transcript line: the runner could not switch Claude, and why.
    public var line: String {
        let stays = "Claude stays in \(SessionPermissionModeChange.label(mode)) — the runner couldn't switch it to \(SessionPermissionModeChange.label(requested))"
        return reason.isEmpty ? stays : "\(stays): \(reason)"
    }

    /// How far the runner's clock may run behind the server's: the refusal is stamped by the runner, the report of
    /// the lower mode it answers by the server.
    static let clockSlack: TimeInterval = 60

    /// Whether this refusal answers the change the engine runs under now: Claude's report of the mode it settled on
    /// (or came back from a re-spawn in), which the runner then failed to correct. Any later change ends it.
    public func stands(latest: SessionPermissionModeChange?, actual: String?) -> Bool {
        guard let latest, let actual, latest.cause == "ENGINE_REPORT" || latest.cause == "RESPAWN",
              latest.toMode == actual, mode == actual else { return false }
        guard let refusedAt = Self.instant(at), let reportedAt = Self.instant(latest.at) else { return true }
        return refusedAt >= reportedAt.addingTimeInterval(-Self.clockSlack)
    }

    /// The index of the change this refusal answers in `changes`: the newest report of the mode it stays in, from before
    /// it. Its line goes with the refusal's: the server stamps a change when it took the runner's batch, after the runner's
    /// own stamp on the refusal, so placed by time alone the report would land below its answer.
    public func answeredChange(in changes: [SessionPermissionModeChange]) -> Int? {
        let refusedAt = Self.instant(at)
        return changes.indices.last { i in
            let change = changes[i]
            guard change.cause == "ENGINE_REPORT" || change.cause == "RESPAWN", change.toMode == mode else { return false }
            guard let refusedAt, let reportedAt = Self.instant(change.at) else { return true }
            return reportedAt <= refusedAt.addingTimeInterval(Self.clockSlack)
        }
    }

    static func instant(_ iso: String) -> Date? {
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return fractional.date(from: iso) ?? ISO8601DateFormatter().date(from: iso)
    }
}

public struct SessionModeDisplay: Equatable, Sendable {
    public let label: String
    public let reason: String?
    public let isCorrecting: Bool

    public init(intent: PermissionMode, actual: String?, beforeStart: Bool,
                latestChange: SessionPermissionModeChange? = nil,
                runsAsRoot: Bool = false, autoStartsInDefault: Bool = false,
                refusal: PermissionModeRefusal? = nil) {
        let requested = AgentDefaults.label(intent)
        guard let actual else {
            label = beforeStart ? requested : "Mode unconfirmed"
            reason = nil
            isCorrecting = false
            return
        }
        let running = SessionPermissionModeChange.label(actual)
        guard actual != intent.rawValue else {
            label = running
            reason = nil
            isCorrecting = false
            return
        }
        // The runner asked Claude for Auto and Claude said no: a gap that lasts (the board's "Default" with its
        // amber), nothing under way, and the CLI's own words for why.
        if let refusal, refusal.stands(latest: latestChange, actual: actual) {
            label = running
            isCorrecting = false
            let asked = SessionPermissionModeChange.label(refusal.requested)
            let words = refusal.reason.isEmpty ? ""
                : ": " + refusal.reason + (refusal.reason.hasSuffix(".") ? "" : ".")
            reason = "Running in \(running). You asked for \(asked), but the runner couldn't switch Claude to it"
                + (words.isEmpty ? "." : words)
            return
        }
        label = "\(running) → \(requested)"
        isCorrecting = intent == .auto && actual == PermissionMode.default.rawValue
            && latestChange?.toMode == actual && latestChange?.cause == "ENGINE_REPORT"
            && !autoStartsInDefault
        if isCorrecting {
            reason = "Running in \(running). The engine started below the Auto you asked for. The runner is switching it to Auto."
        } else if intent == .bypass && runsAsRoot && latestChange?.cause == "CLAIM" {
            reason = "Running in \(running). Bypass can't run on a root runner."
        } else if intent == .auto && autoStartsInDefault && actual == PermissionMode.default.rawValue {
            reason = "Running in Default. Auto starts in Default on this model."
        } else {
            let summary = "Running in \(running). You asked for \(requested)."
            reason = latestChange.flatMap { $0.toMode == actual ? "\(summary) \($0.line)." : nil } ?? summary
        }
    }

    /// This hint does not affect the selected mode. A missing Auto on a known-capable
    /// model can be a transient runner probe result.
    public static func autoStartHint(model: String, engine: String, provider: String,
                                     configured: [ConfiguredProvider], catalog: RunnerModelCatalog?) -> String? {
        guard !AgentDefaults.autoCapableModels.contains(model),
              !AgentDefaults.supportsAuto(model, engine: engine, provider: provider,
                                          configured: configured, catalog: catalog) else { return nil }
        return "starts in Default"
    }
}
