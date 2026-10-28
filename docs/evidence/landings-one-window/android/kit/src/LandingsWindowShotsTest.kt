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
 * Evidence frames for the Android Landings window (owner 2026-10-27, docs/mocks/landings-one-window, frames b, d, e, f, g), taken on the
 * shared emulator through the real product shell over controlled HTTP — a MockWebServer inside the instrumentation — so every answer is
 * the one scripted here, not a deployed server's. The project "Ledger service" has had nine landings: two in hand (one waiting for a
 * decision after its check failed, one checking), five settled today (three landed, one with nothing to land, and the round that merged
 * into main, joined with its record), two settled yesterday, and one merge into main from before landing sessions. Every name is neutral
 * example data. Kept in the evidence directory and compiled into the androidTest APK by kit.gradle; `-e theme dark` takes the dark frames.
 */
@RunWith(AndroidJUnit4::class)
class LandingsWindowShotsTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()
    private val instrumentation get() = InstrumentationRegistry.getInstrumentation()
    private val app get() = instrumentation.targetContext.applicationContext as OrbitApplication
    private val theme = InstrumentationRegistry.getArguments().getString("theme") ?: "light"
    private val evidence get() = File(app.filesDir, "landings-window/$theme").also { it.mkdirs() }
    private val calls = CopyOnWriteArrayList<String>()
    private val notes = CopyOnWriteArrayList<String>()

    private val zone = ZoneId.systemDefault()
    private val now = Instant.now()
    private val midnight = LocalDate.now(zone).atStartOfDay(zone).toInstant()
    /** A moment today, [share] of the way from midnight to now: the window files it under Today whenever the frames are taken. */
    private fun today(share: Double): Instant = midnight.plusMillis(((now.toEpochMilli() - midnight.toEpochMilli()) * share).toLong())
    private fun yesterday(hour: Int, minute: Int): Instant = LocalDate.now(zone).minusDays(1).atTime(hour, minute).atZone(zone).toInstant()
    private fun ago(seconds: Long): Instant = now.minusSeconds(seconds)

    private fun id(suffix: String) = "00000000-0000-4000-8000-${suffix.padStart(12, '0')}"
    private val alpha = id("a01")
    private val project = id("b01")
    private val coord = id("c01"); private val feeSession = id("c02"); private val reconcileSession = id("c03"); private val ledgerSession = id("c04")
    private val flight = id("d01"); private val waiting = id("d02"); private val payout = id("d03"); private val export = id("d04")
    private val ledger = id("d05"); private val round = id("d06"); private val invoice = id("d07"); private val currency = id("d08")
    private val audit = id("d09")
    private val target = "project/ledger-service"

    @Test fun theLandingsWindowFrames() {
        instrumentation.sendStatus(0, android.os.Bundle().apply { putString("lw_pid", android.os.Process.myPid().toString()) })
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

                // b · the project's sessions page: the Landings group is one row, under the coordinator, above the day sections.
                await("the Landings row's counts") {
                    text("landings-row:line") == "1 waiting for a decision · 1 in flight · 3 landed · 1 merged into main today"
                }
                await("how long the waiting one has waited") { text("landings-row:time") == "18m" }
                note("b: line=${text("landings-row:line")} time=${text("landings-row:time")}")
                capture("b-sessions-page-landings-row")

                // d · the window, opened at its bottom: the day sections above, Now's two cards under them.
                compose.onNodeWithTag("landings-row").performClick()
                // Its attempt stopped on a failed check: the head wears the Landings row's red ✕, its word in red (board 02 d).
                await("the waiting card's head") {
                    cardSays(waiting, "landing-head:right", "Not landed") && exists(hasTestTag("landing-head:failed") and inEntry(waiting), true)
                }
                assertTrue("the card in flight keeps its ring", !exists(hasTestTag("landing-head:failed") and inEntry(flight), true))
                await("the checking card's head") { text("landing:budget", flight)?.startsWith("Merge check ") == true }
                await("the waiting card's doors") { exists(hasTestTag("landing:wait:open_coordinator") and inEntry(waiting)) }
                settle(); SystemClock.sleep(800)
                note("d: subtitle=${text("page-bar-subtitle")} cards=${texts("landing:task-name")}")
                capture("d-window-at-its-bottom")
                list().performScrollToNode(hasTestTag("landings:day:Yesterday"))
                await("yesterday's rows") { exists(hasTestTag("landing-row:$currency")) }
                note("d2: rows=${texts("landing-row:title")}")
                capture("d2-window-day-sections")
                list().performScrollToNode(hasTestTag("landing-entry:$flight"))

                // g · a long-press on the card in flight: the old page's menu, its ways to look and its door.
                compose.onNode(hasTestTag("landing-status-card") and inEntry(flight)).performTouchInput { longClick(center) }
                await("the card's menu") { menuItems() == listOf("Open task", "Open source session", "Open coordinator", "Stop landing") }
                note("g: menu=${menuItems()}")
                capture("g-card-long-press-menu")
                instrumentation.sendKeyDownUpSync(KeyEvent.KEYCODE_BACK)
                await("the menu closed, the window still up") { menuItems().isEmpty() && exists(hasTestTag("landings-window")) }

                // e · the round that merged into main, opened in place: its receipt, then its round's own record.
                list().performScrollToNode(hasTestTag("landing-row:$round"))
                compose.onNodeWithTag("landing-row:$round").performClick()
                await("the receipt and the round's record") {
                    exists(hasTestTag("landing:receipt")) && exists(hasText("Landed on main · 3f1c2a9"), unmerged = true)
                }
                list().performScrollToNode(hasText("Landed on main · 3f1c2a9"))
                list().performScrollToNode(hasTestTag("landing-row:$round"))
                note("e: heading=${text("landing:receipt-heading")} check=${text("landing:receipt-check")} tree=${text("landing:receipt-tree")}")
                capture("e-merge-row-open")

                // f · from elsewhere: a landing session id (an Open landing ›, a coordinator's card, an orbit-session link) opens the
                // window on that landing — scrolled to, opened and outlined for a moment.
                openLink("orbit-session:$currency")
                await("the focused landing, open and outlined") {
                    exists(hasTestTag("landing:outlined"), unmerged = true) && exists(hasText("Generation 2"), unmerged = true) &&
                        exists(hasTestTag("landing:link:task") and inEntry(currency))
                }
                compose.waitForIdle(); SystemClock.sleep(200)
                capture("f-opened-on-a-landing", quick = true)
                // The window's timers run on the test's frame clock, which a sleep does not move.
                compose.mainClock.advanceTimeBy(2_000)
                note("f: outlined after 2 s=${exists(hasTestTag("landing:outlined"), unmerged = true)}")
                capture("f2-after-the-outline")
                assertEquals("the settled landing is read once, never polled", 1, calls.count { it == "GET /api/sessions/$currency" })
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
    private fun membership(role: String) = """"projectMembership":{"projectId":"$project","projectTitle":"Ledger service","projectStatus":"OPEN","role":"$role"}"""
    private fun member(id: String, title: String, run: String, lastTurn: Instant, role: String, lifecycle: String = "OPEN", extra: String = "") =
        """{"id":"$id","title":"$title","status":"$run","runState":"$run","lifecycleState":"$lifecycle","agent":{"id":"$alpha","name":"Alpha"},
        "agentId":"$alpha","createdAt":"${ago(36_000)}","lastTurnAt":"$lastTurn","pendingApprovals":0,"tags":[],
        "capabilities":{"canComplete":${lifecycle == "OPEN"},"canRestore":${lifecycle != "OPEN"}},${membership(role)}$extra}"""
    private val members get() = mapOf(
        coord to member(coord, "Coordinate ledger service", "AWAITING_INPUT", ago(240), "COORDINATOR",
            extra = ""","projectId":"$project","lastAssistantText":"Two landings are in hand.""""),
        feeSession to member(feeSession, "Fee schedule import", "AWAITING_INPUT", ago(500), "TASK", extra = ""","lastAssistantText":"The import reads the new fee table.""""),
        reconcileSession to member(reconcileSession, "Reconcile settlement batches", "AWAITING_INPUT", ago(1_300), "TASK",
            extra = ""","lastAssistantText":"Split batches reconcile in one pass.""""),
        ledgerSession to member(ledgerSession, "Ledger migration order", "SUCCEEDED", today(0.4), "TASK", "COMPLETED", ""","completedAt":"${today(0.4)}""""))

    private fun landingRow(id: String, title: String, created: Instant, state: String, subject: String = "TASK", settledAs: String? = null,
        settledAt: Instant? = null) = """{"id":"$id","title":"$title","status":"AWAITING_INPUT","createdAt":"$created","lastTurnAt":"$created",
        "sessionKind":"LANDING","landing":{"subject":"$subject","state":"$state","settledAs":${q(settledAs)},"settledAt":${q(settledAt)}},
        ${membership("LANDING")}}"""
    /** The landings in hand ride on the Open read, the settled ones on the Completed read, as the server files them. */
    private val openLandings get() = listOf(
        landingRow(flight, "Land · Fee schedule import", ago(420), "IN_FLIGHT"),
        landingRow(waiting, "Land · Reconcile settlement batches", ago(18 * 60), "AWAITING_DECISION"))
    private val settledLandings get() = listOf(
        landingRow(payout, "Land · Payout retry budget", today(0.10), "SETTLED", settledAs = "LANDED", settledAt = today(0.15)),
        landingRow(export, "Land · Statement export header", today(0.25), "SETTLED", settledAs = "NOTHING_TO_LAND", settledAt = today(0.30)),
        landingRow(ledger, "Land · Ledger migration order", today(0.40), "SETTLED", settledAs = "LANDED", settledAt = today(0.45)),
        landingRow(round, "Merge project/ledger-service → main · #4", today(0.50), "SETTLED", subject = "PROMOTION", settledAs = "MERGED",
            settledAt = today(0.61)),
        landingRow(invoice, "Land · Invoice rounding rule", today(0.70), "SETTLED", settledAs = "ALREADY_LANDED", settledAt = today(0.80)),
        landingRow(currency, "Land · Currency code lookup", yesterday(16, 20), "SETTLED", settledAs = "LANDED", settledAt = yesterday(18, 10)),
        landingRow(audit, "Land · Audit log retention", yesterday(15, 40), "SETTLED", settledAs = "CANCELLED", settledAt = yesterday(16, 5)))

    private val merged get() = """[{"promotionId":"pr-4","state":"MERGED","sourceRef":"refs/heads/$target","sourceSha":"a7e2c41d9b03",
        "upstreamRef":"refs/heads/main","commitsAhead":6,"filesChanged":14,"taskIds":["t-ledger","t-payout"],
        "tasks":[{"taskId":"t-ledger","title":"Ledger migration order"},{"taskId":"t-payout","title":"Payout retry budget"}],
        "checks":[{"name":"MERGE_CHECK","command":"npm test","expectedExitCode":0,"exitCode":0,"timedOut":false,"durationMs":1061000}],
        "conflicts":[],"landsAs":"MERGE_COMMIT","landsTreeSha":"5e5bfca9d2e8","landingSessionId":"$round",
        "merged":{"sha":"3f1c2a90b7d4","at":"${today(0.60)}","automatic":true,"revert":null}},
        {"promotionId":"pr-1","state":"MERGED","sourceRef":"refs/heads/$target","sourceSha":"19c0b2e4f7aa","upstreamRef":"refs/heads/main",
        "taskIds":["t-a","t-b","t-c"],"tasks":[{"taskId":"t-a","title":"Ledger schema draft"},{"taskId":"t-b","title":"Account id format"},
        {"taskId":"t-c","title":"Posting rules"}],"checks":[{"name":"MERGE_CHECK","command":"npm test","expectedExitCode":0,"exitCode":0,
        "timedOut":false,"durationMs":540000}],"conflicts":[],"landsAs":"FAST_FORWARD","landsTreeSha":"8b41d07c55e1",
        "merged":{"sha":"c9d84e1f2a60","at":"${now.minusSeconds(12 * 86_400)}","automatic":false,"revert":null}}]"""

    /** The project's landing line: the task landing in flight, with the V6 facts its card reads (step start, usual duration). */
    private val inFlightJob get() = """{"jobId":"j-flight","kind":"LAND_TASK","state":"RUNNING","phase":"CHECK","taskId":"t-fee",
        "taskTitle":"Fee schedule import","generation":1,"startedAt":"${ago(400)}","queuedAt":"${ago(420)}","heartbeatAt":"$now",
        "runnerName":"runner-01","timedOut":false,"limitSeconds":600,"retryable":false,"progressProtocol":"v2","claim":1,"round":1,
        "check":{"name":"MERGE_CHECK","index":1,"count":1,"budgetSeconds":1800,"startedAt":"${ago(372)}"},"stepStartedAt":"${ago(372)}",
        "outputMovedAt":"${ago(2)}","typicalMs":540000,"liveness":"LIVE","landingSessionId":"$flight"}"""
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
        "round":1,"step":null,"claim":1,"runnerName":"runner-01","sourceSessionId":${q(source)},"targetRef":"$targetRef","startedAt":"$started",
        "heartbeatAt":${q(heartbeat)},"outputMovedAt":${q(output)},"progressProtocol":"v2","check":$check,"liveness":${q(liveness)},
        "blockingReason":null,"timedOut":false,"limitSeconds":600,"retryable":false,"pushBoundaryPassed":false}"""
    private fun view(id: String, opened: Instant, settledAt: Instant?, settledAs: String?, attempt: String, sections: List<String>,
        subject: String = "TASK", taskId: String? = "t-$id", promotionId: String? = null, checks: String = "[]") =
        """{"sessionId":"$id","projectId":"$project","subject":"$subject","taskId":${q(taskId)},"promotionId":${q(promotionId)},"episode":4,
        "openedAt":"$opened","settledAt":${q(settledAt)},"settledAs":${q(settledAs)},"checks":$checks,"currentAttempt":$attempt,
        "todos":[],"generations":[],"timeline":{"sections":[${sections.joinToString(",")}],"facts":[],"truncated":false}}"""
    /** A task segment that landed in one claim: queued, claimed, its check passed, landed. */
    private fun landedTask(id: String, opened: Instant, settled: Instant, settledAs: String = "LANDED", result: String = "Landed on $target · 9c2e7d1",
        state: String = "LANDED") = view(id, opened, settled, settledAs, attempt("j-$id", state, opened.plusSeconds(20), feeSession),
        listOf(section("Generation 1", "j-$id", "LAND_TASK", 1, state,
            entry("ENQUEUED", opened, "Task marked done · queued to land on $target", claim = 0),
            entry("CLAIMED", opened.plusSeconds(20), "Claimed by runner runner-01 · claim 1"),
            entry("CHECK_FINISHED", settled.minusSeconds(30), "Merge check passed · 6m 12s", round = 1, check = "MERGE_CHECK", data = passed(372000)),
            entry("RESULT", settled, result, data = """{"state":"$state"}"""))))

    private fun landing(id: String): Pair<String, String>? = when (id) {
        flight -> "Land · Fee schedule import" to view(flight, ago(420), null, null,
            attempt("j-flight", "RUNNING", ago(400), feeSession, check = """{"name":"MERGE_CHECK","index":1,"count":1,"budgetSeconds":1800,"startedAt":"${ago(372)}"}""",
                liveness = "LIVE", heartbeat = now, output = ago(2)),
            listOf(section("Generation 1", "j-flight", "LAND_TASK", 1, "RUNNING",
                entry("ENQUEUED", ago(420), "Task marked done · queued to land on $target", claim = 0),
                entry("CLAIMED", ago(400), "Claimed by runner runner-01 · claim 1"),
                entry("STEP", ago(395), "Rebasing onto $target", phase = "REBASE"),
                entry("CHECK_STARTED", ago(372), "Merge check started · claim 1 · runner-01", round = 1, check = "MERGE_CHECK"))),
            taskId = "t-fee")
        waiting -> "Land · Reconcile settlement batches" to view(waiting, ago(18 * 60), null, null,
            attempt("j-waiting", "CHECK_FAILED", ago(17 * 60), reconcileSession),
            listOf(section("Generation 1", "j-waiting", "LAND_TASK", 1, "CHECK_FAILED",
                entry("ENQUEUED", ago(18 * 60), "Task marked done · queued to land on $target", claim = 0),
                entry("CLAIMED", ago(17 * 60), "Claimed by runner runner-01 · claim 1"),
                entry("CHECK_FINISHED", ago(13 * 60), "Task acceptance failed · exit 1 · 3m 52s", round = 1, check = "TASK_ACCEPTANCE",
                    data = failed(232000)),
                entry("RESULT", ago(13 * 60 - 5), "Check failed · nothing was pushed", data = """{"state":"CHECK_FAILED"}"""),
                entry("HANDED_TO", ago(13 * 60 - 10), "Asked the coordinator to fix it"))),
            taskId = "t-reconcile",
            checks = """[{"name":"TASK_ACCEPTANCE","exitCode":1,"expectedExitCode":0,"timedOut":false,"durationMs":232000}]""")
        payout -> "Land · Payout retry budget" to landedTask(payout, today(0.10), today(0.15))
        export -> "Land · Statement export header" to landedTask(export, today(0.25), today(0.30), "NOTHING_TO_LAND",
            "Nothing to push · the branch carried no commits", "NOTHING_TO_LAND")
        ledger -> "Land · Ledger migration order" to landedTask(ledger, today(0.40), today(0.45))
        invoice -> "Land · Invoice rounding rule" to landedTask(invoice, today(0.70), today(0.80), "ALREADY_LANDED",
            "Already on $target · 4d2a9e0", "ALREADY_LANDED")
        audit -> "Land · Audit log retention" to view(audit, yesterday(15, 40), yesterday(16, 5), "CANCELLED",
            attempt("j-audit", "CANCELLED", yesterday(15, 41), feeSession),
            listOf(section("Generation 1", "j-audit", "LAND_TASK", 1, "CANCELLED",
                entry("ENQUEUED", yesterday(15, 40), "Task marked done · queued to land on $target", claim = 0),
                entry("CANCELLED", yesterday(16, 5), "Stopped · not landed"))))
        currency -> "Land · Currency code lookup" to view(currency, yesterday(16, 20), yesterday(18, 10), "LANDED",
            attempt("j-currency-2", "LANDED", yesterday(17, 53), feeSession),
            listOf(
                section("Generation 1", "j-currency-1", "LAND_TASK", 1, "CHECK_FAILED",
                    entry("ENQUEUED", yesterday(16, 20), "Task marked done · queued to land on $target", claim = 0),
                    entry("CLAIMED", yesterday(16, 21), "Claimed by runner runner-01 · claim 1"),
                    entry("CHECK_FINISHED", yesterday(16, 39), "Merge check failed · exit 1 · 18m 02s", round = 1, check = "MERGE_CHECK",
                        data = failed(1082000)),
                    entry("HANDED_TO", yesterday(16, 39), "Asked the coordinator to fix it")),
                section("Generation 2", "j-currency-2", "LAND_TASK", 2, "LANDED",
                    entry("ENQUEUED", yesterday(17, 52), "Queued again to land on $target", claim = 0,
                        reason = "Rerun by the coordinator · the check's database container timed out starting; the task did not change"),
                    entry("CHECK_FINISHED", yesterday(18, 9), "Merge check passed · 16m 48s", round = 1, check = "MERGE_CHECK", data = passed(1008000)),
                    entry("RESULT", yesterday(18, 10), "Landed on $target · 9c2e7d1", data = """{"state":"LANDED"}"""))),
            taskId = "t-currency")
        round -> "Merge project/ledger-service → main · #4" to view(round, today(0.50), today(0.61), "MERGED",
            attempt("j-round-2", "LANDED", today(0.59), null, kind = "LAND_PROMOTION", phase = "PUSH", targetRef = "refs/heads/main"),
            listOf(
                section("Merge check · 1", "j-round-1", "CHECK_PROMOTION", 1, "READY",
                    entry("CHECK_STARTED", today(0.50), "Merge check started · claim 1 · runner-01", round = 1, check = "MERGE_CHECK"),
                    entry("CHECK_FINISHED", today(0.58), "Merge check passed · 17m 41s", round = 1, check = "MERGE_CHECK", data = passed(1061000)),
                    entry("RESULT", today(0.58), "Ready to merge into main", data = """{"state":"READY"}""")),
                section("Merge to main · 1", "j-round-2", "LAND_PROMOTION", 1, "LANDED",
                    entry("CLAIMED", today(0.59), "Claimed by runner runner-01 · claim 1"),
                    entry("STEP", today(0.595), "Reported starting the push to main", phase = "PUSH"),
                    entry("RESULT", today(0.60), "Landed on main · 3f1c2a9", data = """{"state":"LANDED"}"""))),
            subject = "PROMOTION", taskId = null, promotionId = "pr-4",
            checks = """[{"name":"MERGE_CHECK","exitCode":0,"expectedExitCode":0,"timedOut":false,"durationMs":1061000}]""")
        else -> null
    }
    private fun detail(id: String) = landing(id)?.let { (title, view) ->
        """{"id":"$id","title":"$title","status":"AWAITING_INPUT","sessionKind":"LANDING","workspace":null,"assignedRunner":null,"tags":[],"landing":$view}"""
    }
    /** What a check printed: a failed one its last lines, a passed one its count. */
    private fun log(id: String): String {
        val text = when (id) {
            waiting -> "> ledger-service@1.4.0 test\n> vitest run src/settlement\n\n FAIL  src/settlement/batches.test.ts > reconciles a split batch\n" +
                "AssertionError: expected 2 to equal 3\n  at src/settlement/batches.test.ts:58:21\n\n Test Files  1 failed | 11 passed (12)\n" +
                "      Tests  1 failed | 86 passed (87)\n"
            currency -> "> ledger-service@1.4.0 check\n> tsc -p . && vitest run\n\n FAIL  src/currency/lookup.test.ts > maps legacy codes\n" +
                "AssertionError: expected 'XAU' to be 'EUR'\n Test Files  1 failed | 23 passed (24)\n      Tests  1 failed | 190 passed (191)\n"
            flight -> "> ledger-service@1.4.0 check\n> tsc -p . && vitest run\n\n ✓ src/fees/schedule.test.ts (14 tests) 212ms\n" +
                " ✓ src/fees/import.test.ts (9 tests) 167ms\n ✓ src/ledger/post.test.ts (31 tests) 498ms\n"
            else -> " Test Files  24 passed (24)\n      Tests  191 passed (191)\n"
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
                path == "/api/auth/login" -> json("""{"accessToken":"lw-fixture-access","refreshToken":"lw-fixture-refresh","user":${user()}}""")
                path == "/api/users/me" -> json(user())
                path == "/api/workspaces" -> json("""[{"id":"$alpha","name":"Alpha","runnerId":"r1","enabled":true,"position":0,"createdAt":"2026-10-01T01:00:00.000Z"}]""")
                path == "/api/runners" -> json("""[{"id":"r1","name":"runner-01","online":true}]""")
                path == "/api/sessions" && view == "open" -> json((listOf(coord, feeSession, reconcileSession).map { members.getValue(it) } +
                    if (scoped) openLandings else emptyList()).joinToString(",", "[", "]"))
                path == "/api/sessions" && view == "completed" -> json((listOf(members.getValue(ledgerSession)) +
                    if (scoped) settledLandings else emptyList()).joinToString(",", "[", "]"))
                path == "/api/sessions" -> json("[]")
                parts.size == 4 && parts[0] == "sessions" && parts[2] == "landing" && parts[3] == "log" -> json(log(parts[1]))
                parts.size == 2 && parts[0] == "sessions" && request.method == "GET" -> json(detail(parts[1]) ?: members[parts[1]] ?: "{}")
                parts[0] == "sessions" && parts.last() == "page" -> json("""{"events":[],"hasMore":false,"lastSeq":0,"latestSeq":0}""")
                parts[0] == "sessions" && parts.last() == "events" || path == "/api/events" -> MockResponse().setHeader("Content-Type", "text/event-stream")
                    .setChunkedBody(": connected\n\n".repeat(240), 13).throttleBody(13, 1, TimeUnit.SECONDS)
                path == "/api/projects/sidebar" -> json("""[{"id":"$project","title":"Ledger service","status":"OPEN","createdAt":"2026-10-01T00:00:00Z",
                    "buckets":{"running":1},"taskCounts":{"done":12,"failed":0,"total":15},"attention":{},
                    "integration":{"line":"PROJECT_BRANCH","ref":"$target","activeJobCount":1},"startedAt":"2026-10-02T00:00:00Z"}]""")
                path == "/api/projects" -> json("""[{"id":"$project","title":"Ledger service","status":"OPEN","goal":"Move the ledger to the new schema.",
                    "createdAt":"2026-10-01T00:00:00Z"}]""")
                parts == listOf("projects", project) -> json("""{"id":"$project","title":"Ledger service","status":"OPEN",
                    "goal":"Move the ledger to the new schema.","createdAt":"2026-10-01T00:00:00Z","_count":{"tasks":15},
                    "startedAt":"2026-10-02T00:00:00Z","coordinatorSessionId":"$coord","acceptanceCriteriaItems":[]}""")
                parts == listOf("projects", project, "integration") -> json(integration)
                parts == listOf("projects", project, "open-items") -> json("""{"needsYou":[],"withCoordinator":[]}""")
                parts == listOf("projects", project, "coordinator", "status") -> json("""{"state":"LIVE","coordination":{"session":{"id":"$coord"}}}""")
                parts == listOf("projects", project, "promotions", "current") -> MockResponse().setResponseCode(200)
                parts == listOf("projects", project, "promotions", "merged") -> json(merged)
                parts[0] == "tasks" && parts.size == 2 -> json("""{"id":"${parts[1]}","title":"Fee schedule import","status":"DONE","projectId":"$project"}""")
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
    private fun text(tag: String, entry: String? = null) = compose.onAllNodes(if (entry == null) hasTestTag(tag) else hasTestTag(tag) and inEntry(entry), true)
        .fetchSemanticsNodes().firstOrNull()?.config?.getOrNull(SemanticsProperties.Text)?.joinToString("") { it.text }
    private fun texts(tag: String) = compose.onAllNodesWithTag(tag, useUnmergedTree = true).fetchSemanticsNodes()
        .mapNotNull { it.config.getOrNull(SemanticsProperties.Text)?.joinToString("") { t -> t.text } }
    private fun cardSays(entry: String, tag: String, words: String) = text(tag, entry) == words
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
