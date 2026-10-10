import Foundation
import XCTest

/// The wires between an answered question's tool card and its record (`QuestionRecords`).
///
/// SwiftUI does not exist on Linux, and `ToolCards.swift` / `QuestionRecordViews.swift` are compiled
/// only by the macOS and iOS jobs, so the attachment is asserted over the source the way
/// `ApprovalReviewCloseWiringTests` does. Each assertion is written so that DETACHING the wire is
/// what turns it red.
///
/// What is being held (`docs/mocks/ask-question-card-ios/`): folded, the card is the record — what
/// was asked and how it was answered — and unfolded it replays every option with the pick ticked,
/// without the OUTPUT block that only says the same again; a reply given in the conversation is not
/// drawn as a failure; and a clipped call or result is read whole while the card is still folded.
final class QuestionCardWiringTests: XCTestCase {

    private struct SourceMissing: Error, CustomStringConvertible {
        let path: String
        var description: String {
            "OrbitApp/Sources/OrbitApp/\(path) wasn't found above this test. If it moved, point this "
                + "check at its new home — don't delete the check."
        }
    }

    private static let cards = "Views/Console/ToolCards.swift"
    private static let views = "Views/Console/QuestionRecordViews.swift"

    /// Found by walking up from this file; never a skip, so the check can't go quiet when a file moves.
    private func source(_ relative: String) throws -> String {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<12 {
            let candidate = dir.appendingPathComponent("src/macos/OrbitApp/Sources/OrbitApp")
                .appendingPathComponent(relative)
            if FileManager.default.fileExists(atPath: candidate.path) {
                return try String(contentsOf: candidate, encoding: .utf8)
            }
            dir.deleteLastPathComponent()
        }
        throw SourceMissing(path: relative)
    }

    /// From the first `start` through the next `end` after it.
    private func slice(_ text: String, from start: String, to end: String) throws -> String {
        let lower = try XCTUnwrap(text.range(of: start), "no `\(start)`")
        let upper = try XCTUnwrap(text.range(of: end, range: lower.upperBound..<text.endIndex),
                                  "no `\(end)` after `\(start)`")
        return String(text[lower.lowerBound..<upper.upperBound])
    }

    /// The text without its comment lines, on one line — free to talk about what the code must not do.
    private func code(_ text: String) -> String {
        text.split(separator: "\n")
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty && !$0.hasPrefix("//") }
            .joined(separator: " ")
    }

    func testFoldedCardIsTheRecordAndOpenCardTheReplay() throws {
        let cards = try source(Self.cards)
        let folded = code(try slice(cards, from: "private var defaultBody: some View {",
                                    to: ".animation(nil, value: isOpen)"))
        XCTAssertTrue(folded.contains("} else if !questions.isEmpty { QuestionFoldedLines(questions: questions, outcome: questionOutcome)"),
                      "folded, a question card draws its record under the row")
        let detail = code(try slice(cards, from: "private var detail: some View {",
                                    to: ".imagePreview($previewTarget"))
        XCTAssertTrue(detail.contains("} else if !questions.isEmpty { QuestionReplayView(questions: questions, outcome: questionOutcome)"),
                      "open, a question card replays its questions with how they ended")
        XCTAssertTrue(detail.contains("questionOutcome == nil {"),
                      "the result is shown only while it cannot be read: once read, the replay is what it says")
    }

    func testOnlyAnUnreadAnswerOpensTheCard() throws {
        let cards = code(try source(Self.cards))
        XCTAssertTrue(cards.contains("if !questions.isEmpty { return questionUnread }"))
        XCTAssertTrue(cards.contains("questionOutcome == nil && card.status == .ok && hasResult && (!card.resultTruncated || resultResolved)"))
    }

    func testReplyInTheConversationIsNotAFailure() throws {
        let status = code(try slice(try source(Self.cards), from: "@ViewBuilder private var status: some View {",
                                    to: "ToolStatusGlyph(status:"))
        XCTAssertTrue(status.contains("if case .replied? = questionOutcome { Image(systemName: \"bubble.left.fill\")"))
    }

    func testAFoldedQuestionIsReadWhole() throws {
        let cards = code(try source(Self.cards))
        XCTAssertTrue(cards.contains("needsWholeInput: readsWholeQuestion, needsWholeResult: needsWholeResult || readsWholeQuestion"))
        XCTAssertTrue(cards.contains("if expanded || readsWholeQuestion, card.inputTruncated, fullDisplay == nil,"))
        XCTAssertTrue(cards.contains("guard expanded || needsWholeResult || readsWholeQuestion, card.resultTruncated, !resultResolved,"))
    }

    /// The words are OrbitKit's, which the shared fixture holds to the browser's.
    func testWordsComeFromQuestionRecords() throws {
        let views = code(try source(Self.views))
        for constant in ["QuestionRecords.repliedInChat", "QuestionRecords.yourAnswer", "QuestionRecords.multipleChoice",
                         "QuestionRecords.answerLine(", "QuestionRecords.replyLine(", "QuestionRecords.lead("] {
            XCTAssertTrue(views.contains(constant), "\(constant) is not drawn")
        }
        for literal in ["\"Replied in chat\"", "\"Your answer\"", "\"Multiple choice\""] {
            XCTAssertFalse(views.contains(literal), "\(literal) is spelled out instead of read from QuestionRecords")
        }
    }
}
