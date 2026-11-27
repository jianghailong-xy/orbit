package io.orbitd.android.core.cards

import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
import java.time.Instant

/**
 * A08-11 (iOS dfd3224a4): the scheduled wakeup's line, its fold and its receipt, and what a Job card reads off a job's wake — case for case with OrbitKit's BackgroundWakeTests
 * and BackgroundWakeCopyParityTests, over the blocks the control plane writes today and the Chinese wording that shipped until
 * 2026-09-15 (the fixtures are those tests' own, copied verbatim).
 */
class BackgroundWakeCardTest {
    private val enDone = "<background-job-wake>\n  A background job you started with bg_run has news you were waiting for; the control plane opened this turn for it:\n    bgj_13c53745a88a｜job｜/root/orbit/.claude/skills/upgrade/upgrade.sh --pull｜upgrade to 39551b637\n      ended｜completed｜exit code 0\n      output /root/.orbit/runs/4f50733a/bgj_13c53745a88a.output｜this covers bytes 0–16570\n      output tail:\n        ==> recreating apiserver\n        ==> apiserver is healthy\n  The control plane recorded this for you; the user did not say it. Read the full output with mcp__orbit__bg_output by id; pass sinceOffset to read only what is new.\n</background-job-wake>"
    private val enKilled = "<background-job-wake>\n  A background job you started with bg_run has news you were waiting for; the control plane opened this turn for it:\n    bgj_13c53745a88a｜job｜/root/orbit/.claude/skills/upgrade/upgrade.sh --pull｜upgrade to 39551b637\n      ended｜killed｜reason runner_shutdown (the runner process hosting it stopped — a restart or a self-update — and the job was killed with it)\n      output /root/.orbit/runs/4f50733a/bgj_13c53745a88a.output｜this covers bytes 0–16570\n      (no output)\n  The control plane recorded this for you; the user did not say it. Read the full output with mcp__orbit__bg_output by id; pass sinceOffset to read only what is new.\n  A killed job does not come back on its own: to keep waiting, start it again with bg_run.\n</background-job-wake>"
    private val enTwoJobs = "<background-job-wake>\n  A background job you started with bg_run has news you were waiting for; the control plane opened this turn for it:\n    bgj_987dbb363d36｜job｜bash scripts/run-pg-spec.sh src/apiserver/src/tasks/a.pg.spec.ts｜Red run: new pg spec on the unchanged tree\n      ended｜completed｜exit code 0\n      output /root/.orbit/runs/4f50733a/bgj_987dbb363d36.output｜this covers bytes 0–9626\n      output tail:\n        ok 1 - the criterion holds\n    bgj_645de7bb677b｜watch｜gh run watch 34997433169 --exit-status｜watch main CI 34997433169\n      ended｜failed｜exit code 1\n      output /root/.orbit/runs/4f50733a/bgj_645de7bb677b.output｜this covers bytes 0–350697\n      output tail:\n        X Process completed with exit code 1.\n  The control plane recorded this for you; the user did not say it. Read the full output with mcp__orbit__bg_output by id; pass sinceOffset to read only what is new.\n</background-job-wake>"
    private val enTwoJobsNoExitCode = "<background-job-wake>\n  A background job you started with bg_run has news you were waiting for; the control plane opened this turn for it:\n    bgj_987dbb363d36｜job｜bash a.sh｜First\n      ended｜completed\n      output /root/.orbit/runs/4f50733a/bgj_987dbb363d36.output｜this covers bytes 0–10\n      (no output)\n    bgj_645de7bb677b｜job｜bash b.sh｜Second\n      ended｜completed｜exit code 0\n      output /root/.orbit/runs/4f50733a/bgj_645de7bb677b.output｜this covers bytes 0–10\n      (no output)\n  The control plane recorded this for you; the user did not say it. Read the full output with mcp__orbit__bg_output by id; pass sinceOffset to read only what is new.\n</background-job-wake>"
    private val enNewOutput = "<background-job-wake>\n  A background job you started with bg_run has news you were waiting for; the control plane opened this turn for it:\n    bgj_645de7bb677b｜watch｜gh run watch 34997433169 --exit-status｜watch main CI 34997433169\n      new output｜running\n      output /root/.orbit/runs/4f50733a/bgj_645de7bb677b.output｜this covers bytes 120–460\n      output tail:\n        * main CI is still running\n  The control plane recorded this for you; the user did not say it. Read the full output with mcp__orbit__bg_output by id; pass sinceOffset to read only what is new.\n</background-job-wake>"
    private val enScheduled = "<scheduled-wakeup>\n  The wakeup you asked for with schedule_wakeup is due; the control plane opened this turn for it:\n    2026-09-15T18:00:00.000Z scheduled 600 seconds out, due 2026-09-15T18:10:00.000Z\n    reason: waiting for CI run 4242\n    what you left for this turn:\n      read the CI result and fix what failed\n  The control plane recorded this for you; the user did not say it. To wait again, call mcp__orbit__schedule_wakeup again.\n</scheduled-wakeup>"
    private val zhFailed = "<background-job-wake>\n  你用 bg_run 起的后台作业有了你在等的消息，控制面为此给你开了这一轮：\n    bgj_209fc7f9f47a｜job｜sleep 5; exit 3｜Smoke: wakeOnExit on a job that exits 3\n      已结束｜failed｜退出码 3\n      输出 /root/.orbit/runs/e8385a27-7c62-53b7-923c-9e7c048be9c1/bgj_209fc7f9f47a.output｜这次说到的是第 0–0 字节\n      （没有输出）\n  这是控制面替你记下的，不是用户说的。完整输出用 mcp__orbit__bg_output 按 id 读，sinceOffset 填上面的起点就只读新的部分。\n</background-job-wake>"
    private val zhKilled = "<background-job-wake>\n  你用 bg_run 起的后台作业有了你在等的消息，控制面为此给你开了这一轮：\n    bgj_1cddac2b7a92｜job｜bash scripts/soak.sh｜Soak: 2h\n      已结束｜killed｜原因 runner_shutdown（托管它的 runner 进程停了（重启或自更新），作业跟着被杀）\n      输出 /root/.orbit/runs/01a0992f/bgj_1cddac2b7a92.output｜这次说到的是第 0–16570 字节\n      （没有输出）\n  这是控制面替你记下的，不是用户说的。完整输出用 mcp__orbit__bg_output 按 id 读，sinceOffset 填上面的起点就只读新的部分。\n  被杀的作业不会自己回来：还要等，就重新 bg_run。\n</background-job-wake>"
    private val zhScheduled = "<scheduled-wakeup>\n  你用 schedule_wakeup 约的唤醒到点了，控制面为此给你开了这一轮：\n    2026-09-15T11:29:14.912Z 约在 3600 秒后，2026-09-15T12:29:14.911Z 到点\n    理由：复跑负载闸门 12:16Z 超时必开跑，12:26Z 检查时应有部分结果；防 waiter 被 drain 杀\n    你留给这一轮的话：\n      兜底检查：入口 400 复跑 unit rerun-400-104631 现在状态如何？负载闸门 deadline 12:16Z 已过，应已开跑或已完成。读 /root/.orbit/uploads/01a0992f-f058-7605-be10-6a02467ac860/scratch/rerun-400-1046.log 尾部与 systemctl show -p Result,ExecMainStatus rerun-400-104631.service 处理结论；仍在跑则续挂兜底。\n  这是控制面替你记下的，不是用户说的。还要再等，就再调一次 mcp__orbit__schedule_wakeup。\n</scheduled-wakeup>"
    private val zhWithCoordinatorContext = "<background-job-wake>\n  你用 bg_run 起的后台作业有了你在等的消息，控制面为此给你开了这一轮：\n    bgj_1cddac2b7a92｜watch｜target=3a7686cf2ddad5595c46fe3bd908c2408ef2e8d2\nwhile true; do\n  if gh run list --workflow=ci.yml --commit \"\$target\" --json databaseId,status,conclusion 2>/dev/null | grep -q '\"status\":\"completed\"'; then\n    break\n  fi\n  sleep 30\ndone\ngh run list --workflow=ci.yml --commit \"\$target\" --json databaseId,conclusion --limit 1 -q '.[0] | \"main CI \\\\(.databaseId) done: \\\\(.conclusion)\"'｜Watch push-triggered main CI for merged tip 3a7686cf2\n      已结束｜completed｜退出码 0\n      输出 /root/.orbit/runs/01a0992f-f058-7605-be10-6a02467ac860/bgj_1cddac2b7a92.output｜这次说到的是第 0–36 字节\n      输出末尾：\n        main CI 35005981340 done: cancelled\n  这是控制面替你记下的，不是用户说的。完整输出用 mcp__orbit__bg_output 按 id 读，sinceOffset 填上面的起点就只读新的部分。\n</background-job-wake>\n\n<orbit_project_coordinator_context>\n你是项目（id: 34DGqqkpCEVavXwRLFWKU）的协调会话。\n\n这里用来跟进这个项目的进展、协调它下面的任务，不是用来替它干活的——具体实现交给各个任务自己的会话去做。\n\n先读再说：用 project_get 读这个项目的目标、验收标准和作业指导，再用 task_list（projectId 传上面那个 id）看它下面的任务各自停在哪里。这两样都不在任务的描述里，不读就只能靠猜。读完先简短汇报现状。\n\n推进靠的是跟人对话：把现状说清楚，该问的问，商量下一步，然后动手。没有任何自动的环会替你决定什么时候动。\n\n该动的时候你手上有工具：project_update 改这个项目的标题、目标、作业指导；task_create、task_update、task_start 管它下面的任务。\n\n这条会话里冒出来的新工作，记成这个项目下的任务，别提议新建项目：一个会话只能协调一个项目，从这里建一个只会让服务器另开一条会话去接手它，而那条会话对这里的来龙去脉一无所知。真觉得该另起一个项目，把理由说清楚，交给屏幕这边的账号所有者去开。\n\n有两件事不是你来定：改这个项目的验收标准，和把它记成 DONE。验收标准是判定这个项目做没做完的那把尺子，改尺子的人可以让任何结论成立；DONE 是「目标达成了」这句话本身，说错了没有下游会再问一遍。这两件都由账号所有者通道记录——你把该改什么、还差什么说清楚，让屏幕这边的账号所有者决定。这里的 HUMAN_ONLY 是角色隔离和按动作留痕，不是服务器对“真人在场”的密码学证明。\n\n没给你的工具就别去找：列出或删除项目、另开一个协调会话、直接指挥 runner，都不在你手上。\n</orbit_project_coordinator_context>"
    // A quiet job's wake (`buildBackgroundStallBlock`), line for line OrbitKit BackgroundWakeTests' enStall / enStallSilent / enTwoStalls.
    private val stallHead = "  A background job you started with bg_run is still running and has written nothing for as long as you asked to be told about; the control plane opened this turn for it:"
    private val stallFoot = "  The control plane recorded this for you; the user did not say it. The job has not ended: read its output with mcp__orbit__bg_output by id (pass sinceOffset to read only what is new), stop it with mcp__orbit__bg_kill, or leave it running.\n  One silence wakes you once: you are woken again only if the job writes something and then goes quiet as long again."
    private val enStall = listOf("<background-job-stall>", stallHead,
        "    bgj_28a9b17fe75c｜job｜./scripts/rebuild-index.sh --workers 6｜Nightly index rebuild (6 workers)",
        "      gone quiet｜still running｜running for 15m 2s when this was sent",
        "      no new output for 15m 0s｜last output at 2026-09-15T17:59:00Z",
        "      output /root/.orbit/runs/4f50733a/bgj_28a9b17fe75c.output｜this covers bytes 0–21",
        "      output tail:", "        entries=32 workers=6", stallFoot, "</background-job-stall>").joinToString("\n")
    private val enStallSilent = listOf("<background-job-stall>", stallHead,
        "    bgj_5c03e1aa90d2｜job｜pg_dump orbit > /backup/orbit.sql",
        "      gone quiet｜still running｜running for 30m 0s when this was sent",
        "      no output at all｜it has written nothing in the 30m 0s since it started",
        "      output /root/.orbit/runs/4f50733a/bgj_5c03e1aa90d2.output｜this covers bytes 0–0",
        "      (no output)", stallFoot, "</background-job-stall>").joinToString("\n")
    private val enTwoStalls = listOf("<background-job-stall>", stallHead,
        "    bgj_28a9b17fe75c｜job｜./scripts/rebuild-index.sh --workers 6｜Nightly index rebuild (6 workers)",
        "      gone quiet｜still running｜running for 15m 2s when this was sent",
        "      no new output for 15m 0s｜last output at 2026-09-15T17:59:00Z",
        "      output /root/.orbit/runs/4f50733a/bgj_28a9b17fe75c.output｜this covers bytes 0–21",
        "    bgj_91b7c2e0d4f1｜job｜npm run e2e -- --project=staging｜E2E suite against staging",
        "      gone quiet｜still running｜running for 1h 2m 5s when this was sent",
        "      no new output for 10m 0s｜last output at 2026-09-15T18:04:00Z",
        "      output /root/.orbit/runs/4f50733a/bgj_91b7c2e0d4f1.output｜this covers bytes 0–3481",
        stallFoot, "</background-job-stall>").joinToString("\n")
    private val now = Instant.parse("2026-09-15T18:14:00.000Z")
    private fun wake(note: String) = requireNotNull(backgroundWake(note)) { "the note reads as a wake" }

    /** Board C1 (file 350t1lTONlrPMjilBdXx7): a job's end, new output or stall draws no line — its Job card says it — and a wakeup that
     * came due keeps its line, beside a job's news or alone. */
    @Test fun onlyAScheduledWakeupIsStillALine() {
        listOf(enDone, enKilled, enTwoJobs, enNewOutput, zhFailed, zhKilled, enStall, enTwoStalls).forEach { note ->
            assertNull(note, BgJob.wakeupsOnly(wake(note)))
        }
        val wakeup = wake(enScheduled)
        assertSame(wakeup, BgJob.wakeupsOnly(wakeup))
        assertEquals("Scheduled wakeup", BackgroundWakeCard.title)
        assertEquals("waiting for CI run 4242", BackgroundWakeCard.lineName(wakeup))
        val both = requireNotNull(BgJob.wakeupsOnly(wake("$enDone\n\n$enScheduled")))
        assertTrue(BackgroundWakeCard.jobs(both).isEmpty())
        assertEquals("waiting for CI run 4242", BackgroundWakeCard.lineName(both))
        assertNotNull(BackgroundWakeCard.lineName(wake(zhScheduled)))
    }

    /** What a Job card reads off a wake: each job's id, status, exit code, kill reason and the tail it carried. */
    @Test fun aWakeStillReadsEveryJobItCarries() {
        val done = BackgroundWakeCard.jobs(wake(enDone)).single()
        assertEquals("bgj_13c53745a88a", done.text("id"))
        assertEquals("upgrade to 39551b637", done.text("description"))
        assertTrue(done.flag("ended")); assertEquals(0, done.number("exitCode"))
        assertEquals("==> recreating apiserver\n==> apiserver is healthy", done.text("outputTail"))
        assertEquals(16570, done.number("outputTo"))
        val failed = BackgroundWakeCard.jobs(wake(zhFailed)).single()
        assertEquals("failed", failed.text("status")); assertEquals(3, failed.number("exitCode"))
        assertEquals("runner_shutdown", BackgroundWakeCard.jobs(wake(zhKilled)).single().text("killReason"))
        assertEquals("runner_shutdown", BackgroundWakeCard.jobs(wake(enKilled)).single().text("killReason"))
        assertEquals(listOf("bgj_987dbb363d36", "bgj_645de7bb677b"), BgJob.jobIds(wake(enTwoJobs)))
        val news = BackgroundWakeCard.jobs(wake(enNewOutput)).single()
        assertFalse(news.flag("ended")); assertEquals("* main CI is still running", news.text("outputTail"))
        assertEquals(listOf(null, 0), BackgroundWakeCard.jobs(wake(enTwoJobsNoExitCode)).map { it.number("exitCode") })
    }

    @Test fun theFoldSaysNobodyTypedItAndKeepsTheOriginalBehindIt() {
        assertEquals("Queued by a scheduled wakeup, not typed by you", BackgroundWakeCard.meta)
        assertEquals("What the agent received", BackgroundWakeCard.rawSummary)
        assertEquals("The session has not confirmed it received this.", BackgroundWakeCard.undelivered)
        assertEquals(8, BackgroundWakeCard.tailLines)
        // What the agent received is the blocks themselves; whatever else the note carried is not the line's.
        assertEquals(enDone, wake(enDone).text("text"))
        val withContext = wake(zhWithCoordinatorContext)
        assertTrue(withContext.text("text")!!.startsWith("<background-job-wake>"))
        assertFalse(withoutWakeBlocks(zhWithCoordinatorContext).contains("<background-job-wake>"))
        assertTrue(withoutWakeBlocks(zhWithCoordinatorContext).isNotBlank())
    }

    @Test fun aSteeredWakeSaysHowFarItGotInASteersWords() {
        val said = { delivery: String? -> BackgroundWakeCard.steerState(true, delivery, false) }
        assertEquals("waiting for the runner: no event exists yet", "Sending…", said(null))
        assertEquals("Sending…", said("enqueued"))
        assertEquals("Waiting to be read", said("written"))
        assertEquals("Read in this turn", said("acknowledged"))
        assertEquals("Queued for next turn instead", said("requeued"))
        assertNull(said("failed"))
        assertNull(said("unconfirmed"))
        assertNull(BackgroundWakeCard.steerState(true, "written", true))
        assertNull(BackgroundWakeCard.steerState(false, "written", false))
        assertNull(BackgroundWakeCard.steerState(false, null, false))
    }

    /** The card keeps the delivery's own words, the confirmed receipt included, and says its details as iOS and the web do. */
    @Test fun theCardSaysItsReceiptAndItsDetailsInTheWordsIosDraws() {
        assertEquals("Read in this turn", BackgroundWakeCard.steerReceipt("Read in this turn"))
        assertEquals("Waiting to be read", BackgroundWakeCard.steerReceipt("Waiting to be read"))
        assertNull(BackgroundWakeCard.steerReceipt(null))
        assertEquals("Details", BackgroundWakeCard.details)
    }

    @Test fun theWakeupRowSaysHowFarOutItWasAskedFor() {
        val today = BackgroundWakeCard.wakeups(wake(enScheduled)).first()
        assertEquals("Asked for 10m out · came due 4m ago", BackgroundWakeCard.wakeupMeta(today, now))
        val older = BackgroundWakeCard.wakeups(wake(zhScheduled)).first()
        assertEquals("Asked for 1h out · came due 4m ago", BackgroundWakeCard.wakeupMeta(older, Instant.parse("2026-09-15T12:33:14.911Z")))
        listOf(60 to "Asked for 1m out", 3_600 to "Asked for 1h out").forEach { (delay, said) ->
            assertEquals(said, BackgroundWakeCard.wakeupMeta(buildJsonObject { put("delaySeconds", delay) }, now))
        }
        assertEquals("", BackgroundWakeCard.wakeupMeta(buildJsonObject { }, now))
    }

    /** A job gone quiet: its stall block still reads, for its Job card's amber chip (board B1), and draws no line of its own. */
    @Test fun aJobGoneQuietStillReadsHowLongItHasBeenQuiet() {
        val one = wake(enStall)
        val job = BackgroundWakeCard.jobs(one).single()
        assertEquals("running", job.text("status"))
        assertFalse(job.flag("ended"))
        assertEquals("entries=32 workers=6", job.text("outputTail"))
        assertEquals(21, job.number("outputTo"))
        val stall = requireNotNull(job.obj("stall"))
        assertEquals(15 * 60_000L + 2000, stall["runningForMs"]?.jsonPrimitive?.long)
        assertEquals(15 * 60_000L, stall["quietForMs"]?.jsonPrimitive?.long)
        assertEquals("2026-09-15T17:59:00Z", stall.text("lastOutputAt"))
        assertEquals(enStall, one.text("text"))
        assertEquals("", withoutWakeBlocks(enStall))
        assertNotNull(queuedWake(enStall))
        assertNull(BgJob.wakeupsOnly(one))

        val silent = BackgroundWakeCard.jobs(wake(enStallSilent)).single().obj("stall")!!
        assertEquals(30 * 60_000L, silent["quietForMs"]?.jsonPrimitive?.long)
        assertTrue(silent.flag("wroteNothing"))

        val mixed = wake("$enDone\n\n$enStall")
        assertEquals(listOf(true, false), BackgroundWakeCard.jobs(mixed).map { it.flag("ended") })
        assertEquals(listOf(false, true), BackgroundWakeCard.jobs(mixed).map { it.obj("stall") != null })
    }

    @Test fun aTurnThatIsOnlyANoteDrawsTheNoteAlone() {
        val note = "<orbit-future-block>\n  Something a later server sends.\n</orbit-future-block>"
        assertTrue(BackgroundWakeCard.drawsNoteAlone("", hasAttachments = false, note = note, queued = false))
        assertFalse(BackgroundWakeCard.drawsNoteAlone("hi", hasAttachments = false, note = note, queued = false))
        assertFalse(BackgroundWakeCard.drawsNoteAlone("", hasAttachments = true, note = note, queued = false))
        assertFalse(BackgroundWakeCard.drawsNoteAlone("", hasAttachments = false, note = note, queued = true))
        assertFalse(BackgroundWakeCard.drawsNoteAlone("", hasAttachments = false, note = null, queued = false))
        assertEquals(2 * 3_600_000L + 5 * 60_000L, durationMs("2h 5m 0s"))
        assertNull(durationMs("15 minutes"))
    }
}
