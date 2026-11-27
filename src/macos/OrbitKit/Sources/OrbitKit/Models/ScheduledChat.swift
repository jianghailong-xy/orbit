import Foundation

// The Scheduled page's chat (docs/scheduled-chat-design.md §3, §4; src/shared/src/schedule.ts `SchedulePageChat*`):
// `GET /schedules/chat` reads the account's open page chat and Orbit's opening for a new one, `POST /schedules/chat`
// opens one with the person's first words, and each later message carries the page's view as `context`. Every field an
// older server may leave out decodes to its empty value.

/// Orbit's opening (§4.1): the counts and the next run, the examples, and what applies at once. Drawn by the server.
public struct SchedulePageChatOpening: Codable, Equatable, Sendable {
    /// "You have 4 scheduled tasks: 2 active, 2 paused, none failing."
    public let summary: String
    /// "Next: Engine version bump, tomorrow at 06:00 on orbit-ws01.", or nil when nothing is due.
    public let nextText: String?
    public let examplesLead: String
    public let examples: [String]
    public let closing: String

    public init(summary: String, nextText: String? = nil, examplesLead: String = "", examples: [String] = [],
                closing: String = "") {
        self.summary = summary
        self.nextText = nextText
        self.examplesLead = examplesLead
        self.examples = examples
        self.closing = closing
    }

    private enum CodingKeys: String, CodingKey { case summary, nextText, examplesLead, examples, closing }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        summary = try c.decodeIfPresent(String.self, forKey: .summary) ?? ""
        nextText = try c.decodeIfPresent(String.self, forKey: .nextText)
        examplesLead = try c.decodeIfPresent(String.self, forKey: .examplesLead) ?? ""
        examples = try c.decodeIfPresent([String].self, forKey: .examples) ?? []
        closing = try c.decodeIfPresent(String.self, forKey: .closing) ?? ""
    }
}

/// `GET /schedules/chat`: the account's open page chat, if any, and the opening a new one starts with.
public struct SchedulePageChatResponse: Codable, Equatable, Sendable {
    public let sessionId: String?
    public let opening: SchedulePageChatOpening

    public init(sessionId: String?, opening: SchedulePageChatOpening) {
        self.sessionId = sessionId
        self.opening = opening
    }
}

/// `POST /schedules/chat {text, workspaceId}`: the person's first words open the chat in that workspace.
public struct SchedulePageChatOpenRequest: Codable, Equatable, Sendable {
    public let workspaceId: String
    public let text: String

    public init(workspaceId: String, text: String) {
        self.workspaceId = workspaceId
        self.text = text
    }
}

/// The chat the words went to, and whether this request made it (`created: false`: said in the open one).
public struct SchedulePageChatOpenAnswer: Codable, Equatable, Sendable {
    public let sessionId: String
    public let created: Bool

    public init(sessionId: String, created: Bool) {
        self.sessionId = sessionId
        self.created = created
    }

    private enum CodingKeys: String, CodingKey { case sessionId, created }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        sessionId = try c.decode(String.self, forKey: .sessionId)
        created = try c.decodeIfPresent(Bool.self, forKey: .created) ?? false
    }
}

/// What a page chat's message carries of the page (§2.4, §4.2): the workspace the list is filtered to and the schedule
/// whose chip is on, ids alone. Sent as `context` on the turn and resume doors; nil leaves it out.
public struct SchedulePageChatContext: Codable, Equatable, Sendable {
    public let scheduleFilter: String?
    public let scheduleId: String?

    public init(scheduleFilter: String? = nil, scheduleId: String? = nil) {
        self.scheduleFilter = scheduleFilter
        self.scheduleId = scheduleId
    }
}
