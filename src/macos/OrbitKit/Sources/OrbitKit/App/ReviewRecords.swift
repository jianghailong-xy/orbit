import Foundation

/// The line a review sheet ends on once THIS window's answer was taken, where its buttons were:
/// who answered, when, and what became of it (the owner's boards of 2026-10-15, one per card).
///
/// The sheet does not close and does not swap to a receipt page: the card stays as it was asked,
/// read-only, and this line is what changed — the coordinator question's record
/// (`CoordinatorQuestions.footerLine`) for every card a review answers.
public struct ReviewRecordFooter: Equatable, Sendable {
    /// The mark beside the line: the answer went through as asked, the reader kept it open
    /// (Keep planning), or the reader refused it.
    public enum Mark: Equatable, Sendable { case done, keptOpen, refused }

    public let mark: Mark
    public let line: String
    public let detail: String?

    public init(mark: Mark, line: String, detail: String?) {
        self.mark = mark
        self.line = line
        self.detail = detail
    }
}

public enum ReviewRecords {
    /// The sheet's title over an approval's record — a question, a plan, one of Orbit's own asks.
    public static let answeredTitle = "Answered"
    /// …and over a decision card's: the name its record card has in the conversation.
    public static let decisionTitle = "Decision recorded"
    /// The label over an answer the reader typed rather than picked.
    public static let yourAnswer = "YOUR ANSWER"
    public static let sentToAgent = "Sent to the agent"
    public static let runningPlan = "The agent is running the plan"
    public static let goesOnPlanning = "The agent goes on planning"

    /// "Approved by you · 14:06" — a time this client cannot say is left out rather than drawn as a
    /// dangling separator.
    static func byYou(_ verb: String, at: Date, now: Date) -> String {
        guard let time = time(at, now: now) else { return "\(verb) by you" }
        return "\(verb) by you · \(time)"
    }

    /// The clock on the day it happened, the date as well after — the receipts' own rule
    /// (`OwnerConfirmations.receiptTime`).
    public static func time(_ at: Date, now: Date = Date(), calendar: Calendar = .current,
                            timeZone: TimeZone = .current) -> String? {
        OwnerConfirmations.receiptTime(ISO8601DateFormatter().string(from: at), now: now,
                                       calendar: calendar, timeZone: timeZone)
    }

    // MARK: the approvals

    /// An AskUserQuestion answered: the labels it sent.
    public static func question(at: Date, now: Date = Date()) -> ReviewRecordFooter {
        ReviewRecordFooter(mark: .done, line: byYou("Answered", at: at, now: now), detail: sentToAgent)
    }

    /// A plan approved, or kept in planning.
    public static func plan(approved: Bool, at: Date, now: Date = Date()) -> ReviewRecordFooter {
        guard approved else {
            let line = time(at, now: now).map { "Kept planning · by you · \($0)" } ?? "Kept planning · by you"
            return ReviewRecordFooter(mark: .keptOpen, line: line, detail: goesOnPlanning)
        }
        return ReviewRecordFooter(mark: .done, line: byYou("Approved", at: at, now: now), detail: runningPlan)
    }

    /// One of Orbit's own asks — a batch, a restructure, a blocker — approved. Its no goes to the
    /// composer and never leaves a record here.
    public static func toolAsk(at: Date, now: Date = Date()) -> ReviewRecordFooter {
        ReviewRecordFooter(mark: .done, line: byYou("Approved", at: at, now: now), detail: sentToAgent)
    }

    /// What one AskUserQuestion question was answered with, split the way the record draws it: the
    /// listed options it picked, and the words it typed instead (`Approvals.buildAnswers` appends
    /// those after the picks).
    public static func answer(to question: AskQuestion,
                              in answers: [String: [String]]) -> (picked: Set<String>, typed: String?) {
        let sent = answers[question.question] ?? []
        let labels = Set(question.options.map(\.label))
        let typed = sent.filter { !labels.contains($0) }
        return (Set(sent.filter(labels.contains)), typed.isEmpty ? nil : typed.joined(separator: ", "))
    }

    // MARK: the decision cards

    public static func evidence(revision: String, at: Date, now: Date = Date()) -> ReviewRecordFooter {
        ReviewRecordFooter(mark: .done, line: byYou(OwnerConfirmations.confirmedHeading, at: at, now: now),
                           detail: "Recorded on rev \(revision)")
    }

    /// "Recorded on the 13:58 report" — the report the press confirmed, when it said when.
    public static func ownerConfirmed(at: Date, reportedAt: String?,
                                      now: Date = Date()) -> ReviewRecordFooter {
        let report = reportedAt.flatMap { OwnerConfirmations.receiptTime($0, now: now) }
        return ReviewRecordFooter(mark: .done,
                                  line: byYou(OwnerConfirmations.confirmedHeading, at: at, now: now),
                                  detail: report.map { "Recorded on the \($0) report" })
    }

    public static func started(criteria: Int, seal: String, at: Date,
                               now: Date = Date()) -> ReviewRecordFooter {
        ReviewRecordFooter(mark: .done, line: byYou("Started", at: at, now: now),
                           detail: "On \(criteriaCount(criteria)) at seal \(CriteriaDecisions.shortSeal(seal))")
    }

    /// A confirmation of the criteria as they stand, and what the version changed when this window
    /// knows (`CriteriaChanges.counts`).
    public static func confirmed(criteria: Int, seal: String, changes: String?, at: Date,
                                 now: Date = Date()) -> ReviewRecordFooter {
        var detail = "\(criteriaCount(criteria)) at seal \(CriteriaDecisions.shortSeal(seal))"
        if let changes, !changes.isEmpty { detail += " — \(changes)" }
        return ReviewRecordFooter(mark: .done, line: byYou("Confirmed", at: at, now: now), detail: detail)
    }

    /// A held weakening approved, and the seal it moved the ruler to — or refused, and the seal the
    /// ruler stays at.
    public static func criteriaDecision(approved: Bool, baseSeal: String, resultingSeal: String?,
                                        at: Date, now: Date = Date()) -> ReviewRecordFooter {
        let base = CriteriaDecisions.shortSeal(baseSeal)
        guard approved else {
            return ReviewRecordFooter(mark: .refused, line: byYou("Refused", at: at, now: now),
                                      detail: "The criteria stay at seal \(base)")
        }
        return ReviewRecordFooter(mark: .done, line: byYou("Approved", at: at, now: now),
                                  detail: resultingSeal.map { "Re-sealed: \(base) → \(CriteriaDecisions.shortSeal($0))" })
    }

    private static func criteriaCount(_ count: Int) -> String {
        "\(count) \(count == 1 ? "criterion" : "criteria")"
    }
}
