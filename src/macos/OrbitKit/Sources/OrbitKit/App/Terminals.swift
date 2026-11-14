import Foundation

/// The approve-terminal card and Settings → Terminals on iOS and macOS — web's `lib/terminals.ts`, word for word
/// (`TerminalsCopyParityTests` reads the words back out of it).
public enum Terminals {
    // MARK: The approve card (board 2, marker 7)

    public static let approveTitle = "Approve a terminal?"
    public static let approveDetail = "It can start sessions in your workspaces on this machine and answer their approval cards for 30 days. You can revoke it in Settings → Terminals."
    public static let deny = "Deny"
    public static let approve = "Approve"

    /// "Terminal on dev-laptop · code 7KQ-4MZ": the code is the one the terminal shows, compared by eye.
    public static func requestLine(_ request: TerminalRequest) -> String {
        "Terminal on \(request.machineName) · code \(request.userCode)"
    }

    // MARK: Settings → Terminals

    public static let title = "Terminals"
    public static let hint = "Terminals where you typed orbit and approved it. Each one can start sessions on its machine and answer their approval cards until it expires."
    public static let empty = "No terminals are signed in."
    public static let revoke = "Revoke"
    public static let revokeDetail = "It stops working at once. Typing orbit there asks you to approve it again."
    public static let revoked = "Terminal revoked"
    public static let couldNotRevoke = "Couldn't revoke the terminal"
    public static let couldNotLoad = "Couldn’t load your terminals:"

    /// "Revoke the terminal on dev-laptop?"
    public static func revokeTitle(_ terminal: Terminal) -> String { "Revoke the terminal on \(terminal.machineName)?" }

    /// "Couldn't revoke the terminal: the connection dropped".
    public static func notRevoked(_ reason: String) -> String { "\(couldNotRevoke): \(reason)" }

    /// "Approved Nov 12, 2026"
    public static func approvedLine(_ terminal: Terminal) -> String {
        "Approved \(AccessTokensList.fullDate(terminal.approvedAt) ?? terminal.approvedAt)"
    }

    /// "Last used 3m ago", or "Never used".
    public static func lastUsedLine(_ terminal: Terminal, now: Date) -> String {
        guard let lastUsedAt = terminal.lastUsedAt else { return "Never used" }
        return "Last used \(RelativeTime.ago(lastUsedAt, now: now) ?? "unknown")"
    }

    /// "Expires Dec 12, 2026 · in 30 days"
    public static func expiresLine(_ terminal: Terminal, now: Date) -> String {
        let day = AccessTokensList.fullDate(terminal.expiresAt) ?? terminal.expiresAt
        return AccessTokensList.untilLine(terminal.expiresAt, now: now).map { "Expires \(day) · \($0)" } ?? "Expires \(day)"
    }

    /// "2 signed in" — Settings' row value.
    public static func settingsValue(count: Int) -> String {
        count > 0 ? "\(count) signed in" : "None"
    }
}
