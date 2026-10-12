import Foundation
import XCTest

/// The wires between a press that answers an approval and the review sheet that presented it.
///
/// SwiftUI does not exist on Linux, and `ApprovalReview.swift` / `ConsoleModel.swift` are compiled
/// only by the macOS and iOS jobs, so the attachment is asserted over the source the way
/// `StartProjectWiringTests` does. Each assertion is written so that DETACHING the wire is what
/// turns it red.
///
/// What is being held: an approval that is gone looks the same whether somebody else answered it or
/// the reader just did, and a sheet that reads the second as the first reports the reader's own
/// press back to them as news ("This request is no longer waiting for an answer", with the sheet
/// left open on it). The fixes are the two facts the console keeps — the press's own phase
/// (`approvalAnswers`) and the cards answered HERE (`closedCards`) — and the sheet's branches that
/// read them before its fallback.
final class ApprovalReviewCloseWiringTests: XCTestCase {

    private struct SourceMissing: Error, CustomStringConvertible {
        let path: String
        var description: String {
            "OrbitApp/Sources/OrbitApp/\(path) wasn't found above this test. If it moved, point this "
                + "check at its new home — don't delete the check."
        }
    }

    private static let sheet = "Views/ApprovalReview.swift"
    private static let console = "ConsoleModel.swift"

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

    /// The text without its comment lines — free to talk about what the code must not do.
    private func code(_ text: String) -> String {
        text.split(separator: "\n")
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty && !$0.hasPrefix("//") }
            .joined(separator: " ")
    }

    /// The press is marked before the request goes out and marked taken only once the door has it,
    /// so a sheet can tell "your answer" from "somebody else's" — and a refusal clears the mark,
    /// because then the re-seeded card is the live answer.
    func testThePressIsMarkedSendingThenSentAndClearedOnRefusal() throws {
        let console = code(try source(Self.console))
        let decide = try slice(console, from: "func decide(_ approval: PendingApproval,",
                               to: "private(set) var projectID: String?")
        let removed = try XCTUnwrap(decide.range(of: "reducer.removeApproval(id: approval.id)"),
                                    "the card is no longer dropped optimistically")
        let sending = try XCTUnwrap(decide.range(of: "approvalAnswers[approval.id] = .sending"),
                                    "a press no longer says whose answer this is")
        let sent = try XCTUnwrap(decide.range(of: "approvalAnswers[approval.id] = .sent"),
                                 "and is no longer marked as taken once the door has it")
        XCTAssertTrue(removed.lowerBound < sending.lowerBound && sending.lowerBound < sent.lowerBound,
                      "the press is marked sending with the optimistic removal, and sent after the "
                          + "request — the other order would report an answer that never landed")
        XCTAssertTrue(decide.contains("try await api.decideApproval(sessionID: sessionID, approvalID: approval.id, req)"),
                      "the door that decides it")
        let refused = try slice(decide, from: "catch {", to: "await refreshApprovals()")
        XCTAssertTrue(refused.contains("approvalAnswers[approval.id] = nil"),
                      "a refusal clears the mark: the press did not take this card away, and the "
                          + "re-seed is what puts it back")
        XCTAssertTrue(refused.contains("statusMessage = \"Approval failed"),
                      "and says why, in the line the review sheet copies into its own notice")
    }

    /// The sheet answers the reader's own press before it falls back on the copy meant for a
    /// request that went away underneath them.
    func testTheSheetReadsItsOwnAnswerBeforeTheRequestClosedFallback() throws {
        let sheet = code(try source(Self.sheet))
        // From the sheet's own lookup, not `case .approval(let id):` — that is also how the
        // target's own `id` switch spells its case.
        let approval = try slice(sheet, from: "pendingApprovals.first(where: { $0.id == id })",
                                 to: "case .delivered(let card):")
        let mine = try XCTUnwrap(approval.range(of: "console.approvalAnswers[id]"),
                                 "the sheet no longer asks why the approval is gone")
        let fallback = try XCTUnwrap(approval.range(of: "This request is no longer waiting for an answer."),
                                     "the fallback for a request answered elsewhere is gone")
        XCTAssertTrue(mine.lowerBound < fallback.lowerBound,
                      "the reader's own press is read FIRST: the fallback is for the other way a "
                          + "request goes away, and saying it here is what left the sheet open")
        XCTAssertTrue(approval.contains("case .sending:") && approval.contains("ApprovalAnswerUnderWay()"),
                      "a press still in flight is drawn as in flight, not as gone")
        XCTAssertTrue(approval.contains("case .sent:") && approval.contains("ReviewReceipt(")
                          && approval.contains("title: \"Answer sent\""),
                      "and an answer the door took as the receipt that leaves")
    }

    /// The same question for the delivered cards, whose answered-here fact the console already
    /// records ("answered or set aside HERE") — the sheet reads it rather than drawing "recorded
    /// somewhere else" over a decision this window just made.
    func testTheSheetLeavesWhenTheDeliveredCardWasAnsweredHere() throws {
        let sheet = code(try source(Self.sheet))
        let delivered = try slice(sheet, from: "case .delivered(let card):",
                                  to: ".environment(\\.inApprovalReview, true)")
        XCTAssertTrue(delivered.contains("console.answeredHere(card)"),
                      "the sheet does not ask whether IT answered the card, so its own decision is "
                          + "drawn back as somebody else's")
        XCTAssertTrue(delivered.contains("ReviewReceipt(") && delivered.contains("title: \"Decision recorded\""),
                      "an answered card gives way to the receipt, not to the live card's own "
                          + "stale-reading copy")
        let console = code(try source(Self.console))
        XCTAssertTrue(console.contains("func answeredHere(_ card: DeliveredDecisionCard) -> Bool { closedCards.contains(card.id) }"),
                      "`answeredHere` is the closedCards set the transcript reads, not a second "
                          + "opinion that can disagree with it")
    }

    /// The receipt is drawn from the press's own outcome and leaves by itself; the sheet is never
    /// left on a state it cannot get out of.
    func testTheReceiptLeavesByItself() throws {
        let sheet = code(try source(Self.sheet))
        let block = try slice(sheet, from: "struct ReviewReceipt: View", to: "struct ApprovalReviewSheet: View")
        XCTAssertTrue(block.contains("@Environment(\\.dismiss) private var dismiss"),
                      "the receipt needs the sheet's own dismiss, not a pop")
        XCTAssertTrue(block.contains("try? await Task.sleep(for: .seconds(1.2)) dismiss()"),
                      "the receipt no longer closes itself: one that stays is the dead end this "
                          + "replaced, with a nicer face on it")
    }
}
