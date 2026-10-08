package io.orbitd.android.wiki

import android.content.Intent
import android.net.Uri
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import io.orbitd.android.MainActivity
import io.orbitd.android.OrbitApplication
import io.orbitd.android.core.auth.AuthState
import io.orbitd.android.core.protocol.Wire
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.setMain
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TestWatcher
import org.junit.runner.Description
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** The A12c items in the real shell over the controlled server ([WikiShell]), as iOS b85473546 has them: the home's
 * principles and the decisions read by their own kind out of a space thousands of entries deep, one proposal said in the
 * singular, Review naming an entry no other read holds, and an account the wiki is off for. Every check goes through
 * the production Activity by links, tags and the words on screen. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = WikiShellApplication::class, qualifiers = "w411dp-h891dp")
@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
class WikiIncrementShellTest {
    private val main = UnconfinedTestDispatcher()
    @get:Rule(order = 0)
    val mainDispatcher = object : TestWatcher() {
        override fun starting(description: Description) { Dispatchers.setMain(main) }
        override fun finished(description: Description) { Dispatchers.resetMain() }
    }
    @get:Rule(order = 1)
    val compose = createAndroidComposeRule<MainActivity>()
    private val shell = WikiShell

    @Before fun start() { shell.reset(); WikiToast.text = null }

    // MARK: A12-1 — the home reads its principles and decisions by kind

    /** The orbit space's shape: three principles and six decisions, all older than its 200 newest entries. Picked out of
     * those 200, the home showed no principle and no decision; each band reads its own kind. */
    @Test fun aSpaceThousandsDeepStillShowsItsPrinciplesAndItsNewestDecisions() {
        shell.entries = Window.principles + Window.decisions + Window.newer
        signIn()
        open("orbit://wiki/${WikiShell.SPACE}")
        awaitThat("the principles read by kind") { shell.calls.any { it == "GET wiki/spaces/${WikiShell.SPACE}/entries?kind=principle&limit=200" } }
        Window.principles.map { it.title() }.forEach { title -> scrollTo("wiki-home-list", title) }
        awaitThat("the decisions read by kind") { shell.calls.any { it == "GET wiki/spaces/${WikiShell.SPACE}/entries?kind=decision&limit=4" } }
        listOf("Decision 6", "Decision 5", "Decision 4", "Decision 3").forEach { title -> scrollTo("wiki-home-list", title) }
        assertTrue("the four newest only", compose.onAllNodesWithText("Decision 2").fetchSemanticsNodes().isEmpty())
        assertTrue(compose.onAllNodesWithText("Nothing has been recorded in this space yet.").fetchSemanticsNodes().isEmpty())
    }

    /** One waiting proposal is said in the singular. */
    @Test fun oneProposalIsSaidInTheSingular() {
        shell.spaces = spacesWith(pendingOps = 1)
        signIn()
        open("orbit://wiki/${WikiShell.SPACE}")
        awaitTag("wiki-review-banner")
        compose.onNodeWithTag("wiki-review-banner").assertTextContains("1 proposal to review")
    }

    /** A retire's card names its entry by the title Review's read carries (`entryTitle`): that entry is in no other read
     * the page has, and the card used to say "entry". */
    @Test fun reviewNamesAnEntryNoOtherReadHolds() {
        shell.reviewQueue = reviewWithEntryTitle("34UDOpRetireWakeup002", "Wakeups are lost when the runner restarts")
        signIn()
        open("orbit://wiki/${WikiShell.SPACE}")
        awaitTag("wiki-review-banner")
        compose.onNodeWithTag("wiki-review-banner").performClick()
        awaitTag("wiki-review-page")
        compose.onNodeWithTag("wiki-review-tab:retire").performClick()
        awaitTag("wiki-review-card:34UDOpRetireWakeup002")
        awaitThat("the entry's own read answered 404") { shell.calls.any { it.startsWith("GET wiki/entries/34UDFnrgM4q5oWakeLost") } }
        compose.waitForIdle()
        compose.onNodeWithTag("wiki-review-card-title").assertTextEquals("Retire “Wakeups are lost when the runner restarts”")
    }

    // MARK: A12-1 — an account the server has the wiki off for

    /** The server answers every wiki route 404 WIKI_DISABLED: the drawer draws no Wiki row once the spaces read says so,
     * and a Wiki link says the wiki is off rather than that it could not be loaded. */
    @Test fun anAccountTheWikiIsOffForHasNoWikiRowAndIsToldSo() {
        shell.wikiDisabled = true
        signIn()
        compose.onNodeWithContentDescription("Open navigation").performClick()
        awaitThat("the drawer's spaces read") { shell.calls.any { it == "GET wiki/spaces" } }
        compose.waitForIdle()
        compose.onNodeWithText("Tasks").assertExists()
        assertTrue("no Wiki row", compose.onAllNodes(hasText("Wiki") and hasClickAction()).fetchSemanticsNodes().isEmpty())
        back()
        open("orbit://wiki/${WikiShell.SPACE}")
        awaitText("The wiki is not switched on for this account.")
        assertTrue(compose.onAllNodesWithText("The wiki couldn't be loaded").fetchSemanticsNodes().isEmpty())
        open("orbit-wiki:${WikiShell.ENTRY}")
        awaitText("The wiki is not switched on for this account.")
    }

    /** With the wiki on, the same drawer draws the row, with the number of proposals waiting. */
    @Test fun anAccountWithTheWikiHasItsWikiRow() {
        signIn()
        compose.onNodeWithContentDescription("Open navigation").performClick()
        awaitThat("the Wiki row") { compose.onAllNodes(hasText("Wiki") and hasClickAction()).fetchSemanticsNodes().isNotEmpty() }
        // The count is a part of the row, which merges it: read in the row's own tree.
        awaitThat("the row's count") { compose.onAllNodesWithTag("wiki-drawer-count", useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithTag("wiki-drawer-count", useUnmergedTree = true).assertTextEquals("3")
    }

    // MARK: fixtures

    /** WikiHomeWindowTests' space: three principles (one retired), six decisions, and 250 entries newer than all of them. */
    private object Window {
        private fun at(month: Int, day: Int, minute: Int = 0) =
            String.format(java.util.Locale.ROOT, "2026-%02d-%02dT%02d:%02d:00.000Z", month, day, minute / 60, minute % 60)
        private fun entry(id: String, kind: String, title: String, at: String, status: String = "active") = buildJsonObject {
            put("id", id); put("spaceId", WikiShell.SPACE); put("kind", kind); put("status", status)
            put("trust", if (kind == "principle") "owner" else "confirmed"); put("currentRevision", 1)
            put("title", title); put("summary", "$title, in one line."); put("validFrom", at); put("recordedAt", at)
        }
        val principles = listOf(entry("P1", "principle", "A clock never starts agent work", at(1, 1)),
            entry("P2", "principle", "Delete means forget", at(1, 2)),
            entry("P3", "principle", "Completion is adjudicated, not claimed", at(1, 3), status = "retired"))
        val decisions = (1..6).map { entry("D$it", "decision", "Decision $it", at(2, it)) }
        val newer = (0 until 250).map { n -> entry(String.format(java.util.Locale.ROOT, "N%03d", n), if (n % 2 == 0) "pitfall" else "recipe",
            "Newer entry $n", at(9, 1, minute = n)) }
    }
    private fun JsonObject.title() = getValue("title").jsonPrimitive.content

    private fun spacesWith(pendingOps: Int): String = JsonArray(Wire.json.parseToJsonElement(WikiFixtures.spaces).jsonArray.mapIndexed { i, space ->
        JsonObject(space.jsonObject + ("pendingOps" to JsonPrimitive(if (i == 0) pendingOps else 0)))
    }).toString()

    private fun reviewWithEntryTitle(opId: String, title: String): String = JsonArray(Wire.json.parseToJsonElement(WikiFixtures.review).jsonArray.map { changeset ->
        val ops = changeset.jsonObject.getValue("ops").jsonArray.map { op ->
            if (op.jsonObject.getValue("id").jsonPrimitive.content != opId) op else JsonObject(op.jsonObject + ("entryTitle" to JsonPrimitive(title)))
        }
        JsonObject(changeset.jsonObject + ("ops" to JsonArray(ops)))
    }).toString()

    // MARK: helpers (WikiShellTest's)

    private fun app() = compose.activity.application as OrbitApplication
    private fun signIn() {
        compose.waitUntil(5_000) { app().session.state.value is AuthState.SignedOut }
        app().realtime.setNetwork(true, "fixture")
        runBlocking { shell.signIn(app().session) }
        compose.waitUntil(10_000) { app().session.state.value is AuthState.SignedIn && app().realtime.state.value.directoryFresh }
    }
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
    private fun awaitText(text: String) = awaitThat(text) { compose.onAllNodesWithText(text).fetchSemanticsNodes().isNotEmpty() }
    /** A lazy list's row with [text], scrolled into view once the list holds it. */
    private fun scrollTo(list: String, text: String) = awaitThat("“$text” in $list") {
        runCatching { compose.onNodeWithTag(list).performScrollToNode(hasText(text)) }.isSuccess
    }
    private fun awaitThat(what: String, condition: () -> Boolean) {
        try { compose.waitUntil(10_000, condition) }
        catch (timeout: androidx.compose.ui.test.ComposeTimeoutException) {
            throw AssertionError("waited for $what; on screen: '${screenText()}'; last calls=${shell.calls.takeLast(12)}", timeout)
        }
    }
    /** What the screen says, for a wait that ran out. */
    private fun screenText(): String = compose.onAllNodes(hasText("", substring = true)).fetchSemanticsNodes().take(40)
        .mapNotNull { node -> node.config.getOrNull(SemanticsProperties.Text)?.joinToString(" ") { it.text } }.joinToString(" | ")
}
