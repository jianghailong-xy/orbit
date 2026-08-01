import XCTest
@testable import OrbitKit

final class RecentsLogicTests: XCTestCase {

    private func session(_ json: String) -> Session {
        try! JSONDecoder().decode(Session.self, from: Data(json.utf8))
    }

    func testOrdersByLastActivityNewestFirst() {
        let sessions = [
            session(#"{"id":"a","status":"AWAITING_INPUT","lastTurnAt":"2026-07-07T10:00:00.000Z"}"#),
            session(#"{"id":"b","status":"RUNNING","lastTurnAt":"2026-07-07T12:00:00.000Z"}"#),
            session(#"{"id":"c","status":"PENDING","lastTurnAt":"2026-07-07T11:00:00.000Z"}"#),
        ]
        XCTAssertEqual(RecentsLogic.recent(sessions).map(\.id), ["b", "c", "a"])
    }

    func testFallsBackUpdatedThenCreated() {
        // `a` has only createdAt (never ran), `b` only updatedAt, `c` a fresh lastTurnAt. Newest
        // wins per row regardless of which field supplied it: c (12:00) > b (11:00) > a (09:00).
        let sessions = [
            session(#"{"id":"a","status":"PENDING","createdAt":"2026-07-07T09:00:00.000Z"}"#),
            session(#"{"id":"b","status":"AWAITING_INPUT","updatedAt":"2026-07-07T11:00:00.000Z"}"#),
            session(#"{"id":"c","status":"RUNNING","lastTurnAt":"2026-07-07T12:00:00.000Z"}"#),
        ]
        XCTAssertEqual(RecentsLogic.recent(sessions).map(\.id), ["c", "b", "a"])
    }

    func testIncludesLegacySystemSource() {
        let sessions = [
            session(#"{"id":"user","status":"RUNNING","source":"user","lastTurnAt":"2026-07-07T10:00:00.000Z"}"#),
            session(#"{"id":"sys","status":"RUNNING","source":"system","lastTurnAt":"2026-07-07T12:00:00.000Z"}"#),
        ]
        XCTAssertEqual(RecentsLogic.recent(sessions).map(\.id), ["sys", "user"])
    }

    func testRespectsLimit() {
        let sessions = (0..<10).map {
            session(#"{"id":"\#($0)","status":"RUNNING","lastTurnAt":"2026-07-07T1\#($0):00:00.000Z"}"#)
        }
        XCTAssertEqual(RecentsLogic.recent(sessions, limit: 3).count, 3)
        XCTAssertEqual(RecentsLogic.recent(sessions, limit: 0).count, 0)
        XCTAssertEqual(RecentsLogic.recent([]).count, 0)
    }

    func testMissingTimestampSinksButStillIncluded() {
        let sessions = [
            session(#"{"id":"dated","status":"RUNNING","lastTurnAt":"2026-07-07T10:00:00.000Z"}"#),
            session(#"{"id":"undated","status":"PENDING"}"#),
        ]
        XCTAssertEqual(RecentsLogic.recent(sessions).map(\.id), ["dated", "undated"])
    }
}
