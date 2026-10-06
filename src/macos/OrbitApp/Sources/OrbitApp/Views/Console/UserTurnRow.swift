import SwiftUI
import OrbitKit

/// What a turn still waiting on the queue has that a delivered one does not. Everything else its
/// row says — "Not delivered", how far a steer has got — is the bubble's own and reads the same in
/// both states.
struct QueuedControls {
    /// Takes the turn back off the queue (`ConsoleModel.cancelQueued`): a card's Cancel, a watch
    /// wake's Withdraw. Nil until the server's turn id is known — the DELETE keys on it — and for a
    /// steer: written into the running turn rather than queued behind it, it is refused by the server,
    /// which will not withdraw what the engine may already be reading.
    let onCancel: (() -> Void)?

    init(bubble: UserBubble, cancel: @escaping () -> Void) {
        onCancel = bubble.turnId == nil || bubble.steer ? nil : cancel
    }
}

/// One user turn, drawn as the card it is — or as the owner's own bubble when it is none — both where
/// the transcript holds it (`TranscriptItemView`) and while it still waits on the queue
/// (`TranscriptRow.queued`, with `queued` set). This is the one place that decides which card a turn
/// is: the queue tail used to ask the same questions in a second chain of its own, which every card
/// reached later than the transcript did, or never (`taskStart`). A queued turn differs only in what
/// is the queue's: its Cancel and its dashed outline — and in its words, which still hold the blocks
/// that delivery moves into the note.
///
/// The order is the browser's (`NodeView`): who sent it, then the control plane's cards — each off the
/// payload recorded beside the turn (`UserBubble.cards`), never out of its words — and only then the
/// shapes the words can take, with the owner's bubble last.
struct UserTurnRow: View {
    let bubble: UserBubble
    /// What only a turn still waiting on the queue has; nil for one the transcript holds.
    var queued: QueuedControls? = nil

    var body: some View {
        let b = bubble
        let undelivered: Bool = b.undelivered || b.delivery == "failed"
        let cancel: (() -> Void)? = queued?.onCancel
        // Where a wake's block is: once delivered, the note the apiserver recorded beside the echo;
        // while queued, the turn's own words — nothing has been recorded yet (web parity: the queued
        // tail reads `q.content`).
        let wakeNote: String? = queued == nil ? b.note : b.text
        // Another Orbit session's message (`session_send` / `project_send`): somebody's words, but
        // not the reader's, so not the reader's bubble. Who sent it is what the control plane recorded
        // beside the turn (`sessionMessage`, `SessionMessage.parse`), so it is asked FIRST — before
        // anything is read out of the words, which are the sending agent's to choose and could take a
        // wake's shape — as the browser asks it (`NodeView`). No payload, the old reading. Cancel
        // hands none of it back to the composer (`ComposerLogic.restorableText`).
        //
        // An exception item's delivery is the control plane's too, and for a stronger reason than
        // the wakes below: nobody typed it at all. What the turn says is a paragraph written for the
        // AGENT — the tools to call, the ids to call them with — so drawing it as a message is both
        // wrong about who sent it and unreadable as a record: the item's kind, its title, the files a
        // merge conflicted on and whether the work has landed are all in the payload recorded beside
        // it (`openItemDelivery`, `OpenItemDelivery.parse`). That holds from the moment it is QUEUED,
        // not from the moment a runner takes it, so the queue draws the same card. With no payload the
        // turn keeps its old reading — this is checked before the wakes, as the browser checks it.
        if let card = b.sessionMessage {
            SessionMessageCardView(card: card, text: b.text, ts: b.ts,
                                   undelivered: undelivered,
                                   attached: b.attached, onCancelQueued: cancel)
        } else if let card = b.itemCard {
            // The note the same turn carried rides inside the card (`b.attached`): nobody typed
            // this turn either, so the control plane's words do not go back into a bubble in the
            // reader's own name — the same rule the wake card applies to a mixed note.
            OpenItemDeliveryCardView(card: card, text: b.text, ts: b.ts,
                                     undelivered: undelivered,
                                     attached: b.attached, onCancelQueued: cancel)
        } else if let card = b.taskStart {
            // A task run's opening turn is the brief written for the agent — the task, then four
            // steps of protocol — and nobody typed it either. With the task recorded beside it
            // (`taskStart`, `TaskStart.parse`) it is drawn as that task, with anything delivery
            // appended riding inside the card; the task's inputs the turn carried keep the
            // bubble's own image and file rows under it, with no words in the owner's name. A
            // resumed run's brief waits on the queue as the same card.
            VStack(alignment: .leading, spacing: 6) {
                TaskStartCardView(card: card, text: b.text, ts: b.ts,
                                  undelivered: undelivered,
                                  attached: b.attached, onCancelQueued: cancel)
                if !b.attachments.isEmpty {
                    UserBubbleView(bubble: inputsOnly(b))
                }
            }
        } else if let started = b.startedCard {
            // The message telling the coordinator its project was started: prose for the agent,
            // drawn as the card the payload recorded beside it (`projectStarted`,
            // `ProjectStarted.parse`). No payload, the old reading.
            ProjectStartedCardView(card: started, text: b.text, ts: b.ts,
                                   undelivered: undelivered,
                                   attached: b.attached, onCancelQueued: cancel)
        } else if let card = b.reviewRequest {
            // A confirmation request handed to this conversation to review, and a reviewer's
            // return handed to the run (`ConfirmationReviewTurns.swift`): Orbit's turns, drawn as
            // their cards with the block the agent read riding at the foot (web parity: NodeView).
            ReviewRequestedCardView(card: card, ts: b.ts,
                                    undelivered: undelivered,
                                    attached: b.attached, onCancelQueued: cancel)
        } else if let card = b.reviewReturn {
            SentBackByReviewerCardView(card: card, ts: b.ts,
                                       undelivered: undelivered,
                                       attached: b.attached, onCancelQueued: cancel)
        } else if let replies = b.sessionReplies, !replies.isEmpty {
            // The outcomes of this session's own requests, handed back (`sessionReplies`,
            // `SessionReply.parse`): a reply turn carries nobody's words, and a message of the
            // owner's may carry outcomes that were held for it — then the owner's words are their
            // bubble, first, and the outcomes follow as cards, with what else delivery appended
            // folded into them (web parity: NodeView). A queued reply turn's words are still the
            // blocks the cards draw, so it has no bubble.
            VStack(alignment: .leading, spacing: 6) {
                if queued == nil, !b.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    UserBubbleView(bubble: withoutNote(b))
                }
                SessionReplyCardsView(replies: replies, ts: b.ts, attached: replyRest(b),
                                      undelivered: undelivered, onCancelQueued: cancel)
            }
        } else if let wake = WatchWakeText.parse(b.text) {
            // A turn a watch queued is the watch's to show, not a message the user typed: it opens
            // with a raw UUID and carries the whole payload the agent read (web parity: NodeView).
            WatchWakeCardView(wake: wake, text: b.text, ts: b.ts,
                              undelivered: undelivered, onWithdraw: cancel)
        } else if let background = BackgroundWakeText.parse(wakeNote) {
            // A turn the control plane opened for a background job's news, or for a wakeup
            // coming due, is nobody's message either: the block IS the turn, so it is read off
            // the recorded note rather than the person's words, which are empty. Only the wake
            // blocks become the card — anything else the same note carried (the inventory a
            // returning engine is handed, a coordinator's standing role) is a folded entry in
            // the same card, because it is the control plane's too. It used to be an entry in a
            // user bubble under the card, which drew an empty bubble: a message with no words
            // in it, in the reader's own name. A job that ended while a turn ran was written
            // into that turn as a steer: the same line, where its echo landed inside the running
            // turn, saying how far it got (web parity: `Transcript.tsx`'s `steer=`) — and, while
            // it waits for the runner, with no Cancel, because nothing takes a steer back.
            VStack(alignment: .leading, spacing: 6) {
                BackgroundWakeCardView(wake: background, ts: b.ts,
                                       undelivered: undelivered,
                                       attached: attachedRest(background),
                                       onCancelQueued: cancel,
                                       steerState: BackgroundWakeCard.steerState(
                                           steer: b.steer, delivery: b.delivery,
                                           undelivered: b.undelivered),
                                       queued: queued != nil)
                if queued == nil, BackgroundWakeCard.drawsBubble(text: b.text) {
                    UserBubbleView(bubble: withoutNote(b))
                }
            }
        } else {
            UserBubbleView(bubble: b, onCancelQueued: cancel)
        }
    }

    /// What the wake card did NOT take, as the entry folded inside it — so a mixed note still shows
    /// its other blocks instead of repeating the wake beneath the card.
    private func attachedRest(_ wake: BackgroundWake) -> (kind: String, text: String)? {
        wake.rest.isEmpty ? nil : (kind: describeNote(wake.rest), text: wake.rest)
    }

    /// What the reply cards did NOT take from a turn's note, as the entry folded inside them.
    private func replyRest(_ bubble: UserBubble) -> (kind: String, text: String)? {
        let rest = SessionReply.withoutReplyBlocks(bubble.note)
        return rest.isEmpty ? nil : (kind: describeNote(rest), text: rest)
    }

    /// The same bubble with the note taken off it: all of it is the card's now, so leaving it here
    /// would draw it a second time under the card that already holds it.
    private func withoutNote(_ bubble: UserBubble) -> UserBubble {
        var bare = bubble
        bare.note = nil
        return bare
    }

    /// The same bubble holding only what it was sent with: the brief and the note are the task-start
    /// card's, so what is left is the images and files, drawn as the bubble draws them. Not pending:
    /// whether the turn is still queued is the card's to say, not a second line under the images.
    private func inputsOnly(_ bubble: UserBubble) -> UserBubble {
        var inputs = bubble
        inputs.text = ""
        inputs.note = nil
        inputs.pending = false
        return inputs
    }
}
