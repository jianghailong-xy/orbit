import Foundation

/// Whether the composer can send, and whether the message will run now or queue. Queue-while-
/// running is allowed (the durable PENDING turn), so a send during a live turn is accepted and
/// queued rather than blocked.
public enum SendAvailability: Equatable, Sendable {
    case sendNow        // session parked/resumable → starts (or resumes) immediately
    case queue          // a turn is in flight, or the session is still queued → message queues
    case blocked        // nothing actionable
}

public enum ComposerLogic {
    /// Map session status → send availability. Terminal statuses are `sendNow` because a send
    /// revives them via `--resume` (full context preserved).
    public static func availability(status: RunStatus) -> SendAvailability {
        switch status {
        case .awaitingInput, .interrupted, .parked: return .sendNow
        case .running, .pending: return .queue
        case .succeeded, .failed, .cancelled: return .sendNow
        }
    }

    /// True when a terminal-but-resumable session should be revived via POST /resume rather
    /// than POST /turns.
    public static func shouldResume(status: RunStatus) -> Bool {
        switch status {
        case .succeeded, .failed, .cancelled, .parked: return true
        default: return false
        }
    }

    public static func makeTurn(clientTurnId: String, text: String, shell: Bool,
                                attachmentIds: [String]) -> SessionTurnRequest {
        SessionTurnRequest(clientTurnId: clientTurnId,
                           content: text,
                           kind: shell ? "shell" : "message",
                           attachmentIds: attachmentIds.isEmpty ? nil : attachmentIds)
    }
}

/// Builds a `multipart/form-data` body for attachment upload (POST /attachments). Kept pure so
/// the byte layout is unit-testable without a network round-trip.
public enum Multipart {
    public static func boundary(seed: Int) -> String { "orbit.boundary.\(seed)" }

    public static func body(boundary: String, fieldName: String, filename: String,
                            mimeType: String, fileData: Data) -> Data {
        var body = Data()
        func append(_ s: String) { body.append(Data(s.utf8)) }
        append("--\(boundary)\r\n")
        append("Content-Disposition: form-data; name=\"\(fieldName)\"; filename=\"\(filename)\"\r\n")
        append("Content-Type: \(mimeType)\r\n\r\n")
        body.append(fileData)
        append("\r\n--\(boundary)--\r\n")
        return body
    }
}
