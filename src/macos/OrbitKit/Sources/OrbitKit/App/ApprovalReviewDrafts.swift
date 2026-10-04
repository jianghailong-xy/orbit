import Observation

/// Kept by the console, so closing a review or recycling its transcript row does not erase input.
@available(macOS 14.0, *)
@Observable
public final class ApprovalReviewDrafts {
    @ObservationIgnored private var questions: [String: QuestionReviewDraft] = [:]
    @ObservationIgnored private var owners: [String: OwnerReviewDraft] = [:]
    @ObservationIgnored private var coordinators: [String: CoordinatorReviewDraft] = [:]

    public init() {}

    public func question(_ id: String) -> QuestionReviewDraft {
        if let draft = questions[id] { return draft }
        let draft = QuestionReviewDraft()
        questions[id] = draft
        return draft
    }

    public func owner(_ requestID: String) -> OwnerReviewDraft {
        if let draft = owners[requestID] { return draft }
        let draft = OwnerReviewDraft()
        owners[requestID] = draft
        return draft
    }

    public func coordinator(_ itemID: String) -> CoordinatorReviewDraft {
        if let draft = coordinators[itemID] { return draft }
        let draft = CoordinatorReviewDraft()
        coordinators[itemID] = draft
        return draft
    }
}

@available(macOS 14.0, *)
@Observable
public final class QuestionReviewDraft {
    public var selections: [String: Set<String>] = [:]
    public var custom: [String: String] = [:]
}

@available(macOS 14.0, *)
@Observable
public final class OwnerReviewDraft {
    public var choices: [String: ReviewChoice] = [:]
    public var choicesFor: String?
}

@available(macOS 14.0, *)
@Observable
public final class CoordinatorReviewDraft {
    public var chosen: CoordinatorQuestionChoice?
    public var text = ""
    public var receipt: OwnerAnswerReceipt?
    public var sent = ""
}
