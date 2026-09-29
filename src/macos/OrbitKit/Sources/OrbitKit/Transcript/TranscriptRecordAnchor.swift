import Foundation

/// Where the record a link names is drawn (`SessionRecordLink`): the item that shows it, and the row
/// that item is in. Web parity: `elementForSeq` in `lib/transcriptDeepLink.ts`, which lands on the
/// last `data-seq` stamp at or before the record — the card an event is folded into.
public enum TranscriptRecordAnchor {
    /// The id of the item that shows the record a page was read around, or nil in an empty window.
    ///
    /// The anchor's seq names an event, and the item that event built is found by what the item kept
    /// of it: a reply's and a reasoning block's own seq, a tool card's call and result, an interrupt's.
    /// A person's message keeps no seq, so it is found by its turn — the id its `user` event carried,
    /// compared as an id and not as a spelling. An event that built no item of its own (a status, a
    /// turn's end) lands on the last item before it: the row a reader would look at for it.
    public static func itemID(for anchor: TranscriptAnchor, page: [RunEvent],
                              in items: [TranscriptItem]) -> String? {
        let event = page.first { $0.seq == anchor.seq }
        if event?.type == .user || (event == nil && anchor.kind == "turn") {
            if let turn = PublicID.toUUID(event?.turnId ?? anchor.id),
               let bubble = items.first(where: { item in
                   guard case .user(let b) = item, let id = b.turnId else { return false }
                   return PublicID.toUUID(id) == turn
               }) {
                return bubble.id
            }
            // A message whose bubble kept no turn id sits right above the first row newer than it —
            // or last, when nothing newer is loaded.
            let next = items.firstIndex(where: { (seqs(of: $0).min() ?? -1) > anchor.seq }) ?? items.endIndex
            if let bubble = items[..<next].last(where: {
                if case .user = $0 { return true } else { return false }
            }) {
                return bubble.id
            }
        }
        if let item = items.first(where: { seqs(of: $0).contains(anchor.seq) }) { return item.id }
        var before: String?
        for item in items {
            guard let first = seqs(of: item).min() else { continue }
            if first > anchor.seq { break }
            before = item.id
        }
        return before ?? items.first?.id
    }

    /// The row an item is drawn in: its own, or the folded run of tool calls it went into
    /// (`TranscriptRows.groupToolRuns`) — the id a `scrollTo` has to aim at to reach it.
    public static func rowID(containing itemID: String, in rows: [TranscriptRow]) -> String? {
        for row in rows {
            switch row {
            case .item(let item) where item.id == itemID:
                return row.id
            case .toolGroup(let cards) where cards.contains(where: { $0.id == itemID }):
                return row.id
            default:
                continue
            }
        }
        return nil
    }

    /// The seqs of the events an item was built from.
    private static func seqs(of item: TranscriptItem) -> [Int] {
        switch item {
        case .assistant(let b):        return b.seq.map { [$0] } ?? []
        case .thinking(let b):         return b.seq.map { [$0] } ?? []
        case .toolCall(let c):         return [c.inputSeq] + (c.resultSeq.map { [$0] } ?? [])
        case .interrupt(_, let seq):   return [seq]
        case .autoRetry(let n):        return [n.seq]
        case .user, .error, .authError, .notice: return []
        }
    }
}
