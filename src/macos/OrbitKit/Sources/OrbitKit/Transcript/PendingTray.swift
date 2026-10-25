import Foundation

/// One row of the tray above the composer: a message the reader sent that nothing has read yet
/// (docs/mocks/steer-tray, decided 2026-10-16). Web parity: `PendingTray.tsx`'s `PendingTrayRow`.
public struct PendingTrayRow: Identifiable, Equatable, Sendable {
    /// Where the message is going: into the turn running now (a steer), or the next turn.
    public enum Heading: Equatable, Sendable { case currentTurn, nextTurn }

    public var id: String { bubble.id }
    /// The message, for the actions the row offers to act on.
    public let bubble: UserBubble
    public let heading: Heading
    /// What the row says: the reader's words, a `!cmd` as the command, or what a message of
    /// attachments alone carries ("1 image").
    public let text: String
    /// How it stands: Sending…, Waiting to be read, Withdrawing…, Queued for next turn.
    public let state: String
    /// A press for it is out: the row dims and offers nothing to press twice.
    public let busy: Bool
    /// Withdraw: taken back, its words returned to the composer. Not where nothing can give it back
    /// (a Codex steer once Codex has it).
    public let offersWithdraw: Bool
    /// Steer: a queued message sent into the turn running now.
    public let offersSteer: Bool
}

public enum PendingTray {
    /// Whether a bubble on the queue waits in the tray rather than in the transcript's tail: the
    /// reader's own words still on their way — queued for the next turn, or a steer no runner has
    /// taken yet. What Orbit queued stays in the tail as its card, and a message whose delivery
    /// settled undelivered stays in the conversation with that outcome. Web parity:
    /// `WorkspaceView.tsx`'s `inPendingTray`.
    public static func holds(_ bubble: UserBubble) -> Bool {
        !bubble.undelivered && !SteerDelivery.settles(bubble.delivery) && SteerDelivery.isReadersOwn(bubble)
    }

    /// The tray's rows, in the order they were sent: the reader's steers nothing has read
    /// (`TranscriptState.unreadSteers`) and their messages still on the queue (`holds`).
    /// `withdrawing` and `steering` are the turns a press is out for; `steerOffered` whether a turn
    /// is running on an engine that can take a message into one.
    public static func rows(state: TranscriptState, withdrawing: Set<String>, steering: Set<String>,
                            steerOffered: Bool) -> [PendingTrayRow] {
        func asked(_ set: Set<String>, _ bubble: UserBubble) -> Bool {
            bubble.turnId.map { set.contains($0) } ?? false
        }
        let unread = state.unreadSteers.map { bubble -> PendingTrayRow in
            // Missed the turn it was aimed at and handed back to run as the next one: queued now,
            // and shortly the message that opens that turn.
            let requeued = bubble.delivery == "requeued"
            let taking = asked(withdrawing, bubble)
            return PendingTrayRow(
                bubble: bubble, heading: requeued ? .nextTurn : .currentTurn, text: text(of: bubble),
                state: taking ? "Withdrawing…" : requeued ? "Queued for next turn" : SteerDelivery.state(bubble.delivery).label,
                busy: taking,
                offersWithdraw: !taking && !requeued && SteerDelivery.offersWithdraw(bubble),
                offersSteer: false)
        }
        let queued = state.queued.filter(holds).map { bubble -> PendingTrayRow in
            let steering = asked(steering, bubble)
            let intoTurn = bubble.steer || steering
            let taking = asked(withdrawing, bubble)
            let busy = taking || steering
            return PendingTrayRow(
                bubble: bubble, heading: intoTurn ? .currentTurn : .nextTurn, text: text(of: bubble),
                state: taking ? "Withdrawing…" : intoTurn ? SteerDelivery.state(nil).label : "Queued for next turn",
                busy: busy,
                // Not handed to a runner yet, either way: the server takes it back alone — once its
                // turn id, which the DELETE keys on, is known.
                offersWithdraw: !busy && bubble.turnId != nil && (!bubble.steer || SteerDelivery.offersWithdraw(bubble)),
                offersSteer: !busy && !intoTurn && !bubble.shell && bubble.turnId != nil && steerOffered)
        }
        // A row this end just sent has no receipt time yet: it is the newest. Stable for the rest.
        return (unread + queued).enumerated()
            .sorted { a, b in
                let x = a.element.bubble.ts ?? "\u{FFFF}", y = b.element.bubble.ts ?? "\u{FFFF}"
                return x == y ? a.offset < b.offset : x < y
            }
            .map(\.element)
    }

    /// What a row of pictures and files alone says instead of words: "1 image", "2 images, 1 file".
    public static func summary(images: Int, files: Int) -> String {
        [images > 0 ? "\(images) image\(images == 1 ? "" : "s")" : nil,
         files > 0 ? "\(files) file\(files == 1 ? "" : "s")" : nil]
            .compactMap { $0 }.joined(separator: ", ")
    }

    static func text(of bubble: UserBubble) -> String {
        let words = bubble.text.trimmingCharacters(in: .whitespacesAndNewlines)
        if !words.isEmpty { return bubble.shell ? "!\(words)" : words }
        let images = bubble.attachments.filter(\.isImage).count
        return summary(images: images, files: bubble.attachments.count - images)
    }
}
