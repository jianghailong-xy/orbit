import Foundation
import XCTest
@testable import OrbitKit

/// A session with more mode changes than its detail carries, as a real apiserver on PostgreSQL answered it
/// (src/macos/OrbitKit/Fixtures/permission-mode-paging, made by scripts/permission-mode-actual-stack/capture-paging.mjs):
/// the detail's newest 50 and the two pages before them, read the way the console reads them — the detail first, then
/// each page through `ModeChangeHistory`.
final class PermissionModePagingWireTests: XCTestCase {
    private struct FixtureMissing: Error, CustomStringConvertible {
        let name: String
        var description: String { "Fixtures/permission-mode-paging/\(name).json was not found above \(#filePath)." }
    }

    private func data(_ name: String) throws -> Data {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<6 {
            let candidate = dir.appendingPathComponent("Fixtures/permission-mode-paging/\(name).json")
            if FileManager.default.fileExists(atPath: candidate.path) { return try Data(contentsOf: candidate) }
            dir.deleteLastPathComponent()
        }
        throw FixtureMissing(name: name)
    }

    private func detail() throws -> Session { try JSONDecoder().decode(Session.self, from: data("session-paging")) }
    private func pages() throws -> [SessionPermissionModeChangePage] {
        try ["session-paging-page-1", "session-paging-page-2"].map {
            try JSONDecoder().decode(SessionPermissionModeChangePage.self, from: data($0))
        }
    }

    func testTheDetailCarriesTheNewestFiftyAndSaysOlderOnesAreRecorded() throws {
        let session = try detail()
        let changes = try XCTUnwrap(session.permissionModeChanges)
        XCTAssertEqual(changes.count, 50)
        XCTAssertTrue(changes.allSatisfy { $0.seq != nil })
        XCTAssertEqual(session.permissionModeChangesHasMore, true)
        XCTAssertEqual(changes.last?.toMode, session.actualPermissionMode)
        // Every entry the server sent was decoded.
        let raw = try XCTUnwrap(JSONSerialization.jsonObject(with: data("session-paging")) as? [String: Any])
        XCTAssertEqual((raw["permissionModeChanges"] as? [Any])?.count, changes.count)
    }

    func testThePagesBeforeItReachTheFirstChangeEachOnceInOrderWithWhoMadeIt() throws {
        let session = try detail()
        let pages = try pages()
        var held = ModeChangeHistory().adopt(try XCTUnwrap(session.permissionModeChanges),
                                             hasMore: session.permissionModeChangesHasMore == true)
        var asked: [Int] = []
        for page in pages {
            // The transcript has reached the session's start, so every older page is read, from the oldest held.
            XCTAssertTrue(held.needsOlder(oldestRowAt: held.changes.first?.at, reachesStart: true))
            let before = try XCTUnwrap(held.changes.first?.seq)
            asked.append(before)
            held = held.withOlder(before: before, page)
        }
        XCTAssertFalse(held.hasMore)
        XCTAssertFalse(held.needsOlder(oldestRowAt: held.changes.first?.at, reachesStart: true))
        XCTAssertEqual(pages.map(\.changes.count), [50, 11])
        XCTAssertEqual(pages.map(\.hasMore), [true, false])
        XCTAssertEqual(asked, [session.permissionModeChanges?.first?.seq, pages[0].changes.first?.seq].compactMap { $0 })

        let all = held.changes
        XCTAssertEqual(all.count, 111)
        let seqs = all.compactMap(\.seq)
        XCTAssertEqual(Set(seqs).count, all.count, "each once")
        XCTAssertEqual(seqs, seqs.sorted(), "in seq order")
        // In the order it happened: each change starts from the mode the one before it left, and time never goes back.
        XCTAssertNil(all.first?.fromMode)
        for (a, b) in zip(all, all.dropFirst()) {
            XCTAssertEqual(b.fromMode, a.toMode, "\(b.seq ?? -1) follows \(a.seq ?? -1)")
            XCTAssertLessThanOrEqual(try XCTUnwrap(ThinkingSummary.date(a.at)), try XCTUnwrap(ThinkingSummary.date(b.at)))
        }
        // Who or what made each: the claim, the owner's six picks with the app each came from, then Claude's reports and
        // the runner's corrections.
        XCTAssertEqual(all.first?.cause, "CLAIM")
        XCTAssertEqual(all[1...6].map(\.cause), Array(repeating: "OWNER_PICK", count: 6))
        XCTAssertEqual(all[1...6].map(\.client), ["web", "ios", "android", "web", "ios", "android"])
        XCTAssertEqual(all.dropFirst(7).map(\.cause),
                       Array(repeating: ["ENGINE_REPORT", "RUNNER_CORRECTION"], count: 52).flatMap { $0 })
        XCTAssertTrue(all.dropFirst(7).allSatisfy { $0.client == nil })
        XCTAssertEqual(all[1...6].map(\.line), [
            "Mode set to Plan by you on the web", "Mode set to Auto by you on iOS", "Mode set to Accept Edits by you on Android",
            "Mode set to Auto by you on the web", "Mode set to Plan by you on iOS", "Mode set to Auto by you on Android",
        ])
        // Repeated transitions recorded in the same millisecond are still two changes, told apart by their seq.
        XCTAssertGreaterThan(zip(all, all.dropFirst()).filter { $0.at == $1.at }.count, 0, "some changes share their millisecond")
        // Each page's boundary falls inside such a moment: the page continues from the right change by its seq, not its time.
        XCTAssertEqual(pages[0].changes.last?.at, session.permissionModeChanges?.first?.at)
        XCTAssertEqual(pages[1].changes.last?.at, pages[0].changes.first?.at)
        // Among them the same transition twice at one moment: two Default → Auto corrections, or two Auto → Default reports.
        let sameMoment = Dictionary(grouping: all, by: \.at).values.filter { $0.count > 1 }
        XCTAssertTrue(sameMoment.contains { group in
            Dictionary(grouping: group, by: { "\($0.fromMode ?? "")>\($0.toMode)" }).values.contains { $0.count > 1 }
        }, "one moment holds the same transition twice")
    }

    func testEveryChangeIsDrawnOnceAtItsMomentInTheTranscript() throws {
        let session = try detail()
        var held = ModeChangeHistory().adopt(try XCTUnwrap(session.permissionModeChanges), hasMore: true)
        for page in try pages() { held = held.withOlder(before: try XCTUnwrap(held.changes.first?.seq), page) }
        let cards = held.changes.map { DeliveredDecisionCard(kind: .permissionModeChange($0), placement: .at($0.at)) }
        XCTAssertEqual(Set(cards.map(\.id)).count, cards.count, "one row each")
        // One message older than every change: each change's row follows it, in the order the changes were recorded.
        var state = TranscriptState()
        let opened = try XCTUnwrap(held.changes.first?.at)
        state.items = [.user(UserBubble(id: "message", text: "Toggle the flag", ts: opened, pending: false, queued: false))]
        let rows = TranscriptRows.build(state: state, statusCards: [], canPageOlder: false,
                                        showWorkingIndicator: false, decisionCards: cards)
        XCTAssertEqual(rows.map(\.id), ["message"] + cards.map(\.id) + ["transcript-bottom"])
    }
}
