import Foundation
import XCTest
@testable import OrbitKit

/// A session held by its runner's self-update (queuedReason `runner_updating`), case for case with the
/// web's `runnerSlots.runnerUpdating.test.ts`: board 5's studio-mac draining for 0.1.254 behind two
/// turns. `RunnerUpdatingCopyParityTests` holds the same words to `runnerSlots.ts`.
final class RunnerUpdatingTests: XCTestCase {
    static let now = Date(timeIntervalSince1970: 1_794_484_800) // 2026-11-12T12:00:00Z

    static func iso(_ date: Date) -> String {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f.string(from: date)
    }

    static let boardTurns = [QueuedRunnerUpdate.Turn(id: "a1", title: "Backfill missing shard rows"),
                             QueuedRunnerUpdate.Turn(id: "b2", title: "Why are 11-08 metrics zero")]

    static func held(active: Int? = 2, version: String? = "0.1.254", sinceMinutes: Double? = 38,
                     turns: [QueuedRunnerUpdate.Turn] = boardTurns,
                     reason: String? = "runner_updating", runState: SessionRunState = .queued) -> Session {
        var s = Session(id: "S1", title: "Why is the send stuck", status: .pending, runState: runState,
                        agentId: nil, assignedRunnerId: "R1", pendingApprovals: nil, branch: nil, updatedAt: nil)
        s.queuedReason = reason
        s.queuedActive = active
        s.queuedRunnerUpdate = QueuedRunnerUpdate(
            targetVersion: version,
            since: sinceMinutes.map { iso(now.addingTimeInterval(-$0 * 60)) },
            turns: turns)
        return s
    }

    func testTheListAndTheHeaderSayRunnerUpdatingInTheWarningColour() {
        let s = Self.held()
        XCTAssertEqual(SessionLine.make(for: s, live: true), SessionLine(text: "Runner updating", tone: .warning))
        XCTAssertEqual(SessionHeader.statusWord(for: s), "Runner updating")
        // The paired negatives: another gate, no gate, and a session no longer queued.
        XCTAssertEqual(SessionLine.make(for: Self.held(reason: "runner_offline"), live: true),
                       SessionLine(text: "Queued", tone: .queued))
        XCTAssertEqual(SessionHeader.statusWord(for: Self.held(reason: nil)), "Queued")
        XCTAssertFalse(RunnerUpdating.holds(Self.held(runState: .running)))
    }

    func testTheQueuedPageSaysWhatItWaitsForWithTheTurnsAsLinks() {
        let parts = RunnerUpdating.description(Self.held(), machine: "studio-mac")
        XCTAssertEqual(parts, [
            .text("studio-mac is updating to 0.1.254. "),
            .text("It starts no new work until 2 turns finish: "),
            .turn(id: "a1", title: "Backfill missing shard rows"),
            .text(" and "),
            .turn(id: "b2", title: "Why are 11-08 metrics zero"),
            .text(". "),
            .text("This session starts right after."),
        ])
        XCTAssertEqual(RunnerUpdating.plain(parts),
                       "studio-mac is updating to 0.1.254. It starts no new work until 2 turns finish: Backfill missing shard rows and Why are 11-08 metrics zero. This session starts right after.")
    }

    func testItCountsTheMinutesItHasWaited() {
        XCTAssertEqual(RunnerUpdating.waited(Self.held(), now: Self.now), "Waiting 38 min")
        XCTAssertEqual(RunnerUpdating.waited(Self.held(sinceMinutes: 38 + 5.0 / 60), now: Self.now), "Waiting 38 min")
        XCTAssertEqual(RunnerUpdating.waited(Self.held(sinceMinutes: 0), now: Self.now), "Waiting less than a minute")
        XCTAssertEqual(RunnerUpdating.waited(Self.held(sinceMinutes: 60), now: Self.now), "Waiting 1 h")
        XCTAssertEqual(RunnerUpdating.waited(Self.held(sinceMinutes: 125), now: Self.now), "Waiting 2 h 5 min")
        XCTAssertNil(RunnerUpdating.waited(Self.held(sinceMinutes: nil), now: Self.now))
        // A clock ahead of this one knows nothing about this wait.
        XCTAssertNil(RunnerUpdating.waited(Self.held(sinceMinutes: -5), now: Self.now))
    }

    func testTheQueuedMessagesFootRowTagAndItsPopoverGiveTheSameAccount() {
        XCTAssertEqual(RunnerUpdating.RUNNER_UPDATING_TAG, "runner updating")
        XCTAssertEqual(RunnerUpdating.queuedWord, "Queued")
        XCTAssertEqual(RunnerUpdating.messageText(Self.held(), machine: "studio-mac"),
                       "studio-mac starts no new turns until 2 turns finish, then updates to 0.1.254. This message is sent right after.")
    }

    func testItNamesOnlyTheReadersTurnsAndCountsTheRest() {
        XCTAssertEqual(RunnerUpdating.plain(RunnerUpdating.description(Self.held(active: 3), machine: "studio-mac")),
                       "studio-mac is updating to 0.1.254. It starts no new work until 3 turns finish: Backfill missing shard rows, Why are 11-08 metrics zero and 1 more. This session starts right after.")
        // A turn with no title still reads as one.
        let untitled = Self.held(active: 1, turns: [.init(id: "c3", title: "  ")])
        XCTAssertEqual(RunnerUpdating.description(untitled, machine: "studio-mac")[2], .turn(id: "c3", title: "Untitled session"))
    }

    func testItSaysLessNotSomethingFalseWhenTheRunnerReportsLess() {
        let old = Self.held(active: 1, version: nil, sinceMinutes: nil, turns: [Self.boardTurns[0]])
        XCTAssertEqual(RunnerUpdating.plain(RunnerUpdating.description(old, machine: "studio-mac")),
                       "studio-mac is updating. It starts no new work until 1 turn finishes: Backfill missing shard rows. This session starts right after.")
        XCTAssertEqual(RunnerUpdating.messageText(old, machine: "studio-mac"),
                       "studio-mac starts no new turns until 1 turn finishes, then updates. This message is sent right after.")
        let idle = Self.held(active: 0, version: nil, turns: [])
        XCTAssertEqual(RunnerUpdating.plain(RunnerUpdating.description(idle, machine: "studio-mac")),
                       "studio-mac is updating. This session starts right after.")
        XCTAssertEqual(RunnerUpdating.messageText(idle, machine: "studio-mac"),
                       "studio-mac updates now. This message is sent right after.")
        // A runner this client cannot name.
        XCTAssertEqual(RunnerUpdating.plain(RunnerUpdating.description(idle, machine: nil)),
                       "The runner is updating. This session starts right after.")
    }

    func testTheFootRowGoesUnderTheReadersLastMessageAndThePageOnlyWhenThereIsNone() throws {
        var reducer = TranscriptReducer()
        XCTAssertNil(RunnerUpdating.footBubbleID(reducer.state.items))
        for (seq, type, turn) in [(1, "user", "t-0"), (2, "assistant", "t-0"), (3, "user", "t-1"), (4, "assistant", "t-1")] {
            reducer.apply(try event(#"{"seq": \#(seq), "type": "\#(type)", "turnId": "\#(turn)", "payload": {"text": "words \#(seq)"}}"#))
        }
        let users = reducer.state.items.compactMap { item -> String? in
            if case .user(let b) = item { return b.id } else { return nil }
        }
        XCTAssertEqual(users.count, 2)
        XCTAssertEqual(RunnerUpdating.footBubbleID(reducer.state.items), users.last)
    }

    func testTheListRowDecodesTheGateAndAnEventKeepsItOnlyWhileQueued() throws {
        let json = """
        {"id":"S1","status":"PENDING","runState":"QUEUED","queuedReason":"runner_updating","queuedActive":2,
         "queuedLimit":null,"queuedRunnerUpdate":{"targetVersion":"0.1.254","since":"2026-11-12T11:22:00.000Z",
         "turns":[{"id":"a1","title":"Backfill missing shard rows"},{"id":"b2","title":null}]}}
        """
        let s = try JSONDecoder().decode(Session.self, from: Data(json.utf8))
        XCTAssertTrue(RunnerUpdating.holds(s))
        XCTAssertEqual(s.queuedActive, 2)
        XCTAssertEqual(s.queuedRunnerUpdate?.turns.last, .init(id: "b2", title: nil))
        XCTAssertEqual(RunnerUpdating.waited(s, now: Self.now), "Waiting 38 min")
        // An older server's row carries none of it.
        let old = try JSONDecoder().decode(Session.self, from: Data(#"{"id":"S1","status":"PENDING"}"#.utf8))
        XCTAssertNil(old.queuedReason)
        XCTAssertNil(old.queuedRunnerUpdate)

        let stillQueued = s.applying(try summary(#"{"id":"S1","status":"PENDING","runState":"QUEUED"}"#))
        XCTAssertEqual(stillQueued.queuedReason, "runner_updating")
        XCTAssertEqual(stillQueued.queuedRunnerUpdate, s.queuedRunnerUpdate)
        let started = s.applying(try summary(#"{"id":"S1","status":"RUNNING","runState":"RUNNING"}"#))
        XCTAssertNil(started.queuedReason)
        XCTAssertNil(started.queuedRunnerUpdate)
    }

    private func event(_ json: String) throws -> RunEvent {
        try JSONDecoder().decode(RunEvent.self, from: Data(json.utf8))
    }

    private func summary(_ json: String) throws -> ControlSessionSummary {
        try JSONDecoder().decode(ControlSessionSummary.self, from: Data(json.utf8))
    }
}
