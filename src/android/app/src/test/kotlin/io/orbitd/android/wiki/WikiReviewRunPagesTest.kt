package io.orbitd.android.wiki

import android.graphics.Bitmap
import android.graphics.Canvas
import androidx.activity.compose.setContent
import androidx.compose.material3.ColorScheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsNode
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.text.AnnotatedString
import io.orbitd.android.MainActivity
import io.orbitd.android.TestOrbitApplication
import io.orbitd.android.core.protocol.Wire
import io.orbitd.android.ui.OrbitTheme
import java.time.Instant
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/** The Review and run pages as iOS draws them, over controlled reads: which answers each op offers, what each
 * press asks for, and the pager/tab rules. Pages only — the store's requests are WikiStoreHttpTest's. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = TestOrbitApplication::class)
class WikiReviewRunPagesTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()
    private val now = Instant.parse("2026-10-05T12:00:00Z")
    private val entry = Wire.json.decodeFromString(WikiEntry.serializer(), """{"id":"e1","kind":"decision","status":"active","trust":"confirmed",
        "title":"Use the A06 reader","summary":"One reader","currentRevision":3,"fields":{"decision":"Reuse it"},
        "anchors":[{"type":"path","path":"src/Reader.kt","check":{"state":"changed","ref":"0123456789abcdef","at":"2026-10-05T00:00:00Z"}}]}""")
    /** The same entry as a convention: a kind an Amend can rewrite, where a decision is only ever superseded. */
    private val convention = entry.copy(kind = "convention")
    private val challengeReason = "Wrong as a standing rule. Production deploys need the owner's approval."

    private fun changeset(ops: String, origin: String = "session", session: String? = "01a0cca7-8609-70ed-a0e2-d4b55b832b60") =
        Wire.json.decodeFromString(WikiChangeset.serializer(), """{"id":"c1","origin":"$origin",${session?.let { "\"sessionId\":\"$it\"," } ?: ""}
            "rationale":"Learned while porting","createdAt":"2026-10-05T11:00:00Z","ops":[$ops]}""")
    private val ops = listOf(
        """{"id":"op-add","seq":0,"op":"add","payload":{"entry":{"kind":"pitfall","title":"Robolectric needs sdk 29","summary":"Pin it"},"sources":[{"kind":"turn","quote":"It failed on 36"}]},"decision":"pending","similar":[{"id":"e9","title":"Pin the sdk","kind":"pitfall"}]}""",
        """{"id":"op-amend","seq":1,"op":"amend","entryId":"e1","payload":{"changes":{"title":"Use the A06 reader everywhere"}},"decision":"pending","tainted":true}""",
        """{"id":"op-retire","seq":2,"op":"retire","entryId":"e1","payload":{"reason":"No longer true"},"decision":"pending"}""",
        """{"id":"op-challenge","seq":3,"op":"challenge","entryId":"e1","payload":{"reason":"$challengeReason"},"decision":"pending"}""")

    private val decided = mutableListOf<Triple<String, String, String?>>()
    private val edits = mutableListOf<String>()
    private val amends = mutableListOf<String>()
    private val sessions = mutableListOf<String>()
    private val retired = mutableListOf<Pair<String, String>>()
    private val actions = WikiReviewActions(
        decide = { card, action, reason -> decided += Triple(card.op.id, action, reason) },
        edit = { edits += it.op.id }, openSession = { sessions += it }, amend = { amends += it.op.id },
        retire = { card, note -> retired += card.op.id to note })

    private fun review(cards: List<WikiLogic.ReviewCard>, named: WikiEntry? = entry) {
        compose.activityRule.scenario.onActivity { activity -> activity.setContent { OrbitTheme {
            WikiReviewPage(cards, entry = { id -> named?.takeIf { it.id == id } }, now = now, busy = false, actions = actions)
        } } }
    }

    @Test fun tabsCountTheirOpsAndThePagerWalksTheQueueOneCardAtATime() {
        review(WikiLogic.reviewCards(listOf(changeset(ops.joinToString(",")))))
        compose.onNodeWithText("All 4").assertIsDisplayed()
        compose.onNodeWithText("Add 1").assertIsDisplayed()
        // An amend's tab holds supersedes too; a challenge counts only under All.
        compose.onNodeWithText("Amend 1").assertIsDisplayed()
        compose.onNodeWithText("Retire 1").assertIsDisplayed()
        compose.onNodeWithTag("wiki-review-position").assertTextEquals("1 of 4")
        compose.onNodeWithTag("wiki-review-previous").assertIsNotEnabled()
        compose.onNodeWithTag("wiki-review-next").performClick()
        compose.onNodeWithTag("wiki-review-position").assertTextEquals("2 of 4")
        // The index is kept across a tab change and clamped to the queue that is there.
        compose.onNodeWithTag("wiki-review-tab:retire").performClick()
        compose.onNodeWithTag("wiki-review-position").assertDoesNotExist()
        compose.onNodeWithTag("wiki-review-card:op-retire").assertIsDisplayed()
    }

    @Test fun anAddOffersAcceptEditAndRejectWithItsFourReasons() {
        review(WikiLogic.reviewCards(listOf(changeset(ops[0]))))
        compose.onNodeWithText("ADD").assertIsDisplayed()
        compose.onNodeWithText("Pitfall").assertIsDisplayed()
        compose.onNodeWithTag("wiki-review-card-title").assertTextEquals("Robolectric needs sdk 29")
        compose.onNodeWithText("“It failed on 36” — Turn · quote not checked").assertExists()
        compose.onNodeWithText("Pin the sdk · Pitfall").assertExists()
        compose.onNodeWithText(WikiCopy.acceptNote).assertExists()
        compose.onNodeWithTag("wiki-review-accept").performScrollTo().performClick()
        compose.onNodeWithTag("wiki-review-edit").performScrollTo().performClick()
        compose.onNodeWithTag("wiki-review-reject").performScrollTo().performClick()
        compose.onNodeWithText(WikiCopy.rejectReasonFoot).assertIsDisplayed()
        listOf("Not true", "Not useful", "Duplicate", "Too specific").forEach { compose.onNodeWithText(it).assertIsDisplayed() }
        compose.onNodeWithTag("wiki-review-reject:duplicate").performClick()
        assertEquals(listOf(Triple("op-add", "accept", null), Triple("op-add", "reject", "duplicate")), decided)
        assertEquals(listOf("op-add"), edits)
        // Who proposed it opens that session.
        compose.onNodeWithTag("wiki-review-proposer").performScrollTo().performClick()
        assertEquals(listOf("01a0cca7-8609-70ed-a0e2-d4b55b832b60"), sessions)
    }

    @Test fun anAmendShowsItsDiffAndAWebDerivedOneSaysSo() {
        review(WikiLogic.reviewCards(listOf(changeset(ops[1]))))
        compose.onNodeWithTag("wiki-review-web-derived").assertIsDisplayed()
        compose.onNodeWithText("- Use the A06 reader").assertExists()
        compose.onNodeWithText("+ Use the A06 reader everywhere").assertExists()
        compose.onNodeWithText(WikiCopy.webDerivedNote).assertExists()
    }

    @Test fun aRetireIsRetireOrKeepAndKeepIsARejectionAsNotTrue() {
        review(WikiLogic.reviewCards(listOf(changeset(ops[2]))))
        compose.onNodeWithTag("wiki-review-card-title").assertTextEquals("Retire “Use the A06 reader”")
        compose.onNodeWithText("No longer true").assertExists()
        compose.onNodeWithText(WikiCopy.afterRetire).assertExists()
        compose.onNodeWithTag("wiki-review-accept").assertDoesNotExist()
        compose.onNodeWithTag("wiki-review-retire-keep").performScrollTo().performClick()
        compose.onNodeWithTag("wiki-review-retire-accept").performScrollTo().performClick()
        assertEquals(listOf(Triple("op-retire", "reject", "not_true"), Triple("op-retire", "accept", null)), decided)
    }

    /** A challenge is answered about its entry: Keep, Amend… and Retire…, one under the other and full width, under the
     * After row that says what each does to the entry, the answer's word first (owner, 2026-11-07). Keep decides
     * `reconfirm`, Amend… opens the form, and Retire… asks first: it decides nothing yet. */
    @Test fun aChallengeIsAnsweredKeepAmendOrRetireUnderWhatEachDoes() {
        review(WikiLogic.reviewCards(listOf(changeset(ops[3]))), named = convention)
        compose.onNodeWithTag("wiki-review-challenge").assertTextContains("Changed", substring = true)
        compose.onNodeWithTag("wiki-review-challenge").assertTextContains("checked on main at 0123456", substring = true)
        compose.onNodeWithText(WikiModeCopy.challengeWaits).assertExists()
        val answers = listOf("wiki-review-keep", "wiki-review-amend", "wiki-review-challenge-retire").map { compose.onNodeWithTag(it).fetchSemanticsNode() }
        assertEquals(listOf("Keep", "Amend…", "Retire…"), answers.map { node -> node.config[SemanticsProperties.Text].joinToString { it.text } })
        assertEquals("one under the other", answers.sortedBy { it.boundsInRoot.top }, answers)
        assertEquals("all as wide", 1, answers.map { it.boundsInRoot.width }.toSet().size)
        assertTrue("the After row is right above the answers",
            compose.onNodeWithTag("wiki-review-after").fetchSemanticsNode().boundsInRoot.bottom <= answers.first().boundsInRoot.top)
        assertEquals(listOf("After", "Keep · Agents get this entry again. You can still retire it later.",
            "Amend · Agents get your version, and its anchors are checked again.", "Retire · Agents stop getting it. This cannot be undone."),
            afterLines())
        compose.onNodeWithTag("wiki-review-reconfirm").assertDoesNotExist()
        compose.onNodeWithTag("wiki-review-keep").performScrollTo().performClick()
        compose.onNodeWithTag("wiki-review-amend").performScrollTo().performClick()
        compose.onNodeWithTag("wiki-review-challenge-retire").performScrollTo().performClick()
        assertEquals(listOf(Triple("op-challenge", "reconfirm", null)), decided)
        assertEquals(listOf("op-challenge"), amends)
        assertTrue("Retire… asks first", retired.isEmpty())
        compose.onNodeWithTag("wiki-review-challenge-retire-dialog").assertExists()
    }

    /** A decision is superseded, never amended — the server refuses its amend WIKI_SCHEMA — so its challenge offers Keep
     * and Retire… only, and the After row says nothing of an Amend. */
    @Test fun aDecisionsChallengeOffersNoAmend() {
        review(WikiLogic.reviewCards(listOf(changeset(ops[3]))))
        compose.onNodeWithTag("wiki-review-amend").assertDoesNotExist()
        compose.onNodeWithTag("wiki-review-keep").performScrollTo().assertTextEquals("Keep")
        compose.onNodeWithTag("wiki-review-challenge-retire").performScrollTo().assertTextEquals("Retire…")
        assertEquals(listOf("After", "Keep · Agents get this entry again. You can still retire it later.",
            "Retire · Agents stop getting it. This cannot be undone."), afterLines())
    }

    /** Until its entry is read, a challenge's kind is not known: Amend… is there, and waits for the entry its form edits. */
    @Test fun aChallengeWhoseEntryIsNotReadYetCannotBeAmended() {
        review(WikiLogic.reviewCards(listOf(changeset(ops[3]))), named = null)
        compose.onNodeWithTag("wiki-review-amend").performScrollTo().assertIsNotEnabled()
    }

    /** Retire… asks first, in the entry page's dialog: what retiring does and that it cannot be undone, then the reason,
     * filled in with the challenge's own each time it opens. Cancel decides nothing; Retire sends the reason trimmed, and
     * takes no blank one. */
    @Test fun retireAsksFirstWithTheChallengesReasonFilledIn() {
        review(WikiLogic.reviewCards(listOf(changeset(ops[3]))), named = convention)
        compose.onNodeWithTag("wiki-review-challenge-retire").performScrollTo().performClick()
        val inDialog = hasAnyAncestor(hasTestTag("wiki-review-challenge-retire-dialog"))
        compose.onNode(inDialog and hasText("Retire…")).assertExists()
        compose.onNode(inDialog and hasText("Agents stop getting this entry. It stays in History, struck through, and the reason goes on the " +
            "record. This cannot be undone.")).assertExists()
        assertEquals(challengeReason, reasonField())
        compose.onNodeWithTag("wiki-review-challenge-retire-cancel").assertTextEquals("Cancel").performSemanticsAction(SemanticsActions.OnClick)
        compose.onNodeWithTag("wiki-review-challenge-retire-dialog").assertDoesNotExist()
        assertTrue(retired.isEmpty() && decided.isEmpty())

        compose.onNodeWithTag("wiki-review-challenge-retire").performScrollTo().performClick()
        assertEquals("opened again, it starts from the challenge's reason again", challengeReason, reasonField())
        typeReason("")
        compose.onNode(hasText(WikiCopy.reasonPlaceholder) and hasAnyAncestor(hasTestTag("wiki-review-challenge-retire-reason")), useUnmergedTree = true)
            .assertExists()
        compose.onNodeWithTag("wiki-review-challenge-retire-confirm").assertIsNotEnabled()
        typeReason("   ")
        compose.onNodeWithTag("wiki-review-challenge-retire-confirm").assertIsNotEnabled()
        typeReason("  It never held.  ")
        compose.onNodeWithTag("wiki-review-challenge-retire-confirm").assertIsEnabled().assertTextEquals("Retire")
            .performSemanticsAction(SemanticsActions.OnClick)
        compose.onNodeWithTag("wiki-review-challenge-retire-dialog").assertDoesNotExist()
        assertEquals(listOf("op-challenge" to "It never held."), retired)
        assertTrue("Retire… is no decide of its own", decided.isEmpty())
    }

    /** When the card shown changes — Next, or an answer the server took — the page goes back to its top, so the next card is
     * read from its head and not with its answers under the finger that pressed one (owner, 2026-11-07). */
    @Test fun theNextCardIsShownFromItsHead() {
        val second = ops[3].replace("\"op-challenge\"", "\"op-challenge-2\"").replace("\"seq\":3", "\"seq\":4")
        var cards by mutableStateOf(WikiLogic.reviewCards(listOf(changeset("${ops[3]},$second"))))
        compose.activityRule.scenario.onActivity { activity -> activity.setContent { OrbitTheme {
            WikiReviewPage(cards, entry = { id -> convention.takeIf { it.id == id } }, now = now, busy = false, actions = actions)
        } } }
        fun offset() = compose.onNodeWithTag("wiki-review-page").fetchSemanticsNode().config[SemanticsProperties.VerticalScrollAxisRange].value()
        compose.onNodeWithTag("wiki-review-keep").performScrollTo()
        assertTrue("the answers are reached by scrolling", offset() > 0f)
        compose.onNodeWithTag("wiki-review-next").performSemanticsAction(SemanticsActions.OnClick)
        compose.onNodeWithTag("wiki-review-card:op-challenge-2").assertExists()
        assertEquals("Next shows the card from its head", 0f, offset())
        compose.onNodeWithTag("wiki-review-keep").performScrollTo().performClick()
        assertTrue(offset() > 0f)
        // The server takes the answered card away; the one left is shown from its head.
        cards = cards.filter { it.op.id != "op-challenge-2" }
        compose.onNodeWithTag("wiki-review-card:op-challenge").assertExists()
        assertEquals("an answer shows the next card from its head", 0f, offset())
        compose.onNodeWithTag("wiki-review-card-title").assertIsDisplayed()
        assertEquals(listOf(Triple("op-challenge-2", "reconfirm", null)), decided)
    }

    /** No answer of a challenge is filled — none of them is "do what this card proposes" — and Retire…, which cannot be
     * undone, is outlined and worded in the error colour, as its word in the After row is, where Keep and Amend… are not.
     * The Retire card's filled Retire shows the measure can tell. Read off the drawn pixels, light and dark. */
    @Test @Config(qualifiers = "w411dp-h891dp-xxhdpi") @GraphicsMode(GraphicsMode.Mode.NATIVE)
    fun noChallengeAnswerIsFilledAndRetireIsInTheErrorColour() {
        listOf(false, true).forEach { dark ->
            var scheme: ColorScheme? = null
            fun show(op: String) = compose.activityRule.scenario.onActivity { activity -> activity.setContent { OrbitTheme(darkTheme = dark) { Surface {
                scheme = MaterialTheme.colorScheme
                WikiReviewPage(WikiLogic.reviewCards(listOf(changeset(op))), entry = { id -> convention.takeIf { it.id == id } }, now = now,
                    busy = false, actions = actions)
            } } } }
            val theme = if (dark) "dark" else "light"
            show(ops[3])
            compose.onNodeWithTag("wiki-review-challenge-retire").performScrollTo()
            var screen = draw()
            val primary = scheme!!.primary.toArgb(); val error = scheme!!.error.toArgb()
            listOf("wiki-review-keep", "wiki-review-amend", "wiki-review-challenge-retire").forEach { tag ->
                val pixels = pixels(screen, tag)
                assertTrue("$theme: $tag is not filled", pixels.count { it == primary } < pixels.size / 4)
            }
            assertTrue("$theme: Retire… is in the error colour", error in pixels(screen, "wiki-review-challenge-retire"))
            assertFalse("$theme: Keep is not", error in pixels(screen, "wiki-review-keep"))
            assertFalse("$theme: Amend… is not", error in pixels(screen, "wiki-review-amend"))
            assertTrue("$theme: Retire's word in the After row is", error in pixels(screen, "wiki-review-after"))
            show(ops[2])
            compose.onNodeWithTag("wiki-review-retire-accept").performScrollTo()
            screen = draw()
            val filled = pixels(screen, "wiki-review-retire-accept")
            assertTrue("$theme: a filled answer measures as one", filled.count { it == primary } > filled.size / 2)
        }
    }

    private fun afterLines() = compose.onAllNodes(hasAnyAncestor(hasTestTag("wiki-review-after")), useUnmergedTree = true)
        .fetchSemanticsNodes().map { node -> node.config[SemanticsProperties.Text].joinToString { it.text } }
    /** Into the dialog's field without focusing it (SetText), as the device kit does. */
    private fun typeReason(text: String) = compose.onNodeWithTag("wiki-review-challenge-retire-reason")
        .performSemanticsAction(SemanticsActions.SetText) { it(AnnotatedString(text)) }
    private fun reasonField() = compose.onNodeWithTag("wiki-review-challenge-retire-reason").fetchSemanticsNode()
        .config[SemanticsProperties.EditableText].text
    private fun draw(): Bitmap {
        compose.waitForIdle()
        val view = compose.activity.window.decorView
        return Bitmap.createBitmap(view.width, view.height, Bitmap.Config.ARGB_8888).also { view.draw(Canvas(it)) }
    }
    /** Every pixel drawn inside the node [tag] names. */
    private fun pixels(screen: Bitmap, tag: String): IntArray {
        val bounds = compose.onNodeWithTag(tag).fetchSemanticsNode().boundsInWindow
        val left = bounds.left.toInt().coerceIn(0, screen.width); val top = bounds.top.toInt().coerceIn(0, screen.height)
        val width = bounds.right.toInt().coerceIn(left, screen.width) - left; val height = bounds.bottom.toInt().coerceIn(top, screen.height) - top
        assertTrue("$tag is drawn nowhere on the screen", width > 0 && height > 0)
        return IntArray(width * height).also { screen.getPixels(it, 0, width, left, top, width, height) }
    }

    @Test fun anEmptyQueueSaysNothingWaitsAndStillExplainsAutoAccept() {
        review(emptyList())
        compose.onNodeWithTag("wiki-review-empty").assertTextEquals(WikiCopy.noReview)
        compose.onNodeWithText(WikiCopy.autoAccept).assertExists()
        compose.onNodeWithText(WikiCopy.reinforceNote).assertExists()
        assertEquals(WikiCopy.noReview, reviewSubtitle(emptyList(), now))
        val cards = WikiLogic.reviewCards(listOf(changeset(ops.joinToString(","))))
        assertEquals("4 proposals from 1 session · oldest 1h ago", reviewSubtitle(cards, now))
    }

    private fun runView(revertible: Boolean, added: Int) = WikiChangesetView.decode(Wire.json.parseToJsonElement("""{"id":"c9","origin":"maintenance",
        "sessionId":"01a0cca7-8609-70ed-a0e2-d4b55b832b60","createdAt":"2026-10-05T11:00:00Z",
        "ops":[${(0 until added).joinToString(",") { """{"id":"a$it","seq":$it,"op":"add","resultEntryId":"n$it","payload":{"entry":{"title":"Added $it","summary":"line $it"}},"decision":"auto_applied","appliedByMode":"automatic"}""" }}],
        "entries":[${(0 until added).joinToString(",") { """{"id":"n$it","status":"active","trust":"${if (it == 0) "unreviewed" else "auto"}","title":"Added $it","summary":"line $it"}""" }}],
        "counts":{"applied":$added,"auto":${added - 1},"unreviewed":1,"rejectedByCheck":0,"toReview":0},"revertible":$revertible,"revert":{"adds":$added,"amends":0}}"""))

    @Test fun aRunPageShowsWhatItAppliedAndRevertsOnlyWhenTheServerSaysItCan() {
        val reverts = mutableListOf<Unit>(); val opened = mutableListOf<String>(); val rejected = mutableListOf<Pair<String, String>>()
        val actions = WikiRunActions(revert = { reverts += Unit }, openSession = { opened += it }, openEntry = { opened += it },
            reject = { id, reason -> rejected += id to reason })
        var revertible by mutableStateOf(false)
        compose.activityRule.scenario.onActivity { activity -> activity.setContent { OrbitTheme {
            WikiRunPage(runView(revertible, 6), busy = false, actions = actions)
        } } }
        compose.onNodeWithText("${WikiCopy.historyMaintenance} · run").assertIsDisplayed()
        compose.onNodeWithTag("wiki-run-title").assertTextEquals("Applied 6 changes")
        compose.onNodeWithTag("wiki-run-counts").assertTextEquals("5 Auto  ·  1 Unreviewed")
        compose.onNodeWithTag("wiki-run-revert").assertIsNotEnabled()
        compose.onNodeWithTag("wiki-run-open-session").performClick()
        // Four rows, then the rest behind Show 2 more.
        compose.onNodeWithText("Added 3").assertExists()
        compose.onNodeWithText("Added 4").assertDoesNotExist()
        compose.onNodeWithTag("wiki-run-more:Added").performScrollTo().performClick()
        compose.onNodeWithText("Added 5").assertExists()
        compose.onNodeWithTag("wiki-run-row:a1").performScrollTo().performClick()
        // An answerable row's Reject asks for the reason that goes on the record.
        val row: SemanticsNode = compose.onNodeWithTag("wiki-run-row:a0", useUnmergedTree = true).performScrollTo().fetchSemanticsNode()
        val custom: List<CustomAccessibilityAction> = generateSequence(row) { it.parent }
            .firstNotNullOf { node -> node.config.getOrNull(SemanticsActions.CustomActions) }
        val reject: CustomAccessibilityAction = custom.first { it.label == WikiCopy.reject }
        compose.runOnUiThread { reject.action() }
        compose.onNodeWithText(WikiModeCopy.rejectOnRecord).assertIsDisplayed()
        compose.onNodeWithTag("wiki-run-reject:too_specific").performClick()
        assertEquals(listOf("n0" to "too_specific"), rejected)
        assertEquals(listOf("01a0cca7-8609-70ed-a0e2-d4b55b832b60", "n1"), opened)
        revertible = true
        compose.onNodeWithTag("wiki-run-list").performScrollToIndex(0)
        compose.onNodeWithTag("wiki-run-revert").assertIsEnabled().performClick()
        assertEquals(1, reverts.size)
    }
}
