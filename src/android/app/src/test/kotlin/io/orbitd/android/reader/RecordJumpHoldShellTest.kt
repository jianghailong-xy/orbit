package io.orbitd.android.reader

import androidx.compose.ui.test.*
import io.orbitd.android.composer.ComposerShell
import io.orbitd.android.composer.ComposerShellApplication
import io.orbitd.android.composer.ComposerShellTest
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * A record link opens the window around the record and scrolls the list to its row. The rows are not the list's first items: a
 * "handoff-note" (a successor's note card), "created-workspace" or "loading" item can stand between "older" and the first row, so
 * the jump counts the items there are rather than assuming one. And the row stays where the jump put it while the conversation
 * lands around it (web `landingRef`).
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = ComposerShellApplication::class, qualifiers = "w360dp-h640dp")
class RecordJumpHoldShellTest : ComposerShellTest() {
    private val record = "34A06fQuestionRecord01"
    private fun event(type: String, seq: Long, text: String) = buildJsonObject {
        put("type", type); put("seq", seq); put("payload", buildJsonObject { put("text", text) })
    }
    private val transcript = buildList {
        add(event("user", 1, "First question"))
        (2L..30L).forEach { add(event("assistant", it, "Answer $it\n\nIt goes on for a while, so that a few of these fill the phone's page.")) }
    }
    private fun top(tag: String) = compose.onAllNodesWithTag(tag, useUnmergedTree = true).fetchSemanticsNodes().singleOrNull()?.boundsInWindow?.top
    private fun listTop() = compose.onNodeWithTag("transcript-list").fetchSemanticsNode().boundsInWindow.top

    private fun openAtRecord(withHandoffNote: Boolean) {
        if (withHandoffNote) ComposerShell.session = mapOf("coordinatorHandoffReceived" to Json.parseToJsonElement(
            """{"handoffFromSessionId":"34HandoffPrevious00001","note":"Handing over after Friday's release.","handedOverAt":"2026-11-14T15:42:00Z","movedWaits":[]}"""))
        ComposerShell.events = transcript
        ComposerShell.around = buildJsonObject {
            put("events", JsonArray(transcript.take(24))); put("hasMore", false); put("after", 24)
            put("anchor", buildJsonObject { put("kind", "event"); put("id", record); put("seq", 16) })
        }
        signIn()
        open("orbit-session:${ComposerShell.SESSION}?at=$record")
        await { has(hasTestTag("composer-model") and isEnabled()) }
        await { has(hasTestTag("event:16")) }
        repeat(5) { compose.mainClock.advanceTimeBy(300); compose.waitForIdle() }
    }

    /** The row a record link names is at the top of the list, whatever stands between "older" and the first row. */
    @Test fun aRecordJumpLandsOnItsRowBehindAHandoffNote() {
        openAtRecord(withHandoffNote = true)
        await { has(hasTestTag("handoff-note-card")) || top("event:16") != null }
        val gap = top("event:16")!! - listTop()
        assertTrue("the record's row is the first row in view, not the one before it: $gap below the list's top", gap in 0f..80f)
    }

    @Test fun aRecordJumpLandsOnItsRowWithNothingAheadOfTheRows() {
        openAtRecord(withHandoffNote = false)
        val gap = top("event:16")!! - listTop()
        assertTrue("the record's row is the first row in view: $gap below the list's top", gap in 0f..80f)
    }

    /** A note card that lands after the jump does not carry the row out of place. */
    @Test fun aRecordJumpStaysPutWhenAHandoffNoteLandsAheadOfIt() {
        openAtRecord(withHandoffNote = false)
        ComposerShell.session = mapOf("coordinatorHandoffReceived" to Json.parseToJsonElement(
            """{"handoffFromSessionId":"34HandoffPrevious00001","note":"Handing over after Friday's release.","handedOverAt":"2026-11-14T15:42:00Z","movedWaits":[]}"""))
        app().realtime.refreshSession()
        repeat(5) { compose.mainClock.advanceTimeBy(300); compose.waitForIdle() }
        val gap = top("event:16")!! - listTop()
        assertTrue("the record's row is still the first row in view: $gap below the list's top", gap in 0f..80f)
    }
}
