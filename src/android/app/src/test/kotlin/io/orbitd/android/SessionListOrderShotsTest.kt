package io.orbitd.android

import android.graphics.Bitmap
import android.graphics.Canvas
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import io.orbitd.android.core.auth.AuthState
import java.io.File
import java.time.Instant
import java.time.temporal.ChronoUnit
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.setMain
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TestWatcher
import org.junit.runner.Description
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/** The Open list with several running sessions whose activity is newer than their listing, drawn for the before/after screenshots of
 * the listedAt order. Writes `src/android/build/evidence/session-list-order/<SHOT_NAME>.png` (SHOT_NAME defaults to `after`). */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = NavShellApplication::class, qualifiers = "w411dp-h891dp")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
class SessionListOrderShotsTest {
    @get:Rule(order = 0)
    val mainDispatcher = object : TestWatcher() {
        override fun starting(description: Description) { Dispatchers.setMain(UnconfinedTestDispatcher()) }
        override fun finished(description: Description) { Dispatchers.resetMain() }
    }
    @get:Rule(order = 1)
    val compose = createAndroidComposeRule<MainActivity>()

    @Before fun start() = NavShell.reset()

    private fun ago(seconds: Long) = Instant.now().minus(seconds, ChronoUnit.SECONDS).truncatedTo(ChronoUnit.SECONDS).toString()

    private fun running(id: String, title: String, listedSecondsAgo: Long, activitySecondsAgo: Long) = NavShell.row(id, title, at = ago(activitySecondsAgo),
        fields = ""","status":"RUNNING","runState":"RUNNING","listedAt":"${ago(listedSecondsAgo)}","currentTurnStartedAt":"${ago(listedSecondsAgo)}",
            "lastToolUse":"Bash","lastAssistantText":"Checking the run…"""")

    @Test fun severalRunningSessionsInTheOpenList() {
        NavShell.extra = mapOf("open" to listOf(
            running("34A05cSessionRun000001", "UI copy check", 1_800, 2),
            running("34A05cSessionRun000002", "Alert cause", 2_400, 20),
            running("34A05cSessionRun000003", "Agent title position", 3_600, 1),
            running("34A05cSessionRun000004", "Runner default workspace", 7_200, 8),
            running("34A05cSessionRun000005", "Runner preinstall agent", 10_800, 3),
            running("34A05cSessionRun000006", "Runner full view", 14_400, 15),
            NavShell.row("34A05cSessionAsk0000001", "Restart the runner?", at = ago(600), pending = 1,
                fields = ""","listedAt":"${ago(600)}","lastAssistantText":"Restart runner?"""")))
        compose.waitUntil(60_000) { compose.activity.let { (it.application as OrbitApplication).session.state.value is AuthState.SignedOut } }
        (compose.activity.application as OrbitApplication).realtime.setNetwork(true, "fixture")
        runBlocking { NavShell.signIn((compose.activity.application as OrbitApplication).session) }
        compose.waitUntil(60_000) { compose.onAllNodesWithText("Runner full view", substring = true).fetchSemanticsNodes().isNotEmpty() }
        compose.waitForIdle()
        val view = compose.activity.window.decorView
        val bitmap = Bitmap.createBitmap(view.width, view.height, Bitmap.Config.ARGB_8888)
        view.draw(Canvas(bitmap))
        val root = generateSequence(File(System.getProperty("user.dir")!!)) { it.parentFile }.first { File(it, "src/android").isDirectory }
        val out = File(root, "src/android/build/evidence/session-list-order").also { it.mkdirs() }
        val file = File(out, (System.getenv("SHOT_NAME") ?: "after") + ".png")
        file.outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
        assertTrue(file.length() > 0)
    }
}
