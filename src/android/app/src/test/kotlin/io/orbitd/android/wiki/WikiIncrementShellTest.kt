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

/** The A12c items in the real shell over the controlled server ([WikiShell]). A12-1 (iOS b85473546): the home's
 * principles and Activity's decisions read by their own kind out of a space thousands of entries deep, one proposal said
 * in the singular, Review naming an entry no other read holds, an account the wiki is off for. A12-2 (iOS 42d12db2b):
 * the bar's Activity and the drawer saying one number waiting on the owner, Activity's bands and banners adding up to it,
 * what is new since the reader last looked, the space by its repository's name, and the space a workspace opens. Every
 * check goes through the production Activity by links, tags and the words on screen. */
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
        // Recent decisions are Activity's now.
        press("wiki-bar-activity")
        awaitThat("the decisions read by kind") { shell.calls.any { it == "GET wiki/spaces/${WikiShell.SPACE}/entries?kind=decision&limit=4" } }
        listOf("Decision 6", "Decision 5", "Decision 4", "Decision 3").forEach { title -> scrollTo("wiki-activity-list", title) }
        assertTrue("the four newest only", compose.onAllNodesWithText("Decision 2").fetchSemanticsNodes().isEmpty())
        assertTrue(compose.onAllNodesWithText("Nothing has been recorded in this space yet.").fetchSemanticsNodes().isEmpty())
    }

    /** One waiting proposal is said in the singular, on Activity's first banner. */
    @Test fun oneProposalIsSaidInTheSingular() {
        shell.spaces = spacesWith(pendingOps = 1)
        signIn()
        open("orbit://wiki/${WikiShell.SPACE}")
        press("wiki-bar-activity")
        awaitTag("wiki-review-banner")
        compose.onNodeWithTag("wiki-review-banner").assertTextContains("1 proposal to review")
    }

    /** A retire's card names its entry by the title Review's read carries (`entryTitle`): that entry is in no other read
     * the page has, and the card used to say "entry". */
    @Test fun reviewNamesAnEntryNoOtherReadHolds() {
        shell.reviewQueue = reviewWithEntryTitle("34UDOpRetireWakeup002", "Wakeups are lost when the runner restarts")
        signIn()
        open("orbit://wiki/${WikiShell.SPACE}")
        press("wiki-bar-activity")
        press("wiki-review-banner")
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

    // MARK: A12-2 — one number waiting on the owner, and Activity

    /** What waits on the owner is one number — every space's proposals and the things each plan waits for: the drawer's
     * Wiki row and the bar's Activity say it "5 waiting on you", and Activity's amber banners add up to it — the proposals
     * with the other space's share on the line, then one banner per kind of thing the plan waits for. */
    @Test fun theDrawerTheBarAndActivitySayOneNumber() {
        shell.spaces = spaces(orbit = mapOf("pendingOps" to 1, "planWaiting" to 2), wikova = mapOf("pendingOps" to 2, "planWaiting" to 0))
        shell.plans = mapOf(WikiShell.SPACE to planWithDraftAndOneChange())
        signIn()
        compose.onNodeWithContentDescription("Open navigation").performClick()
        awaitThat("the row's count") { compose.onAllNodesWithTag("wiki-drawer-count", useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithTag("wiki-drawer-count", useUnmergedTree = true).assertTextEquals("5").assert(hasContentDescription("5 waiting on you"))
        compose.onNode(hasText("Wiki") and hasClickAction()).performClick()
        awaitTag("wiki-home-list")
        compose.onNodeWithTag("wiki-bar-activity").assert(hasContentDescription("Activity")).assert(hasStateDescription("5 waiting on you"))
        // The badge draws the number; TalkBack hears it once, from the button's state.
        compose.onNodeWithTag("wiki-bar-activity-badge", useUnmergedTree = true).assertExists()
        press("wiki-bar-activity")
        awaitTag("wiki-status-line")
        awaitText("Plan draft ready to confirm")
        val banners = listOf("3 proposals to review · 2 in wikova", "Plan draft ready to confirm", "1 plan change to review")
        banners.forEach { awaitText(it) }
        // The bar names the page and the space, by its repository's last segment.
        assertEquals("orbit", barSubtitle())
        // Their order is Activity's: the proposals, then the space's plan.
        val tops = banners.map { compose.onNodeWithText(it).fetchSemanticsNode().boundsInRoot.top }
        assertEquals(tops.sorted(), tops)
        press("wiki-review-banner")
        awaitTag("wiki-review-page")
    }

    /** Activity's bands in the web's order under the bar's title: the status line, the banners, Recent decisions, Recently
     * changed — every row new to a reader who never looked, said beside its heading — and Agents used the wiki. Looked at
     * again after a second visit of the home, nothing has changed since. */
    @Test fun activityMarksWhatChangedSinceTheReaderLastLooked() {
        signIn()
        open("orbit://wiki/${WikiShell.SPACE}")
        awaitTag("wiki-home-list")
        press("wiki-bar-activity")
        awaitTag("wiki-status-line")
        compose.onNodeWithTag("wiki-status-line").assertTextEquals("9 entries · Anchors verified at 4db4f9f")
        awaitThat("the new rows' count") { compose.onAllNodesWithTag("wiki-activity-new", useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty() }
        compose.onNode(isHeading() and hasText("Recently changed", substring = true)).assertTextContains("5 new since you last looked", substring = true)
        val order = listOf("3 proposals to review", "Recent decisions", "Recently changed", "Agents used the wiki")
        order.forEach { scrollTo("wiki-activity-list", it) }
        compose.onNodeWithTag("wiki-activity-list").performScrollToIndex(0)
        // The reader comes back a little later: the home moves the stamp, and Activity compares against that visit.
        Thread.sleep(1_100); back(); awaitTag("wiki-home-list")
        Thread.sleep(1_100); press("wiki-bar-activity")
        awaitTag("wiki-status-line")
        compose.waitForIdle()
        assertTrue("nothing changed since", compose.onAllNodesWithTag("wiki-activity-new", useUnmergedTree = true).fetchSemanticsNodes().isEmpty())
    }

    /** A space is called by its repository's last segment. With several, the name opens a menu of them — each with its
     * repository and documents, and what waits in it — and Manage spaces, into Wiki settings; picking one opens its home. */
    @Test fun theSpacesAreCalledByTheirRepositoryAndSeveralAreAMenu() {
        shell.spaces = spaces(orbit = mapOf("pendingOps" to 1), wikova = mapOf("pendingOps" to 0, "docs" to mapOf("written" to 3, "total" to 12)))
        signIn()
        open("orbit://wiki/${WikiShell.SPACE}")
        awaitTag("wiki-home-list")
        compose.onNodeWithTag("wiki-space-picker").assert(hasContentDescription(WikiCopy.spacePickerHint)).assertTextContains("orbit")
        press("wiki-space-picker")
        awaitTag("wiki-space:wikova")
        compose.onNodeWithTag("wiki-space:orbit").assertTextContains("github.com/jianghailong-xy/orbit\nNo documents yet").assertIsSelected()
        compose.onNodeWithTag("wiki-space:wikova").assertTextContains("github.com/jianghailong-xy/wikova\n12 documents")
        compose.onNode(hasContentDescription("1 waiting"), useUnmergedTree = true).assertExists()
        compose.onNodeWithTag("wiki-space-manage").assertTextEquals("Manage spaces")
        press("wiki-space:wikova")
        awaitThat("wikova's home") { picker().contains("wikova") }
        press("wiki-space-picker")
        press("wiki-space-manage")
        awaitTag("wiki-settings-page")
    }

    /** One space: its name as a label and no control. */
    @Test fun oneSpaceIsALabelAndNoMenu() {
        shell.spaces = JsonArray(listOf(Wire.json.parseToJsonElement(WikiFixtures.spaces).jsonArray[0])).toString()
        signIn()
        open("orbit://wiki/${WikiShell.SPACE}")
        awaitTag("wiki-home-list")
        compose.onNodeWithTag("wiki-space-picker").assertTextContains("orbit").assert(hasNoClickAction())
    }

    /** Coming into the Wiki from a workspace opens the space bound to it; from the Tasks list, the one last looked at. */
    @Test fun comingIntoTheWikiFromAWorkspaceOpensTheSpaceBoundToIt() {
        val workspace = "01a0cca7-8609-70ed-a0e2-d4b55b832b99"
        shell.workspaces = """[{"id":"$workspace","name":"wikova-develop"}]"""
        shell.spaces = spaces(orbit = mapOf("pendingOps" to 3), wikova = mapOf("workspaceIds" to listOf(workspace)))
        signIn()
        // The workspace's session list, from the workspaces page.
        awaitTag("workspace:$workspace")
        compose.onNodeWithTag("workspace:$workspace").performClick()
        compose.onNodeWithContentDescription("Open navigation").performClick()
        awaitThat("the Wiki row") { compose.onAllNodes(hasText("Wiki") and hasClickAction()).fetchSemanticsNodes().isNotEmpty() }
        compose.onNode(hasText("Wiki") and hasClickAction()).performClick()
        awaitThat("the workspace's space") { picker().contains("wikova") }
        // From the Tasks list, which is no workspace: the space last looked at stays.
        compose.onNodeWithContentDescription("Open navigation").performClick()
        compose.onNode(hasText("Tasks") and hasClickAction()).performClick()
        compose.onNodeWithContentDescription("Open navigation").performClick()
        compose.onNode(hasText("Wiki") and hasClickAction()).performClick()
        awaitTag("wiki-home-list")
        compose.waitForIdle()
        assertTrue(picker().contains("wikova"))
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

    /** The fixture's two spaces with these fields over theirs. */
    private fun spaces(orbit: Map<String, Any>, wikova: Map<String, Any> = emptyMap()): String =
        JsonArray(Wire.json.parseToJsonElement(WikiFixtures.spaces).jsonArray.mapIndexed { i, space ->
            JsonObject(space.jsonObject + (if (i == 0) orbit else wikova).mapValues { (_, value) -> json(value) })
        }).toString()
    private fun json(value: Any?): JsonElement = when (value) {
        null -> JsonNull
        is Number -> JsonPrimitive(value)
        is String -> JsonPrimitive(value)
        is Boolean -> JsonPrimitive(value)
        is List<*> -> JsonArray(value.map(::json))
        is Map<*, *> -> JsonObject(value.entries.associate { (k, v) -> k.toString() to json(v) })
        else -> error("no JSON for $value")
    }
    /** A plan whose draft waits to be confirmed, with one change proposed: two things waiting on the owner. */
    private fun planWithDraftAndOneChange() = """{"spaceId":"${WikiShell.SPACE}","confirmed":null,
        "draft":{"id":"v1","version":1,"status":"draft"},"proposals":[{"id":"p1","status":"pending"}],"job":null}"""

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
    /** A press once its node is there and enabled. */
    private fun press(tag: String) {
        awaitThat(tag) { compose.onAllNodes(hasTestTag(tag) and isEnabled()).fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithTag(tag).performClick()
        compose.waitForIdle()
    }
    private fun picker(): String = compose.onAllNodesWithTag("wiki-space-picker").fetchSemanticsNodes().firstOrNull()
        ?.let { node -> node.config.getOrNull(SemanticsProperties.Text)?.joinToString(" ") { text -> text.text } }.orEmpty()
    /** The bar's second line: the space a page is about. */
    private fun barSubtitle(): String = compose.onAllNodesWithTag("page-bar-subtitle", useUnmergedTree = true).fetchSemanticsNodes().firstOrNull()
        ?.let { node -> node.config.getOrNull(SemanticsProperties.Text)?.joinToString(" ") { text -> text.text } }.orEmpty()
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
