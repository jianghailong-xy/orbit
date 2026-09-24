import Foundation

// `POST /api/link-previews`: one request for every card a conversation shows. Mirrors
// `@orbit/shared`'s `link-preview.ts`, which the apiserver answers from
// (`src/apiserver/src/link-previews/`).
//
// The decoding is deliberately tolerant in the same places the rest of this file's neighbours are:
// the fields a card draws are asked for with `decodeIfPresent`, so a control plane that is one
// release behind fills fewer rows instead of failing the whole batch. What it is NOT tolerant about
// is the shape of one preview: a preview that does not decode is dropped by the caller's catch and
// drawn as a card that never arrived — never as a wrong card.

/// The four kinds of object a link can name, and the one enum both the link parser and this wire
/// type are written against (`OrbitLinkKind` in `App/OrbitLink.swift` is the same type on purpose:
/// a link's kind and a card's kind are the same fact).
public enum OrbitLinkKind: String, Codable, Sendable, CaseIterable, Hashable {
    case project, task, session, list

    /// The page path this kind's objects live under: `/tasks/<id>`, `/sessions/<id>`, …
    public var pathSegment: String {
        switch self {
        case .project: return "projects"
        case .task:    return "tasks"
        case .session: return "sessions"
        case .list:    return "lists"
        }
    }
}

/// How many refs one request may carry; more is a 400, not a truncated answer
/// (`LINK_PREVIEW_MAX_REFS`). The store batches to this.
public let linkPreviewMaxRefs = 50

/// One object a client wants a card for. `id` is a public id or a UUID.
public struct LinkPreviewRef: Codable, Equatable, Sendable {
    public let kind: OrbitLinkKind
    public let id: String

    public init(kind: OrbitLinkKind, id: String) {
        self.kind = kind
        self.id = id
    }
}

public struct LinkPreviewsRequest: Codable, Equatable, Sendable {
    public let refs: [LinkPreviewRef]

    public init(refs: [LinkPreviewRef]) { self.refs = refs }
}

public struct LinkPreviewsResponse: Codable, Equatable, Sendable {
    public let previews: [LinkPreview]

    public init(previews: [LinkPreview]) { self.previews = previews }
}

/// The live RESUME_SESSION watches parked on a session, as counts — what the session list reads to
/// say "Watching 7 targets" / "Watch paused".
public struct LinkPreviewWatching: Codable, Equatable, Sendable {
    /// ACTIVE watches.
    public let active: Int?
    /// PAUSED watches.
    public let paused: Int?
    /// Targets still in the set (not GONE) across the ACTIVE watches, each counted once.
    public let targets: Int?
}

public struct LinkPreviewWorkspace: Codable, Equatable, Sendable {
    public let id: String?
    public let name: String?
}

/// A session's card: the session LIST ROW's fields under the row's own names, plus `watching` and
/// `updatedAt`. Read exactly as the app reads a row — the status word comes from
/// `SessionStatusGlyph`, never from a vocabulary invented here.
public struct LinkPreviewSession: Codable, Equatable, Sendable {
    public let id: String?
    public let title: String?
    public let status: RunStatus?
    public let runStatus: RunStatus?
    public let runState: SessionRunState?
    public let sessionState: SessionState?
    public let lifecycleState: SessionLifecycleState?
    public let endReason: String?
    public let error: String?
    /// When an armed auto-retry re-sends the failed message; null when none is armed.
    public let retryAt: String?
    public let engineTurnActive: Bool?
    public let pendingApprovals: Int?
    public let waitingKind: SessionWaitingKind?
    public let runningBgCount: Int?
    public let runningBgJobCount: Int?
    public let watching: LinkPreviewWatching?
    public let workspace: LinkPreviewWorkspace?
    public let model: String?
    public let numTurns: Int?
    public let createdAt: String?
    public let lastTurnAt: String?
    public let updatedAt: String?
    /// The project this session COORDINATES; both nil for any other session. Non-nil is what draws
    /// the Coordinator badge on a session card.
    public let projectId: String?
    public let projectTitle: String?

    /// The execution state, resolved exactly as a list row resolves it (`Session.effectiveRunState`).
    public var effectiveRunState: SessionRunState {
        SessionRunState.resolveOptional(runState, legacy: sessionState, status: status,
                                        endReason: endReason) ?? .unknown
    }

    /// When this session was last touched, for the card's relative time.
    public var lastActivityAt: String? { lastTurnAt ?? updatedAt ?? createdAt }

    /// Whether a failure on this session is one the server intends to undo by itself — the same rule
    /// as `Session.retryPending`, including the grace window that stops a spent retry from saying
    /// "Retrying" forever (`Session.retryStale`).
    public func retryPending(now: Date = Date()) -> Bool {
        guard effectiveRunState == .failed, let retryAt, let at = RelativeTime.parse(retryAt) else {
            return false
        }
        return at.timeIntervalSince(now) > -120
    }

    /// The word the glyph shows for a session parked on live watches, from the counts alone — the
    /// same sentence `WatchSessionSummary.word` builds from the watches themselves.
    public var watchingLabel: String? {
        guard let watching else { return nil }
        if (watching.active ?? 0) > 0 {
            return WatchProjection.watchingLabel(targets: watching.targets ?? 0)
        }
        guard let paused = watching.paused, paused > 0 else { return nil }
        return paused == 1 ? "Watch paused" : "\(paused) watches paused"
    }
}

/// A task's newest session.
public struct LinkPreviewTaskRun: Codable, Equatable, Sendable {
    public let status: RunStatus?
    public let runState: SessionRunState?
    public let numTurns: Int?
    /// Null while it has not finished.
    public let endedAt: String?

    public var effectiveRunState: SessionRunState {
        SessionRunState.resolveOptional(runState, legacy: nil, status: status) ?? .unknown
    }
}

public struct LinkPreviewProjectRef: Codable, Equatable, Sendable {
    public let id: String?
    public let title: String?
}

public struct LinkPreviewTask: Codable, Equatable, Sendable {
    public let title: String?
    /// The lifecycle name, kept as the wire's own string: `ReferencedTaskNote.pill` is total over
    /// strings and draws a status this build has never heard of under its own name rather than
    /// under a wrong one.
    public let status: String?
    /// The task list's live overlays: a RUNNING session on it, or a PENDING one with none running.
    public let running: Bool?
    public let queued: Bool?
    public let project: LinkPreviewProjectRef?
    /// The workspace responsible for it.
    public let assignee: LinkPreviewWorkspace?
    /// How many sessions the task has had.
    public let runs: Int?
    public let lastRun: LinkPreviewTaskRun?
    public let updatedAt: String?

    /// When the last run ended, for the card's relative time; the task's own clock when there is no
    /// run to date.
    public var lastActivityAt: String? { lastRun?.endedAt ?? updatedAt }
}

/// `readProjectPanorama`'s lanes: every task in exactly one of them, so they sum to `total`.
public struct LinkPreviewProjectBuckets: Codable, Equatable, Sendable {
    public let running: Int?
    public let ready: Int?
    public let blocked: Int?
    public let awaitingVerification: Int?
    public let done: Int?
    public let failed: Int?
    public let cancelled: Int?
}

public struct LinkPreviewProject: Codable, Equatable, Sendable {
    public let title: String?
    public let status: String?
    /// Every task in the project: the sum of the seven lanes.
    public let total: Int?
    public let buckets: LinkPreviewProjectBuckets?
    /// The coordinator session, and its card; both null when there is none it can be shown.
    public let coordinatorSessionId: String?
    public let coordinator: LinkPreviewSession?
}

/// The tallies behind the task list's progress bar (`GET /tasks/counts?listId=`), unchanged.
public struct LinkPreviewListCounts: Codable, Equatable, Sendable {
    public let total: Int?
    public let open: Int?
    public let inProgress: Int?
    public let done: Int?
    public let failed: Int?
    public let cancelled: Int?
    public let running: Int?
    public let queued: Int?
    public let runnable: Int?
}

public struct LinkPreviewList: Codable, Equatable, Sendable {
    public let title: String?
    public let counts: LinkPreviewListCounts?
}

public enum LinkPreviewState: String, Codable, Sendable {
    case ok, unavailable
}

/// One answer for one ref. The union is flattened into optional payloads rather than modelled as an
/// enum with associated values: the wire is a flat object with a `state` discriminator, and a
/// decoding that mirrors that literally is one that cannot silently pick the wrong arm.
public struct LinkPreview: Codable, Equatable, Sendable {
    public let kind: OrbitLinkKind
    /// The ref's id as a public id; a ref whose id is not one comes back as it was sent.
    public let id: String
    public let state: LinkPreviewState
    public let session: LinkPreviewSession?
    public let task: LinkPreviewTask?
    public let project: LinkPreviewProject?
    public let list: LinkPreviewList?

    /// The ref the server answered about, spelled the way it answered.
    public var ref: LinkPreviewRef { LinkPreviewRef(kind: kind, id: id) }
}

/// One preview per ref, in the order they were asked for. The store pairs them back up by index, so
/// this is a list and not a dictionary on purpose.
public enum LinkPreviews {
    /// The `(kind, id)` key a preview is cached under. Canonicalised, so the two spellings of one id
    /// are one entry — a card that missed because the caller held a UUID and the cache a public id
    /// is the silent miss this whole work exists to remove.
    public static func key(kind: OrbitLinkKind, id: String) -> String {
        "\(kind.rawValue):\(PublicID.storageKey(id))"
    }
}
