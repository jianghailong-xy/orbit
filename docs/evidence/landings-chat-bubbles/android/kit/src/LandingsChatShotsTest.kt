package io.orbitd.android.reader

import android.content.Intent
import android.graphics.Bitmap
import android.net.Uri
import android.os.SystemClock
import android.view.KeyEvent
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import io.orbitd.android.MainActivity
import io.orbitd.android.OrbitApplication
import io.orbitd.android.core.auth.AuthState
import io.orbitd.android.core.net.ServerAddress
import java.io.File
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.temporal.ChronoUnit
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Evidence frames for the Android Landings window drawn as a chat (owner 2026-11-02, docs/mocks/landings-chat-bubbles, option C), taken
 * on the shared emulator through the real product shell over controlled HTTP — a MockWebServer inside the instrumentation — so every
 * answer is the one scripted here, not a deployed server's. The project "install.sh on multi-user machines" has had eight settled
 * landings and two in hand: yesterday T1, T2 and T4 each landed and merged into main a few minutes later; today T3 landed and merged in
 * the same minute; T5 waits for a decision (its check failed, the coordinator has it) and T6 is checking. Every name is example data;
 * the times are set relative to the run. Kept in the evidence directory and compiled into the androidTest APK by kit.gradle;
 * `-e theme dark` takes the dark frames.
 */
@RunWith(AndroidJUnit4::class)
class LandingsChatShotsTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()
    private val instrumentation get() = InstrumentationRegistry.getInstrumentation()
    private val app get() = instrumentation.targetContext.applicationContext as OrbitApplication
    private val theme = InstrumentationRegistry.getArguments().getString("theme") ?: "light"
    private val evidence get() = File(app.filesDir, "landings-chat/$theme").also { it.mkdirs() }
    private val calls = CopyOnWriteArrayList<String>()
    private val notes = CopyOnWriteArrayList<String>()

    private val zone = ZoneId.systemDefault()
    private val now = Instant.now()
    private val midnight = LocalDate.now(zone).atStartOfDay(zone).toInstant()
    private fun yesterday(hour: Int, minute: Int): Instant = LocalDate.now(zone).minusDays(1).atTime(hour, minute).atZone(zone).toInstant()
    private fun ago(seconds: Long): Instant = now.minusSeconds(seconds)
    /** T3 landed, and its merge went into main, in one minute today: halfway from midnight to now, at :12 and :47 of that minute. */
    private val t3Minute = midnight.plusMillis((now.toEpochMilli() - midnight.toEpochMilli()) / 2).truncatedTo(ChronoUnit.MINUTES)
    private val t3At = t3Minute.plusSeconds(12)
    private val m4At = t3Minute.plusSeconds(47)

    private fun id(suffix: String) = "00000000-0000-4000-8000-${suffix.padStart(12, '0')}"
    private val alpha = id("a01")
    private val project = id("b01")
    private val coord = id("c01"); private val doctorSession = id("c05"); private val upgradeSession = id("c06"); private val hintsSession = id("c03")
    private val t1 = id("d01"); private val m1 = id("d02"); private val t2 = id("d03"); private val m2 = id("d04")
    private val t4 = id("d05"); private val m3 = id("d06"); private val t3 = id("d07"); private val m4 = id("d08")
    private val t5 = id("d09"); private val t6 = id("d10")
    private val target = "project/install-sh"
    private val projectTitle = "install.sh on multi-user machines"

    private val names = mapOf(
        t1 to "T1 install.sh: keep one orbit binary per account",
        t2 to "T2 host setup refuses a binary it did not install",
        t4 to "T4 install.sh under sudo writes the unit file once",
        t3 to "T3 sudo hints name the binary's real path",
        t5 to "T5 orbit doctor reports the runner's own binary",
        t6 to "T6 upgrade keeps each account's service running")

    @Test fun theLandingsChatFrames() {
        instrumentation.sendStatus(0, android.os.Bundle().apply { putString("lc_pid", android.os.Process.myPid().toString()) })
        compose.waitUntil(10_000) { app.session.state.value !is AuthState.Restoring }
        assertTrue("Requires a dedicated signed-out debug installation", app.session.state.value is AuthState.SignedOut)
        evidence.listFiles()?.forEach { it.delete() }
        MockWebServer().use { server ->
            server.dispatcher = dispatcher()
            try {
                runBlocking { app.session.login(ServerAddress.parse(server.url("/").toString(), true), "landings@example.test", "controlled-fixture") }
                compose.waitUntil(20_000) { app.session.state.value is AuthState.SignedIn && app.realtime.state.value.directoryFresh }
                await("the workspace") { exists(hasTestTag("workspace:$alpha")) }
                compose.onNodeWithTag("workspace:$alpha").performClick()
                await("the project's row") { exists(hasTestTag("project-row:$project")) }
                compose.onNodeWithTag("project-row:$project").performClick()
                await("the Landings row") { exists(hasTestTag("landings-row")) }
                compose.onNodeWithTag("landings-row").performClick()

                // a · the window, opened at its bottom: today's group, then Now's chip and its one group of two cards, and the bar.
                await("the waiting card's head") { text("landing-head:right", t5) == "Not landed" }
                await("the waiting card's doors") { exists(hasTestTag("landing:wait:open_coordinator") and inEntry(t5)) }
                await("the checking card's budget") { text("landing:budget", t6)?.startsWith("Merge check ") == true }
                await("today's group") { exists(hasTestTag("landing-row:$t3")) && exists(hasTestTag("landing-row:$m4")) }
                await("the bar's door") { exists(hasTestTag("landings:open-coordinator")) }
                settle(); SystemClock.sleep(800)
                note("a: chips=${texts("landings:day:", prefix = true)} titles=${texts("landing-row:title")} cards=${texts("landing:task-name")} " +
                    "avatars=${count("landings:avatar")} footer=${text("landings:footer-line")} | ${text("landings:footer-decisions")}")
                capture("a-window-at-its-bottom")

                // b · scrolled up: the day chips and yesterday's three groups, each a landing and the merge that carried it.
                list().performScrollToKey("day:Yesterday")
                await("yesterday's groups") { exists(hasTestTag("landing-row:$t1")) && exists(hasTestTag("landing-row:$m1")) }
                note("b: chips=${texts("landings:day:", prefix = true)} titles=${texts("landing-row:title")} details=${texts("landing-row:detail")} " +
                    "times=${texts("landing-row:time")} avatars=${count("landings:avatar")}")
                capture("b-day-chips-and-groups")

                // c · a bubble opened: T3's record under it, on a quiet panel at the column's width.
                list().performScrollToNode(hasTestTag("landing-row:$t3"))
                compose.onNodeWithTag("landing-row:$t3").performClick()
                await("T3's record") {
                    exists(hasTestTag("landing:record-panel") and inEntry(t3)) && exists(hasTestTag("landing:link:task") and inEntry(t3))
                }
                list().performScrollToKey("day:Today")
                note("c: panel=${texts("landing:record-panel", unmergedText = true)}")
                capture("c-bubble-opened")
                compose.onNodeWithTag("landing-row:$t3").performClick()
                await("T3 folded") { !exists(hasTestTag("landing:record-panel") and inEntry(t3)) }

                // d · a long press on T3's bubble: today's menu, its ways to look.
                compose.onNodeWithTag("landing-row:$t3").performTouchInput { longClick(center) }
                await("the bubble's menu") { menuItems() == listOf("Open task", "Open source session", "Open coordinator") }
                note("d: menu=${menuItems()}")
                capture("d-bubble-long-press-menu")
                instrumentation.sendKeyDownUpSync(KeyEvent.KEYCODE_BACK)
                await("the menu closed, the window still up") { menuItems().isEmpty() && exists(hasTestTag("landings-window")) }

                // e · from elsewhere: an orbit-session link to yesterday's T2 opens the window on it — scrolled to, opened and outlined.
                openLink("orbit-session:$t2")
                await("T2, open and outlined") {
                    exists(hasTestTag("landing:outlined") and inEntry(t2), unmerged = true) &&
                        exists(hasTestTag("landing:link:task") and inEntry(t2))
                }
                compose.waitForIdle(); SystemClock.sleep(200)
                capture("e-opened-on-a-landing-outlined", quick = true)
                // The window's timers run on the test's frame clock, which a sleep does not move.
                compose.mainClock.advanceTimeBy(2_000)
                await("the outline gone, T2 still open") {
                    !exists(hasTestTag("landing:outlined"), unmerged = true) && exists(hasTestTag("landing:record-panel") and inEntry(t2))
                }
                capture("e2-after-the-outline")
                assertEquals("a settled landing is read once, never polled", 1, calls.count { it == "GET /api/sessions/$t2" })
                File(evidence, "result.txt").writeText("PASS\n")
            } catch (failure: Throwable) {
                File(evidence, "failure.txt").writeText(failure.stackTraceToString())
                runCatching { File(evidence, "failure-tree.txt").writeText(compose.onRoot(useUnmergedTree = true).printToString()) }
                runCatching { capture("failure") }
                throw failure
            } finally {
                File(evidence, "requests.txt").writeText(calls.joinToString("\n"))
                File(evidence, "notes.txt").writeText(notes.joinToString("\n"))
                runBlocking { runCatching { app.session.logout() } }
            }
        }
    }

    // MARK: the fixture's answers

    private fun q(value: Any?) = when (value) { null -> "null"; is Instant -> "\"$value\""; is String -> "\"$value\""; else -> "$value" }
    private fun user() = """{"id":"u1","name":"Fixture","email":"landings@example.test","role":"MEMBER","avatarUpdatedAt":null,
        "preferences":{"theme":"$theme","defaultPermissionMode":"auto","notifySessionFinished":false,"notifyAgentMessage":true}}"""
    private fun membership(role: String) = """"projectMembership":{"projectId":"$project","projectTitle":"$projectTitle","projectStatus":"OPEN","role":"$role"}"""
    private fun member(id: String, title: String, run: String, lastTurn: Instant, role: String, extra: String = "") =
        """{"id":"$id","title":"$title","status":"$run","runState":"$run","lifecycleState":"OPEN","agent":{"id":"$alpha","name":"Alpha"},
        "agentId":"$alpha","createdAt":"${ago(36_000)}","lastTurnAt":"$lastTurn","pendingApprovals":0,"tags":[],
        "capabilities":{"canComplete":true,"canRestore":false},${membership(role)}$extra}"""
    private val members get() = mapOf(
        coord to member(coord, "Coordinate install.sh on multi-user machines", "AWAITING_INPUT", ago(240), "COORDINATOR",
            extra = ""","projectId":"$project","lastAssistantText":"T5's check failed; I am looking at it.""""),
        doctorSession to member(doctorSession, "orbit doctor reports the runner's own binary", "AWAITING_INPUT", ago(1_300), "TASK",
            extra = ""","lastAssistantText":"doctor reads the unit file's ExecStart.""""),
        upgradeSession to member(upgradeSession, "upgrade keeps each account's service running", "AWAITING_INPUT", ago(500), "TASK",
            extra = ""","lastAssistantText":"Each account's unit restarts after the swap.""""),
        hintsSession to member(hintsSession, "sudo hints name the binary's real path", "AWAITING_INPUT", ago(3_000), "TASK",
            extra = ""","lastAssistantText":"The hint prints the resolved path.""""))

    private fun landingRow(id: String, title: String, created: Instant, state: String, subject: String = "TASK", settledAs: String? = null,
        settledAt: Instant? = null) = """{"id":"$id","title":"$title","status":"AWAITING_INPUT","createdAt":"$created","lastTurnAt":"$created",
        "sessionKind":"LANDING","landing":{"subject":"$subject","state":"$state","settledAs":${q(settledAs)},"settledAt":${q(settledAt)}},
        ${membership("LANDING")}}"""
    private fun taskRow(id: String, landed: Instant) = landingRow(id, "Land · ${names.getValue(id)}", landed.minusSeconds(9 * 60), "SETTLED",
        settledAs = "LANDED", settledAt = landed)
    private fun roundRow(id: String, number: Int, merged: Instant) = landingRow(id, "Merge $target → main · #$number", merged.minusSeconds(100),
        "SETTLED", subject = "PROMOTION", settledAs = "MERGED", settledAt = merged)

    /** When each settled one settled: yesterday's three landings and the merges that carried them, and today's pair. */
    private val settledAt get() = mapOf(t1 to yesterday(22, 11), m1 to yesterday(22, 13), t2 to yesterday(23, 7), m2 to yesterday(23, 9),
        t4 to yesterday(23, 25), m3 to yesterday(23, 29), t3 to t3At, m4 to m4At)
    /** The landings in hand ride on the Open read, the settled ones on the Completed read, as the server files them. */
    private val openLandings get() = listOf(
        landingRow(t5, "Land · ${names.getValue(t5)}", ago(18 * 60), "AWAITING_DECISION"),
        landingRow(t6, "Land · ${names.getValue(t6)}", ago(420), "IN_FLIGHT"))
    private val settledLandings get() = listOf(taskRow(t1, settledAt.getValue(t1)), roundRow(m1, 1, settledAt.getValue(m1)),
        taskRow(t2, settledAt.getValue(t2)), roundRow(m2, 2, settledAt.getValue(m2)), taskRow(t4, settledAt.getValue(t4)),
        roundRow(m3, 3, settledAt.getValue(m3)), taskRow(t3, settledAt.getValue(t3)), roundRow(m4, 4, settledAt.getValue(m4)))

    /** The merges into main, each joined to its round's landing session: one task each, merged automatically. */
    private data class Round(val promotionId: String, val session: String, val task: String, val sha: String, val tree: String)
    private val rounds get() = listOf(Round("pr-1", m1, t1, "3c1e9a04d2b1", "6a0d93c2e417"), Round("pr-2", m2, t2, "b74d2f1e8a03", "c21f7e90b5d4"),
        Round("pr-3", m3, t4, "e05a8c3b71f9", "0d7c4e2a9b61"), Round("pr-4", m4, t3, "91fd6b2c04ae", "5e5bfca9d2e8"))
    private fun mergedRecord(round: Round) = """{"promotionId":"${round.promotionId}","state":"MERGED","sourceRef":"refs/heads/$target",
        "sourceSha":"${round.tree}","upstreamRef":"refs/heads/main","commitsAhead":3,"filesChanged":4,"taskIds":["t-${round.task}"],
        "tasks":[{"taskId":"t-${round.task}","title":"${names.getValue(round.task)}"}],
        "checks":[{"name":"MERGE_CHECK","command":"npm test","expectedExitCode":0,"exitCode":0,"timedOut":false,"durationMs":521000}],
        "conflicts":[],"landsAs":"MERGE_COMMIT","landsTreeSha":"${round.tree}","landingSessionId":"${round.session}",
        "merged":{"sha":"${round.sha}","at":"${settledAt.getValue(round.session)}","automatic":true,"revert":null}}"""
    private val merged get() = rounds.joinToString(",", "[", "]") { mergedRecord(it) }

    /** The project's landing line: the task landing in flight, with the V6 facts its card reads (step start, usual duration). */
    private val inFlightJob get() = """{"jobId":"j-t6","kind":"LAND_TASK","state":"RUNNING","phase":"CHECK","taskId":"t-$t6",
        "taskTitle":"${names.getValue(t6)}","generation":1,"startedAt":"${ago(400)}","queuedAt":"${ago(420)}","heartbeatAt":"$now",
        "runnerName":"workstation-gpu","timedOut":false,"limitSeconds":600,"retryable":false,"progressProtocol":"v2","claim":1,"round":1,
        "check":{"name":"MERGE_CHECK","index":1,"count":1,"budgetSeconds":1800,"startedAt":"${ago(372)}"},"stepStartedAt":"${ago(372)}",
        "outputMovedAt":"${ago(2)}","typicalMs":540000,"liveness":"LIVE","landingSessionId":"$t6"}"""
    private val integration get() = """{"line":"PROJECT_BRANCH","ref":"$target","upstreamRef":"refs/heads/main","integratingCount":1,"queuedCount":0,
        "inFlight":$inFlightJob,"inFlightJobs":[$inFlightJob]}"""

    private fun entry(kind: String, at: Instant, text: String, claim: Int = 1, round: Int? = null, check: String? = null,
        data: String? = null, phase: String? = null, reason: String? = null) = """{"kind":"$kind","at":"$at","claim":$claim,
        "round":${q(round)},"check":${check?.let { """{"name":"$it","index":1}""" } ?: "null"},"data":${data ?: "null"},
        "phase":${q(phase)},"reason":${q(reason)},"text":"$text"}"""
    private fun passed(ms: Int) = """{"exitCode":0,"expectedExitCode":0,"timedOut":false,"durationMs":$ms}"""
    private fun failed(ms: Int) = """{"exitCode":1,"expectedExitCode":0,"timedOut":false,"durationMs":$ms}"""
    private fun section(title: String, jobId: String, kind: String, generation: Int, state: String, vararg entries: String) =
        """{"title":"$title","jobId":"$jobId","kind":"$kind","generation":$generation,"state":"$state","entries":[${entries.joinToString(",")}]}"""
    private fun attempt(jobId: String, state: String, started: Instant, source: String?, kind: String = "LAND_TASK", check: String = "null",
        liveness: String? = null, heartbeat: Instant? = started, output: Instant? = null, phase: String? = "CHECK",
        targetRef: String = "refs/heads/$target") = """{"jobId":"$jobId","kind":"$kind","state":"$state","generation":1,"phase":${q(phase)},
        "round":1,"step":null,"claim":1,"runnerName":"workstation-gpu","sourceSessionId":${q(source)},"targetRef":"$targetRef","startedAt":"$started",
        "heartbeatAt":${q(heartbeat)},"outputMovedAt":${q(output)},"progressProtocol":"v2","check":$check,"liveness":${q(liveness)},
        "blockingReason":null,"timedOut":false,"limitSeconds":600,"retryable":false,"pushBoundaryPassed":false}"""
    private fun view(id: String, opened: Instant, settledAt: Instant?, settledAs: String?, attempt: String, sections: List<String>,
        subject: String = "TASK", taskId: String? = "t-$id", promotionId: String? = null, checks: String = "[]") =
        """{"sessionId":"$id","projectId":"$project","subject":"$subject","taskId":${q(taskId)},"promotionId":${q(promotionId)},"episode":2,
        "openedAt":"$opened","settledAt":${q(settledAt)},"settledAs":${q(settledAs)},"checks":$checks,"currentAttempt":$attempt,
        "todos":[],"generations":[],"timeline":{"sections":[${sections.joinToString(",")}],"facts":[],"truncated":false}}"""
    /** A task segment that landed in one claim: queued, claimed, its check started and passed, landed. */
    private fun landedTask(id: String, landed: Instant, sha: String): String {
        val opened = landed.minusSeconds(9 * 60)
        return view(id, opened, landed, "LANDED", attempt("j-$id", "LANDED", opened.plusSeconds(4), hintsSession),
            listOf(section("Generation 1", "j-$id", "LAND_TASK", 1, "LANDED",
                entry("ENQUEUED", opened, "Task marked done · queued to land on $target", claim = 0),
                entry("CLAIMED", opened.plusSeconds(4), "Claimed by runner workstation-gpu · claim 1"),
                entry("CHECK_STARTED", opened.plusSeconds(19), "Merge check started · claim 1 · workstation-gpu", round = 1, check = "MERGE_CHECK"),
                entry("CHECK_FINISHED", landed.minusSeconds(20), "Merge check passed · 8m 41s", round = 1, check = "MERGE_CHECK", data = passed(521000)),
                entry("RESULT", landed, "Landed on $target · $sha", data = """{"state":"LANDED"}"""))))
    }
    /** A round of merging into main: its check on the combined tree, then the merge. */
    private fun mergedRound(round: Round): String {
        val at = settledAt.getValue(round.session)
        return view(round.session, at.minusSeconds(100), at, "MERGED",
            attempt("j-${round.promotionId}-2", "LANDED", at.minusSeconds(20), null, kind = "LAND_PROMOTION", phase = "PUSH", targetRef = "refs/heads/main"),
            listOf(
                section("Merge check · 1", "j-${round.promotionId}-1", "CHECK_PROMOTION", 1, "READY",
                    entry("CHECK_STARTED", at.minusSeconds(100), "Merge check started · claim 1 · workstation-gpu", round = 1, check = "MERGE_CHECK"),
                    entry("CHECK_FINISHED", at.minusSeconds(30), "Merge check passed · 1m 10s", round = 1, check = "MERGE_CHECK", data = passed(70000)),
                    entry("RESULT", at.minusSeconds(30), "Ready to merge into main", data = """{"state":"READY"}""")),
                section("Merge to main · 1", "j-${round.promotionId}-2", "LAND_PROMOTION", 1, "LANDED",
                    entry("CLAIMED", at.minusSeconds(20), "Claimed by runner workstation-gpu · claim 1"),
                    entry("RESULT", at, "Landed on main · ${round.sha.take(7)}", data = """{"state":"LANDED"}"""))),
            subject = "PROMOTION", taskId = null, promotionId = round.promotionId,
            checks = """[{"name":"MERGE_CHECK","exitCode":0,"expectedExitCode":0,"timedOut":false,"durationMs":70000}]""")
    }

    private fun landing(id: String): Pair<String, String>? = when (id) {
        t5 -> "Land · ${names.getValue(t5)}" to view(t5, ago(18 * 60), null, null,
            attempt("j-t5", "CHECK_FAILED", ago(17 * 60), doctorSession),
            listOf(section("Generation 1", "j-t5", "LAND_TASK", 1, "CHECK_FAILED",
                entry("ENQUEUED", ago(18 * 60), "Task marked done · queued to land on $target", claim = 0),
                entry("CLAIMED", ago(17 * 60), "Claimed by runner workstation-gpu · claim 1"),
                entry("CHECK_FINISHED", ago(13 * 60), "Task acceptance failed · exit 1 · 3m 52s", round = 1, check = "TASK_ACCEPTANCE",
                    data = failed(232000)),
                entry("RESULT", ago(13 * 60 - 5), "Check failed · nothing was pushed", data = """{"state":"CHECK_FAILED"}"""),
                entry("HANDED_TO", ago(13 * 60 - 10), "Asked the coordinator to fix it"))),
            checks = """[{"name":"TASK_ACCEPTANCE","exitCode":1,"expectedExitCode":0,"timedOut":false,"durationMs":232000}]""")
        t6 -> "Land · ${names.getValue(t6)}" to view(t6, ago(420), null, null,
            attempt("j-t6", "RUNNING", ago(400), upgradeSession, check = """{"name":"MERGE_CHECK","index":1,"count":1,"budgetSeconds":1800,"startedAt":"${ago(372)}"}""",
                liveness = "LIVE", heartbeat = now, output = ago(2)),
            listOf(section("Generation 1", "j-t6", "LAND_TASK", 1, "RUNNING",
                entry("ENQUEUED", ago(420), "Task marked done · queued to land on $target", claim = 0),
                entry("CLAIMED", ago(400), "Claimed by runner workstation-gpu · claim 1"),
                entry("CHECK_STARTED", ago(372), "Merge check started · claim 1 · workstation-gpu", round = 1, check = "MERGE_CHECK"))))
        t1 -> "Land · ${names.getValue(t1)}" to landedTask(t1, settledAt.getValue(t1), "4f2c81d")
        t2 -> "Land · ${names.getValue(t2)}" to landedTask(t2, settledAt.getValue(t2), "a93e05b")
        t4 -> "Land · ${names.getValue(t4)}" to landedTask(t4, settledAt.getValue(t4), "7d10c6e")
        t3 -> "Land · ${names.getValue(t3)}" to landedTask(t3, settledAt.getValue(t3), "c58b2f4")
        else -> rounds.firstOrNull { it.session == id }?.let { round -> "Merge $target → main · #${round.promotionId.removePrefix("pr-")}" to mergedRound(round) }
    }
    private fun detail(id: String) = landing(id)?.let { (title, view) ->
        """{"id":"$id","title":"$title","status":"AWAITING_INPUT","sessionKind":"LANDING","workspace":null,"assignedRunner":null,"tags":[],"landing":$view}"""
    }
    /** What a check printed: the failed one its last lines, a running one its newest, a passed one its count. */
    private fun log(id: String): String {
        val text = when (id) {
            t5 -> "> orbit doctor --json\n FAIL  doctor/runner_binary_test.go > reports the account's own binary\n" +
                "expected /home/ops/.orbit/bin/orbit, got /usr/local/bin/orbit\n Tests  1 failed | 41 passed (42)\n"
            t6 -> "> npm test\n ✓ upgrade/keeps-service.test.ts (6 tests) 2.1s\n ✓ upgrade/per-account.test.ts (9 tests) 3.4s\n"
            else -> " Test Files  18 passed (18)\n      Tests  212 passed (212)\n"
        }
        return """{"jobId":"j-$id","entries":[{"claim":1,"round":1,"seq":0,"text":${kotlinx.serialization.json.JsonPrimitive(text)},"truncatedBytes":0}],"nextCursor":null}"""
    }

    private fun dispatcher() = object : Dispatcher() {
        override fun dispatch(request: RecordedRequest): MockResponse {
            val url = request.requestUrl!!
            val path = url.encodedPath
            calls += "${request.method} $path${url.encodedQuery?.let { "?$it" }.orEmpty()}"
            // An answer the fixture got wrong is named in notes.txt, rather than read by the app as a server it cannot reach.
            fun json(body: String) = if (runCatching { kotlinx.serialization.json.Json.parseToJsonElement(body) }.isSuccess)
                MockResponse().setHeader("Content-Type", "application/json").setBody(body)
                else MockResponse().setResponseCode(500).also { notes += "FIXTURE: not JSON for $path" }
            val parts = path.removePrefix("/api/").split('/')
            val view = url.queryParameter("view") ?: "open"
            val scoped = url.queryParameter("projectId") != null
            return when {
                path == "/dl/version.json" -> json("""{"version":"0.0.1"}""")
                path == "/api/auth/methods" -> MockResponse().setResponseCode(404)
                path == "/api/auth/login" -> json("""{"accessToken":"lc-fixture-access","refreshToken":"lc-fixture-refresh","user":${user()}}""")
                path == "/api/users/me" -> json(user())
                path == "/api/workspaces" -> json("""[{"id":"$alpha","name":"Alpha","runnerId":"r1","enabled":true,"position":0,"createdAt":"2026-10-01T01:00:00.000Z"}]""")
                path == "/api/runners" -> json("""[{"id":"r1","name":"workstation-gpu","online":true}]""")
                path == "/api/sessions" && view == "open" -> json((listOf(coord, doctorSession, upgradeSession, hintsSession).map { members.getValue(it) } +
                    if (scoped) openLandings else emptyList()).joinToString(",", "[", "]"))
                path == "/api/sessions" && view == "completed" -> json((if (scoped) settledLandings else emptyList()).joinToString(",", "[", "]"))
                path == "/api/sessions" -> json("[]")
                parts.size == 4 && parts[0] == "sessions" && parts[2] == "landing" && parts[3] == "log" -> json(log(parts[1]))
                parts.size == 2 && parts[0] == "sessions" && request.method == "GET" -> json(detail(parts[1]) ?: members[parts[1]] ?: "{}")
                parts[0] == "sessions" && parts.last() == "page" -> json("""{"events":[],"hasMore":false,"lastSeq":0,"latestSeq":0}""")
                // The realtime stream says it is connected first (memory android-emulator-fixture-event-stream), then keeps the line open.
                parts[0] == "sessions" && parts.last() == "events" || path == "/api/events" -> MockResponse().setHeader("Content-Type", "text/event-stream")
                    .setChunkedBody("data: {\"type\":\"ping\",\"seq\":0}\n\n" + ": connected\n\n".repeat(240), 13).throttleBody(13, 1, TimeUnit.SECONDS)
                path == "/api/projects/sidebar" -> json("""[{"id":"$project","title":"$projectTitle","status":"OPEN","createdAt":"2026-10-28T00:00:00Z",
                    "buckets":{"running":1},"taskCounts":{"done":4,"failed":0,"total":6},"attention":{},
                    "integration":{"line":"PROJECT_BRANCH","ref":"$target","activeJobCount":1},"startedAt":"2026-10-29T00:00:00Z"}]""")
                path == "/api/projects" -> json("""[{"id":"$project","title":"$projectTitle","status":"OPEN","goal":"One orbit binary per account.",
                    "createdAt":"2026-10-28T00:00:00Z"}]""")
                parts == listOf("projects", project) -> json("""{"id":"$project","title":"$projectTitle","status":"OPEN",
                    "goal":"One orbit binary per account.","createdAt":"2026-10-28T00:00:00Z","_count":{"tasks":6},
                    "startedAt":"2026-10-29T00:00:00Z","coordinatorSessionId":"$coord","acceptanceCriteriaItems":[]}""")
                parts == listOf("projects", project, "integration") -> json(integration)
                parts == listOf("projects", project, "open-items") -> json("""{"needsYou":[],"withCoordinator":[]}""")
                parts == listOf("projects", project, "coordinator", "status") -> json("""{"state":"LIVE","coordination":{"session":{"id":"$coord"}}}""")
                parts == listOf("projects", project, "promotions", "current") -> MockResponse().setResponseCode(200)
                parts == listOf("projects", project, "promotions", "merged") -> json(merged)
                parts[0] == "tasks" && parts.size == 2 -> json("""{"id":"${parts[1]}","title":"${names[parts[1].removePrefix("t-")] ?: "Task"}","status":"DONE","projectId":"$project"}""")
                parts[0] == "projects" -> json("{}")
                parts[0] == "wiki" -> MockResponse().setResponseCode(404).setHeader("Content-Type", "application/json")
                    .setBody("""{"code":"WIKI_DISABLED","message":"The wiki is off."}""")
                path.endsWith("/logout") -> json("{}")
                request.method == "GET" -> json("[]")
                else -> json("{}")
            }
        }
    }

    // MARK: the hands and the eyes

    private fun list() = compose.onNodeWithTag("landings-window-list")
    private fun inEntry(id: String) = hasAnyAncestor(hasTestTag("landing-entry:$id"))
    private fun exists(matcher: SemanticsMatcher, unmerged: Boolean = false) = compose.onAllNodes(matcher, unmerged).fetchSemanticsNodes().isNotEmpty()
    private fun count(tag: String) = compose.onAllNodesWithTag(tag, useUnmergedTree = true).fetchSemanticsNodes().size
    private fun text(tag: String, entry: String? = null) = compose.onAllNodes(if (entry == null) hasTestTag(tag) else hasTestTag(tag) and inEntry(entry), true)
        .fetchSemanticsNodes().firstOrNull()?.config?.getOrNull(SemanticsProperties.Text)?.joinToString("") { it.text }
    /** Every node's words under [tag] (or every tag starting with it), top to bottom; [unmergedText] reads a container's descendants. */
    private fun texts(tag: String, prefix: Boolean = false, unmergedText: Boolean = false): List<String> {
        val matcher = if (prefix) SemanticsMatcher("tag starts with $tag") { it.config.getOrNull(SemanticsProperties.TestTag)?.startsWith(tag) == true }
            else hasTestTag(tag)
        val nodes = compose.onAllNodes(if (unmergedText) hasAnyAncestor(matcher) else matcher, useUnmergedTree = true).fetchSemanticsNodes()
        return nodes.sortedBy { it.positionInRoot.y }.mapNotNull { it.config.getOrNull(SemanticsProperties.Text)?.joinToString("") { t -> t.text } }
    }
    private fun menuItems() = compose.onAllNodes(hasAnyAncestor(isPopup()) and hasClickAction()).fetchSemanticsNodes()
        .mapNotNull { node -> node.config.getOrNull(SemanticsProperties.Text)?.firstOrNull()?.text }
    private fun note(line: String) { notes += line }
    private fun await(what: String, condition: () -> Boolean) {
        try { compose.waitUntil(30_000) { condition() } } catch (failure: Throwable) { note("FAIL waited for $what"); throw failure }
        note("PASS $what")
    }
    private fun openLink(link: String) {
        compose.activityRule.scenario.onActivity { activity ->
            val original = activity.intent
            MainActivity::class.java.getDeclaredMethod("onNewIntent", Intent::class.java).apply { isAccessible = true }
                .invoke(activity, Intent(Intent.ACTION_VIEW, Uri.parse(link)).setClass(activity, MainActivity::class.java))
            activity.intent = original
        }
    }
    private fun settle() {
        compose.waitForIdle()
        instrumentation.waitForIdleSync()
        instrumentation.uiAutomation.waitForIdle(300, 5_000)
    }
    /** The screen as the device shows it. [quick] takes it at once, for a frame that lasts a moment (the focus outline). */
    private fun capture(name: String, quick: Boolean = false) {
        if (!quick) { settle(); SystemClock.sleep(600) }
        var bitmap: Bitmap? = null
        repeat(3) { if (bitmap == null) bitmap = instrumentation.uiAutomation.takeScreenshot() ?: run { SystemClock.sleep(300); null } }
        val shot = bitmap ?: run { File(evidence, "$name.missing").writeText("takeScreenshot returned null 3 times\n"); return }
        File(evidence, "$name.png").outputStream().use { shot.compress(Bitmap.CompressFormat.PNG, 100, it) }
        shot.recycle()
        note("captured $name at ${Instant.now()}")
    }
}
