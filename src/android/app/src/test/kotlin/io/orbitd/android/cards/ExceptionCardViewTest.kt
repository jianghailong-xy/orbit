package io.orbitd.android.cards

import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.text.font.FontFamily
import io.orbitd.android.MainActivity
import io.orbitd.android.TestOrbitApplication
import io.orbitd.android.core.cards.*
import io.orbitd.android.core.protocol.Wire
import io.orbitd.android.management.AccountTranslation
import io.orbitd.android.management.LocalTranslation
import io.orbitd.android.translation.TranslationCopy
import androidx.compose.runtime.CompositionLocalProvider
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** The owner's exception card as the conversation draws it (A08-17; iOS `OwnerItemCardView`): what has to happen next first, who is on
 * it, each door with its line and in its weight, Review only beside its merge card, the Check row's faces and log, the owner's own
 * ending with the draft it keeps, the pause, and a card whose item went. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = TestOrbitApplication::class, qualifiers = "w411dp-h891dp")
class ExceptionCardViewTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()
    private val pressed = mutableListOf<Pair<CardVerb, CardInput>>()
    private val opened = mutableListOf<String>()
    private val reviewed = mutableListOf<String>()
    private val key = "item:01a0bb0b-b3fb-744c-b9a6-2fd68b4420b4"

    private fun row(kind: String, actions: List<String>, promotionId: String? = null, taskId: String? = "t1", sessionId: String? = "s9",
        requiredAction: String? = null, handledBy: List<String> = emptyList(), facts: JsonElement = JsonNull, fuseEpisodeId: String? = null,
        reason: String = "ESCALATED", primaryAction: String? = null, landingSessionId: String? = null, integrationJobId: String? = null,
        lease: JsonElement = JsonNull, title: String = "Checks failed on the combined tree", handledByState: String = "OPEN") = buildJsonObject {
        put("itemId", "01a0bb0b-b3fb-744c-b9a6-2fd68b4420b4"); put("kind", kind); put("title", title)
        put("detailLine", "the merge check exited 1"); put("assignee", "OWNER"); put("assigneeReason", reason)
        put("waitingSince", "2026-09-19T19:01:41.497Z"); put("escalatedAt", if (reason == "ESCALATED") "2026-09-19T21:02:23.903Z" else null)
        put("taskId", taskId); put("sessionId", sessionId); put("promotionId", promotionId); put("fuseEpisodeId", fuseEpisodeId)
        put("landingSessionId", landingSessionId); put("integrationJobId", integrationJobId)
        putJsonObject("delivery") { put("state", "NOT_REQUIRED"); put("sessionId", JsonNull); put("at", JsonNull) }
        putJsonArray("actions") { actions.forEach { add(it) } }
        requiredAction?.let { put("requiredAction", it) }
        primaryAction?.let { put("primaryAction", it) }
        if (handledBy.isNotEmpty()) putJsonArray("handledBy") { handledBy.forEach { addJsonObject { put("taskId", "01a0bb0b-b3fb-744c-b9a6-2fd68b4420f0"); put("title", it); put("state", handledByState) } } }
        put("question", JsonNull); put("facts", facts); put("lease", lease)
    }
    private fun card(row: JsonObject) = CardCatalog.project("s1", "p1", mapOf("project" to buildJsonObject { put("id", "p1") },
        "openItems" to buildJsonObject { putJsonArray("needsYou") { add(row) }; putJsonArray("withCoordinator") {} })).single()

    private fun show(card: InteractionCard, mergeCard: String? = null, main: String = "main") {
        compose.runOnUiThread { compose.activity.setContent { MaterialTheme { Column(Modifier.verticalScroll(rememberScrollState())) {
            ExceptionCard(card, fresh = true, result = CardActionState(), mergeCard = mergeCard, open = { opened += it }, discuss = null,
                review = { reviewed += it }, main = main) { verb, input -> pressed += verb to input }
        } } } }
        compose.waitForIdle()
    }
    private fun top(tag: String) = compose.onNodeWithTag(tag, useUnmergedTree = true).fetchSemanticsNode().boundsInRoot.top

    private val check = Wire.json.parseToJsonElement("""{"task":null,"targetRef":"project/bg-jobs","targetSha":"b70a4461c2d3","files":[],"nothingLanded":false,
        "check":{"command":"cd src/runner-go && go test ./...","exitCode":1,"timedOut":false,"durationMs":340000,
          "outputTail":"--- FAIL: TestScheduleWakeup\n    wake_test.go:88: wake not delivered\nFAIL"},"branchUnchanged":true,"errorCode":null,"failure":null}""")

    @Test fun itOpensWithWhatHasToHappenNextThenTheDoorsEachWithItsLine() {
        // A chain's 3rd failure keeps this layout; an escalation draws the "Who fixes it?" card (below).
        val candidate = card(row("INTEGRATION_CHECK_FAILED", listOf("ASK_COORDINATOR_AGAIN", "RETRY", "REVIEW"), promotionId = "pr1", taskId = null,
            sessionId = null, reason = "CHAIN_LIMIT", requiredAction = "Nothing on the project branch reaches main until this check passes.", handledBy = listOf("Fix the branch"),
            handledByState = "DONE", facts = check))
        show(candidate, mergeCard = "pr1")
        // Its repair has ended, so the card is the plain one: no Fixing tag, no one linked line.
        compose.onNodeWithTag("$key:fixing-tag", useUnmergedTree = true).assertDoesNotExist()
        compose.onNodeWithTag("$key:fixing", useUnmergedTree = true).assertDoesNotExist()
        compose.onNodeWithTag("$key:title", useUnmergedTree = true).assertTextEquals("Escalated to you")
        compose.onNodeWithTag("$key:required", useUnmergedTree = true).assertTextEquals("Nothing on the project branch reaches main until this check passes.")
        compose.onNodeWithTag("$key:handled-by", useUnmergedTree = true).assertTextEquals("The coordinator is fixing this in Fix the branch.")
        assertTrue("what has to happen next comes first", top("$key:required") < top("$key:handled-by"))
        assertTrue(top("$key:handled-by") < top("$key:RETURN_COORDINATOR"))
        // The owner's card leads with the way back to the coordinator, then the re-check, then the quiet Review.
        assertTrue(top("$key:RETURN_COORDINATOR") < top("$key:RERUN_CHECK")); assertTrue(top("$key:RERUN_CHECK") < top("$key:REVIEW"))
        compose.onNodeWithTag("$key:RERUN_CHECK").assertTextEquals(ExceptionCards.rerunCheck)
        compose.onNodeWithTag("$key:RERUN_CHECK:consequence", useUnmergedTree = true).assertTextEquals(ExceptionCards.promotionRetryConsequence)
        compose.onNodeWithTag("$key:RETURN_COORDINATOR:consequence", useUnmergedTree = true)
            .assertTextEquals("It goes back to the coordinator with a fresh escalation clock.")
        compose.onNodeWithTag("$key:REVIEW:consequence", useUnmergedTree = true).assertTextEquals("Open the current merge card.")
        compose.onNodeWithTag("$key:MARK_HANDLED:consequence", useUnmergedTree = true).assertTextEquals(ExceptionCards.markHandledConsequence)
        assertTrue("the ending comes last", top("$key:REVIEW") < top("$key:MARK_HANDLED"))
        assertTrue("the doors come before the facts", top("$key:MARK_HANDLED") < top("$key:fact:Check"))
        // The Check row: its command mono, its verdict red, its log hung under it and before the next fact.
        val text = compose.onNode(hasText("cd src/runner-go", substring = true), useUnmergedTree = true).fetchSemanticsNode().config[SemanticsProperties.Text].single()
        val mono = text.spanStyles.single { it.item.fontFamily == FontFamily.Monospace }
        assertEquals("cd src/runner-go && go test ./...", text.text.substring(mono.start, mono.end))
        val bad = text.spanStyles.single { it.item.color != Color.Unspecified }
        assertEquals("exit 1", text.text.substring(bad.start, bad.end))
        assertTrue(top("$key:fact:Check") < top("$key:log")); assertTrue(top("$key:log") < top("$key:fact:Branch"))
        compose.onNodeWithTag("$key:owner", useUnmergedTree = true).assertExists()
        compose.onNodeWithTag("$key:RERUN_CHECK").performClick()
        assertEquals(listOf(CardVerb.RERUN_CHECK), pressed.map { it.first })
        compose.onNodeWithTag("$key:REVIEW").performClick()
        assertEquals(listOf("pr1"), reviewed)
    }

    /** Board card-ui-polish ① (iOS `fixingBlock`/`quietRow`, web `ItemCard`): while a repair task is live the card wears the blue
     * Fixing tag, says "Being fixed in <task ↗>" once — the title opening the task — with "In progress · nothing for you to do unless it
     * fails." under it, in place of the server's sentence and the handled-by line, and every door is a quiet link with no line, in one
     * row with the owner's ending, under the facts. The Into row names the branch, not its ref. */
    @Test fun aLiveRepairIsOneLinkedLineAndQuietDoors() {
        val into = Wire.json.parseToJsonElement("""{"task":null,"targetRef":"refs/heads/main","targetSha":"928ed7e0000","files":[],"nothingLanded":true,
            "check":null,"branchUnchanged":false,"errorCode":null,"failure":null}""")
        show(card(row("INTEGRATION_CHECK_FAILED", listOf("ASK_COORDINATOR_AGAIN", "RETRY", "OPEN_TASK_SESSION"), reason = "CHAIN_LIMIT",
            requiredAction = "Nothing on the project branch reaches main until this check passes.", handledBy = listOf("Fix the branch"), facts = into)))
        compose.onNodeWithTag("$key:fixing-tag", useUnmergedTree = true).assertTextEquals(ExceptionCards.fixingTag)
        compose.onNodeWithTag("$key:being-fixed", useUnmergedTree = true).assertTextEquals("Being fixed in Fix the branch ↗")
        compose.onNodeWithTag("$key:nothing-for-you", useUnmergedTree = true).assertTextEquals(ExceptionCards.fixingNothingForYou)
        compose.onNodeWithTag("$key:required", useUnmergedTree = true).assertDoesNotExist()
        compose.onNodeWithTag("$key:handled-by", useUnmergedTree = true).assertDoesNotExist()
        compose.onAllNodes(hasTestTag("$key:RETRY_INTEGRATION:consequence") or hasTestTag("$key:RETURN_COORDINATOR:consequence")
            or hasTestTag("$key:MARK_HANDLED:consequence"), useUnmergedTree = true).assertCountEquals(0)
        listOf("RETURN_COORDINATOR", "RETRY_INTEGRATION", "OPEN_TASK_SESSION", "MARK_HANDLED").forEach {
            compose.onNode(hasTestTag("$key:$it") and hasAnyAncestor(hasTestTag("$key:quiet")), useUnmergedTree = true).assertExists()
        }
        assertTrue("the quiet row waits under the facts", top("$key:fact:Into") < top("$key:quiet"))
        compose.onNode(hasText("main at 928ed7e · nothing landed") and hasAnyAncestor(hasTestTag("$key:fact:Into")), useUnmergedTree = true).assertExists()
        compose.onNodeWithTag("$key:being-fixed", useUnmergedTree = true)
            .performFirstLinkClick({ (it.item as? androidx.compose.ui.text.LinkAnnotation.Clickable)?.tag == "orbit-task:01a0bb0b-b3fb-744c-b9a6-2fd68b4420f0" })
        compose.waitForIdle()
        assertEquals(listOf("orbit-task:01a0bb0b-b3fb-744c-b9a6-2fd68b4420f0"), opened)
        compose.onNodeWithTag("$key:RETRY_INTEGRATION").performClick()
        assertEquals(listOf(CardVerb.RETRY_INTEGRATION), pressed.map { it.first })
    }

    @Test fun reviewIsDrawnOnlyWhereTheMergeCardIs() {
        show(card(row("INTEGRATION_ERROR", listOf("ASK_COORDINATOR_AGAIN", "REVIEW"), promotionId = "pr1")), mergeCard = null)
        compose.onNodeWithTag("$key:RETURN_COORDINATOR").assertExists()
        compose.onNodeWithTag("$key:REVIEW").assertDoesNotExist()
        compose.onNodeWithTag("$key:REVIEW:consequence", useUnmergedTree = true).assertDoesNotExist()
    }

    /** X-E5 (§4.6, board v4 06): the heading is how long the runner has been silent, Abandon is the lead in its solid weight, Open
     * landing follows it, and both lines say what they do — J12's push verdict under Abandon. */
    @Test fun theXe5CardLeadsWithAbandonAndOpensItsLanding() {
        val lease = buildJsonObject { put("jobKind", "LAND_TASK"); put("progressProtocol", "v2"); put("pushReported", false)
            put("generation", 2); put("runner", "workstation-gpu"); put("phase", "REBASE"); put("claimGeneration", 1); put("round", 1)
            put("checkCount", 3); put("lastReportAt", "2026-09-19T18:35:00Z") }
        show(card(row("LANDING_LEASE_EXPIRED", listOf("ABANDON", "OPEN_LANDING"), taskId = "t1", sessionId = null, primaryAction = "ABANDON",
            landingSessionId = "L1", integrationJobId = "j-1", lease = lease, title = "A landing stopped reporting",
            requiredAction = "The runner stopped reporting; abandon this landing, or wait for the runner to come back.")))
        compose.onNodeWithTag("$key:heading", useUnmergedTree = true).assertTextEquals("Now yours — no report from the runner for 147m")
        compose.onNodeWithTag("$key:ABANDON").assertTextEquals("Abandon")
        compose.onNodeWithTag("$key:ABANDON:consequence", useUnmergedTree = true)
            .assertTextEquals("Ends this attempt. Nothing was pushed, and nothing is queued again.")
        compose.onNodeWithTag("$key:OPEN_LANDING").assertTextEquals("Open landing")
        compose.onNodeWithTag("$key:OPEN_LANDING:consequence", useUnmergedTree = true).assertTextEquals("Open the landing: every attempt, step by step.")
        assertTrue("Abandon leads", top("$key:ABANDON") < top("$key:OPEN_LANDING"))
        compose.onNodeWithTag("$key:OPEN_LANDING").performClick()
        assertEquals(listOf("orbit-session:L1"), opened)
        compose.onNodeWithTag("$key:ABANDON").performClick()
        assertEquals(listOf(CardVerb.ABANDON), pressed.map { it.first })
        // The lease block draws the claim, not the item's sentence; the footer says the wait alone.
        compose.onNodeWithTag("$key:fact:Landing", useUnmergedTree = true).assertExists()
        compose.onNodeWithTag("$key:owner", useUnmergedTree = true).assertExists()
        assertTrue("Mark as handled closes X-E5 too", compose.onAllNodesWithTag("$key:MARK_HANDLED", useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty())
    }

    /** An INTEGRATION_* card that names a landing draws Open landing at the END of its doors — a way to look, not the step it asks
     * for — and sends nothing when pressed. */
    @Test fun anIntegrationCardsOpenLandingComesLastAndOnlyLooks() {
        show(card(row("INTEGRATION_CHECK_FAILED", listOf("ASK_COORDINATOR_AGAIN", "OPEN_TASK_SESSION", "OPEN_LANDING"),
            promotionId = "pr1", landingSessionId = "L1", reason = "CHAIN_LIMIT", requiredAction = "Nothing reaches main until this check passes.")))
        compose.onNodeWithTag("$key:OPEN_LANDING").assertTextEquals("Open landing")
        assertTrue(top("$key:RETURN_COORDINATOR") < top("$key:OPEN_LANDING"))
        assertTrue(top("$key:OPEN_TASK_SESSION") < top("$key:OPEN_LANDING"))
        assertTrue("the doors come before the footer", top("$key:OPEN_LANDING") < top("$key:owner"))
        compose.onNodeWithTag("$key:OPEN_LANDING").performClick()
        assertEquals(listOf("orbit-session:L1"), opened)
        assertTrue("it sends nothing", pressed.isEmpty())
    }

    /** Board owner-exception-who-fixes ⑤: an escalated conflict is the "Who fixes it?" card — the coordinator row first with Ask again
     * and the chat link, then You with Fix it myself, then Details folded, then Already settled? — and its Cancel task still asks first. */
    @Test fun anEscalatedConflictIsTheWhoFixesItCard() {
        val files = buildJsonObject {
            putJsonObject("task") { put("id", "t1"); put("title", "Retry failed webhook deliveries") }
            put("targetRef", "refs/heads/project/35aK2xQm8LrT0vHcE1pZq"); put("targetSha", "9f3c2e1aa0b1")
            putJsonArray("files") { (1..9).forEach { add("src/f$it.ts") } }
        }
        show(card(row("INTEGRATION_CONFLICT", listOf("ASK_COORDINATOR_AGAIN", "OPEN_TASK_SESSION", "OPEN_LANDING", "CANCEL_TASK"),
            landingSessionId = "L1", facts = files, title = "Merge conflict: Retry failed webhook deliveries")))
        compose.onNodeWithTag("$key:heading", useUnmergedTree = true).assertTextEquals("Now yours — the coordinator didn’t get to it")
        compose.onNodeWithTag("$key:subline", useUnmergedTree = true).assertTextEquals("Merge conflict · Retry failed webhook deliveries")
        compose.onNodeWithTag("$key:required", useUnmergedTree = true).assertDoesNotExist()
        compose.onNodeWithTag("$key:owner", useUnmergedTree = true).assertDoesNotExist()
        compose.onNode(hasText("Chat about this")).assertDoesNotExist()
        assertTrue("the coordinator row leads", top("$key:who:coordinator") < top("$key:who:you"))
        assertTrue(top("$key:RETURN_COORDINATOR") < top("$key:OPEN_TASK_SESSION"))
        compose.onNodeWithTag("$key:OPEN_TASK_SESSION").assertTextEquals(ExceptionCards.fixItMyself)
        compose.onNodeWithTag("$key:OPEN_TASK_SESSION:consequence", useUnmergedTree = true)
            .assertTextEquals("Opens the task session. Fix the conflict there and push to the task branch.")
        compose.onNodeWithTag("$key:closes", useUnmergedTree = true).assertExists()
        assertTrue(top("$key:who") < top("$key:details")); assertTrue(top("$key:details") < top("$key:settled"))
        compose.onNodeWithTag("$key:MARK_HANDLED:consequence", useUnmergedTree = true).assertTextEquals(ExceptionCards.markHandledSettledConsequence)
        compose.onNodeWithTag("$key:CANCEL_TASK:consequence", useUnmergedTree = true).assertTextEquals(ExceptionCards.cancelTaskSettledConsequence)
        // Details, folded, then unfolded: five files and the rest counted, the landing a link.
        compose.onNodeWithTag("$key:details", useUnmergedTree = true).assertTextEquals("› Details · 9 files · Open landing")
        compose.onNodeWithTag("$key:fact:Files (9)", useUnmergedTree = true).assertDoesNotExist()
        compose.onNodeWithTag("$key:details").performClick()
        compose.onNodeWithTag("$key:fact:Files (9)", useUnmergedTree = true).assertExists()
        compose.onNode(hasText("and 4 more", substring = true), useUnmergedTree = true).assertExists()
        compose.onNodeWithTag("$key:OPEN_LANDING").performScrollTo().performClick()
        compose.onNodeWithTag("$key:OPEN_TASK_SESSION").performScrollTo().performClick()
        assertEquals(listOf("orbit-session:L1", "orbit-session:s9"), opened)
        compose.onNodeWithTag("$key:CANCEL_TASK").performScrollTo().performClick()
        assertTrue("cancelling asks first", pressed.isEmpty())
        compose.onNodeWithTag("confirm:CANCEL_TASK").performClick()
        assertEquals(CardVerb.CANCEL_TASK, pressed.single().first)
    }

    /** D4 = A: a hand-over puts You first, with Fix it myself in the leading weight and Ask again second. */
    @Test fun aHandOverLeadsWithYou() {
        show(card(row("INTEGRATION_CONFLICT", listOf("ASK_COORDINATOR_AGAIN", "OPEN_TASK_SESSION", "CANCEL_TASK"), reason = "HANDED_OVER")))
        compose.onNodeWithTag("$key:heading", useUnmergedTree = true).assertTextEquals("Now yours — the coordinator handed it over")
        assertTrue(top("$key:who:you") < top("$key:who:coordinator"))
        compose.onNodeWithTag("$key:who:status", useUnmergedTree = true).assertTextEquals("It handed this to you on purpose.")
        compose.onNodeWithTag("$key:RETURN_COORDINATOR").performScrollTo().performClick()
        assertEquals(CardVerb.RETURN_COORDINATOR, pressed.single().first)
    }

    /** The coordinator's hand-over note, under its caption in the coordinator row: translated with its own flip while a usable translation
     * exists, as written otherwise, and nothing at all when the item carries no note. */
    @Test fun aHandOverDrawsTheCoordinatorsNoteUnderItsCaptionTranslated() {
        fun handed(note: String?, translation: JsonElement = JsonNull) = card(JsonObject(
            row("INTEGRATION_CONFLICT", listOf("ASK_COORDINATOR_AGAIN", "OPEN_TASK_SESSION"), reason = "HANDED_OVER")
                + mapOf("handoverNote" to JsonPrimitive(note), "translation" to translation)))
        fun showIn(card: InteractionCard, language: String?) {
            val account = AccountTranslation(enabled = language != null, available = true, language = language ?: "ja")
            compose.runOnUiThread { compose.activity.setContent { MaterialTheme { CompositionLocalProvider(LocalTranslation provides account) {
                Column(Modifier.verticalScroll(rememberScrollState())) {
                    ExceptionCard(card, fresh = true, result = CardActionState(), mergeCard = null, open = { opened += it }, discuss = null,
                        review = { reviewed += it }, main = "main") { verb, input -> pressed += verb to input }
                }
            } } } }
            compose.waitForIdle()
        }
        val note = "Your retry policy"
        val translated = buildJsonObject { put("lang", "ja"); put("handoverNote", "再試行ポリシー") }
        showIn(handed(note, translated), "ja")
        compose.onNodeWithTag("$key:who:handover:caption", useUnmergedTree = true).assertTextEquals(ExceptionCards.handoverNoteCaption)
        compose.onNodeWithTag("$key:who:handover:note", useUnmergedTree = true).assertTextEquals("再試行ポリシー")
        compose.onNodeWithTag("$key:who:status", useUnmergedTree = true).assertTextEquals("It handed this to you on purpose.")
        assertTrue("the note is under the status sentence", top("$key:who:status") < top("$key:who:handover:caption"))
        assertTrue(top("$key:who:handover:caption") < top("$key:who:handover:note"))
        compose.onNodeWithText(TranslationCopy.SHOW_ORIGINAL, useUnmergedTree = true).performScrollTo().performClick()
        compose.onNodeWithTag("$key:who:handover:note", useUnmergedTree = true).assertTextEquals(note)
        compose.onNodeWithText(TranslationCopy.SHOW_TRANSLATION, useUnmergedTree = true).assertExists()

        showIn(handed(note), "ja")
        compose.onNodeWithTag("$key:who:handover:caption", useUnmergedTree = true).assertTextEquals(ExceptionCards.handoverNoteCaption)
        compose.onNodeWithTag("$key:who:handover:note", useUnmergedTree = true).assertTextEquals(note)
        compose.onNodeWithText(TranslationCopy.SHOW_ORIGINAL, useUnmergedTree = true).assertDoesNotExist()
        showIn(handed(note, translated), null)
        compose.onNodeWithTag("$key:who:handover:note", useUnmergedTree = true).assertTextEquals(note)
        compose.onNodeWithText(TranslationCopy.SHOW_ORIGINAL, useUnmergedTree = true).assertDoesNotExist()

        showIn(handed(null, translated), "ja")
        compose.onNodeWithTag("$key:who:handover", useUnmergedTree = true).assertDoesNotExist()
        compose.onNodeWithText(ExceptionCards.handoverNoteCaption, useUnmergedTree = true).assertDoesNotExist()
    }

    @Test fun aFailedTaskRunsAgainWithItsOwnPressAndCancelAsksFirst() {
        show(card(row("TASK_FAILED", listOf("ASK_COORDINATOR_AGAIN", "OPEN_TASK_SESSION", "RETRY", "CANCEL_TASK"), reason = "DEFAULT")))
        compose.onNodeWithTag("$key:RETRY_TASK:consequence", useUnmergedTree = true).assertTextEquals(ExceptionCards.taskRunAgainConsequence)
        compose.onNodeWithTag("$key:RETRY_TASK").assertTextEquals("Retry").performClick()
        val (verb, input) = pressed.single()
        assertEquals(CardVerb.RETRY_TASK, verb); assertFalse(input.triggerId.isNullOrBlank())
        compose.onNodeWithTag("$key:OPEN_TASK_SESSION").performClick()
        assertEquals(listOf("orbit-session:s9"), opened)
        compose.onNodeWithTag("$key:CANCEL_TASK").performClick()
        assertEquals("cancelling asks first", 1, pressed.size)
        compose.onNodeWithTag("confirm:CANCEL_TASK").performClick()
        assertEquals(CardVerb.CANCEL_TASK, pressed.last().first)
    }

    @Test fun theOwnersEndingKeepsItsDraftAndWaitsForAReason() {
        show(card(row("INTEGRATION_CONFLICT", listOf("ASK_COORDINATOR_AGAIN", "OPEN_TASK_SESSION"))))
        compose.onNodeWithTag("$key:MARK_HANDLED").performScrollTo().performClick()
        compose.onNodeWithText(ExceptionCards.markHandledTitle).assertExists()
        compose.onNodeWithText(ExceptionCards.markHandledBody).assertExists()
        compose.onNodeWithTag("$key:mark-handled-confirm").assertIsNotEnabled()
        compose.onNodeWithTag("$key:reason").performTextInput("landed by hand")
        compose.onNodeWithTag("$key:mark-handled-confirm").assertIsEnabled()
        compose.onNodeWithTag("$key:mark-handled-back").performScrollTo().performClick()
        compose.onNodeWithTag("$key:mark-handled-panel").assertDoesNotExist()
        compose.onNodeWithTag("$key:MARK_HANDLED").performScrollTo().performClick()
        compose.onNodeWithTag("$key:reason").assertTextContains("landed by hand")
        compose.onNodeWithTag("$key:reason").performTextReplacement("x".repeat(2_100))
        compose.waitForIdle()
        val held = compose.onNodeWithTag("$key:reason").fetchSemanticsNode().config[SemanticsProperties.EditableText].text
        assertEquals("the field stops where the door does", 2_000, held.length)
        compose.onNodeWithTag("$key:mark-handled-confirm").performScrollTo().performClick()
        assertEquals(CardVerb.MARK_HANDLED, pressed.single().first)
        assertEquals(2_000, pressed.single().second.text.length)
    }

    @Test fun aPauseIsItsOwnCardWithOneDoor() {
        show(card(row("FUSE_PAUSED", listOf("RESUME"), taskId = null, sessionId = null, fuseEpisodeId = "ep1", reason = "DEFAULT")))
        compose.onNodeWithTag("$key:title", useUnmergedTree = true).assertTextEquals("Paused")
        compose.onNodeWithTag("$key:RESUME:consequence", useUnmergedTree = true).assertTextEquals("The coordinator resumes and held work can continue.")
        compose.onNodeWithTag("$key:MARK_HANDLED").assertDoesNotExist()
        compose.onNodeWithTag("$key:RESUME").performClick()
        assertEquals(listOf(CardVerb.RESUME), pressed.map { it.first })
    }

    /** §10.7: work that reached main without the owner's confirmation is theirs from birth — its own kind word heads the card, its
     * §10.7 title is the first line, Accept leads and sends the owner's door, and nothing closes it by hand. */
    @Test fun workThatLandedWithoutYourConfirmationIsAcceptedFromItsCard() {
        show(card(row("LANDED_WITHOUT_CONFIRMATION", listOf("ACCEPT", "OPEN_TASK_SESSION"), reason = "DEFAULT", primaryAction = "ACCEPT",
            title = "Reached main without your confirmation: Fix the login redirect",
            requiredAction = "This work reached main without your confirmation — accept it, or use Chat about this to have the coordinator file a task that reverts it.")))
        compose.onNodeWithTag("$key:title", useUnmergedTree = true).assertTextEquals("Landed without your confirmation")
        compose.onNodeWithTag("$key:heading", useUnmergedTree = true).assertTextEquals("Reached main without your confirmation: Fix the login redirect")
        compose.onNodeWithTag("$key:ACCEPT").assertTextEquals("Accept")
        compose.onNodeWithTag("$key:ACCEPT:consequence", useUnmergedTree = true).assertTextEquals("You accept the work as it landed, and this item closes.")
        assertTrue("Accept leads", top("$key:ACCEPT") < top("$key:OPEN_TASK_SESSION"))
        compose.onNodeWithTag("$key:MARK_HANDLED").assertDoesNotExist()
        compose.onNodeWithTag("$key:handling").assertDoesNotExist()
        compose.onNodeWithTag("$key:ACCEPT").performClick()
        assertEquals(listOf(CardVerb.ACCEPT), pressed.map { it.first })
    }

    /** §10.7's work not seen on its line, handed to the owner while the observation it asked for runs: the escalation heads the card
     * with the §10.7 title under it, the handling line names the project's main branch with the reason given, and Observe again — a
     * quiet door beside the way back to the coordinator — asks for its reason in place and sends nothing until it has one. */
    @Test fun workNotSeenOnTheLineIsLookedAtAgainWithAReason() {
        val unobserved = buildJsonObject {
            row("LANDING_UNOBSERVED", listOf("ASK_COORDINATOR_AGAIN", "OPEN_TASK_SESSION", "OBSERVE", "CANCEL_TASK"), reason = "HANDED_OVER",
                primaryAction = "ASK_COORDINATOR_AGAIN", title = "Not on main yet: Draw the observation cards").forEach { (k, v) -> put(k, v) }
            putJsonObject("handling") { put("sessionId", JsonNull); put("userId", "u1"); put("reason", "I pushed the rebased commit to main by hand")
                put("startedAt", java.time.Instant.now().minusSeconds(150).toString()); put("jobId", "j1"); put("jobKind", "OBSERVE_LANDING")
                put("generation", 2); put("state", "RUNNING") }
        }
        show(card(unobserved), main = "master")
        compose.onNodeWithTag("$key:title", useUnmergedTree = true).assertTextEquals("Escalated to you")
        compose.onNodeWithTag("$key:heading", useUnmergedTree = true).assertTextEquals("Now yours — the coordinator handed it over")
        compose.onNode(hasText("Not on main yet: Draw the observation cards") and hasAnyAncestor(hasTestTag("$key:facts")), useUnmergedTree = true).assertExists()
        compose.onNode(hasText("Observing master… — running · asked 2m ago") and hasAnyAncestor(hasTestTag("$key:fact:Handling")), useUnmergedTree = true).assertExists()
        compose.onNode(hasText("I pushed the rebased commit to main by hand") and hasAnyAncestor(hasTestTag("$key:fact:Reason")), useUnmergedTree = true).assertExists()
        assertTrue("the handling comes after the facts", top("$key:facts") < top("$key:handling"))
        compose.onNodeWithTag("$key:OBSERVE").assertTextEquals("Observe again")
        compose.onNodeWithTag("$key:OBSERVE:consequence", useUnmergedTree = true).assertTextEquals("An observation of the line is queued with your reason.")
        assertTrue("the way back to the coordinator leads", top("$key:RETURN_COORDINATOR") < top("$key:OBSERVE"))
        compose.onNodeWithTag("$key:MARK_HANDLED").assertDoesNotExist()
        compose.onNodeWithTag("$key:OBSERVE").performClick()
        assertTrue("the press asks first", pressed.isEmpty())
        compose.onNodeWithText(ExceptionCards.observeTitle).assertExists()
        compose.onNodeWithText(ExceptionCards.observeBody).assertExists()
        compose.onNodeWithTag("$key:observe-confirm").performScrollTo().assertIsNotEnabled()
        compose.onNodeWithTag("$key:observe-reason").performScrollTo().performTextInput("The runner can reach the repository again")
        compose.onNodeWithTag("$key:observe-confirm").performScrollTo().assertIsEnabled().assertTextEquals("Observe again").performClick()
        assertEquals(CardVerb.OBSERVE to "The runner can reach the repository again", pressed.single().let { it.first to it.second.text })
    }

    @Test fun aCardWhoseItemWentSaysSoAndOffersNothing() {
        show(SessionCardsModel.stale(card(row("TASK_FAILED", listOf("RETRY")))))
        compose.onNodeWithTag("$key:gone", useUnmergedTree = true).assertTextEquals(ExceptionCards.gone)
        compose.onNodeWithTag("$key:RETRY_TASK").assertDoesNotExist()
        compose.onNodeWithTag("$key:next").assertDoesNotExist()
    }
}
