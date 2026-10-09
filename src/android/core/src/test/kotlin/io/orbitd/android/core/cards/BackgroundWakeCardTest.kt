package io.orbitd.android.core.cards

import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
import java.time.Instant

/**
 * A08-11 (iOS dfd3224a4): the background wake's line, its fold and its receipt — case for case with OrbitKit's BackgroundWakeTests
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
    private val now = Instant.parse("2026-09-15T18:14:00.000Z")
    private fun wake(note: String) = requireNotNull(backgroundWake(note)) { "the note reads as a wake" }

    @Test fun theLineSaysWhatHappenedForEveryShapeOfWake() {
        val one = wake(enDone)
        assertEquals("Background job finished", BackgroundWakeCard.title(one))
        assertEquals("upgrade to 39551b637", BackgroundWakeCard.lineName(one))
        assertEquals("exit 0", BackgroundWakeCard.lineStatus(one))
        assertFalse(BackgroundWakeCard.isPending(one))
        val failed = wake(zhFailed)
        assertEquals("Background job failed", BackgroundWakeCard.title(failed))
        assertEquals("Smoke: wakeOnExit on a job that exits 3", BackgroundWakeCard.lineName(failed))
        assertEquals("exit 3", BackgroundWakeCard.lineStatus(failed))
        val killed = wake(zhKilled)
        assertEquals("Background job failed", BackgroundWakeCard.title(killed))
        assertEquals("Soak: 2h", BackgroundWakeCard.lineName(killed))
        assertEquals("killed: runner_shutdown", BackgroundWakeCard.lineStatus(killed))
        val running = wake(enNewOutput)
        assertEquals("Background job has new output", BackgroundWakeCard.title(running))
        assertEquals("watch main CI 34997433169", BackgroundWakeCard.lineName(running))
        assertNull(BackgroundWakeCard.lineStatus(running))
        assertTrue(BackgroundWakeCard.isPending(running))
        val several = wake(enTwoJobs)
        assertEquals("2 background jobs finished", BackgroundWakeCard.title(several))
        assertNull(BackgroundWakeCard.lineName(several))
        assertEquals("1 of 2 failed", BackgroundWakeCard.lineStatus(several))
        val wakeup = wake(enScheduled)
        assertEquals("Scheduled wakeup", BackgroundWakeCard.title(wakeup))
        assertEquals("waiting for CI run 4242", BackgroundWakeCard.lineName(wakeup))
        assertNull(BackgroundWakeCard.lineStatus(wakeup))
        assertTrue(BackgroundWakeCard.isPending(wakeup))
    }

    @Test fun theLineSaysNothingMoreOfSeveralCleanJobs() {
        val both = wake(enTwoJobs.replace("ended｜failed｜exit code 1", "ended｜completed｜exit code 0"))
        assertNull(BackgroundWakeCard.lineStatus(both))
        assertFalse(BackgroundWakeCard.isPending(both))
        assertNull(BackgroundWakeCard.lineStatus(wake(enTwoJobsNoExitCode)))
    }

    @Test fun theFoldsRowsSayWhatEachJobWasAndWhatItWrote() {
        val job = BackgroundWakeCard.jobs(wake(enDone)).first()
        assertEquals("upgrade to 39551b637", BackgroundWakeCard.name(job))
        assertEquals("exit 0", BackgroundWakeCard.status(job))
        assertEquals("bgj_13c53745a88a · 16.2 KB of output", BackgroundWakeCard.jobMeta(job))
        assertEquals("bgj_209fc7f9f47a · no output", BackgroundWakeCard.jobMeta(BackgroundWakeCard.jobs(wake(zhFailed)).first()))
        val bare = buildJsonObject { put("id", "bgj_1"); put("kind", "job"); put("command", "bash a.sh"); put("status", "completed"); put("ended", true); put("exitCode", 0) }
        assertEquals("bash a.sh", BackgroundWakeCard.name(bare))
        assertEquals("bash a.sh", BackgroundWakeCard.lineName(buildJsonObject { put("jobs", JsonArray(listOf(bare))); putJsonArray("wakeups") {} }))
        assertEquals("54 B", BackgroundWakeCard.formatBytes(54))
        assertEquals("342.5 KB", BackgroundWakeCard.formatBytes(350_697))
        assertEquals("2.0 MB", BackgroundWakeCard.formatBytes(2 * 1024 * 1024))
    }

    @Test fun theLineSaysWhatBecameOfAJobItWasToldLittleAbout() {
        val killed = buildJsonObject { put("id", "bgj_1"); put("command", "bash a.sh"); put("status", "killed"); put("ended", true) }
        assertEquals("killed", BackgroundWakeCard.status(killed))
        assertEquals("bgj_1", BackgroundWakeCard.jobMeta(killed))
        val ended = buildJsonObject { put("id", "bgj_2"); put("command", "bash a.sh"); put("status", "completed"); put("ended", true) }
        assertEquals("completed", BackgroundWakeCard.status(ended))
    }

    @Test fun theFoldSaysNobodyTypedItAndKeepsTheOriginalBehindIt() {
        assertEquals("Queued by a background job, not typed by you", BackgroundWakeCard.meta(wake(enDone)))
        assertEquals("Queued by a scheduled wakeup, not typed by you", BackgroundWakeCard.meta(wake(enScheduled)))
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
        assertEquals("Delivering…", said("written"))
        assertEquals("Sent into this turn", said("acknowledged"))
        assertEquals("Queued for next turn instead", said("requeued"))
        assertNull(said("failed"))
        assertNull(said("unconfirmed"))
        assertNull(BackgroundWakeCard.steerState(true, "written", true))
        assertNull(BackgroundWakeCard.steerState(false, "written", false))
        assertNull(BackgroundWakeCard.steerState(false, null, false))
    }

    /** The card keeps the delivery's own words, the confirmed receipt included, and says its details and output tail as iOS and the web do. */
    @Test fun theCardSaysItsReceiptAndItsDetailsInTheWordsIosDraws() {
        assertEquals("Sent into this turn", BackgroundWakeCard.steerReceipt("Sent into this turn"))
        assertEquals("Delivering…", BackgroundWakeCard.steerReceipt("Delivering…"))
        assertNull(BackgroundWakeCard.steerReceipt(null))
        assertEquals("Job details", BackgroundWakeCard.detailsLabel(wake(enDone)))
        assertEquals("Details", BackgroundWakeCard.detailsLabel(wake(enScheduled)))
        assertEquals("Output tail", BackgroundWakeCard.outputTail)
        assertEquals("Show full output", BackgroundWakeCard.expandOutput)
        assertEquals("Show less", BackgroundWakeCard.collapseOutput)
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
}
