import Foundation
import XCTest

/// SwiftUI doesn't exist on Linux, so nothing here compiles the app shells. These hold the
/// coordinator conversation's crossing card to its source: the console reads the project's
/// handoffs with its other project reads and puts one card per batch at its first request; a press
/// answers every pending row through the project page's door; the card is drawn for its kind.
final class CrossingBatchWiringTests: XCTestCase {
    private func source(_ path: String) throws -> String {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<12 {
            let candidate = dir.appendingPathComponent(path)
            if FileManager.default.fileExists(atPath: candidate.path) {
                return try String(contentsOf: candidate, encoding: .utf8)
            }
            dir.deleteLastPathComponent()
        }
        throw NSError(domain: "missing \(path)", code: 1)
    }

    private func app(_ relative: String) throws -> String {
        try source("src/macos/OrbitApp/Sources/OrbitApp/\(relative)")
    }

    private func slice(_ text: String, from start: String, to end: String) throws -> String {
        let lower = try XCTUnwrap(text.range(of: start), "no `\(start)`")
        let upper = try XCTUnwrap(text.range(of: end, range: lower.upperBound..<text.endIndex),
                                  "no `\(end)` after `\(start)`")
        return String(text[lower.lowerBound..<upper.upperBound])
    }

    func testTheConsoleReadsTheHandoffsWithItsProjectReads() throws {
        let model = try app("ConsoleModel.swift")
        let refresh = try slice(model, from: "func refreshRulerQuestions(force: Bool = false) async {",
                                to: "lastRulerRead = Date()")
        XCTAssertTrue(refresh.contains("if let rows = try? await api.projectCrossings(projectID: projectID) {\n            adoptCrossings(rows)\n        }"))
        let adopt = try slice(model, from: "private func adoptCrossings(_ rows: [ProjectCrossing]) {", to: "\n    }\n")
        XCTAssertTrue(adopt.contains("if batch.isLive { crossingBatchesSeenLive.insert(batch.id) }"))
        XCTAssertTrue(adopt.contains("deliver(.crossingBatch(batchID: batch.id), placement: .at(batch.moment))"))
        XCTAssertTrue(model.contains("CrossingBatches.batches(crossings, projectID: projectID)"))
    }

    func testAPressAnswersEveryPendingRowThroughTheDoor() throws {
        let model = try app("ConsoleModel.swift")
        let decide = try slice(model, from: "func decideCrossingBatch(_ batchID: String, _ decision: ProjectCrossingDecision) async {",
                               to: "\n    }\n")
        XCTAssertTrue(decide.contains("for (row, _) in CrossingBatches.requests(batch, decision) {"))
        XCTAssertTrue(decide.contains("try await api.decideProjectCrossing(projectID: projectID, crossing: row, decision)"))
        XCTAssertTrue(decide.contains("crossingRefusals[row.id] = ProjectCrossings.refusal(error)"))
        XCTAssertTrue(decide.contains("if taken > 0 { crossingBatchesPressedAt[batchID] = pressedAt }"))
        XCTAssertTrue(decide.contains("adoptCrossings(rows)"), "the press re-reads the handoffs")
    }

    func testTheCardIsDrawnAndReviewed() throws {
        let cards = try app("Views/ApprovalCards.swift")
        XCTAssertTrue(cards.contains("case .crossingBatch(let batchID):\n                CrossingDecisionCard(console: console, batchID: batchID)"))
        let view = try app("Views/CrossingDecisionCard.swift")
        XCTAssertTrue(view.contains("symbol: \"arrow.left.arrow.right\""))
        XCTAssertTrue(view.contains("tone: .orange"))
        XCTAssertTrue(view.contains("await console.decideCrossingBatch(batchID, decision)"))
        let review = try app("Views/ApprovalReview.swift")
        XCTAssertTrue(review.contains("return console.crossingAnsweredHere(batchID)"),
                      "the review leaves after its own press, like every other card's")
        XCTAssertTrue(review.contains("guard !crossingAnsweredAtOpen else { return }"),
                      "a record opened again after the press stays open")
        let console = try app("Views/Console/ConsoleView.swift")
        XCTAssertTrue(console.contains(".ownerConfirmation, .coordinatorQuestion, .crossingBatch:"),
                      "the needs-you bar opens the review")
    }
}
