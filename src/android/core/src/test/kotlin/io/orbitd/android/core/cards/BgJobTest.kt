package io.orbitd.android.core.cards

import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
import java.time.ZoneOffset

/**
 * A bg_run job's one card (board 350t1lTONlrPMjilBdXx7, rulings R1-R4; web `lib/bgJobCard.test.ts`): what it reads off the call's receipt,
 * its row of the Background list, its wakes and the tail read, joined by job id.
 */
class BgJobTest {
    private fun wakeBlock(id: String, trigger: String, tail: String? = null, description: String = "Wait for CI") =
        "<background-job-wake>\n  A background job you started with bg_run has news you were waiting for; the control plane opened this turn for it:\n" +
            "    $id｜watch｜gh run watch 1 --exit-status｜$description\n      $trigger\n" +
            "      output /root/.orbit/runs/x/$id.output｜this covers bytes 0–40\n" +
            (if (tail != null) "      output tail:\n" + tail.lines().joinToString("\n") { "        $it" } + "\n" else "      (no output)\n") +
            "  The control plane recorded this for you; the user did not say it.\n</background-job-wake>"
    private val stall = listOf("<background-job-stall>",
        "  A background job you started with bg_run is still running and has written nothing for as long as you asked to be told about; the control plane opened this turn for it:",
        "    bgj_a1｜job｜./deploy.sh｜Deploy 5dd308afd",
        "      gone quiet｜still running｜running for 22m 0s when this was sent",
        "      no new output for 10m 0s｜last output at 2026-11-21T10:20:00Z",
        "      output /root/.orbit/runs/x/bgj_a1.output｜this covers bytes 0–21",
        "      output tail:", "        Waiting for apiserver-next to pass its health check…",
        "  The control plane recorded this for you; the user did not say it.", "</background-job-stall>").joinToString("\n")

    private fun seen(note: String, ts: String = "2026-11-21T10:32:00Z", delivered: Boolean = true) =
        BgJob.wakesOf(listOf(BgJob.Turn(note, ts, delivered))).values.single()
    private fun shell(vararg fields: Pair<String, Any>) = buildJsonObject {
        put("shellId", "bgj_a1"); put("kind", "job")
        fields.forEach { (k, v) -> when (v) { is String -> put(k, v); is Int -> put(k, v); is Boolean -> put(k, v) } }
    }
    private fun tail(status: String, vararg lines: String, exitCode: Int? = null) = buildJsonObject {
        put("jobId", "bgj_a1"); put("status", status); put("exitCode", exitCode?.let(::JsonPrimitive) ?: JsonNull)
        putJsonArray("lines") { lines.forEach { add(it) } }
    }

    @Test fun theCallsReceiptNamesItsJobAndWhenItStarted() {
        assertEquals(BgJob.Receipt("bgj_359822f74c72", "2026-11-21T05:33:46Z"),
            BgJob.receipt("""{"receiptVersion":1,"entity":{"jobId":"bgj_359822f74c72","status":"running","startedAt":"2026-11-21T05:33:46Z"}}"""))
        assertEquals(BgJob.Receipt("bgj_ab12", null), BgJob.receipt("started bgj_ab12 in the background"))
        assertNull(BgJob.receipt("""{"ok":false,"error":{"code":"PERMISSION"}}"""))
        assertNull(BgJob.receipt(null))
    }

    @Test fun theRunnersLaunchPairIsNoCardOfItsOwn() {
        val input = buildJsonObject { put("command", "make"); put("run_in_background", true) }
        assertTrue(BgJob.isRunnerJobLaunch("Bash", "bgj_1", input))
        assertFalse(BgJob.isRunnerJobLaunch("Bash", "toolu_1", input))
        assertFalse(BgJob.isRunnerJobLaunch("Bash", "bgj_1", buildJsonObject { put("command", "make") }))
        assertFalse(BgJob.isRunnerJobLaunch(BgJob.TOOL, "bgj_1", input))
    }

    @Test fun wakesJoinTheirJobByIdOldestFirstAndKnowWhetherTheAgentReadThem() {
        val news = wakeBlock("bgj_a1", "new output｜running", "check Swift → success")
        val end = wakeBlock("bgj_a1", "ended｜failed｜exit code 1", "run ended before JavaScript finished: completed cancelled")
        val other = wakeBlock("bgj_b2", "ended｜completed｜exit code 0")
        val wakes = BgJob.wakesOf(listOf(BgJob.Turn(news, "2026-11-21T10:25:00Z", true), BgJob.Turn("not a wake", null, true),
            BgJob.Turn("$end\n\n$other", "2026-11-21T10:32:00Z", false)))
        assertEquals(setOf("bgj_a1", "bgj_b2"), wakes.keys)
        val a1 = wakes.getValue("bgj_a1")
        assertEquals(listOf("2026-11-21T10:25:00Z", "2026-11-21T10:32:00Z"), a1.map { it.ts })
        assertEquals(listOf("2026-11-21T10:25:00Z", null), a1.map { it.readAt })
        assertTrue(a1.last().text.startsWith("<background-job-wake>"))
        val utc = ZoneOffset.UTC
        assertEquals("10:25 · new output · read by the agent at 10:25", BgJob.wakeRow(a1.first(), utc))
        assertEquals("10:32 · exit 1", BgJob.wakeRow(a1.last(), utc))
        assertEquals("10:32 · quiet 10m · read by the agent at 10:32", BgJob.wakeRow(seen(stall).single(), utc))
        assertEquals("Woke the agent 1 time", BgJob.woke(1))
        assertEquals("Woke the agent 2 times", BgJob.woke(2))
    }

    @Test fun eachFoldedStateComesFromTheRunnersReportItsWakeOrTheTailRead() {
        // Running: the session is live, or its row says so; quiet once its newest wake said it went quiet (B1).
        assertEquals(BgJob.Phase.RUNNING, BgJob.state(null, emptyList(), null, live = true).phase)
        assertEquals(BgJob.Phase.RUNNING, BgJob.state(shell("status" to "running"), emptyList(), null, live = false).phase)
        assertEquals(BgJob.Phase.UNKNOWN, BgJob.state(null, emptyList(), null, live = false).phase)
        val quiet = BgJob.state(null, seen(stall), null, live = true)
        assertEquals(BgJob.Phase.RUNNING, quiet.phase); assertEquals(600_000L, quiet.quietMs)
        assertEquals("quiet 10m", BgJob.quiet(quiet.quietMs!!))
        assertNull(BgJob.state(null, seen(wakeBlock("bgj_a1", "new output｜running", "x")), null, true).quietMs)
        // Its runner's report wins; exit 0 is done, exit N failed.
        val done = BgJob.state(shell("terminal" to "done", "exitCode" to 0, "endedAt" to "2026-11-21T10:04:02Z"), emptyList(), null, true)
        assertEquals(BgJob.State(BgJob.Phase.DONE, 0, null, null, "2026-11-21T10:04:02Z"), done)
        assertEquals(BgJob.Phase.FAILED, BgJob.state(shell("terminal" to "done", "exitCode" to 1), emptyList(), null, true).phase)
        assertEquals(1, BgJob.state(shell("terminal" to "failed", "exitCode" to 1), emptyList(), null, true).exitCode)
        // Killed: no exit code, and who stopped it.
        val killed = BgJob.state(shell("terminal" to "killed", "reason" to "stopped_by_owner", "exitCode" to 137), emptyList(), null, true)
        assertEquals(BgJob.Phase.KILLED, killed.phase); assertNull(killed.exitCode); assertEquals("stopped_by_owner", killed.reason)
        // Without a report loaded: its end's wake, written when it ended.
        val endWake = seen(wakeBlock("bgj_a1", "ended｜failed｜exit code 1", "boom"))
        assertEquals(BgJob.State(BgJob.Phase.FAILED, 1, null, null, "2026-11-21T10:32:00Z"), BgJob.state(null, endWake, null, true))
        val killWake = seen(wakeBlock("bgj_a1", "ended｜killed｜reason requested (you killed it)"))
        assertEquals("requested", BgJob.state(null, killWake, null, true).reason)
        // Without either: the tail read's own status.
        assertEquals(BgJob.Phase.FAILED, BgJob.state(null, emptyList(), tail("failed", "x", exitCode = 2), true).phase)
        assertEquals(BgJob.Phase.RUNNING, BgJob.state(null, emptyList(), tail("running", "x"), true).phase)
    }

    @Test fun theKilledLineNamesWhoStoppedItInTheWakeGlossesWords() {
        assertEquals("Killed by the agent.", BgJob.killedBy("requested"))
        assertEquals("The person who owns this session stopped it from the app.", BgJob.killedBy("stopped_by_owner"))
        assertEquals("The runner process hosting it stopped — a restart or a self-update — and the job was killed with it.", BgJob.killedBy("runner_shutdown"))
        assertEquals("The session was cancelled, or handed to another runner process, and the job was killed with it.", BgJob.killedBy("session_cancelled"))
        assertNull(BgJob.killedBy("something_new"))
        assertNull(BgJob.killedBy(null))
    }

    @Test fun theOutputIsTheLiveTailWhileItRunsAndItsEndsOnceItEnded() {
        val news = seen(wakeBlock("bgj_a1", "new output｜running", "from the wake"))
        assertEquals("polled 1\npolled 2", BgJob.output(BgJob.Phase.RUNNING, null, news, tail("running", "polled 1", "polled 2")))
        assertEquals("from the wake", BgJob.output(BgJob.Phase.RUNNING, null, news, null))
        assertEquals("from the wake", BgJob.output(BgJob.Phase.RUNNING, null, news, tail("running")))
        val end = seen(wakeBlock("bgj_a1", "ended｜failed｜exit code 1", "the end"))
        assertEquals("the end", BgJob.output(BgJob.Phase.FAILED, null, end, tail("failed", "polled")))
        assertEquals("polled", BgJob.output(BgJob.Phase.FAILED, null, emptyList(), tail("failed", "polled")))
        assertEquals("report", BgJob.output(BgJob.Phase.DONE, shell("latestOutput" to "report"), emptyList(), null))
        assertEquals("red", BgJob.output(BgJob.Phase.RUNNING, null, emptyList(), tail("running", "\u001B[31mred\u001B[0m")))
        assertEquals(listOf("b", "c"), BgJob.lastLines("a\nb\nc\n\n", 2))
        assertEquals(emptyList<String>(), BgJob.lines("  \n"))
    }

    @Test fun elapsedReadsAsTheBoardWritesIt() {
        assertEquals("45s", BgJob.elapsed(45_000))
        assertEquals("3m 10s", BgJob.elapsed(190_000))
        assertEquals("12m 40s", BgJob.elapsed(760_000))
        assertEquals("1m 05s", BgJob.elapsed(65_000))
        assertEquals("40m", BgJob.elapsed(40 * 60_000L + 5_000))
        assertEquals("1h 5m", BgJob.elapsed(65 * 60_000L))
        assertEquals("0s", BgJob.elapsed(-5))
    }

    @Test fun theOpenedCardsMetadataLineAndItsTitleKindAndStop() {
        val start = java.time.Instant.parse("2026-11-21T10:20:00Z").toEpochMilli()
        assertEquals("bgj_9f3a · watch · started 10:20 · ran 12m 40s · on workstation",
            BgJob.meta("bgj_9f3a", "watch", start, "12m 40s", "workstation", ZoneOffset.UTC))
        assertEquals("bgj_9f3a · job · started 10:20", BgJob.meta("bgj_9f3a", "job", start, null, null, ZoneOffset.UTC))
        assertEquals("Wait for CI", BgJob.title(buildJsonObject { put("command", "gh run watch"); put("description", " Wait for CI ") }))
        assertEquals("gh run watch", BgJob.title(buildJsonObject { put("command", "gh run watch") }))
        assertEquals("job", BgJob.kind(buildJsonObject { }))
        assertEquals("service", BgJob.kind(buildJsonObject { put("kind", "service") }))
        assertTrue(BgJob.stoppable(BgJob.Phase.RUNNING, shell("stoppable" to true)))
        assertFalse(BgJob.stoppable(BgJob.Phase.RUNNING, shell("stoppable" to false)))
        assertFalse(BgJob.stoppable(BgJob.Phase.RUNNING, shell()))
        assertFalse(BgJob.stoppable(BgJob.Phase.DONE, shell("stoppable" to true)))
        assertEquals("Show all 214 lines", BgJob.showAll(214))
        assertEquals("exit 1", BgJob.exit(1))
    }
}
