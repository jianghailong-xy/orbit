import Foundation

/// One durable mode change from the session detail, ordered by the server's clock.
public struct SessionPermissionModeChange: Codable, Equatable, Sendable {
    public let fromMode: String?
    public let toMode: String
    public let cause: String
    public let client: String?
    public let at: String

    var rowID: String {
        "permission-mode-\(at)-\(fromMode ?? "")-\(toMode)-\(cause)-\(client ?? "")"
    }

    public var line: String {
        let mode = Self.label(toMode)
        switch cause {
        case "CLAIM":
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

public struct SessionModeDisplay: Equatable, Sendable {
    public let label: String
    public let reason: String?
    public let isCorrecting: Bool

    public init(intent: PermissionMode, actual: String?, beforeStart: Bool,
                latestChange: SessionPermissionModeChange? = nil,
                runsAsRoot: Bool = false, autoStartsInDefault: Bool = false) {
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
