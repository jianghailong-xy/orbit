import Foundation

/// Single source of truth for the composer's model / permission-mode / effort pickers. The
/// `claude` CLI has no list command, so (like the web's lib/agentDefaults) this is a static,
/// Opus-first list. Keep in sync with src/web/src/lib/agentDefaults.
public struct ModelOption: Equatable, Sendable, Identifiable {
    public let id: String
    public let name: String
}

/// Reasoning-effort levels offered in the composer, in the same order as web's EFFORT_OPTIONS.
/// `.default` ("") omits `--effort` so the model picks its own.
public enum Effort: String, CaseIterable, Sendable, Identifiable {
    case `default` = ""
    case low, medium, high, xhigh, max
    public var id: String { rawValue }
    public var label: String {
        switch self {
        case .default: return "Default"
        case .xhigh:   return "xHigh"
        default:       return rawValue.capitalized   // Low / Medium / High / Max
        }
    }
    /// Wire value for a turn/resume request: nil = omit the field (same as Default).
    public var wire: String? { self == .default ? nil : rawValue }
}

public enum AgentDefaults {
    public static let models: [ModelOption] = [
        ModelOption(id: "claude-fable-5", name: "Fable 5"),
        ModelOption(id: "claude-opus-4-8", name: "Opus 4.8"),
        ModelOption(id: "claude-sonnet-5", name: "Sonnet 5"),
        ModelOption(id: "claude-haiku-4-5", name: "Haiku 4.5"),
    ]
    public static let defaultModelID = "claude-opus-4-8"

    public static func friendlyName(_ id: String) -> String {
        models.first { $0.id == id }?.name ?? id
    }

    public static let permissionModes = PermissionMode.allCases

    public static func label(_ mode: PermissionMode) -> String {
        switch mode {
        case .default:     return "Default"
        case .acceptEdits: return "Accept Edits"
        case .plan:        return "Plan"
        case .auto:        return "Auto"
        case .dontAsk:     return "Don't Ask"
        case .bypass:      return "Bypass"
        }
    }
}
