import Foundation
import XCTest
@testable import OrbitKit

/// What the owner-confirmation card says confirming sets off, and how much its folded criteria row
/// says is behind it — proved against `src/shared/src/owner-confirmation-if-confirmed.fixture.json`,
/// the same cases the web card's `OwnerConfirmationCard.test.tsx` proves `ifConfirmedRows` and
/// `criteriaItemsLabel` against. So the browser, the Mac and the phone say one thing about one
/// confirmation, sentence for sentence, rather than three things that started out the same.
///
/// A failure — never an `XCTSkip` — when the fixture goes missing: a check that quietly opts out
/// reports green on exactly the day the thing it watches went away.
final class OwnerConfirmationIfConfirmedTests: XCTestCase {

    private static let fixturePath = "src/shared/src/owner-confirmation-if-confirmed.fixture.json"

    private struct Missing: Error, CustomStringConvertible {
        var description: String {
            "\(OwnerConfirmationIfConfirmedTests.fixturePath) was not found above this test file. "
                + "Both clients are proved against it; if it moved, move this check with it."
        }
    }

    private struct Fixture: Decodable {
        struct RowsCase: Decodable {
            let `case`: String
            let ifConfirmed: OwnerConfirmationIfConfirmed?
            let rows: [OwnerConfirmations.IfConfirmedRow]
        }

        struct CriteriaCase: Decodable {
            let `case`: String
            let acceptanceCriteria: String?
            let label: String?
        }

        let rows: [RowsCase]
        let criteria: [CriteriaCase]
    }

    private func fixture() throws -> Fixture {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<12 {
            let candidate = dir.appendingPathComponent(Self.fixturePath)
            if FileManager.default.fileExists(atPath: candidate.path) {
                return try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: candidate))
            }
            dir = dir.deletingLastPathComponent()
        }
        throw Missing()
    }

    func testTheRowsAreTheFixturesInTheirOrder() throws {
        let cases = try fixture().rows
        XCTAssertGreaterThan(cases.count, 10)
        for each in cases {
            XCTAssertEqual(OwnerConfirmations.ifConfirmedRows(each.ifConfirmed), each.rows, each.case)
        }
    }

    func testTheFoldedCriteriaRowCountsWhatTheFixtureCounts() throws {
        let cases = try fixture().criteria
        XCTAssertGreaterThan(cases.count, 8)
        for each in cases {
            XCTAssertEqual(OwnerConfirmations.criteriaItemsLabel(each.acceptanceCriteria), each.label,
                           each.case)
        }
    }

    // MARK: the read, as this client takes it

    private func decodeView(_ json: String) throws -> OwnerConfirmationView {
        try JSONDecoder().decode(OwnerConfirmationView.self, from: Data(json.utf8))
    }

    private func view(ifConfirmed: String?) -> String {
        let tail = ifConfirmed.map { #","ifConfirmed":\#($0)"# } ?? ""
        return #"{"taskId":"t1","title":"T","status":"OPEN","projectId":null,"#
            + #""completionCriterion":"OWNER_CONFIRMED","acceptanceCriteria":null,"#
            + #""waiting":null,"decisions":[]\#(tail)}"#
    }

    func testTheReadCarriesWhatConfirmingSetsOff() throws {
        let read = try decodeView(view(ifConfirmed: """
            {"startsTasks":[{"id":"t2","title":"Next","starts":"WHEN_SLOT_FREES"}],
             "startsAfterLanding":true,
             "branch":{"name":"orbit/x","linesAdded":3,"linesRemoved":1,"files":1,"onMain":"NO"},
             "landing":"AUTO_MAIN",
             "endsSession":{"sessionId":"s1","runningBgJobs":2}}
            """))
        XCTAssertEqual(read.ifConfirmed, OwnerConfirmationIfConfirmed(
            startsTasks: [OwnerConfirmationStartsTask(id: "t2", title: "Next", starts: .whenSlotFrees)],
            startsAfterLanding: true,
            branch: OwnerConfirmationBranch(name: "orbit/x", linesAdded: 3, linesRemoved: 1, files: 1,
                                            onMain: .no),
            landing: .autoMain,
            endsSession: OwnerConfirmationEndsSession(sessionId: "s1", runningBgJobs: 2)))
    }

    func testAnOlderServerOrNothingWaitingIsNoBlock() throws {
        XCTAssertNil(try decodeView(view(ifConfirmed: nil)).ifConfirmed)
        XCTAssertNil(try decodeView(view(ifConfirmed: "null")).ifConfirmed)
        XCTAssertEqual(OwnerConfirmations.ifConfirmedRows(nil), [])
    }

    /// A value this client does not know costs its own item and never the card: the read still
    /// decodes, so the report and the buttons are still there.
    func testAnItemThisClientCannotReadIsLeftOutAndTheCardStays() throws {
        let read = try decodeView(view(ifConfirmed: """
            {"startsTasks":[{"id":"t2","title":"Next","starts":"SOMEDAY"}],
             "startsAfterLanding":false,
             "branch":{"name":"orbit/x","linesAdded":3,"linesRemoved":1,"files":1,"onMain":"MAYBE"},
             "landing":"BY_CARRIER_PIGEON",
             "endsSession":{"sessionId":"s1","runningBgJobs":0}}
            """))
        XCTAssertNil(read.ifConfirmed?.startsTasks)
        XCTAssertNil(read.ifConfirmed?.branch)
        XCTAssertNil(read.ifConfirmed?.landing)
        XCTAssertEqual(read.ifConfirmed?.startsAfterLanding, false)
        XCTAssertEqual(OwnerConfirmations.ifConfirmedRows(read.ifConfirmed),
                       [OwnerConfirmations.IfConfirmedRow(kind: .endsSession,
                                                          lead: OwnerConfirmations.endsSession)])

        let garbled = try decodeView(view(ifConfirmed: #""not an object""#))
        XCTAssertEqual(OwnerConfirmations.ifConfirmedRows(garbled.ifConfirmed), [])
    }
}
