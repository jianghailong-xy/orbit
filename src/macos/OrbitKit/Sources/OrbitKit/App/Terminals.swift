import Foundation

/// The approve-terminal card and the machine page's Terminals on iOS and macOS — web's `lib/terminals.ts`,
/// word for word (`TerminalsTests` reads the words back out of it).
public enum Terminals {
    // MARK: The approve card (board 2, marker 7)

    public static let approveTitle = "Approve a terminal?"
    public static let approveDetail = "It can start sessions in your workspaces on this machine and answer their approval cards for 30 days. You can revoke it on this machine's page in Settings."
    public static let deny = "Deny"
    public static let approve = "Approve"

    /// "Terminal on dev-laptop · code 7KQ-4MZ": the code is the one the terminal shows, compared by eye.
    public static func requestLine(_ request: TerminalRequest) -> String {
        "Terminal on \(request.machineName) · code \(request.userCode)"
    }

    // MARK: Where a waiting terminal is drawn
    // (docs/mocks/waiting-on-you-removal/02-terminal-approvals.html)

    /// The machine page's section of approve cards, and its note.
    public static let toApprove = "Terminals to approve"
    public static let requestLasts = "A request lasts 10 minutes"
    /// The session list's section over its line.
    public static let needsYou = "Needs you"
    /// What a press says once the server recorded it (board ② choice 3).
    public static let approvedToast = "Terminal approved"
    public static let deniedToast = "Terminal denied"
    /// What a screen reader hears for the needs-you line, and what a press goes to.
    public static let needsYouHint = "Opens the terminals waiting on you"

    /// "Approve a terminal", or "Approve 2 terminals" (board ③ choice 5).
    public static func approveNeedsYou(count: Int) -> String {
        count == 1 ? "Approve a terminal" : "Approve \(count) terminals"
    }

    /// What a toast over a newly waiting terminal says (the owner, 2026-11-16: the resident needs-you
    /// bar is gone, so each request is announced once, as a toast): "Approve a terminal", over the
    /// machine and the code it shows — the same words the approve card and the Mac list's line use.
    public static let toastTitle = "Approve a terminal"

    /// The notices for the requests that have started waiting since `seen` (the ids of the last look),
    /// oldest first — at most one per request, so answering one and reading again never repeats a
    /// request that is still in the list. Expired requests are not announced: they wait on nobody.
    public static func newNotices(_ requests: [TerminalRequest], seen: Set<String>,
                                  now: Date = Date()) -> [NeedsYouToast] {
        liveRequests(requests, now: now)
            .filter { !seen.contains($0.id) }
            .map { request in
                NeedsYouToast(id: request.id, target: nil, title: toastTitle,
                              line: needsYouDetail([request]), ownerItem: nil, terminal: request)
            }
    }

    /// The needs-you line's second line: one request names its machine and code
    /// ("dev-laptop · code 7KQ-4MZ"); several on one machine count ("dev-laptop · 2 waiting");
    /// several machines are named, oldest first ("dev-laptop, build-box").
    public static func needsYouDetail(_ requests: [TerminalRequest]) -> String {
        guard let first = requests.first else { return "" }
        if requests.count == 1 { return "\(first.machineName) · code \(first.userCode)" }
        var machines: [String] = []
        for request in requests where !machines.contains(request.machineName) {
            machines.append(request.machineName)
        }
        return machines.count == 1 ? "\(machines[0]) · \(requests.count) waiting"
                                   : machines.joined(separator: ", ")
    }

    /// The requests still answerable at `now`, oldest first: the server's own rule
    /// (`expiresAt > now`), so a card folds at its deadline rather than at the next read
    /// (board ② choice 4). The server's 404 stays the fallback.
    public static func liveRequests(_ requests: [TerminalRequest], now: Date = Date()) -> [TerminalRequest] {
        requests
            .filter { request in
                guard let expires = RelativeTime.parse(request.expiresAt) else { return true }
                return expires > now
            }
            .sorted { a, b in
                let left = RelativeTime.parse(a.createdAt) ?? .distantPast
                let right = RelativeTime.parse(b.createdAt) ?? .distantPast
                return left == right ? a.id < b.id : left < right
            }
    }

    /// The requests on one machine.
    public static func requests(_ requests: [TerminalRequest], on runnerID: String) -> [TerminalRequest] {
        requests.filter { PublicID.toPublic($0.runnerId) == PublicID.toPublic(runnerID) }
    }

    /// When the earliest live request stops being answerable, so a surface can redraw on time.
    public static func nextDeadline(_ requests: [TerminalRequest], after now: Date = Date()) -> Date? {
        liveRequests(requests, now: now)
            .compactMap { RelativeTime.parse($0.expiresAt) }
            .filter { $0 > now }
            .min()
    }

    // MARK: The machine page's Terminals (docs/mocks/terminals-on-machine-page/01-board.html ②③)

    public static let title = "Terminals"
    public static let machineHint = "Terminals on this machine where you typed orbit and approved it. Each one can start sessions here and answer their approval cards until it expires."
    public static let revoke = "Revoke"
    public static let revokeDetail = "It stops working at once. Typing orbit there asks you to approve it again."
    public static let revoked = "Terminal revoked"
    public static let couldNotRevoke = "Couldn't revoke the terminal"
    public static let couldNotLoad = "Couldn’t load your terminals:"

    /// "Revoke the terminal on dev-laptop?"
    public static func revokeTitle(_ terminal: Terminal) -> String { "Revoke the terminal on \(terminal.machineName)?" }

    /// "Couldn't revoke the terminal: the connection dropped".
    public static func notRevoked(_ reason: String) -> String { "\(couldNotRevoke): \(reason)" }

    /// `runnerID`'s live terminals, newest approval first (board ②) — the machine page's own list,
    /// as web's `machineTerminals` and Android's `Terminals.on`.
    public static func machineTerminals(_ terminals: [Terminal], on runnerID: String) -> [Terminal] {
        terminals
            .filter { PublicID.toPublic($0.runnerId) == PublicID.toPublic(runnerID) }
            .sorted { a, b in
                let left = RelativeTime.parse(a.approvedAt) ?? .distantPast
                let right = RelativeTime.parse(b.approvedAt) ?? .distantPast
                return left == right ? a.id > b.id : left > right
            }
    }

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

    /// "Last used 3m ago · Expires Dec 12, 2026 · in 30 days": the row's second line (board ③).
    public static func usedAndExpiresLine(_ terminal: Terminal, now: Date) -> String {
        "\(lastUsedLine(terminal, now: now)) · \(expiresLine(terminal, now: now))"
    }
}

/// The needs-you bar's line for waiting terminals (board ③), and what a press opens: the oldest
/// request leads, because a request lives ten minutes, and Machines & models lights that card.
public struct TerminalNeedsYou: Equatable, Sendable {
    /// How many terminals are asking.
    public let count: Int
    /// The request that has waited longest — the card a press lights.
    public let oldest: TerminalRequest
    /// "Approve a terminal", or "Approve 2 terminals".
    public let text: String
    /// "dev-laptop · code 7KQ-4MZ", or where several wait.
    public let detail: String
    /// Since when the oldest has waited, the ISO instant the age is read from.
    public let since: String

    /// The terminal is the mark the bar draws.
    public var glyph: NeedsYouGlyph { .terminal }

    public init(count: Int, oldest: TerminalRequest, text: String, detail: String, since: String) {
        self.count = count
        self.oldest = oldest
        self.text = text
        self.detail = detail
        self.since = since
    }

    /// The live line for `requests`, or nil when nothing waits.
    public static func banner(_ requests: [TerminalRequest], now: Date = Date()) -> TerminalNeedsYou? {
        let live = Terminals.liveRequests(requests, now: now)
        guard let oldest = live.first else { return nil }
        return TerminalNeedsYou(count: live.count, oldest: oldest,
                                text: Terminals.approveNeedsYou(count: live.count),
                                detail: Terminals.needsYouDetail(live), since: oldest.createdAt)
    }
}
