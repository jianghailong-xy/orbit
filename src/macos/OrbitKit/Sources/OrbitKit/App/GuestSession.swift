import Foundation

// The guest's side of session guests (docs/session-guests-design.md §4; boards
// docs/mocks/share-links/10-session-guests and 11-guest-one-link): Shared with me, the sessions other
// people invited this account to reply in, and the guest view a row opens — its head (title,
// `Shared by <owner>`, status, a Guest badge), the transcript the guest door projects, and a composer
// that takes text and images. Everything here is the web's (src/web/src/components/SharedWithMe.tsx,
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

/// What the guest's composer takes: text, images, or both — the owner's image rules (PNG, JPEG, WebP
/// or GIF, at most 5 MB), and nothing but images.
public enum GuestComposer {
    /// The guest door's own sentence for anything that is not one of the four image types.
    public static let imagesOnly = "A guest can attach PNG, JPEG, WebP or GIF images only."

    /// `nil` ⇒ OK to upload; otherwise the sentence it was refused with.
    public static func rejectReason(mimeType: String, byteCount: Int) -> String? {
        guard Attachments.isInlineImage(mimeType: mimeType) else { return imagesOnly }
        return Attachments.rejectReason(mimeType: mimeType, byteCount: byteCount)
    }

    /// Whether there is anything to send: words, or at least one image on its own.
    public static func canSend(text: String, imageCount: Int) -> Bool {
        imageCount > 0 || !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }
}

/// The tone of the status pill, as the public page colours it (web `RUN_TONE`, plus `done` for a
/// session filed Completed).
public enum GuestTone: String, Sendable, Equatable {
    case queued, running, awaiting, done, failed, cancelled
}

extension GuestSessionState {
    public var displayFacts: SessionDisplayFacts {
        SessionDisplayFacts(phase: phase, released: released, lastTurnOutcome: lastTurnOutcome,
                            waitingOn: waitingOn, endReason: endReason, workFinished: workFinished,
                            activity: activity, pendingApprovals: pendingApprovals,
                            runningBgCount: runningBgCount)
    }

    /// The state and its marks as Shared with me writes them (web `sharedWithMeStateText`): "Idle · Finished",
    /// then Completed for a filed session. From an older server, `word`.
    public var line: String {
        guard let state = SessionDisplay.state(displayFacts) else { return word }
        let shown = SessionDisplay.written(state, SessionDisplay.marks(displayFacts) ?? [])
        return completed ? "\(shown) \u{00B7} Completed" : shown
    }

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
    public var live: Bool { (released.map { !$0 } ?? resolvedRunState.isLive) && !completed }

    /// Waiting on its owner — a permission card or a question pending — which only the owner answers.
    public var waiting: Bool { live && waitingOnOwner }

    /// Queued or running: the conversation is moving now.
    public var busy: Bool { resolvedRunState == .queued || resolvedRunState == .running }

    /// Guest payloads historically omitted the end reason. Until they carry the release outcome
    /// facts, keep their terminal wording on the legacy path.
    private var releasedRunState: SessionRunState? {
        guard released == true, workFinished != nil || endReason != nil else { return nil }
        return .afterRelease(endReason: endReason, lastTurnOutcome: lastTurnOutcome,
                             workFinished: workFinished)
    }

    private var displayRunState: SessionRunState {
        if let releasedRunState { return releasedRunState }
        if released == false && endReason != nil && lastTurnOutcome == .interrupted { return .interrupted }
        return resolvedRunState
    }

    /// The status word (web `sessionStateWord`): with the session facts, the state word from `phase`
    /// (`SessionDisplay`), a filed session's Completed drawn after it by the caller; from an older server,
    /// `Completed` once filed, else the run's own word.
    public var word: String {
        if let state = SessionDisplay.state(displayFacts) { return state.word }
        if completed { return "Completed" }
        if releasedRunState == .succeeded { return "Finished" }
        if displayRunState == .queued && waitingOn == .hold { return "On hold" }
        // A payload without the release facts keeps its old word; the task panel's run label now says Finished.
        if displayRunState == .succeeded { return "Succeeded" }
        return ShareMarkdown.runLabel(displayRunState)
    }

    public var tone: GuestTone {
        if completed { return .done }
        switch displayRunState {
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
        // PENDING on a wake is an armed retry, which can be hours out on a spent quota: it waits, as an idle one does.
        let busy = state.phase.map { $0 == .running || ($0 == .pending && state.waitingOn != .wake) } ?? state.busy
        if moved || (state.released != true && busy) { return workingInterval }
        if state.live { return waitingInterval }
        return expecting ? workingInterval : nil
    }
}

/// The messages a guest view sent, drawn the moment Send is pressed until the runner's own `user`
/// event for each turn is read (web `GuestConversation`'s `sent`, Android `GuestConversation`). The
/// runner writes that echo a moment after the send is accepted (production 11-16: ~0.7 s), so the read
/// right after a send comes back without it; until it is read the view asks every `echoInterval`, for up
/// to `echoWindow` — a message behind a running turn is echoed only when its turn starts, which can be
/// minutes, and it stays drawn meanwhile.
public struct GuestSentTurns: Equatable, Sendable {
    public static let echoInterval: TimeInterval = 0.5
    public static let echoWindow: TimeInterval = 10
    /// The seqs below `RunEvent.sentinelSeq` a drawn message takes, one per message sent: after every
    /// real event, and never one a real event can take.
    static let drawnSeqs = 1_000_000_000

    struct Turn: Equatable, Sendable {
        let key: Int
        var turnId: String?
        let text: String
        let ts: String
        var askUntil: Date?
    }

    private(set) var turns: [Turn] = []
    private var sent = 0

    public init() {}

    public var isEmpty: Bool { turns.isEmpty }

    /// Draw `text` as sent now; the key names it to `accepted` and `refused`.
    public mutating func draw(_ text: String, at now: Date = Date()) -> Int {
        sent += 1
        turns.append(Turn(key: sent, turnId: nil, text: text, ts: ISO8601DateFormatter().string(from: now), askUntil: nil))
        return sent
    }

    /// The door took it: its echo will carry `turnId`, asked for often until `echoWindow` has passed.
    public mutating func accepted(_ key: Int, turnId: String?, at now: Date = Date()) {
        guard let i = turns.firstIndex(where: { $0.key == key }) else { return }
        turns[i].turnId = turnId
        turns[i].askUntil = turnId == nil ? nil : now.addingTimeInterval(Self.echoWindow)
    }

    /// The door refused it: it is no longer drawn.
    public mutating func refused(_ key: Int) {
        turns.removeAll { $0.key == key }
    }

    /// Events read from the door: a `user` event for a turn drawn here replaces the drawing.
    public mutating func read(_ events: [RunEvent]) {
        let echoed = Set(events.compactMap { $0.type == .user ? $0.turnId : nil })
        if !echoed.isEmpty { turns.removeAll { $0.turnId.map(echoed.contains) ?? false } }
    }

    /// The drawn messages as `user` events, headed as the reader's own.
    public var events: [RunEvent] {
        turns.map { turn in
            RunEvent(seq: RunEvent.sentinelSeq - Self.drawnSeqs + turn.key, type: .user, ts: turn.ts,
                     turnId: turn.turnId ?? "sent-\(turn.key)",
                     payload: .object(["text": .string(turn.text),
                                       "externalSender": .object(["source": .string(ExternalSender.readerSource)])]))
        }
    }

    /// The wait before the next follow read: `following` (GuestFollow's), cut to `echoInterval` while an
    /// accepted message's echo is still missing and its window is open.
    public func delay(_ following: TimeInterval?, at now: Date = Date()) -> TimeInterval? {
        guard turns.contains(where: { ($0.askUntil ?? .distantPast) > now }) else { return following }
        return min(following ?? Self.echoInterval, Self.echoInterval)
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
        "\(session.ownerName) \u{00B7} \(session.state.line)"
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

/// One row of a guest conversation's transcript: the earlier-messages control, an item, or the
/// bottom anchor the view scrolls to. One array, so the list holds one ForEach and no conditional
/// row of its own.
public enum GuestTranscriptListRow: Equatable, Sendable, Identifiable {
    case loadOlder
    case item(TranscriptItem)
    case bottom(String)

    public var id: String {
        switch self {
        case .loadOlder: "load-older"
        case .item(let item): "item:\(item.id)"
        case .bottom(let id): "bottom:\(id)"
        }
    }
}

public enum GuestTranscriptListLogic {
    public static func rows(_ items: [TranscriptItem], hasMoreOlder: Bool,
                            bottomID: String) -> [GuestTranscriptListRow] {
        (hasMoreOlder ? [.loadOlder] : []) + items.map(GuestTranscriptListRow.item) + [.bottom(bottomID)]
    }
}
