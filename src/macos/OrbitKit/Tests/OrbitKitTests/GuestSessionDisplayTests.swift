import Foundation
import XCTest
@testable import OrbitKit

/// Shared with me and the guest view against web, on the cross-client check's server-built `guestRow` and `sharedHead`
/// payloads (23 cases, scripts/acceptance/session-three-state-check/guest-payloads.apple.json; `web` is what web's own
/// `sessionDisplayState` / `sessionMarks` / `sharedWithMeStateText` answer for each, `legacy` what these surfaces drew
/// before they read the facts, with the six facts removed from the payload — an older server).
final class GuestSessionDisplayTests: XCTestCase {
    private static let root = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    private static let facts = ["phase", "released", "lastTurnOutcome", "waitingOn", "endReason", "workFinished"]

    private func rows() throws -> [[String: Any]] {
        let url = Self.root.appendingPathComponent("scripts/acceptance/session-three-state-check/guest-payloads.apple.json")
        return try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as! [[String: Any]]
    }

    private func row(_ name: String, _ kind: String) throws -> [String: Any] {
        try XCTUnwrap(rows().first { $0["name"] as? String == name && $0["kind"] as? String == kind }, "\(name) \(kind)")
    }

    /// Every way the app reads the payload: the Shared with me row, or the guest view's root, `events?after=` answer
    /// and stream `head` frame. The row also answers its subtitle.
    private func decode(_ payload: [String: Any], _ kind: String) throws -> (states: [GuestSessionState], subtitle: String?) {
        let data = try JSONSerialization.data(withJSONObject: payload)
        let d = JSONDecoder()
        if kind == "guestRow" {
            let summary = try d.decode(GuestSessionSummary.self, from: data)
            return ([summary.state], SharedWithMe.subtitle(summary))
        }
        return ([try d.decode(GuestSession.self, from: data).state,
                 try d.decode(GuestSessionNow.self, from: data).state,
                 try d.decode(GuestSessionHead.self, from: data).state], nil)
    }

    private func assertMatchesWeb(_ name: String, file: StaticString = #filePath, line: UInt = #line) throws {
        for kind in ["guestRow", "sharedHead"] {
            let r = try row(name, kind)
            let web = r["web"] as! [String: Any]
            let word = web["state"] as! String
            let marks = web["marks"] as! [String]
            let shown = web["line"] as! String
            let icon: [String: SessionStatusGlyph.Shape] = ["clock": .symbol("clock"), "spinner": .spinner,
                                                            "message": .symbol("message")]
            let (states, subtitle) = try decode(r["payload"] as! [String: Any], kind)
            for s in states {
                let state = try XCTUnwrap(SessionDisplay.state(s.displayFacts), "\(kind) state", file: file, line: line)
                XCTAssertEqual(state.word, word, "\(kind) state word", file: file, line: line)
                XCTAssertEqual(state.glyph.shape, icon[web["icon"] as! String], "\(kind) icon", file: file, line: line)
                XCTAssertEqual(s.word, word, "\(kind) word", file: file, line: line)
                XCTAssertEqual(SessionDisplay.marks(s.displayFacts)?.map(\.word), marks, "\(kind) marks", file: file, line: line)
                XCTAssertEqual(s.completed, web["completed"] as! Bool, "\(kind) completed", file: file, line: line)
                XCTAssertEqual(s.line, shown, "\(kind) line", file: file, line: line)
            }
            if let subtitle {
                XCTAssertEqual(subtitle, "payloads owner \u{00B7} \(shown)", "Shared with me row", file: file, line: line)
            }
        }
    }

    func testTheFixtureHoldsThe23CasesOfBothKinds() throws {
        let all = try rows()
        XCTAssertEqual(all.count, 46)
        XCTAssertEqual(Set(all.map { $0["name"] as! String }).count, 23)
        XCTAssertEqual(all.filter { $0["kind"] as? String == "guestRow" }.count, 23)
    }

    func testCase01_PENDING() throws { try assertMatchesWeb("PENDING") }
    func testCase02_RUNNING() throws { try assertMatchesWeb("RUNNING") }
    func testCase03_AWAITINGINPUT() throws { try assertMatchesWeb("AWAITING_INPUT") }
    func testCase04_INTERRUPTED() throws { try assertMatchesWeb("INTERRUPTED") }
    func testCase05_SUCCEEDED() throws { try assertMatchesWeb("SUCCEEDED") }
    func testCase06_FAILED() throws { try assertMatchesWeb("FAILED") }
    func testCase07_CANCELLED() throws { try assertMatchesWeb("CANCELLED") }
    func testCase08_JobRunning() throws { try assertMatchesWeb("job running") }
    func testCase09_WaitingOnAnApproval() throws { try assertMatchesWeb("waiting on an approval") }
    func testCase10_WatchArmed() throws { try assertMatchesWeb("watch armed") }
    func testCase11_PausedAccount() throws { try assertMatchesWeb("paused account") }
    func testCase12_SettledLanding() throws { try assertMatchesWeb("settled landing") }
    func testCase13_EndedRunnerNeverConfirmed() throws { try assertMatchesWeb("ended, runner never confirmed") }
    func testCase14_OldPlainRowStoredSUCCEEDED() throws { try assertMatchesWeb("old plain row stored SUCCEEDED") }
    func testCase15_EndingAfterAnInterruptedTurn() throws { try assertMatchesWeb("ending after an interrupted turn") }
    func testCase16_ParkedEngineStartedItsOwnTurn() throws { try assertMatchesWeb("parked, engine started its own turn") }
    func testCase17_ParkedSubAgentRunning() throws { try assertMatchesWeb("parked, sub-agent running") }
    func testCase18_ParkedBackgroundProcessLeftUp() throws { try assertMatchesWeb("parked, background process left up") }
    func testCase19_ParkedRetryArmed() throws { try assertMatchesWeb("parked, retry armed") }
    func testCase20_FailedRetryArmed() throws { try assertMatchesWeb("failed, retry armed") }
    func testCase21_FailedRunnerOffline() throws { try assertMatchesWeb("failed, runner offline") }
    func testCase22_ApprovalBesideABackgroundJob() throws { try assertMatchesWeb("approval beside a background job") }
    func testCase23_InterruptedAProcessUpRetryArmed() throws { try assertMatchesWeb("interrupted, a process up, retry armed") }

    func testWithTheFactsAbsentEveryCaseDrawsWhatItDrew() throws {
        for r in try rows() {
            let name = r["name"] as! String, kind = r["kind"] as! String
            let legacy = r["legacy"] as! [String: Any]
            var payload = r["payload"] as! [String: Any]
            for fact in Self.facts { payload[fact] = nil }
            let (states, subtitle) = try decode(payload, kind)
            for s in states {
                XCTAssertNil(SessionDisplay.state(s.displayFacts), "\(name) \(kind)")
                XCTAssertNil(SessionDisplay.marks(s.displayFacts), "\(name) \(kind)")
                XCTAssertEqual(s.word, legacy["word"] as? String, "\(name) \(kind) word")
                XCTAssertEqual(s.tone.rawValue, legacy["tone"] as? String, "\(name) \(kind) tone")
                XCTAssertEqual(s.line, legacy["word"] as? String, "\(name) \(kind) line")
            }
            if let subtitle {
                XCTAssertEqual(subtitle, "payloads owner \u{00B7} \(legacy["word"] as! String)", "\(name) Shared with me row")
            }
        }
    }

    /// A filed session says Completed after its state and marks, as web's guest header and Shared with me do
    /// (no server case is filed, so one is re-filed here); from an older server it still replaces the word.
    func testAFiledSessionSaysCompletedAfterItsStateAndMarks() throws {
        var payload = try row("SUCCEEDED", "guestRow")["payload"] as! [String: Any]
        payload["lifecycleState"] = "COMPLETED"
        let filed = try decode(payload, "guestRow")
        XCTAssertEqual(filed.states.first?.word, "Idle")
        XCTAssertEqual(filed.subtitle, "payloads owner \u{00B7} Idle \u{00B7} Completed")
        for fact in Self.facts { payload[fact] = nil }
        XCTAssertEqual(try decode(payload, "guestRow").subtitle, "payloads owner \u{00B7} Completed")
    }

    /// The two inputs the guest payloads do not send yet reach the marks and row icons when they do, as web reads them.
    func testBackgroundAndApprovalCountsReachTheMarksWhenSent() throws {
        for kind in ["guestRow", "sharedHead"] {
            var payload = try row("AWAITING_INPUT", kind)["payload"] as! [String: Any]
            payload["runningBgCount"] = 1
            payload["pendingApprovals"] = 1
            for s in try decode(payload, kind).states {
                XCTAssertEqual(SessionDisplay.marks(s.displayFacts), [.needsYou], kind)
                XCTAssertEqual(SessionDisplay.rowIcons(s.displayFacts), [.background], kind)
            }
        }
    }
}
