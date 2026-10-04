import Foundation

// The two readings the control plane records beside a confirmation review's turns
// (docs/owner-confirmation-review-contract.md §2 D7, §8 B3): `confirmationReviewRequest` on the turn
// that asks a reviewer to review a run's report, and `confirmationReturn` on the turn that hands the
// reviewer's return to the run. Both turns are Orbit's — their words are a block written for the
// agent — so the console draws the card these describe rather than a bubble in the reader's name.
//
// The web reads the same payloads with `lib/confirmationReviewTurns.ts`; this is that rule for iOS
// and macOS: a payload that is not one parses as NOTHING rather than as half a card, which leaves
// every other turn drawn exactly as it was.

/// The turn that asks a reviewer to review a run's report (D7): drawn as `Review requested`.
public struct ConfirmationReviewRequestCard: Codable, Equatable, Sendable {
    public let requestId: String
    public let reviewId: String
    public let taskId: String
    public let title: String
    /// The run that reported: where `Open task session` goes.
    public let runSessionId: String
    public let branch: String?
    public let sha: String?
    public let dueAt: String

    public init(requestId: String, reviewId: String = "", taskId: String, title: String,
                runSessionId: String, branch: String? = nil, sha: String? = nil, dueAt: String) {
        self.requestId = requestId
        self.reviewId = reviewId
        self.taskId = taskId
        self.title = title
        self.runSessionId = runSessionId
        self.branch = branch
        self.sha = sha
        self.dueAt = dueAt
    }

    /// The card a `user` event's payload carries, or nil for every other turn.
    public static func parse(_ payload: JSONValue) -> ConfirmationReviewRequestCard? {
        parseCard(payload["confirmationReviewRequest"])
    }

    public static func parseCard(_ value: JSONValue?) -> ConfirmationReviewRequestCard? {
        guard case .object(let card)? = value,
              let requestId = card["requestId"]?.stringValue,
              let taskId = card["taskId"]?.stringValue, !taskId.isEmpty,
              let title = card["title"]?.stringValue,
              let run = card["runSessionId"]?.stringValue,
              let dueAt = card["dueAt"]?.stringValue else { return nil }
        return ConfirmationReviewRequestCard(requestId: requestId,
                                             reviewId: card["reviewId"]?.stringValue ?? "",
                                             taskId: taskId, title: title, runSessionId: run,
                                             branch: card["branch"]?.stringValue,
                                             sha: card["sha"]?.stringValue, dueAt: dueAt)
    }
}

/// The turn that hands a reviewer's return to the run (§8 B3): drawn as `Sent back by the reviewer`,
/// never as the owner's message.
public struct ConfirmationReturnCard: Codable, Equatable, Sendable {
    public let requestId: String
    public let recordId: String
    public let reviewerSessionId: String?
    public let reviewerTitle: String?
    public let reason: String
    public let problems: [ConfirmationReviewItem]

    public init(requestId: String, recordId: String = "", reviewerSessionId: String? = nil,
                reviewerTitle: String? = nil, reason: String, problems: [ConfirmationReviewItem] = []) {
        self.requestId = requestId
        self.recordId = recordId
        self.reviewerSessionId = reviewerSessionId
        self.reviewerTitle = reviewerTitle
        self.reason = reason
        self.problems = problems
    }

    public static func parse(_ payload: JSONValue) -> ConfirmationReturnCard? {
        parseCard(payload["confirmationReturn"])
    }

    public static func parseCard(_ value: JSONValue?) -> ConfirmationReturnCard? {
        guard case .object(let card)? = value,
              let requestId = card["requestId"]?.stringValue,
              let reason = card["reason"]?.stringValue else { return nil }
        var problems: [ConfirmationReviewItem] = []
        if case .array(let raw)? = card["problems"] {
            for value in raw {
                guard case .object(let item) = value, let text = item["text"]?.stringValue else { continue }
                var refs: [String]?
                if case .array(let list)? = item["evidenceRefs"] { refs = list.compactMap(\.stringValue) }
                problems.append(ConfirmationReviewItem(key: item["key"]?.stringValue ?? "", text: text,
                                                       evidenceRefs: refs))
            }
        }
        return ConfirmationReturnCard(requestId: requestId, recordId: card["recordId"]?.stringValue ?? "",
                                      reviewerSessionId: card["reviewerSessionId"]?.stringValue,
                                      reviewerTitle: card["reviewerTitle"]?.stringValue,
                                      reason: reason, problems: problems)
    }
}

/// The ways out of the two cards, as the app's own `orbit-task:` / `orbit-session:` doors — the
/// task whose report is asked about, the run that reported, and the reviewer that sent it back. Nil
/// for an id that names nothing, which the card then draws as plain text.
public enum ConfirmationReviewTurnLinks {
    public static func task(_ id: String?) -> URL? { link(id, scheme: "orbit-task") }
    public static func session(_ id: String?) -> URL? { link(id, scheme: "orbit-session") }

    private static func link(_ id: String?, scheme: String) -> URL? {
        guard let id, PublicID.toUUID(id) != nil else { return nil }
        return URL(string: "\(scheme):\(id)")
    }
}
