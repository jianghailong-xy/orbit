import Foundation

/// Single source of truth for the composer's model / permission-mode / effort pickers. The
/// `claude` CLI has no list command, so (like the web's lib/agentDefaults) this is a static,
/// Opus-first list. Keep in sync with src/web/src/lib/agentDefaults.
public struct ModelOption: Equatable, Sendable, Identifiable {
    public let id: String
    public let name: String
}

public enum Effort: String, CaseIterable, Sendable, Identifiable {
    case low, medium, high
    public var id: String { rawValue }
    public var label: String { rawValue.capitalized }
}

public enum AgentDefaults {
    public static let models: [ModelOption] = [
        ModelOption(id: "claude-opus-4-8", name: "Opus 4.8"),
        ModelOption(id: "claude-sonnet-4-6", name: "Sonnet 4.6"),
        ModelOption(id: "claude-haiku-4-5-20251001", name: "Haiku 4.5"),
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
