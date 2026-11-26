import Foundation
import XCTest
@testable import OrbitKit

/// A scheduled run's session when the run did not get under way in it (board docs/mocks/scheduled-run-not-started
/// ②③④): the words are the web's (CLAUDE.md §5), the three states are the web's `scheduleRunStatusKind`.
final class ScheduleRunStatusTests: XCTestCase {
    private func root() throws -> URL {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<12 {
            if FileManager.default.fileExists(atPath: dir.appendingPathComponent("contracts/schedule.contract.json").path) {
                return dir
            }
            dir = dir.deletingLastPathComponent()
        }
        struct Missing: Error, CustomStringConvertible {
            var description: String { "contracts/schedule.contract.json was not found above this test file" }
        }
        throw Missing()
    }

    private func flatten(_ value: JSONValue, _ path: String, into out: inout [String: String]) {
        switch value {
        case .string(let s): out[path] = s
        case .object(let o): for (k, v) in o { flatten(v, path.isEmpty ? k : "\(path).\(k)", into: &out) }
        default: XCTFail("\(path) is not a sentence")
        }
    }

    // MARK: copy parity with web

    func testEverySentenceOfTheContractIsHereWordForWord() throws {
        let contract = try JSONDecoder().decode(
            JSONValue.self, from: Data(contentsOf: try root().appendingPathComponent("contracts/schedule.contract.json")))
        let copy = try XCTUnwrap(contract["runStatusCopy"], "the contract has no runStatusCopy")
        var flat: [String: String] = [:]
        flatten(copy, "", into: &flat)
        XCTAssertEqual(flat.count, 23)
        for (path, sentence) in flat.sorted(by: { $0.key < $1.key }) {
            XCTAssertEqual(ScheduleRunStatusCopy.contract[path], sentence, "runStatusCopy.\(path)")
        }
        for path in ScheduleRunStatusCopy.contract.keys.sorted() where flat[path] == nil {
            XCTFail("ScheduleRunStatusCopy holds \(path), which the contract no longer has")
        }
    }

    /// The web source itself, not only the contract: SCHEDULE_RUN_STATUS_COPY declares each sentence.
    func testTheWebSourceDeclaresEverySentence() throws {
        let web = try String(contentsOf: try root().appendingPathComponent("src/shared/src/schedule.ts"), encoding: .utf8)
        let start = try XCTUnwrap(web.range(of: "export const SCHEDULE_RUN_STATUS_COPY"))
        let end = try XCTUnwrap(web.range(of: "} as const;", range: start.upperBound..<web.endIndex))
        let block = String(web[start.lowerBound..<end.upperBound])
        for (path, sentence) in ScheduleRunStatusCopy.contract.sorted(by: { $0.key < $1.key }) {
            let key = String(path.split(separator: ".").last!)
            let quoted = sentence.contains("'") ? "\"\(sentence)\"" : "'\(sentence)'"
            XCTAssertTrue(block.contains("\(key): \(quoted)"), "web no longer declares \(path) as \(sentence)")
        }
    }

    func testTheButtonsAreTheBoards() {
        XCTAssertEqual([ScheduleRunStatusCopy.Actions.runNow, ScheduleRunStatusCopy.Actions.openSchedule,
                        ScheduleRunStatusCopy.Actions.cancelRun, ScheduleRunStatusCopy.Actions.openRun],
                       ["Run now", "Open schedule", "Cancel run", "Open the run →"])
    }

    func testTheQueuedSentenceIsTheQueuedMessageSaidOfTheRun() throws {
        let web = try String(contentsOf: try root().appendingPathComponent("src/web/src/lib/queuedCapacity.ts"), encoding: .utf8)
        XCTAssertTrue(web.contains(".replace('This message is sent', 'The run starts')"))
    }

    // MARK: the three states (board ②③④)

    private let zone = "UTC"
    private let schedule = "sch"
    private func iso(_ day: Int, _ time: String) -> String { "2026-11-\(day)T\(time):00Z" }
    private let times = ["03:32", "03:43", "03:58", "04:23", "05:34"]

    private func tries(reached: Int? = nil, count: Int = 5) -> [ScheduleRunTry] {
        (0..<count).map {
            ScheduleRunTry(sessionId: "s\($0 + 1)", startedAt: iso(14, times[$0]), claimed: true, reachedEngine: reached == $0 + 1)
        }
    }

    private func run(state: String, session: String, reason: String? = nil) -> ScheduleRunView {
        ScheduleRunView(id: "r", scheduleId: schedule, plannedAt: iso(14, "03:32"), state: state, sessionId: session,
                        failureReason: reason)
    }

    func testDidntRunAfterFiveTriesHPCDidNotPickUp() throws {
        let status = ScheduleRunSessionStatus(tries: tries(), thisTry: 5, gaveUpAt: iso(14, "05:44"),
                                              nextDueAt: iso(15, "06:00"))
        let r = run(state: "MISSED", session: "s5", reason: "RUNNER_UNAVAILABLE")
        XCTAssertEqual(ScheduleRunStatus.kind(run: r, status: status), .didntRun)
        let now = try XCTUnwrap(ScheduleDisplay.parse(iso(14, "08:07")))
        let text = ScheduleRunStatus.didntRunText(run: r, status: status, runner: "HPC", now: now, timezone: zone)
        XCTAssertEqual(text.title, "Didn't run")
        XCTAssertEqual(text.reason, "HPC didn't pick it up on any of 5 tries, so the run never started. Nothing was changed.")
        XCTAssertEqual(text.tries, ["03:32", "03:43", "03:58", "04:23", "05:34"])
        XCTAssertEqual(text.gaveUp, "gave up 05:44")
        XCTAssertEqual(text.next, "Next run: tomorrow 06:00")
        XCTAssertEqual(ScheduleRunStatus.stripText(plannedAt: r.plannedAt, accessLevel: "LAND", timezone: zone),
                       "Scheduled run · planned 03:32 · access Edit and land on main")
    }

    func testDidntRunSaysItsOwnReasonPerFailure() {
        let said = { (reason: String?, tries: Int) in
            ScheduleRunStatus.didntRunReason(failureReason: reason, tries: tries, runner: "HPC")
        }
        XCTAssertEqual(said("RUNNER_UNAVAILABLE", 1), "HPC didn't pick it up, so the run never started. Nothing was changed.")
        XCTAssertEqual(said("RUNNER_FULL", 3), "HPC was full the whole time, so the run never started. Nothing was changed.")
        XCTAssertEqual(said("ENGINE_CRASHED_BEFORE_START", 2),
                       "HPC couldn't start the engine on any of 2 tries, so the run never started. Nothing was changed.")
        XCTAssertEqual(said("ENGINE_CRASHED_BEFORE_START", 1),
                       "HPC couldn't start the engine, so the run never started. Nothing was changed.")
        XCTAssertEqual(said("QUOTA", 1), "The engine's usage limit was reached, so the run never started. Nothing was changed.")
        XCTAssertEqual(said("CANCELLED_BY_OWNER", 1), "You cancelled the run before it started. Nothing was changed.")
    }

    func testQueuedRunnerFull() throws {
        let gate = ScheduleRunQueueGate(queuedReason: "runner_at_capacity", queuedActive: 20, queuedLimit: 20,
                                        queuedHeldByJobs: 0, since: iso(14, "11:18"), deadline: iso(15, "03:32"))
        let status = ScheduleRunSessionStatus(tries: tries(count: 1), thisTry: 1, nextDueAt: iso(15, "06:00"), queue: gate)
        let r = run(state: "RUNNING", session: "s1")
        XCTAssertEqual(ScheduleRunStatus.kind(run: r, status: status), .queuedFull)
        let now = try XCTUnwrap(ScheduleDisplay.parse(iso(14, "12:30")))
        let text = ScheduleRunStatus.queuedText(gate: gate, machine: "HPC", now: now, timezone: zone)
        XCTAssertEqual(text.title, "Queued · runner full")
        XCTAssertEqual(text.body, "HPC is running 20 of 20 sessions. The run starts as soon as one finishes.")
        XCTAssertEqual(text.waited, "Waiting 1 h 12 min · gives up at 03:32 tomorrow")
    }

    func testQueuedRunAndBatchFullSayTheirOwnTag() throws {
        let now = try XCTUnwrap(ScheduleDisplay.parse(iso(14, "12:30")))
        let tree = ScheduleRunQueueGate(queuedReason: "tree_at_capacity", queuedActive: 3, queuedLimit: 3, since: iso(14, "12:29"),
                                        deadline: iso(14, "20:00"))
        let text = ScheduleRunStatus.queuedText(gate: tree, machine: "HPC", now: now, timezone: zone)
        XCTAssertEqual(text.title, "Queued · run full")
        XCTAssertEqual(text.body, "This run is already using all its slots (3/3). The run starts as soon as one of its sessions finishes.")
        XCTAssertEqual(text.waited, "Waiting 1 min · gives up at 20:00")
    }

    func testStartedOnTryThree() throws {
        let status = ScheduleRunSessionStatus(tries: tries(reached: 3, count: 3), thisTry: 2, nextDueAt: iso(15, "06:00"))
        let r = run(state: "RUNNING", session: "s3")
        XCTAssertEqual(ScheduleRunStatus.kind(run: r, status: status), .startedOn)
        let text = try XCTUnwrap(ScheduleRunStatus.startedOnText(run: r, status: status, engine: "Claude Code", runner: "HPC",
                                                                 timezone: zone))
        XCTAssertEqual(text.title, "Started on try 3")
        XCTAssertEqual(text.body, "This try stopped before its engine started (Claude Code exited). Try 3 started at 03:58.")
        let unclaimed = ScheduleRunSessionStatus(
            tries: [tries()[0], ScheduleRunTry(sessionId: "s2", startedAt: iso(14, "03:43"), claimed: false, reachedEngine: false),
                    ScheduleRunTry(sessionId: "s3", startedAt: iso(14, "03:58"), claimed: true, reachedEngine: true)],
            thisTry: 2)
        XCTAssertEqual(ScheduleRunStatus.startedOnText(run: r, status: unclaimed, engine: "Claude Code", runner: "HPC",
                                                       timezone: zone)?.body,
                       "This try stopped before its engine started (HPC didn't pick it up). Try 3 started at 03:58.")
    }

    func testNoCardWhenTheRunReachedItsEngineHere() {
        let status = ScheduleRunSessionStatus(tries: tries(reached: 5), thisTry: 5, gaveUpAt: nil)
        XCTAssertNil(ScheduleRunStatus.kind(run: run(state: "CHANGED", session: "s5"), status: status))
        XCTAssertNil(ScheduleRunStatus.kind(run: run(state: "RUNNING", session: "s5"), status: nil))
        XCTAssertNil(ScheduleRunStatus.kind(run: run(state: "RUNNING", session: "s5"),
                                            status: ScheduleRunSessionStatus(tries: tries(), thisTry: nil)))
        // Between tries, with nothing to say yet.
        XCTAssertNil(ScheduleRunStatus.kind(run: run(state: "QUEUED", session: "s1"),
                                            status: ScheduleRunSessionStatus(tries: tries(count: 1), thisTry: 1)))
    }

    func testTheServerFieldDecodes() throws {
        let json = """
        {"run":{"id":"r","scheduleId":"sch","plannedAt":"2026-11-14T03:32:00Z","state":"RUNNING","sessionId":"s1"},
         "runStatus":{"tries":[{"sessionId":"s1","startedAt":"2026-11-14T11:18:00Z","claimed":false,"reachedEngine":false}],
           "thisTry":1,"gaveUpAt":null,"notBeforeAt":null,"nextDueAt":"2026-11-15T06:00:00Z",
           "queue":{"queuedReason":"runner_at_capacity","queuedActive":20,"queuedLimit":20,"queuedHeldByJobs":0,
                    "since":"2026-11-14T11:18:00Z","deadline":"2026-11-15T03:32:00Z"}},
         "cards":[],"records":[]}
        """
        let read = try JSONDecoder().decode(SessionScheduleCardsResponse.self, from: Data(json.utf8))
        XCTAssertEqual(read.runStatus?.thisTry, 1)
        XCTAssertEqual(read.runStatus?.queue?.queuedActive, 20)
        XCTAssertEqual(ScheduleRunStatus.kind(run: try XCTUnwrap(read.run), status: read.runStatus), .queuedFull)
        let old = try JSONDecoder().decode(SessionScheduleCardsResponse.self, from: Data(#"{"run":null,"cards":[],"records":[]}"#.utf8))
        XCTAssertNil(old.runStatus)
    }
}
