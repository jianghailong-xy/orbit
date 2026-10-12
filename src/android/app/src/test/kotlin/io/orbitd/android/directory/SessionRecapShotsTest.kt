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
import io.orbitd.android.management.LocalSessionRecaps
import io.orbitd.android.management.ManagementApi
import io.orbitd.android.management.SettingsScreen
import io.orbitd.android.navigation.Destination
import io.orbitd.android.navigation.OrbitRoute
import io.orbitd.android.ui.OrbitTheme
import java.io.File
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.temporal.ChronoUnit
import java.util.Locale
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/** The screenshots of the session recap in the Android list (0418): a session the server has recapped, one whose recap
 * is from another day, one with only a reply, and one working — then the same list with the account's Session recaps
 * switch off, where every recap row falls back to the raw last reply it showed before. Compose/Robolectric shots of the
 * real `DirectoryScreen` over fake reads, written to PNGs under `src/android/build/evidence/session-recap-android/`;
 * every assertion the device shots make is made here too, so a shot that drew the wrong line fails rather than being
 * committed. The reads are invented; that the server writes `recapText` is Phase 1's (`recap.spec.ts`,
 * `session-recap-delivery.pg.spec.ts`). */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = TestOrbitApplication::class, qualifiers = "w411dp-h900dp")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class SessionRecapShotsTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()

    private val workspace = "0198f3a2-1111-7000-8000-000000000001"
    private val output: File by lazy {
        val root = generateSequence(File(System.getProperty("user.dir"))) { it.parentFile }
            .first { File(it, "src/android").isDirectory && File(it, "docs/evidence").isDirectory }
        File(root, "src/android/build/evidence/session-recap-android").also { it.mkdirs() }
    }

    private val recap = "Moved the recap onto the session list row; the three states are covered by tests."
    private val olderRecap = "Shipped the drawer fix and re-ran the web suite."
    private val reply = "Committed the row change."
    private val olderReply = "Pushed the drawer fix."

    /** The clock and date the row's own `recapLabel` reads a time with, so the expectations hold in any time zone. */
    private fun clock(at: Instant) = DateTimeFormatter.ofPattern("h:mm a", Locale.US).withZone(ZoneId.systemDefault()).format(at)
    private fun day(at: Instant) = DateTimeFormatter.ofPattern("EEE, MMM d", Locale.US).withZone(ZoneId.systemDefault()).format(at)

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

    /** The list, then the same list with the account's Session recaps switch off. */
    @Test fun theRecapRowsOnTheSessionList() {
        val now = Instant.now().truncatedTo(ChronoUnit.SECONDS)
        val writtenAt = now.minusSeconds(300)
        val longAgo = now.minus(3, ChronoUnit.DAYS)
        val api = DirectoryApi(stub(), signedIn())
        // A parked session the server has recapped, one recapped days ago, one with only a reply, and one working
        // with a recap of the turn before it — the three states the row has to get right, in the web's order.
        val rows = listOf(
            DirectorySession("a", title = "Recap on the session list row", workspaceId = workspace, status = "AWAITING_INPUT",
                lastAssistantText = reply, recapText = recap, recapAt = writtenAt.toString()),
            DirectorySession("b", title = "Drawer shadow fix", workspaceId = workspace, status = "AWAITING_INPUT",
                lastAssistantText = olderReply, recapText = olderRecap, recapAt = longAgo.toString()),
            DirectorySession("c", title = "Rebasing the fixtures", workspaceId = workspace, status = "AWAITING_INPUT",
                lastAssistantText = "Rebased the fixtures; the suite is green."),
            DirectorySession("d", title = "Rebuilding the transcript page", workspaceId = workspace, status = "RUNNING",
                runState = "RUNNING", lastToolUse = "Bash"),
        )
        var recaps by mutableStateOf(true)
        compose.activityRule.scenario.onActivity { activity -> activity.setContent { OrbitTheme {
            CompositionLocalProvider(LocalSessionRecaps provides recaps) {
                DirectoryScreen(OrbitRoute(Destination.WORKSPACE, workspace),
                    DirectoryData(sessions = mapOf("open" to rows), ready = true, fresh = true), api, {}, {})
            }
        } } }

        // The recap under its muted "Recap · <time>" label, and not the reply it replaced.
        val label = "Recap · ${clock(writtenAt)}"
        compose.onNodeWithTag("directory-list").performScrollToNode(hasText("Recap on the session list row"))
        compose.onNodeWithText("$label $recap", substring = true).assertIsDisplayed()
        compose.onAllNodesWithText(reply, substring = true).assertCountEquals(0)
        shot("list-with-recap")

        // Another day's recap wears the date too: a bare clock time on an older row would mislead.
        val olderLabel = "Recap · ${day(longAgo)}, ${clock(longAgo)}"
        compose.onNodeWithTag("directory-list").performScrollToNode(hasText("Drawer shadow fix"))
        compose.onNodeWithText("$olderLabel $olderRecap", substring = true).assertIsDisplayed()

        // A session no pass has recapped: the reply preview it always had, with no label in front of it.
        compose.onNodeWithTag("directory-list").performScrollToNode(hasText("Rebasing the fixtures"))
        compose.onNodeWithText("Rebased the fixtures; the suite is green.", substring = true).assertIsDisplayed()

        // Working: this row keeps its own state line above the preview (it always has — the preview is
        // the second line, not the only one), so a live session reads "Running" here. The web rule that
        // live state outranks the recap is `SessionLine`'s, which is what a project row draws and what
        // the whole macOS/iOS list draws; on this row the recap takes the preview slot either way.
        // Asked of the ROW, not the screen: the recapped rows above keep their labels either way.
        compose.onNodeWithTag("directory-list").performScrollToNode(hasText("Rebuilding the transcript page"))
        compose.onNode(hasText("Rebuilding the transcript page") and hasText("Running")).assertExists()
        compose.onAllNodes(hasText("Rebuilding the transcript page") and hasText(recap, substring = true))
            .assertCountEquals(0)

        // The account's Session recaps switch, off: every recap row falls back to the raw last reply — no label, and
        // not the recap under one.
        recaps = false
        compose.onNodeWithTag("directory-list").performScrollToNode(hasText("Recap on the session list row"))
        compose.onNodeWithText(reply, substring = true).assertIsDisplayed()
        compose.onAllNodesWithText(recap, substring = true).assertCountEquals(0)
        compose.onAllNodesWithText(label, substring = true).assertCountEquals(0)
        shot("list-with-recaps-off")
    }

    /** Settings → Sessions, with the account's Session recaps switch — where the list above is turned off from. */
    @Test fun theSessionRecapsSwitchInSettings() {
        val stub = stub()
        val handle = signedIn()
        val api = ManagementApi(stub, handle)
        compose.activityRule.scenario.onActivity { activity -> activity.setContent { OrbitTheme {
            SettingsScreen(api, OrbitRoute(Destination.SETTINGS), 0, {}, {}, logout = {}, changed = {}, workspaceDeleted = {},
                deviceAlerts = { true }, notifications = {}, about = {})
        } } }
        compose.waitUntil(60_000) { compose.onAllNodesWithText("Session recaps", substring = true).fetchSemanticsNodes().isNotEmpty() }
        val row = hasText("Session recaps") and isToggleable()
        compose.onNode(row).performScrollTo().assertIsOn()
        compose.onNodeWithText("Session lists show the one-line summary the server writes for each conversation, " +
            "in place of its raw last reply. Off: the raw last reply.", useUnmergedTree = true).assertExists()
        shot("settings-session-recaps")
    }
}
