import Foundation

/// What to say about a message sent into a turn that was already running.
///
/// The server decides, under the Session row lock, whether a message queues behind the running
/// turn or joins it (`kind: "steer"`), and says which in the POST /turns response and on the
/// queued-turns list. The two look nothing alike to the person who sent one:
///
/// - a QUEUED message is waiting for its own turn. Nothing has read it, it can still be
///   cancelled, and when it finally runs it gets a reply of its own.
/// - a STEER is already on its way into the turn in progress. It produces no reply of its own —
///   the running turn's does — and so how far it got IS the whole visible outcome. Silence here is
///   indistinguishable from a message that was dropped, which is why every stage has a word for it.
///   Until the engine reads it, it can be withdrawn where the engine can drop it unread and say so
///   (claude: its runner marks the steer `withdrawable`); once read, it is part of the turn.
///
/// The words follow the read receipts people already know from chat: sending, then waiting to be
/// read, then read. Once the engine has it the message has arrived; what it waits for is the
/// engine, not the wire.
///
/// The stages are the runner's, not invented here (`RunEventType.userDelivery`): a message is
/// accepted, then handed to the engine, then echoed back by it, which is the only moment it is
/// really in the conversation. How each engine takes one differs — claude reads a frame off a
/// stdin that stays open, codex is asked to write it into the turn (`turn/steer`) — but the
/// stages mean the same thing on both, which is why there is one vocabulary and not two.
/// `enqueued` reads as "accepted" rather than as its own stage — the runner taking it and the
/// control plane taking it are the same promise to the person waiting, and splitting them would
/// be a distinction only the implementation can see.
///
/// The web twin is `web/src/lib/steerDelivery.ts`; the labels are deliberately identical, so the
/// same message reads the same on every client watching it.
public enum SteerDeliveryTone: Equatable, Sendable {
    /// Accepted, not yet in the conversation.
    case progress
    /// The engine echoed it back — it is in the conversation.
    case delivered
    /// It never reached the engine.
    case failed
}

public struct SteerDeliveryState: Equatable, Sendable {
    /// The word shown under the bubble.
    public let label: String
    public let tone: SteerDeliveryTone

    public init(label: String, tone: SteerDeliveryTone) {
        self.label = label
        self.tone = tone
    }
}

public enum SteerDelivery {
    /// Was this turn filed as a steer? `kind` comes from POST /turns or GET /sessions/:id/turns.
    public static func isSteerKind(_ kind: String?) -> Bool { kind == "steer" }

    /// The stage a steer is at, from the `delivery` its `user` event opened with and every
    /// `user_delivery` that amended it. `nil` covers the window before any event exists at all —
    /// the control plane has accepted the message and the runner has not yet leased it — which is
    /// the same promise as `enqueued` and reads the same.
    public static func state(_ delivery: String?) -> SteerDeliveryState {
        switch delivery {
        case "written":
            // The engine has it and the model has not read it yet: `claude` busy in a tool call
            // takes it into the conversation only when that tool finishes, and codex buffers a
            // steer until its next model request — measured at 31 seconds. It has arrived; what it
            // waits for is the engine.
            return SteerDeliveryState(label: "Waiting to be read", tone: .progress)
        case "acknowledged":
            // The engine echoed it back (claude's --replay-user-messages, codex's userMessage
            // item). The message is in the conversation, and the reply this turn gives is the
            // answer to it.
            return SteerDeliveryState(label: "Read in this turn", tone: .delivered)
        case "requeued":
            // It missed the turn it was aimed at, and the runner can prove nothing read it, so
            // it goes back to being an ordinary queued message. The one non-delivery that still
            // ends with the message being read — progress, not failure.
            return SteerDeliveryState(label: "Queued for next turn instead", tone: .progress)
        case "failed":
            return SteerDeliveryState(label: "Not delivered", tone: .failed)
        case "unconfirmed":
            // It reached the engine; whether the engine read it is what nobody can say. Neutral on
            // purpose: it may have been acted on, and a resend would do the work twice.
            return SteerDeliveryState(label: "Couldn't confirm it was read", tone: .failed)
        default:
            return SteerDeliveryState(label: "Sending…", tone: .progress)
        }
    }

    /// The runner's word that the engine dropped a steer unread at its sender's request: nothing
    /// will ever read it, so its bubble leaves the transcript (`TranscriptReducer`).
    public static let withdrawn = "withdrawn"

    /// Whether this delivery ends a steer's wait: read into the turn, or provably or possibly never.
    /// Until then a steer of the reader's waits in the tray above the composer, out of the
    /// conversation (`TranscriptState.unreadSteers`); from then on it is drawn where it settled.
    /// Web parity: `Transcript.tsx`'s `SETTLED_STEER_DELIVERY`.
    public static func settles(_ delivery: String?) -> Bool {
        delivery == "acknowledged" || delivery == "failed" || delivery == "unconfirmed"
    }

    /// Whether a user turn is the reader's own words and nothing else's: what the tray above the
    /// composer holds while nothing has read it (`PendingTray`). A steer Orbit filed — a job's exit,
    /// a request's outcome — or another session's message stays where its echo lands; a wake on the
    /// queue stays in the transcript's tail. The bubble's `text` is the reader's part of an echo and
    /// its `note` what delivery appended; a queued wake has its block as its text. Web parity:
    /// `Transcript.tsx`'s `readersOwnWords` and the queue's `returnsToComposer`.
    public static func isReadersOwn(_ b: UserBubble) -> Bool {
        !b.authoredByOrbit && b.itemCard == nil && b.taskStart == nil && b.startedCard == nil
            && b.sessionMessage == nil && b.sessionReplies == nil
            && b.reviewRequest == nil && b.reviewReturn == nil
            && WatchWakeText.parse(b.text) == nil
            && BackgroundWakeText.parse(b.text) == nil && BackgroundWakeText.parse(b.note) == nil
    }

    /// Whether this runtime can take a message into a running turn at all, whatever its runner
    /// declared — what a client asks before it offers to send a queued message into the turn (the
    /// tray's Steer) or to queue one instead. The server still asks the runner and refuses one too
    /// old. The twin of `runtimeTakesMidTurnSteer` in shared/src/providerTransport.ts: claude always,
    /// codex on a runner that declared `turn/steer`; kimi, DeepSeek Harness, OpenCode and Antigravity
    /// never, a message sent there mid-turn queues.
    public static func runtimeTakesMidTurnSteer(_ runtime: String) -> Bool {
        runtime == "claude" || runtime == "codex"
    }

    /// Whether to offer taking a steer back: its runner said the engine can drop it unread
    /// (`withdrawable` on its user event), and nothing has read, failed or withdrawn it since.
    public static func offersWithdraw(delivery: String?, withdrawable: Bool) -> Bool {
        withdrawable && (delivery == nil || delivery == "enqueued" || delivery == "written")
    }

    /// Whether this bubble offers to take its steer back. While the server still holds it —
    /// `pending`, not yet echoed by any runner — it can be had back whatever the engine: the
    /// server simply deletes it. Once a runner holds it, only where that runner said its engine
    /// can drop it unread. Either way only for words somebody typed
    /// (`ComposerLogic.restorableText`), which are what a withdrawal hands back to the composer,
    /// and only once the server's turn id is known, which the DELETE keys on. Web parity:
    /// `Transcript.tsx`'s `SteerState` and the queued tail's `onWithdraw`.
    public static func offersWithdraw(_ bubble: UserBubble) -> Bool {
        guard bubble.steer, bubble.turnId != nil, !bubble.undelivered,
              ComposerLogic.restorableText(of: bubble) != nil else { return false }
        return offersWithdraw(delivery: bubble.delivery,
                              withdrawable: bubble.pending || bubble.withdrawable)
    }

    /// Whether this bubble offers "Put back in the composer": words the reader typed
    /// (`ComposerLogic.restorableText`) that never reached the engine — `failed`, or drained unrun
    /// when the run ended (`undelivered`) — or that only the server's receipt says did not land
    /// (`receipt`, `unconfirmed` included). Not a message the conversation holds as `unconfirmed`: it
    /// may have been acted on, and its words back in the box invite doing the work twice. Web
    /// parity: `Transcript.tsx`'s `UserBubble` puts back `failed` alone, `QueuedTurnMeta` any receipt.
    public static func offersPutBack(_ bubble: UserBubble) -> Bool {
        (bubble.undelivered || bubble.receipt) && ComposerLogic.restorableText(of: bubble) != nil
    }

    /// Why a message did not land, in the sender's words rather than the protocol's: what stopped
    /// reading it. The receipt's own reason stands in for a code these words do not cover. Web
    /// parity: `steerDelivery.ts`'s `deliveryFailureExplanation`.
    public static func failureExplanation(code: String?, reason: String?) -> String? {
        switch code {
        case "CURRENT_WORK_TARGET_COMPLETED":
            return "The turn finished before it was read."
        case "CURRENT_WORK_INTERRUPTED":
            return "The turn was interrupted before it was read."
        case "CURRENT_WORK_SESSION_ENDED", "CURRENT_WORK_SESSION_FINALIZED":
            return "The session ended before it was read."
        case "CURRENT_WORK_SESSION_REAPED":
            return "The runner disappeared while it was being delivered."
        case "CURRENT_WORK_RUNTIME_REJECTED":
            return "The engine rejected it."
        default:
            return reason
        }
    }
}
