import Foundation
import XCTest
@testable import OrbitKit

/// The approved board (docs/mocks/session-display-three-states) on Mac and iPhone: for every row of the comparison
/// table (scripts/acceptance/session-three-state-check/fixture.json), the state from `phase` alone and the marks from
/// the other facts, as `SessionDisplay` decides them and as each surface that draws a session's state takes them —
/// the header word and subtitle, the task run label and shared Markdown line (`ShareMarkdown.runLabel`), the session
/// link card, the phone row's marks and VoiceOver value. With the facts absent (an older server) both functions
/// answer nil, and LegacyBaselineTests / LegacySurfacesBaselineTests hold the drawing to today's.
/// The list group (Needs you / Working) is the board's group column, except that rows 15, 27 and 29 (work running with
/// no turn: phase RUNNING) are Working, as on web: contracts/session-list-order.fixtures.json (owner 2026-11-26).
final class SessionDisplayTests: XCTestCase {
    private static let root = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    private static let now = Date(timeIntervalSince1970: 1_795_000_000)

    private func payload(row: Int) throws -> (data: Data, newFields: Bool) {
        let url = Self.root.appendingPathComponent("scripts/acceptance/session-three-state-check/fixture.json")
        let rows = try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as! [[String: Any]]
        let r = rows[row - 1]
        return (try JSONSerialization.data(withJSONObject: r["payload"] as! [String: Any]), r["newFields"] as! Bool)
    }

    private func linkCard(_ data: Data) throws -> OrbitLinkCardContent {
        let preview = try JSONDecoder().decode(LinkPreviewSession.self, from: data)
        let ref = OrbitLinkRef(target: OrbitLinkTarget(kind: .session, id: "s"), source: .reference("orbit-session:s"))
        return OrbitLinkCardContent.preview(ref, LinkPreview(kind: .session, id: "s", state: .ok, session: preview,
                                                             task: nil, project: nil, list: nil),
                                            host: "orbitd.io", now: Self.now)
    }

    private func assertDrawn(row: Int, state: SessionDisplayState, marks: [SessionMark], group: String,
                             file: StaticString = #filePath, line: UInt = #line) throws {
        let (data, newFields) = try payload(row: row)
        XCTAssertTrue(newFields, "row \(row) carries the facts", file: file, line: line)
        let s = try JSONDecoder().decode(Session.self, from: data)
        let run = try JSONDecoder().decode(SessionRef.self, from: data)
        // The two functions, from every payload kind a surface holds.
        XCTAssertEqual(SessionDisplay.state(s.displayFacts), state, "state", file: file, line: line)
        XCTAssertEqual(SessionDisplay.marks(s.displayFacts), marks, "marks", file: file, line: line)
        XCTAssertEqual(SessionDisplay.state(run.displayFacts), state, "task run state", file: file, line: line)
        XCTAssertEqual(SessionDisplay.marks(run.displayFacts), marks, "task run marks", file: file, line: line)
        // The session header: the state word leads, then lifecycle and time.
        XCTAssertEqual(SessionHeader.headerWord(for: s, now: Self.now), state.word, "header word", file: file, line: line)
        XCTAssertTrue(SessionHeader.subtitle(for: s, now: Self.now)?.hasPrefix("\(state.word) · Open") == true,
                      "header subtitle", file: file, line: line)
        // The task run label and the shared Markdown Runs line.
        let written = ([state.word] + marks.map(\.word)).joined(separator: " · ")
        XCTAssertEqual(ShareMarkdown.runLabel(run), written, "task run label", file: file, line: line)
        // The session link card: the state glyph and its marks.
        let card = try linkCard(data)
        XCTAssertEqual(card.sessionGlyph, state.glyph, "link card state", file: file, line: line)
        XCTAssertEqual(card.sessionMarks, marks, "link card marks", file: file, line: line)
        // The row: the state icon (shape from phase alone) and the phone row's VoiceOver value.
        XCTAssertEqual(SessionDisplay.spoken(state, marks), ([state.word] + marks.map(\.word)).joined(separator: ", "),
                       file: file, line: line)
        XCTAssertEqual(SessionDisplay.phoneRowMarks(marks).shown, marks, "no fixture case has more than two marks",
                       file: file, line: line)
        // Group membership is the board's group column.
        let section = SessionTimeGrouping.sections([s], now: Self.now).first?.title ?? ""
        XCTAssertEqual(["Needs you", "Working"].contains(section) ? section : "", group, "group", file: file, line: line)
    }

    private func assertDrawsToday(row: Int, file: StaticString = #filePath, line: UInt = #line) throws {
        let (data, newFields) = try payload(row: row)
        XCTAssertFalse(newFields, "row \(row) is the older server's", file: file, line: line)
        let s = try JSONDecoder().decode(Session.self, from: data)
        let run = try JSONDecoder().decode(SessionRef.self, from: data)
        let hit = try JSONDecoder().decode(SessionSearchHit.self, from: data)
        for facts in [s.displayFacts, run.displayFacts, hit.displayFacts] {
            XCTAssertNil(SessionDisplay.state(facts), "no state from an older server", file: file, line: line)
            XCTAssertNil(SessionDisplay.marks(facts), "no marks from an older server", file: file, line: line)
        }
        // Every surface then takes its legacy reading, held to today's by the two baseline files.
        XCTAssertEqual(SessionHeader.headerWord(for: s, now: Self.now), SessionHeader.statusWord(for: s, now: Self.now),
                       file: file, line: line)
        XCTAssertTrue(try linkCard(data).sessionMarks.isEmpty, "no link card marks", file: file, line: line)
    }

    func testRow01_StatusPENDINGQueued_FactsPresent() throws {
        try assertDrawn(row: 1, state: .queued, marks: [], group: "Working")
    }

    func testRow02_StatusPENDINGQueued_FactsAbsent() throws {
        try assertDrawsToday(row: 2)
    }

    func testRow03_StatusRUNNING_FactsPresent() throws {
        try assertDrawn(row: 3, state: .running, marks: [], group: "Working")
    }

    func testRow04_StatusRUNNING_FactsAbsent() throws {
        try assertDrawsToday(row: 4)
    }

    func testRow05_StatusAWAITINGINPUTHeldIdle_FactsPresent() throws {
        try assertDrawn(row: 5, state: .idle, marks: [], group: "")
    }

    func testRow06_StatusAWAITINGINPUTHeldIdle_FactsAbsent() throws {
        try assertDrawsToday(row: 6)
    }

    func testRow07_StatusINTERRUPTEDHeldStoppedTurn_FactsPresent() throws {
        try assertDrawn(row: 7, state: .idle, marks: [.interrupted], group: "")
    }

    func testRow08_StatusINTERRUPTEDHeldStoppedTurn_FactsAbsent() throws {
        try assertDrawsToday(row: 8)
    }

    func testRow09_StatusSUCCEEDEDTaskRunFinished_FactsPresent() throws {
        try assertDrawn(row: 9, state: .idle, marks: [.finished], group: "")
    }

    func testRow10_StatusSUCCEEDEDTaskRunFinished_FactsAbsent() throws {
        try assertDrawsToday(row: 10)
    }

    func testRow11_StatusFAILEDReleasedByAFailedTurn_FactsPresent() throws {
        try assertDrawn(row: 11, state: .idle, marks: [.failed], group: "Needs you")
    }

    func testRow12_StatusFAILEDReleasedByAFailedTurn_FactsAbsent() throws {
        try assertDrawsToday(row: 12)
    }

    func testRow13_StatusCANCELLEDReleasedByEnd_FactsPresent() throws {
        try assertDrawn(row: 13, state: .idle, marks: [.ended], group: "")
    }

    func testRow14_StatusCANCELLEDReleasedByEnd_FactsAbsent() throws {
        try assertDrawsToday(row: 14)
    }

    func testRow15_RunningAJobWithNoTurn_FactsPresent() throws {
        try assertDrawn(row: 15, state: .running, marks: [.background], group: "Working")
    }

    func testRow16_RunningAJobWithNoTurn_FactsAbsent() throws {
        try assertDrawsToday(row: 16)
    }

    func testRow17_WaitingOnAnApproval_FactsPresent() throws {
        try assertDrawn(row: 17, state: .running, marks: [.needsYou], group: "Needs you")
    }

    func testRow18_WaitingOnAnApproval_FactsAbsent() throws {
        try assertDrawsToday(row: 18)
    }

    func testRow19_OnHoldQueuedAccountPaused_FactsPresent() throws {
        try assertDrawn(row: 19, state: .queued, marks: [.onHold], group: "Working")
    }

    func testRow20_OnHoldQueuedAccountPaused_FactsAbsent() throws {
        try assertDrawsToday(row: 20)
    }

    func testRow21_EndedRunnerNeverConfirmed_FactsPresent() throws {
        try assertDrawn(row: 21, state: .idle, marks: [.ended], group: "")
    }

    func testRow22_EndedRunnerNeverConfirmed_FactsAbsent() throws {
        try assertDrawsToday(row: 22)
    }

    func testRow23_OldPlainRowStoredSUCCEEDED_FactsPresent() throws {
        try assertDrawn(row: 23, state: .idle, marks: [.ended], group: "")
    }

    func testRow24_OldPlainRowStoredSUCCEEDED_FactsAbsent() throws {
        try assertDrawsToday(row: 24)
    }

    func testRow25_EndingAfterAnInterruptedTurn_FactsPresent() throws {
        try assertDrawn(row: 25, state: .idle, marks: [.interrupted], group: "")
    }

    func testRow26_EndingAfterAnInterruptedTurn_FactsAbsent() throws {
        try assertDrawsToday(row: 26)
    }

    func testRow27_ParkedEngineStartedItsOwnTurn_FactsPresent() throws {
        try assertDrawn(row: 27, state: .running, marks: [], group: "Working")
    }

    func testRow28_ParkedEngineStartedItsOwnTurn_FactsAbsent() throws {
        try assertDrawsToday(row: 28)
    }

    func testRow29_ParkedSubAgentRunning_FactsPresent() throws {
        try assertDrawn(row: 29, state: .running, marks: [], group: "Working")
    }

    func testRow30_ParkedSubAgentRunning_FactsAbsent() throws {
        try assertDrawsToday(row: 30)
    }

    func testRow31_ParkedWillWakeWatchOrWakeUp_FactsPresent() throws {
        // Idle is Idle: a watch or wake-up to come draws no mark and no row line of its own (the owner, 2026-11-27).
        try assertDrawn(row: 31, state: .idle, marks: [], group: "")
        let s = try JSONDecoder().decode(Session.self, from: try payload(row: 31).0)
        XCTAssertTrue(s.resumesOnItsOwn)
        XCTAssertEqual(SessionLine.make(for: s, live: true), SessionLine(text: "Idle", tone: .preview))
    }

    func testRow32_ParkedWillWakeWatchOrWakeUp_FactsAbsent() throws {
        try assertDrawsToday(row: 32)
    }

    func testRow33_UnknownStatusNoCapabilitiesHeld_FactsPresent() throws {
        try assertDrawn(row: 33, state: .idle, marks: [], group: "")
    }

    func testRow34_UnknownStatusNoCapabilitiesHeld_FactsAbsent() throws {
        try assertDrawsToday(row: 34)
    }

    func testRow35_UnknownStatusNoCapabilitiesReleased_FactsPresent() throws {
        try assertDrawn(row: 35, state: .idle, marks: [.ended], group: "")
    }

    func testRow36_UnknownStatusNoCapabilitiesReleased_FactsAbsent() throws {
        try assertDrawsToday(row: 36)
    }

    // MARK: the rules beyond the fixture

    private func facts(_ phase: SessionPhase = .idle, released: Bool = false, outcome: SessionTurnOutcome? = nil,
                       waitingOn: SessionWaitingOn? = nil, endReason: String? = nil, workFinished: Bool = false,
                       activity: String? = nil, pendingApprovals: Int? = nil,
                       runningBgCount: Int? = nil) -> SessionDisplayFacts {
        SessionDisplayFacts(phase: phase, released: released, lastTurnOutcome: outcome, waitingOn: waitingOn,
                            endReason: endReason, workFinished: workFinished, activity: activity,
                            pendingApprovals: pendingApprovals, runningBgCount: runningBgCount)
    }

    /// Owner 2026-11-25: no Disconnected mark. A released failure is Failed whatever its error says; nothing reads
    /// the error text.
    func testAReleasedFailureWhoseRunnerWentOfflineIsFailedLikeAnyOther() throws {
        let data = try JSONSerialization.data(withJSONObject: [
            "id": "s", "title": "t", "status": "FAILED", "phase": "IDLE", "released": true,
            "lastTurnOutcome": "FAILED", "workFinished": false, "error": "runner offline"])
        let s = try JSONDecoder().decode(Session.self, from: data)
        XCTAssertEqual(SessionDisplay.state(s.displayFacts), .idle)
        XCTAssertEqual(SessionDisplay.marks(s.displayFacts), [.failed])
        XCTAssertFalse(SessionMark.allCases.map(\.word).contains("Disconnected"))
    }

    func testAReleasedFailureWithARetryArmedIsRetryingNotFailed() {
        XCTAssertEqual(SessionDisplay.marks(facts(released: true, outcome: .failed, waitingOn: .wake)), [.retrying])
    }

    func testAFailureWithAnEndAskedForIsEnded() {
        XCTAssertEqual(SessionDisplay.marks(facts(released: true, outcome: .failed, endReason: "ended")), [.ended])
    }

    func testPendingApprovalsAloneMakeNeedsYou() {
        XCTAssertEqual(SessionDisplay.marks(facts(.running, activity: "TURN", pendingApprovals: 2)), [.needsYou])
    }

    func testAProcessLeftUpUnderAnIdleSessionIsBackground() {
        XCTAssertEqual(SessionDisplay.marks(facts(runningBgCount: 1)), [.background])
        XCTAssertEqual(SessionDisplay.marks(facts(released: true, runningBgCount: 1)), [.ended])
    }

    func testMarksAreDrawnInTheBoardsOrderAndAPhoneRowShowsTwoThenACount() {
        let marks = SessionDisplay.marks(facts(outcome: .interrupted, waitingOn: .person, activity: "BACKGROUND_JOB"))!
        XCTAssertEqual(marks, [.needsYou, .interrupted, .background])
        let row = SessionDisplay.phoneRowMarks(marks)
        XCTAssertEqual(row.shown, [.needsYou, .interrupted])
        XCTAssertEqual(row.more, "+1")
        XCTAssertNil(SessionDisplay.phoneRowMarks([.ended]).more)
    }

    func testOnlyPhaseAndReleasedTogetherCountAsTheFacts() {
        XCTAssertNil(SessionDisplay.state(SessionDisplayFacts(phase: .idle, released: nil)))
        XCTAssertNil(SessionDisplay.state(SessionDisplayFacts(phase: nil, released: true)))
        XCTAssertEqual(SessionDisplay.state(SessionDisplayFacts(phase: .pending, released: false)), .queued)
    }

    func testStateIconsAreAClockTheSpinnerAndAnEmptyCircleAndOnlyRunningIsColoured() {
        XCTAssertEqual(SessionDisplayState.queued.glyph, SessionStatusGlyph(shape: .symbol("clock"), tone: .neutral, label: "Queued"))
        XCTAssertEqual(SessionDisplayState.running.glyph, SessionStatusGlyph(shape: .spinner, tone: .brand, label: "Running"))
        XCTAssertEqual(SessionDisplayState.idle.glyph, SessionStatusGlyph(shape: .symbol("circle"), tone: .neutral, label: "Idle"))
        XCTAssertEqual(SessionMark.allCases.filter { $0.tone != .neutral }, [.needsYou, .failed, .finished])
        XCTAssertEqual(SessionMark.needsYou.tone, .warning)
        XCTAssertEqual(SessionMark.failed.tone, .error)
        XCTAssertEqual(SessionMark.finished.tone, .success)
    }

    /// The words are the board's (`capture/rules.mjs`, which web, Mac, iPhone and Android all port), minus
    /// Disconnected; the state words are `STATES`, the marks `MARKS`, each with its tone.
    func testEveryWordAndToneIsTheBoardsRulesFile() throws {
        let rules = try String(contentsOf: Self.root
            .appendingPathComponent("docs/mocks/session-display-three-states/capture/rules.mjs"), encoding: .utf8)
        for (key, state) in [("PENDING", SessionDisplayState.queued), ("RUNNING", .running), ("IDLE", .idle)] {
            XCTAssertTrue(rules.contains("\(key): { word: '\(state.word)'"), "STATES.\(key) says \(state.word)")
        }
        let keys: [SessionMark: String] = [.needsYou: "NEEDS_YOU", .failed: "FAILED", .retrying: "RETRYING",
                                           .onHold: "ON_HOLD", .interrupted: "INTERRUPTED", .background: "BACKGROUND",
                                           .willResume: "WILL_RESUME", .finished: "FINISHED", .ended: "ENDED"]
        let tones: [SessionStatusGlyph.Tone: String] = [.warning: "amber", .error: "red", .success: "green", .neutral: "grey"]
        for mark in SessionMark.allCases {
            let key = keys[mark]!
            XCTAssertTrue(rules.contains("\(key): { word: '\(mark.word)'"), "MARKS.\(key) says \(mark.word)")
            XCTAssertTrue(rules.contains("\(key): { word: '\(mark.word)', icon: '")
                          && rules.components(separatedBy: "\(key): { word: '\(mark.word)', icon: '")[1]
                            .prefix(while: { $0 != "\n" }).contains("tone: '\(tones[mark.tone]!)'"), "MARKS.\(key) tone")
        }
        // The drawing order is the order MARKS declares them in.
        let marksBlock = rules.components(separatedBy: "export const MARKS = {")[1].components(separatedBy: "};")[0]
        let declared = marksBlock.components(separatedBy: "\n")
            .compactMap { line -> String? in
                let t = line.trimmingCharacters(in: .whitespaces)
                guard let colon = t.firstIndex(of: ":"), t[colon...].hasPrefix(": { word:") else { return nil }
                return String(t[..<colon])
            }
            .filter { $0 != "DISCONNECTED" }
        XCTAssertEqual(declared, SessionMark.allCases.map { keys[$0]! })
    }

    /// The web's two functions (src/web/src/lib/sessionDisplay.ts) say the same words, give each mark the same tone,
    /// declare the marks in the same order and join them the same way, so a shared Markdown line reads alike.
    func testTheWebsDisplayFunctionsSayTheSameWords() throws {
        let web = try String(contentsOf: Self.root.appendingPathComponent("src/web/src/lib/sessionDisplay.ts"), encoding: .utf8)
        for (key, state) in [("PENDING", SessionDisplayState.queued), ("RUNNING", .running), ("IDLE", .idle)] {
            XCTAssertTrue(web.contains("\(key): { word: '\(state.word)'"), "web says \(state.word) for \(key)")
        }
        let keys: [SessionMark: String] = [.needsYou: "NEEDS_YOU", .failed: "FAILED", .retrying: "RETRYING",
                                           .onHold: "ON_HOLD", .interrupted: "INTERRUPTED", .background: "BACKGROUND",
                                           .willResume: "WILL_RESUME", .finished: "FINISHED", .ended: "ENDED"]
        let tones: [SessionStatusGlyph.Tone: String] = [.warning: "amber", .error: "red", .success: "green", .neutral: "grey"]
        for mark in SessionMark.allCases {
            XCTAssertTrue(web.contains("\(keys[mark]!): { word: '\(mark.word)', tone: '\(tones[mark.tone]!)' }"),
                          "web SESSION_MARKS.\(keys[mark]!)")
        }
        let block = web.components(separatedBy: "export const SESSION_MARKS")[1].components(separatedBy: "};")[0]
        let declared = block.components(separatedBy: "\n").compactMap { line -> String? in
            let t = line.trimmingCharacters(in: .whitespaces)
            guard let colon = t.firstIndex(of: ":"), t[colon...].hasPrefix(": { word:") else { return nil }
            return String(t[..<colon])
        }
        XCTAssertEqual(declared, SessionMark.allCases.map { keys[$0]! })
        XCTAssertTrue(web.contains("return [state.word, ...marks.map((m) => SESSION_MARKS[m].word)].join(' · ');"))
        XCTAssertEqual(SessionDisplay.written(.idle, [.finished]), "Idle · Finished")
    }
}
