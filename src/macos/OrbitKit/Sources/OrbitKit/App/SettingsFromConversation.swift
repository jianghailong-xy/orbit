import Foundation

/// Settings from a conversation, on the Apple clients (docs/settings-from-conversation-design.md §8): the words of a
/// SETTINGS_CHANGE card, of an `orbit-settings:` link card and of a changed Settings row, and the rules with no view
/// in them — where a setting is in Settings and how a value reads there. Web parity: `lib/settingsChange.ts`,
/// `components/SettingsChangeCard.tsx`, `SettingsLinkCard.tsx`, `settings/SettingChangedLine.tsx`.
public enum SettingsChangeCopy {
    public static func heading(_ count: Int) -> String { "⚙️ Confirm: change \(count) setting\(count == 1 ? "" : "s")?" }
    public static let newSessionsOnly = "Applies to new sessions only."
    public static func agentSays(_ why: String) -> String { "The agent says: \(why)" }
    public static let foot = "Only these change. You can change them back in Settings."
    public static let save = "Save changes"
    public static let chat = "💬 Chat about this"
    public static let declinePlaceholder = "What should the agent know? It reads this."
    public static let decline = "Decline"
    public static let keep = "Keep it"
    public static func changed(_ count: Int) -> String { "✓ Changed \(count) setting\(count == 1 ? "" : "s")" }
    public static let undo = "Undo"
    public static let undone = "Undone"
    public static let declined = "Declined"
    public static let stale = "This setting changed since it was proposed."
    public static let openInSettings = "Open in Settings"
    public static let turnedOn = "Turned on from"
    public static let turnedOff = "Turned off from"
    public static let setFrom = "Set from"
    public static let aConversation = "a conversation"
    public static let untitledConversation = "Untitled conversation"
}

/// One change on a card, as the request's payload holds it (`{changes: [{key, from, to, tier}]}`).
public struct SettingsChangeEntry: Equatable, Sendable {
    public let key: String
    public let from: JSONValue
    public let to: JSONValue
    public let tier: Int
    public init(key: String, from: JSONValue, to: JSONValue, tier: Int) {
        self.key = key
        self.from = from
        self.to = to
        self.tier = tier
    }
}

/// One setting's mark from `GET /users/me` (design §5.3): the conversation it was changed from, when, and what it was.
public struct SettingChangedBy: Codable, Equatable, Sendable {
    public let sessionId: String
    public let requestId: String
    public let at: String
    public let from: JSONValue?
    public let sessionTitle: String?

    public init(sessionId: String, requestId: String, at: String, from: JSONValue? = nil, sessionTitle: String? = nil) {
        self.sessionId = sessionId
        self.requestId = requestId
        self.at = at
        self.from = from
        self.sessionTitle = sessionTitle
    }

    private enum CodingKeys: String, CodingKey { case sessionId, requestId, at, from, sessionTitle }

    /// Read leniently: a mark this build cannot read costs the one line, never the account.
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        sessionId = (try? c.decodeIfPresent(String.self, forKey: .sessionId)) ?? ""
        requestId = (try? c.decodeIfPresent(String.self, forKey: .requestId)) ?? ""
        at = (try? c.decodeIfPresent(String.self, forKey: .at)) ?? ""
        from = (try? c.decodeIfPresent(JSONValue.self, forKey: .from)) ?? nil
        sessionTitle = (try? c.decodeIfPresent(String.self, forKey: .sessionTitle)) ?? nil
    }
}

/// A Settings row, found by its link name or by the preference key it writes.
public struct SettingPlace: Equatable, Sendable {
    public let key: String
    public let title: String
    /// The page of Settings on the phone that holds the row; nil for a row on Settings' own list (Theme).
    public let page: SettingsPage?
    /// The web page's name and the section under it, for the `Settings › General › Translation` line.
    public let webPage: String
    public let section: String?
}

public enum SettingsFromConversation {
    private static let rows: [String: SettingPlace] = {
        func row(_ key: String, _ title: String, _ page: SettingsPage?, _ webPage: String, _ section: String?)
            -> (String, SettingPlace) {
            (key, SettingPlace(key: key, title: title, page: page, webPage: webPage, section: section))
        }
        return Dictionary(uniqueKeysWithValues: [
            row("theme", "Theme", nil, "Appearance", nil),
            row("translationEnabled", "Translate conversations", .general, "General", "Translation"),
            row("translationLanguage", "Your language", .general, "General", "Translation"),
            row("translationAgentLanguage", "Agents work in", .general, "General", "Translation"),
            row("translationBilingual", "Show both languages", .general, "General", "Translation"),
            row("notifySessionFinished", "When a session finishes", .notifications, "Notifications", nil),
            row("notifyAgentMessage", "When an agent asks for you", .notifications, "Notifications", nil),
            row("recaps", "Session recaps", .general, "General", "New sessions"),
            row("promptSuggestions", "Suggested replies", .general, "General", "New sessions"),
            row("promptOptimizer", "Prompt optimizer", .general, "General", "New sessions"),
            row("modelRouting", "Route by tier", .general, "General", "New sessions"),
            row("optimizeFor", "Optimize For", .general, "General", "New sessions"),
            row("defaultPermissionMode", "Default permission mode", .general, "General", "New sessions"),
            row("enableOrchestration", "Let sessions orchestrate", .general, "General", "Orchestration"),
            row("cardFreeTaskCreates", "Tasks a session files without asking", .general, "General", "Orchestration"),
        ])
    }()

    /// The keys with no row of their own in Settings (the composer's defaults, the SubAgent providers list), by title.
    private static let rowless: [String: String] = [
        "defaultModel": "Default model",
        "defaultModels": "Default model per provider",
        "defaultEffort": "Default effort",
        "subagentBlockedProviders": "SubAgent providers",
        "relaxBlockedPins": "Run pinned tasks elsewhere when their account can't run",
    ]

    /// The row an `orbit-settings:` link or a key names, in either spelling the web takes (`agentLanguage` is the
    /// row's anchor, `translationAgentLanguage` its key). Nil for a name with no row in Settings.
    public static func place(_ name: String) -> SettingPlace? {
        rows[name == "agentLanguage" ? "translationAgentLanguage" : name]
    }

    /// A key's title as the card shows it, row or not.
    public static func title(_ key: String) -> String { place(key)?.title ?? rowless[key] ?? key }

    /// `Settings › General › Translation`: where a row is, as the card and the link card name it.
    public static func pathLabel(_ place: SettingPlace) -> String {
        ["Settings", place.webPage, place.section].compactMap { $0 }.joined(separator: " › ")
    }

    /// A key's place as the card names it, or nil for a key with no Settings row.
    public static func pathLabel(forKey key: String) -> String? { place(key).map(pathLabel) }

    /// The changes a SETTINGS_CHANGE request carries, in the order filed. Entries naming no known key are left out.
    public static func entries(_ payload: JSONValue?) -> [SettingsChangeEntry] {
        guard case .array(let changes)? = payload?["changes"] else { return [] }
        return changes.compactMap { change in
            guard let key = change["key"]?.stringValue, place(key) != nil || rowless[key] != nil else { return nil }
            return SettingsChangeEntry(key: key, from: change["from"] ?? .null, to: change["to"] ?? .null,
                                       tier: change["tier"]?.intValue ?? 1)
        }
    }

    /// Consecutive rows on the same Settings page share one path line; a key with no row of its own has none.
    public static func groups(_ entries: [SettingsChangeEntry]) -> [(path: String?, entries: [SettingsChangeEntry])] {
        var out: [(path: String?, entries: [SettingsChangeEntry])] = []
        for entry in entries {
            let path = pathLabel(forKey: entry.key)
            if let last = out.last, last.path == path {
                out[out.count - 1].entries.append(entry)
            } else {
                out.append((path: path, entries: [entry]))
            }
        }
        return out
    }

    /// A value as the Settings page shows it: `Chinese (Simplified)`, not `zh-Hans`; `On`, not `true`.
    public static func valueLabel(_ key: String, _ value: JSONValue) -> String {
        if case .bool(let on) = value { return on ? "On" : "Off" }
        switch key {
        case "translationLanguage", "translationAgentLanguage":
            if let raw = value.stringValue, let language = TranslationLanguage(rawValue: raw) { return language.name }
        case "theme":
            switch value.stringValue {
            case "system": return "System"
            case "light": return "Light"
            case "dark": return "Dark"
            default: break
            }
        case "optimizeFor":
            if let raw = value.stringValue, let pick = OptimizeFor(rawValue: raw) { return pick.label }
        case "defaultPermissionMode":
            if let raw = value.stringValue, let mode = PermissionMode(rawValue: raw) { return AgentDefaults.label(mode) }
        case "defaultEffort":
            return value.asString.flatMap { $0.isEmpty ? nil : $0 } ?? "Engine default"
        case "defaultModel":
            return value.asString.flatMap { $0.isEmpty ? nil : $0 } ?? "None"
        case "defaultModels":
            if case .object(let models) = value, !models.isEmpty {
                return models.keys.sorted().map { "\($0): \(models[$0]?.asString ?? "")" }.joined(separator: ", ")
            }
            return "None"
        case "subagentBlockedProviders":
            if case .array(let providers) = value, !providers.isEmpty {
                return providers.compactMap(\.asString).joined(separator: ", ")
            }
            return "None"
        default: break
        }
        if case .null = value { return "Default" }
        return value.asString ?? "Default"
    }

    // MARK: the changed Settings row

    /// The first words of a changed row's line: a switch was turned on or off; any other value was set.
    public static func changedLead(_ mark: SettingChangedBy) -> String {
        guard case .bool(let was)? = mark.from else { return SettingsChangeCopy.setFrom }
        return was ? SettingsChangeCopy.turnedOff : SettingsChangeCopy.turnedOn
    }

    /// The conversation's name on the line: its title, `Untitled conversation`, or `a conversation` when the server
    /// no longer knows the session.
    public static func changedConversation(_ mark: SettingChangedBy) -> String {
        guard let title = mark.sessionTitle else { return SettingsChangeCopy.aConversation }
        return title.isEmpty ? SettingsChangeCopy.untitledConversation : title
    }

    /// `Turned on from <conversation> · 2m ago · ` — everything before the Undo button.
    public static func changedLine(_ mark: SettingChangedBy, now: Date = Date()) -> String {
        let when = RelativeTime.ago(mark.at, now: now).map { " · \($0)" } ?? ""
        return "\(changedLead(mark)) \(changedConversation(mark))\(when) · "
    }

    // MARK: Undo

    /// The PATCH body that puts back what the card replaced: each key this request still marks, with its `from`
    /// (§5.3). A setting the owner changed since carries no mark of this request and is left alone.
    public static func undoBody(request: OwnerRequest, user: User?) -> [String: JSONValue] {
        var body: [String: JSONValue] = [:]
        for entry in entries(request.payload) {
            guard let mark = user?.changedBy?[entry.key],
                  PublicID.storageKey(mark.requestId) == PublicID.storageKey(request.id) else { continue }
            body[entry.key] = entry.from
        }
        return body
    }

    /// Whether an apply was refused because a value moved since it was proposed (`409 SETTINGS_STALE`).
    public static func isStale(_ error: Error) -> Bool {
        guard case APIError.http(let status, let body)? = error as? APIError, status == 409 else { return false }
        return body?.contains("SETTINGS_STALE") == true
    }
}
