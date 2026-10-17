import Foundation

/// Settings → Access tokens on iOS and macOS: the personal access tokens this account has issued,
/// filed by whether they still work — web's `AccessTokensPage`, `AccessTokenTable` and
/// `lib/accessTokens.ts`, word for word wherever the web says the same thing
/// (`SettingsCopyParityTests` reads the words back out of them). The apps list and revoke; a token
/// is issued on the web only (docs/personal-access-token-design.md §9), so the one thing only the
/// apps say is where to go for a new one.
public enum AccessTokensList {
    public enum Tab: String, CaseIterable, Sendable, Identifiable {
        case active, ended

        public var id: String { rawValue }

        public var label: String {
            switch self {
            case .active: return "Active"
            case .ended:  return "Revoked & expired"
            }
        }

        /// What the tab says when it holds nothing.
        public var empty: String {
            switch self {
            case .active: return "No active tokens. Create one to use the API or the orbit CLI as yourself."
            case .ended:  return "No token has been revoked or has expired."
            }
        }
    }

    public static let title = "Access tokens"
    public static let subtitle = "Let your scripts and the orbit CLI use the Orbit API as you, with only the access you give each token. Treat a token like a password."
    /// Where the web page has its New token button: the apps never issue one (§9).
    public static let issuedOnTheWeb = "New tokens are created in Settings → Access tokens on the web."
    public static let couldNotLoad = "Couldn’t load your tokens:"

    // Revoking asks first: anything using the token stops working at once.
    public static let revoke = "Revoke"
    public static let revokeDetail = "Anything using it stops working at once. This can’t be undone."
    public static let revoked = "Token revoked"
    public static let couldNotRevoke = "Couldn't revoke the token"

    public static func revokeTitle(_ token: AccessToken) -> String { "Revoke “\(token.name)”?" }

    /// "Couldn't revoke the token: the connection dropped".
    public static func notRevoked(_ reason: String) -> String { "\(couldNotRevoke): \(reason)" }

    /// The tokens in one tab, newest first as the server answered them: Active holds the ones that
    /// work, the other tab every one that stopped.
    public static func tokens(_ all: [AccessToken], in tab: Tab) -> [AccessToken] {
        all.filter { ($0.state == .active) == (tab == .active) }
    }

    /// Only a token that still works has anything left to revoke.
    public static func canRevoke(_ token: AccessToken) -> Bool {
        token.state == .active
    }

    /// "orbit_pat_…k3Fq" — enough of the token to tell it from the others. Orbit never has more.
    public static func hint(_ token: AccessToken) -> String {
        "orbit_pat_…\(token.tokenHint)"
    }

    // MARK: - What it can reach

    /// One resource a token can be granted, and its two scopes — the server's PAT_SCOPES (§4).
    struct ScopeGroup: Sendable {
        let resource: String
        let read: String
        let write: String?
    }

    /// In the order the web lists them (`SCOPE_GROUPS`).
    static let scopeGroups: [ScopeGroup] = [
        ScopeGroup(resource: "Tasks", read: "tasks:read", write: "tasks:write"),
        ScopeGroup(resource: "Projects", read: "projects:read", write: "projects:write"),
        ScopeGroup(resource: "Sessions", read: "sessions:read", write: "sessions:write"),
        ScopeGroup(resource: "Workspaces", read: "workspaces:read", write: "workspaces:write"),
        ScopeGroup(resource: "Runners", read: "runners:read", write: nil),
        ScopeGroup(resource: "Wiki", read: "wiki:read", write: "wiki:write"),
        ScopeGroup(resource: "Events", read: "events:read", write: nil),
    ]

    static var readScopes: [String] { scopeGroups.map(\.read) }
    static var allScopes: [String] { scopeGroups.flatMap { group in group.write.map { [group.read, $0] } ?? [group.read] } }

    /// A token's scopes in a few words: a preset's name, or what it can do resource by resource —
    /// "Read-only · everything", "Tasks: read & write · Sessions: read".
    public static func scopeSummary(_ scopes: [String]) -> String {
        if sameSet(scopes, allScopes) { return "Read & write · everything" }
        if sameSet(scopes, readScopes) { return "Read-only · everything" }
        let parts = scopeGroups.compactMap { group -> String? in
            let read = scopes.contains(group.read)
            let write = group.write.map(scopes.contains) ?? false
            if read && write { return "\(group.resource): read & write" }
            if read { return "\(group.resource): read" }
            if write { return "\(group.resource): write" }
            return nil
        }
        // Scopes newer than this build are still what the token holds: name them rather than
        // draw an empty line.
        return parts.isEmpty ? scopes.joined(separator: ", ") : parts.joined(separator: " · ")
    }

    /// Which workspaces it reaches: all of them, or those it is confined to — a workspace deleted
    /// since is counted, since its name is gone.
    public static func workspacesLine(_ token: AccessToken) -> String {
        if token.workspaceIds.isEmpty { return "All workspaces" }
        var names = token.workspaces.map(\.name)
        let gone = token.workspaceIds.count - token.workspaces.count
        if gone > 0 { names.append(gone == 1 ? "a deleted workspace" : "\(gone) deleted workspaces") }
        return names.joined(separator: ", ")
    }

    /// What it can do, and where when it is confined: "Read-only · everything",
    /// "Tasks: read & write · in orbit, docs".
    public static func accessLine(_ token: AccessToken) -> String {
        let summary = scopeSummary(token.scopes)
        return token.workspaceIds.isEmpty ? summary : "\(summary) · in \(workspacesLine(token))"
    }

    // MARK: - When it stops

    /// The mark a token that never expires carries in the list (§9, §11.1).
    public static let neverExpires = "Never expires"

    /// A working token with no expiry: the list marks it, since a leak of it lasts until revoked.
    public static func isNeverExpiring(_ token: AccessToken) -> Bool {
        token.state == .active && token.expiresAt == nil
    }

    /// Where it stands on its clock: "Expires Jan 4, 2027 · in 90 days" while it works, "Never
    /// expires" for one that never will, and why one that stopped did ("Revoked Oct 6, 2026").
    public static func expiryLine(_ token: AccessToken, now: Date) -> String {
        guard token.state == .active else { return endedLine(token) }
        guard let expiresAt = token.expiresAt else { return neverExpires }
        let day = fullDate(expiresAt) ?? expiresAt
        return untilLine(expiresAt, now: now).map { "Expires \(day) · \($0)" } ?? "Expires \(day)"
    }

    /// Why a token that no longer works stopped, in the list's words.
    public static func endedLine(_ token: AccessToken) -> String {
        if token.state == .expired {
            guard let day = (token.expiresAt ?? token.revokedAt).flatMap(fullDate) else { return "Expired" }
            return "Expired \(day)"
        }
        let at = token.revokedAt.flatMap(fullDate).map { " \($0)" } ?? ""
        switch token.revokedReason {
        case "ADMIN": return "Revoked by an administrator\(at)"
        case "PASSWORD_CHANGED": return "Revoked with a password change\(at)"
        default: return "Revoked\(at)"
        }
    }

    /// How far off an expiry still ahead is: "in 89 days", "in 5 hours", "in less than an hour".
    public static func untilLine(_ iso: String, now: Date) -> String? {
        guard let at = RelativeTime.parse(iso) else { return nil }
        let hours = (at.timeIntervalSince(now) / 3600).rounded()
        if hours < 1 { return "in less than an hour" }
        if hours < 24 { return hours == 1 ? "in 1 hour" : "in \(Int(hours)) hours" }
        let days = (hours / 24).rounded()
        return days == 1 ? "in 1 day" : "in \(Int(days)) days"
    }

    // MARK: - When it was last used

    public static let neverUsed = "Never used"
    public static let addressUnknown = "Address unknown"

    /// "Last used 3h 20m ago · 203.0.113.7", or "Never used" — the place a lost device's token gives
    /// itself away.
    public static func lastUsedLine(_ token: AccessToken, now: Date) -> String {
        guard let lastUsedAt = token.lastUsedAt else { return neverUsed }
        let when = RelativeTime.ago(lastUsedAt, now: now) ?? "unknown"
        return "Last used \(when) · \(token.lastUsedIp ?? addressUnknown)"
    }

    /// "Oct 6, 2026", the way the web list names a day.
    public static func fullDate(_ iso: String) -> String? {
        RelativeTime.parse(iso).map { day.string(from: $0) }
    }

    private static func sameSet(_ scopes: [String], _ of: [String]) -> Bool {
        scopes.count == of.count && of.allSatisfy(scopes.contains)
    }

    private static let day: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "MMM d, yyyy"
        return f
    }()
}
