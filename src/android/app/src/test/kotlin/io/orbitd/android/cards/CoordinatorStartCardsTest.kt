package io.orbitd.android.cards

import android.content.ComponentName
import androidx.activity.ComponentActivity
import androidx.compose.foundation.layout.Column
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import io.orbitd.android.TestOrbitApplication
import io.orbitd.android.core.cards.*
import io.orbitd.android.core.realtime.RunEvent
import io.orbitd.android.ui.OrbitTheme
import java.io.File
import java.time.Instant
import java.time.ZoneId
import java.util.Locale
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.ExternalResource
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

/**
 * The three cards a coordinator conversation draws after a project starts (board-4, project criterion 7), from the fixtures web and
 * OrbitKit are proved against: criteria-decision-receipt.fixture.json (web `CriteriaDecisionCard.receiptFixture.test.tsx`, OrbitKit
 * `CriteriaDecisionReceiptFixtureTests`) and coordinator-start-cards.fixture.json (web `CoordinatorStartCards.fixture.test.tsx`). Each
 * case's words are asserted off the logic, then off the drawn card.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = TestOrbitApplication::class, qualifiers = "w411dp-h891dp")
class CoordinatorStartCardsTest {
    @get:Rule(order = 0) val host = object : ExternalResource() {
        override fun before() {
            val app = RuntimeEnvironment.getApplication()
            shadowOf(app.packageManager).addActivityIfNotPresent(ComponentName(app, ComponentActivity::class.java))
        }
    }
    @get:Rule(order = 1) val compose = createComposeRule()

    private fun shared(name: String): JsonObject {
        val root = generateSequence(File(System.getProperty("user.dir"))) { it.parentFile }.first { File(it, "src/shared/src/$name").isFile }
        return Json.parseToJsonElement(File(root, "src/shared/src/$name").readText()).jsonObject
    }
    private val receipts = shared("criteria-decision-receipt.fixture.json")
    private val start = shared("coordinator-start-cards.fixture.json")
    private val clock = start.obj("clock")!!
    private val now = Instant.parse(clock.text("now"))
    private val zone = ZoneId.of(clock.text("timeZone"))
    private val locale = Locale.forLanguageTag(clock.text("locale")!!)

    private fun JsonObject.texts(key: String) = strings(key)
    private fun JsonObject.textOrNull(key: String) = (get(key) as? JsonPrimitive)?.contentOrNull

    private fun show(content: @androidx.compose.runtime.Composable () -> Unit) {
        compose.setContent { OrbitTheme(darkTheme = false) { Column { content() } } }
        compose.waitForIdle()
    }
    /** A word drawn anywhere under [tag] (a tagged Column has no text of its own). */
    private fun shows(tag: String, words: String, substring: Boolean = false) =
        compose.onAllNodes(hasText(words, substring = substring) and hasAnyAncestor(hasTestTag(tag)), useUnmergedTree = true)
            .fetchSemanticsNodes().isNotEmpty()

    private fun receiptCard(settled: JsonObject) = InteractionCard("receipt:CRITERIA_CHANGE:${settled.text("intentId")}:",
        CardFamily.CRITERIA_CHANGE, CriteriaReceipt.heading, settled, "s", objectId = settled.text("intentId")!!, binding = "", status = "Recorded")

    @Test fun theCriteriaReceiptSaysWhatWebAndIosSayForEachSharedCase() {
        receipts.objects("cases").forEach { case ->
            val settled = case.obj("settled")!!
            val expected = case.obj("expected")!!
            val name = case.text("name")
            assertTrue(name, expected.flag("warningTone"))
            assertEquals(name, CriteriaReceipt.Tone.WARNING, CriteriaReceipt.tone)
            assertEquals(name, CriteriaReceipt.Tone.SUCCESS, CriteriaReceipt.verdictTone)
            val fold = CriteriaReceipt.fold(settled)!!
            assertEquals(name, expected.text("summary"), fold.summary)
            assertEquals(name, expected.textOrNull("legend"), fold.legend)
            assertEquals(name, expected.objects("rows").map { Triple(it.number("ordinal"), it.text("text"), it.text("badge")) },
                fold.rows.map { Triple(it.ordinal, it.text, it.badge) })
            val unchanged = expected.obj("unchanged")
            assertEquals(name, unchanged?.text("line"), fold.unchangedLine)
            assertEquals(name, unchanged?.objects("rows").orEmpty().map { it.number("ordinal") to it.text("text") }, fold.unchanged.map { it.ordinal to it.text })
            assertEquals(name, expected.textOrNull("note"), fold.note)
            val verdict = if (settled.text("decision") == "APPROVE") "Approved" else "Refused"
            assertEquals(name, "✓ $verdict by you at 11/19 23:45", CriteriaReceipt.line(settled, now, zone, locale))
        }
    }

    @Test fun theCriteriaReceiptIsDrawnOrangeWithItsFoldClosedThenOpen() {
        val case = receipts.objects("cases").first()
        val card = receiptCard(case.obj("settled")!!)
        val expected = case.obj("expected")!!
        show { CriteriaReceiptCard(card) }
        assertTrue(shows(card.key, "Decision recorded"))
        assertTrue(shows(card.key, "✓ Approved by you at ", substring = true))
        assertTrue(shows(card.key, expected.text("summary")!!))
        assertTrue(shows(card.key, "From Orbit"))
        assertFalse("closed by default", shows(card.key, "reworded by this proposal"))
        compose.onNodeWithTag("${card.key}:fold", useUnmergedTree = true).performClick()
        compose.waitForIdle()
        assertTrue(shows(card.key, expected.text("legend")!!))
        assertTrue(shows(card.key, "2. Every migration is replayed on a loaded databasewhen someone asks"))
        assertTrue(shows(card.key, "reworded by this proposal"))
        assertTrue(shows(card.key, "4. The receipt folds out what it approved"))
        assertTrue(shows(card.key, "new in this proposal"))
        assertTrue(shows(card.key, "2 criteria are unchanged by this proposal"))
    }

    @Test fun theStartReceiptSaysWhatWebSaysForEachSharedCase() {
        start.objects("startReceipts").forEach { case ->
            val confirmation = case.obj("confirmation")!!
            val expected = case.obj("expected")!!
            val name = case.text("name")
            assertEquals(name, expected.text("heading"), StartReceipt.heading)
            assertEquals(name, expected.text("line"), StartReceipt.line(confirmation))
            val settings = StartReceipt.startedSettings(confirmation)
            assertEquals(name, expected.textOrNull("settings"), settings?.let { RunSettingsSummary.line(it, StartReceipt.startedDiffers(confirmation)) })
            assertEquals(name, expected.texts("differs"),
                settings?.let { s -> RunSettingsSummary.parts(s, StartReceipt.startedDiffers(confirmation)).filter { it.differs }.map { it.text } }.orEmpty())
            assertEquals(name, expected.text("stamp"), StartReceipt.stamp(confirmation, now, zone, locale))
            val fold = StartReceipt.fold(confirmation)!!
            assertEquals(name, expected.text("foldLabel"), fold.openLabel)
            assertEquals(name, expected.text("seal"), fold.seal)
        }
    }

    @Test fun theStartReceiptIsDrawnWithItsSettingsStampAndFold() {
        val case = start.objects("startReceipts").first()
        val confirmation = case.obj("confirmation")!!
        val expected = case.obj("expected")!!
        val card = InteractionCard("receipt:ACCEPTANCE:p:${confirmation.text("confirmedAt")}", CardFamily.ACCEPTANCE, StartReceipt.heading,
            confirmation, "s", objectId = "p", binding = "", status = "Recorded")
        show { StartReceiptCard(card) }
        listOf("Decision recorded", expected.text("line")!!, expected.text("foldLabel")!!, "From Orbit").forEach { assertTrue(it, shows(card.key, it)) }
        compose.onNodeWithTag("${card.key}:settings", useUnmergedTree = true).assertTextEquals(expected.text("settings")!!)
        // The changed setting is said aloud for a reader who cannot see the bold.
        compose.onNodeWithTag("${card.key}:settings", useUnmergedTree = true)
            .assert(SemanticsMatcher.expectValue(androidx.compose.ui.semantics.SemanticsProperties.ContentDescription,
                listOf("project/34yca… · Automatic on · 3 tasks at a time (Not what the coordinator suggested) · merge check set")))
        compose.onNodeWithTag("${card.key}:stamp", useUnmergedTree = true).assertTextContains("by you at ", substring = true)
        compose.onNodeWithTag("${card.key}:receipt-toggle", useUnmergedTree = true).performClick()
        compose.waitForIdle()
        assertTrue(shows("${card.key}:receipt-fold", "1. The iOS criteria receipt is orange"))
        assertTrue(shows("${card.key}:receipt-fold", expected.text("seal")!!))
    }

    private fun startedEvent(payload: JsonObject, seq: Long = 41) = RunEvent("user", seq, JsonObject(payload + ("text" to JsonPrimitive("From Orbit · project started\n\nTold words."))),
        ts = Instant.now().minusSeconds(3_600).toString())

    @Test fun projectStartedSaysWhatWebSaysForEachSharedCase() {
        start.objects("projectStarted").forEach { case ->
            val card = ProjectStarted.parse(case.obj("payload")!!.obj("projectStarted"))!!
            val expected = case.obj("expected")!!
            val name = case.text("name")
            assertEquals(name, expected.text("label"), ProjectStartedCopy.label(card.by))
            assertEquals(name, expected.text("kind"), ProjectStartedCopy.kind(card.by))
            assertEquals(name, expected.text("title"), card.projectTitle)
            assertEquals(name, expected.textOrNull("settings"), card.settings?.let { RunSettingsSummary.line(it, card.differsFromRequest) })
            assertEquals(name, expected.text("lead"), ProjectStartedCopy.lead(card))
            assertEquals(name, expected.texts("tasks"), card.held.take(ProjectStartedCopy.tasksShown).map { it.title })
            assertEquals(name, expected.textOrNull("toggle"), ProjectStartedCopy.tasksToggle(card, expanded = false))
            assertEquals(name, expected.textOrNull("more"), ProjectStartedCopy.unlisted(card).takeIf { it > 0 }?.let(ProjectStartedCopy::moreInProject))
            assertEquals(name, expected.text("meta"), ProjectStartedCopy.meta(card))
            assertEquals(name, expected.text("told"), ProjectStartedCopy.told)
        }
        assertNull("not a card", ProjectStarted.parse(buildJsonObject { put("by", "SOMEONE"); put("projectId", "p"); put("projectTitle", "t") }))
    }

    @Test fun projectStartedIsItsOwnCardInTheConversationWithItsTasksAndWhatTheCoordinatorWasTold() {
        // One composition, each case drawn in turn: a rule sets its content once.
        val opened = mutableListOf<String>()
        var drawn by androidx.compose.runtime.mutableStateOf<Pair<InteractionCard, RunEvent>?>(null)
        show { drawn?.let { (card, event) -> androidx.compose.runtime.key(card.key) { TranscriptCardView(card, { opened += it }, event) } } }
        start.objects("projectStarted").forEachIndexed { index, case ->
            val event = startedEvent(case.obj("payload")!!, 41L + index)
            val card = transcriptCards(event).single { it.key.endsWith(":projectStarted") }
            assertTrue("drawn as Orbit's turn, the row is the card alone", isOrbitTurnCard(card))
            val expected = case.obj("expected")!!
            drawn = card to event
            compose.waitForIdle()
            val tag = "turn-project-started"
            (listOf("label", "kind", "title", "lead", "told").map { expected.text(it)!! } + expected.texts("tasks")).forEach {
                assertTrue("${case.text("name")}: $it", shows(tag, it))
            }
            expected.textOrNull("settings")?.let { compose.onNodeWithTag("$tag:settings", useUnmergedTree = true).assertTextEquals(it) }
            compose.onNodeWithTag("$tag:meta", useUnmergedTree = true).assertTextEquals("${expected.text("meta")} · 1h ago")
            assertFalse("the old generic card is gone", shows(tag, "Task and project details are not connected yet."))
            expected.textOrNull("toggle")?.let { toggle ->
                assertFalse(shows(tag, expected.text("more")!!))
                compose.onNode(hasText(toggle) and hasAnyAncestor(hasTestTag(tag)), useUnmergedTree = true).performClick()
                compose.waitForIdle()
                assertTrue(shows(tag, "Fifth"))
                assertTrue(shows(tag, "Show fewer"))
                compose.onNode(hasText(expected.text("more")!!) and hasAnyAncestor(hasTestTag(tag)), useUnmergedTree = true).performClick()
                assertEquals("orbit-project:34ycaQ1bT0kE7vLmN3pR5", opened.last())
            }
            expected.texts("tasks").firstOrNull()?.let { first ->
                compose.onNode(hasText(first) and hasAnyAncestor(hasTestTag(tag)), useUnmergedTree = true).performClick()
                assertTrue(opened.any { it.startsWith("orbit-task:34ycbR2cU1lF8wMnO4qS") })
            }
            assertFalse("folded until asked", shows(tag, "Told words."))
            compose.onNodeWithTag("$tag:told", useUnmergedTree = true).performClick()
            compose.waitForIdle()
            compose.onNodeWithTag("$tag:words", useUnmergedTree = true).assertTextContains("Told words.", substring = true)
        }
    }

    /** A started project's conversation: the receipt the start left, not the dimmed "When is this project done?" preview. */
    @Test fun aConfirmedProjectDrawsTheStartReceiptAndNotTheDimmedPreview() {
        val confirmation = start.objects("startReceipts").first().obj("confirmation")!!
        val standing = mapOf(
            "project" to buildJsonObject {
                put("id", "p1"); put("title", "Coordinator handoff v2"); put("startedAt", "2026-11-16T15:45:31.000Z")
                putJsonArray("acceptanceCriteriaItems") { addJsonObject { put("ordinal", 1); put("text", "x") } }
            },
            "acceptanceConfirmation" to buildJsonObject {
                put("state", "CONFIRMED"); put("confirmed", true)
                putJsonObject("currentVersion") { put("digest", confirmation.text("criteriaDigest")) }
                put("confirmation", confirmation)
            },
            "criteriaDecisions" to buildJsonObject { putJsonArray("pending") {}; put("settled", JsonArray(listOf(receipts.objects("cases").first().obj("settled")!!))) },
        )
        val cards = CardCatalog.project("s1", "p1", standing)
        assertNull("no question card once confirmed", cards.firstOrNull { it.key.startsWith("acceptance:") })
        val receipt = cards.single { it.family == CardFamily.ACCEPTANCE }
        assertTrue(receipt.key.startsWith("receipt:"))
        assertNull("a receipt is drawn whole, never as a preview", CardPreviews.preview(receipt))
        assertEquals("You started the project on 5 criteria", StartReceipt.line(receipt.source))
        val criteria = cards.single { it.family == CardFamily.CRITERIA_CHANGE }
        assertTrue(criteria.key.startsWith("receipt:"))
        assertNull(CardPreviews.preview(criteria))
        // Still asking (the criteria moved since): the question and the old receipt, both.
        val stale = standing + ("acceptanceConfirmation" to JsonObject(standing["acceptanceConfirmation"]!!.jsonObject + ("state" to JsonPrimitive("STALE"))))
        val asked = CardCatalog.project("s1", "p1", stale)
        assertNotNull(asked.firstOrNull { it.key.startsWith("acceptance:") })
        assertNotNull(asked.firstOrNull { it.key.startsWith("receipt:ACCEPTANCE") })
        // A conversation opened after the start draws no receipt older than itself (`CoordinatorCleanStart`).
        assertFalse(CoordinatorCleanStart.drawsCard("2026-11-17T00:00:00Z", receipt))
        assertTrue(CoordinatorCleanStart.drawsCard("2026-11-16T00:00:00Z", receipt))
    }
}
