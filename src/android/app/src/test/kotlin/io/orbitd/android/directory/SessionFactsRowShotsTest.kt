package io.orbitd.android.directory

import android.graphics.Bitmap
import android.graphics.Canvas
import androidx.activity.compose.setContent
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import io.orbitd.android.MainActivity
import io.orbitd.android.OrbitApplication
import io.orbitd.android.TestOrbitApplication
import io.orbitd.android.core.auth.*
import io.orbitd.android.core.net.*
import io.orbitd.android.navigation.Destination
import io.orbitd.android.navigation.OrbitRoute
import io.orbitd.android.ui.OrbitTheme
import java.io.File
import java.time.Instant
import java.time.temporal.ChronoUnit
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/** Before and after pictures of the five approved words on the session list row (plan step 5.4), the real `DirectoryScreen` over fake
 * reads under Robolectric; PNGs and the semantics tree go to `src/android/build/evidence/session-facts-android/`. Assertions make a
 * shot that drew the wrong word fail instead of being committed. Android has no separate session-header status word: the reader's
 * header shows the title and the worktree bar, so the list row (`SessionHeader.statusWord`) is where the words are read. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = TestOrbitApplication::class, qualifiers = "w411dp-h900dp")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class SessionFactsRowShotsTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()

    private val workspace = "0198f3a2-1111-7000-8000-000000000001"
    private val output: File by lazy {
        val root = generateSequence(File(System.getProperty("user.dir"))) { it.parentFile }
            .first { File(it, "src/android").isDirectory && File(it, "docs/evidence").isDirectory }
        File(root, "src/android/build/evidence/session-facts-android").also { it.mkdirs() }
    }


    /** The account is signed in once per test; `users/me` and an empty list answer every read the two screens make. */
    private fun signedIn(): SessionHandle {
        val session = (compose.activity.application as OrbitApplication).session
        compose.waitUntil(60_000) { session.state.value is AuthState.SignedOut }
        runBlocking { session.login(ServerAddress.parse("https://fixture.test"), "a@example.test", "fixture-password") }
        return (session.state.value as AuthState.SignedIn).handle
    }

    private fun stub() = object : OrbitApi {
        override suspend fun request(handle: SessionHandle, request: ApiRequest): ApiResponse =
            if (request.path == listOf("users", "me"))
                ApiResponse(200, """{"id":"u1","email":"reader@example.test","name":"Reader","preferences":{}}""".encodeToByteArray())
            else ApiResponse(200, "[]".encodeToByteArray())
    }

    /** The screen as a PNG, and never a blank one; the semantics tree goes beside it, so what the picture holds is
     * readable without looking at it. */
    private fun shot(name: String) {
        compose.waitForIdle()
        val roots = compose.onAllNodes(isRoot())
        File(output, "$name-semantics.txt").writeText(
            (0 until roots.fetchSemanticsNodes().size).joinToString("\n\n") { roots[it].printToString() })
        val view = compose.activity.window.decorView
        assertTrue("$name: the view was never laid out (${view.width}×${view.height})", view.width > 0 && view.height > 0)
        val bitmap = Bitmap.createBitmap(view.width, view.height, Bitmap.Config.ARGB_8888)
        view.draw(Canvas(bitmap))
        val pixels = IntArray(bitmap.width * bitmap.height)
        bitmap.getPixels(pixels, 0, bitmap.width, 0, 0, bitmap.width, bitmap.height)
        assertTrue("$name: the shot is blank — the graphics mode drew nothing", pixels.any { it != 0 })
        val file = File(output, "$name.png")
        file.outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
        assertTrue("$name: no PNG was written", file.length() > 0)
        println("shot $name ${bitmap.width}×${bitmap.height} -> $file")
        bitmap.recycle()
    }


    private fun rows(withFacts: Boolean): List<DirectorySession> {
        fun row(id: String, title: String, status: String, runState: String? = null, endReason: String? = null, released: Boolean, outcome: String? = null,
            phase: String, waitingOn: String? = null, workFinished: Boolean = false) =
            DirectorySession(id, title = title, workspaceId = workspace, status = status, runState = runState, endReason = endReason,
                phase = phase.takeIf { withFacts }, released = released.takeIf { withFacts }, lastTurnOutcome = outcome.takeIf { withFacts },
                waitingOn = waitingOn.takeIf { withFacts }, workFinished = workFinished.takeIf { withFacts })
        return listOf(
            row("1", "1 A task run that finished", "SUCCEEDED", endReason = "task_done", released = true, outcome = "ANSWERED", phase = "IDLE", workFinished = true),
            row("2", "2 A queued session on hold", "PENDING", runState = "QUEUED", released = false, phase = "PENDING", waitingOn = "HOLD"),
            row("3", "3 An end nobody confirmed", "FAILED", endReason = "ended", released = true, outcome = "FAILED", phase = "IDLE"),
            row("4", "4 An old plain conversation", "SUCCEEDED", released = true, outcome = "ANSWERED", phase = "IDLE"),
            row("5", "5 Interrupted, being ended", "INTERRUPTED", endReason = "ended", released = false, outcome = "INTERRUPTED", phase = "IDLE"),
        )
    }

    private fun draw(rows: List<DirectorySession>) {
        val handle = signedIn()
        val api = DirectoryApi(stub(), handle)
        compose.activityRule.scenario.onActivity { activity -> activity.setContent { OrbitTheme {
            DirectoryScreen(OrbitRoute(Destination.WORKSPACE, workspace), DirectoryData(sessions = mapOf("open" to rows), ready = true, fresh = true), api, handle, {}, {})
        } } }
    }

    private fun assertWords(words: List<String>, values: List<String>? = null) {
        val rows = rows(false)
        words.forEachIndexed { i, word ->
            compose.onNodeWithTag("directory-list").performScrollToNode(hasText(rows[i].title!!))
            compose.onNode(hasText(rows[i].title!!) and hasText(word)).assertExists()
            values?.let { compose.onNode(hasText(rows[i].title!!) and hasStateDescription(it[i])).assertExists() }
        }
    }

    /** The five approved words on the session list row, without the facts (an older server: today's words). */
    @Test fun beforeTheFactsAreSent() {
        draw(rows(false))
        assertWords(listOf("Succeeded", "Queued", "Failed", "Succeeded", "Ended"))
        shot("list-before-legacy-fields")
    }

    /** The same five rows with the facts the server sends now: the state from `phase`, the other facts as the approved board's marks
     * (docs/mocks/session-display-three-states). With nothing to preview, the line says the state word, as web's does, and a held
     * queue its queue word, as on the board. */
    @Test fun afterTheFactsAreSent() {
        draw(rows(true))
        assertWords(listOf("Idle", "On hold", "Idle", "Idle", "Idle"),
            listOf("Idle", "Queued, On hold", "Idle", "Idle", "Idle"))
        shot("list-after-session-facts")
    }
}
