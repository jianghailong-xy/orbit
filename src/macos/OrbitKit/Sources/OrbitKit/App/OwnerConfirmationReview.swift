import Foundation

/* ─────────────────────────────────────────────────────────────────────────────────────────────
   THE REVIEW BAR — THE NATIVE HALF OF WEB'S `OwnerConfirmationReview.tsx`
   ─────────────────────────────────────────────────────────────────────────────────────────────

   A run that declares its work finished is reviewed before its owner is asked
   (docs/owner-confirmation-review-contract.md): the project's coordinator conversation, or the
   conversation the task was filed from. The card draws where that got to between what the agent
   said and If you confirm, in a box that names the reviewer — `REVIEW · <reviewer> · <time>` and
   the commit it read. Under the box's label everything is the reviewer's own words except the first
   line, which is Orbit's, worked out from the reviewer's lists (option B: what is left, before what
   the reviewer thinks).

   Nothing here locks the door: the buttons are the same in every state. A review's questions only
   add answers that ride with Confirm done, each preselected to its recommendation — so the one
   thing that can disable Confirm done is an Other the owner picked and has not written yet.

   The bar is data before it is a view (`reviewBar`), and that data is proved against
   `src/shared/src/owner-confirmation-review.fixture.json` here (`OwnerConfirmationReviewTests`) and
   in the web card's test, so the browser, the Mac and the phone draw the same lines.
   ───────────────────────────────────────────────────────────────────────────────────────────── */

// MARK: - the read, as the server publishes it (`@orbit/shared` owner-confirmation-review.ts)

/// One line of a review. `criterionKey` / `whyNotProven` / `coordinatorChecked` / `evidenceRefs`
/// are AcceptedGap's fields, with the same names and meanings.
public struct ConfirmationReviewItem: Codable, Equatable, Sendable, Identifiable {
    /// Given by the server: c1… checked, x1… notChecked, n1… needsYou, o1… leftOpen, p1… problems.
    public let key: String
    public let text: String
    public let criterionKey: String?
    public let whyNotProven: String?
    public let coordinatorChecked: String?
    public let evidenceRefs: [String]?

    public var id: String { key }

    public init(key: String, text: String, criterionKey: String? = nil, whyNotProven: String? = nil,
                coordinatorChecked: String? = nil, evidenceRefs: [String]? = nil) {
        self.key = key
        self.text = text
        self.criterionKey = criterionKey
        self.whyNotProven = whyNotProven
        self.coordinatorChecked = coordinatorChecked
        self.evidenceRefs = evidenceRefs
    }
}

/// One answer a question offers: ask_owner's shape.
public struct ConfirmationNeedsYouOption: Codable, Equatable, Sendable {
    public let label: String
    public let description: String?

    public init(label: String, description: String? = nil) {
        self.label = label
        self.description = description
    }
}

/// A line only the owner can decide: a question, its options, and the one the card preselects.
public struct ConfirmationNeedsYouItem: Codable, Equatable, Sendable, Identifiable {
    public let key: String
    public let text: String
    public let criterionKey: String?
    public let evidenceRefs: [String]?
    public let options: [ConfirmationNeedsYouOption]
    /// Index into `options`: preselected, and tagged Recommended.
    public let recommendedOption: Int

    public var id: String { key }

    public init(key: String, text: String, criterionKey: String? = nil, evidenceRefs: [String]? = nil,
                options: [ConfirmationNeedsYouOption], recommendedOption: Int) {
        self.key = key
        self.text = text
        self.criterionKey = criterionKey
        self.evidenceRefs = evidenceRefs
        self.options = options
        self.recommendedOption = recommendedOption
    }
}

/// The states a review is read in (§4 T1).
public enum OwnerConfirmationReviewState: String, Codable, Equatable, Sendable {
    case underReview = "UNDER_REVIEW"
    case reviewed = "REVIEWED"
    case notReviewed = "NOT_REVIEWED"
    case outdated = "OUTDATED"
    case returned = "RETURNED"
}

/// Why nobody reviewed it (§4 T2). A reason this build does not know reads as `.unknown`, and the
/// bar then says who has checked the work without guessing why nobody else did.
public enum OwnerConfirmationNotReviewedReason: String, Codable, Equatable, Sendable {
    case timedOut = "TIMED_OUT"
    case reviewerEnded = "REVIEWER_ENDED"
    case reviewerStopped = "REVIEWER_STOPPED"
    case noCoordinator = "NO_COORDINATOR"
    case automaticOff = "AUTOMATIC_OFF"
    case coordinatorPaused = "COORDINATOR_PAUSED"
    case unreachable = "UNREACHABLE"
    case unknown = "UNKNOWN"

    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = OwnerConfirmationNotReviewedReason(rawValue: raw) ?? .unknown
    }
}

/// Orbit's first line, as the server worked it out of the record shown (§6 H2).
public enum ConfirmationReviewHeadline: Codable, Equatable, Sendable {
    case needsYou(text: String, more: Int)
    case nothingNeedsYou(notChecked: Int)
    case problemsAfterConfirm(problems: Int)

    private enum CodingKeys: String, CodingKey { case kind, text, more, notChecked, problems }

    public init(from decoder: Decoder) throws {
        let box = try decoder.container(keyedBy: CodingKeys.self)
        switch try box.decode(String.self, forKey: .kind) {
        case "NEEDS_YOU":
            self = .needsYou(text: try box.decode(String.self, forKey: .text),
                             more: try box.decode(Int.self, forKey: .more))
        case "NOTHING_NEEDS_YOU":
            self = .nothingNeedsYou(notChecked: try box.decode(Int.self, forKey: .notChecked))
        case "PROBLEMS_AFTER_CONFIRM":
            self = .problemsAfterConfirm(problems: try box.decode(Int.self, forKey: .problems))
        case let kind:
            throw DecodingError.dataCorruptedError(forKey: .kind, in: box,
                                                   debugDescription: "unknown headline \(kind)")
        }
    }

    public func encode(to encoder: Encoder) throws {
        var box = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .needsYou(let text, let more):
            try box.encode("NEEDS_YOU", forKey: .kind)
            try box.encode(text, forKey: .text)
            try box.encode(more, forKey: .more)
        case .nothingNeedsYou(let notChecked):
            try box.encode("NOTHING_NEEDS_YOU", forKey: .kind)
            try box.encode(notChecked, forKey: .notChecked)
        case .problemsAfterConfirm(let problems):
            try box.encode("PROBLEMS_AFTER_CONFIRM", forKey: .kind)
            try box.encode(problems, forKey: .problems)
        }
    }
}

/// A RETURN or PROBLEMS record: why, and what is wrong (§8, §9).
public struct ConfirmationReturnRecordView: Codable, Equatable, Sendable {
    public let recordId: String
    public let recordedAt: String
    public let reviewedSha: String?
    public let reason: String
    public let problems: [ConfirmationReviewItem]

    public init(recordId: String, recordedAt: String, reviewedSha: String? = nil, reason: String,
                problems: [ConfirmationReviewItem]) {
        self.recordId = recordId
        self.recordedAt = recordedAt
        self.reviewedSha = reviewedSha
        self.reason = reason
        self.problems = problems
    }
}

/// The review of one confirmation request, as the card and its receipts draw it (§3.4).
public struct OwnerConfirmationReviewView: Codable, Equatable, Sendable {
    public struct Outdated: Codable, Equatable, Sendable {
        public enum Cause: String, Codable, Equatable, Sendable {
            case newerReport = "NEWER_REPORT"
            case branchMoved = "BRANCH_MOVED"
        }
        public let cause: Cause
        /// The run's tip now, for BRANCH_MOVED.
        public let branchSha: String?

        public init(cause: Cause, branchSha: String? = nil) {
            self.cause = cause
            self.branchSha = branchSha
        }
    }

    public struct Reviewer: Codable, Equatable, Sendable {
        /// PROJECT_COORDINATOR or TASK_CREATOR.
        public let kind: String
        public let sessionId: String?
        /// The reviewer conversation's title now; nil when it cannot be read.
        public let title: String?

        public init(kind: String, sessionId: String? = nil, title: String? = nil) {
            self.kind = kind
            self.sessionId = sessionId
            self.title = title
        }
    }

    /// The REVIEW record: the reviewer's call, and its four lists.
    public struct Record: Codable, Equatable, Sendable {
        public let recordId: String
        public let recordedAt: String
        public let reviewedSha: String?
        public let judgment: String
        public let checked: [ConfirmationReviewItem]
        public let notChecked: [ConfirmationReviewItem]
        public let needsYou: [ConfirmationNeedsYouItem]
        public let leftOpen: [ConfirmationReviewItem]

        public init(recordId: String, recordedAt: String, reviewedSha: String? = nil, judgment: String,
                    checked: [ConfirmationReviewItem] = [], notChecked: [ConfirmationReviewItem] = [],
                    needsYou: [ConfirmationNeedsYouItem] = [], leftOpen: [ConfirmationReviewItem] = []) {
            self.recordId = recordId
            self.recordedAt = recordedAt
            self.reviewedSha = reviewedSha
            self.judgment = judgment
            self.checked = checked
            self.notChecked = notChecked
            self.needsYou = needsYou
            self.leftOpen = leftOpen
        }
    }

    public let reviewId: String
    public let state: OwnerConfirmationReviewState
    public let notReviewedReason: OwnerConfirmationNotReviewedReason?
    public let outdated: Outdated?
    public let reviewer: Reviewer
    /// The request's requestedAt: "Reviewing since".
    public let since: String
    public let dueAt: String
    public let windowSeconds: Int
    public let headline: ConfirmationReviewHeadline?
    public let review: Record?
    public let returned: ConfirmationReturnRecordView?
    public let problems: ConfirmationReturnRecordView?

    public init(reviewId: String, state: OwnerConfirmationReviewState,
                notReviewedReason: OwnerConfirmationNotReviewedReason? = nil,
                outdated: Outdated? = nil, reviewer: Reviewer, since: String, dueAt: String,
                windowSeconds: Int, headline: ConfirmationReviewHeadline? = nil, review: Record? = nil,
                returned: ConfirmationReturnRecordView? = nil,
                problems: ConfirmationReturnRecordView? = nil) {
        self.reviewId = reviewId
        self.state = state
        self.notReviewedReason = notReviewedReason
        self.outdated = outdated
        self.reviewer = reviewer
        self.since = since
        self.dueAt = dueAt
        self.windowSeconds = windowSeconds
        self.headline = headline
        self.review = review
        self.returned = returned
        self.problems = problems
    }

    private enum CodingKeys: String, CodingKey {
        case reviewId, state, notReviewedReason, outdated, reviewer, since, dueAt, windowSeconds
        case headline, review, returned, problems
    }

    /// Best-effort past the review's identity and state: a headline, an outdated cause or a record
    /// this build cannot read costs that part of the bar and never the review — and a state it
    /// cannot read costs the review and never the card (see `OwnerConfirmationWaiting`).
    public init(from decoder: Decoder) throws {
        let box = try decoder.container(keyedBy: CodingKeys.self)
        reviewId = try box.decode(String.self, forKey: .reviewId)
        state = try box.decode(OwnerConfirmationReviewState.self, forKey: .state)
        notReviewedReason = try? box.decodeIfPresent(OwnerConfirmationNotReviewedReason.self,
                                                     forKey: .notReviewedReason)
        outdated = try? box.decodeIfPresent(Outdated.self, forKey: .outdated)
        reviewer = try box.decode(Reviewer.self, forKey: .reviewer)
        since = try box.decode(String.self, forKey: .since)
        dueAt = try box.decode(String.self, forKey: .dueAt)
        windowSeconds = try box.decode(Int.self, forKey: .windowSeconds)
        headline = try? box.decodeIfPresent(ConfirmationReviewHeadline.self, forKey: .headline)
        review = try? box.decodeIfPresent(Record.self, forKey: .review)
        returned = try? box.decodeIfPresent(ConfirmationReturnRecordView.self, forKey: .returned)
        problems = try? box.decodeIfPresent(ConfirmationReturnRecordView.self, forKey: .problems)
    }
}

/// One answer, as the decision row stores it (§7 Q4).
public struct OwnerConfirmationAnswer: Codable, Equatable, Sendable {
    public let key: String
    public let option: Int?
    public let text: String?
    /// OWNER: chosen on the card. NOT_SHOWN: an app older than reviews confirmed, and the
    /// recommended option was recorded for an owner who never saw the question.
    public let source: String

    public init(key: String, option: Int? = nil, text: String? = nil, source: String = "OWNER") {
        self.key = key
        self.option = option
        self.text = text
        self.source = source
    }
}

/// A report its reviewer sent back to the run: no decision answers it (§8 B6).
public struct ReviewerReturnedRequest: Codable, Equatable, Sendable {
    public let requestId: String
    public let sessionId: String
    public let requestedAt: String
    public let review: OwnerConfirmationReviewView

    public init(requestId: String, sessionId: String, requestedAt: String,
                review: OwnerConfirmationReviewView) {
        self.requestId = requestId
        self.sessionId = sessionId
        self.requestedAt = requestedAt
        self.review = review
    }
}

/// The OWNER_CONFIRMED request on a run's session that is still with its reviewer (§5 N3): the row
/// says "Under review" and is not counted.
public struct ConfirmationUnderReview: Codable, Equatable, Sendable {
    public let requestId: String
    public let taskId: String
    public let reviewerSessionId: String?
    public let reviewerTitle: String?
    /// The request's requestedAt.
    public let since: String
    public let dueAt: String

    public init(requestId: String, taskId: String, reviewerSessionId: String? = nil,
                reviewerTitle: String? = nil, since: String, dueAt: String) {
        self.requestId = requestId
        self.taskId = taskId
        self.reviewerSessionId = reviewerSessionId
        self.reviewerTitle = reviewerTitle
        self.since = since
        self.dueAt = dueAt
    }
}

// MARK: - the bar, as data

/// Where a review is drawn: on the card that asks, or under the receipt a decision left.
public enum ReviewPlace: String, Decodable, Equatable, Sendable {
    case card = "CARD"
    case receipt = "RECEIPT"
}

/// What the bar draws for one review — web's `ReviewBar`, line for line.
public struct ReviewBar: Decodable, Equatable, Sendable {
    /// One line of the bar, in the order it is drawn. STATUS is a state word with its symbol, NOTE
    /// the quieter sentence under it, HEADLINE Orbit's first line, ANSWERS the place the card draws
    /// its answer blocks, ROW one of the reviewer's lists (the items it opens to are `keys`), QUOTE
    /// the reviewer's own sentence and FOOTER what Orbit says last.
    public struct Line: Decodable, Equatable, Sendable {
        public enum Kind: String, Decodable, Equatable, Sendable {
            case status = "STATUS"
            case note = "NOTE"
            case headline = "HEADLINE"
            case answers = "ANSWERS"
            case row = "ROW"
            case quote = "QUOTE"
            case footer = "FOOTER"
        }
        public enum Icon: String, Decodable, Equatable, Sendable {
            case clock = "CLOCK"
            case dash = "DASH"
        }
        public enum Row: String, Decodable, Equatable, Sendable {
            case checked = "CHECKED"
            case notChecked = "NOT_CHECKED"
            case leftOpen = "LEFT_OPEN"
            case problem = "PROBLEM"
        }

        public let kind: Kind
        public let text: String
        public let icon: Icon?
        /// STATUS and HEADLINE only: drawn in the warning tone.
        public let warn: Bool?
        public let row: Row?
        public let label: String?
        public let keys: [String]?

        public init(kind: Kind, text: String, icon: Icon? = nil, warn: Bool? = nil, row: Row? = nil,
                    label: String? = nil, keys: [String]? = nil) {
            self.kind = kind
            self.text = text
            self.icon = icon
            self.warn = warn
            self.row = row
            self.label = label
            self.keys = keys
        }
    }

    /// The reviewer's name: `REVIEW · <reviewer>`.
    public let reviewer: String
    /// When the record drawn was written; nil while there is none.
    public let time: String?
    /// The commit that record was written for, first 7; nil when it named none.
    public let sha: String?
    /// Struck through: the record no longer describes what is waiting.
    public let shaStruck: Bool
    public let lines: [Line]
    /// The old review, behind `Show the old review`.
    public let folded: [Line]
    /// The bar offers Reopen task, once the task has settled (§9 L4).
    public let reopen: Bool

    public init(reviewer: String, time: String?, sha: String?, shaStruck: Bool = false, lines: [Line],
                folded: [Line] = [], reopen: Bool = false) {
        self.reviewer = reviewer
        self.time = time
        self.sha = sha
        self.shaStruck = shaStruck
        self.lines = lines
        self.folded = folded
        self.reopen = reopen
    }
}

/// One question's answer on the card: an option's index, or the owner's own words.
public enum ReviewChoice: Equatable, Sendable, Decodable {
    case option(Int)
    case other(String)

    private enum CodingKeys: String, CodingKey { case other }

    public init(from decoder: Decoder) throws {
        if let index = try? decoder.singleValueContainer().decode(Int.self) {
            self = .option(index)
            return
        }
        let box = try decoder.container(keyedBy: CodingKeys.self)
        self = .other(try box.decode(String.self, forKey: .other))
    }
}

/// One answer as the door takes it (§7 Q3): exactly one of `option` and `text`.
public struct OwnerAnswerBody: Codable, Equatable, Sendable {
    public let key: String
    public let option: Int?
    public let text: String?

    public init(key: String, option: Int? = nil, text: String? = nil) {
        self.key = key
        self.option = option
        self.text = text
    }

    private enum CodingKeys: String, CodingKey { case key, option, text }

    public func encode(to encoder: Encoder) throws {
        var box = encoder.container(keyedBy: CodingKeys.self)
        try box.encode(key, forKey: .key)
        try box.encodeIfPresent(option, forKey: .option)
        try box.encodeIfPresent(text, forKey: .text)
    }
}

/// What a confirmation from the card says about the review it drew (§7 Q3): the record it showed
/// (nil when it showed none) and an answer to each of that record's questions.
public struct OwnerDecisionReview: Equatable, Sendable {
    public let reviewRecordId: String?
    public let answers: [OwnerAnswerBody]

    public init(reviewRecordId: String?, answers: [OwnerAnswerBody] = []) {
        self.reviewRecordId = reviewRecordId
        self.answers = answers
    }
}

/// One line of a receipt's `Your answers`.
public struct OwnerAnswerLine: Decodable, Equatable, Sendable {
    public let text: String
    /// Recorded for the owner by an app that did not show them the question.
    public let notShown: Bool

    public init(text: String, notShown: Bool) {
        self.text = text
        self.notShown = notShown
    }
}

public extension OwnerConfirmations {

    // MARK: the words, put together (each piece is declared beside the card's other copy)

    static func reviewingSince(_ time: String) -> String { "\(reviewingSincePrefix) \(time)" }

    static func reviewNeedsYouLine(_ text: String, more: Int) -> String {
        more > 0 ? "\(reviewNeedsYou)\(text) (+\(more) more)" : "\(reviewNeedsYou)\(text)"
    }

    static func reviewNothingNeedsYouLine(_ notChecked: Int) -> String {
        "\(notChecked) not checked · \(reviewNothingNeedsYou)"
    }

    /// The first line under a receipt once the reviewer found problems after the confirmation.
    static func problemsFoundLine(_ problems: Int) -> String {
        problems == 1 ? "1 problem found after you confirmed"
                      : "\(problems) problems found after you confirmed"
    }

    static func noAnswerWithin(_ window: String) -> String { "No answer within \(window)." }

    static func writtenFor(_ reviewed: String, now: String) -> String {
        "Written for \(reviewed). The branch is at \(now) now, so this says nothing about the last commit."
    }

    static func reviewDue(_ time: String) -> String { "Due \(time)" }

    /// The session row's line while its report is with its reviewer (§5 N3).
    static func underReviewLine(_ reviewerTitle: String?) -> String {
        "\(underReview) · \(reviewerName(reviewerTitle))"
    }

    /// A review window as `No answer within <window>.` says it: `30 min`, `2 h`, `1 h 30 min`.
    static func reviewWindowWords(_ seconds: Int) -> String {
        let minutes = max(1, Int((Double(seconds) / 60).rounded()))
        let hours = minutes / 60
        let rest = minutes % 60
        if hours == 0 { return "\(rest) min" }
        return rest == 0 ? "\(hours) h" : "\(hours) h \(rest) min"
    }

    /// Why nobody reviewed it, then who has checked it. A reason this build does not know says the
    /// second half alone.
    static func notReviewedNote(_ reason: OwnerConfirmationNotReviewedReason?,
                                windowSeconds: Int) -> String {
        let why: String
        switch reason {
        case .timedOut?: why = noAnswerWithin(reviewWindowWords(windowSeconds))
        case .reviewerEnded?: why = notReviewedReviewerEnded
        case .reviewerStopped?: why = notReviewedReviewerStopped
        case .coordinatorPaused?: why = notReviewedCoordinatorPaused
        case .automaticOff?: why = notReviewedAutomaticOff
        case .noCoordinator?: why = notReviewedNoCoordinator
        case .unreachable?: why = notReviewedUnreachable
        case .unknown?, nil: why = ""
        }
        return "\(why)\(notReviewedTail)".trimmingCharacters(in: .whitespaces)
    }

    static func reviewerName(_ title: String?) -> String {
        let trimmed = title?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return trimmed.isEmpty ? reviewerFallback : trimmed
    }

    /// Orbit's first line, from the headline the server worked out (§6 H2).
    static func reviewHeadlineLine(_ headline: ConfirmationReviewHeadline) -> (text: String, warn: Bool) {
        switch headline {
        case .needsYou(let text, let more): return (reviewNeedsYouLine(text, more: more), true)
        case .nothingNeedsYou(let notChecked): return (reviewNothingNeedsYouLine(notChecked), false)
        case .problemsAfterConfirm(let problems): return (problemsFoundLine(problems), true)
        }
    }

    // MARK: the bar

    /// What the bar draws for one review, where it is drawn (§6 H3, §8 B6, §9 L3) — web's
    /// `reviewBar`. `clock` writes an instant as the card writes its times, and answers nil for one
    /// it cannot read.
    static func reviewBar(_ review: OwnerConfirmationReviewView, place: ReviewPlace,
                          clock: (String) -> String?) -> ReviewBar {
        func bar(_ time: String?, _ sha: String?, _ lines: [ReviewBar.Line], shaStruck: Bool = false,
                 folded: [ReviewBar.Line] = [], reopen: Bool = false) -> ReviewBar {
            ReviewBar(reviewer: reviewerName(review.reviewer.title), time: time, sha: shortSha(sha),
                      shaStruck: shaStruck, lines: lines, folded: folded, reopen: reopen)
        }
        // Under a receipt, problems the reviewer found after the confirmation outrank whatever state
        // the review is in: they are what the owner has to act on, and Reopen task is how.
        if place == .receipt, let found = review.problems {
            return bar(clock(found.recordedAt), found.reviewedSha,
                       [ReviewBar.Line(kind: .headline, text: problemsFoundLine(found.problems.count),
                                       warn: true)] + problemRows(found.problems),
                       reopen: true)
        }
        switch review.state {
        case .underReview:
            let since = clock(review.since)
            return bar(nil, nil, [
                ReviewBar.Line(kind: .status, text: since.map(reviewingSince) ?? underReview,
                               icon: .clock, warn: false),
                ReviewBar.Line(kind: .note, text: place == .card ? reviewWillAsk : reviewWillShowHere),
            ])
        case .notReviewed:
            return bar(nil, nil, [
                ReviewBar.Line(kind: .status, text: notReviewed, icon: .dash, warn: false),
                ReviewBar.Line(kind: .note, text: notReviewedNote(review.notReviewedReason,
                                                                  windowSeconds: review.windowSeconds)),
            ])
        case .returned:
            let returned = review.returned
            var lines = [ReviewBar.Line(kind: .status, text: returnedToAgent, warn: false)]
            if let reason = returned?.reason, !reason.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                lines.append(ReviewBar.Line(kind: .quote, text: reason))
            }
            lines += problemRows(returned?.problems ?? [])
            lines.append(ReviewBar.Line(kind: .footer, text: returnedFooter))
            return bar(returned.flatMap { clock($0.recordedAt) }, returned?.reviewedSha, lines)
        case .outdated:
            let record = review.review
            let note: String?
            if review.outdated?.cause == .newerReport {
                note = reviewEarlierReport
            } else if let reviewed = shortSha(record?.reviewedSha),
                      let now = shortSha(review.outdated?.branchSha) {
                note = writtenFor(reviewed, now: now)
            } else {
                note = nil
            }
            var lines = [ReviewBar.Line(kind: .status, text: reviewOutdated, warn: true)]
            if let note { lines.append(ReviewBar.Line(kind: .note, text: note)) }
            return bar(record.flatMap { clock($0.recordedAt) }, record?.reviewedSha, lines,
                       shaStruck: true, folded: recordLines(review, answers: false))
        case .reviewed:
            let record = review.review
            return bar(record.flatMap { clock($0.recordedAt) }, record?.reviewedSha,
                       recordLines(review, answers: place == .card))
        }
    }

    /// A REVIEW record's own headline: the server's, unless that one is about problems found later.
    private static func recordHeadline(_ review: OwnerConfirmationReviewView) -> ConfirmationReviewHeadline? {
        guard let record = review.review else { return nil }
        if let headline = review.headline {
            if case .problemsAfterConfirm = headline {} else { return headline }
        }
        if let first = record.needsYou.first {
            return .needsYou(text: first.text, more: record.needsYou.count - 1)
        }
        return .nothingNeedsYou(notChecked: record.notChecked.count)
    }

    /// The record's lines in their order: Orbit's first line, the card's answers, the lists, the quote.
    private static func recordLines(_ review: OwnerConfirmationReviewView,
                                    answers: Bool) -> [ReviewBar.Line] {
        guard let record = review.review else { return [] }
        var lines: [ReviewBar.Line] = []
        if let headline = recordHeadline(review) {
            let line = reviewHeadlineLine(headline)
            lines.append(ReviewBar.Line(kind: .headline, text: line.text, warn: line.warn))
        }
        if answers && !record.needsYou.isEmpty {
            lines.append(ReviewBar.Line(kind: .answers, text: ""))
        }
        let lists: [(ReviewBar.Line.Row, String, [ConfirmationReviewItem])] = [
            (.checked, reviewChecked, record.checked),
            (.notChecked, reviewNotChecked, record.notChecked),
            (.leftOpen, reviewLeftOpen, record.leftOpen),
        ]
        for (row, label, items) in lists where !items.isEmpty {
            lines.append(ReviewBar.Line(kind: .row, text: items.map(\.text).joined(separator: " · "),
                                        row: row, label: label, keys: items.map(\.key)))
        }
        if !record.judgment.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            lines.append(ReviewBar.Line(kind: .quote, text: record.judgment))
        }
        return lines
    }

    /// One row per problem: each is a thing to fix, not one of a list.
    private static func problemRows(_ problems: [ConfirmationReviewItem]) -> [ReviewBar.Line] {
        problems.map {
            ReviewBar.Line(kind: .row, text: $0.text, row: .problem, label: reviewProblem, keys: [$0.key])
        }
    }

    private static func shortSha(_ sha: String?) -> String? {
        guard let sha, !sha.isEmpty else { return nil }
        return String(sha.prefix(7))
    }

    /// Every item the bar's rows can name, by key: the review's lists and either kind of problem.
    static func reviewItemsByKey(_ review: OwnerConfirmationReviewView) -> [String: ConfirmationReviewItem] {
        var items: [String: ConfirmationReviewItem] = [:]
        if let record = review.review {
            for item in record.checked + record.notChecked + record.leftOpen { items[item.key] = item }
            for question in record.needsYou {
                items[question.key] = ConfirmationReviewItem(key: question.key, text: question.text,
                                                             criterionKey: question.criterionKey,
                                                             evidenceRefs: question.evidenceRefs)
            }
        }
        for item in (review.returned?.problems ?? []) + (review.problems?.problems ?? []) {
            items[item.key] = item
        }
        return items
    }

    // MARK: the owner's answers (§7)

    /// The questions the card asks: those of a review it draws as REVIEWED. An outdated review's old
    /// questions are not answerable, and nothing else has any.
    static func reviewQuestions(_ review: OwnerConfirmationReviewView?) -> [ConfirmationNeedsYouItem] {
        guard let review, review.state == .reviewed else { return [] }
        return review.review?.needsYou ?? []
    }

    /// What a question is answered with now: the owner's choice, or its recommendation untouched.
    static func reviewChoice(_ item: ConfirmationNeedsYouItem,
                             in choices: [String: ReviewChoice]) -> ReviewChoice {
        choices[item.key] ?? .option(item.recommendedOption)
    }

    /// What a confirmation from the card says about the review it drew (§7 Q3).
    static func reviewAnswered(_ review: OwnerConfirmationReviewView?,
                               choices: [String: ReviewChoice]) -> OwnerDecisionReview {
        guard let review, review.state == .reviewed || review.state == .outdated else {
            return OwnerDecisionReview(reviewRecordId: nil)
        }
        let answers = reviewQuestions(review).map { item -> OwnerAnswerBody in
            switch reviewChoice(item, in: choices) {
            case .option(let index):
                return OwnerAnswerBody(key: item.key, option: index)
            case .other(let words):
                return OwnerAnswerBody(key: item.key,
                                       text: words.trimmingCharacters(in: .whitespacesAndNewlines))
            }
        }
        return OwnerDecisionReview(reviewRecordId: review.review?.recordId, answers: answers)
    }

    /// Whether every question has an answer the door would take: an Other with no words has none,
    /// and Confirm done is disabled while one stands (§6 H4).
    static func reviewAnswersComplete(_ review: OwnerConfirmationReviewView?,
                                      choices: [String: ReviewChoice]) -> Bool {
        reviewQuestions(review).allSatisfy { item in
            if case .other(let words) = reviewChoice(item, in: choices) {
                return !words.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            }
            return true
        }
    }

    /// The receipt's `Your answers`: each question, then what was chosen or said (§7 Q5).
    static func ownerAnswerLines(_ decided: RecordedOwnerDecision) -> [OwnerAnswerLine] {
        var questions: [String: ConfirmationNeedsYouItem] = [:]
        for item in decided.review?.review?.needsYou ?? [] { questions[item.key] = item }
        return decided.answers.map { answer in
            let question = questions[answer.key]
            let said: String
            if let option = answer.option {
                let options = question?.options ?? []
                said = options.indices.contains(option) ? options[option].label : String(option + 1)
            } else {
                said = answer.text ?? ""
            }
            return OwnerAnswerLine(text: "\(question?.text ?? answer.key) — \(said)",
                                   notShown: answer.source == "NOT_SHOWN")
        }
    }

    /// Whether the review's first record came in after the decision: `Before the review came in`.
    static func reviewCameInAfter(_ decided: RecordedOwnerDecision) -> Bool {
        guard let review = decided.review, let decidedAt = RelativeTime.parse(decided.decidedAt) else {
            return false
        }
        let moments = [review.review?.recordedAt, review.returned?.recordedAt, review.problems?.recordedAt]
            .compactMap { $0.flatMap(RelativeTime.parse) }
        guard let first = moments.min() else { return false }
        return first > decidedAt
    }

    /// The reports of this session's run that its reviewer sent back: each was a card here, and is
    /// drawn as the record it became (§8 B6).
    static func reviewerReturnsIn(_ view: OwnerConfirmationView?,
                                  sessionID: String?) -> [ReviewerReturnedRequest] {
        guard let view, let sessionID else { return [] }
        return view.reviewerReturns.filter { $0.sessionId == sessionID }
    }

    /// Whether a receipt's Reopen task may be offered: the task has settled (`TaskReopen.isOffered`'s
    /// statuses, read off the confirmation's own read).
    static func reopenOffered(_ view: OwnerConfirmationView?) -> Bool {
        guard let status = view.flatMap({ TaskStatus(rawValue: $0.status) }) else { return false }
        return TaskReopen.statuses.contains(status)
    }

    /// Whether this card is still asking the owner NOW — a question whose report is not with its
    /// reviewer any more. Under review, the card is drawn and can be pressed (`isOpen`), but it is
    /// somebody else's to look at first, so nothing counts it or points at it (§5 N1).
    static func asksNow(_ standing: OwnerConfirmationStanding) -> Bool {
        guard isOpen(standing) else { return false }
        return standing.waiting?.review?.state != .underReview
    }
}
