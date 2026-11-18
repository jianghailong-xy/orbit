import Foundation
import XCTest
@testable import OrbitKit

final class CoordinatorCleanStartTests: XCTestCase {
    private struct FixtureMissing: Error, CustomStringConvertible {
        var description: String {
            "contracts/coordinator-clean-start.fixtures.json was not found above \(#filePath). If it moved, update this check."
        }
    }

    private func fixture() throws -> [String: Any] {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<12 {
            let candidate = dir.appendingPathComponent("contracts/coordinator-clean-start.fixtures.json")
            if FileManager.default.fileExists(atPath: candidate.path) {
                return try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: candidate)) as? [String: Any])
            }
            dir.deleteLastPathComponent()
        }
        throw FixtureMissing()
    }

    private func items(_ fixture: [String: Any]) throws -> [TranscriptItem] {
        try XCTUnwrap(fixture["loaded"] as? [[String: Any]]).map { row in
            .user(UserBubble(id: try XCTUnwrap(row["id"] as? String), text: "Hello",
                             ts: try XCTUnwrap(row["ts"] as? String), pending: false, queued: false))
        }
    }

    func testRecordAndOpenItemPlacementsMatchSharedFixture() throws {
        let fixture = try fixture()
        let createdAt = try XCTUnwrap(fixture["createdAt"] as? String)
        let clocks = ReceiptAnchor.Clocks(try items(fixture))
        for key in ["records", "openItems"] {
            for row in try XCTUnwrap(fixture[key] as? [[String: Any]]) {
                let stamp = try XCTUnwrap(row["stamp"] as? String)
                let name = try XCTUnwrap(row["name"] as? String)
                let actual = ReceiptAnchor.place(clocks, at: stamp, since: key == "records" ? createdAt : nil)
                if let expected = row["expect"] as? String {
                    switch expected {
                    case "hidden":
                        XCTAssertTrue(actual == .beforeConversation || actual == .unplaceable, name)
                    case "head": XCTAssertEqual(actual, .beforeWindow, name)
                    default: XCTFail("Unknown placement: \(expected)")
                    }
                } else {
                    let expected = try XCTUnwrap(row["expect"] as? [String: String])
                    XCTAssertEqual(actual, .after(try XCTUnwrap(expected["after"])), name)
                }
            }
        }
    }

    func testCountsAndNoteCopyMatchSharedFixture() throws {
        let fixture = try fixture()
        let createdAt = try XCTUnwrap(fixture["createdAt"] as? String)
        for row in try XCTUnwrap(fixture["counts"] as? [[String: Any]]) {
            let counts = CoordinatorCleanStart.counts(
                createdAt: createdAt, decisions: try XCTUnwrap(row["decisions"] as? [String]),
                merges: try XCTUnwrap(row["merges"] as? [String]))
            let expected = try XCTUnwrap(row["expect"] as? [String: Int])
            XCTAssertEqual(counts.decisions, expected["decisions"])
            XCTAssertEqual(counts.merges, expected["merges"])
        }
        for row in try XCTUnwrap(fixture["noteLine"] as? [[String: Any]]) {
            XCTAssertEqual(CoordinatorHandoffCopy.historyBefore(
                try XCTUnwrap(row["decisions"] as? Int), try XCTUnwrap(row["merges"] as? Int)),
                row["expect"] as? String)
        }
        XCTAssertEqual(CoordinatorHandoffCopy.openPrevious, fixture["openPrevious"] as? String)
    }

    func testMissingOrUnreadableCreationKeepsExistingPlacementAndCountsNothing() throws {
        let clocks = ReceiptAnchor.Clocks(try items(fixture()))
        let stamp = "2026-11-15T09:00:00.000Z"
        let starts: [String?] = [nil, "not a stamp"]
        for createdAt in starts {
            XCTAssertEqual(ReceiptAnchor.place(clocks, at: stamp, since: createdAt), .beforeWindow)
            let counts = CoordinatorCleanStart.counts(createdAt: createdAt, decisions: [stamp], merges: [stamp])
            XCTAssertEqual(counts.decisions, 0)
            XCTAssertEqual(counts.merges, 0)
        }
    }

    func testBuildHidesEarlierQuestionRecordsKeepsHeadAndOpenItems() throws {
        let fixture = try fixture()
        func record(_ id: String, at stamp: String) -> DeliveredDecisionCard {
            let closed = ProjectClosedQuestion(
                itemId: id, question: CoordinatorQuestion(question: "Continue?"),
                askedAt: stamp, resolvedAt: stamp)
            return DeliveredDecisionCard(kind: .coordinatorQuestionRecord(record: closed), placement: .at(stamp))
        }
        let hidden = record("previous", at: "2026-11-15T09:00:00.000Z")
        let head = record("current", at: "2026-11-16T15:05:00.000Z")
        let open = DeliveredDecisionCard(kind: .escalatedItem(itemID: "open"),
                                         placement: .at("2026-11-15T09:00:00.000Z"))
        var state = TranscriptState()
        state.items = try items(fixture)
        let rows = TranscriptRows.build(
            state: state, statusCards: [], canPageOlder: false, showWorkingIndicator: false,
            decisionCards: [hidden, head, open], conversationCreatedAt: try XCTUnwrap(fixture["createdAt"] as? String))
        XCTAssertEqual(rows.map(\.id), [open.id, head.id] + state.items.map(\.id) + ["transcript-bottom"])
    }
}
