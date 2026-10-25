package io.orbitd.android.reader

import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.unit.toSize
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.*
import io.orbitd.android.composer.ComposerShell
import io.orbitd.android.composer.ComposerShellApplication
import io.orbitd.android.composer.ComposerShellTest
import io.orbitd.android.core.net.ApiResponse
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * A06d in the production session page: the settled thinking row (A06-11), the fade into the composer band and the jump row
 * under it (A06-12), the tail following rows that grow under a pinned reader and never a reader who scrolled (A06-13), and a
 * running background task's live line (A06-17).
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = ComposerShellApplication::class, qualifiers = "w411dp-h891dp")
@GraphicsMode(GraphicsMode.Mode.NATIVE) // rows measured as the device measures them, so the list scrolls and grows as it does there
class ReaderIncrementsTest : ComposerShellTest() {
    private fun event(seq: Long, type: String, payload: String) = ComposerShell.obj("""{"type":"$type","seq":$seq,"payload":$payload}""")
    private fun said(seq: Long, type: String, text: String) = event(seq, type, buildJsonObject { put("text", text) }.toString())
    private fun thinking(seq: Long, text: String, ms: Long? = null) =
        event(seq, "thinking", buildJsonObject { put("text", text); ms?.let { put("thinkingMs", it) } }.toString())
    /** A background agent's call and the runtime's receipt for it. */
    private fun agent(seq: Long, id: String, description: String) = listOf(
        event(seq, "tool_use", """{"id":"$id","name":"Agent","input":{"description":"$description","subagent_type":"Explore","run_in_background":true}}"""),
        event(seq + 1, "tool_result", """{"toolUseId":"$id","content":"Async agent launched successfully. agentId: a$seq (internal ID - do not mention to user.)"}"""))
    private fun running(vararg agents: Pair<String, String>) = { ApiResponse(200, agents.joinToString(",", "[", "]") { (id, tool) ->
        """{"toolUseId":"$id","status":"running","progress":{"toolUseId":"$id","lastToolName":"$tool","usage":{"totalTokens":900,"toolUses":3,"durationMs":4000}}}"""
    }.encodeToByteArray()) }
    private val background = "GET sessions/${ComposerShell.SESSION}/background"
    private fun card(seq: Long) = hasAnyAncestor(hasTestTag("event:$seq"))
    /** Where a node lies, unclipped: a row pushed below the list keeps its place instead of collapsing to nothing. */
    private fun bounds(tag: String): Rect = compose.onNodeWithTag(tag, useUnmergedTree = true).fetchSemanticsNode().let { Rect(it.positionInRoot, it.size.toSize()) }
    private fun top(text: String): Float = compose.onNodeWithText(text, useUnmergedTree = true).fetchSemanticsNode().positionInRoot.y
    private fun dp(value: Float) = with(compose.density) { value * this.density }
    private fun show(seq: Long) { compose.onNodeWithTag("transcript-list").performScrollToKey("event:$seq"); compose.waitForIdle() }

    /** A06-11 (iOS 471b2afbb, d55e9900b): adjacent blocks fold into one settled row that says what they cost, folded until tapped. */
    @Test fun aTurnsReasoningFoldsIntoRowsThatSayWhatItCost() {
        ComposerShell.events = listOf(said(1, "user", "Why is the reader slow?"),
            thinking(2, "first", 60_000), thinking(3, "second", 47_000), thinking(4, "third"),
            event(5, "tool_use", """{"id":"t5","name":"Bash","input":{"command":"top -b -n 1"}}"""),
            event(6, "tool_result", """{"toolUseId":"t5","content":"load 4.1"}"""),
            thinking(7, ""), thinking(8, "after the call"), said(9, "assistant", "Found it."))
        signIn(); openSession()
        await { shows("Found it.") }
        assertTrue(has(hasText("Thought for 1m 47s · 3 blocks · 20 chars"), unmerged = true))
        // An empty block draws no row; the block after the call keeps its own, and an older runner's says its size alone.
        assertTrue(has(hasText("Thought · 14 chars"), unmerged = true))
        assertEquals(2, compose.onAllNodesWithTag("thinking-fold").fetchSemanticsNodes().size)
        assertFalse("settled, it is folded", shows("second"))
        assertFalse("no button of the old row", shows("Show thinking"))
        val fold = compose.onAllNodesWithTag("thinking-fold")[0]
        fold.assert(SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, "Collapsed"))
        fold.performClick()
        await { shows("second") }
        assertTrue(shows("first") && shows("third"))
        fold.assert(SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, "Expanded"))
        fold.performClick()
        await { !shows("second") }
    }

    /** A06-17 (iOS ea175e5af): folded and running, an agent's card says its sub-agent's last step in place of its progress line. */
    @Test fun aRunningAgentsFoldedCardSaysWhatItsSubagentIsOn() {
        ComposerShell.events = listOf(said(1, "user", "Survey the reader")) + agent(2, "toolu_busy", "Survey") +
            event(4, "tool_use", """{"id":"toolu_read","name":"Read","parentToolUseId":"toolu_busy","input":{"file_path":"/repo/src/android/app/SessionReader.kt"}}""") +
            event(5, "tool_result", """{"toolUseId":"toolu_read","parentToolUseId":"toolu_busy","content":"package io.orbitd"}""") +
            agent(6, "toolu_quiet", "Second survey") + said(8, "assistant", "Both agents are running.")
        ComposerShell.answers[background] = running("toolu_busy" to "Read", "toolu_quiet" to "Grep")
        signIn(); openSession()
        // An agent whose sub-agent has relayed nothing yet keeps its progress line.
        show(6)
        await { has(hasText("Grep · 3 tool calls") and card(6), unmerged = true) }
        assertFalse(has(hasTestTag("subagent-live-line") and card(6), unmerged = true))
        show(2)
        await { has(hasTestTag("subagent-live-line") and card(2), unmerged = true) }
        assertTrue(has(hasText("Read SessionReader.kt") and card(2), unmerged = true))
        assertFalse("the live line takes the progress line's place", has(hasText("Read · 3 tool calls") and card(2), unmerged = true))
        // Opened, the card reads its records instead.
        compose.onNode(hasText("Show input and output") and card(2)).performClick()
        await { !has(hasTestTag("subagent-live-line") and card(2), unmerged = true) }
        // Ended, nothing is on right now.
        ComposerShell.answers[background] = { ApiResponse(200, "[]".encodeToByteArray()) }
        compose.onNode(hasText("Hide input and output") and card(2)).performClick()
        app().realtime.refreshSession()
        await { has(hasText("Complete") and card(2), unmerged = true) }
        assertFalse(has(hasTestTag("subagent-live-line") and card(2), unmerged = true))
        show(6)
        await { has(hasText("Complete") and card(6), unmerged = true) }
        assertFalse(has(hasText("Grep · 3 tool calls") and card(6), unmerged = true))
    }

    /** A06-12 (iOS 9d3751ec2): the tail keeps the fade's room, so the last line rests above it; the jump row is under the list. */
    @Test fun theLastLineRestsAboveTheFadeAndTheJumpRowSitsUnderTheList() {
        ComposerShell.events = (1L..30L).map { said(it, if (it % 2 == 1L) "user" else "assistant", "Message $it") }
        signIn(); openSession()
        await { shows("Message 30") }
        compose.waitForIdle()
        assertEquals("the tail row is the fade's room and the 1 dp anchor", dp(21f), bounds("transcript-tail").height, 1f)
        val list = bounds("transcript-list")
        val last = compose.onNodeWithText("Message 30", useUnmergedTree = true).fetchSemanticsNode().let { Rect(it.positionInRoot, it.size.toSize()) }
        assertTrue("at rest nothing is in the fade: ${last.bottom} against ${list.bottom}", last.bottom <= list.bottom - dp(20f))
        compose.onNodeWithTag("transcript-list").performTouchInput { swipeDown() }
        await { shows("Jump to latest") }
        compose.waitForIdle()
        assertTrue("the jump row lies under the list, out of its fade", bounds("transcript-jump").top >= bounds("transcript-list").bottom - 0.5f)
    }

    /**
     * A06-13 (iOS 900e1810d, 66c42e852) in the page: an agent starting grows its card a progress line and the card rail a
     * Background card under a pinned reader, who stays on the tail; once the reader has scrolled, however little, a card
     * growing leaves them where they went. (The geometry rule on its own: TailPinningTest.)
     */
    @Test fun aPinnedReaderStaysOnTheTailAsAnAgentStartsAndAReaderWhoScrolledStaysPut() {
        ComposerShell.events = (1L..24L).map { said(it, if (it % 2 == 1L) "user" else "assistant", "Message $it") } +
            agent(25, "toolu_first", "First survey") + said(27, "assistant", "Waiting on the agents.") + agent(28, "toolu_second", "Second survey")
        signIn(); openSession()
        await { shows("Waiting on the agents.") }
        compose.waitForIdle()
        fun tailGap() = bounds("transcript-tail").bottom - bounds("transcript-list").bottom
        assertEquals(0f, tailGap(), 1f)

        // The first agent starts running: its card grows a progress line, and the rail a card, under a list nobody moved.
        ComposerShell.answers[background] = running("toolu_first" to "Read")
        app().realtime.refreshSession()
        await { has(hasText("Read · 3 tool calls"), unmerged = true) }
        compose.waitForIdle()
        assertEquals("the tail followed what grew", 0f, tailGap(), 1f)

        // The reader scrolls up a little, and the second agent's card grows below what they read: they stay where they went.
        // (A scroll inside the rule's slack is TailPinningTest's `aScrollIsNeverFollowed`; here the jump row takes room too.)
        compose.onNodeWithTag("transcript-list").performTouchInput { swipeDown(startY = centerY, endY = centerY + dp(40f), durationMillis = 1_000) }
        await { shows("Jump to latest") }
        compose.waitForIdle()
        val reading = top("Waiting on the agents.")
        ComposerShell.answers[background] = running("toolu_first" to "Read", "toolu_second" to "Grep")
        app().realtime.refreshSession()
        await { has(hasText("Grep · 3 tool calls"), unmerged = true) }
        compose.waitForIdle()
        assertEquals("a reader who scrolled is never followed", reading, top("Waiting on the agents."), 1f)
        assertTrue(shows("Jump to latest"))
    }
}
