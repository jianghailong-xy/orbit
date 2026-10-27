package io.orbitd.android.reader

import android.graphics.Insets
import android.view.View
import android.view.WindowInsets
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
import org.robolectric.util.ReflectionHelpers

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

/**
 * A15 F-48: Android 15's first release keeps the window across `Activity.recreate()` and leaves it fitting the system bars and the
 * keyboard itself. The decor's content root is padded above the keyboard and the window's insets say it is shown, but none of it
 * reaches the page: Compose's IME inset stays 0 as the keyboard comes and goes. Its going still gives the chrome back.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = ComposerShellApplication::class, qualifiers = "w360dp-h640dp-xhdpi")
class RecreatedWindowChromeFoldTest : ReaderChromeFoldFixture() {
    /** A keyboard [height] px tall as that window takes it, never dispatched to the page: the content root padded above it, and the
     * window's insets reporting it (below API 30 androidx reads a system-window bottom over the stable one as the keyboard). */
    private fun windowFitsKeyboard(height: Int) = compose.runOnUiThread {
        val decor = compose.activity.window.decorView
        ReflectionHelpers.setField(decor.parent, "mLastWindowInsets", WindowInsets.Builder().setSystemWindowInsets(Insets.of(0, 0, 0, height)).build())
        (compose.activity.findViewById<View>(android.R.id.content).parent as View).setPadding(0, 0, 0, height)
    }

    @Test fun theKeyboardGoingGivesTheChromeBackWhenOnlyTheWindowReportsIt() {
        session()
        signIn(); openSession()
        await { has(hasTestTag("app-bar")) }
        compose.onNodeWithTag("composer-input").performClick()
        await { !has(hasTestTag("app-bar")) }
        // The API 35 emulator's keyboard at 360x640 dp.
        windowFitsKeyboard(598)
        compose.waitForIdle()
        assertFalse("folded while the keyboard is up", has(hasTestTag("app-bar")))
        compose.onNodeWithTag("composer-input").assertIsFocused()

        // Back puts the keyboard away: the content root gets its room back and the window's insets show no keyboard.
        windowFitsKeyboard(0)
        await { has(hasTestTag("app-bar")) }
        compose.onNodeWithTag("composer-input").assertIsNotFocused()
        assertTrue(has(sessionMenu()))
        assertTrue(has(hasTestTag("worktree-bar")))
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
