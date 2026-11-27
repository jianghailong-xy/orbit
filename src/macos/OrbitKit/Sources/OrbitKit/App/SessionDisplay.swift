import Foundation

/// The session facts the two display functions read (contracts/session-state.contract.json), from
/// whichever payload a surface holds. `phase` and `released` absent is an older server.
public struct SessionDisplayFacts: Equatable, Sendable {
    public var phase: SessionPhase?
    public var released: Bool?
    public var lastTurnOutcome: SessionTurnOutcome?
    public var waitingOn: SessionWaitingOn?
    public var endReason: String?
    public var workFinished: Bool?
    public var activity: String?
    public var pendingApprovals: Int?
    public var runningBgCount: Int?

    public init(phase: SessionPhase?, released: Bool?, lastTurnOutcome: SessionTurnOutcome? = nil,
                waitingOn: SessionWaitingOn? = nil, endReason: String? = nil, workFinished: Bool? = nil,
                activity: String? = nil, pendingApprovals: Int? = nil, runningBgCount: Int? = nil) {
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

/// A session's state: `phase` alone, three values (the approved board,
/// docs/mocks/session-display-three-states).
public enum SessionDisplayState: String, Equatable, Sendable, CaseIterable {
    case queued, running, idle

    public var word: String {
        switch self {
        case .queued:  return "Queued"
        case .running: return "Running"
        case .idle:    return "Idle"
        }
    }

    /// The state icon: a clock, the spinner, an empty circle. Only Running carries a colour.
    public var glyph: SessionStatusGlyph {
        switch self {
        case .queued:  return .init(shape: .symbol("clock"), tone: .neutral, label: word)
        case .running: return .init(shape: .spinner, tone: .brand, label: word)
        case .idle:    return .init(shape: .symbol("circle"), tone: .neutral, label: word)
        }
    }
}

/// One fact that is not activity, drawn as its own mark after the state word, never in place of the
/// state icon. Declared in drawing order.
public enum SessionMark: String, Equatable, Sendable, CaseIterable {
    case needsYou, failed, retrying, onHold

    public var word: String {
        switch self {
        case .needsYou:    return "Needs you"
        case .failed:      return "Failed"
        case .retrying:    return "Retrying"
        case .onHold:      return "On hold"
        }
    }

    public var symbol: String {
        switch self {
        case .needsYou:    return "hand.raised.fill"
        case .failed:      return "xmark"
        case .retrying:    return "arrow.clockwise"
        case .onHold:      return "pause"
        }
    }

    /// Amber: the person has to act. Red: a failure nobody is retrying. Everything else is grey.
    public var tone: SessionStatusGlyph.Tone {
        switch self {
        case .needsYou: return .warning
        case .failed:   return .error
        default:        return .neutral
        }
    }
}

/// A fact a list row draws as an icon at the end of its title line instead of a chip (the owner,
/// 2026-11-27; web `SessionRowIcon`): a release by a failure (Failed, or Retrying when the server will
/// retry it) and a held queued turn (On hold), which every other surface still draws as marks; and
/// background work still running and a wake (a watch, a scheduled wake-up or an armed retry) that
/// will resume a held session, which no other surface draws. Interrupted, Finished and Ended are not
/// drawn at all.
public enum SessionRowIcon: String, Equatable, Sendable, CaseIterable {
    case failed, retrying, onHold, background, willResume

    public var symbol: String {
        switch self {
        case .failed:     return SessionMark.failed.symbol
        case .retrying:   return SessionMark.retrying.symbol
        case .onHold:     return SessionMark.onHold.symbol
        case .background: return "terminal"
        case .willResume: return "eye"
        }
    }

    /// The icon's tooltip and VoiceOver label.
    public var tip: String {
        switch self {
        case .failed:     return SessionMark.failed.word
        case .retrying:   return SessionMark.retrying.word
        case .onHold:     return SessionMark.onHold.word
        case .background: return "Background work running"
        case .willResume: return "Will resume"
        }
    }

    /// Red for Failed (a failure nobody is retrying), grey otherwise.
    public var tone: SessionStatusGlyph.Tone { self == .failed ? .error : .neutral }

    /// The mark a list row draws as this icon, if any.
    init?(mark: SessionMark) {
        switch mark {
        case .failed:   self = .failed
        case .retrying: self = .retrying
        case .onHold:   self = .onHold
        default:        return nil
        }
    }
}

/// The two functions every Apple surface that draws a session's state calls: one for the state,
/// one for the marks. A port of the board's `capture/rules.mjs`, without the Disconnected mark (owner
/// 2026-11-25: a released failure whose runner went offline is Failed like any other). Both answer
/// nil from an older server, and the caller then draws what it always drew.
public enum SessionDisplay {
    public static func hasFacts(_ f: SessionDisplayFacts) -> Bool { f.phase != nil && f.released != nil }

    /// The state: `phase` alone.
    public static func state(_ f: SessionDisplayFacts) -> SessionDisplayState? {
        guard hasFacts(f), let phase = f.phase else { return nil }
        switch phase {
        case .pending: return .queued
        case .running: return .running
        case .idle:    return .idle
        }
    }

    /// The end reason a move to another workspace releases a session with (`POST /sessions/:id/move`).
    public static let movedEndReason = "moved"

    /// Released by a move: the server let it go so its runner could commit what it left, which the
    /// person who moved it is not told. Drawn as a held idle session — no Ended mark, its idle word and
    /// glyph — and still resumed by the next message (board docs/mocks/session-move-released; web
    /// `sessionReleasedByMove`).
    public static func releasedByMove(_ f: SessionDisplayFacts) -> Bool {
        f.released == true && f.endReason == movedEndReason
    }

    /// A release the server counts as a failure (decision D9): released, the last turn failed, and
    /// nobody asked for an end.
    static func releasedByFailure(_ f: SessionDisplayFacts) -> Bool {
        f.released == true && (f.endReason ?? "").isEmpty && f.lastTurnOutcome == .failed
    }

    /// The marks, in drawing order, each read from its own fact.
    public static func marks(_ f: SessionDisplayFacts) -> [SessionMark]? {
        guard hasFacts(f) else { return nil }
        var out: [SessionMark] = []
        if f.waitingOn == .person || (f.pendingApprovals ?? 0) > 0 { out.append(.needsYou) }
        if releasedByFailure(f) { out.append(f.waitingOn == .wake ? .retrying : .failed) }
        if f.waitingOn == .hold { out.append(.onHold) }
        return out
    }

    /// The chips a list row draws after its line: the marks less those it draws as title-line icons,
    /// so Needs you alone (web `sessionRowMarks`). Nil from an older server.
    public static func rowMarks(_ f: SessionDisplayFacts) -> [SessionMark]? {
        marks(f)?.filter { SessionRowIcon(mark: $0) == nil }
    }

    /// The title-line icons of a list row, in drawing order (web `sessionRowIcons`): Failed / Retrying
    /// and On hold (the marks of those names), then Background and Will resume for a held session.
    public static func rowIcons(_ f: SessionDisplayFacts) -> [SessionRowIcon] {
        var out = (marks(f) ?? []).compactMap(SessionRowIcon.init(mark:))
        guard hasFacts(f), f.released != true else { return out }
        if f.activity == "BACKGROUND_JOB" || (f.runningBgCount ?? 0) > 0 { out.append(.background) }
        if f.waitingOn == .wake { out.append(.willResume) }
        return out
    }

    /// A phone row draws at most two marks; the rest are counted as "+N".
    public static let phoneRowMarkLimit = 2

    public static func phoneRowMarks(_ marks: [SessionMark]) -> (shown: [SessionMark], more: String?) {
        let shown = Array(marks.prefix(phoneRowMarkLimit))
        let rest = marks.count - shown.count
        return (shown, rest > 0 ? "+\(rest)" : nil)
    }

    /// The state word and the marks as one sentence, separated as shared Markdown writes them:
    /// "Idle · Needs you".
    public static func written(_ state: SessionDisplayState, _ marks: [SessionMark]) -> String {
        ([state.word] + marks.map(\.word)).joined(separator: " · ")
    }

    /// The same, as a row's VoiceOver value: "Idle, Needs you".
    public static func spoken(_ state: SessionDisplayState, _ marks: [SessionMark]) -> String {
        ([state.word] + marks.map(\.word)).joined(separator: ", ")
    }
}

extension Session {
    public var displayFacts: SessionDisplayFacts {
        SessionDisplayFacts(phase: phase, released: released, lastTurnOutcome: lastTurnOutcome,
                            waitingOn: waitingOn, endReason: endReason, workFinished: workFinished,
                            activity: activity, pendingApprovals: pendingApprovals,
                            runningBgCount: runningBgCount)
    }
}

extension SessionRef {
    public var displayFacts: SessionDisplayFacts {
        SessionDisplayFacts(phase: phase, released: released, lastTurnOutcome: lastTurnOutcome,
                            waitingOn: waitingOn, endReason: endReason, workFinished: workFinished,
                            activity: activity, runningBgCount: runningBgCount)
    }
}

extension LinkPreviewSession {
    public var displayFacts: SessionDisplayFacts {
        SessionDisplayFacts(phase: phase, released: released, lastTurnOutcome: lastTurnOutcome,
                            waitingOn: waitingOn, endReason: endReason, workFinished: workFinished,
                            activity: activity, pendingApprovals: pendingApprovals,
                            runningBgCount: runningBgCount)
    }
}

extension SessionSearchHit {
    public var displayFacts: SessionDisplayFacts {
        SessionDisplayFacts(phase: phase, released: released, lastTurnOutcome: lastTurnOutcome,
                            waitingOn: waitingOn, endReason: endReason, workFinished: workFinished,
                            activity: activity, runningBgCount: runningBgCount)
    }
}
