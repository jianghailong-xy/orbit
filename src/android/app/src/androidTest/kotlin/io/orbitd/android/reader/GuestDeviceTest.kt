package io.orbitd.android.reader

import android.graphics.Bitmap
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
import io.orbitd.android.core.guests.GuestCopy
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Session guests, the guest's side, on a device over scripts/guest-fixture.py (a loopback fixture, not a deployment): Bo signs in;
 * Ana shared three sessions with him. The drawer's Shared with me group lists them; each opens the guest view — running, waiting on
 * Ana's approval, ended (the restart hint) — and a message sent to the ended one restarts it and shows up in the transcript headed
 * You. A session link the owner's read answers 404 for opens the same view, and one taken away reads "no longer shared". Screenshots
 * land in files/guest.
 */
@RunWith(AndroidJUnit4::class)
class GuestDeviceTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()
    private val instrumentation get() = InstrumentationRegistry.getInstrumentation()
    private val app get() = instrumentation.targetContext.applicationContext as OrbitApplication
    private val server = InstrumentationRegistry.getArguments().getString("guest_server") ?: "http://127.0.0.1:18768"
    private val evidence get() = File(app.filesDir, "guest").also { it.mkdirs() }
    private val running = "01a0cca7-8609-70ed-a0e2-d4b55b8c0001"
    private val waiting = "01a0cca7-8609-70ed-a0e2-d4b55b8c0002"

    @Test fun theGuestsSide() {
        instrumentation.sendStatus(0, android.os.Bundle().apply { putString("guest_pid", android.os.Process.myPid().toString()) })
        compose.waitUntil(10_000) { app.session.state.value !is AuthState.Restoring }
        assertTrue("Requires a signed-out debug installation", app.session.state.value is AuthState.SignedOut)
        evidence.listFiles()?.forEach { it.delete() }
        try {
            compose.chooseServer(server)
            compose.onNodeWithText("Email").performTextReplacement("bo@example.test")
            compose.onNodeWithText("Password").performTextReplacement("guest-fixture-password")
            compose.pressSignIn()
            compose.waitUntil(30_000) { app.session.state.value is AuthState.SignedIn }

            // (a) The drawer: Shared with me, its count, each row's title, owner and state.
            openDrawer()
            await { exists(hasText("Ana · Running")) }
            assertTrue(exists(hasText(GuestCopy.SHARED_WITH_ME)))
            assertTrue(exists(hasText("Fix the login redirect")))
            assertTrue(exists(hasText("Ana · Awaiting reply")))
            assertTrue(exists(hasText("Ana · Ended")))
            compose.onNodeWithText("Fix the login redirect").performScrollTo()
            capture("a-drawer-shared-with-me")

            // (b) Running.
            compose.onNodeWithText("Fix the login redirect").performClick()
            await { exists(hasText("Runs on Ana’s machine")) }
            assertTrue(exists(hasText("Running")) && exists(hasText(GuestCopy.GUEST_BADGE)) && exists(hasText("Shared by Ana")))
            assertTrue(exists(hasText("From Cy")))
            capture("b-running")

            // (c) Waiting on the owner.
            openDrawer(); compose.onNodeWithText("Upgrade the payment SDK").performScrollTo().performClick()
            await { exists(hasText("Waiting for Ana to approve")) }
            assertTrue(exists(hasText("Your message waits its turn")) && exists(hasText("Awaiting reply")))
            capture("c-waiting-on-owner")

            // (d) Ended: sending restarts it on Ana's machine.
            openDrawer(); compose.onNodeWithText("Write the release notes").performScrollTo().performClick()
            await { exists(hasText("Send to continue — this restarts the session on Ana’s machine.")) }
            assertTrue(exists(hasText("Ended")))
            capture("d-ended")

            // (f) A message: posted, then drawn in the transcript as the reader's own, and answered.
            compose.onNodeWithTag("guest-composer-input").performTextReplacement("Please also mention the CSV fix.")
            compose.onNodeWithTag("guest-send").performClick()
            awaitFollowing { exists(hasText("Please also mention the CSV fix.", substring = true)) && exists(hasText("Done — the tests pass on my side. Anything else?")) }
            compose.waitForIdle()
            capture("f-after-sending")

            // A session link: the owner's read answers 404, the guest door answers, and the guest view opens in its place.
            // Delivered as a link arrives (ComposerStackDeviceTest's way): starting an activity would leave the scenario's paused.
            compose.activityRule.scenario.onActivity { activity ->
                val original = activity.intent
                MainActivity::class.java.getDeclaredMethod("onNewIntent", android.content.Intent::class.java).apply { isAccessible = true }
                    .invoke(activity, android.content.Intent(android.content.Intent.ACTION_VIEW, android.net.Uri.parse("orbit-session:$running"))
                        .setClass(activity, MainActivity::class.java))
                activity.intent = original
            }
            await { exists(hasText("Runs on Ana’s machine")) && exists(hasText("From Cy")) }
            capture("g-link-opens-guest-view")

            // (e) Taken away: the next read says so.
            post("/__control", """{"unshare":"$waiting"}""")
            openDrawer(); compose.onNodeWithText("Upgrade the payment SDK").performScrollTo().performClick()
            await { exists(hasText(GuestCopy.NOT_SHARED)) }
            assertTrue(exists(hasText(GuestCopy.NOT_SHARED_DETAIL)))
            capture("e-no-longer-shared")
            File(evidence, "result.txt").writeText("PASS\n")
        } catch (failure: Throwable) {
            File(evidence, "failure.txt").writeText(failure.stackTraceToString())
            runCatching { capture("failure") }
            throw failure
        } finally {
            runBlocking { app.session.logout() }
        }
    }

    private fun post(path: String, body: String) {
        val connection = URL(server.trimEnd('/') + path).openConnection() as HttpURLConnection
        connection.requestMethod = "POST"; connection.doOutput = true
        connection.setRequestProperty("Content-Type", "application/json")
        connection.outputStream.use { it.write(body.toByteArray()) }
        check(connection.responseCode == 200)
        connection.disconnect()
    }
    private fun exists(matcher: SemanticsMatcher) = compose.onAllNodes(matcher, true).fetchSemanticsNodes().isNotEmpty()
    private fun await(condition: () -> Boolean) = compose.waitUntil(30_000, condition)
    /** The follow loop's 4 s waits are effect delays, which the test's clock only moves while it has frames to draw: move it by hand,
     *  a second at a time, while the fixture answers in real time. */
    private fun awaitFollowing(condition: () -> Boolean) {
        repeat(60) {
            compose.waitForIdle()
            if (condition()) return
            compose.mainClock.advanceTimeBy(1_000)
            SystemClock.sleep(500)
        }
        assertTrue("the follow loop never brought it", condition())
    }
    private fun openDrawer() {
        compose.onAllNodesWithContentDescription("Open navigation").onFirst().performClick()
        settle()
    }
    private fun settle() {
        compose.waitForIdle()
        instrumentation.waitForIdleSync()
        instrumentation.uiAutomation.waitForIdle(300, 5_000)
    }
    private fun capture(name: String) {
        settle()
        SystemClock.sleep(800)
        var bitmap: Bitmap? = null
        repeat(3) { if (bitmap == null) bitmap = instrumentation.uiAutomation.takeScreenshot() ?: run { SystemClock.sleep(500); null } }
        val shot = bitmap ?: run { File(evidence, "$name.missing").writeText("takeScreenshot returned null 3 times\n"); return }
        File(evidence, "$name.png").outputStream().use { shot.compress(Bitmap.CompressFormat.PNG, 100, it) }
        shot.recycle()
    }
}
