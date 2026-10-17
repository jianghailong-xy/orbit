package io.orbitd.android.wiki

import androidx.activity.compose.setContent
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsNode
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
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

    private fun changeset(ops: String, origin: String = "session", session: String? = "01a0cca7-8609-70ed-a0e2-d4b55b832b60") =
        Wire.json.decodeFromString(WikiChangeset.serializer(), """{"id":"c1","origin":"$origin",${session?.let { "\"sessionId\":\"$it\"," } ?: ""}
            "rationale":"Learned while porting","createdAt":"2026-10-05T11:00:00Z","ops":[$ops]}""")
    private val ops = listOf(
        """{"id":"op-add","seq":0,"op":"add","payload":{"entry":{"kind":"pitfall","title":"Robolectric needs sdk 29","summary":"Pin it"},"sources":[{"kind":"turn","quote":"It failed on 36"}]},"decision":"pending","similar":[{"id":"e9","title":"Pin the sdk","kind":"pitfall"}]}""",
        """{"id":"op-amend","seq":1,"op":"amend","entryId":"e1","payload":{"changes":{"title":"Use the A06 reader everywhere"}},"decision":"pending","tainted":true}""",
        """{"id":"op-retire","seq":2,"op":"retire","entryId":"e1","payload":{"reason":"No longer true"},"decision":"pending"}""",
        """{"id":"op-challenge","seq":3,"op":"challenge","entryId":"e1","payload":{},"decision":"pending"}""")

    private val decided = mutableListOf<Triple<String, String, String?>>()
    private val edits = mutableListOf<String>()
    private val amends = mutableListOf<String>()
    private val sessions = mutableListOf<String>()
    private val actions = WikiReviewActions(
        decide = { card, action, reason -> decided += Triple(card.op.id, action, reason) },
        edit = { edits += it.op.id }, openSession = { sessions += it }, amend = { amends += it.op.id })

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

    @Test fun aChallengeIsAnsweredAboutItsEntryAndAmendWaitsForTheEntry() {
        val cards = WikiLogic.reviewCards(listOf(changeset(ops[3])))
        review(cards)
        compose.onNodeWithTag("wiki-review-challenge").assertTextContains("Changed", substring = true)
        compose.onNodeWithTag("wiki-review-challenge").assertTextContains("checked on main at 0123456", substring = true)
        compose.onNodeWithText(WikiModeCopy.challengeWaits).assertExists()
        compose.onNodeWithTag("wiki-review-reconfirm").performScrollTo().performClick()
        compose.onNodeWithTag("wiki-review-amend").performScrollTo().performClick()
        compose.onNodeWithTag("wiki-review-challenge-retire").performScrollTo().performClick()
        assertEquals(listOf(Triple("op-challenge", "reconfirm", null), Triple("op-challenge", "retire", null)), decided)
        assertEquals(listOf("op-challenge"), amends)
    }

    @Test fun aChallengeWhoseEntryIsNotReadYetCannotBeAmended() {
        review(WikiLogic.reviewCards(listOf(changeset(ops[3]))), named = null)
        compose.onNodeWithTag("wiki-review-amend").performScrollTo().assertIsNotEnabled()
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
