import Foundation

/// The cards a user turn is drawn as, held as one value — this end's copy of the apiserver's
/// `TurnCards` (sessions/turn-cards.ts), which the runner's echo and both views of the queue read.
///
/// A turn the control plane opened is drawn as a card rather than as the owner's own message, and it
/// is drawn twice: while it waits on the queue (`QueuedTurnInfo`, folded in by
/// `TranscriptReducer.reconcileQueuedTurns`) and once the runner echoes it (the `user` event). Each
/// card used to be copied onto the queued row by hand, field by field and twice over — once for the
/// row reconciled in place and once for the row first seen in a listing — so a card could reach the
/// echo and never the queue: `taskStart` never did. The queue's cards are now gathered in one place
/// (`QueuedTurnInfo.cards`) and set as a whole (`UserBubble.cards`); `QueuedTurnCardsTests` fails for
/// a card `UserBubble` grows without them.
public struct TurnCards: Equatable, Sendable {
    public var itemCard: OpenItemDelivery?
    public var taskStart: TaskStart?
    public var startedCard: ProjectStarted?
    public var sessionMessage: SessionMessage?
    public var sessionReplies: [SessionReply]?
    public var reviewRequest: ConfirmationReviewRequestCard?
    public var reviewReturn: ConfirmationReturnCard?

    public init(itemCard: OpenItemDelivery? = nil, taskStart: TaskStart? = nil,
                startedCard: ProjectStarted? = nil, sessionMessage: SessionMessage? = nil,
                sessionReplies: [SessionReply]? = nil,
                reviewRequest: ConfirmationReviewRequestCard? = nil,
                reviewReturn: ConfirmationReturnCard? = nil) {
        self.itemCard = itemCard
        self.taskStart = taskStart
        self.startedCard = startedCard
        self.sessionMessage = sessionMessage
        self.sessionReplies = sessionReplies
        self.reviewRequest = reviewRequest
        self.reviewReturn = reviewReturn
    }
}

extension UserBubble {
    /// Every card this turn is drawn as. Setting it sets each card field, so a card the new value
    /// does not hold is cleared rather than left over from an earlier reading.
    public var cards: TurnCards {
        get {
            TurnCards(itemCard: itemCard, taskStart: taskStart, startedCard: startedCard,
                      sessionMessage: sessionMessage, sessionReplies: sessionReplies,
                      reviewRequest: reviewRequest, reviewReturn: reviewReturn)
        }
        set {
            itemCard = newValue.itemCard
            taskStart = newValue.taskStart
            startedCard = newValue.startedCard
            sessionMessage = newValue.sessionMessage
            sessionReplies = newValue.sessionReplies
            reviewRequest = newValue.reviewRequest
            reviewReturn = newValue.reviewReturn
        }
    }
}
