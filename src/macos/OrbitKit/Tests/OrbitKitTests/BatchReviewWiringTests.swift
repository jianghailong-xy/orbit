import Foundation
import XCTest
@testable import OrbitKit

/// The wires of the batch-create review approved in docs/mocks/batch-create-review-ios. SwiftUI does
/// not build on Linux, so the attachment is asserted over the source, the way
/// `ShareEntriesWiringTests` does. Each check is written so that undoing the wire turns it red.
final class BatchReviewWiringTests: XCTestCase {

    private struct SourceMissing: Error, CustomStringConvertible {
        let path: String
        var description: String {
            "\(path) wasn't found above this test. If it moved, point this check at its new home — "
                + "don't delete the check."
        }
    }

    /// Found by walking up from this file; never a skip, so the check can't go quiet when a file moves.
    private func source(_ path: String) throws -> String {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<12 {
            let candidate = dir.appendingPathComponent(path)
            if FileManager.default.fileExists(atPath: candidate.path) {
                return try String(contentsOf: candidate, encoding: .utf8)
            }
            dir.deleteLastPathComponent()
        }
        throw SourceMissing(path: path)
    }

    private func appSource(_ relative: String) throws -> String {
        try source("src/macos/OrbitApp/Sources/OrbitApp/\(relative)")
    }

    /// From the first `start` through the next `end` after it.
    private func slice(_ text: String, from start: String, to end: String) throws -> String {
        let lower = try XCTUnwrap(text.range(of: start), "no `\(start)`")
        let upper = try XCTUnwrap(text.range(of: end, range: lower.upperBound..<text.endIndex),
                                  "no `\(end)` after `\(start)`")
        return String(text[lower.lowerBound..<upper.upperBound])
    }

    /// The text without its comment lines, which are free to talk about what the code must not do.
    private func code(_ text: String) -> String {
        text.split(separator: "\n", omittingEmptySubsequences: false)
            .filter { !$0.trimmingCharacters(in: .whitespaces).hasPrefix("//") }
            .joined(separator: "\n")
    }

    /// The conditional-compilation branches `needle` sits in, outermost first: `os(iOS)` inside an
    /// `#if os(iOS)`, `!os(iOS)` inside its `#else`. Empty means every platform compiles it.
    private func branches(of needle: String, in text: String,
                          file: StaticString = #filePath, line: UInt = #line) throws -> [String] {
        let at = try XCTUnwrap(text.range(of: needle), "no `\(needle)`", file: file, line: line)
        var stack: [String] = []
        for row in text[..<at.lowerBound].split(separator: "\n", omittingEmptySubsequences: false) {
            let directive = row.components(separatedBy: "//")[0].trimmingCharacters(in: .whitespaces)
            if directive.hasPrefix("#if ") {
                stack.append(String(directive.dropFirst(4)))
            } else if directive.hasPrefix("#elseif "), !stack.isEmpty {
                stack[stack.count - 1] = String(directive.dropFirst(8))
            } else if directive == "#else", let open = stack.popLast() {
                stack.append("!" + open)
            } else if directive == "#endif" {
                _ = stack.popLast()
            }
        }
        return stack
    }

    /// iOS 26 draws `.confirmationAction` as the prominent, filled button: the review's ✕ came out as
    /// a second blue yes beside "Create". The phone puts it where the share sheet's Done goes, and
    /// every page of the review uses the same one.
    func testTheReviewsCloseIsNotASecondYesOnThePhone() throws {
        let review = code(try appSource("Views/ApprovalReview.swift"))
        let close = try slice(review, from: "struct ApprovalReviewCloseButton: ToolbarContent",
                              to: "struct ApprovalReviewSheet: View")
        XCTAssertEqual(try branches(of: "ToolbarItem(placement: .topBarTrailing)", in: close), ["os(iOS)"])
        XCTAssertEqual(try branches(of: "ToolbarItem(placement: .confirmationAction)", in: close), ["!os(iOS)"],
                       "the Mac draws that placement plainly and keeps it")

        let sheet = try slice(review, from: "struct ApprovalReviewSheet: View", to: ".presentationDetents")
        XCTAssertTrue(sheet.contains(".toolbar { ApprovalReviewCloseButton { dismiss() } }"))
        XCTAssertFalse(sheet.contains("placement: .confirmationAction"),
                       "the sheet's own toolbar no longer places the ✕ itself")

        let page = code(try appSource("Views/BatchCreateReview.swift"))
        XCTAssertTrue(try slice(page, from: "struct BatchTaskPage: View", to: "private func section")
                          .contains(".toolbar { ApprovalReviewCloseButton(close: close) }"),
                      "a pushed task page keeps the same ✕, and it closes the review, not the page")
    }

    /// The batch card asks its question once, in the navigation bar, and draws the approved body: the
    /// grouped page, the consequence rows, the levels, a page per task.
    func testTheBatchCardDrawsTheApprovedReview() throws {
        let card = code(try appSource("Views/ApprovalCards.swift"))
        let details = try slice(card, from: "@ViewBuilder private var details: some View",
                                to: "} else if let dag {")
        XCTAssertTrue(details.contains("BatchCreateReviewBody(batch: batch,"))
        XCTAssertTrue(details.contains("details: approval.input.map(Approvals.batchTaskDetails)"),
                      "the task pages read the bodies the runner sends, not just the preview's titles")
        XCTAssertFalse(details.contains("ApprovalHeader("),
                       "no second \"Create 3 tasks?\" under the navigation bar's")
        XCTAssertFalse(card.contains("batchTreeRows"), "the card lists levels; the tree is the transcript's")

        XCTAssertTrue(card.contains("summary: reviewSummary, grouped: batch != nil)"))
        XCTAssertTrue(card.contains("if let batch { return Approvals.batchCreateAction(batch.taskCount) }"))
        XCTAssertFalse(card.contains("\"Create them\""))
        XCTAssertTrue(card.contains("ForEach(create.impactRows) { BatchImpactRowView(row: $0) }"),
                      "the single create card draws its consequence the way the batch card does")

        let review = code(try appSource("Views/ApprovalReview.swift"))
        XCTAssertTrue(review.contains("if grouped { Color.reviewBackdrop.ignoresSafeArea() }"))
    }

    /// Each row opens its task's page inside the review's own stack. The page has no yes of its own:
    /// "Create" on one task's page would read as creating that task alone.
    func testATaskOpensItsOwnPageAndThePageDecidesNothing() throws {
        let file = code(try appSource("Views/BatchCreateReview.swift"))
        let body = try slice(file, from: "struct BatchCreateReviewBody: View", to: "private struct BatchLevelBlock")
        XCTAssertTrue(body.contains("NavigationLink {"))
        XCTAssertTrue(body.contains("BatchTaskPage(row: row, levels: levels, details: details,"))
        XCTAssertTrue(body.contains("Approvals.batchLevels(batch.tasks)"))
        XCTAssertTrue(body.contains("Approvals.batchDetailLine(batch)"))
        XCTAssertTrue(body.contains("Approvals.batchImpactRows(batch)"))
        XCTAssertFalse(file.contains("navigationDestination(isPresented:"))

        let page = try slice(file, from: "struct BatchTaskPage: View", to: "private func section")
        XCTAssertFalse(page.contains("decide("), "the decision is the whole batch's, on the first page")
        XCTAssertFalse(page.contains("batchCreateAction"))
    }

    /// The two clients name the batch card's yes the same way.
    func testWebSaysTheSameYes() throws {
        let web = try source("src/web/src/components/ApprovalPanel.tsx")
        XCTAssertTrue(web.contains("`Create ${batch.taskCount ?? 0} task${batch.taskCount === 1 ? '' : 's'}`"),
                      "ApprovalPanel.tsx's batch button no longer counts, or counts differently")
        XCTAssertFalse(web.contains("'Create them'"))
        XCTAssertEqual(Approvals.batchCreateAction(2), "Create 2 tasks")
        XCTAssertEqual(Approvals.batchCreateAction(1), "Create 1 task")
    }
}
