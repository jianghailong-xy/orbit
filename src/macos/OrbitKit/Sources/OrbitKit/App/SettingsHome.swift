import Foundation
#if canImport(CoreGraphics)
import CoreGraphics   // CGSize/CGRect's Swift members on Apple platforms; Foundation has them on Linux
#endif

/// A page Settings opens from its list, each one a frame of Settings' own stack
/// (`NavNode.settingsPage`). Change password is the one opened from a page rather than the list: Profile's.
public enum SettingsPage: String, Hashable, Sendable, CaseIterable {
    case general, notifications, profile, sharedLinks, accessTokens, github, machines, providers, changePassword

    /// The page's navigation title — the same words as the row that opens it.
    public var title: String {
        switch self {
        case .general:        return SettingsHome.title(.general)
        case .notifications:  return SettingsHome.title(.notifications)
        case .profile:        return SettingsHome.title(.profile)
        case .sharedLinks:    return SettingsHome.title(.sharedLinks)
        case .accessTokens:   return SettingsHome.title(.accessTokens)
        case .github:         return SettingsHome.title(.github)
        case .machines:       return SettingsHome.title(.machines)
        case .providers:      return SettingsHome.title(.providers)
        case .changePassword: return SettingsCopy.changePassword
        }
    }
}

/// Settings' own list on iOS, top to bottom: which groups it has, which rows each holds, and what a
/// row says about where things stand. The list is an index — a row names a thing and its current
/// value, and the explanation behind it lives on the page it opens — so the view draws exactly this
/// and nothing of its own.
///
/// The groups and rows are the web Settings nav's (`SettingsLayout.tsx`, `settingsIndex.ts`), in its
/// order: Personal — General, Notifications, Appearance, Profile, Shared links, Access tokens —
/// then Integrations' GitHub (docs/github-workspace-design.md §8), then Machines, then
/// Providers. Terminals has no row on either: an approved terminal lives on its machine's page
/// (docs/mocks/terminals-on-machine-page). The web's pages the app has no page for yet (Storage,
/// Feishu, Workspaces) are left out; a phone shows each of Machines and Providers as one row
/// opening its page, where the web lists their items in the nav itself.
public enum SettingsHome {
    public enum Group: String, CaseIterable, Sendable {
        case personal, integrations, machines, providers
    }

    public enum Row: String, CaseIterable, Sendable {
        case general, notifications, appearance, profile, sharedLinks, accessTokens
        /// Settings → GitHub (docs/github-workspace-design.md §8): the web's Integrations group's GitHub page.
        case github
        case machines
        case providers
    }

    /// A group's header. Machines and Providers have none: each holds the one row that says that name,
    /// and a header over it would say it twice.
    public static func header(_ group: Group) -> String? {
        switch group {
        case .personal:  return "Personal"
        case .integrations: return GithubCopy.INTEGRATIONS
        case .machines:  return nil
        case .providers: return nil
        }
    }

    /// The rows a group shows, in order.
    public static func rows(_ group: Group) -> [Row] {
        switch group {
        case .personal:  return [.general, .notifications, .appearance, .profile, .sharedLinks, .accessTokens]
        case .integrations: return [.github]
        case .machines:  return [.machines]
        case .providers: return [.providers]
        }
    }

    /// The web nav's labels.
    public static func title(_ row: Row) -> String {
        switch row {
        case .general:       return "General"
        case .notifications: return "Notifications"
        case .appearance:    return "Appearance"
        case .profile:       return "Profile"
        case .sharedLinks:   return "Shared links"
        case .accessTokens:  return AccessTokensList.title
        case .github:        return GithubCopy.TITLE
        case .machines:      return MachinesAndModels.machines
        case .providers:     return "Providers"
        }
    }

    /// SF Symbol for the row's leading glyph: the web nav's icon, as near as SF Symbols has it.
    public static func systemImage(_ row: Row) -> String {
        switch row {
        case .general:       return "gearshape"
        case .notifications: return "bell"
        case .appearance:    return "sun.max"
        case .profile:       return "person"
        case .sharedLinks:   return "link"
        case .accessTokens:  return "key.horizontal"
        case .github:        return "chevron.left.forwardslash.chevron.right"
        case .machines:      return AppSection.runners.systemImage
        case .providers:     return "cloud"
        }
    }

    /// The page a row opens. Nil for Appearance, a menu on the row itself.
    public static func page(_ row: Row) -> SettingsPage? {
        switch row {
        case .general:       return .general
        case .notifications: return .notifications
        case .appearance:    return nil
        case .profile:       return .profile
        case .sharedLinks:   return .sharedLinks
        case .accessTokens:  return .accessTokens
        case .github:        return .github
        case .machines:      return .machines
        case .providers:     return .providers
        }
    }

    // MARK: - What a row says

    /// "1 needs you" — how many lines the Machines & models page's Needs you holds; with none, how many of
    /// the account's machines can take work right now. Settings' Machines row says it of the machines'
    /// lines alone, the Mac's Machines & models row of them all.
    public static func machinesAndModelsValue(needsYou: Int, runners: [Runner]) -> String {
        needsYouValue(needsYou) ?? runnersValue(runners)
    }

    /// "1 needs you", "3 need you" — nil with none.
    public static func needsYouValue(_ count: Int) -> String? {
        guard count > 0 else { return nil }
        return count == 1 ? "1 needs you" : "\(count) need you"
    }

    /// "3 of 4 online" — how many of the account's machines can take work right now.
    public static func runnersValue(_ runners: [Runner]) -> String {
        guard !runners.isEmpty else { return "None" }
        let online = runners.filter { $0.online == true }.count
        return "\(online) of \(runners.count) online"
    }

    /// "@ada" — the GitHub account connected, once the connection has been read; nil before, and when none is.
    public static func githubValue(_ integration: GithubIntegration?) -> String? {
        guard let integration, integration.connected, let login = integration.login else { return nil }
        return "@\(login)"
    }

    /// "25 active" — the links that open for anyone who has them.
    public static func sharedLinksValue(active: Int) -> String {
        active > 0 ? "\(active) active" : "None"
    }

    /// "3 active" — the tokens that still work.
    public static func accessTokensValue(active: Int) -> String {
        active > 0 ? "\(active) active" : "None"
    }

    /// Whether this device lets Orbit alert at all. Nil while that hasn't been asked yet.
    public static func notificationsValue(allowed: Bool?) -> String? {
        allowed.map { $0 ? "On" : "Off" }
    }
}

/// The page Settings' General row opens on iOS, top to bottom: the account's session settings —
/// the web's Session defaults card and its Session orchestration card — each in a section of its own
/// with the web's hint as its footer, as the Notifications page's switches have theirs
/// (docs/mocks/ios-settings-order, 2A). Every one is the whole account's, so it is answered on its
/// row and opens nothing.
public enum SessionSettings {
    public enum Row: String, CaseIterable, Sendable {
        case defaultPermission, orchestration, modelRouting, optimizeFor, promptSuggestions, recaps
    }

    /// One group on the page: a row's section, Settings › Translation's, or the Prompt optimizer's.
    public enum Group: Hashable, Sendable {
        case row(Row)
        case translation
        case promptOptimizer
    }

    /// The page top to bottom: Translation sits right after Default permission and before Session
    /// orchestration, as Android's and the web's pages have it (docs/mocks/session-translation, frame 7);
    /// the Prompt optimizer sits right under Suggested replies (docs/mocks/prompt-optimizer, frame 1);
    /// the rows keep their own order around them.
    public static let groups: [Group] =
        [.row(.defaultPermission), .translation] + Row.allCases.dropFirst().flatMap { row -> [Group] in
            row == .promptSuggestions ? [.row(row), .promptOptimizer] : [.row(row)]
        }

    /// Whether a row is drawn: Optimize For only while smart model selection is on, the one thing that
    /// reads it (owner, 2026-11-20); its saved value is kept while it is hidden. Every other row always.
    public static func shows(_ row: Row, smartModelSelection: Bool) -> Bool {
        row != .optimizeFor || smartModelSelection
    }

    public static func title(_ row: Row) -> String {
        switch row {
        case .defaultPermission: return "Default permission"
        case .orchestration:     return "Session orchestration"
        case .modelRouting:      return SettingsCopy.smartModelSelection
        case .optimizeFor:       return SettingsCopy.optimizeFor
        case .promptSuggestions: return SettingsCopy.suggestedReplies
        case .recaps:            return SettingsCopy.sessionRecaps
        }
    }

    /// The line under a row: what it does, in the web Settings page's words.
    public static func footer(_ row: Row) -> String {
        switch row {
        case .defaultPermission: return SettingsCopy.defaultPermissionHint
        case .orchestration:     return SettingsCopy.letSessionsOrchestrateHint
        case .modelRouting:      return SettingsCopy.smartModelSelectionHint
        case .optimizeFor:       return SettingsCopy.optimizeForHint
        case .promptSuggestions: return SettingsCopy.suggestedRepliesHint
        case .recaps:            return SettingsCopy.sessionRecapsHint
        }
    }
}

/// The card Settings' header opens on iOS — ChatGPT's edit-profile card, with only what an Orbit
/// account has. The avatar is the name's first letter, so the name is the whole profile; the email is
/// the sign-in and is not changed here.
public enum ProfileEdit {
    /// What the card will do to the photo on Save: nothing, put this one in its place, or take it away.
    public enum Photo: Equatable, Sendable {
        case unchanged
        /// A square JPEG, already cropped and scaled.
        case replaced(Data)
        case removed
    }

    /// One write Save makes, in the order it makes them.
    public enum Step: Equatable, Sendable {
        case setPhoto(Data)
        case removePhoto
        case rename(String)
    }

    /// The name as it is sent: without the spaces around it.
    public static func name(_ draft: String) -> String {
        draft.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// Save is live once the draft names someone, and it changes something: a name other than the
    /// account's, or the photo.
    public static func canSave(_ draft: String, saved: String?, photo: Photo = .unchanged) -> Bool {
        let name = name(draft)
        return !name.isEmpty && (name != saved || photo != .unchanged)
    }

    /// What Save writes: the photo first, then the name — each only when it changed. A step that
    /// lands is the account's from then on, so a Save that fails part way leaves only the rest to do.
    public static func steps(_ draft: String, saved: String?, photo: Photo) -> [Step] {
        guard canSave(draft, saved: saved, photo: photo) else { return [] }
        var steps: [Step] = []
        switch photo {
        case .unchanged: break
        case .replaced(let jpeg): steps.append(.setPhoto(jpeg))
        case .removed: steps.append(.removePhoto)
        }
        let name = name(draft)
        if name != saved { steps.append(.rename(name)) }
        return steps
    }
}

/// Where a round profile photo is cut from, as the crop screen frames it: the photo covers the circle
/// at least (zoom 1), zooms in to `maxZoom`, and moves only as far as keeps the circle on the photo.
/// Offsets are in screen points, from the circle's centre to the photo's.
public enum AvatarCrop {
    public static let maxZoom: CGFloat = 5

    /// The photo's size on screen at zoom 1: just covering a circle of that diameter.
    public static func fitted(_ image: CGSize, circle: CGFloat) -> CGSize {
        guard image.width > 0, image.height > 0 else { return .zero }
        let k = max(circle / image.width, circle / image.height)
        return CGSize(width: image.width * k, height: image.height * k)
    }

    public static func clampedZoom(_ zoom: CGFloat) -> CGFloat { min(max(zoom, 1), maxZoom) }

    /// The offset, moved back inside what keeps the circle on the photo at that zoom.
    public static func clampedOffset(_ offset: CGSize, fitted: CGSize, circle: CGFloat, zoom: CGFloat) -> CGSize {
        let slackX = max(0, (fitted.width * zoom - circle) / 2)
        let slackY = max(0, (fitted.height * zoom - circle) / 2)
        return CGSize(width: min(max(offset.width, -slackX), slackX),
                      height: min(max(offset.height, -slackY), slackY))
    }

    /// The square of the photo, in the photo's own points, that the circle covers.
    public static func cropRect(image: CGSize, circle: CGFloat, zoom: CGFloat, offset: CGSize) -> CGRect {
        let fitted = fitted(image, circle: circle)
        guard fitted.width > 0 else { return .zero }
        let shown = CGSize(width: fitted.width * zoom, height: fitted.height * zoom)
        let k = shown.width / image.width   // screen points per photo point
        return CGRect(x: (shown.width / 2 - offset.width - circle / 2) / k,
                      y: (shown.height / 2 - offset.height - circle / 2) / k,
                      width: circle / k, height: circle / k)
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
    public static let sessionFinishedHint = "Alert your devices when a session you started finishes on its own or fails for good. Task, coordinator and agent-started sessions stay quiet; Project done still rings."
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

    // MARK: Default permission (the web page's Session defaults card)

    /// What the mode is for, as the web says it under its "Default permission mode" — the footer of
    /// the row on iOS' Sessions page.
    public static let defaultPermissionHint = "The mode a new session starts in, unless the composer picks another. Account-wide: the mode is a property of the run, not of the workspace it runs in."

    // MARK: Session orchestration (the web page's card)

    /// The account's one switch, where a form has room to label and explain it (macOS). On iOS' Sessions
    /// page the row is the switch, under the row's own name, and the hint is its footer.
    public static let letSessionsOrchestrate = "Let sessions orchestrate"
    public static let letSessionsOrchestrateHint = "Sessions in every workspace can start and manage other sessions, and manage your agents and runners, through the orbit MCP tools and CLI: create, change and delete agents, install engines on runners and delete them. Off → those tools are hidden and refused."

    // MARK: Smart model selection (the web page's Session defaults card)

    /// The account's master switch for smart model selection, on unless turned off. On iOS' Sessions
    /// page the row is the switch and the hint its footer.
    public static let smartModelSelection = "Route by tier"
    public static let smartModelSelectionHint = "Coordinators suggest a tier for each task, and a SubAgent's size sets its own. Task runs and SubAgents run on a model of that tier from your providers. Off: tasks keep their Agent's model and SubAgents their parent session's."

    // MARK: Optimize For (board docs/mocks/routing-mode-account, approved 2026-11-19)

    /// The account's one routing pick, directly under Route by tier (Smart model selection until 2026-11-22).
    public static let optimizeFor = "Optimize For"
    public static let optimizeForHint = "What to favour when a model is picked at a tier."

    // MARK: Suggested replies (the web page's Session defaults card)

    /// The account's switch for the engine's guess at the next message, on unless turned off. On iOS'
    /// Sessions page the row is the switch and the hint its footer, as smart model selection's is.
    public static let suggestedReplies = "Suggested replies"
    public static let suggestedRepliesHint = "When a Claude turn ends, the empty message box offers what you'd probably type next. Each suggestion is one more request on that session's Claude account."

    // MARK: Session recaps (the web page's Session defaults card)

    /// The account's switch for the server's rolling recap — the line on a session's list row and the
    /// Recap card its conversation ends with — on unless turned off. On iOS' Sessions page the row is
    /// the switch and the hint its footer, as its two neighbours'.
    public static let sessionRecaps = "Session recaps"
    public static let sessionRecapsHint = "Session lists show the one-line summary the server writes for each conversation, in place of its raw last reply, and the conversation ends with it. Off: the raw last reply, and no summary in the conversation."

    // MARK: Change password (the web's Profile page)

    public static let currentPassword = "Current password"
    public static let newPassword = "New password"
    public static let confirmPassword = "Confirm new password"
    public static let passwordRule = "At least 6 characters"
    public static let passwordsDoNotMatch = "Passwords do not match"
    public static let changePassword = "Change password"
    public static let passwordChanged = "Password changed"

    // MARK: Edit profile (the card Settings' header opens)

    /// What the header does, for VoiceOver: the avatar and name are the button.
    public static let editProfile = "Edit profile"
    /// Over the field — the web Profile page's word for it.
    public static let nameLabel = "Name"
    public static let namePlaceholder = "Your name"
    /// Who sees the name besides its owner: the people in their shared pools, on the member list and
    /// beside each key given. A public link never shows it.
    public static let nameCaption = "People in your shared pools see you by this name."
    public static let saveProfile = "Save profile"
    public static func nameNotSaved(_ reason: String) -> String { "Couldn't save your name — \(reason)." }
    /// The photo's actions. On iOS they are the menu the card's avatar opens, as ChatGPT's is: the
    /// library, the camera (a phone's alone) or Files, and — when there is a photo — taking it away.
    /// The web Profile page and macOS Settings choose a file, in `choosePhoto`'s words.
    public static let photoLibrary = "Photo library"
    public static let takePhoto = "Take photo"
    public static let chooseFile = "Choose file"
    public static let choosePhoto = "Choose photo"
    public static let removePhoto = "Remove photo"
    /// The crop screen's button: the circle's square becomes the card's photo, until Save profile.
    public static let savePhoto = "Save"
    public static func photoNotSaved(_ reason: String) -> String { "Couldn't save your photo — \(reason)." }

    // MARK: Sign out

    public static let signOut = "Sign out"
    /// The question the confirmation asks. It names nothing: the server (`orbitd.io`) is the app's
    /// business rather than the person's — ChatGPT's own log out names the account, and this screen
    /// already shows that one row up, so the question would only repeat it.
    public static let signOutTitle = "Sign out?"
}
