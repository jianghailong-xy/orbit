import Foundation

/* ─────────────────────────────────────────────────────────────────────────────────────────────
   RESTART THE TASK — THE OWNER'S ONE PRESS ON EVIDENCE NOBODY ELSE CAN MOVE
   ─────────────────────────────────────────────────────────────────────────────────────────────

   docs/evidence-always-has-an-addressee-design.md §3, D2 = A. A revision that can no longer be
   decided (its standard was reworded or deleted, or the task moved) goes to the task's live run, or
   to an Automatic project's coordinator. Only when there is neither does the owner's pending read
   carry it, in `waitingOnYou`, with `ownerAction: RESTART_TASK` — and then the owner's card offers
   the one thing the owner can do: start the task, so a new run files evidence against the standard
   it is held to now.

   It is a Run press, not a decision: `POST /tasks/:taskId/evidence/:revision/restart` with the Run
   press's `triggerId`. The server asks its own placement again at the press and refuses with 409
   `EVIDENCE_RESTART_NOT_OFFERED` once the row is no longer the owner's to move.

   The words are the web's (`EvidenceRestartAction.tsx`) and Android's, all three pinned by
   `src/shared/src/evidence-restart-copy.fixture.json` (`EvidenceRestartCopyParityTests`).
   ───────────────────────────────────────────────────────────────────────────────────────────── */

/// The body of one Restart press: the Run press's own name for it (`RunTaskRequest`).
public struct EvidenceRestartRequest: Codable, Equatable, Sendable {
    public let triggerId: String

    public init(triggerId: String) {
        self.triggerId = triggerId
    }
}

/// What the restart door returns once it has started the task. Only the address is read back.
public struct EvidenceRestartResult: Codable, Equatable, Sendable {
    public let taskId: String
    public let evidenceRevision: String
    public let action: String
}

public enum EvidenceRestart {

    /// The `ownerAction` value that offers this press, in the server's spelling.
    public static let ownerAction = "RESTART_TASK"
    /// The server's code for a press that is no longer offered.
    public static let notOfferedCode = "EVIDENCE_RESTART_NOT_OFFERED"

    // MARK: the copy (`evidence-restart-copy.fixture.json`)

    /// The button (`EVIDENCE_RESTART_ACTION`).
    public static let action = "Restart the task"
    /// What the press does, above it (`EVIDENCE_RESTART_EXPLANATION`).
    public static let explanation =
        "No run of this task is live to submit it again, and no coordinator was told to act on it. "
        + "Restart the task and a new run will submit evidence against the standard it is held to now."
    /// The line that replaces the button once the task is started (`EVIDENCE_RESTART_STARTED`).
    public static let started = "Restarted: a new run will submit the evidence again."
    /// A refusal's title (`EVIDENCE_RESTART_REFUSED`), and the one for a row that moved on
    /// (`EVIDENCE_RESTART_STALE`).
    public static let refused = "Not restarted"
    public static let stale = "Not restarted: this row is out of date"
    /// The card's heading: the web strip's group label, `WAITING_ON_YOU_LABEL`, in this client's
    /// own spelling of it.
    public static let heading = OwnerRequests.waitingOnYou

    // MARK: which rows offer it

    /// The rows this reader is offered Restart the task on: `waitingOnYou` rows carrying the action.
    /// The server already places them only where the owner reads the task's work, so nothing more is
    /// filtered here.
    public static func rows(queue: EvidenceDecisionQueue?) -> [EvidenceDecisionRow] {
        (queue?.waitingOnYou ?? []).filter(offers)
    }

    /// Whether this row offers the press. An `ownerAction` this build does not know offers nothing.
    public static func offers(_ row: EvidenceDecisionRow) -> Bool {
        row.ownerAction == ownerAction
    }

    // MARK: the press

    /// The path one press is made at, for the revision the row was read at.
    public static func path(taskID: String, evidenceRevision: String) -> String {
        "tasks/\(taskID)/evidence/\(evidenceRevision)/restart"
    }

    /// What a refusal says: out of date when the server's code means the row moved on, plain
    /// otherwise. The server's own message is shown beside it (`APIClient.failureReason`).
    public static func refusalTitle(_ error: Error) -> String {
        isNotOffered(error) ? stale : refused
    }

    /// Whether the server refused because the row is no longer the owner's to move.
    public static func isNotOffered(_ error: Error) -> Bool {
        guard case .http(let status, let body)? = error as? APIError, status == 409, let body,
              let data = body.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { return false }
        return object["code"] as? String == notOfferedCode
    }
}
