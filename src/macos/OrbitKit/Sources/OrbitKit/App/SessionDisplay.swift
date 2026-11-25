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
    case needsYou, failed, retrying, onHold, interrupted, background, willResume, finished, ended

    public var word: String {
        switch self {
        case .needsYou:    return "Needs you"
        case .failed:      return "Failed"
        case .retrying:    return "Retrying"
        case .onHold:      return "On hold"
        case .interrupted: return "Interrupted"
        case .background:  return "Background"
        case .willResume:  return "Will resume"
        case .finished:    return "Finished"
        case .ended:       return "Ended"
        }
    }

    public var symbol: String {
        switch self {
        case .needsYou:    return "hand.raised.fill"
        case .failed:      return "xmark"
        case .retrying:    return "arrow.clockwise"
        case .onHold:      return "pause"
        case .interrupted: return "minus"
        case .background:  return "terminal"
        case .willResume:  return "eye"
        case .finished:    return "checkmark"
        case .ended:       return "stop"
        }
    }

    /// Amber: the person has to act. Red: a failure nobody is retrying. Green: the work finished.
    /// Everything else is grey.
    public var tone: SessionStatusGlyph.Tone {
        switch self {
        case .needsYou: return .warning
        case .failed:   return .error
        case .finished: return .success
        default:        return .neutral
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

    /// A release the server counts as a failure (decision D9): released, the last turn failed, and
    /// nobody asked for an end.
    static func releasedByFailure(_ f: SessionDisplayFacts) -> Bool {
        f.released == true && (f.endReason ?? "").isEmpty && f.lastTurnOutcome == .failed
    }

    /// The marks, in drawing order, each read from its own fact.
    public static func marks(_ f: SessionDisplayFacts) -> [SessionMark]? {
        guard hasFacts(f) else { return nil }
        let released = f.released == true
        var out: [SessionMark] = []
        if f.waitingOn == .person || (f.pendingApprovals ?? 0) > 0 { out.append(.needsYou) }
        if releasedByFailure(f) { out.append(f.waitingOn == .wake ? .retrying : .failed) }
        if f.waitingOn == .hold { out.append(.onHold) }
        if !released && f.phase == .idle && f.lastTurnOutcome == .interrupted { out.append(.interrupted) }
        if !released && (f.activity == "BACKGROUND_JOB" || (f.runningBgCount ?? 0) > 0) { out.append(.background) }
        if !released && f.waitingOn == .wake { out.append(.willResume) }
        if released && f.workFinished == true { out.append(.finished) }
        if released && f.workFinished != true && !releasedByFailure(f) { out.append(.ended) }
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
    /// "Idle · Finished".
    public static func written(_ state: SessionDisplayState, _ marks: [SessionMark]) -> String {
        ([state.word] + marks.map(\.word)).joined(separator: " · ")
    }

    /// The same, as a row's VoiceOver value: "Idle, Interrupted".
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
