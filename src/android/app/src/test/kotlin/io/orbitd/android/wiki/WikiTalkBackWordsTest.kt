package io.orbitd.android.wiki

import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.runtime.Composable
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsNode
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import io.orbitd.android.MainActivity
import io.orbitd.android.TestOrbitApplication
import io.orbitd.android.core.protocol.Wire
import io.orbitd.android.directory.DirectoryData
import io.orbitd.android.navigation.Destination
import io.orbitd.android.navigation.OrbitRoute
import io.orbitd.android.ui.OrbitTheme
import java.time.Instant
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** What TalkBack found on the emulator (WikiWatchTalkBackTest), held on the JVM: no word TalkBack reads is a bare symbol
 * ("ⓘ", "💬", "◎", "⚠", "•", "✓", "—"), every heading has words of its own to be announced with, no press says its words
 * twice, and the parts TalkBack spoke apart or with their glyph ("✓ Confirm", "· Draft", "“…”") carry plain words. A node's label is what TalkBack
 * reads in place of its text. Pages over the shared fixtures; the screen reader itself is the device check's. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = TestOrbitApplication::class, qualifiers = "w411dp-h3000dp")
class WikiTalkBackWordsTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()

    private fun show(bar: OrbitRoute? = null, content: @Composable () -> Unit) {
        compose.activityRule.scenario.onActivity { it.setContent { OrbitTheme { Column { if (bar != null) Row { PageBar.Actions(bar, this) }; content() } } } }
        compose.waitForIdle()
    }

    /** What TalkBack reads on a node: its label, else its text. */
    private fun read(node: SemanticsNode): List<String> = node.config.getOrNull(SemanticsProperties.ContentDescription)?.takeIf { it.isNotEmpty() }
        ?: node.config.getOrNull(SemanticsProperties.Text).orEmpty().map { it.text }
    private val bareSymbol = SemanticsMatcher("words that are only a symbol") { node -> read(node).any { it.isNotBlank() && it.none(Char::isLetterOrDigit) } }
    private val silentHeading = SemanticsMatcher("a heading without words of its own") { node ->
        node.config.contains(SemanticsProperties.Heading) && read(node).isEmpty() }

    /** A press whose label or state repeats the words under it: TalkBack says them twice. */
    private val repeated = SemanticsMatcher("a press that says its words twice") { node ->
        node.config.contains(SemanticsActions.OnClick) && (node.config.getOrNull(SemanticsProperties.ContentDescription).orEmpty() +
            listOfNotNull(node.config.getOrNull(SemanticsProperties.StateDescription)) + node.config.getOrNull(SemanticsProperties.Text).orEmpty().map { it.text })
            .filter { words -> words.any(Char::isLetter) }.groupingBy { it.lowercase() }.eachCount().any { it.value > 1 } }

    private fun assertTalkBackReadsWords(where: String) {
        compose.waitForIdle()
        val bare = compose.onAllNodes(bareSymbol, useUnmergedTree = true).fetchSemanticsNodes().map(::read)
        assertTrue("$where: TalkBack reads these on their own: $bare", bare.isEmpty())
        val silent = compose.onAllNodes(silentHeading).fetchSemanticsNodes().map { heading -> heading.children.flatMap(::read) }
        assertTrue("$where: headings TalkBack never announces: $silent", silent.isEmpty())
        val twice = compose.onAllNodes(repeated).fetchSemanticsNodes().map { it.config }
        assertTrue("$where: presses TalkBack reads twice: $twice", twice.isEmpty())
    }

    /** The home: the review banner and the space picker say each of their words once (TalkBack read the banner twice,
     * and the space's slug as a state and again as its text). */
    @Test fun theHomesPressesSayTheirWordsOnce() {
        val space = WikiFixtures.spaceID
        val rig = WikiTestRig { api ->
            when (api.path.joinToString("/")) {
                "wiki/spaces" -> 200 to WikiFixtures.spaces
                "wiki/spaces/$space" -> 200 to WikiFixtures.space
                "wiki/spaces/$space/entries" -> 200 to WikiFixtures.entries
                "wiki/spaces/$space/timeline" -> 200 to WikiFixtures.timeline
                "wiki/review" -> 200 to WikiFixtures.review
                else -> null
            }
        }
        val route = OrbitRoute(Destination.WIKI)
        show(route) { WikiHomeScreen(rig.store(), route, DirectoryData(), WikiNavRecord().nav) }
        compose.waitUntil(5_000) { compose.onAllNodesWithTag("wiki-review-banner").fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithTag("wiki-review-banner").assertTextContains("proposals to review", substring = true)
        compose.onNodeWithTag("wiki-space-picker").assert(hasContentDescription(WikiCopy.spacePickerHint)).assertTextContains("orbit")
        assertTalkBackReadsWords("home")
    }
    private fun labelled(tag: String, label: String) = compose.onNodeWithTag(tag).assert(hasContentDescription(label))

    /** An entry a review mode applied: its glyphs (the mark bar's ⓘ, a source's kind, an anchor's ◎) say nothing, its
     * section headers are headings with their counts, and Confirm and Reject are said without their tick and arrow. */
    @Test fun anAppliedEntryReadsInWords() {
        val detail = WikiFixtures.entryDetail.replace("\"trust\":\"confirmed\"", "\"trust\":\"unreviewed\"")
        val store = wikiTestStore { path ->
            when (path) {
                listOf("wiki", "entries", WikiFixtures.pitfallID) -> 200 to detail
                listOf("link-previews") -> 200 to """{"previews":[]}"""
                else -> 404 to "{}"
            }
        }
        val route = OrbitRoute(Destination.WIKI_ENTRY, WikiFixtures.pitfallID)
        show(route) { WikiEntryScreen(store, route, DirectoryData(), WikiNavRecord().nav) }
        compose.waitUntil(5_000) { compose.onAllNodesWithTag("wiki-entry-mark").fetchSemanticsNodes().isNotEmpty() }
        labelled("wiki-entry-confirm", "Confirm")
        labelled("wiki-entry-reject", "Reject")
        compose.onNode(isHeading() and hasText("Sources")).assertTextContains("3")
        assertTalkBackReadsWords("entry")
        toTheEnd("wiki-entry-list")
        assertTalkBackReadsWords("entry, its end")
    }

    /** A list scrolled as far down as it goes. */
    private fun toTheEnd(tag: String) {
        compose.onNodeWithTag(tag).performSemanticsAction(SemanticsActions.ScrollBy) { it(0f, 1_000_000f) }
        compose.waitForIdle()
    }

    /** The plan's version menu says its state without the dot TalkBack spoke on its own. */
    @Test fun thePlansVersionMenuSaysItsStateWithoutTheDot() {
        val route = OrbitRoute(Destination.WIKI_PLAN)
        val state = WikiPlanFixture.state("draftReady")
        val shown = WikiPlanLogic.defaultShown(state)
        show(route) { WikiPlanPage(route, state, shown, shown?.let { WikiPlanLogic.base(it, state) }, emptyList(), null, null, null, null, WikiPlanFixture.now) }
        compose.onNodeWithTag("wiki-plan-version-menu").assert(hasContentDescription(shown!!.status.label))
        assertTalkBackReadsWords("plan")
    }

    /** A document past the threshold, its scope open, its footnotes and their sheets: the banner's ⚠, the bullets and the
     * sheets' glyphs say nothing; a footnote row says its verdict and its quote in words. */
    @Test fun aDocumentItsFootnotesAndTheirSheetsReadInWords() {
        val doc = wikiDocsFixture().obj("docs").obj("doc").obj("read").decodeAs(WikiDoc.serializer())
        show { WikiDocPage(doc, "https://github.com/example/orbit", null) }
        labelled("wiki-doc-next-marked", "Next marked")
        compose.onNodeWithTag("wiki-doc-scope-toggle").performSemanticsAction(SemanticsActions.OnClick)
        assertTalkBackReadsWords("document")
        val list = compose.onNodeWithTag("wiki-doc-list")
        val verified = doc.footnotes.orEmpty().first { it.verdict == "verified" }
        val missing = doc.footnotes.orEmpty().first { it.verdict == "not_found" && it.quote != null }
        list.performScrollToNode(hasTestTag("wiki-doc-footnote:${verified.n}"))
        compose.onNode(hasAnyAncestor(hasTestTag("wiki-doc-footnote:${verified.n}")) and hasText(WikiDocCopy.verdictList("verified")), useUnmergedTree = true)
            .assert(hasContentDescription("quote verified"))
        list.performScrollToNode(hasTestTag("wiki-doc-footnote:${missing.n}"))
        compose.onNode(hasAnyAncestor(hasTestTag("wiki-doc-footnote:${missing.n}")) and hasText(WikiDocLogic.quoted(missing.quote!!)), useUnmergedTree = true)
            .assert(hasContentDescription(missing.quote!!))
        assertTalkBackReadsWords("document, its footnotes")
        toTheEnd("wiki-doc-list")
        assertTalkBackReadsWords("document, its end")
        // Each footnote's sheet over a fresh page: a session's (with the entry it came through) and a code one's.
        listOf(missing.n, doc.footnotes.orEmpty().first { it.kind == "code" }.n).forEach { n ->
            show { WikiDocPage(doc, "https://github.com/example/orbit", null) }
            compose.onNodeWithTag("wiki-doc-list").performScrollToNode(hasTestTag("wiki-doc-footnote:$n"))
            compose.onNodeWithTag("wiki-doc-footnote:$n").performSemanticsAction(SemanticsActions.OnClick)
            compose.waitUntil(5_000) { compose.onAllNodesWithTag("wiki-doc-footnote-sheet").fetchSemanticsNodes().isNotEmpty() }
            assertTalkBackReadsWords("footnote $n's sheet")
        }
    }

    /** Review, every kind of card: Auto-accept's ticks say nothing, a challenge's ◎ says nothing, and the dash that
     * stands for nothing is read as None. */
    @Test fun everyReviewCardReadsInWords() {
        val entry = Wire.json.decodeFromString(WikiEntry.serializer(), """{"id":"e1","kind":"decision","status":"active","trust":"confirmed",
            "title":"Use the A06 reader","summary":"One reader","currentRevision":3,"fields":{"decision":"Reuse it"},
            "anchors":[{"type":"path","path":"src/Reader.kt","check":{"state":"changed","ref":"0123456789abcdef","at":"2026-10-05T00:00:00Z"}}]}""")
        val ops = listOf(
            """{"id":"op-add","seq":0,"op":"add","payload":{"entry":{"kind":"pitfall","title":"Robolectric needs sdk 29","summary":"Pin it"}},"decision":"pending"}""",
            """{"id":"op-amend","seq":1,"op":"amend","entryId":"e1","payload":{"changes":{"title":"Use the A06 reader everywhere"}},"decision":"pending","tainted":true}""",
            """{"id":"op-retire","seq":2,"op":"retire","entryId":"e1","payload":{"reason":"No longer true"},"decision":"pending"}""",
            """{"id":"op-challenge","seq":3,"op":"challenge","entryId":"e1","payload":{},"decision":"pending"}""")
        val changeset = Wire.json.decodeFromString(WikiChangeset.serializer(), """{"id":"c1","origin":"session","sessionId":"01a0cca7-8609-70ed-a0e2-d4b55b832b60",
            "rationale":"Learned while porting","createdAt":"2026-10-05T11:00:00Z","ops":[${ops.joinToString(",")}]}""")
        val cards = WikiLogic.reviewCards(listOf(changeset))
        show { WikiReviewPage(cards, entry = { id -> entry.takeIf { it.id == id } }, now = Instant.parse("2026-10-05T12:00:00Z"), busy = false, actions = WikiReviewActions()) }
        repeat(cards.size) { at ->
            compose.onNodeWithTag("wiki-review-position").assertTextEquals(WikiCopy.ofCount(at + 1, cards.size))
            assertTalkBackReadsWords("review card ${at + 1}")
            if (at < cards.size - 1) compose.onNodeWithTag("wiki-review-next").performSemanticsAction(SemanticsActions.OnClick)
        }
        compose.onAllNodes(hasText("—") and hasContentDescription(WikiCopy.similarNone), useUnmergedTree = true).onFirst().assertExists()
    }

    /** A band of the home is one heading: its title with its count and badge, announced as a heading. */
    @Test fun aHomeBandIsOneHeadingWithItsCount() {
        show { WikiBandHeader(WikiCopy.principles, 3, badge = WikiCopy.trustLabel("owner")) }
        compose.onNode(isHeading()).assertTextContains(WikiCopy.principles).assertTextContains("3").assertTextContains(WikiCopy.trustLabel("owner"))
        assertTalkBackReadsWords("home band")
    }
}
