package io.orbitd.android.composer

import android.graphics.Bitmap
import android.os.Process
import android.os.SystemClock
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import io.orbitd.android.MainActivity
import io.orbitd.android.OrbitApplication
import io.orbitd.android.auth.chooseServer
import io.orbitd.android.auth.pressSignIn
import io.orbitd.android.core.auth.AuthState
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * A session held by its GitHub workspace's clone, in the real app against the composer fixture: the full-height waiting card (empty
 * conversation), the card under a transcript, and the list row, with the clone's state and percentage relayed as `agent.changed`
 * frames on the account's event stream. Captures are the device's own screenshots.
 */
@RunWith(AndroidJUnit4::class)
class CloneWaitDeviceTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()
    private val instrument get() = InstrumentationRegistry.getInstrumentation()
    private val app get() = instrument.targetContext.applicationContext as OrbitApplication
    private val server get() = InstrumentationRegistry.getArguments().getString("a07_server") ?: "http://127.0.0.1:18767"
    private val evidence get() = File(app.filesDir, "a07-composer").apply { mkdirs() }
    private val workspace = "01a0cca7-8609-70ed-a0e2-d4b55b832b61"

    private fun detail(state: String) =
        """{"status":"QUEUED","extraDetail":{"queuedReason":"WORKSPACE_CLONING","workspace":{"id":"$workspace","name":"widgets","repoUrl":"https://github.com/acme/widgets.git","cloneState":"$state"}}}"""
    private fun frame(state: String, progress: Int?) =
        """{"type":"agent.changed","sessionId":"","agentId":null,"ts":"2026-11-22T12:00:00Z","data":{"agentId":"$workspace","affectsTaskRows":false,"clone":{"state":"$state"${progress?.let { ""","progress":$it""" } ?: ""}}}}"""

    @Test fun waitingCardsAndRow() {
        instrument.sendStatus(0, android.os.Bundle().apply { putString("a07_pid", Process.myPid().toString()) })
        compose.waitUntil(10000) { app.session.state.value !is AuthState.Restoring }
        runBlocking { app.session.logout() }
        control("""{"reset":true}"""); control(detail("PENDING"))
        awaitText("Welcome back")
        compose.chooseServer(server)
        compose.onNodeWithText("Email").performTextReplacement("a07@example.test")
        compose.onNodeWithText("Password").performTextReplacement("a07-fixture-password")
        compose.pressSignIn()
        compose.waitUntil(15000) { app.session.state.value is AuthState.SignedIn && app.realtime.state.value.directoryFresh }
        awaitText("Composer conversation"); capture("list-pending")
        compose.onNodeWithText("Composer conversation").performClick()
        // Full-height card, empty conversation.
        awaitText("Waiting to clone acme/widgets"); awaitText("On Fixture runner. This session starts when the clone is done.")
        capture("full-pending")
        control("""{"extraDetail":${extra("CLONING")},"events":[${frame("CLONING", 42)}]}""")
        awaitText("Cloning acme/widgets"); awaitText("42%"); capture("full-cloning-42")
        // The list row, once a percentage is heard.
        shell("input keyevent KEYCODE_BACK")
        awaitText("Cloning · 42%"); capture("list-cloning-42")
        // Under a transcript.
        control("""{"extraDetail":${extra("PENDING")},"rows":[{"seq":1,"type":"user","turnId":"t1","payload":{"text":"Add a dark mode switch to the settings page."}},
            {"seq":2,"type":"assistant","payload":{"text":"I'll start as soon as the repository is on the machine."}}],
            "events":[${frame("PENDING", null)}]}""")
        compose.onNodeWithText("Composer conversation").performClick()
        awaitText("Waiting to clone acme/widgets"); awaitText("Add a dark mode switch to the settings page.")
        // The spinner turns: several frames, so one shows its arc open.
        // The rule's clock stands still while the test sleeps, so it is stepped by hand: each frame is the spinner a little further round.
        compose.mainClock.autoAdvance = false
        for (i in 1..3) { compose.mainClock.advanceTimeBy(260L); capture("compact-pending-$i") }
        compose.mainClock.autoAdvance = true
        control("""{"extraDetail":${extra("CLONING")},"events":[${frame("CLONING", 57)}]}""")
        awaitText("Cloning acme/widgets"); awaitText("57%"); capture("compact-cloning-57")
        File(evidence, "clone-wait-result.txt").writeText("PASS\n")
        runBlocking { app.session.logout() }
    }

    private fun extra(state: String) = detail(state).substringAfter("\"extraDetail\":").dropLast(1)
    private fun awaitText(text: String) { compose.waitUntil(20000) { compose.onAllNodesWithText(text).fetchSemanticsNodes().isNotEmpty() } }
    private fun control(body: String) = (URL("$server/__control").openConnection() as HttpURLConnection).run {
        connectTimeout = 5000; readTimeout = 5000; requestMethod = "POST"; doOutput = true
        outputStream.use { it.write(body.toByteArray()) }
        assertTrue(responseCode == 200); disconnect()
    }
    private fun shell(command: String) = android.os.ParcelFileDescriptor.AutoCloseInputStream(instrument.uiAutomation.executeShellCommand(command)).use { it.readBytes() }
    private fun capture(name: String) {
        SystemClock.sleep(600)
        val shot = (1..3).firstNotNullOfOrNull { instrument.uiAutomation.takeScreenshot() ?: run { SystemClock.sleep(1000); null } }
        if (shot == null) { File(evidence, "missing-captures.txt").appendText("$name\n"); return }
        File(evidence, "$name.png").outputStream().use { shot.compress(Bitmap.CompressFormat.PNG, 100, it) }; shot.recycle()
    }
}
