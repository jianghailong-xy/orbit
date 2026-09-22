import Foundation
import XCTest
@testable import OrbitKit

/// WHERE A MERGE'S RECORD IS DRAWN — the one thing about it that was still wrong on the clients
/// while the browser had already been fixed.
///
/// The account owner, on the iOS build (2026-09-21), read this in a session:
///
///     ✓ Merged into main
///     df444ca · merge of project/34ODo… · 41m
///
/// fixed at the BOTTOM of the conversation: under every later message, in conversations started long
/// after the merge, and still there after the project was done. Nothing derived it wrongly. The card
/// was drawn off `GET /projects/:id/promotions/current` — the candidate the branch is offering NOW,
/// whose row moves on to the next candidate — and a delivered card anchors where it ARRIVED, which
/// for a read that keeps re-finding it is the tail. Web was fixed by giving the merge a read of its
/// own (`GET /projects/:id/promotions/merged`, `projectMergedPromotionsQuery`), which serves the
/// MERGED rows newest first, each carrying its own `mergedSha`/`mergedAt`, and drawing the record
/// where it happened (`ProjectPromotionReceipt`, anchored by `decisionReceiptAnchor`).
///
/// These tests are the Linux-runnable half of the same fix on this client: WHERE a record lands, that
/// an unplaceable one is not drawn at all, and the wire from the console and the card to both. Layout
/// is what the beta and the owner's screenshot are for; ORDER is what this file settles.
final class PromotionReceiptPlacementTests: XCTestCase {

    // MARK: the fixture

    /// The account owner's own merge, as the read serves one: terminal, immutable, and carrying the
    /// commit it put on main.
    private func merge(_ promotionID: String, at stamp: String, sha: String,
                       source: String = "refs/heads/project/34ODo",
                       tasks: [String] = ["t1", "t2"]) -> ProjectPromotionView {
        ProjectPromotionView(
            promotionId: promotionID, state: .merged,
            sourceRef: source, sourceSha: "58f3a4711d0c", upstreamRef: "refs/heads/main",
            commitsAhead: 7, filesChanged: 18, taskIds: tasks,
            askedAt: "2026-09-21T09:00:00.000Z", recheckedAt: nil,
            merged: .init(sha: sha, at: stamp))
    }

    private func item(_ id: String, at stamp: String) -> TranscriptItem {
        .user(UserBubble(id: id, text: "…", ts: stamp, pending: false, queued: false))
    }

    private func state(_ items: [TranscriptItem]) -> TranscriptState {
        var s = TranscriptState()
        s.items = items
        return s
    }

    private func rows(items: [TranscriptItem], cards: [DeliveredDecisionCard]) -> [String] {
        TranscriptRows.build(state: state(items), statusCards: [], canPageOlder: false,
                             showWorkingIndicator: false, decisionCards: cards).map(\.id)
    }

    /// The row the console adopts for a record, built the way `adoptPromotionReceipts` builds it.
    private func card(_ receipt: PromotionCards.Receipt) -> DeliveredDecisionCard {
        DeliveredDecisionCard(kind: .promotionReceipt(promotion: receipt.promotion),
                              afterItemID: receipt.afterItemID)
    }

    /// A conversation that outlived the merge by an hour: the merge landed between `i2` and `i3`, so
    /// the last row loaded is NOT where it belongs.
    private func transcript() -> [TranscriptItem] {
        [item("i1", at: "2026-09-21T09:00:00.000Z"),
         item("i2", at: "2026-09-21T09:25:00.000Z"),
         item("i3", at: "2026-09-21T10:00:00.000Z")]
    }

    private static let mergedSha = "df444ca91b7e0c2f5a6d8e1b3c4a5f60718293a4"

    // MARK: (a) where the merge happened

    /// The record is drawn where the merge HAPPENED — the door's own clock, against the rows' own
    /// clocks — and not where the read that found it happened to be looking. `i3` arrived after the
    /// merge and stays BELOW the record, which is what tells the two rules apart.
    func testAMergeIsDrawnWhereItHappenedAndNotAtTheTail() {
        let items = transcript()
        let receipts = PromotionCards.receipts(
            merged: [merge("pr-1", at: "2026-09-21T09:30:00.000Z", sha: Self.mergedSha)],
            items: items)

        XCTAssertEqual(receipts.map(\.afterItemID), ["i2"])
        XCTAssertEqual(receipts.map(\.id), ["promotion-receipt-pr-1"])
        XCTAssertNotEqual(receipts.first?.afterItemID, items.last?.id,
                          "a record anchored at the tail is drawn as though it happened last, "
                          + "which is the defect the owner reported")
        XCTAssertEqual(rows(items: items, cards: receipts.map(card)),
                       ["i1", "i2", "promotion-receipt-pr-1", "i3", "transcript-bottom"])
    }

    /// A record is not a question, and the row it draws is its own: the card that ASKS for the merge
    /// can be on screen beside it while the question is being let go of, and two rows sharing an id
    /// costs the List its diff.
    func testTheRecordsRowIsBesideTheCardsAndNotTheSameAsIt() {
        XCTAssertEqual(DeliveredDecisionCard(kind: .promotionReceipt(
            promotion: merge("pr-1", at: "2026-09-21T09:30:00.000Z", sha: Self.mergedSha))).id,
                       "promotion-receipt-pr-1")
        XCTAssertNotEqual(DeliveredDecisionCard(kind: .promotionReceipt(
            promotion: merge("pr-1", at: "2026-09-21T09:30:00.000Z", sha: Self.mergedSha))).id,
                          DeliveredDecisionCard(kind: .promotionApproval(promotionID: "pr-1")).id)
    }

    // MARK: (b) the record nothing can place

    /// THE SCREENSHOT'S CASE, one conversation later. The merge is older than every row this console
    /// holds, so it cannot be placed: it is NOT drawn, and above all it is not drawn at the tail
    /// instead — that is the defect rather than a smaller version of it. Web says the same by drawing
    /// nothing for an anchor `decisionReceiptAnchor` answers `null` for.
    func testAMergeOlderThanEveryLoadedRowIsNotDrawnAtTheTailInstead() {
        let items = [item("i1", at: "2026-09-22T08:00:00.000Z"),
                     item("i2", at: "2026-09-22T08:30:00.000Z")]
        XCTAssertEqual(
            PromotionCards.receipts(merged: [merge("pr-1", at: "2026-09-21T09:30:00.000Z",
                                                   sha: Self.mergedSha)],
                                    items: items),
            [])
        XCTAssertEqual(rows(items: items, cards: []),
                       ["i1", "i2", "transcript-bottom"])
    }

    /// And nothing is invented for a row that carries no moment at all: the door serves the merges it
    /// has a `merged_at` for, and a row without one has no place to be drawn.
    func testARowWithNoMomentOfItsOwnIsNotDrawnEither() {
        let unmoment = ProjectPromotionView(
            promotionId: "pr-2", state: .merged, sourceRef: "refs/heads/project/34ODo",
            sourceSha: "58f3a4711d0c", upstreamRef: "refs/heads/main", merged: nil)
        XCTAssertEqual(PromotionCards.receipts(merged: [unmoment], items: transcript()), [])
        XCTAssertEqual(PromotionCards.receipts(merged: [], items: transcript()), [],
                       "a project that has merged nothing draws nothing")
    }

    // MARK: (c) one conversation, two merges

    /// Two merges, each at its own moment, each drawn where it happened and neither over the other:
    /// the second does not take the first's place, and the first does not walk down to the tail when
    /// the second is read.
    func testTwoMergesEachLandWhereTheyHappened() {
        let first = merge("pr-1", at: "2026-09-21T09:30:00.000Z", sha: Self.mergedSha,
                          source: "refs/heads/project/34ODo")
        let second = merge("pr-2", at: "2026-09-21T10:45:00.000Z",
                           sha: "1f2e3d4c5b6a798807162534435261708f9e0a1b",
                           source: "refs/heads/project/34ODoUKJ")
        let items = [item("i1", at: "2026-09-21T09:00:00.000Z"),
                     item("i2", at: "2026-09-21T09:25:00.000Z"),
                     item("i3", at: "2026-09-21T10:00:00.000Z"),
                     item("i4", at: "2026-09-21T11:00:00.000Z")]
        // Newest first, the way the door serves them.
        let receipts = PromotionCards.receipts(merged: [second, first], items: items)

        XCTAssertEqual(receipts.map(\.afterItemID), ["i3", "i2"])
        XCTAssertEqual(Set(receipts.map(\.id)).count, 2,
                       "two merges are two rows: one id for both would cost the List its diff and "
                       + "draw the second merge over the first")
        XCTAssertEqual(rows(items: items, cards: receipts.map(card)),
                       ["i1", "i2", "promotion-receipt-pr-1", "i3", "promotion-receipt-pr-2",
                        "i4", "transcript-bottom"])
    }

    // MARK: (d) what the record says

    /// The record says what THAT merge was: its own commit, its own branch, and the state it ended
    /// in — read off the terminal row it carries, never off whatever the branch is offering now,
    /// which is the whole reason this read exists.
    func testTheRecordKeepsThatMergesOwnCommitAndState() {
        let now = RelativeTime.parse("2026-09-21T09:45:00Z")!
        let first = merge("pr-1", at: "2026-09-21T09:30:00.000Z", sha: Self.mergedSha,
                          source: "refs/heads/project/34ODo")
        let second = merge("pr-2", at: "2026-09-21T09:40:00.000Z",
                           sha: "1f2e3d4c5b6a798807162534435261708f9e0a1b",
                           source: "refs/heads/project/34ODoUKJ")
        let items = transcript()
        let receipts = PromotionCards.receipts(merged: [second, first], items: items)
        XCTAssertEqual(receipts.count, 2)

        let mine = receipts.last
        XCTAssertEqual(mine?.promotion.state, .merged)
        XCTAssertEqual(mine?.promotion.merged?.sha, Self.mergedSha)
        XCTAssertEqual(PromotionCards.title(first), PromotionCards.mergedHeading,
                       "the state it ended in is what the card is headed")
        XCTAssertEqual(PromotionCards.title(first), "✓ Merged into main")

        let line = PromotionCards.mergedLine(first, now: now)
        XCTAssertTrue(line.contains("df444ca"), line)
        XCTAssertTrue(line.contains("merge of project/34ODo"), line)
        XCTAssertFalse(line.contains("1f2e3d4"), "that is the other merge's commit: \(line)")
    }

    // MARK: the wire — the read the record is drawn from

    private enum WiringError: Error, CustomStringConvertible {
        case missing(String)
        var description: String {
            switch self {
            case .missing(let what):
                return "\(what) was not found above this test. If it moved, move this check with "
                    + "it rather than deleting it: it is the only gate on Linux that sees whether a "
                    + "merge is still drawn from the read that carries its own moment."
            }
        }
    }

    private static let consolePath = "src/macos/OrbitApp/Sources/OrbitApp/ConsoleModel.swift"
    private static let cardPath = "src/macos/OrbitApp/Sources/OrbitApp/Views/ApprovalCards.swift"
    private static let apiPath = "src/macos/OrbitKit/Sources/OrbitKit/Net/APIClient.swift"

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

    /// One stretch of a file, so a match somewhere else cannot answer for the part being asserted
    /// about. (A bare `contains` over a whole file is how a scan like this goes falsely green.)
    private func section(_ source: String, from: String, to: String) throws -> String {
        guard let start = source.range(of: from),
              let end = source.range(of: to, range: start.upperBound..<source.endIndex) else {
            throw WiringError.missing("\(from) … \(to)")
        }
        return String(source[start.lowerBound..<end.lowerBound])
    }

    /// The lines of one stretch that are CODE: a call that is commented out still contains its own
    /// words, so every assertion below is made over these and never over the raw slice.
    private func statements(_ source: String) -> [String] {
        source.split(separator: "\n")
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty && !$0.hasPrefix("//") }
    }

    /// The door the record is read from, and the only one it may be read from: `current` is the
    /// candidate on offer, whose row moves on to the next candidate — the reason a receipt drawn from
    /// it described a different merge every time the branch was offered again.
    func testTheClientReadsTheMergesFromTheirOwnDoor() throws {
        let api = try source(Self.apiPath)
        let reader = try section(api, from: "public func mergedPromotions(projectID: String)",
                                 to: "\n    /// M-T4: merge it")
        let written = statements(reader).joined(separator: " ")
        XCTAssertTrue(written.contains("\"projects/\\(projectID)/promotions/merged\""),
                      "the client is not reading /promotions/merged: \(written)")
        XCTAssertFalse(written.contains("promotions/current"),
                       "a receipt drawn off the candidate on offer describes a different merge "
                       + "every time the branch is offered again")
    }

    /// The rule above decides nothing unless the console asks it, and the console is compiled only by
    /// the macOS and iOS jobs — SwiftUI does not exist on Linux — so the attachment is asserted over
    /// the source, the way `OwnerConfirmationPlacementTests` does.
    func testTheConsoleAdoptsEachMergeByItsOwnMoment() throws {
        let console = try source(Self.consolePath)
        let refresh = try section(console,
                                  from: "func refreshRulerQuestions(force: Bool = false) async {",
                                  to: "\n    /// Whether this project is waiting to be started")
        let reads = statements(refresh).joined(separator: " ")
        XCTAssertTrue(reads.contains("api.mergedPromotions(projectID: projectID)"),
                      "the read that carries each merge's own moment is not being made")
        XCTAssertTrue(reads.contains("adoptPromotionReceipts(merged)"),
                      "and what it answers is not being drawn where it happened")
        XCTAssertFalse(reads.contains("deliver(.promotionReceipt"),
                       "delivering a receipt anchors it to the moment this DEVICE read the merge, "
                       + "which is the bottom of the pane the owner reported")

        let adopt = try section(console, from: "private func adoptPromotionReceipts(",
                                to: "\n    /// Where one delivered proposal stands right now")
        let built = statements(adopt).joined(separator: " ")
        XCTAssertTrue(built.contains("PromotionCards.receipts(merged: merged, items: state.items)"),
                      "the record's place is the merge's own clock, and the console has to ask for it")
        XCTAssertTrue(built.contains("afterItemID: receipt.afterItemID"),
                      "the adopted row must carry the anchor the rule computed, not one of its own")
        XCTAssertTrue(built.contains(".promotionReceipt(promotion: receipt.promotion)"),
                      "and it must be drawn as a record rather than as a second question")
    }

    /// And the strip stops drawing the merge as a QUESTION once it has happened. Held there as well it
    /// sat under every later message for the life of the project, which is the report: the card the
    /// read finds asking is a card; the candidate it finds MERGED is a record, drawn above.
    func testAMergedCandidateIsLetGoOfByTheStripRatherThanKeptAtTheTail() throws {
        let console = try source(Self.consolePath)
        let site = try section(console, from: "let current = try await api.currentPromotion",
                               to: "        } catch {")
        let written = statements(site).joined(separator: " ")
        XCTAssertTrue(written.contains("if stage == .merged {"), written)
        XCTAssertTrue(written.contains("close(.promotionApproval(promotionID: current.promotionId))"),
                      "a candidate that has merged keeps its card at the tail: \(written)")
        XCTAssertTrue(written.contains("deliver(.promotionApproval(promotionID: current.promotionId))"),
                      "and a candidate that is still asking must still be delivered: \(written)")
    }

    /// The row reaches the screen: the switch dispatches it, the card draws that merge's own commit
    /// and state, and the record is never counted as an open question — nothing on it is pressable.
    func testTheRecordIsDrawnAsAReceiptAndNeverCountedAsAQuestion() throws {
        let card = try source(Self.cardPath)
        let dispatch = try section(card, from: "case .promotionApproval(let promotionID):",
                                   to: "// A card re-derives itself when it comes into view")
        XCTAssertTrue(dispatch.contains("case .promotionReceipt(let promotion):"),
                      "the delivered-card switch draws nothing for a merge's record")
        XCTAssertTrue(dispatch.contains("PromotionReceiptCard(promotion: promotion)"),
                      "and what it draws must be handed the merge it is about")

        let view = try section(card, from: "private struct PromotionReceiptCard: View",
                               to: "private struct CardRow: View")
        XCTAssertTrue(view.contains("PromotionCards.title(promotion)"),
                      "the record draws OrbitKit's heading rather than one composed here")
        XCTAssertTrue(view.contains("PromotionCards.mergedLine(promotion)"),
                      "and OrbitKit's line, which is the one naming the commit that landed")
        XCTAssertFalse(view.contains("Button"),
                       "a record is not a question: nothing on it is pressable")

        let console = try source(Self.consolePath)
        let counted = try section(console, from: "var openQuestionRowIDs: [String] {",
                                  to: "\n    /// A row the transcript has been asked to scroll to")
        XCTAssertTrue(counted.contains(".promotionReceipt"),
                      "the record's row must be counted among the receipts — it is not a question, "
                      + "and a bar pointing at it would be pointing at nothing to answer")
    }
}
