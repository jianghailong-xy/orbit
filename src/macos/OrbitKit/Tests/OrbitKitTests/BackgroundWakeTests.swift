import Foundation
import XCTest
@testable import OrbitKit

/// The blocks the control plane opens a turn with, in both wordings it has written them in.
///
/// The English fixtures are built the way the apiserver builds them today
/// (`runner-api/background-job-wake.ts` `buildBackgroundWakeBlock`, `scheduled-wakeup.ts`
/// `buildScheduledWakeupBlock`). The Chinese ones are the wording that shipped until 2026-09-15:
/// the four copied out of this deployment's own `run_event` rows are the same rows web's
/// `backgroundWake.fixtures.ts` quotes, and the rest are built from that writer's own lines
/// (`git show 3023d5c8d^:src/apiserver/src/runner-api/background-job-wake.ts`) rather than typed out
/// from a description of the format. The 59 turns already in the record are not migrated, so a
/// client that read only today's wording would send every older transcript back to an unnamed grey
/// strip on the day it shipped.
private enum Fixture {

    // MARK: the wording written today

    static let enDone = """
        <background-job-wake>
          A background job you started with bg_run has news you were waiting for; the control plane opened this turn for it:
            bgj_13c53745a88a｜job｜/root/orbit/.claude/skills/upgrade/upgrade.sh --pull｜upgrade to 39551b637
              ended｜completed｜exit code 0
              output /root/.orbit/runs/4f50733a/bgj_13c53745a88a.output｜this covers bytes 0–16570
              output tail:
                ==> recreating apiserver
                ==> apiserver is healthy
          The control plane recorded this for you; the user did not say it. Read the full output with mcp__orbit__bg_output by id; pass sinceOffset to read only what is new.
        </background-job-wake>
        """

    static let enKilled = """
        <background-job-wake>
          A background job you started with bg_run has news you were waiting for; the control plane opened this turn for it:
            bgj_13c53745a88a｜job｜/root/orbit/.claude/skills/upgrade/upgrade.sh --pull｜upgrade to 39551b637
              ended｜killed｜reason runner_shutdown (the runner process hosting it stopped — a restart or a self-update — and the job was killed with it)
              output /root/.orbit/runs/4f50733a/bgj_13c53745a88a.output｜this covers bytes 0–16570
              (no output)
          The control plane recorded this for you; the user did not say it. Read the full output with mcp__orbit__bg_output by id; pass sinceOffset to read only what is new.
          A killed job does not come back on its own: to keep waiting, start it again with bg_run.
        </background-job-wake>
        """

    static let enTwoJobs = """
        <background-job-wake>
          A background job you started with bg_run has news you were waiting for; the control plane opened this turn for it:
            bgj_987dbb363d36｜job｜bash scripts/run-pg-spec.sh src/apiserver/src/tasks/a.pg.spec.ts｜Red run: new pg spec on the unchanged tree
              ended｜completed｜exit code 0
              output /root/.orbit/runs/4f50733a/bgj_987dbb363d36.output｜this covers bytes 0–9626
              output tail:
                ok 1 - the criterion holds
            bgj_645de7bb677b｜watch｜gh run watch 34997433169 --exit-status｜watch main CI 34997433169
              ended｜failed｜exit code 1
              output /root/.orbit/runs/4f50733a/bgj_645de7bb677b.output｜this covers bytes 0–350697
              output tail:
                X Process completed with exit code 1.
          The control plane recorded this for you; the user did not say it. Read the full output with mcp__orbit__bg_output by id; pass sinceOffset to read only what is new.
        </background-job-wake>
        """

    /// Two jobs that ended without an exit code between them: the card counts them without claiming
    /// they all exited 0.
    static let enTwoJobsNoExitCode = """
        <background-job-wake>
          A background job you started with bg_run has news you were waiting for; the control plane opened this turn for it:
            bgj_987dbb363d36｜job｜bash a.sh｜First
              ended｜completed
              output /root/.orbit/runs/4f50733a/bgj_987dbb363d36.output｜this covers bytes 0–10
              (no output)
            bgj_645de7bb677b｜job｜bash b.sh｜Second
              ended｜completed｜exit code 0
              output /root/.orbit/runs/4f50733a/bgj_645de7bb677b.output｜this covers bytes 0–10
              (no output)
          The control plane recorded this for you; the user did not say it. Read the full output with mcp__orbit__bg_output by id; pass sinceOffset to read only what is new.
        </background-job-wake>
        """

    /// A wake the job's new output opened, rather than its exit: it is still running.
    static let enNewOutput = """
        <background-job-wake>
          A background job you started with bg_run has news you were waiting for; the control plane opened this turn for it:
            bgj_645de7bb677b｜watch｜gh run watch 34997433169 --exit-status｜watch main CI 34997433169
              new output｜running
              output /root/.orbit/runs/4f50733a/bgj_645de7bb677b.output｜this covers bytes 120–460
              output tail:
                * main CI is still running
          The control plane recorded this for you; the user did not say it. Read the full output with mcp__orbit__bg_output by id; pass sinceOffset to read only what is new.
        </background-job-wake>
        """

    static let enScheduled = """
        <scheduled-wakeup>
          The wakeup you asked for with schedule_wakeup is due; the control plane opened this turn for it:
            2026-09-15T18:00:00.000Z scheduled 600 seconds out, due 2026-09-15T18:10:00.000Z
            reason: waiting for CI run 4242
            what you left for this turn:
              read the CI result and fix what failed
          The control plane recorded this for you; the user did not say it. To wait again, call mcp__orbit__schedule_wakeup again.
        </scheduled-wakeup>
        """

    // MARK: the wording that shipped until 2026-09-15

    /// run_event 01a0a5ce-df7e-775d-93b2-876856622791.
    static let zhDone = """
        <background-job-wake>
          你用 bg_run 起的后台作业有了你在等的消息，控制面为此给你开了这一轮：
            bgj_cc4b4ef84b39｜watch｜gh run watch 34970575848 --exit-status >/dev/null 2>&1; echo "CI 34970575848 (rerun of Test web, bb4a144ff) exit: $?"｜watch main CI rerun 34970575848
              已结束｜completed｜退出码 0
              输出 /root/.orbit/runs/01a0992f-f058-7605-be10-6a02467ac860/bgj_cc4b4ef84b39.output｜这次说到的是第 0–54 字节
              输出末尾：
                CI 34970575848 (rerun of Test web, bb4a144ff) exit: 1
          这是控制面替你记下的，不是用户说的。完整输出用 mcp__orbit__bg_output 按 id 读，sinceOffset 填上面的起点就只读新的部分。
        </background-job-wake>
        """

    /// run_event 01a09fef-6038-758d-94b8-8c265ee9cc98.
    static let zhFailed = """
        <background-job-wake>
          你用 bg_run 起的后台作业有了你在等的消息，控制面为此给你开了这一轮：
            bgj_209fc7f9f47a｜job｜sleep 5; exit 3｜Smoke: wakeOnExit on a job that exits 3
              已结束｜failed｜退出码 3
              输出 /root/.orbit/runs/e8385a27-7c62-53b7-923c-9e7c048be9c1/bgj_209fc7f9f47a.output｜这次说到的是第 0–0 字节
              （没有输出）
          这是控制面替你记下的，不是用户说的。完整输出用 mcp__orbit__bg_output 按 id 读，sinceOffset 填上面的起点就只读新的部分。
        </background-job-wake>
        """

    /// The old writer's kill line, gloss and full-width brackets and all
    /// (`KILLED_BECAUSE`, `describeTrigger`), plus the sentence it appends for a killed job.
    static let zhKilled = """
        <background-job-wake>
          你用 bg_run 起的后台作业有了你在等的消息，控制面为此给你开了这一轮：
            bgj_1cddac2b7a92｜job｜bash scripts/soak.sh｜Soak: 2h
              已结束｜killed｜原因 runner_shutdown（托管它的 runner 进程停了（重启或自更新），作业跟着被杀）
              输出 /root/.orbit/runs/01a0992f/bgj_1cddac2b7a92.output｜这次说到的是第 0–16570 字节
              （没有输出）
          这是控制面替你记下的，不是用户说的。完整输出用 mcp__orbit__bg_output 按 id 读，sinceOffset 填上面的起点就只读新的部分。
          被杀的作业不会自己回来：还要等，就重新 bg_run。
        </background-job-wake>
        """

    static let zhTwoJobs = """
        <background-job-wake>
          你用 bg_run 起的后台作业有了你在等的消息，控制面为此给你开了这一轮：
            bgj_987dbb363d36｜job｜bash scripts/run-pg-spec.sh src/apiserver/src/tasks/a.pg.spec.ts｜Red run: new pg spec on the unchanged tree
              已结束｜completed｜退出码 0
              输出 /root/.orbit/runs/4f50733a/bgj_987dbb363d36.output｜这次说到的是第 0–9626 字节
              输出末尾：
                ok 1 - the criterion holds
            bgj_645de7bb677b｜watch｜gh run watch 34997433169 --exit-status｜watch main CI 34997433169
              已结束｜failed｜退出码 1
              输出 /root/.orbit/runs/4f50733a/bgj_645de7bb677b.output｜这次说到的是第 0–350697 字节
              输出末尾：
                X Process completed with exit code 1.
          这是控制面替你记下的，不是用户说的。完整输出用 mcp__orbit__bg_output 按 id 读，sinceOffset 填上面的起点就只读新的部分。
        </background-job-wake>
        """

    static let zhNewOutput = """
        <background-job-wake>
          你用 bg_run 起的后台作业有了你在等的消息，控制面为此给你开了这一轮：
            bgj_645de7bb677b｜watch｜gh run watch 34997433169 --exit-status｜watch main CI 34997433169
              有新输出｜running
              输出 /root/.orbit/runs/4f50733a/bgj_645de7bb677b.output｜这次说到的是第 120–460 字节
              输出末尾：
                * main CI is still running
          这是控制面替你记下的，不是用户说的。完整输出用 mcp__orbit__bg_output 按 id 读，sinceOffset 填上面的起点就只读新的部分。
        </background-job-wake>
        """

    /// run_event 01a0a50b-1c0e-72b7-af6b-fd4793c6ef65.
    static let zhScheduled = """
        <scheduled-wakeup>
          你用 schedule_wakeup 约的唤醒到点了，控制面为此给你开了这一轮：
            2026-09-15T11:29:14.912Z 约在 3600 秒后，2026-09-15T12:29:14.911Z 到点
            理由：复跑负载闸门 12:16Z 超时必开跑，12:26Z 检查时应有部分结果；防 waiter 被 drain 杀
            你留给这一轮的话：
              兜底检查：入口 400 复跑 unit rerun-400-104631 现在状态如何？负载闸门 deadline 12:16Z 已过，应已开跑或已完成。
          这是控制面替你记下的，不是用户说的。还要再等，就再调一次 mcp__orbit__schedule_wakeup。
        </scheduled-wakeup>
        """

    /// run_event 01a0a648-e8ca-7644-b92b-825c83b5f8aa: a job whose command runs to several lines of
    /// its own, on a note that carried the coordinator's standing role as well. That block is
    /// shortened here — what is under test is that it stays out of the card, not what it says.
    static let zhWithCoordinatorContext = """
        <background-job-wake>
          你用 bg_run 起的后台作业有了你在等的消息，控制面为此给你开了这一轮：
            bgj_1cddac2b7a92｜watch｜target=3a7686cf2ddad5595c46fe3bd908c2408ef2e8d2
        while true; do
          if gh run list --workflow=ci.yml --commit "$target" --json databaseId,status,conclusion 2>/dev/null | grep -q '"status":"completed"'; then
            break
          fi
          sleep 30
        done
        gh run list --workflow=ci.yml --commit "$target" --json databaseId,conclusion --limit 1 -q '.[0] | "main CI \\(.databaseId) done: \\(.conclusion)"'｜Watch push-triggered main CI for merged tip 3a7686cf2
              已结束｜completed｜退出码 0
              输出 /root/.orbit/runs/01a0992f-f058-7605-be10-6a02467ac860/bgj_1cddac2b7a92.output｜这次说到的是第 0–36 字节
              输出末尾：
                main CI 35005981340 done: cancelled
          这是控制面替你记下的，不是用户说的。完整输出用 mcp__orbit__bg_output 按 id 读，sinceOffset 填上面的起点就只读新的部分。
        </background-job-wake>

        <orbit_project_coordinator_context>
        你是项目（id: 34DGqqkpCEVavXwRLFWKU）的协调会话。

        这里用来协调任务，不是替任务干活。
        </orbit_project_coordinator_context>
        """

    /// Not a wake: this one rides along on somebody's message and stays where it always was.
    static let continuation = """
        <background-jobs>
          你不在的时候结束了：
            bgj_3a1af2b50428｜job｜bash upgrade.sh｜completed｜退出码 0｜输出 /root/.orbit/runs/01a07c80/bgj_3a1af2b50428.output
        </background-jobs>
        """
}

final class BackgroundWakeTests: XCTestCase {

    /// The clock every card test reads against.
    private let now = RelativeTime.parse("2026-09-15T18:14:00.000Z")!

    // MARK: reading a job's wake, in both wordings

    func testReadsEveryFieldOfAJobThatFinished() throws {
        let wake = try XCTUnwrap(BackgroundWakeText.parse(Fixture.enDone))

        XCTAssertEqual(wake.wakeups, [])
        XCTAssertEqual(wake.jobs, [BackgroundWakeJob(
            id: "bgj_13c53745a88a",
            kind: "job",
            command: "/root/orbit/.claude/skills/upgrade/upgrade.sh --pull",
            description: "upgrade to 39551b637",
            status: "completed",
            ended: true,
            exitCode: 0,
            killReason: nil,
            outputPath: "/root/.orbit/runs/4f50733a/bgj_13c53745a88a.output",
            outputFrom: 0,
            outputTo: 16570,
            outputTail: "==> recreating apiserver\n==> apiserver is healthy")])
        // The block itself is kept whole, to be shown exactly as the agent received it.
        XCTAssertEqual(wake.text, Fixture.enDone)
        XCTAssertEqual(wake.rest, "")
    }

    func testReadsTheSameFieldsOutOfTheWordingThatShippedUntilSeptember15() throws {
        let wake = try XCTUnwrap(BackgroundWakeText.parse(Fixture.zhDone))

        XCTAssertEqual(wake.jobs.count, 1)
        let job = try XCTUnwrap(wake.jobs.first)
        XCTAssertEqual(job.id, "bgj_cc4b4ef84b39")
        XCTAssertEqual(job.kind, "watch")
        XCTAssertEqual(job.description, "watch main CI rerun 34970575848")
        XCTAssertEqual(job.status, "completed")
        XCTAssertTrue(job.ended)
        XCTAssertEqual(job.exitCode, 0)
        XCTAssertEqual(job.outputFrom, 0)
        XCTAssertEqual(job.outputTo, 54)
        XCTAssertEqual(job.outputPath,
                       "/root/.orbit/runs/01a0992f-f058-7605-be10-6a02467ac860/bgj_cc4b4ef84b39.output")
        XCTAssertTrue(job.command.contains("gh run watch 34970575848 --exit-status"))
        XCTAssertEqual(job.outputTail, "CI 34970575848 (rerun of Test web, bb4a144ff) exit: 1")
        XCTAssertEqual(wake.text, Fixture.zhDone)
    }

    /// A failure is the whole reason most of these turns wake anybody, and an empty output has to
    /// read as empty rather than as a missing field.
    func testReadsAFailingExitCodeAndAnEmptyOutputInBothWordings() throws {
        for (wording, block) in [("today", Fixture.enTwoJobs), ("older", Fixture.zhTwoJobs)] {
            let failed = try XCTUnwrap(BackgroundWakeText.parse(block)?.jobs.last, wording)
            XCTAssertEqual(failed.status, "failed", wording)
            XCTAssertEqual(failed.exitCode, 1, wording)
            XCTAssertTrue(failed.ended, wording)
            XCTAssertNil(failed.killReason, wording)
        }
        let older = try XCTUnwrap(BackgroundWakeText.parse(Fixture.zhFailed)?.jobs.first)
        XCTAssertEqual(older.id, "bgj_209fc7f9f47a")
        XCTAssertEqual(older.command, "sleep 5; exit 3")
        XCTAssertEqual(older.description, "Smoke: wakeOnExit on a job that exits 3")
        XCTAssertEqual(older.status, "failed")
        XCTAssertEqual(older.exitCode, 3)
        XCTAssertEqual(older.outputTo, 0)
        XCTAssertEqual(older.outputTail, "")
    }

    /// A kill is read by its reason alone: the sentence explaining what a `runner_shutdown` is
    /// belongs to the block, and the two wordings bracket it differently.
    func testReadsAKillByItsReasonAloneInBothWordings() throws {
        for (wording, block) in [("today", Fixture.enKilled), ("older", Fixture.zhKilled)] {
            let job = try XCTUnwrap(BackgroundWakeText.parse(block)?.jobs.first, wording)
            XCTAssertEqual(job.status, "killed", wording)
            XCTAssertTrue(job.ended, wording)
            XCTAssertNil(job.exitCode, wording)
            XCTAssertEqual(job.killReason, "runner_shutdown", wording)
            XCTAssertEqual(job.outputTail, "", wording)
        }
    }

    func testKeepsSeveralJobsApartInTheOrderTheBlockListsThemInBothWordings() throws {
        for (wording, block) in [("today", Fixture.enTwoJobs), ("older", Fixture.zhTwoJobs)] {
            let wake = try XCTUnwrap(BackgroundWakeText.parse(block), wording)
            XCTAssertEqual(wake.jobs.map(\.id), ["bgj_987dbb363d36", "bgj_645de7bb677b"], wording)
            XCTAssertEqual(wake.jobs.map(\.status), ["completed", "failed"], wording)
            XCTAssertEqual(wake.jobs.map(\.exitCode), [0, 1], wording)
            XCTAssertEqual(wake.jobs.map(\.kind), ["job", "watch"], wording)
            XCTAssertEqual(wake.jobs.last?.outputTail, "X Process completed with exit code 1.", wording)
        }
    }

    /// The other trigger: a job that is still running, whose new output opened the turn.
    func testReadsAWakeNewOutputOpenedInBothWordings() throws {
        for (wording, block) in [("today", Fixture.enNewOutput), ("older", Fixture.zhNewOutput)] {
            let job = try XCTUnwrap(BackgroundWakeText.parse(block)?.jobs.first, wording)
            XCTAssertFalse(job.ended, wording)
            XCTAssertEqual(job.status, "running", wording)
            XCTAssertNil(job.exitCode, wording)
            XCTAssertEqual(job.outputFrom, 120, wording)
            XCTAssertEqual(job.outputTo, 460, wording)
            XCTAssertEqual(job.outputTail, "* main CI is still running", wording)
        }
    }

    /// A command of several lines is one command: the fields end where the trigger line starts, not
    /// at the first newline, so the description behind it is still found.
    func testKeepsACommandThatRunsToSeveralLinesWhole() throws {
        let wake = try XCTUnwrap(BackgroundWakeText.parse(Fixture.zhWithCoordinatorContext))

        XCTAssertEqual(wake.jobs.count, 1)
        let job = try XCTUnwrap(wake.jobs.first)
        XCTAssertTrue(job.command.hasPrefix("target=3a7686cf2"))
        XCTAssertTrue(job.command.contains("while true; do"))
        XCTAssertTrue(job.command.contains("sleep 30"))
        XCTAssertEqual(job.description, "Watch push-triggered main CI for merged tip 3a7686cf2")
        XCTAssertEqual(job.status, "completed")
        XCTAssertEqual(job.outputTail, "main CI 35005981340 done: cancelled")
    }

    // MARK: reading a scheduled wakeup, in both wordings

    func testReadsAScheduledWakeupInBothWordings() throws {
        let today = try XCTUnwrap(BackgroundWakeText.parse(Fixture.enScheduled))
        XCTAssertEqual(today.jobs, [])
        XCTAssertEqual(today.wakeups, [ScheduledWakeup(askedAt: "2026-09-15T18:00:00.000Z",
                                                       delaySeconds: 600,
                                                       dueAt: "2026-09-15T18:10:00.000Z",
                                                       reason: "waiting for CI run 4242",
                                                       prompt: "read the CI result and fix what failed")])

        let older = try XCTUnwrap(BackgroundWakeText.parse(Fixture.zhScheduled))
        XCTAssertEqual(older.jobs, [])
        XCTAssertEqual(older.wakeups.count, 1)
        let wakeup = try XCTUnwrap(older.wakeups.first)
        XCTAssertEqual(wakeup.askedAt, "2026-09-15T11:29:14.912Z")
        XCTAssertEqual(wakeup.delaySeconds, 3600)
        XCTAssertEqual(wakeup.dueAt, "2026-09-15T12:29:14.911Z")
        XCTAssertEqual(wakeup.reason?.hasPrefix("复跑负载闸门 12:16Z"), true)
        XCTAssertTrue(wakeup.prompt.hasPrefix("兜底检查："))
    }

    func testCarriesBothBlocksWhenAWakeupCameDueOnAJobsTurn() throws {
        let joined = "\(Fixture.enDone)\n\n\(Fixture.enScheduled)"

        let wake = try XCTUnwrap(BackgroundWakeText.parse(joined))

        XCTAssertEqual(wake.jobs.count, 1)
        XCTAssertEqual(wake.wakeups.count, 1)
        XCTAssertEqual(wake.text, joined)
        XCTAssertEqual(wake.rest, "")
    }

    // MARK: what the card is not given

    func testHandsBackEverythingElseTheSameNoteCarried() throws {
        let wake = try XCTUnwrap(BackgroundWakeText.parse(Fixture.zhWithCoordinatorContext))

        XCTAssertTrue(wake.text.hasPrefix("<background-job-wake>"))
        XCTAssertTrue(wake.text.hasSuffix("</background-job-wake>"))
        XCTAssertFalse(wake.text.contains("orbit_project_coordinator_context"))
        XCTAssertTrue(wake.rest.hasPrefix("<orbit_project_coordinator_context>"))
        XCTAssertTrue(wake.rest.hasSuffix("</orbit_project_coordinator_context>"))
        XCTAssertFalse(wake.rest.contains("bgj_"))
    }

    func testIsNothingAtAllForANoteWithNoWakeInItOrNoNote() {
        // The continuation nudge names the same jobs and is not a wake: it rides along on a message.
        XCTAssertNil(BackgroundWakeText.parse(Fixture.continuation))
        XCTAssertNil(BackgroundWakeText.parse("just a message someone typed"))
        XCTAssertNil(BackgroundWakeText.parse(""))
        XCTAssertNil(BackgroundWakeText.parse(nil))
    }

    /// Better the note as it always read than half a card.
    func testIsNothingAtAllForABlockWhoseFieldsItCannotRead() {
        XCTAssertNil(BackgroundWakeText.parse(
            "<background-job-wake>\n  something else entirely\n</background-job-wake>"))
        XCTAssertNil(BackgroundWakeText.parse(
            "<scheduled-wakeup>\n  something else entirely\n</scheduled-wakeup>"))
    }

    // MARK: the card it becomes

    func testTheCardNamesWhatHappenedForEveryShapeOfWake() throws {
        let one = try XCTUnwrap(BackgroundWakeText.parse(Fixture.enDone))
        XCTAssertEqual(BackgroundWakeCard.title(one), "Background job finished")
        XCTAssertEqual(BackgroundWakeCard.summary(one), "upgrade to 39551b637 exited 0.")

        let failed = try XCTUnwrap(BackgroundWakeText.parse(Fixture.zhFailed))
        XCTAssertEqual(BackgroundWakeCard.title(failed), "Background job failed")
        XCTAssertEqual(BackgroundWakeCard.summary(failed),
                       "Smoke: wakeOnExit on a job that exits 3 exited 3.")

        let killed = try XCTUnwrap(BackgroundWakeText.parse(Fixture.zhKilled))
        XCTAssertEqual(BackgroundWakeCard.title(killed), "Background job failed")
        XCTAssertEqual(BackgroundWakeCard.summary(killed), "Soak: 2h was killed: runner_shutdown.")

        let running = try XCTUnwrap(BackgroundWakeText.parse(Fixture.enNewOutput))
        XCTAssertEqual(BackgroundWakeCard.title(running), "Background job has new output")
        XCTAssertEqual(BackgroundWakeCard.summary(running), "watch main CI 34997433169 has new output.")

        let several = try XCTUnwrap(BackgroundWakeText.parse(Fixture.enTwoJobs))
        XCTAssertEqual(BackgroundWakeCard.title(several), "2 background jobs finished")
        XCTAssertEqual(BackgroundWakeCard.summary(several), "1 of 2 failed.")

        let allDone = try XCTUnwrap(BackgroundWakeText.parse(Fixture.enTwoJobsNoExitCode))
        XCTAssertEqual(BackgroundWakeCard.summary(allDone), "All 2 finished.")

        let wakeup = try XCTUnwrap(BackgroundWakeText.parse(Fixture.enScheduled))
        XCTAssertEqual(BackgroundWakeCard.title(wakeup), "Scheduled wakeup")
        XCTAssertEqual(BackgroundWakeCard.summary(wakeup), "waiting for CI run 4242")
    }

    /// Two jobs that both exited 0 say so; the sentence is the only place a reader is told they all
    /// came out clean without opening the rows.
    func testTheCardCountsSeveralCleanJobs() throws {
        let both = try XCTUnwrap(BackgroundWakeText.parse(
            Fixture.enTwoJobs.replacingOccurrences(of: "ended｜failed｜exit code 1",
                                                   with: "ended｜completed｜exit code 0")))

        XCTAssertEqual(BackgroundWakeCard.summary(both), "All 2 exited 0.")
    }

    func testTheCardsRowsSayWhatEachJobWasAndWhatItWrote() throws {
        let wake = try XCTUnwrap(BackgroundWakeText.parse(Fixture.enDone))
        let job = try XCTUnwrap(wake.jobs.first)

        XCTAssertEqual(BackgroundWakeCard.name(job), "upgrade to 39551b637")
        XCTAssertEqual(BackgroundWakeCard.exitLabel(job), "exit 0")
        XCTAssertEqual(BackgroundWakeCard.jobMeta(job), "bgj_13c53745a88a · 16.2 KB of output")
        XCTAssertEqual(BackgroundWakeCard.outcome(job), "exited 0")

        // A job with nothing to show says so rather than printing a zero.
        let empty = try XCTUnwrap(BackgroundWakeText.parse(Fixture.zhFailed)?.jobs.first)
        XCTAssertEqual(BackgroundWakeCard.jobMeta(empty), "bgj_209fc7f9f47a · no output")
        // A job started without a description is named by the command it ran.
        XCTAssertEqual(BackgroundWakeCard.name(BackgroundWakeJob(
            id: "bgj_1", kind: "job", command: "bash a.sh", description: nil, status: "completed",
            ended: true, exitCode: 0, killReason: nil, outputPath: nil, outputFrom: nil,
            outputTo: nil, outputTail: "")), "bash a.sh")
        XCTAssertEqual(BackgroundWakeCard.formatBytes(54), "54 B")
        XCTAssertEqual(BackgroundWakeCard.formatBytes(350_697), "342.5 KB")
        XCTAssertEqual(BackgroundWakeCard.formatBytes(2 * 1024 * 1024), "2.0 MB")
    }

    /// A kill with no reason recorded still says what happened, and a job that ended with no exit
    /// code is not claimed to have exited anything.
    func testTheCardSaysWhatBecameOfAJobItWasToldLittleAbout() {
        let bare = BackgroundWakeJob(id: "bgj_1", kind: "job", command: "bash a.sh", description: nil,
                                     status: "killed", ended: true, exitCode: nil, killReason: nil,
                                     outputPath: nil, outputFrom: nil, outputTo: nil, outputTail: "")
        XCTAssertEqual(BackgroundWakeCard.outcome(bare), "was killed")
        XCTAssertNil(BackgroundWakeCard.exitLabel(bare))
        XCTAssertEqual(BackgroundWakeCard.jobMeta(bare), "bgj_1")

        let ended = BackgroundWakeJob(id: "bgj_2", kind: "job", command: "bash a.sh", description: nil,
                                      status: "completed", ended: true, exitCode: nil, killReason: nil,
                                      outputPath: nil, outputFrom: nil, outputTo: nil, outputTail: "")
        XCTAssertEqual(BackgroundWakeCard.outcome(ended), "ended completed")
    }

    func testTheCardSaysNobodyTypedItAndKeepsTheOriginalBehindAFold() throws {
        let job = try XCTUnwrap(BackgroundWakeText.parse(Fixture.enDone))
        XCTAssertEqual(BackgroundWakeCard.meta(job, ts: "2026-09-15T18:10:00.000Z", now: now),
                       "Queued by a background job, not typed by you · 4m ago")
        // A card with no timestamp says only the part that is always true.
        XCTAssertEqual(BackgroundWakeCard.meta(job), "Queued by a background job, not typed by you")

        let wakeup = try XCTUnwrap(BackgroundWakeText.parse(Fixture.enScheduled))
        XCTAssertEqual(BackgroundWakeCard.meta(wakeup, ts: "2026-09-15T18:10:00.000Z", now: now),
                       "Queued by a scheduled wakeup, not typed by you · 4m ago")

        XCTAssertEqual(BackgroundWakeCard.rawSummary, "What the agent received")
        XCTAssertEqual(BackgroundWakeCard.undelivered, "The session has not confirmed it received this.")
        XCTAssertEqual(BackgroundWakeCard.tailLines, 8)
    }

    /// The wakeup's own row: how far out it was asked for, and when it came due. The span is the
    /// browser's over the range the control plane clamps a delay to — a minute at the short end, an
    /// hour at the long one.
    func testTheWakeupRowSaysHowFarOutItWasAskedFor() throws {
        let today = try XCTUnwrap(BackgroundWakeText.parse(Fixture.enScheduled)?.wakeups.first)
        XCTAssertEqual(BackgroundWakeCard.wakeupMeta(today, now: now),
                       "Asked for 10m out · came due 4m ago")

        let older = try XCTUnwrap(BackgroundWakeText.parse(Fixture.zhScheduled)?.wakeups.first)
        XCTAssertEqual(BackgroundWakeCard.wakeupMeta(
            older, now: RelativeTime.parse("2026-09-15T12:33:14.911Z")!), "Asked for 1h out · came due 4m ago")

        // The two ends of the clamp, where this client and the browser have to agree exactly.
        let ends = [(60, "Asked for 1m out"), (3_600, "Asked for 1h out")]
        for (delay, said) in ends {
            let wakeup = ScheduledWakeup(askedAt: nil, delaySeconds: delay, dueAt: nil, reason: nil,
                                         prompt: "")
            XCTAssertEqual(BackgroundWakeCard.wakeupMeta(wakeup, now: now), said)
        }
        // Neither half claimed when the block named neither.
        XCTAssertEqual(BackgroundWakeCard.wakeupMeta(
            ScheduledWakeup(askedAt: nil, delaySeconds: nil, dueAt: nil, reason: nil, prompt: ""),
            now: now), "")
    }
}
