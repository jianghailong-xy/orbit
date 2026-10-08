package io.orbitd.android.wiki

import android.content.Intent
import android.net.Uri
import androidx.compose.ui.test.*
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import io.orbitd.android.MainActivity
import io.orbitd.android.OrbitApplication
import io.orbitd.android.core.auth.AuthState
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.setMain
import org.junit.Assert.*
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TestWatcher
import org.junit.runner.Description
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** The Wiki and Watch pages inside the real shell over the controlled server ([WikiShell]): a write that outlives its
 * page, a stale op the server applied nothing for, what a page shows when it is opened again, which account events
 * re-read what, and a read that answers after a newer one. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = WikiShellApplication::class, qualifiers = "w411dp-h891dp")
@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
class WikiShellTest {
    /** The app's own scope (`processScope`, Main) runs here: [settle] moves its clock with the composition's. */
    private val main = UnconfinedTestDispatcher()
    @get:Rule(order = 0)
    val mainDispatcher = object : TestWatcher() {
        override fun starting(description: Description) { Dispatchers.setMain(main) }
        override fun finished(description: Description) { Dispatchers.resetMain() }
    }
    @get:Rule(order = 1)
    val compose = createAndroidComposeRule<MainActivity>()
    private val shell = WikiShell

    /** WikiToast is one per process, and Robolectric restarts the clock for every test: an earlier test's toast is cleared. */
    @Before fun start() { shell.reset(); WikiToast.text = null }

    // MARK: P1-1 — a write runs to its end, whatever happens to the page that asked for it

    @Test fun aSavingSheetCannotBeClosedUntilItsWriteAnswers() {
        signIn()
        open("orbit-wiki:${WikiShell.ENTRY}")
        awaitTag("wiki-entry-title")
        compose.onNodeWithTag("wiki-entry-edit").performClick()
        awaitTag("wiki-entry-form-summary")
        compose.onNodeWithTag("wiki-entry-form-summary").performTextReplacement("Written while the page was open.")
        val gate = shell.hold("POST", "wiki/spaces/${WikiShell.SPACE}/changesets")
        compose.onNodeWithTag("wiki-entry-form-save").performClick()
        compose.waitForIdle()
        compose.onNodeWithTag("wiki-entry-form-save-cancel").assertIsNotEnabled()
        // Swiped down, the sheet holds while its write is on its way (Back, in the sheet's own window, likewise).
        compose.onNodeWithTag("wiki-entry-form").performTouchInput { swipeDown() }
        compose.waitForIdle()
        compose.onNodeWithTag("wiki-entry-form").assertExists()
        gate.complete(Unit)
        compose.waitUntil(10_000) { compose.onAllNodesWithTag("wiki-entry-form").fetchSemanticsNodes().isEmpty() }
        assertEquals("answered", shell.ended["POST wiki/spaces/${WikiShell.SPACE}/changesets"])
    }

    @Test fun aWriteLandsAfterItsPageIsGoneAndTheNextPageSaysHowItWent() {
        signIn()
        open("orbit-wiki:${WikiShell.ENTRY}")
        awaitTag("wiki-entry-title")
        compose.onNodeWithTag("wiki-entry-edit").performClick()
        awaitTag("wiki-entry-form-summary")
        compose.onNodeWithTag("wiki-entry-form-summary").performTextReplacement("Written while the page went away.")
        val gate = shell.hold("POST", "wiki/spaces/${WikiShell.SPACE}/changesets")
        compose.onNodeWithTag("wiki-entry-form-save").performClick()
        compose.waitForIdle()
        // A notification's link takes the reader to the Wiki home while the save is still on its way.
        open("orbit://wiki/${WikiShell.SPACE}")
        awaitTag("wiki-home-list")
        gate.complete(Unit)
        compose.waitUntil(10_000) { shell.ended.containsKey("POST wiki/spaces/${WikiShell.SPACE}/changesets") }
        assertEquals("the write went on to its answer", "answered", shell.ended["POST wiki/spaces/${WikiShell.SPACE}/changesets"])
        compose.waitUntil(10_000) { compose.onAllNodesWithTag("wiki-notice").fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithTag("wiki-notice").assertTextContains("runner-go’s full suite inside a session reaches production", substring = true)
    }

    // MARK: P1-2 — a decide the server recorded `conflict` applied nothing

    @Test fun anAcceptTheServerRecordedAsAConflictSaysNothingWasApplied() {
        shell.decision = "conflict"
        signIn()
        open("orbit://wiki/${WikiShell.SPACE}")
        openReviewFromActivity()
        compose.onNodeWithTag("wiki-review-tab:amend").performClick()
        awaitTag("wiki-review-card:${WikiShell.AMEND_OP}")
        compose.onNodeWithTag("wiki-review-accept").performScrollTo().performClick()
        compose.waitUntil(10_000) { shell.writes("wiki/changesets/${WikiShell.AMEND_CHANGESET}/decide").isNotEmpty() }
        compose.waitUntil(10_000) { compose.onAllNodesWithText("Nothing was applied", substring = true).fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithText("Nothing was applied: the entry changed after this was proposed.").assertExists()
        assertTrue("no Accepted toast for an op that changed nothing",
            compose.onAllNodesWithText(WikiCopy.decidedAccepted).fetchSemanticsNodes().isEmpty())
    }

    // MARK: P2 — a page opened again starts afresh

    @Test fun aDocumentOpenedAgainAtTheSameSectionScrollsThereAgain() {
        signIn()
        open("orbit://wiki/${WikiShell.SPACE}")
        awaitTag("wiki-home-list")
        compose.onNodeWithTag("wiki-bar-contents").performClick()
        awaitTag("wiki-contents-index")
        compose.onNodeWithTag("wiki-contents-index").performClick()
        val entry = "wiki-index-entry:${WikiShell.DOC}:s3"
        scrollIndexTo(entry)
        compose.onNodeWithTag(entry).performClick()
        awaitTag("wiki-doc-section:s3")
        assertTrue("opened at its section", sectionAtTop("s3"))
        // The reader goes up to the top, back to the index, and opens the same section again.
        compose.onNodeWithTag("wiki-doc-list").performScrollToIndex(0)
        compose.onNodeWithTag("wiki-doc-crumb").assertIsDisplayed()
        assertFalse(sectionAtTop("s3"))
        back()
        scrollIndexTo(entry)
        compose.onNodeWithTag(entry).performClick()
        awaitTag("wiki-doc-list")
        awaitThat("the document again") { compose.onAllNodesWithTag("wiki-doc-section:s3").fetchSemanticsNodes().isNotEmpty() }
        assertTrue("a section opened again is shown at that section, not from the top", sectionAtTop("s3"))
    }

    @Test fun aSecondLinkToASpaceShowsThatSpaceAgain() {
        signIn()
        open("orbit://wiki/${WikiShell.OTHER_SPACE}")
        awaitThat("the linked space") { picker().contains("wikova") }
        // The reader picks another space on the same page; the next notification names the first one again.
        compose.onNodeWithTag("wiki-space-picker").performClick()
        compose.onNodeWithTag("wiki-space:orbit").performClick()
        awaitThat("the picked space") { picker().contains("orbit") }
        open("orbit://wiki/${WikiShell.OTHER_SPACE}")
        awaitThat("the linked space, again") { picker().contains("wikova") }
    }

    @Test fun aLinkToASpaceThisAccountDoesNotHaveSaysItIsNotAvailable() {
        signIn()
        open("orbit://wiki/${WikiShell.GONE_SPACE}")
        compose.waitUntil(10_000) { compose.onAllNodesWithText("That space is not available.").fetchSemanticsNodes().isNotEmpty() }
        assertTrue("no other space's home stands in for it", compose.onAllNodesWithTag("wiki-home-list").fetchSemanticsNodes().isEmpty())
    }

    @Test fun aWatchsRefusedControlIsNotShownWhenTheWatchIsOpenedAgain() {
        shell.pauseRefusal = "a MATCHED watch cannot be paused"
        signIn()
        open("orbit://watch/${WikiShell.WATCH}")
        awaitTag("watch-detail:${WikiShell.WATCH}")
        compose.onNodeWithTag("watch:${WikiShell.WATCH}:WATCH_PAUSE").performClick()
        compose.waitUntil(10_000) { compose.onAllNodesWithTag("watch-error").fetchSemanticsNodes().isNotEmpty() }
        back()
        awaitTag("following")
        open("orbit://watch/${WikiShell.WATCH}")
        awaitTag("watch-detail:${WikiShell.WATCH}")
        compose.waitForIdle()
        assertTrue("an old refusal is not this visit's", compose.onAllNodesWithTag("watch-error").fetchSemanticsNodes().isEmpty())
    }

    /** MainActivity drops a Settings or Runner page's saved state once its route has left every stack (A13), and a Wiki
     * or Watch page's likewise (A12): two effects over one holder, each over its own routes. A Settings page pushed over
     * a watch and popped takes only its own state with it; the watch's goes when the watch itself is left. */
    @Test fun aSettingsPagePoppedOffAWatchLeavesTheWatchsStateAlone() {
        shell.pauseRefusal = "a MATCHED watch cannot be paused"
        signIn()
        open("orbit://watch/${WikiShell.WATCH}")
        awaitTag("watch-detail:${WikiShell.WATCH}")
        compose.onNodeWithTag("watch:${WikiShell.WATCH}:WATCH_PAUSE").performClick()
        compose.waitUntil(10_000) { compose.onAllNodesWithTag("watch-error").fetchSemanticsNodes().isNotEmpty() }
        // Settings, from the drawer, goes on the same stack, over the watch.
        compose.onNodeWithContentDescription("Open navigation").performClick()
        compose.onNodeWithText("Settings").performScrollTo().performClick()
        awaitThat("Settings over the watch") { compose.onAllNodesWithTag("watch-detail:${WikiShell.WATCH}").fetchSemanticsNodes().isEmpty() }
        back()
        awaitTag("watch-detail:${WikiShell.WATCH}")
        compose.waitForIdle()
        assertTrue("the watch never left its stack: its refusal is still this visit's",
            compose.onAllNodesWithTag("watch-error").fetchSemanticsNodes().isNotEmpty())
        back()
        awaitTag("following")
        open("orbit://watch/${WikiShell.WATCH}")
        awaitTag("watch-detail:${WikiShell.WATCH}")
        compose.waitForIdle()
        assertTrue("left, the watch took its state with it", compose.onAllNodesWithTag("watch-error").fetchSemanticsNodes().isEmpty())
    }

    // MARK: refresh — by event type, and never an older read over a newer one

    @Test fun theWikiReReadsOnWikiChangedAndNotOnOtherAccountEvents() {
        signIn()
        open("orbit://wiki/${WikiShell.SPACE}")
        awaitTag("wiki-home-list")
        settle(2_000)
        val entries = "GET wiki/spaces/${WikiShell.SPACE}/entries"
        val before = shell.count(entries)
        repeat(3) { shell.event("session.updated") }
        settle(4_000)
        assertEquals("session events do not re-read the Wiki; ${shell.calls.takeLast(30)}", before, shell.count(entries))
        shell.event("wiki.changed")
        settle(2_000)
        settleUntil("wiki.changed to re-read what the Wiki shows") { shell.count(entries) > before }
    }

    @Test fun watchesReReadOnTaskAndSessionEventsAndNotOnWikiChanged() {
        signIn()
        open("orbit://watch/${WikiShell.WATCH}")
        awaitTag("watch-detail:${WikiShell.WATCH}")
        settle(5_000)
        val before = shell.count("GET watches")
        shell.event("wiki.changed")
        settle(6_000)
        assertEquals("a wiki event does not re-read watches; ${shell.calls.takeLast(30)}", before, shell.count("GET watches"))
        shell.event("task.changed")
        settle(5_000)
        settleUntil("a task event to re-read the live watches") { shell.count("GET watches") > before }
    }

    @Test fun aReviewReadThatAnswersLateNeverBringsBackAnAnsweredCard() {
        signIn()
        open("orbit://wiki/${WikiShell.SPACE}")
        openReviewFromActivity()
        compose.onNodeWithTag("wiki-review-tab:amend").performClick()
        awaitTag("wiki-review-card:${WikiShell.AMEND_OP}")
        // A re-read of the queue goes out and is slow to answer; it was asked while the op still waited.
        val late = shell.hold("GET", "wiki/review")
        shell.event("wiki.changed")
        settle(2_000)
        compose.onNodeWithTag("wiki-review-accept").performScrollTo().performClick()
        compose.waitUntil(10_000) { shell.writes("wiki/changesets/${WikiShell.AMEND_CHANGESET}/decide").isNotEmpty() }
        settle(2_000)
        late.complete(Unit)
        settle(2_000)
        assertTrue("the answered card does not come back", compose.onAllNodesWithTag("wiki-review-card:${WikiShell.AMEND_OP}").fetchSemanticsNodes().isEmpty())
    }

    // MARK: helpers

    /** Review is reached from Activity's first banner: the bar's Activity, then the banner. */
    private fun openReviewFromActivity() {
        awaitTag("wiki-bar-activity")
        compose.onNodeWithTag("wiki-bar-activity").performClick()
        awaitTag("wiki-review-banner")
        compose.onNodeWithTag("wiki-review-banner").performClick()
        awaitTag("wiki-review-page")
    }

    private fun app() = compose.activity.application as OrbitApplication
    private fun signIn() {
        compose.waitUntil(5_000) { app().session.state.value is AuthState.SignedOut }
        app().realtime.setNetwork(true, "fixture")
        runBlocking { shell.signIn(app().session) }
        compose.waitUntil(10_000) { app().session.state.value is AuthState.SignedIn && app().realtime.state.value.directoryFresh }
    }
    /** A link as Android delivers one to the running Activity; the launch intent is put back for ActivityScenario. */
    private fun open(link: String) {
        compose.activityRule.scenario.onActivity {
            val launch = it.intent
            MainActivity::class.java.getDeclaredMethod("onNewIntent", Intent::class.java).apply { isAccessible = true }
                .invoke(it, Intent(Intent.ACTION_VIEW, Uri.parse(link)).setClass(it, MainActivity::class.java))
            it.intent = launch
        }
        compose.waitForIdle()
    }
    private fun back() = compose.activityRule.scenario.onActivity { it.onBackPressedDispatcher.onBackPressed() }
    private fun awaitTag(tag: String) = awaitThat(tag) { compose.onAllNodesWithTag(tag).fetchSemanticsNodes().isNotEmpty() }
    /** A wait that, when it runs out, says what the page and the server were doing. */
    private fun awaitThat(what: String, condition: () -> Boolean) {
        try { compose.waitUntil(10_000, condition) }
        catch (timeout: androidx.compose.ui.test.ComposeTimeoutException) {
            throw AssertionError("waited for $what; picker='${picker()}'; last calls=${shell.calls.takeLast(12)}", timeout)
        }
    }
    /** The index scrolled to the row [tag]: the list is on screen before its reads answer, so the scroll is tried
     * until the row is in it. */
    private fun scrollIndexTo(tag: String) = awaitThat("the index row $tag") {
        runCatching { compose.onNodeWithTag("wiki-index-list").performScrollToNode(hasTestTag(tag)) }.isSuccess
    }
    /** The section's heading at the top of the document list: where opening the document at it puts the reader. */
    private fun sectionAtTop(key: String): Boolean {
        val heading = compose.onNodeWithTag("wiki-doc-section:$key").fetchSemanticsNode().boundsInRoot.top
        val list = compose.onNodeWithTag("wiki-doc-list").fetchSemanticsNode().boundsInRoot.top
        return heading - list in -1f..48f
    }
    private fun picker(): String = compose.onAllNodesWithTag("wiki-space-picker").fetchSemanticsNodes().firstOrNull()
        ?.let { node -> node.config.getOrNull(SemanticsProperties.Text)?.joinToString(" ") { text -> text.text } }.orEmpty()
    /** Let debounced re-reads run: the clocks move, then everything due settles — reads hop to AuthSession's IO
     * threads and back, so each step also gives them a moment of real time. */
    private fun settle(ms: Long) { repeat((ms / 250).toInt()) { step() } }
    private fun step() {
        main.scheduler.advanceTimeBy(250); main.scheduler.runCurrent()
        // `processScope` took the main looper's own dispatcher when the application was made: its delays run on
        // Robolectric's looper clock.
        org.robolectric.Shadows.shadowOf(android.os.Looper.getMainLooper()).idleFor(java.time.Duration.ofMillis(250))
        compose.mainClock.advanceTimeBy(250); compose.waitForIdle()
        Thread.sleep(25)
        org.robolectric.Shadows.shadowOf(android.os.Looper.getMainLooper()).idle(); compose.waitForIdle()
    }
    /** Step the clocks until [condition] holds. */
    private fun settleUntil(what: String, ms: Long = 15_000, condition: () -> Boolean) {
        var left = ms
        while (!condition()) {
            if (left <= 0) throw AssertionError("waited for $what; last calls=${shell.calls.takeLast(30)}")
            step(); left -= 250
        }
    }
}
