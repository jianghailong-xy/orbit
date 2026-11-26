import Foundation

/// One person who can reply in a session, as the owner's `GET /sessions/:id/guests` lists them.
/// Mirrors `@orbit/shared`'s `SessionGuestPerson` (docs/session-guests-design.md §3, §7).
public struct SessionGuestPerson: Codable, Equatable, Sendable, Identifiable {
    public let userId: String
    public let name: String
    public let email: String
    public let addedAt: String
    /// The guest's messages to this session since midnight UTC.
    public let messagesToday: Int
    /// Whether the guest has opened the session at least once.
    public let opened: Bool

    public var id: String { userId }

    public init(userId: String, name: String, email: String, addedAt: String,
                messagesToday: Int, opened: Bool) {
        self.userId = userId
        self.name = name
        self.email = email
        self.addedAt = addedAt
        self.messagesToday = messagesToday
        self.opened = opened
    }
}

/// What all three owner routes answer: the people as they now stand.
struct SessionGuestList: Decodable {
    let guests: [SessionGuestPerson]
}

/// Someone the owner has invited before, to any of their sessions, as
/// `GET /sessions/:id/guests/suggestions` offers them to the email field of People who can reply
/// (board docs/mocks/share-links/14-guest-suggestions). Mirrors `@orbit/shared`'s `SessionGuestSuggestion`.
public struct SessionGuestSuggestion: Codable, Equatable, Sendable, Identifiable {
    public let name: String
    public let email: String
    /// The owner's latest invitation of this person, to any session.
    public let lastInvitedAt: String

    public var id: String { email }

    public init(name: String, email: String, lastInvitedAt: String) {
        self.name = name
        self.email = email
        self.lastInvitedAt = lastInvitedAt
    }
}

/// What the suggestions route answers: newest invitation first, people already in the session left out.
struct SessionGuestSuggestionList: Decodable {
    let people: [SessionGuestSuggestion]
}

struct InviteSessionGuestRequest: Encodable {
    let email: String
}

// MARK: The guest's side — Shared with me and the guest door (docs/session-guests-design.md §4, §7)

/// One row of the guest's Shared with me (`GET /guest-sessions`). Mirrors `@orbit/shared`'s
/// `GuestSessionSummary`.
public struct GuestSessionSummary: Codable, Equatable, Sendable, Identifiable {
    public let id: String
    public let title: String
    public let ownerName: String
    public let status: String?
    @LenientSessionField public private(set) var phase: SessionPhase?
    @LenientSessionField public private(set) var released: Bool?
    @LenientSessionField public private(set) var workFinished: Bool?
    @LenientSessionField public private(set) var lastTurnOutcome: SessionTurnOutcome?
    @LenientSessionField public private(set) var waitingOn: SessionWaitingOn?
    @LenientSessionField public private(set) var endReason: String?
    @LenientSessionField public private(set) var activity: String?
    @LenientSessionField public private(set) var pendingApprovals: Int?
    @LenientSessionField public private(set) var runningBgCount: Int?
    public let sessionState: String?
    public let lifecycleState: String?
    public let addedAt: String
    public let lastTurnAt: String?

    public init(id: String, title: String, ownerName: String, status: String?, sessionState: String?,
                lifecycleState: String?, addedAt: String, lastTurnAt: String?) {
        self.id = id
        self.title = title
        self.ownerName = ownerName
        self.status = status
        self.sessionState = sessionState
        self.lifecycleState = lifecycleState
        self.addedAt = addedAt
        self.lastTurnAt = lastTurnAt
    }

    /// How the session stands, read from the row's own fields the way the guest view reads its head.
    public var state: GuestSessionState {
        GuestSessionState(runState: nil, runStatus: status, sessionState: sessionState,
                          lifecycleState: lifecycleState, waitingOnOwner: false,
                          phase: phase, released: released, lastTurnOutcome: lastTurnOutcome,
                          waitingOn: waitingOn, endReason: endReason, workFinished: workFinished,
                          activity: activity, pendingApprovals: pendingApprovals, runningBgCount: runningBgCount)
    }
}

struct GuestSessionList: Decodable {
    let sessions: [GuestSessionSummary]
}

/// The head fields the guest door answers beside its events — the public page's (`sharedHead`), and
/// whether the agent waits on its owner. Every field is optional on the wire: an older or newer
/// control plane missing one must not fail the read.
public struct GuestSessionState: Equatable, Sendable {
    public let runState: SessionRunState?
    public let runStatus: String?
    public let sessionState: String?
    public let lifecycleState: String?
    public let waitingOnOwner: Bool
    public let phase: SessionPhase?
    public let released: Bool?
    public let lastTurnOutcome: SessionTurnOutcome?
    public let waitingOn: SessionWaitingOn?
    public let endReason: String?
    public let workFinished: Bool?
    public let activity: String?
    public let pendingApprovals: Int?
    public let runningBgCount: Int?

    public init(runState: SessionRunState?, runStatus: String?, sessionState: String?,
                lifecycleState: String?, waitingOnOwner: Bool, phase: SessionPhase? = nil,
                released: Bool? = nil, lastTurnOutcome: SessionTurnOutcome? = nil,
                waitingOn: SessionWaitingOn? = nil, endReason: String? = nil, workFinished: Bool? = nil,
                activity: String? = nil, pendingApprovals: Int? = nil, runningBgCount: Int? = nil) {
        self.runState = runState
        self.runStatus = runStatus
        self.sessionState = sessionState
        self.lifecycleState = lifecycleState
        self.waitingOnOwner = waitingOnOwner
        self.phase = phase
        self.released = released
        self.lastTurnOutcome = lastTurnOutcome
        self.waitingOn = waitingOn
        self.endReason = endReason
        self.workFinished = workFinished
        self.activity = activity
        self.pendingApprovals = pendingApprovals
        self.runningBgCount = runningBgCount
    }
}

private enum GuestHeadKeys: String, CodingKey {
    case title, ownerName, status, runStatus, sessionState, runState, lifecycleState, filingState,
         waitingOnOwner, events, hasMore, after, phase, released, lastTurnOutcome, waitingOn,
         endReason, workFinished, activity, pendingApprovals, runningBgCount
}

private extension KeyedDecodingContainer where K == GuestHeadKeys {
    func guestState() -> GuestSessionState {
        let runStatus = (try? decodeIfPresent(String.self, forKey: .runStatus))
            ?? (try? decodeIfPresent(String.self, forKey: .status))
        return GuestSessionState(
            runState: try? decodeIfPresent(SessionRunState.self, forKey: .runState),
            runStatus: runStatus ?? nil,
            sessionState: (try? decodeIfPresent(String.self, forKey: .sessionState)) ?? nil,
            lifecycleState: ((try? decodeIfPresent(String.self, forKey: .lifecycleState)) ?? nil)
                ?? ((try? decodeIfPresent(String.self, forKey: .filingState)) ?? nil),
            waitingOnOwner: (try? decodeIfPresent(Bool.self, forKey: .waitingOnOwner)) ?? false,
            phase: try? decodeIfPresent(SessionPhase.self, forKey: .phase),
            released: try? decodeIfPresent(Bool.self, forKey: .released),
            lastTurnOutcome: try? decodeIfPresent(SessionTurnOutcome.self, forKey: .lastTurnOutcome),
            waitingOn: try? decodeIfPresent(SessionWaitingOn.self, forKey: .waitingOn),
            endReason: try? decodeIfPresent(String.self, forKey: .endReason),
            workFinished: try? decodeIfPresent(Bool.self, forKey: .workFinished),
            activity: try? decodeIfPresent(String.self, forKey: .activity),
            pendingApprovals: try? decodeIfPresent(Int.self, forKey: .pendingApprovals),
            runningBgCount: try? decodeIfPresent(Int.self, forKey: .runningBgCount))
    }
}

/// The guest view's root (`GET /guest-sessions/:id`): who shared it, how it stands, and the newest
/// page of its transcript — the /shared projection with tool output on, in the owner's event shape.
public struct GuestSession: Decodable, Equatable, Sendable {
    public let title: String
    public let ownerName: String
    public let state: GuestSessionState
    public let events: [RunEvent]
    public let hasMore: Bool

    public init(title: String, ownerName: String, state: GuestSessionState, events: [RunEvent], hasMore: Bool) {
        self.title = title
        self.ownerName = ownerName
        self.state = state
        self.events = events
        self.hasMore = hasMore
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: GuestHeadKeys.self)
        title = (try? c.decode(String.self, forKey: .title)) ?? ""
        ownerName = (try? c.decode(String.self, forKey: .ownerName)) ?? ""
        state = c.guestState()
        events = (try? c.decode([RunEvent].self, forKey: .events)) ?? []
        hasMore = ((try? c.decodeIfPresent(Bool.self, forKey: .hasMore)) ?? nil) ?? false
    }
}

/// What the guest door answers to `events?after=`: the head as it stands now, the events newer than
/// the seq asked after, and `after` — where the rest start, nil once these reach the newest.
public struct GuestSessionNow: Decodable, Equatable, Sendable {
    public let title: String?
    public let state: GuestSessionState
    public let events: [RunEvent]
    public let after: Int?

    public init(title: String?, state: GuestSessionState, events: [RunEvent], after: Int?) {
        self.title = title
        self.state = state
        self.events = events
        self.after = after
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: GuestHeadKeys.self)
        title = (try? c.decodeIfPresent(String.self, forKey: .title)) ?? nil
        state = c.guestState()
        events = (try? c.decode([RunEvent].self, forKey: .events)) ?? []
        after = (try? c.decodeIfPresent(Int.self, forKey: .after)) ?? nil
    }
}

/// A `head` frame of the guest stream (docs/session-viewer-stream-design.md §4): the head fields the
/// `events?after=` answer carries — title, how the session stands and whether it waits on its owner —
/// sent when the stream opens and whenever they change.
public struct GuestSessionHead: Decodable, Equatable, Sendable {
    public let title: String?
    public let state: GuestSessionState

    public init(title: String?, state: GuestSessionState) {
        self.title = title
        self.state = state
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: GuestHeadKeys.self)
        title = (try? c.decodeIfPresent(String.self, forKey: .title)) ?? nil
        state = c.guestState()
    }
}

/// An older page of the guest's transcript (`events?before=`).
public struct GuestEventPage: Decodable, Equatable, Sendable {
    public let events: [RunEvent]
    public let hasMore: Bool
}

/// What a guest's message answers: its turn, and whether it restarted an ended session.
public struct GuestTurnAccepted: Decodable, Equatable, Sendable {
    public let turnId: String?
    public let revived: Bool

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        turnId = (try? c.decodeIfPresent(String.self, forKey: .turnId)) ?? nil
        revived = ((try? c.decodeIfPresent(Bool.self, forKey: .revived)) ?? nil) ?? false
    }

    private enum CodingKeys: String, CodingKey { case turnId, revived }
}

/// A guest's message: text and images — no mode, model or effort can ride it (§5). `attachmentIds`
/// names images uploaded through the guest door; nil omits the field (a text-only message).
struct GuestTurnRequest: Encodable {
    let clientTurnId: String
    let content: String
    let attachmentIds: [String]?
}
