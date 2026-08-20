import Foundation

/// What to say about a message sent into a turn that was already running.
///
/// The server decides, under the Session row lock, whether a message queues behind the running
/// turn or joins it (`kind: "steer"`), and says which in the POST /turns response and on the
/// queued-turns list. The two look nothing alike to the person who sent one:
///
/// - a QUEUED message is waiting for its own turn. Nothing has read it, it can still be
///   withdrawn, and when it finally runs it gets a reply of its own.
/// - a STEER is already on its way into the turn in progress. It cannot be withdrawn (the engine
///   may be reading it as we ask), it produces no reply of its own — the running turn's does —
///   and so how far it got IS the whole visible outcome. Silence here is indistinguishable from a
///   message that was dropped, which is why every stage has a word for it.
///
/// The stages are the runner's, not invented here (`RunEventType.userDelivery`): a message is
/// accepted, then written into the engine's stdin, then echoed back by the engine, which is the
/// only moment it is really in the conversation. `enqueued` reads as "accepted" rather than as
/// its own stage — the runner taking it and the control plane taking it are the same promise to
/// the person waiting, and splitting them would be a distinction only the implementation can see.
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
            // In the engine's stdin, unread: `claude` inside a tool call reads nothing until that
            // tool finishes, so this can sit for as long as the tool runs. On its way, but past us.
            return SteerDeliveryState(label: "Delivering…", tone: .progress)
        case "acknowledged":
            // The engine echoed it back (--replay-user-messages). It is in the conversation.
            return SteerDeliveryState(label: "Sent into this turn", tone: .delivered)
        case "failed":
            return SteerDeliveryState(label: "Not delivered", tone: .failed)
        default:
            return SteerDeliveryState(label: "Sending…", tone: .progress)
        }
    }
}
