import Foundation

/// The Settings form's own sections, named so a column can list them.
///
/// Settings is the one section that renders everything in the middle column and leaves the detail
/// pane on a placeholder — on a regular-width iPad that spends the larger half of the screen to say
/// "Browse settings in the list." Splitting the form by category gives that pane something true to
/// show: the list of categories on the left, one category's controls on the right.
///
/// The order is the order the form reads top to bottom, so the split shell and the single-column
/// shells present the same sequence and nothing has to be re-learned between them.
public enum SettingsCategory: String, CaseIterable, Identifiable, Sendable {
    case account, preferences, orchestration, password, updates

    public var id: String { rawValue }

    public var title: String {
        switch self {
        case .account:       return "Account"
        case .preferences:   return "Preferences"
        case .orchestration: return "Session orchestration"
        case .password:      return "Change password"
        case .updates:       return "Updates"
        }
    }

    public var systemImage: String {
        switch self {
        case .account:       return "person.crop.circle"
        case .preferences:   return "slider.horizontal.3"
        case .orchestration: return "point.3.connected.trianglepath.dotted"
        case .password:      return "lock.rotation"
        case .updates:       return "arrow.triangle.2.circlepath"
        }
    }

    /// The categories this platform actually renders. `updates` is the Sparkle channel switch and
    /// Sparkle ships only on macOS, so listing it on iPad would open onto an empty pane.
    public static var visible: [SettingsCategory] {
        #if os(macOS)
        return allCases
        #else
        return allCases.filter { $0 != .updates }
        #endif
    }
}
