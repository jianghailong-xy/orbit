package io.orbitd.android.composer

import android.app.UiAutomation
import android.content.Intent
import android.graphics.Bitmap
import android.net.Uri
import android.os.SystemClock
import android.view.KeyEvent
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import io.orbitd.android.MainActivity
import io.orbitd.android.OrbitApplication
import io.orbitd.android.core.auth.AuthState
import io.orbitd.android.core.net.ServerAddress
import io.orbitd.android.navigation.ObjectId
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import okhttp3.mockwebserver.*
import java.io.File
import java.time.Instant
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.TimeUnit
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Boards 03 (Android 1 and 2) and 02 (states 2–5) on the emulator, through the real product shell over controlled HTTP
 * (MockWebServer inside the instrumentation), light and dark: the context dialog of a coordinator and of an ordinary session while
 * it runs, the confirm, and the handoff in the conversation — writing, handing over, failed, handed over, and the successor's note.
 * Every answer is a fixture in the shape docs/coordinator-handoff.md gives; no real project, runner or prompt is claimed. Its
 * screenshots land in files/coordinator-handoff, which scripts/coordinator-handoff-device-test.sh pulls.
 */
@RunWith(AndroidJUnit4::class)
class CoordinatorHandoffDeviceTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()
    private val instrumentation get() = InstrumentationRegistry.getInstrumentation()
    private val app get() = instrumentation.targetContext.applicationContext as OrbitApplication
    private val automation: UiAutomation get() = instrumentation.uiAutomation
    private val calls = CopyOnWriteArrayList<String>()
    private val now get() = Instant.now()
    private fun at(seconds: Long) = now.plusSeconds(seconds).toString()

    private val workspace = "01a0cca7-8609-70ed-a0e2-d4b55b8a0c01"
    private val runner = "01a0cca7-8609-70ed-a0e2-d4b55b8a0c02"
    private val coordinator = "01a0cca7-8609-70ed-a0e2-d4b55b8a0c03"
    private val successor = "01a0cca7-8609-70ed-a0e2-d4b55b8a0c04"
    private val ordinary = "01a0cca7-8609-70ed-a0e2-d4b55b8a0c05"
    private val project = "01a0cca7-8609-70ed-a0e2-d4b55b8a0c06"

    @Volatile private var theme = "light"
    /** The coordinator's handoff as its detail says it: none, WRITING, HANDING_OVER, FAILED or COMPLETED. */
    @Volatile private var handoff: String? = null
    @Volatile private var handoffStartedAt = now.toString()

    @Test fun handoffScreensLight() = tour("light")
    @Test fun handoffScreensDark() = tour("dark")

    private fun tour(pass: String) {
        compose.waitUntil(10_000) { app.session.state.value !is AuthState.Restoring }
        assertTrue("Dedicated signed-out debug installation required", app.session.state.value is AuthState.SignedOut)
        theme = pass
        MockWebServer().use { server ->
            server.dispatcher = dispatcher()
            try {
                signIn(server)
                dismissSystemDialogs()
                // Board 03 Android 1: a coordinator's dialog, both actions.
                handoff = null
                open("orbit-session:$coordinator")
                await("Fix login redirect is in review")
                openContext()
                // Compact waits for the runner's slash commands, which the dialog reads as it opens.
                compose.waitUntil(15_000) { has(hasTestTag("context-action-new-coordinator")) && has(hasTestTag("context-action-compact")) }
                compose.onNodeWithTag("context-action-new-coordinator").performScrollTo()
                capture("03-android1-coordinator-dialog-$pass")
                // Board 02 ① as board 03 asks of a phone: the confirm, the waits as a count.
                press(hasTestTag("context-action-new-coordinator"))
                await("2 pending waits move over")
                capture("03-confirm-$pass")
                press(hasTestTag("handoff-confirm-hand-over"))
                compose.waitUntil(15_000) { calls.contains("POST /api/projects/$project/coordinator/handoff") }
                // 02-2: writing the note, the composer locked; then handing over.
                handoff = "WRITING"; handoffStartedAt = at(-24)
                reopen(coordinator)
                compose.waitUntil(15_000) { has(hasTestTag("handoff-progress")) }
                capture("02-2-writing-$pass")
                handoff = "HANDING_OVER"
                reopen(coordinator)
                await("Handing over to a new coordinator…")
                capture("02-2-handing-over-$pass")
                // 02-5: the note was not written.
                handoff = "FAILED"
                reopen(coordinator)
                compose.waitUntil(15_000) { has(hasTestTag("handoff-failed")) }
                capture("02-5-failed-$pass")
                // 02-4: handed over, and Open it to the successor — 02-3, with its moved waits opened.
                handoff = "COMPLETED"
                reopen(coordinator)
                compose.waitUntil(15_000) { has(hasTestTag("handoff-handed-over")) }
                capture("02-4-handed-over-$pass")
                press(hasTestTag("handoff-open-successor"))
                compose.waitUntil(15_000) { has(hasTestTag("handoff-note-card")) }
                capture("02-3-successor-$pass")
                press(hasTestTag("handoff-waits-moved"))
                await("Waiting for “Fix login redirect” to be Done")
                capture("02-3-successor-waits-$pass")
                back()
                // Board 03 Android 2: an ordinary session while it runs — Compact only, greyed with why.
                open("orbit-session:$ordinary")
                await("Working on the retry backoff")
                openContext()
                await("Available when this turn ends.")
                compose.onNodeWithTag("context-action-compact").performScrollTo()
                capture("03-android2-running-dialog-$pass")
                click(hasText("Close") and hasAnyAncestor(isDialog()))
            } catch (e: Throwable) {
                capture("$pass-failed"); throw e
            } finally {
                File(dir, "requests-$pass.txt").writeText(calls.joinToString("\n"))
                runBlocking { app.session.logout() }
            }
        }
    }

    // The shell

    private val dir get() = File(app.filesDir, "coordinator-handoff").apply { mkdirs() }
    private fun has(matcher: SemanticsMatcher) = compose.onAllNodes(matcher, useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty()
    private fun signIn(server: MockWebServer) {
        runBlocking { app.session.login(ServerAddress.parse(server.url("/").toString(), true), "handoff@example.test", "controlled-fixture") }
        compose.waitUntil(15_000) { app.session.state.value is AuthState.SignedIn && app.realtime.state.value.directoryFresh }
    }
    private fun open(link: String) {
        compose.activityRule.scenario.onActivity {
            val launch = it.intent
            MainActivity::class.java.getDeclaredMethod("onNewIntent", Intent::class.java).apply { isAccessible = true }
                .invoke(it, Intent(Intent.ACTION_VIEW, Uri.parse(link)).setClass(it, MainActivity::class.java))
            it.intent = launch
        }
        compose.waitForIdle()
    }
    /** The session page again, read afresh: a system dialog under load can eat the Back, so the store is also asked to read it. */
    private fun reopen(id: String) {
        back(); open("orbit-session:$id"); app.realtime.refreshSession(); compose.waitForIdle()
        dismissSystemDialogs()
    }
    /** A cold emulator under load can show "isn't responding" over the app: it is not this app's, and it is closed. */
    private fun dismissSystemDialogs() {
        automation.executeShellCommand("am broadcast -a android.intent.action.CLOSE_SYSTEM_DIALOGS").close()
        compose.waitForIdle()
    }
    private fun openContext() {
        click(hasText("· Usage", substring = true) and hasClickAction())
        await("Context and plan usage")
    }
    private fun await(text: String) {
        compose.waitUntil(15_000) { compose.onAllNodesWithText(text, substring = true, useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty() }
    }
    private fun click(matcher: SemanticsMatcher) {
        compose.waitUntil(15_000) { compose.onAllNodes(matcher).fetchSemanticsNodes().isNotEmpty() }
        compose.onAllNodes(matcher).onFirst().performClick()
        compose.waitForIdle()
    }
    /** Inside a dialog an injected touch can miss while it settles: the node's own click, once it is enabled. */
    private fun press(matcher: SemanticsMatcher) {
        compose.waitUntil(15_000) { compose.onAllNodes(matcher and isEnabled()).fetchSemanticsNodes().isNotEmpty() }
        compose.onAllNodes(matcher).onFirst().performSemanticsAction(SemanticsActions.OnClick)
        compose.waitForIdle()
    }
    private fun back() { instrumentation.sendKeyDownUpSync(KeyEvent.KEYCODE_BACK); compose.waitForIdle() }
    private fun capture(label: String) {
        dismissSystemDialogs()
        compose.waitForIdle(); instrumentation.waitForIdleSync()
        SystemClock.sleep(900)
        val bitmap = (1..4).firstNotNullOfOrNull { automation.takeScreenshot() ?: run { SystemClock.sleep(1_000); null } } ?: return
        File(dir, "$label.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
        bitmap.recycle()
    }

    // The controlled server

    private fun user() = """{"id":"fixture-user","name":"Handoff fixture","email":"handoff@example.test","role":"ADMIN","avatarUpdatedAt":null,
        "preferences":{"theme":"$theme","defaultPermissionMode":"default"}}"""
    private fun workspaceJson() = """{"id":"$workspace","name":"orbit","runnerId":"$runner","enabled":true,"workDir":"/root/orbit","provider":"claude",
        "model":"claude-opus-5-5","lastProvider":"claude","lastEngine":"claude","env":{},"position":0,"createdAt":"2026-09-01T00:00:00Z"}"""
    private fun runnerJson() = """{"id":"$runner","name":"hpc","displayName":"hpc","version":"0.1.262","online":true,"status":"ONLINE","lastHeartbeatAt":"$now",
        "maxConcurrent":4,"activeSessions":1,"capabilities":[],"engines":[{"engine":"claude","installed":true,"version":"2.1.302","auth":"yes"}],
        "modelCatalog":{"claude":[{"value":"claude-opus-5-5","label":"Opus 5.5","contextWindow":1000000}]},
        "commands":[{"name":"compact","type":"command","provider":"claude","builtin":true,"description":"Clear conversation history but keep a summary in context"}],
        "planUsage":{"claude":{"provider":"claude","fetchedAt":"${at(-60)}","fiveHour":{"utilization":79,"resetsAt":"${at(3600)}"}}},
        "enrolledAt":"2026-09-01T00:00:00Z"}"""
    private val membership = """{"projectId":"$project","projectTitle":"Checkout redesign","projectStatus":"OPEN","role":"COORDINATOR"}"""
    private fun handoffJson() = when (val state = handoff) {
        null -> "null"
        else -> """{"state":"$state","startedAt":"$handoffStartedAt",
            "failureCode":${if (state == "FAILED") "\"TURN_FAILED\"" else "null"},
            "failureReason":${if (state == "FAILED") "\"The handoff note wasn't written: the turn failed.\"" else "null"},
            "handedOverToSessionId":${if (state == "COMPLETED") "\"$successor\"" else "null"}}"""
    }
    private fun sessionJson(id: String): String {
        val outgoing = id == coordinator
        val completed = outgoing && handoff == "COMPLETED"
        val status = when {
            id == ordinary -> "RUNNING"
            outgoing && handoff == "WRITING" -> "RUNNING"
            else -> "AWAITING_INPUT"
        }
        val title = if (id == ordinary) "Payment retries" else "Checkout redesign"
        val member = if (id == ordinary || completed) "null" else membership
        val received = if (id != successor) "null" else """{"handoffFromSessionId":"$coordinator",
            "note":"Where things stand\n- 4 of 6 tasks done; Fix login redirect in review.\nAgreed with the owner\n- Don't merge Payment retries before Friday's release.\nWaiting on\n- Evidence for Fix login redirect.\nNext\n- Ask for the merge once that evidence is in.",
            "handedOverAt":"${at(-120)}","movedWaits":[{"id":"w1","label":"Waiting for “Fix login redirect” to be Done","paused":false},
            {"id":"w2","label":"Session “Payment retries” finishing its turn","paused":false}]}"""
        return """{"id":"$id","title":"$title","status":"$status","runState":"$status","runStatus":"$status",
            "lifecycleState":"${if (completed) "COMPLETED" else "OPEN"}","engine":"claude","provider":"claude","model":"claude-opus-5-5","numTurns":3,
            "assignedRunnerId":"$runner","assignedRunner":{"id":"$runner","name":"hpc"},"agentId":"$workspace","agent":{"id":"$workspace","name":"orbit"},
            "workspace":{"id":"$workspace","name":"orbit"},"createdAt":"${at(-3600)}","lastTurnAt":"${at(-60)}",
            "capabilities":{"canSend":true,"canResume":false,"canComplete":true},"tags":[],"pendingApprovals":0,
            "projectMembership":$member,"coordinatorHandoff":${if (outgoing) handoffJson() else "null"},"coordinatorHandoffReceived":$received}"""
    }
    private fun events(id: String): String {
        var seq = 0
        fun event(type: String, text: String, tokens: Long? = null) = buildJsonObject {
            put("type", type); put("seq", ++seq); put("ts", at(-600L + seq * 30)); putJsonObject("payload") {
                put("text", text); tokens?.let { put("contextTokens", it); put("contextWindow", 1_000_000) } } }.toString()
        val list = when (id) {
            ordinary -> listOf(event("user", "Retries back off too fast against the payment gateway. Fix it."),
                event("assistant", "Working on the retry backoff…", 410_000))
            successor -> listOf(event("assistant", "Picked up from the handoff. I re-read the project and its tasks — it matches: 4 of 6 done, one in review…", 120_000))
            else -> listOfNotNull(event("user", "Where are we?"),
                event("assistant", "…Fix login redirect is in review; I'm waiting on its evidence before asking you about the merge.", 820_000),
                if (handoff in setOf("WRITING", "HANDING_OVER", "FAILED", "COMPLETED")) event("user",
                    "From Orbit · handoff note\n\nThe owner is handing this project over to a new coordinator conversation.") else null,
                if (handoff in setOf("WRITING", "HANDING_OVER", "COMPLETED")) event("assistant",
                    "Handoff\nWhere things stand: 4 of 6 tasks done…", 830_000) else null)
        }
        return """{"events":${list.joinToString(",", "[", "]")},"hasMore":false}"""
    }

    private fun dispatcher() = object : Dispatcher() {
        override fun dispatch(request: RecordedRequest): MockResponse {
            val ids = listOf(workspace, runner, coordinator, successor, ordinary, project)
            val path = request.requestUrl!!.encodedPath.split('/').joinToString("/") { part -> ids.firstOrNull { ObjectId.same(it, part) } ?: part }
            calls += "${request.method} $path"
            if (path == "/dl/version.json") return json("""{"version":"0.1.262"}""")
            if (path == "/api/auth/methods") return MockResponse().setResponseCode(404)
            if (path == "/api/events" || path.startsWith("/api/sessions/") && path.endsWith("/events") && request.requestUrl!!.queryParameter("sinceSeq") != null)
                return MockResponse().setHeader("Content-Type", "text/event-stream").setChunkedBody(": connected\n\n".repeat(120), 13)
                    .throttleBody(13, 1, TimeUnit.SECONDS)
            val session = listOf(coordinator, successor, ordinary).firstOrNull { path == "/api/sessions/$it" }
            val page = listOf(coordinator, successor, ordinary).firstOrNull { path == "/api/sessions/$it/events/page" }
            val body = when {
                path == "/api/auth/login" -> """{"accessToken":"fixture-access","refreshToken":"fixture-refresh","user":${user()}}"""
                path == "/api/auth/logout" -> "{}"
                path == "/api/users/me" -> user()
                path == "/api/workspaces" -> "[${workspaceJson()}]"
                path == "/api/workspaces/$workspace" -> workspaceJson()
                path == "/api/runners" -> "[${runnerJson()}]"
                path == "/api/runners/$runner" -> runnerJson()
                path == "/api/sessions" -> if (request.requestUrl!!.queryParameter("view") == "open")
                    "[${sessionJson(coordinator)},${sessionJson(successor)},${sessionJson(ordinary)}]" else "[]"
                session != null -> sessionJson(session)
                page != null -> events(page)
                path == "/api/projects/$project/coordinator/pending-waits" ->
                    """[{"id":"w1","label":"Waiting for “Fix login redirect” to be Done","paused":false},{"id":"w2","label":"Session “Payment retries” finishing its turn","paused":true}]"""
                path.startsWith("/api/projects/$project/coordinator/handoff") ->
                    """{"projectId":"$project","sessionId":"$coordinator","state":"WRITING","startedAt":"$now","failureCode":null,"failureReason":null,"handedOverToSessionId":null,"movedWaits":[]}"""
                path == "/api/providers/pools" || path == "/api/providers/shared-pools" -> "[]"
                request.method == "GET" -> "[]"
                else -> "{}"
            }
            return json(body)
        }
        private fun json(body: String) = MockResponse().setHeader("Content-Type", "application/json").setBody(body)
    }
}
