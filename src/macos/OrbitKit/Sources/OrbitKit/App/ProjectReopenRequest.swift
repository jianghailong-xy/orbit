import Foundation

/// The PROJECT_REOPEN owner request on the Apple clients (docs/project-reopen-request-design.md §6): an agent asking the
/// owner to reopen a settled project. The words of its card and the rules over its payload, with no view in them.
/// Web parity: the card the web draws from the same fields.
public enum ProjectReopenCopy {
    public static func title(_ projectTitle: String) -> String { "↺ Reopen project “\(projectTitle)”?" }
    public static let whyLabel = "Why"
    public static let plannedWorkLabel = "Planned work"
    public static func agentSays(_ why: String) -> String { "The agent says: \(why)" }
    public static let reopen = "Reopen"
    public static let chat = "💬 Chat about this"
    public static let declinePlaceholder = "What should the agent know? It reads this."
    public static let decline = "Decline"
    public static let keep = "Keep it"
    public static let projectPageRow = "An agent asked to reopen this project"
    public static let declined = "Declined"

    /// "DONE since Nov 18" / "Cancelled since Nov 18".
    public static func settledLine(status: String?, settledAt: String?) -> String {
        let word = status == "CANCELLED" ? "Cancelled" : "DONE"
        guard let settledAt, let date = RelativeTime.parse(settledAt) else { return word }
        return "\(word) since \(monthDay(date))"
    }

    /// "Asked by <session>" outside that session; nil when no title is known.
    public static func askedBy(_ title: String?) -> String? {
        guard let title, !title.isEmpty else { return nil }
        return "Asked by \(title)"
    }

    /// "Also asked by A, B" for the askers after the first; nil for a lone asker.
    public static func alsoAskedBy(_ titles: [String]) -> String? {
        titles.isEmpty ? nil : "Also asked by \(titles.joined(separator: ", "))"
    }

    /// The collapsed line once answered: "Reopened · Nov 23 14:02" or "Declined: <reason>".
    public static func outcomeLine(_ request: OwnerRequest) -> String {
        switch request.state {
        case .declined:
            let note = request.resolutionNote?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            return note.isEmpty ? declined : "Declined: “\(note)”"
        case .done:
            guard let at = request.resolvedAt, let date = RelativeTime.parse(at) else { return "Reopened" }
            return "Reopened · \(monthDay(date)) \(clock(date))"
        case .expired: return "Expired before anyone answered"
        case .withdrawn:
            let note = request.resolutionNote?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            return note.isEmpty ? "Withdrawn" : "Withdrawn: “\(note)”"
        case .pending: return ""
        }
    }

    private static func monthDay(_ date: Date) -> String { format("MMM d", date) }
    private static func clock(_ date: Date) -> String { format("HH:mm", date) }
    private static func format(_ pattern: String, _ date: Date) -> String {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = pattern
        return f.string(from: date)
    }
}

/// What a PROJECT_REOPEN request's payload holds: `{projectId, statusAtAsk, settledAt, plannedWork, askers}`.
public struct ProjectReopenFacts: Equatable, Sendable {
    public struct Asker: Equatable, Sendable {
        public let sessionId: String
        public let title: String?
    }
    public let projectId: String
    public let statusAtAsk: String?
    public let settledAt: String?
    public let plannedWork: String
    public let askers: [Asker]

    /// Nil for a request that is not a PROJECT_REOPEN or whose payload names no project.
    public init?(_ request: OwnerRequest) {
        guard request.kind == .projectReopen, let payload = request.payload,
              let projectId = payload["projectId"]?.stringValue ?? request.projectId else { return nil }
        self.projectId = projectId
        statusAtAsk = payload["statusAtAsk"]?.stringValue
        settledAt = payload["settledAt"]?.stringValue
        plannedWork = payload["plannedWork"]?.stringValue ?? ""
        if case .array(let rows)? = payload["askers"] {
            askers = rows.compactMap { row in
                row["sessionId"]?.stringValue.map { Asker(sessionId: $0, title: row["title"]?.stringValue) }
            }
        } else {
            askers = []
        }
    }

    /// The titles of the askers after the one whose card this is.
    public func otherAskerTitles(besides sessionId: String) -> [String] {
        askers.filter { $0.sessionId != sessionId }.compactMap { $0.title }.filter { !$0.isEmpty }
    }
}

extension OwnerRequests {
    /// The pending PROJECT_REOPEN requests of one project, newest first: what its page draws as its row.
    public static func pendingReopens(_ requests: [OwnerRequest], projectID: String) -> [OwnerRequest] {
        let key = PublicID.storageKey(projectID)
        return requests.filter {
            $0.kind == .projectReopen && $0.state == .pending
                && ProjectReopenFacts($0).map { PublicID.storageKey($0.projectId) == key } == true
        }
    }
}
