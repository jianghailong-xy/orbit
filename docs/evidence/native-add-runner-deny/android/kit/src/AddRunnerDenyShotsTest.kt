package io.orbitd.android.management

import android.graphics.Bitmap
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.text.AnnotatedString
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import io.orbitd.android.MainActivity
import io.orbitd.android.OrbitApplication
import io.orbitd.android.core.auth.AuthState
import io.orbitd.android.core.net.ServerAddress
import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.time.Instant
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.TimeUnit

/**
 * Evidence frames for task 34no050naUDViWDBEtXaZ (the native Add Runner dialogs deny an `orbit register` request), on the shared emulator
 * through the real product shell over controlled HTTP — a MockWebServer inside the instrumentation, as ManagementDeviceTest — so the
 * server's answers are the ones scripted here, not a deployed one's. Settings → Machines & models → Add Runner, then the code: a PENDING
 * request offers Deny beside Approve, and Deny says nothing was added; a request already DENIED opens denied with no Approve; an approval
 * the server refuses shows its sentence; a runner already of the name shows when it was last online, and approving says the machine is
 * registered. Kept in the evidence directory and compiled into the androidTest APK by kit.gradle; `-e theme dark` takes the dark frames.
 */
@RunWith(AndroidJUnit4::class)
class AddRunnerDenyShotsTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()
    private val instrumentation get() = InstrumentationRegistry.getInstrumentation()
    private val app get() = instrumentation.targetContext.applicationContext as OrbitApplication
    private val theme = InstrumentationRegistry.getArguments().getString("theme") ?: "light"
    private val calls = CopyOnWriteArrayList<String>()
    private val code = "ABCDE-FGH23"
    /** The request as the server keeps it ([status]), whether the lookup still reads it PENDING ([stale]), and a runner of its name. */
    @Volatile private var status = "PENDING"
    @Volatile private var stale = false
    @Volatile private var conflict = false
    private val runnerId = "0199f0a8-2222-7000-8000-000000000002"
    private val now get() = Instant.now()

    @Test fun denyTheRequestAndTheDialogsOtherWords() {
        compose.waitUntil(10_000) { app.session.state.value !is AuthState.Restoring }
        assertTrue("Dedicated signed-out debug installation required", app.session.state.value is AuthState.SignedOut)
        MockWebServer().use { server ->
            server.dispatcher = dispatcher()
            runBlocking { app.session.login(ServerAddress.parse(server.url("/").toString(), true), "ard@example.test", "controlled-fixture") }
            compose.waitUntil(15_000) { app.session.state.value is AuthState.SignedIn && app.realtime.state.value.directoryFresh }
            compose.onAllNodesWithContentDescription("Open navigation").onFirst().performClick()
            click(hasText("Settings") and hasClickAction())
            click(hasText("Machines & models") and hasClickAction())
            await("Add Runner")

            // Still to decide: Deny beside Approve; Deny posts …/deny and the dialog says nothing was added.
            lookUp()
            assertEquals(1, buttons(RunnerCopy.APPROVE)); assertEquals(1, buttons(RunnerCopy.DENY))
            compose.onNode(button(RunnerCopy.DENY)).performScrollTo()
            capture("01-pending")
            press(RunnerCopy.DENY)
            await(RunnerCopy.DEVICE_DENIED_DETAIL)
            assertEquals(calls.toString(), listOf("POST /api/runners/device/$code/deny"), decisions())
            assertEquals(0, buttons(RunnerCopy.APPROVE)); assertEquals(0, buttons(RunnerCopy.DENY))
            compose.onNode(hasText(RunnerCopy.DEVICE_DENIED_DETAIL)).performScrollTo()
            capture("02-denied")
            close()

            // Denied already: it opens denied, with no Approve, and sends nothing.
            status = "DENIED"
            lookUp(RunnerCopy.DEVICE_DENIED_DETAIL)
            assertEquals(0, buttons(RunnerCopy.APPROVE)); assertEquals(0, buttons(RunnerCopy.DENY))
            assertEquals(1, decisions().size)
            compose.onNode(hasText(RunnerCopy.DEVICE_DENIED_DETAIL)).performScrollTo()
            capture("03-denied-on-open")
            close()

            // Denied in a browser after the lookup read it: Approve is refused in the server's words, and the request stays to decide.
            stale = true
            lookUp()
            press(RunnerCopy.APPROVE)
            await("This registration request was denied — run `orbit register` again")
            assertEquals(1, buttons(RunnerCopy.APPROVE)); assertEquals(1, buttons(RunnerCopy.DENY))
            compose.onNode(hasText("This registration request was denied — run `orbit register` again")).performScrollTo()
            capture("04-refused")
            close()

            // A runner of the same name: when it was last online, Re-register in red, Deny beside it; approving says it is registered.
            status = "PENDING"; stale = false; conflict = true
            lookUp(RunnerCopy.deviceNameTaken("devbox"))
            await("Last online 3d ago. ${RunnerCopy.DEVICE_NAME_TAKEN_DETAIL}")
            assertEquals(1, buttons(RunnerCopy.REREGISTER)); assertEquals(1, buttons(RunnerCopy.DENY)); assertEquals(0, buttons(RunnerCopy.APPROVE))
            compose.onNode(button(RunnerCopy.DENY)).performScrollTo()
            capture("05-same-name")
            press(RunnerCopy.REREGISTER)
            await(RunnerCopy.deviceApprovedDetail("devbox"))
            assertEquals(0, buttons(RunnerCopy.REREGISTER)); assertEquals(0, buttons(RunnerCopy.DENY))
            compose.onNode(hasText(RunnerCopy.deviceApprovedDetail("devbox"))).performScrollTo()
            capture("06-approved")
            assertEquals(calls.toString(), listOf("POST /api/runners/device/$code/deny", "POST /api/runners/device/$code/approve",
                "POST /api/runners/device/$code/approve"), decisions())
        }
    }

    /** Add Runner's dialog, with the code put into its field through the field's own semantics — no keyboard over the frame — once the
     * machine it names shows, and [until] with it. */
    private fun lookUp(until: String = "vmi3337007") {
        click(hasText("Add Runner") and hasClickAction())
        await(RunnerCopy.NO_BROWSER)
        val field = compose.onNode(hasSetTextAction() and hasAnyAncestor(isDialog()))
        field.performScrollTo()
        field.performSemanticsAction(SemanticsActions.SetText) { it(AnnotatedString(code)) }
        await("vmi3337007"); await(until)
    }
    /** The dialog's own Close, through its semantics. */
    private fun close() {
        val close = hasText("Close") and hasClickAction() and hasAnyAncestor(isDialog())
        compose.waitUntil(10_000) { compose.onAllNodes(close).fetchSemanticsNodes().isNotEmpty() }
        compose.onNode(close).performSemanticsAction(SemanticsActions.OnClick)
        compose.waitUntil(10_000) { compose.onAllNodes(isDialog()).fetchSemanticsNodes().isEmpty() }
    }
    private fun decisions() = calls.filter { it.startsWith("POST /api/runners/device/") }
    private fun await(text: String) = compose.waitUntil(15_000) { compose.onAllNodesWithText(text, substring = true).fetchSemanticsNodes().isNotEmpty() }
    private fun buttons(label: String) = compose.onAllNodes(button(label)).fetchSemanticsNodes().size
    private fun click(matcher: SemanticsMatcher) {
        compose.waitUntil(10_000) { compose.onAllNodes(matcher).fetchSemanticsNodes().isNotEmpty() }
        val node = compose.onAllNodes(matcher).onFirst()
        try { node.performScrollTo() } catch (_: AssertionError) { }
        node.performClick()
        compose.waitForIdle()
    }
    private fun button(label: String): SemanticsMatcher = hasText(label) and hasClickAction()
    /** A dialog's button, through its semantics once it can be pressed: injected touches fail while a dialog settles. */
    private fun press(label: String) {
        compose.waitUntil(10_000) { compose.onAllNodes(button(label) and isEnabled()).fetchSemanticsNodes().isNotEmpty() }
        compose.onNode(button(label)).performSemanticsAction(SemanticsActions.OnClick)
        compose.waitForIdle()
    }
    private fun capture(label: String) {
        compose.waitForIdle(); instrumentation.waitForIdleSync()
        // Semantics can be current a frame before the display is: let the frame reach the screen.
        android.os.SystemClock.sleep(700)
        val dir = File(app.filesDir, "add-runner-deny").apply { mkdirs() }
        instrumentation.uiAutomation.takeScreenshot().let { bitmap ->
            File(dir, "$label-$theme.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }; bitmap.recycle()
        }
    }

    private fun user() = """{"id":"fixture-user","name":"Fixture","email":"ard@example.test","role":"MEMBER","avatarUpdatedAt":null,
        "preferences":{"theme":"$theme","defaultPermissionMode":"auto","notifySessionFinished":false,"notifyAgentMessage":true}}"""
    private fun runner() = """{"id":"$runnerId","name":"HPC","displayName":"HPC","hostname":"workstation","version":"0.1.240","online":true,
        "status":"ONLINE","lastHeartbeatAt":"$now","maxConcurrent":8,"activeSessions":1,"runsAsRoot":false,"selfUpdate":null,"minFreeDiskMb":null,
        "enrolledAt":"2026-09-01T10:00:00Z","engines":[{"engine":"claude","installed":true,"version":"2.1.296 (Claude Code)","auth":"yes"}]}"""
    private fun device(): String {
        val shown = if (stale) "PENDING" else status
        return """{"userCode":"$code","name":"devbox","hostname":"vmi3337007","labels":[],"maxConcurrent":16,"status":"$shown",
            "nameConflict":$conflict,"existingLastSeenAt":${if (conflict) "\"${now.minusSeconds(3 * 86_400 + 3_600)}\"" else "null"},
            "runnerId":${if (shown == "APPROVED") "\"$runnerId\"" else "null"},"createdAt":"${now.minusSeconds(19)}","expiresAt":"${now.plusSeconds(581)}"}"""
    }
    /** runners.service.ts: a PENDING request takes the decision; the same one again is answered as it stands; the other way is a 409. */
    private fun decide(wanted: String): MockResponse {
        if (status == "PENDING") { status = wanted; stale = false }
        fun json(code: Int, body: String) = MockResponse().setResponseCode(code).setHeader("Content-Type", "application/json").setBody(body)
        return when (status) {
            wanted -> json(201, if (wanted == "APPROVED") """{"ok":true,"name":"devbox","replaced":$conflict,"runnerId":"$runnerId"}""" else """{"ok":true,"name":"devbox"}""")
            "DENIED" -> json(409, """{"statusCode":409,"code":"DEVICE_ENROLLMENT_DECIDED","message":"This registration request was denied — run `orbit register` again"}""")
            else -> json(409, """{"statusCode":409,"code":"DEVICE_ENROLLMENT_DECIDED","message":"This registration request was already approved"}""")
        }
    }

    private fun dispatcher() = object : Dispatcher() {
        override fun dispatch(request: RecordedRequest): MockResponse {
            val path = request.requestUrl!!.encodedPath
            calls += "${request.method} $path"
            fun json(body: String) = MockResponse().setHeader("Content-Type", "application/json").setBody(body)
            return when {
                path == "/dl/version.json" -> json("""{"version":"0.1.240"}""")
                path == "/api/auth/methods" -> MockResponse().setResponseCode(404)
                path == "/api/auth/login" -> json("""{"accessToken":"fixture-access","refreshToken":"fixture-refresh","user":${user()}}""")
                path == "/api/users/me" -> json(user())
                path == "/api/runners" -> json("[${runner()}]")
                path == "/api/runners/device/$code" -> json(device())
                path == "/api/runners/device/$code/approve" && request.method == "POST" -> decide("APPROVED")
                path == "/api/runners/device/$code/deny" && request.method == "POST" -> decide("DENIED")
                path == "/api/events" -> MockResponse().setHeader("Content-Type", "text/event-stream")
                    .setChunkedBody(": connected\n\n".repeat(120), 13).throttleBody(13, 1, TimeUnit.SECONDS)
                request.method == "GET" -> json("[]")
                else -> json("{}")
            }
        }
    }
}
