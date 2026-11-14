import Foundation

// The guest's side of session guests (docs/session-guests-design.md §4; boards
// docs/mocks/share-links/10-session-guests and 11-guest-one-link): Shared with me, the sessions other
// people invited this account to reply in, and the guest view a row opens — its head (title,
// `Shared by <owner>`, status, a Guest badge), the transcript the guest door projects, and a composer
// that takes text only. Everything here is the web's (src/web/src/components/SharedWithMe.tsx,
// src/web/src/pages/GuestSessionPage.tsx), in the web's words.

/// The guest view's and Shared with me's words.
public enum GuestCopy {
    /// The sidebar's / drawer's group.
    public static let sharedWithMe = "Shared with me"
    /// The badge beside the status in the guest view's head.
    public static let guestBadge = "Guest"
    /// What the guest door answers for every session the caller cannot reply in: removed, left,
    /// Trash or deleted (web `GUEST_NOT_SHARED`).
    public static let notShared = "This conversation is no longer shared with you."
    public static let notSharedDetail = "Ask the person who shared it if you need it again."
    public static let loading = "Loading…"

    public static func sharedBy(_ owner: String) -> String { "Shared by \(owner)" }
    public static func placeholder(_ owner: String) -> String { "Message \(owner)\u{2019}s agent…" }
    public static func runsOn(_ owner: String) -> String { "Runs on \(owner)\u{2019}s machine" }
    public static func waiting(_ owner: String) -> String { "Waiting for \(owner) to approve" }
    public static let waitsItsTurn = "Your message waits its turn"
    public static func restarts(_ owner: String) -> String {
        "Send to continue \u{2014} this restarts the session on \(owner)\u{2019}s machine."
    }
}

/// The tone of the status pill, as the public page colours it (web `RUN_TONE`, plus `done` for a
/// session filed Completed).
public enum GuestTone: String, Sendable, Equatable {
    case queued, running, awaiting, done, failed, cancelled
}

extension GuestSessionState {
    /// The run state, resolved the way every other surface resolves it: the new field first, then the
    /// raw run status, then the legacy mixed state. Nothing at all reads as Ended.
    public var resolvedRunState: SessionRunState {
        SessionRunState.resolveOptional(runState,
                                        legacy: sessionState.flatMap(SessionState.init(rawValue:)),
                                        status: runStatus.flatMap(RunStatus.init(rawValue:))) ?? .ended
    }

    /// Filed Completed by its owner (`ARCHIVED` is the old spelling).
    public var completed: Bool {
        let raw = lifecycleState?.uppercased()
        return raw == "COMPLETED" || raw == "ARCHIVED"
    }

    /// The agent is still in a run — and the conversation is not filed away — so a message joins it
    /// rather than restarting it.
    public var live: Bool { resolvedRunState.isLive && !completed }

    /// Waiting on its owner — a permission card or a question pending — which only the owner answers.
    public var waiting: Bool { live && waitingOnOwner }

    /// Queued or running: the conversation is moving now.
    public var busy: Bool { resolvedRunState == .queued || resolvedRunState == .running }

    /// The status word (web `sessionStateWord`): `Completed` once filed, else the run's own word.
    public var word: String { completed ? "Completed" : ShareMarkdown.runLabel(resolvedRunState) }

    public var tone: GuestTone {
        if completed { return .done }
        switch resolvedRunState {
        case .queued: return .queued
        case .running: return .running
        case .awaitingInput: return .awaiting
        case .succeeded: return .done
        case .failed: return .failed
        case .interrupted, .ended, .unknown: return .cancelled
        }
    }

    /// The line under the composer: where a message runs, that it waits its turn behind the owner's
    /// approval, or that sending restarts an ended session.
    public func hint(owner: String) -> String {
        if !live { return GuestCopy.restarts(owner) }
        return waiting ? GuestCopy.waitsItsTurn : GuestCopy.runsOn(owner)
    }
}

/// How the guest view follows the conversation — the public page's cadence (web `followDelay`):
/// every 4 s while it works or has just moved, every 30 s while it waits, and not at all once over.
public enum GuestFollow {
    public static let workingInterval: TimeInterval = 4
    public static let waitingInterval: TimeInterval = 30
    /// How many events the first read and each follow read ask for.
    public static let tailPage = 200
    public static let pageSize = 200

    /// The wait before the next read, after an answer that did (`moved`) or did not bring anything
    /// new; nil once the conversation has stopped and gone quiet. `expecting`: a message was just
    /// sent and the run it starts has not been seen yet, so a quiet session is still asked.
    public static func delay(_ state: GuestSessionState, moved: Bool, expecting: Bool = false) -> TimeInterval? {
        if moved || state.busy { return workingInterval }
        if state.resolvedRunState.isLive && !state.completed { return waitingInterval }
        return expecting ? workingInterval : nil
    }
}

/// The guest's own words read as theirs: a `user` event the door attributes to this account
/// (`ORBIT_GUEST` under its name) is headed `You` instead of `From <name>` (web `sentByReader`). The
/// owner's own messages carry no sender and stay plain bubbles; anyone else's keep `From <name>`.
public enum GuestTranscript {
    public static func ownMessages(_ events: [RunEvent], myName: String?) -> [RunEvent] {
        guard let me = myName?.trimmingCharacters(in: .whitespacesAndNewlines), !me.isEmpty else { return events }
        return events.map { event in
            guard event.type == .user, case .object(var payload) = event.payload,
                  let from = ExternalSender.parse(payload["externalSender"]),
                  from.source == ExternalSender.guestSource, from.name == me else { return event }
            payload["externalSender"] = .object(["source": .string(ExternalSender.readerSource)])
            return RunEvent(seq: event.seq, type: event.type, ts: event.ts, turnId: event.turnId,
                            payload: .object(payload), truncated: event.truncated)
        }
    }
}

/// Shared with me: the rows, and whether the group is drawn at all.
public enum SharedWithMe {
    /// How often the list is read again: a session can be shared with you, or stop being, at any time.
    public static let refreshInterval: TimeInterval = 60

    /// No group while there is none.
    public static func showsGroup(_ sessions: [GuestSessionSummary]) -> Bool { !sessions.isEmpty }

    /// The row's second line: who shared it and how it stands, `Ana · Running`.
    public static func subtitle(_ session: GuestSessionSummary) -> String {
        "\(session.ownerName) \u{00B7} \(session.state.word)"
    }

    /// The row's title: the first non-blank line of the session's title (web `titleFirstLine`).
    public static func title(_ session: GuestSessionSummary) -> String { firstLine(session.title) }

    public static func firstLine(_ title: String) -> String {
        title.split(separator: "\n", omittingEmptySubsequences: false)
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .first { !$0.isEmpty } ?? title.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// How long ago it last moved, in the list's shortest words: `now`, `2m`, `1h`, `2d`.
    public static func ago(_ session: GuestSessionSummary, now: Date = Date()) -> String {
        guard let date = RelativeTime.parse(session.lastTurnAt ?? session.addedAt) else { return "" }
        let minutes = Int(now.timeIntervalSince(date) / 60)
        if minutes < 1 { return "now" }
        if minutes < 60 { return "\(minutes)m" }
        if minutes < 24 * 60 { return "\(minutes / 60)h" }
        return "\(minutes / (24 * 60))d"
    }

    /// Whether `id` is one of the rows, in either id spelling — what highlights the open row.
    public static func contains(_ sessions: [GuestSessionSummary], id: String?) -> Bool {
        guard let id else { return false }
        let key = PublicID.storageKey(id)
        return sessions.contains { PublicID.storageKey($0.id) == key }
    }
}
