package io.orbitd.android.reader

import androidx.compose.ui.semantics.SemanticsActions
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
 * iOS `ConsoleView.foldsChrome` in the production shell: on a phone's width, while the composer holds the keyboard,
 * the conversation gets the screen — the shell's bar, with the session's ⋯ in it, and the cards above the composer fold
 * away together and give it back when the keyboard goes. The cards are folded, not removed, so what was open in them
 * stays open. A wide page keeps all of it. Since A06-18 (iOS d87e5fa67) no rows sit under the bar to fold: the session's
 * name and state are not drawn on the page.
 */
abstract class ReaderChromeFoldFixture : ComposerShellTest() {
    private val title = "Composer increments"

    /** The last line of the conversation, as the reading journey reads it. */
    private val lastLine = "Latest answer 9999"

    protected fun session() {
        ComposerShell.events = listOf(
            ComposerShell.obj("""{"type":"user","seq":1,"payload":{"text":"First question"}}"""),
            ComposerShell.obj("""{"type":"assistant","seq":2,"payload":{"text":"First answer"}}"""),
            ComposerShell.obj("""{"type":"assistant","seq":3,"payload":{"text":"$lastLine"}}"""))
        // A worktree session, so the branch bar is one of the cards above the composer.
        ComposerShell.session = mapOf(
            "isolationStatus" to JsonPrimitive("worktree"), "branch" to JsonPrimitive("orbit/composer-chrome-a06d"),
            "mergeTarget" to JsonPrimitive("main"), "worktreeDirty" to JsonPrimitive(false),
            "changedFiles" to JsonArray(listOf(ComposerShell.obj("""{"path":"SessionReader.kt","additions":3,"deletions":1,"status":"M"}"""))))
    }

    protected fun listHeight() = compose.onNodeWithTag("transcript-list").fetchSemanticsNode().boundsInWindow.height
    protected fun titleRow() = hasText(title)
    protected fun stateRow() = hasText("AWAITING_INPUT")
    protected fun sessionMenu() = hasContentDescription("Session actions")
    protected fun lastRead() = hasText(lastLine)
}

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = ComposerShellApplication::class, qualifiers = "w360dp-h640dp")
class ReaderChromeFoldTest : ReaderChromeFoldFixture() {
    @Test fun aPhoneFoldsTheChromeWhileTheComposerHoldsTheKeyboardAndGivesItBackWhenItGoes() {
        session()
        signIn(); openSession()
        await { has(hasTestTag("app-bar")) }
        assertTrue("the session's ⋯ in the bar", has(sessionMenu()))
        assertFalse("no title row under the bar", has(titleRow()))
        assertFalse("nor a state row", has(stateRow()))
        assertTrue("the branch bar above the composer", has(hasTestTag("worktree-bar")))
        assertTrue("the last line reads while nothing types", has(lastRead()))
        val resting = listHeight()

        compose.onNodeWithTag("composer-input").performClick()
        await { !has(hasTestTag("app-bar")) }
        assertFalse("the ⋯ folds away with the bar", has(sessionMenu()))
        assertFalse("and the branch bar above the composer", has(hasTestTag("worktree-bar")))
        val typing = listHeight()
        assertTrue("the conversation got the chrome's room: $resting → $typing", typing > resting)
        assertTrue("the last line is still what reads", has(lastRead()))

        // The keyboard going gives all of it back, as it was.
        compose.onNodeWithTag("composer-model").performSemanticsAction(SemanticsActions.RequestFocus)
        await { has(hasTestTag("app-bar")) }
        assertTrue(has(sessionMenu()))
        assertTrue(has(hasTestTag("worktree-bar")))
        assertEquals(resting, listHeight(), 1f)
    }
}

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = ComposerShellApplication::class, qualifiers = "w800dp-h1000dp")
class WideReaderChromeTest : ReaderChromeFoldFixture() {
    /** The fold is the phone's alone: a page wide enough for the two-column shell keeps its bar and its cards. */
    @Test fun aWidePageKeepsItsChrome() {
        session()
        signIn(); openSession()
        await { has(hasTestTag("app-bar")) }
        val resting = listHeight()
        compose.onNodeWithTag("composer-input").performClick()
        compose.waitForIdle()
        assertTrue("the bar stays, with its ⋯", has(hasTestTag("app-bar")) && has(sessionMenu()))
        assertFalse("no rows under it, typing or not", has(titleRow()) || has(stateRow()))
        assertTrue("and the cards above the composer", has(hasTestTag("worktree-bar")))
        assertEquals(resting, listHeight(), 1f)
    }
}
