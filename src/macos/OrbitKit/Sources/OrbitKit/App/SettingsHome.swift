import Foundation

/// A page Settings opens from its list, each one a frame of Settings' own stack
/// (`NavNode.settingsPage`). The runners list is the one page that predates these and keeps its own
/// frame (`NavNode.settingsRunners`).
public enum SettingsPage: String, Hashable, Sendable, CaseIterable {
    case providers, notifications, sharedLinks, changePassword, admin

    /// The page's navigation title — the same words as the row that opens it.
    public var title: String {
        switch self {
        case .providers:      return SettingsHome.title(.providers)
        case .notifications:  return SettingsHome.title(.notifications)
        case .sharedLinks:    return SettingsHome.title(.sharedLinks)
        case .changePassword: return SettingsHome.title(.changePassword)
        case .admin:          return SettingsHome.title(.admin)
        }
    }
}

/// Settings' own list on iOS, top to bottom: which groups it has, which rows each holds, and what a
/// row says about where things stand. The list is an index — a row names a thing and its current
/// value, and the explanation behind it lives on the page it opens — so the view draws exactly this
/// and nothing of its own — the ChatGPT-style sheet the owner picked from the mockups.
///
/// The rows are the web's Settings and Profile pages, regrouped for a phone: Session defaults and
/// Session orchestration under Sessions, the Runners and Providers pages under Machines & models,
/// Notifications and Appearance under Preferences, Profile's email and password under Account with
/// Shared links beside them. The words are the web's wherever it has one.
public enum SettingsHome {
    public enum Group: String, CaseIterable, Sendable {
        case sessions, machines, preferences, account
    }

    public enum Row: String, CaseIterable, Sendable {
        case defaultPermission, orchestration
        case runners, providers
        case notifications, appearance
        case email, instance, sharedLinks, changePassword, admin
    }

    public static func header(_ group: Group) -> String {
        switch group {
        case .sessions:    return "Sessions"
        case .machines:    return "Machines & models"
        case .preferences: return "Preferences"
        case .account:     return "Account"
        }
    }

    /// The rows a group shows, in order. Admin is role-gated, like its section everywhere else.
    public static func rows(_ group: Group, isAdmin: Bool) -> [Row] {
        switch group {
        case .sessions:    return [.defaultPermission, .orchestration]
        case .machines:    return [.runners, .providers]
        case .preferences: return [.notifications, .appearance]
        case .account:
            let rows: [Row] = [.email, .instance, .sharedLinks, .changePassword]
            return isAdmin ? rows + [.admin] : rows
        }
    }

    public static func title(_ row: Row) -> String {
        switch row {
        case .defaultPermission: return "Default permission"
        case .orchestration:     return "Session orchestration"
        case .runners:           return AppSection.runners.title
        case .providers:         return "Providers"
        case .notifications:     return "Notifications"
        case .appearance:        return "Appearance"
        case .email:             return "Email"
        case .instance:          return "Instance"
        case .sharedLinks:       return "Shared links"
        case .changePassword:    return "Change password"
        case .admin:             return AppSection.admin.title
        }
    }

    /// SF Symbol for the row's leading glyph. Runners and Admin keep the glyph their sections have.
    public static func systemImage(_ row: Row) -> String {
        switch row {
        case .defaultPermission: return "hand.raised"
        case .orchestration:     return "point.3.connected.trianglepath.dotted"
        case .runners:           return AppSection.runners.systemImage
        case .providers:         return "powerplug"
        case .notifications:     return "bell"
        case .appearance:        return "circle.lefthalf.filled"
        case .email:             return "envelope"
        case .instance:          return "globe"
        case .sharedLinks:       return "link"
        case .changePassword:    return "lock.rotation"
        case .admin:             return AppSection.admin.systemImage
        }
    }

    /// The page a row opens. Nil for the rows that are answered in place: the two pickers, which
    /// are menus on the row itself, the orchestration switch — one for the whole account, so the
    /// row is the switch — and the two lines that only say something.
    public static func page(_ row: Row) -> SettingsPage? {
        switch row {
        case .providers:      return .providers
        case .notifications:  return .notifications
        case .sharedLinks:    return .sharedLinks
        case .changePassword: return .changePassword
        case .admin:          return .admin
        case .runners, .defaultPermission, .orchestration, .appearance, .email, .instance: return nil
        }
    }

    // MARK: - What a row says

    /// "3 of 4 online" — how many of the account's machines can take work right now.
    public static func runnersValue(_ runners: [Runner]) -> String {
        guard !runners.isEmpty else { return "None" }
        let online = runners.filter { $0.online == true }.count
        return "\(online) of \(runners.count) online"
    }

    /// "25 active" — the links that open for anyone who has them.
    public static func sharedLinksValue(active: Int) -> String {
        active > 0 ? "\(active) active" : "None"
    }

    /// Whether this device lets Orbit alert at all. Nil while that hasn't been asked yet.
    public static func notificationsValue(allowed: Bool?) -> String? {
        allowed.map { $0 ? "On" : "Off" }
    }

    /// The server this app is signed in to, as the sign-in screen asked for it: the host, and the
    /// port when there is one.
    public static func instanceName(_ baseURL: URL?) -> String? {
        guard let baseURL, let host = baseURL.host, !host.isEmpty else { return nil }
        return baseURL.port.map { "\(host):\($0)" } ?? host
    }

    /// "Orbit 0.1.2 (3581)" — the build, under the list, for a report about it.
    public static func versionLine(version: String?, build: String?) -> String? {
        guard let version, !version.isEmpty else { return nil }
        guard let build, !build.isEmpty else { return "Orbit \(version)" }
        return "Orbit \(version) (\(build))"
    }
}

/// The words of Settings' own pages. Wherever the web says the same thing, these are its words byte
/// for byte (`SettingsCopyParityTests` reads them back out of `SettingsPage.tsx` and
/// `ProfilePage.tsx`); the rest are the app's own — what only a phone has to say.
public enum SettingsCopy {
    // MARK: Notifications

    /// The group about this device's own switch — "This iPhone", "This iPad".
    public static func deviceHeader(_ model: String) -> String { "This \(model)" }
    public static let allowNotifications = "Allow notifications"
    public static let deviceFooter = "Set in iOS Settings — tap to open."
    /// Over the two switches the web page has: they are the account's, so every device follows them.
    public static let accountHeader = "Sent to all your devices"
    public static let sessionFinished = "When a session finishes"
    public static let sessionFinishedHint = "Alert your devices when a run finishes on its own or fails for good."
    public static let agentMessage = "When an agent asks for you"
    public static let agentMessageHint = "Let a running agent alert your devices itself — to ask something only you can answer, or to report what you were waiting for. At most one per session per minute."
    /// What alerts whatever the two switches say — the server gates only those two
    /// (`push.service.ts`), and a list that left these out would answer "I turned it all off, why
    /// does it still ring?" with nothing.
    public static let alwaysHeader = "Always sent"
    public static let alwaysSent = ["Tool approvals", "Projects waiting on you", "Engine sign-outs", "Watch matches"]
    public static let always = "Always"
    public static let alwaysFooter = "Each one waits on you, or is a watch you set up."

    /// The card at the top of Settings while this device won't show Orbit's alerts at all.
    public static let notificationsOffTitle = "Notifications are off"
    public static let notificationsOffDetail = "Hear when a session finishes or an agent asks for you."
    public static let turnOn = "Turn on"

    // MARK: Session orchestration (the web page's card)

    /// The account's one switch, where a form has room to label and explain it (macOS). On iOS the
    /// row is the switch, under the row's own name.
    public static let letSessionsOrchestrate = "Let sessions orchestrate"
    public static let letSessionsOrchestrateHint = "Sessions in every workspace can spawn and manage other sessions via the orbit MCP session tools. Off → those tools are hidden and refused."

    // MARK: Change password (the web's Profile page)

    public static let currentPassword = "Current password"
    public static let newPassword = "New password"
    public static let confirmPassword = "Confirm new password"
    public static let passwordRule = "At least 6 characters"
    public static let passwordsDoNotMatch = "Passwords do not match"
    public static let changePassword = "Change password"
    public static let passwordChanged = "Password changed"

    // MARK: Sign out

    public static let signOut = "Sign out"
    /// The confirmation names the server, the one thing that makes signing back in more than typing
    /// a password again.
    public static func signOutTitle(instance: String?) -> String {
        instance.map { "Sign out of \($0)?" } ?? "Sign out?"
    }
}
