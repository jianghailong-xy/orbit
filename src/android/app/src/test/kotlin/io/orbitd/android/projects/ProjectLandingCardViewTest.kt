package io.orbitd.android.projects

import android.graphics.Bitmap
import android.graphics.Canvas
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.unit.dp
import io.orbitd.android.MainActivity
import io.orbitd.android.TestOrbitApplication
import io.orbitd.android.ui.OrbitTheme
import java.io.File
import java.time.Instant
import java.time.ZoneOffset
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/** The Landing card's four states as drawn (A11-11; iOS 749d995c5, 3b23aa163; docs/mocks/project-landing-card, project-merge-check-row):
 * in flight — a grey card, the ring turning, the task and the branch, "Nothing to do"; queued — the same card standing still; timed
 * out — the whole card amber, a triangle where the ring was, where the runner stopped and Retry; several jobs — the head counting
 * them and a row each. Each state is written to a PNG under `src/android/build/evidence/a11f-landing-card/`. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = TestOrbitApplication::class, qualifiers = "w360dp-h640dp-xhdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class ProjectLandingCardViewTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()
    private val now = Instant.parse("2026-10-11T09:07:00Z")
    private fun iso(secondsBeforeNow: Long) = now.minusSeconds(secondsBeforeNow).toString()

    private var jobs = 0
    private var project = 0
    private val retried = mutableListOf<String>()
    private val opened = mutableListOf<String>()

    private fun job(id: String, state: String = "RUNNING", phase: String? = "CHECK", title: String = "维护每日轮数上限在服务端路径上没生效：byJob 计数恒为 0",
        started: Long = 66, heartbeat: Long? = 0, timedOut: Boolean = false, retryable: Boolean = false, kind: String = "LAND_TASK",
        landing: String? = "L1") = buildJsonObject {
        put("jobId", id); put("kind", kind); put("state", state); put("phase", phase); put("taskId", "t-$id"); put("taskTitle", title)
        put("generation", 1); put("startedAt", iso(started)); put("queuedAt", iso(started + 34)); put("heartbeatAt", heartbeat?.let(::iso))
        put("runnerName", "workstation-gpu"); put("timedOut", timedOut); put("limitSeconds", 600); put("retryable", retryable)
        landing?.let { put("landingSessionId", it) }
    }
    private fun view(vararg listed: JsonObject, waitMs: Int? = 34_000) = buildJsonObject {
        val lead = listed.first()
        put("integratingCount", listed.count { it["state"]?.jsonPrimitive?.content == "RUNNING" })
        put("queuedCount", listed.count { it["state"]?.jsonPrimitive?.content == "QUEUED" })
        putJsonObject("inFlight") {
            put("taskTitle", lead["taskTitle"]!!); put("state", lead["state"]!!); put("startedAt", lead["startedAt"]!!)
            put("kind", lead["kind"]!!); put("jobId", lead["jobId"]!!)
            put("phase", lead["phase"]!!); put("heartbeatAt", lead["heartbeatAt"]!!); put("waitMs", waitMs)
        }
        putJsonArray("landTasks") { listed.forEach { job -> addJsonObject {
            put("taskId", "t"); put("taskTitle", job["taskTitle"]!!)
            putJsonObject("integration") { putJsonObject("landTask") { put("jobId", job["jobId"]!!); put("state", job["state"]!!)
                put("targetRef", "refs/heads/project/2zwQZ2hd93IvLb59t6p9d") } }
        } } }
        put("inFlightJobs", JsonArray(listed.toList()))
    }

    private fun draw(card: LandingCard, listed: Boolean = true, toProject: Boolean = true, refusal: String? = null) {
        compose.runOnUiThread { compose.activity.setContent { OrbitTheme(darkTheme = false) {
            Surface(color = MaterialTheme.colorScheme.background) {
                Column(Modifier.padding(16.dp)) {
                    ProjectLandingCardView(card, onOpenJobs = if (listed) ({ jobs++ }) else null, onOpenProject = if (toProject) ({ project++ }) else null,
                        openLanding = { opened += it }, retry = { id -> retried += id; refusal })
                }
            }
        } } }
        compose.waitForIdle()
    }

    private fun says(tag: String, text: String) = compose.onNodeWithTag(tag, useUnmergedTree = true).assertTextEquals(text)

    @Test fun inFlightTheCardIsGreyItsRingTurnsAndThereIsNothingToDo() {
        draw(ProjectPage.landingCard(view(job("j-1")), now, now, false)!!)
        says("landing-head:title", "Landing"); says("landing-head:right", "1m 6s")
        says("landing-head:detail", "checking · waited 0m 34s · updated just now")
        compose.onNodeWithTag("landing-ring:running", useUnmergedTree = true).assertExists()
        says("landing-card:what", "维护每日轮数上限在服务端路径上没生效：byJob 计数恒为 0")
        says("landing-card:onto", "onto project/2zwQZ2hd93IvLb59t6p9d")
        compose.onNodeWithText(ProjectPage.landingNothingToDo, useUnmergedTree = true).assertExists()
        compose.onNodeWithTag("landing-card:retry").assertDoesNotExist(); compose.onNodeWithTag("landing-head:timed-out", useUnmergedTree = true).assertDoesNotExist()
        assertGrey(shot("1-in-flight"))
        // The whole card is the press: the jobs it counts.
        compose.onNodeWithTag("landing-card:body").performClick()
        assertEquals(1, jobs)
    }

    @Test fun queuedTheSameCardStandsStill() {
        draw(ProjectPage.landingCard(view(job("j-1", state = "QUEUED", phase = null, started = 65, heartbeat = null), waitMs = null), now, now, false)!!)
        says("landing-head:title", "Landing"); says("landing-head:right", "1m 5s"); says("landing-head:detail", "queued · updated just now")
        compose.onNodeWithTag("landing-ring:still", useUnmergedTree = true).assertExists()
        compose.onNodeWithTag("landing-ring:running", useUnmergedTree = true).assertDoesNotExist()
        compose.onNodeWithText(ProjectPage.landingNothingToDo, useUnmergedTree = true).assertExists()
        assertGrey(shot("2-queued"))
    }

    @Test fun timedOutTheWholeCardTurnsAmberSaysWhereTheRunnerStoppedAndOffersRetry() {
        val card = ProjectPage.landingCard(view(job("j-c5", started = 6_630, heartbeat = 6_620, timedOut = true, retryable = true)), now, now, false, ZoneOffset.UTC)!!
        draw(card, refusal = "${ProjectPage.landingRetryFailed} — The job is no longer running.")
        says("landing-head:title", "Landing"); says("landing-head:right", "Timed out"); says("landing-head:detail", "No report for 110m · limit 10m")
        compose.onNodeWithTag("landing-head:timed-out", useUnmergedTree = true).assertExists()
        compose.onNodeWithTag("landing-ring:running", useUnmergedTree = true).assertDoesNotExist()
        says("landing-card:detail", "Runner workstation-gpu took it at 07:16 · stopped at checking · no push recorded")
        compose.onNodeWithText(ProjectPage.landingNothingToDo, useUnmergedTree = true).assertDoesNotExist()
        compose.onNodeWithTag("landing-card:all-jobs").assertTextEquals("${ProjectPage.landingAllJobs} ›")
        assertAmber(shot("3-timed-out"))
        // Retry is the server's door for the lead job; a refusal is said under the card in its words.
        compose.onNodeWithTag("landing-card:retry").assertTextEquals(ProjectPage.landingRetry).performClick()
        compose.waitForIdle()
        assertEquals(listOf("j-c5"), retried)
        compose.onNodeWithTag("landing-card:error").assertTextEquals("Retry failed — The job is no longer running.")
        compose.onNodeWithTag("landing-card:all-jobs").performClick()
        assertEquals(1, jobs)
        // A server that will not take a retry: no press, and from a server that lists no jobs, no "All jobs" either.
        draw(ProjectPage.landingCard(view(job("j-c5", started = 6_630, heartbeat = 6_620, timedOut = true)), now, now, false)!!, listed = false)
        compose.onNodeWithTag("landing-card:retry").assertDoesNotExist(); compose.onNodeWithTag("landing-card:all-jobs").assertDoesNotExist()
    }

    @Test fun severalJobsTheHeadCountsThemAndEachIsARowInItsOwnState() {
        draw(ProjectPage.landingCard(view(job("j-1"), job("j-2", state = "QUEUED", phase = null, title = "维护：同一会话跨页时，dossier 在一轮里重复发出",
            started = 32, heartbeat = null)), now, now, false)!!)
        says("landing-head:title", "Landing 2 jobs"); says("landing-head:detail", "checking · waited 0m 34s · updated just now")
        compose.onNode(hasText("checking") and hasAnyAncestor(hasTestTag("landing-card:job:j-1")), useUnmergedTree = true).assertExists()
        compose.onNode(hasText("queued") and hasAnyAncestor(hasTestTag("landing-card:job:j-2")), useUnmergedTree = true).assertExists()
        compose.onNodeWithTag("landing-card:what", useUnmergedTree = true).assertDoesNotExist()
        says("landing-card:onto", "onto project/2zwQZ2hd93IvLb59t6p9d")
        assertGrey(shot("4-two-jobs"))
    }

    /** From a server that lists no jobs the press goes to the project page; where there is nowhere left to go — the project page itself —
     * the card is a read. */
    @Test fun aServerThatListsNoJobsOpensTheProjectAndThePageItselfDrawsARead() {
        val older = buildJsonObject {
            put("integratingCount", 1); put("queuedCount", 0)
            putJsonObject("inFlight") { put("taskTitle", "C5"); put("state", "RUNNING"); put("startedAt", iso(666)); put("kind", "LAND_TASK")
                put("phase", "CHECK"); put("heartbeatAt", iso(660)) }
        }
        val card = ProjectPage.landingCard(older, now, now, false)!!
        draw(card, listed = false)
        // An older server's silent runner: "No report", said once, the clock frozen at the last report.
        says("landing-head:right", "0m 6s"); says("landing-head:detail", "No report for 11m")
        compose.onNodeWithTag("landing-card:body").performClick()
        assertEquals(1, project); assertEquals(0, jobs)
        draw(card, listed = false, toProject = false)
        assertFalse(SemanticsActions.OnClick in compose.onNodeWithTag("landing-card:body").fetchSemanticsNode().config)
    }

    /** 方案 A: a card holding one job names its landing at the card's foot — beside the card's own press, not inside it — and a
     * server that names none says so in grey in that same slot, with nothing to press. */
    @Test fun oneJobsCardFootNamesItsLandingOrSaysTheServerNamesNone() {
        draw(ProjectPage.landingCard(view(job("j-1")), now, now, false)!!)
        compose.onNodeWithTag("landing-card:open-landing").assertTextEquals("Open landing ›").performClick()
        assertEquals(listOf("L1"), opened)
        compose.onNodeWithTag("landing-card:body").performClick()
        assertEquals("the card's own press is still the jobs list", 1, jobs)
        shot("6-one-job-open-landing")
        // The same slot on a server that lists the job but names no landing: the grey sentence, and no press.
        draw(ProjectPage.landingCard(view(job("j-1", landing = null)), now, now, false)!!)
        compose.onNodeWithTag("landing-card:open-landing").assertTextEquals("No landing page on this server yet")
        assertFalse(SemanticsActions.OnClick in compose.onNodeWithTag("landing-card:open-landing").fetchSemanticsNode().config)
        shot("7-no-landing-on-this-server")
    }

    /** Several jobs: one way in per row, drawn outside the card's press; the merge job's row carries none — the merge card is
     * that round's way in. */
    @Test fun severalJobsEachRowNamesItsOwnLandingExceptTheMergeJobs() {
        draw(ProjectPage.landingCard(view(job("j-1"), job("j-2", state = "QUEUED", phase = null, kind = "CHECK_PROMOTION",
            title = "Merge project/launch → main", started = 32, heartbeat = null)), now, now, false)!!)
        compose.onNodeWithTag("landing-card:job:j-1:open-landing").assertTextEquals("Open landing ›").performClick()
        assertEquals(listOf("L1"), opened)
        compose.onNodeWithTag("landing-card:job:j-2:open-landing").assertDoesNotExist()
        compose.onNodeWithTag("landing-card:open-landing").assertDoesNotExist()
        shot("8-many-jobs-open-landing")
    }

    /** A card whose only job is a merge into main — a merge check running, or the merge itself queued — draws its head and nothing
     * under it: that job lands no task, so "Nothing to do" would be about a task that is not there (board v4 04). A task's card keeps it. */
    @Test fun aLoneMergeJobsCardSaysNothingUnderItsHead() {
        for ((kind, word) in listOf("CHECK_PROMOTION" to "Merge check", "LAND_PROMOTION" to "Merge to main")) {
            val queued = kind == "LAND_PROMOTION"
            val merge = buildJsonObject {
                put("jobId", "j-m"); put("kind", kind); put("state", if (queued) "QUEUED" else "RUNNING"); put("phase", if (queued) null else "CHECK")
                put("taskId", null as String?); put("taskTitle", null as String?); put("generation", 1); put("startedAt", iso(66))
                put("queuedAt", iso(100)); put("heartbeatAt", if (queued) null else iso(0)); put("runnerName", null as String?)
                put("timedOut", false); put("limitSeconds", 600); put("retryable", false); put("landingSessionId", "L-m")
            }
            val lone = buildJsonObject {
                put("integratingCount", if (queued) 0 else 1); put("queuedCount", if (queued) 1 else 0)
                putJsonObject("inFlight") {
                    put("taskTitle", null as String?); put("state", merge["state"]!!); put("startedAt", merge["startedAt"]!!); put("kind", kind)
                    put("jobId", "j-m"); put("phase", merge["phase"]!!); put("heartbeatAt", merge["heartbeatAt"]!!)
                }
                put("inFlightJobs", JsonArray(listOf(merge)))
            }
            draw(ProjectPage.landingCard(lone, now, now, false)!!)
            says("landing-head:title", word)
            compose.onNodeWithTag("landing-card:what", useUnmergedTree = true).assertDoesNotExist()
            compose.onNodeWithText(ProjectPage.landingNothingToDo, useUnmergedTree = true).assertDoesNotExist()
        }
        draw(ProjectPage.landingCard(view(job("j-1")), now, now, false)!!)
        compose.onNodeWithText(ProjectPage.landingNothingToDo, useUnmergedTree = true).assertExists()
    }

    private val output: File by lazy {
        val root = generateSequence(File(System.getProperty("user.dir")).absoluteFile) { it.parentFile }
            .first { File(it, "src/android/settings.gradle.kts").isFile }
        File(root, "src/android/build/evidence/a11f-landing-card").also { it.mkdirs() }
    }

    /** The window as drawn, written beside its semantics tree; the card's background is sampled inside its padding. */
    private fun shot(name: String): Int {
        compose.waitForIdle()
        File(output, "$name-semantics.txt").writeText(compose.onRoot().printToString())
        val view = compose.activity.window.decorView
        val bitmap = Bitmap.createBitmap(view.width, view.height, Bitmap.Config.ARGB_8888)
        view.draw(Canvas(bitmap))
        File(output, "$name.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
        val bounds = compose.onNodeWithTag("landing-card").fetchSemanticsNode().boundsInWindow
        val pixel = bitmap.getPixel(bounds.left.toInt() + 6, (bounds.top + bounds.bottom).toInt() / 2)
        bitmap.recycle()
        return pixel
    }
    private fun channels(pixel: Int) = Triple((pixel shr 16) and 0xFF, (pixel shr 8) and 0xFF, pixel and 0xFF)
    /** The grey card: the neutral tint over the page, its three channels within a hair of each other. */
    private fun assertGrey(pixel: Int) = channels(pixel).let { (r, g, b) -> assertTrue("grey card, got $r/$g/$b", maxOf(r, g, b) - minOf(r, g, b) <= 4 && r < 250) }
    /** The amber card: the warning ink's wash, red well above blue. */
    private fun assertAmber(pixel: Int) = channels(pixel).let { (r, g, b) -> assertTrue("amber card, got $r/$g/$b", r - b >= 8 && r >= g) }

    /** A §7.2 V6 read: the step clock against its budget, the claim and its round, the output's last
     * move and the server's liveness, on the same head the six surfaces wear. */
    private fun v6view(liveness: String, step: Long = 110, heartbeat: Long = 0, outputAge: Long = 6): JsonObject {
        val check = """{"name":"TASK_ACCEPTANCE","index":1,"count":3,"budgetSeconds":3600,"startedAt":"${iso(step)}"}"""
        val job = """{"jobId":"j-1","kind":"LAND_TASK","state":"RUNNING","phase":"CHECK","taskId":"t-1",
            "taskTitle":"维护每日轮数上限在服务端路径上没生效：byJob 计数恒为 0","generation":1,
            "startedAt":"${iso(step)}","queuedAt":"${iso(step + 34)}","heartbeatAt":"${iso(heartbeat)}",
            "runner":"wikova","runnerName":"wikova","timedOut":false,"limitSeconds":null,"retryable":false,
            "progressProtocol":"v2","claim":1,"round":1,"check":$check,
            "stepStartedAt":"${iso(step)}","outputMovedAt":"${iso(outputAge)}","typicalMs":null,"liveness":"$liveness"}"""
        return Json.parseToJsonElement("""{"integratingCount":1,"queuedCount":0,
            "inFlight":$job,"inFlightJobs":[$job],
            "landTasks":[{"taskId":"t-1","taskTitle":"x","integration":{"landTask":{"jobId":"j-1","state":"RUNNING",
              "phase":"CHECK","targetRef":"refs/heads/project/2zwQZ2hd93IvLb59t6p9d","startedAt":"${iso(step)}"}}}]}""").jsonObject
    }

    /** §7.2 V6's readings as drawn: LIVE and QUIET run the clock, SILENT freezes it at the runner's last
     * word, LEGACY says why its quiet is not a stall — each written to a PNG for the evidence. */
    @Test fun theV6LivenessReadingsAreDrawnOnTheHead() {
        val readings = listOf(
            Triple("LIVE", v6view("LIVE"), "1m 50s of 60m" to "checking · output 6s ago · claim 1 · round 1 of 3"),
            Triple("QUIET", v6view("QUIET", outputAge = 840), "1m 50s of 60m" to
                "checking · no output for 14m · within its 60m budget · claim 1 · round 1 of 3"),
            Triple("SILENT", v6view("SILENT", step = 600, heartbeat = 240), "6m 0s of 60m" to
                "checking · no word from runner wikova for 4m · claim 1 · round 1 of 3"),
            Triple("LEGACY", v6view("LEGACY", step = 720, heartbeat = 720), "12m 0s of 60m" to
                "checking · reports only between steps · claim 1 · round 1 of 3"))
        for ((name, view, copy) in readings) {
            draw(ProjectPage.landingCard(view, now, now, false)!!)
            says("landing-head:right", copy.first)
            says("landing-head:detail", copy.second)
            // A frozen clock keeps the ring still; LIVE and QUIET turn it, LEGACY keeps turning it
            // because its quiet is the protocol rather than a stall.
            if (name == "SILENT") compose.onNodeWithTag("landing-ring:running", useUnmergedTree = true).assertDoesNotExist()
            else compose.onNodeWithTag("landing-ring:running", useUnmergedTree = true).assertExists()
            shot("5-v6-${name.lowercase()}")
        }
        // A server that sends none draws the older head, word for word (this file's other cases).
        draw(ProjectPage.landingCard(view(job("j-old")), now, now, false)!!)
        says("landing-head:right", "1m 6s"); says("landing-head:detail", "checking · waited 0m 34s · updated just now")
        shot("5-v6-older-server")
    }
}
