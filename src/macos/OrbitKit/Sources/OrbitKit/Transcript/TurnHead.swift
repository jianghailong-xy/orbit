import Foundation

// The head of a turn, over the turn's own output: how long it worked, or has been working (web
// parity: `TurnHead` in Transcript.tsx, owner 2026-10-10, board docs/mocks/turn-head-web). The span
// runs from the `user` event that opened the turn to the `turn_end` that closed it, both stored, so
// a turn read back later says what the turn on screen said.

/// The `user` event a message opened its turn with: where the turn starts.
public struct TurnOpening: Codable, Equatable, Sendable {
    public var seq: Int
    public var ts: String?

    public init(seq: Int, ts: String?) {
        self.seq = seq
        self.ts = ts
    }
}

/// A `turn_end`: where some turn stopped working.
public struct TurnEndMark: Codable, Equatable, Sendable {
    public var seq: Int
    public var ts: String?

    public init(seq: Int, ts: String?) {
        self.seq = seq
        self.ts = ts
    }
}

/// One head row, drawn under the message that opened its turn.
public struct TurnHeadLine: Equatable, Sendable {
    /// The id of the message that opened the turn.
    public let bubbleID: String
    public let startTs: String?
    public let endTs: String?
    /// The newest turn head in the window: the only turn that can still be running.
    public let newest: Bool

    public init(bubbleID: String, startTs: String?, endTs: String?, newest: Bool) {
        self.bubbleID = bubbleID
        self.startTs = startTs
        self.endTs = endTs
        self.newest = newest
    }
}

public enum TurnHead {
    public static func workedFor(_ duration: String) -> String { "Worked for \(duration)" }
    public static func workingFor(_ duration: String) -> String { "Working for \(duration)" }
    public static let working = "Working…"

    /// The head of every turn the window draws, keyed by the id of the message that opened it.
    ///
    /// A turn's end is the first `turn_end` after its opening and before the next turn opens. The
    /// marks are matched by seq rather than folded in order, so a turn whose `turn_end` lies in a
    /// page loaded later — either side of it — still meets it.
    public static func lines(_ state: TranscriptState) -> [String: TurnHeadLine] {
        var opened: [(id: String, opening: TurnOpening)] = []
        for item in state.items {
            if case .user(let b) = item, let opening = b.opensTurn { opened.append((b.id, opening)) }
        }
        guard !opened.isEmpty else { return [:] }
        let ends = state.turnEnds.sorted { $0.seq < $1.seq }
        let byOpening = opened.sorted { $0.opening.seq < $1.opening.seq }
        var out: [String: TurnHeadLine] = [:]
        for (i, head) in byOpening.enumerated() {
            let next = i + 1 < byOpening.count ? byOpening[i + 1].opening.seq : Int.max
            let end = ends.first { $0.seq > head.opening.seq && $0.seq < next }
            out[head.id] = TurnHeadLine(bubbleID: head.id, startTs: head.opening.ts, endTs: end?.ts,
                                        newest: i == byOpening.count - 1)
        }
        return out
    }

    /// What the row says at `now`, or nil for no row. An ended turn says how long it worked; the
    /// newest turn of a running session counts up; a turn that neither ended nor can still be running
    /// — its end is past the loaded window — says nothing rather than something wrong. A turn is never
    /// under a second: "Worked for 0s" reads as a bug, not as a measurement.
    public static func label(_ line: TurnHeadLine, running: Bool, now: Date = Date()) -> String? {
        let start = ThinkingSummary.date(line.startTs)
        if let start, let end = ThinkingSummary.date(line.endTs), end >= start {
            return workedFor(span(end.timeIntervalSince(start)))
        }
        guard line.endTs == nil, running, line.newest else { return nil }
        guard let start else { return working }
        return workingFor(span(now.timeIntervalSince(start)))
    }

    private static func span(_ seconds: TimeInterval) -> String {
        ExceptionCards.checkDuration(Int(max(1, seconds) * 1000))
    }
}
