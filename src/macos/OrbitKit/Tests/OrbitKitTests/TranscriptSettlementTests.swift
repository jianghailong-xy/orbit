import XCTest
@testable import OrbitKit

/// Once the conversation moves past a sign-in failure its card is history (web parity): only the
/// latest open one stays a remedy, and the account switches around it mute.
final class TranscriptSettlementTests: XCTestCase {

    private let expired = "Failed to authenticate: OAuth session expired and could not be refreshed"
    private let signedOut = "Failed to authenticate: Claude Code is installed on this runner but not signed in"

    private func user(_ seq: Int) -> RunEvent {
        RunEvent(seq: seq, type: .user, payload: .object(["text": .string("deploy")]))
    }
    private func assistant(_ seq: Int, _ text: String) -> RunEvent {
        RunEvent(seq: seq, type: .assistant, payload: .object(["text": .string(text)]))
    }
    private func switched(_ seq: Int) -> RunEvent {
        RunEvent(seq: seq, type: .system, payload: .object([
            "subtype": .string("init"),
            "notice": .string("Switched to B — A is signed out"),
            "noticeKind": .string("pool-member-switched"),
        ]))
    }

    private func reduce(_ events: [RunEvent]) -> TranscriptReducer {
        var r = TranscriptReducer()
        for ev in events { r.apply(ev) }
        return r
    }

    private func authIDs(_ r: TranscriptReducer) -> [String] {
        r.state.items.compactMap { if case .authError(let id, _) = $0 { return id }; return nil }
    }

    private func switchIDs(_ r: TranscriptReducer) -> [String] {
        r.state.items.compactMap {
            if case .notice(let id, _, let accountSwitch) = $0, accountSwitch { return id }
            return nil
        }
    }

    func testOnlyTheLatestOpenFailureStaysARemedy() {
        let r = reduce([user(1), assistant(2, expired), user(3), assistant(4, signedOut)])
        let ids = authIDs(r)
        let s = TranscriptSettlement(r.state.items)

        XCTAssertEqual(ids.count, 2)
        XCTAssertEqual(s.auth[ids[0]], .superseded)
        XCTAssertNil(s.auth[ids[1]])
    }

    func testWorkAfterAFailureResolvesItAndMutesTheSwitches() {
        let r = reduce([
            user(1), switched(2), assistant(3, expired),
            user(4), switched(5), assistant(6, signedOut),
            user(7), switched(8), assistant(9, "Deployed."),
        ])
        let ids = authIDs(r)
        let s = TranscriptSettlement(r.state.items)

        XCTAssertEqual(ids.map { s.auth[$0] }, [.superseded, .resolved])
        XCTAssertEqual(Set(switchIDs(r)), s.settledNotices)
        XCTAssertEqual(s.settledNotices.count, 3)
    }

    func testTheSwitchBesideALiveCardKeepsItsTone() {
        let r = reduce([user(1), switched(2), assistant(3, expired)])
        let s = TranscriptSettlement(r.state.items)

        XCTAssertTrue(s.auth.isEmpty)
        XCTAssertTrue(s.settledNotices.isEmpty)
    }
}
