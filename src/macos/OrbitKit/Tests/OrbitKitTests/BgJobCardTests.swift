import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import XCTest
@testable import OrbitKit

/// A bg_run job is one card from start to end (the owner's job-card board, choices A1 B1 C1 D1 E1 F1,
/// rulings R1-R4 of 2026-11-21): each folded state, the opened card, the wake turns that draw nothing,
/// the queued tail, the Background list's rows, Stop, and the tail read's pace. Web parity:
/// `Transcript.jobCard.test.tsx`, `bgJobCard.test.ts`, `BackgroundShellsTray.row.test.tsx`.
final class BgJobCardTests: XCTestCase {
    private static let jobId = "bgj_9f3a2c1d0e4b"
    private static let ts = "2026-11-21T10:20:00.000Z"
    private static let input: JSONValue = .object([
        "command": .string("gh run watch 19632123456 --exit-status --interval 30"),
        "description": .string("Wait for CI JavaScript job on 4c8f5a8a1b"),
        "kind": .string("watch"),
    ])
    private static let receipt = "{\"jobId\":\"\(jobId)\",\"status\":\"running\",\"startedAt\":\"2026-11-21T10:20:00.000Z\"}"

    private static func wakeBlock(_ trigger: String, tail: [String] = ["run ended before JavaScript finished: completed cancelled"]) -> String {
        ([
            "<background-job-wake>",
            "  A background job you started with bg_run has news you were waiting for; the control plane opened this turn for it:",
            "    \(jobId)｜watch｜gh run watch 19632123456 --exit-status --interval 30｜Wait for CI JavaScript job on 4c8f5a8a1b",
            "      \(trigger)",
            "      output /root/.orbit/runs/4f50733a/\(jobId).output｜this covers bytes 0–900",
            "      output tail:",
        ] + tail.map { "        \($0)" } + [
            "  The control plane recorded this for you; the user did not say it.",
            "</background-job-wake>",
        ]).joined(separator: "\n")
    }

    private static let stallBlock = [
        "<background-job-stall>",
        "  A background job you started with bg_run is still running and has written nothing for as long as you asked to be told about; the control plane opened this turn for it:",
        "    \(jobId)｜job｜./deploy.sh 5dd308afd｜Deploy 5dd308afd",
        "      gone quiet｜still running｜running for 22m 0s when this was sent",
        "      no new output for 10m 0s｜last output at 2026-11-21T10:32:00Z",
        "      output /root/.orbit/runs/4f50733a/\(jobId).output｜this covers bytes 0–21",
        "      output tail:",
        "        Waiting for apiserver-next to pass its health check…",
        "  The control plane recorded this for you; the user did not say it.",
        "</background-job-stall>",
    ].joined(separator: "\n")

    private static let wakeupBlock = """
        <scheduled-wakeup>
          The wakeup you asked for with schedule_wakeup is due; the control plane opened this turn for it:
            2026-09-15T18:00:00.000Z scheduled 600 seconds out, due 2026-09-15T18:10:00.000Z
            reason: waiting for CI run 4242
            what you left for this turn:
              read the CI result and fix what failed
          The control plane recorded this for you; the user did not say it.
        </scheduled-wakeup>
        """

    private func wake(_ block: String, ts: String = "2026-11-21T10:32:40.000Z", delivered: Bool = true) -> BgJobCard.WakeSeen {
        let job = BackgroundWakeText.parse(block)!.jobs[0]
        return BgJobCard.WakeSeen(job: job, text: block, ts: ts, readAt: delivered ? ts : nil)
    }

    private func proc(status: String, exitCode: Int? = nil, reason: String? = nil, stoppable: Bool? = nil,
                      endedAt: String? = nil, output: String = "") -> BackgroundProc {
        BackgroundProc(id: Self.jobId, command: "gh run watch", description: nil, status: status, outputTail: output,
                       startedAt: Self.ts, kind: "job", taskId: Self.jobId, endedAt: endedAt,
                       reason: reason, exitCode: exitCode, stoppable: stoppable)
    }

    private func look(proc: BackgroundProc? = nil, wakes: [BgJobCard.WakeSeen] = [], tail: BackgroundJobTail? = nil,
                      live: Bool = true, canStop: Bool = true, input: JSONValue = BgJobCardTests.input,
                      now: Date? = nil) -> BgJobCard.Look {
        BgJobCard.look(input: input, jobId: Self.jobId, startedAt: Self.ts, proc: proc, wakes: wakes, tail: tail,
                       live: live, canStop: canStop, where: "workstation",
                       now: now ?? RelativeTime.parse("2026-11-21T10:23:10.000Z")!)
    }

    // MARK: the call is the card

    func testTheCallIsTheCardAndItsReceiptNamesTheJob() {
        let running = ToolCard(id: "toolu_1", name: BgJobCard.toolName, input: Self.input, result: nil, status: .running)
        XCTAssertTrue(BgJobCard.drawsCard(running), "the card stands from the moment the call does")
        var answered = running
        answered.result = Self.receipt
        answered.status = .ok
        XCTAssertTrue(BgJobCard.drawsCard(answered))
        XCTAssertEqual(BgJobCard.receipt(answered.result)?.jobId, Self.jobId)
        XCTAssertEqual(BgJobCard.receipt(answered.result)?.startedAt, Self.ts)
        var refused = answered
        refused.status = .error
        XCTAssertFalse(BgJobCard.drawsCard(refused), "a refused call stays a call")
        var nameless = answered
        nameless.result = "{\"status\":\"waiting_for_owner\"}"
        XCTAssertFalse(BgJobCard.drawsCard(nameless), "an answer naming no job stays a call")
        XCTAssertEqual(BgJobCard.card(forJob: Self.jobId, in: [.toolCall(answered)]), "toolu_1")
    }

    /// The runner's launch pair is the Background list's: the transcript draws only the bg_run call,
    /// and never folds it into a steps line.
    func testTheRunnersLaunchPairDrawsNothingAndTheCardIsNeverAStep() throws {
        let rows = try rows([
            ["seq": 1, "type": "user", "turnId": "t1", "payload": ["text": "Watch CI."]],
            ["seq": 2, "type": "tool_use", "turnId": "t1",
             "payload": ["id": "toolu_1", "name": BgJobCard.toolName,
                         "input": ["command": "gh run watch", "description": "Wait for CI", "kind": "watch"]]],
            ["seq": 3, "type": "tool_use", "turnId": "t1",
             "payload": ["id": Self.jobId, "name": "Bash", "input": ["command": "gh run watch", "run_in_background": true]]],
            ["seq": 4, "type": "tool_result", "turnId": "t1",
             "payload": ["toolUseId": Self.jobId, "content": "Command running in background with ID: \(Self.jobId)."]],
            ["seq": 5, "type": "tool_result", "turnId": "t1", "payload": ["toolUseId": "toolu_1", "content": Self.receipt]],
            ["seq": 6, "type": "tool_use", "turnId": "t1", "payload": ["id": "toolu_2", "name": "Read", "input": ["file_path": "/a"]]],
        ])
        let cards = rows.compactMap { row -> ToolCard? in
            if case .item(.toolCall(let card)) = row { return card }
            return nil
        }
        XCTAssertEqual(cards.map(\.id), ["toolu_1"], "the bg_run call alone, in a row of its own")
        XCTAssertEqual(BgJobCard.receipt(cards.first?.result)?.jobId, Self.jobId, "its own receipt, not the launch's")
        XCTAssertFalse(rows.contains { if case .item(.toolCall(let c)) = $0 { return c.name == "Bash" } else { return false } })
    }

    // MARK: each folded state

    func testRunningShowsTheSpinnerAndTheNewestLineReadLive() {
        let tail = BackgroundJobTail(jobId: Self.jobId, status: "running", exitCode: nil,
                                     lines: ["✓ Swift in 6m12s", "✓ src/components/Transcript.test.tsx (412 tests) 9.8s"])
        let look = look(proc: proc(status: "running"), tail: tail)
        XCTAssertEqual(look.phase, .running)
        XCTAssertEqual(look.folded, .live("✓ src/components/Transcript.test.tsx (412 tests) 9.8s"))
        XCTAssertEqual(look.elapsed, "3m 10s")
        XCTAssertNil(look.endChip)
        XCTAssertNil(look.quietChip)
    }

    /// R2: with no tail read answered (a runner too old, or offline), no line and no error: the spinner stays.
    func testRunningWithNothingReadShowsNoLine() {
        let look = look(proc: proc(status: "running"))
        XCTAssertEqual(look.phase, .running)
        XCTAssertEqual(look.folded, .none)
    }

    func testExitZeroIsACheckAndTheLastTwoLinesGrey() {
        let block = Self.wakeBlock("ended｜completed｜exit code 0", tail: ["building", "Test Files  641 passed (641)", "     Tests  8723 passed (8723)"])
        let look = look(wakes: [wake(block)], live: true)
        XCTAssertEqual(look.phase, .done)
        XCTAssertEqual(look.folded, .ending(lines: ["Test Files  641 passed (641)", "     Tests  8723 passed (8723)"], failed: false))
        XCTAssertNil(look.endChip, "exit 0 adds no word")
        XCTAssertEqual(look.elapsed, "12m 40s", "dated from the wake its end opened")
    }

    func testExitNIsARedChipACrossAndTheLastTwoLinesRed() {
        let look = look(proc: proc(status: "failed", exitCode: 1, endedAt: "2026-11-21T10:21:10.000Z",
                                   output: "npm error network ECONNRESET\nERROR: process \"/bin/sh -c npm ci\" did not complete: exit code 1\n"))
        XCTAssertEqual(look.phase, .failed)
        XCTAssertEqual(look.endChip, "exit 1")
        XCTAssertEqual(look.folded, .ending(lines: ["npm error network ECONNRESET",
                                                    "ERROR: process \"/bin/sh -c npm ci\" did not complete: exit code 1"],
                                            failed: true))
        XCTAssertEqual(look.elapsed, "1m 10s")
        XCTAssertEqual(BgJobCard.showFullOutput, "Show full output")
    }

    /// R3: a killed job's line names who stopped it, in the wake glosses' own words, for every reason.
    func testKilledIsAGreyChipAndALineNamingWhoStoppedIt() {
        let cases: [(String, String)] = [
            ("requested", "Killed by the agent."),
            ("stopped_by_owner", "The person who owns this session stopped it from the app."),
            ("runner_shutdown", "The runner process hosting it stopped — a restart or a self-update — and the job was killed with it."),
            ("session_cancelled", "The session was cancelled, or handed to another runner process, and the job was killed with it."),
        ]
        for (reason, line) in cases {
            let look = look(proc: proc(status: "killed", reason: reason, endedAt: "2026-11-21T10:26:00.000Z"))
            XCTAssertEqual(look.phase, .killed)
            XCTAssertEqual(look.endChip, "killed")
            XCTAssertEqual(look.folded, .killedBy(line), reason)
            XCTAssertEqual(look.killedBy, line)
        }
        // The same from the end's wake, where the runner's report is not loaded.
        let fromWake = look(wakes: [wake(Self.wakeBlock("ended｜killed｜reason stopped_by_owner (the owner stopped it)"))])
        XCTAssertEqual(fromWake.folded, .killedBy("The person who owns this session stopped it from the app."))
        XCTAssertNil(BgJobCard.killedBy("something_new"), "no invented words for a reason nobody named")
    }

    /// B1: a quiet job changes only its chip, amber, and keeps spinning.
    func testQuietIsAnAmberChipWhileItStillRuns() {
        let block = Self.stallBlock
        let job = BackgroundWakeText.parse(block)!.jobs[0]
        let look = look(proc: proc(status: "running"), wakes: [BgJobCard.WakeSeen(job: job, text: block, ts: Self.ts, readAt: Self.ts)])
        XCTAssertEqual(look.phase, .running)
        XCTAssertEqual(look.quietChip, "quiet 10m")
        XCTAssertEqual(look.folded, .live("Waiting for apiserver-next to pass its health check…"))
    }

    func testAServiceNeverEndsAndKeepsSpinning() {
        let input: JSONValue = .object(["command": .string("npm run dev"), "kind": .string("service")])
        let tail = BackgroundJobTail(jobId: Self.jobId, status: "running", exitCode: nil, lines: ["  ➜  Local:   http://localhost:5173/"])
        let look = look(tail: tail, input: input, now: RelativeTime.parse("2026-11-21T11:00:00.000Z")!)
        XCTAssertEqual(look.kind, "service")
        XCTAssertEqual(look.title, "npm run dev", "named by its command without a description")
        XCTAssertEqual(look.phase, .running)
        XCTAssertEqual(look.elapsed, "40m")
    }

    /// B1: new output only refreshes the tail; no chip.
    func testNewOutputRefreshesTheTailAndAddsNoChip() {
        let block = Self.wakeBlock("new output｜running", tail: ["check \"Swift\" → success (3 of 6 done)"])
        let look = look(proc: proc(status: "running"), wakes: [wake(block)])
        XCTAssertEqual(look.phase, .running)
        XCTAssertEqual(look.folded, .live("check \"Swift\" → success (3 of 6 done)"))
        XCTAssertNil(look.quietChip)
        XCTAssertNil(look.endChip)
    }

    /// R4: never the word "Job" in the header; the kind chip and the icon say it.
    func testTheHeaderNeverSaysJob() {
        let look = look(proc: proc(status: "running"))
        XCTAssertEqual(look.title, "Wait for CI JavaScript job on 4c8f5a8a1b")
        XCTAssertEqual(look.kind, "watch")
        let header = [look.kind, look.elapsed, look.quietChip, look.endChip].compactMap { $0 }
        XCTAssertFalse(header.contains { $0 == "Job" }, "the header carries the word Job")
        XCTAssertEqual(BgJobCard.kind(input: .object([:])), "job", "bg_run's own default kind")
    }

    // MARK: the opened card

    func testTheOpenedCardSaysWhereItRanAndEveryTimeItWokeTheAgent() {
        let lines = (1...214).map { "line \($0)" }
        let end = wake(Self.wakeBlock("ended｜failed｜exit code 1", tail: lines), ts: "2026-11-21T10:32:40.000Z")
        let look = look(wakes: [end])
        XCTAssertEqual(look.meta, "\(Self.jobId) · watch · started \(BgJobCard.clock(RelativeTime.parse(Self.ts)!)) · ran 12m 40s · on workstation")
        XCTAssertEqual(look.lines.count, 214)
        XCTAssertEqual(Array(look.lines.suffix(BgJobCard.openLines)).first, "line 175", "the last 40 lines")
        XCTAssertEqual(BgJobCard.showAll(214), "Show all 214 lines")
        XCTAssertEqual(BgJobCard.wokeHead(1), "Woke the agent 1 time")
        XCTAssertEqual(BgJobCard.wokeHead(2), "Woke the agent 2 times")
        let clock = SubagentCardEnd.clock(end.ts!)!
        XCTAssertEqual(BgJobCard.wakeLine(end), "\(clock) · exit 1 · read by the agent at \(clock)")
        XCTAssertEqual(BgJobCard.rawSummary, "What the agent read")
        let queued = BgJobCard.WakeSeen(job: end.job, text: end.text, ts: end.ts, readAt: nil)
        XCTAssertEqual(BgJobCard.wakeLine(queued), "\(clock) · exit 1", "no read time for a wake never confirmed")
    }

    // MARK: the wake turns draw nothing

    func testAJobsWakeTurnDrawsNothingWhileAWakeupStillDraws() throws {
        let end = Self.wakeBlock("ended｜failed｜exit code 1")
        let rows = try rows([
            ["seq": 1, "type": "user", "turnId": "t1", "payload": ["text": "Watch CI."]],
            ["seq": 2, "type": "user", "turnId": "t2", "payload": ["text": end, "controlPlaneNote": end]],
            ["seq": 3, "type": "assistant", "turnId": "t2", "payload": ["text": "CI's JavaScript job was cancelled, not failed: I'll re-run it."]],
            ["seq": 4, "type": "user", "turnId": "t3", "payload": ["text": "\(Self.stallBlock)\n\n\(Self.wakeupBlock)",
                                                                  "controlPlaneNote": "\(Self.stallBlock)\n\n\(Self.wakeupBlock)"]],
        ])
        let users = rows.compactMap { row -> UserBubble? in
            if case .item(.user(let b)) = row { return b }
            return nil
        }
        let exchanges = rows.flatMap { row -> [OrbitExchange] in
            if case .exchanges(let xs) = row { return xs }
            return []
        }
        XCTAssertFalse(users.contains { $0.turnId == "t2" }, "the job's end turn drew a row")
        XCTAssertFalse(exchanges.contains { $0.what.contains("Background job") }, "the job's end folded as a line")
        let wakeupDrawn = users.contains { $0.note?.contains("<scheduled-wakeup>") == true }
            || exchanges.contains { $0.what == "Scheduled wakeup: waiting for CI run 4242" }
        XCTAssertTrue(wakeupDrawn, "a wakeup coming due beside a job's stall keeps its line")
        XCTAssertTrue(BgJobCard.drawsNothing(UserBubble(id: "w", text: "", pending: false, note: end), queued: false))
        XCTAssertFalse(BgJobCard.drawsNothing(UserBubble(id: "w", text: "", pending: false, note: Self.wakeupBlock), queued: false),
                       "a schedule_wakeup with no job is unchanged")
        XCTAssertFalse(BgJobCard.drawsNothing(UserBubble(id: "w", text: "继续", pending: false, note: end), queued: false),
                       "words somebody typed keep their bubble")
        // What is left of the wake to draw: its wakeups, never its job.
        let left = try XCTUnwrap(BgJobCard.wakeupsOnly(BackgroundWakeText.parse("\(Self.stallBlock)\n\n\(Self.wakeupBlock)")))
        XCTAssertTrue(left.jobs.isEmpty)
        XCTAssertEqual(left.wakeups.count, 1)
    }

    func testTheCardJoinsItsWakesByJobIdOldestFirst() {
        let output = Self.wakeBlock("new output｜running")
        let end = Self.wakeBlock("ended｜failed｜exit code 1")
        let items: [TranscriptItem] = [
            .user(UserBubble(id: "a", text: "", ts: "2026-11-21T10:25:00.000Z", pending: false, note: output)),
            .user(UserBubble(id: "b", text: "", ts: "2026-11-21T10:32:40.000Z", pending: false, note: end, delivery: "unconfirmed")),
        ]
        let wakes = BgJobCard.wakes(items)[Self.jobId] ?? []
        XCTAssertEqual(wakes.map(\.ts), ["2026-11-21T10:25:00.000Z", "2026-11-21T10:32:40.000Z"])
        XCTAssertNotNil(wakes[0].readAt)
        XCTAssertNil(wakes[1].readAt, "an unconfirmed wake was never read")
    }

    // MARK: the queued tail

    /// E1: a job's wake still on the queue waits on its card; the tail draws no row for it.
    func testAQueuedJobWakeWaitsOnTheCardNotInTheTail() throws {
        var state = try state([
            ["seq": 1, "type": "user", "turnId": "t1", "payload": ["text": "Watch CI."]],
            ["seq": 2, "type": "tool_use", "turnId": "t1",
             "payload": ["id": "toolu_1", "name": BgJobCard.toolName, "input": ["command": "gh run watch", "kind": "watch"]]],
            ["seq": 3, "type": "tool_result", "turnId": "t1", "payload": ["toolUseId": "toolu_1", "content": Self.receipt]],
        ])
        let end = Self.wakeBlock("ended｜failed｜exit code 1")
        let queued = UserBubble(id: "q1", text: end, turnId: "wake-1", pending: true, queued: true)
        state.queued = [queued, UserBubble(id: "q2", text: Self.wakeupBlock, turnId: "wake-2", pending: true, queued: true)]
        let rows = TranscriptRows.build(state: state, statusCards: [], canPageOlder: false, showWorkingIndicator: false)
        let tail = rows.compactMap { row -> String? in if case .queued(let b) = row { return b.id } else { return nil } }
        XCTAssertEqual(tail, ["q2"], "the job's wake has no row in the tail; a wakeup still does")
        XCTAssertEqual(BgJobCard.queuedWake(queued)?.jobIds, [Self.jobId])
        XCTAssertEqual(BgJobCard.queuedWake(queued)?.alone, true)
        let withWakeup = UserBubble(id: "q3", text: "\(end)\n\n\(Self.wakeupBlock)", pending: true, queued: true)
        XCTAssertEqual(BgJobCard.queuedWake(withWakeup)?.alone, false, "a wakeup beside it keeps the tail's row")
        XCTAssertEqual("\(SubagentCardEnd.waiting) · \(SubagentCardEnd.dontSend)", "Waiting for the agent to read it · Don't send")
    }

    // MARK: the Background list

    /// R1 (E2, revised 2026-11-21): the owner can do nothing about a failed job, so the row does not count it;
    /// tapping a job in the opened list goes to its card.
    func testTheBackgroundListDoesNotCountAFailedJobAndGoesToTheCard() {
        let failed = proc(status: "failed", exitCode: 1, endedAt: "2026-11-21T10:32:40.000Z")
        let other = BackgroundProc(id: "bgj_other", command: "npm run dev", status: "running", outputTail: "",
                                   startedAt: Self.ts, kind: "job")
        let row = BackgroundRowRule.row([failed, other], items: [], sessionLive: true)
        XCTAssertNil(row?.countParts.first { $0.kind == "failed" }, "a failed job is not counted")
        XCTAssertTrue(WorktreeBarLogic.jobRowScrollsToCard(failed))
        var shell = failed
        shell.kind = "shell"
        XCTAssertFalse(WorktreeBarLogic.jobRowScrollsToCard(shell), "an engine's own shell opens in place as ever")
    }

    // MARK: Stop

    /// R3: Stop is offered on a running job its runner can stop, on the card and in the list, and hidden
    /// when the list marks it not stoppable.
    func testStopIsOfferedOnlyWhereTheRunnerCanStopIt() {
        XCTAssertTrue(look(proc: proc(status: "running", stoppable: true)).stoppable)
        XCTAssertFalse(look(proc: proc(status: "running", stoppable: false)).stoppable, "an older runner")
        XCTAssertFalse(look(proc: proc(status: "running")).stoppable, "a list that never said")
        XCTAssertFalse(look(proc: proc(status: "running", stoppable: true), canStop: false).stoppable, "no session to ask")
        XCTAssertFalse(look(proc: proc(status: "failed", exitCode: 1, stoppable: true)).stoppable, "an ended job")
        XCTAssertTrue(WorktreeBarLogic.jobRowOffersStop(proc(status: "running", stoppable: true)))
        XCTAssertFalse(WorktreeBarLogic.jobRowOffersStop(proc(status: "running", stoppable: false)))
        XCTAssertFalse(WorktreeBarLogic.jobRowOffersStop(proc(status: "completed", stoppable: true)))
        XCTAssertEqual(BgJobCard.stopConfirm, "Stop this job?")
        XCTAssertEqual(BgJobCard.stop, "Stop")
    }

    // MARK: the tail read's pace

    /// R2: polled while the card is on screen and the job runs, at the route's pace; stopped for good on a
    /// 404/409, slowed on a 503/504, and over once the job ended.
    func testTheTailIsReadOnlyWhileOnScreenAtTheRoutesPace() {
        XCTAssertTrue(BgJobCard.pollsTail(running: true, onScreen: true, appActive: true, gone: false, canRead: true))
        XCTAssertFalse(BgJobCard.pollsTail(running: true, onScreen: false, appActive: true, gone: false, canRead: true))
        XCTAssertFalse(BgJobCard.pollsTail(running: true, onScreen: true, appActive: false, gone: false, canRead: true))
        XCTAssertFalse(BgJobCard.pollsTail(running: false, onScreen: true, appActive: true, gone: false, canRead: true))
        XCTAssertFalse(BgJobCard.pollsTail(running: true, onScreen: true, appActive: true, gone: true, canRead: true))
        let running = BackgroundJobTail(jobId: Self.jobId, status: "running", exitCode: nil, lines: [])
        let ended = BackgroundJobTail(jobId: Self.jobId, status: "completed", exitCode: 0, lines: [])
        XCTAssertEqual(BgJobCard.tailNext(answer: running, httpStatus: nil), .after(5))
        XCTAssertEqual(BgJobCard.tailNext(answer: ended, httpStatus: nil), .ended)
        XCTAssertEqual(BgJobCard.tailNext(answer: nil, httpStatus: 404), .gone)
        XCTAssertEqual(BgJobCard.tailNext(answer: nil, httpStatus: 409), .gone)
        XCTAssertEqual(BgJobCard.tailNext(answer: nil, httpStatus: 503), .after(30))
        XCTAssertEqual(BgJobCard.tailNext(answer: nil, httpStatus: nil), .after(30))
    }

    /// Once it ended, the card shows the wake's tail (R2), then the last read, then the runner's report.
    func testAnEndedJobShowsItsEndsTailBeforeTheLastRead() {
        let end = wake(Self.wakeBlock("ended｜failed｜exit code 1", tail: ["from the wake"]))
        let tail = BackgroundJobTail(jobId: Self.jobId, status: "running", exitCode: nil, lines: ["from the read"])
        XCTAssertEqual(BgJobCard.output(phase: .failed, proc: nil, wakes: [end], tail: tail), "from the wake")
        XCTAssertEqual(BgJobCard.output(phase: .running, proc: nil, wakes: [end], tail: tail), "from the read")
        XCTAssertEqual(BgJobCard.stripAnsi("\u{1b}[31mred\u{1b}[0m"), "red")
        XCTAssertEqual(BgJobCard.elapsed(45), "45s")
        XCTAssertEqual(BgJobCard.elapsed(3 * 60 + 10), "3m 10s")
        XCTAssertEqual(BgJobCard.elapsed(40 * 60), "40m")
        XCTAssertEqual(BgJobCard.elapsed(3600 + 5 * 60), "1h 5m")
    }

    // MARK: the runner's reports

    /// The list says why a killed job was killed, its exit code, and whether it can be stopped; a live
    /// row keeps the server's word on the last.
    func testTheListCarriesHowAJobEndedAndWhetherItCanBeStopped() throws {
        let dto = try JSONDecoder().decode(BgShellDTO.self, from: Data("""
            {"shellId":"\(Self.jobId)","toolUseId":"\(Self.jobId)","command":"gh run watch","status":"running",
             "kind":"job","stoppable":true}
            """.utf8))
        var reducer = TranscriptReducer()
        reducer.seedBackground([dto.asBackgroundProc()])
        XCTAssertEqual(reducer.state.background.first?.stoppable, true)
        let end = try JSONDecoder().decode(RunEvent.self, from: JSONSerialization.data(withJSONObject: [
            "seq": 9, "type": "background_task", "ts": "2026-11-21T10:26:00.000Z",
            "payload": ["shellId": Self.jobId, "toolUseId": Self.jobId, "status": "killed", "kind": "watch",
                        "reason": "stopped_by_owner"],
        ]))
        reducer.apply(end)
        let row = try XCTUnwrap(reducer.state.background.first)
        XCTAssertEqual(row.status, "killed")
        XCTAssertEqual(row.reason, "stopped_by_owner")
        XCTAssertEqual(row.stoppable, false, "an end is no longer stoppable")
        let exit = try JSONDecoder().decode(RunEvent.self, from: JSONSerialization.data(withJSONObject: [
            "seq": 10, "type": "background_task", "ts": "2026-11-21T10:26:00.000Z",
            "payload": ["shellId": "bgj_2", "toolUseId": "bgj_2", "status": "failed", "kind": "job", "exitCode": 3],
        ]))
        reducer.apply(exit)
        XCTAssertEqual(reducer.state.background.first { $0.id == "bgj_2" }?.exitCode, 3)
    }

    // MARK: the two routes

    func testTheCardReadsTheTailRouteAndStopsOnTheStopRoute() async throws {
        let seen = JobRouteSeen()
        JobRouteURLProtocol.handler = { request in
            seen.record(request)
            if request.httpMethod == "POST" {
                return (202, Data(#"{"jobId":"bgj_9f3a2c1d0e4b","status":"stopping"}"#.utf8))
            }
            return (200, Data(#"{"jobId":"bgj_9f3a2c1d0e4b","status":"running","exitCode":null,"lines":["a","b"],"truncated":false,"outputBytes":4,"readAt":"2026-11-21T10:23:10.000Z"}"#.utf8))
        }
        defer { JobRouteURLProtocol.handler = nil }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [JobRouteURLProtocol.self]
        let api = APIClient(baseURL: URL(string: "https://orbit.test")!, tokenStore: InMemoryTokenStore(),
                            session: URLSession(configuration: configuration))
        let tail = try await api.backgroundJobTail(sessionID: "s1", jobID: Self.jobId)
        XCTAssertEqual(tail.lines, ["a", "b"])
        XCTAssertEqual(seen.requests.last?.httpMethod, "GET")
        XCTAssertEqual(seen.requests.last?.url?.path, "/api/sessions/s1/background/jobs/\(Self.jobId)/tail")
        let stop = try await api.stopBackgroundJob(sessionID: "s1", jobID: Self.jobId)
        XCTAssertEqual(stop.status, "stopping")
        XCTAssertEqual(seen.requests.last?.httpMethod, "POST")
        XCTAssertEqual(seen.requests.last?.url?.path, "/api/sessions/s1/background/jobs/\(Self.jobId)/stop")
    }

    // MARK: helpers

    private func state(_ events: [[String: Any]]) throws -> TranscriptState {
        var reducer = TranscriptReducer()
        for e in events {
            var event = e
            if event["ts"] == nil { event["ts"] = Self.ts }
            reducer.apply(try JSONDecoder().decode(RunEvent.self, from: JSONSerialization.data(withJSONObject: event)))
        }
        return reducer.state
    }

    private func rows(_ events: [[String: Any]]) throws -> [TranscriptRow] {
        TranscriptRows.build(state: try state(events), statusCards: [], canPageOlder: false, showWorkingIndicator: false)
    }
}

private final class JobRouteURLProtocol: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var handler: (@Sendable (URLRequest) -> (status: Int, body: Data))?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        guard let handler = Self.handler else {
            client?.urlProtocol(self, didFailWithError: APIError.invalidResponse)
            return
        }
        let result = handler(request)
        let response = HTTPURLResponse(url: request.url!, statusCode: result.status, httpVersion: nil, headerFields: nil)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: result.body)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

private final class JobRouteSeen: @unchecked Sendable {
    private let lock = NSLock()
    private var seen: [URLRequest] = []
    func record(_ request: URLRequest) { lock.lock(); seen.append(request); lock.unlock() }
    var requests: [URLRequest] { lock.lock(); defer { lock.unlock() }; return seen }
}
