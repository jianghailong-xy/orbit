import Foundation
import XCTest
@testable import OrbitKit

/// The turn handing the owner's answer to the coordinator is the question's own card where the
/// conversation holds its record (docs/mocks/owner-answer-sent-card/merged.html), grey once answered
/// (tone.html) — the view half of `OwnerAnswerTests`' "the question's own card".
///
/// It reads source, because SwiftUI does not exist on Linux and the OrbitApp views are compiled only by
/// the macOS and iOS jobs (`client.yml`). What it holds is what a compiler lets drift in silence: the
/// card offered a Cancel the queue's line has, the records reaching the transcript but not the queued
/// tail, the sheet losing the words the coordinator was told, and the answered card going back to the
/// blue the open question keeps.
final class OwnerAnswerCardWiringTests: XCTestCase {

    private enum WiringError: Error, CustomStringConvertible {
        case missing(String)
        var description: String {
            switch self {
            case .missing(let what):
                return "\(what) was not found above this test. If it moved, move this check with it "
                    + "rather than deleting it."
            }
        }
    }

    private static let app = "src/macos/OrbitApp/Sources/OrbitApp"
    private static let linePath = app + "/Views/OwnerAnswerLineView.swift"
    private static let cardsPath = app + "/Views/ApprovalCards.swift"
    private static let consoleViewPath = app + "/Views/Console/ConsoleView.swift"
    private static let consoleModelPath = app + "/ConsoleModel.swift"

    private func source(_ relative: String) throws -> String {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<12 {
            let candidate = dir.appendingPathComponent(relative)
            if FileManager.default.fileExists(atPath: candidate.path) {
                return try String(contentsOf: candidate, encoding: .utf8)
            }
            dir = dir.deletingLastPathComponent()
        }
        throw WiringError.missing(relative)
    }

    /// One stretch of a file, so a match somewhere else cannot answer for the part being asserted about.
    private func section(_ source: String, from: String, to: String) throws -> String {
        guard let start = source.range(of: from),
              let end = source.range(of: to, range: start.upperBound..<source.endIndex) else {
            throw WiringError.missing("\(from) … \(to)")
        }
        return String(source[start.lowerBound..<end.lowerBound])
    }

    /// The lines of one stretch that are CODE: a call that is commented out still contains its words.
    private func statements(_ source: String) -> [String] {
        source.split(separator: "\n")
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty && !$0.hasPrefix("//") }
    }

    /// The turn asks the records the conversation holds, and is the question's card where one is held:
    /// dashed while queued, or saying its delivery went unconfirmed — and with no Cancel, which would
    /// leave the coordinator never told. Its press opens the record's own review.
    func testTheTurnIsTheQuestionsCardWhereTheConversationHoldsItsRecord() throws {
        let line = try source(Self.linePath)
        XCTAssertTrue(statements(line).contains("@Environment(\\.answeredQuestions) private var answered"))
        let body = statements(try section(line, from: "var body: some View {", to: "private var line: some View {"))
        for code in ["if let record = OwnerAnswer.record(of: card, in: answered) {",
                     "CoordinatorQuestionRecordView(record: record, queued: queued && !undelivered,",
                     "notice: undelivered ? OwnerAnswerCard.undelivered : nil)",
                     ".delivered(DeliveredDecisionCard(kind: .coordinatorQuestionRecord(record: record))))",
                     "} else {", "line"] {
            XCTAssertTrue(body.contains(code), "the turn's body no longer reads \(code)")
        }
        let card = statements(try section(line, from: "if let record = OwnerAnswer.record(of: card, in: answered) {",
                                          to: "} else {")).joined(separator: "\n")
        XCTAssertFalse(card.contains("onCancelQueued"), "the card hands the queue's Cancel on")
        XCTAssertFalse(card.contains("Cancel"), "the card offers a Cancel")
    }

    /// One list holds the transcript and the queued tail, so the records handed to it reach a turn in
    /// either; the console reads them as it reads one record, and finds the turn that told the
    /// coordinator for the card's sheet.
    func testTheConsoleHandsItsRecordsToTheTranscriptAndTheQueue() throws {
        let list = statements(try section(try source(Self.consoleViewPath),
                                          from: "private var rowsList: some View {",
                                          to: ".scrollContentBackground(.hidden)"))
        XCTAssertTrue(list.contains("ForEach(rows) { row in"))
        XCTAssertTrue(list.contains(".environment(\\.answeredQuestions, console.answeredQuestions)"),
                      "the transcript's list no longer hands its rows the records it holds")

        let model = statements(try source(Self.consoleModelPath))
        XCTAssertTrue(model.contains("CoordinatorQuestions.held(drawn: decisionCards, read: openItems)"))
        XCTAssertTrue(model.contains(
            "guard let turn = OwnerAnswer.handover(of: itemID, in: state), let card = turn.ownerAnswer else { return nil }"))
        XCTAssertTrue(model.contains("return OwnerAnswerTold(card: card, text: turn.text, attached: turn.attached)"))
    }

    /// The answered card leaves the blue for the neutral frame, with a grey chip and the answer ticked
    /// green; it says when the turn handing it over is queued or unconfirmed, and its sheet folds the
    /// words the coordinator was told. The open question card stays blue.
    func testTheAnsweredCardIsGreyAndItsSheetFoldsTheWords() throws {
        let cards = try source(Self.cardsPath)
        let record = try section(cards, from: "struct CoordinatorQuestionRecordView: View {",
                                 to: "/// The exception that became the owner's without anybody asking")
        let code = statements(record)
        for line in [".approvalChrome(.gray, dashed: queued)", ".foregroundStyle(Color.gray)",
                     ".font(.orbitMeta).foregroundStyle(Color.green)",
                     "Text(CoordinatorQuestions.queuedForCoordinator)", "if let notice {",
                     "if let told { toldFold(told) }", "Text(OwnerAnswerCard.told)", "Text(told.text)",
                     "if let attached = told.attached { AttachedNoteEntry(attached: attached) }"] {
            XCTAssertTrue(code.contains(line), "the record view no longer draws \(line)")
        }
        XCTAssertFalse(code.joined(separator: "\n").contains(".approvalChrome(.blue"),
                       "the answered card is blue again: the blue is the open question's")
        XCTAssertTrue(statements(cards).contains("told: console.questionTold(record.itemId))"),
                      "the record's sheet no longer finds the words the coordinator was told")

        let open = try section(cards, from: "private struct CoordinatorQuestionCardView: View {",
                               to: "private var previewSummary: String {")
        XCTAssertTrue(open.contains("symbol: \"questionmark.bubble.fill\", tone: .blue,"),
                      "the open question card is no longer blue")
    }
}
