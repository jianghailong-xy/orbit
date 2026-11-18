package io.orbitd.android.cards

import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.unit.dp
import io.orbitd.android.MainActivity
import io.orbitd.android.TestOrbitApplication
import io.orbitd.android.core.cards.*
import io.orbitd.android.core.realtime.SessionSnapshot
import io.orbitd.android.core.translation.Translation
import io.orbitd.android.projects.CoordinatorStartCard
import io.orbitd.android.projects.CrossingBatch
import io.orbitd.android.projects.ProjectDone
import io.orbitd.android.projects.ProjectDoneCard
import io.orbitd.android.translation.TranslationCopy
import io.orbitd.android.ui.OrbitTheme
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.time.Instant

/**
 * The owner cards outside a session drawn in the owner's language (Settings › Translation, board 04-owner-cards.html), by the
 * production composables: the coordinator's question, the start and done requests, an owner confirmation, completion evidence, a
 * criteria change, a crossing and a question's record. Each draws its translation with one "Translated · Show original" foot that
 * flips the whole card to the agent's words and back; with no translation, or a failed one, the card as it came and no foot; and an
 * answer the server could not translate (422 TRANSLATION_FAILED) says "Couldn't translate, so it wasn't sent" with Retry and Send as
 * written, which sends the words again with `sendAsWritten: true`. The owner request card's own test is OwnerRequestTranslationTest.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = TestOrbitApplication::class, qualifiers = "w411dp-h2000dp")
class OwnerCardTranslationViewsTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()
    private fun j(text: String) = Json.parseToJsonElement(text).jsonObject
    private val project = "p1"
    private val seal = "a".repeat(64)

    /** A page that scrolls and weights its own body (a review), in a fixed frame rather than in a scrolling column. */
    private fun showPage(content: @Composable () -> Unit) {
        compose.runOnUiThread { compose.activity.setContent { OrbitTheme(darkTheme = false) {
            Surface { androidx.compose.foundation.layout.Box(Modifier.fillMaxSize()) { content() } }
        } } }
        compose.waitForIdle()
    }
    private fun show(content: @Composable () -> Unit) {
        compose.runOnUiThread { compose.activity.setContent { OrbitTheme(darkTheme = false) {
            Surface { Column(Modifier.verticalScroll(rememberScrollState()).padding(16.dp)) { content() } }
        } } }
        compose.waitForIdle()
    }
    private fun has(text: String) = compose.onAllNodesWithText(text, substring = true, useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty()
    private fun press(text: String) { compose.onNodeWithText(text, useUnmergedTree = true).performScrollTo().performClick(); compose.waitForIdle() }

    /** Drawn translated with its foot, then flipped whole to the original and back. */
    private fun flips(translated: List<String>, original: List<String>) {
        translated.forEach { assertTrue("shows $it", has(it)) }
        original.forEach { assertFalse("hides $it", has(it)) }
        assertTrue(has(TranslationCopy.TRANSLATED))
        press(TranslationCopy.SHOW_ORIGINAL)
        original.forEach { assertTrue("shows $it", has(it)) }
        translated.forEach { assertFalse("hides $it", has(it)) }
        assertTrue(has(TranslationCopy.ORIGINAL))
        press(TranslationCopy.SHOW_TRANSLATION)
        translated.forEach { assertTrue("shows $it again", has(it)) }
    }
    private fun noFoot() {
        assertFalse(has(TranslationCopy.SHOW_ORIGINAL))
        compose.onAllNodesWithTag("translation-foot", useUnmergedTree = true).assertCountEquals(0)
    }

    /** A business card whose press is answered 422 TRANSLATION_FAILED the first time, and recorded once sent as written. */
    private fun refusedThenSentAsWritten(card: InteractionCard, verb: CardVerb, typed: String, opensNote: Boolean = false) {
        val pressed = mutableListOf<CardInput>()
        var result by mutableStateOf(CardActionState())
        show { BusinessCard(card, true, result, open = {}, submit = { _, input ->
            pressed += input
            result = if (input.sendAsWritten) CardActionState(message = "Recorded", settled = true)
                else CardActionState(message = "The words could not be translated.", response = buildJsonObject { put("code", Translation.FAILED_CODE) })
        }) }
        // A note-taking door opens its note on the first press.
        if (opensNote) { compose.onNodeWithTag("${card.key}:${verb.name}").performScrollTo().performClick(); compose.waitForIdle() }
        compose.onAllNodes(hasSetTextAction()).onLast().performTextInput(typed)
        compose.onNodeWithTag("${card.key}:${verb.name}").performScrollTo().performClick()
        compose.waitForIdle()
        compose.onNodeWithTag("card-translation-failed").assertExists()
        assertTrue(has(TranslationCopy.SEND_FAILED))
        press(TranslationCopy.RETRY)
        assertEquals(2, pressed.size)
        assertFalse(pressed[1].sendAsWritten)
        press(TranslationCopy.SEND_AS_WRITTEN)
        assertEquals(3, pressed.size)
        assertTrue(pressed[2].sendAsWritten)
        assertEquals(typed, pressed[2].text.trim())
        val body = Json.parseToJsonElement(CardRequests.build(card, verb, pressed[2]).body!!.decodeToString()).jsonObject
        assertEquals("the door is told to deliver it untranslated", JsonPrimitive(true), body["sendAsWritten"])
        assertNull(Json.parseToJsonElement(CardRequests.build(card, verb, pressed[0]).body!!.decodeToString()).jsonObject["sendAsWritten"])
    }

    // The coordinator's question.

    private fun questionCard(translation: String?): InteractionCard {
        val row = j("""{"itemId":"q1","kind":"COORDINATOR_QUESTION","title":"The coordinator has a question","assignee":"OWNER","actions":["ANSWER"],
            "waitingSince":"2026-11-18T01:00:00.000Z","question":{"question":"Should the export keep the old columns?",
            "options":[{"label":"Keep the old columns","description":"Both shapes for one release."},{"label":"Update the sheet"}],"recommendedOption":0,
            "ifUnanswered":"I keep both shapes."}""" + (translation?.let { ""","translation":$it}""" } ?: "}"))
        val reads = mapOf<String, JsonElement>("project" to j("""{"id":"$project","title":"Export"}"""),
            "openItems" to buildJsonObject { putJsonArray("needsYou") { add(row) }; putJsonArray("withCoordinator") {} })
        return CardCatalog.project("s1", project, reads).single { it.family == CardFamily.OWNER_QUESTION }
    }
    private val questionJa = """{"lang":"zh-Hans","question":"新导出要保留旧列吗？","options":[{"label":"保留旧列","description":"一个版本内两种格式。"},{"label":"改财务表"}],
        "ifUnanswered":"我两种都留。"}"""

    @Test fun aCoordinatorQuestionIsDrawnTranslatedAndFlipsWhole() {
        show { BusinessCard(questionCard(questionJa), true, open = {}, submit = { _, _ -> }) }
        flips(listOf("新导出要保留旧列吗？", "保留旧列", "一个版本内两种格式。", "改财务表", "我两种都留。"),
            listOf("Should the export keep the old columns?", "Keep the old columns", "Both shapes for one release.", "Update the sheet", "I keep both shapes."))
    }

    @Test fun aCoordinatorQuestionWithNoOrAFailedTranslationIsDrawnAsWritten() {
        show { BusinessCard(questionCard(null), true, open = {}, submit = { _, _ -> }) }
        assertTrue(has("Should the export keep the old columns?")); noFoot()
        show { BusinessCard(questionCard("""{"lang":"zh-Hans","failed":true}"""), true, open = {}, submit = { _, _ -> }) }
        assertTrue(has("Should the export keep the old columns?") && has("Keep the old columns")); noFoot()
    }

    @Test fun aCoordinatorQuestionAnswerRefusedUntranslatedOffersRetryAndSendAsWritten() {
        val card = questionCard(questionJa)
        refusedThenSentAsWritten(card, CardVerb.OWNER_ANSWER, "两列都留")
        // The translated option still answers by its index.
        val body = Json.parseToJsonElement(CardRequests.build(card, CardVerb.OWNER_ANSWER, CardInput(option = 1)).body!!.decodeToString()).jsonObject
        assertEquals(JsonPrimitive(1), body["option"])
    }

    // Completion evidence.

    private fun evidenceCard(translation: String?): InteractionCard {
        val row = j("""{"taskId":"t1","title":"Wire the card","projectId":"$project","evidenceRevision":"2","claim":"The card is drawn on Android.",
            "gaps":["No device run."],"citations":[],"criterion":{"key":"k","text":"Every client draws it."},
            "decidability":{"decidable":true},"independence":{"independent":true}""" + (translation?.let { ""","translation":$it}""" } ?: "}"))
        return CardCatalog.session("s1", SessionSnapshot(buildJsonObject { put("id", "s1"); put("projectId", project) }, emptyList(), emptyList(), emptyList(),
            mapOf("evidenceDecisions" to buildJsonObject {
                put("decidingSessionId", "s1"); putJsonArray("pending") { add(row) }; putJsonArray("waitingOnYou") {}
                putJsonArray("sentToCoordinator") {}; putJsonArray("decided") {}
            }))).single { it.family == CardFamily.EVIDENCE }
    }

    @Test fun evidenceIsDrawnTranslatedAndFlipsWhole() {
        show { BusinessCard(evidenceCard("""{"lang":"zh-Hans","claim":"安卓上画出了卡片。","gaps":["没有真机运行。"]}"""), true, open = {}, submit = { _, _ -> }) }
        flips(listOf("安卓上画出了卡片。", "没有真机运行。"), listOf("The card is drawn on Android.", "No device run."))
    }

    @Test fun evidenceWithAFailedTranslationIsDrawnAsWritten() {
        show { BusinessCard(evidenceCard("""{"lang":"zh-Hans","failed":true}"""), true, open = {}, submit = { _, _ -> }) }
        assertTrue(has("The card is drawn on Android.")); noFoot()
    }

    @Test fun anEvidenceSendBackRefusedUntranslatedOffersSendAsWritten() {
        refusedThenSentAsWritten(evidenceCard(null), CardVerb.SEND_BACK, "缺少真机证据", opensNote = true)
    }

    // An owner confirmation.

    private fun confirmationCard(report: String?, review: String?): InteractionCard {
        val view = j("""{"taskId":"t1","title":"Wire the card","completionCriterion":"OWNER_CONFIRMED","status":"OPEN","acceptanceCriteria":"It is drawn.",
            "decisions":[],"waiting":{"sessionId":"s1","requestId":"r1","report":{"text":"I drew the card.","reportedAt":"2026-11-18T01:00:00.000Z"""" +
            (report?.let { ""","translation":$it""" } ?: "") + """},
            "review":{"state":"REVIEWED","reviewId":"rv1","reviewer":{},"since":"2026-11-18T01:00:00.000Z","dueAt":null,"windowSeconds":3600,
              "review":{"recordId":"rec1","recordedAt":"2026-11-18T01:05:00.000Z","reviewedSha":null,"judgment":"It looks right to me.",
                "checked":[],"notChecked":[],"leftOpen":[],"needsYou":[]""" + (review?.let { ""","translation":$it""" } ?: "") + "}}}}")
        return CardCatalog.session("s1", SessionSnapshot(buildJsonObject { put("id", "s1") }, emptyList(), emptyList(), emptyList(),
            mapOf("ownerConfirmation" to view))).single { it.family == CardFamily.OWNER_CONFIRMATION }
    }

    @Test fun anOwnerConfirmationsReportAndReviewAreDrawnTranslatedAndFlipWhole() {
        show { BusinessCard(confirmationCard("""{"lang":"zh-Hans","text":"我画好了卡片。"}""", """{"lang":"zh-Hans","judgment":"我看没问题。"}"""),
            true, open = {}, submit = { _, _ -> }) }
        flips(listOf("我画好了卡片。", "我看没问题。"), listOf("I drew the card.", "It looks right to me."))
    }

    @Test fun anOwnerConfirmationWithoutATranslationIsDrawnAsWritten() {
        show { BusinessCard(confirmationCard(null, """{"lang":"zh-Hans","failed":true}"""), true, open = {}, submit = { _, _ -> }) }
        assertTrue(has("I drew the card.") && has("It looks right to me.")); noFoot()
    }

    @Test fun anOwnerConfirmationSendBackRefusedUntranslatedOffersSendAsWritten() {
        refusedThenSentAsWritten(confirmationCard(null, null), CardVerb.SEND_BACK, "还缺截图", opensNote = true)
    }

    // A criteria change.

    private fun criteriaCard(translation: String?): InteractionCard {
        val row = j("""{"intentId":"i1","projectId":"$project","filedAt":"2026-11-18T01:00:00.000Z","baselineSeal":"$seal","currentSeal":"$seal","commitToken":"tok",
            "proposed":[{"id":"c1","ordinal":1,"text":"The card is drawn on two clients.","verificationMethod":"Unit tests."}],
            "diff":{"entries":[{"change":"REWORDED","ordinal":1,"onRecord":{"text":"The card is drawn on three clients.","verificationMethod":"Unit tests."},
              "proposed":{"text":"The card is drawn on two clients.","verificationMethod":"Unit tests."},"changed":["text"],
              "rewrites":[{"field":"text","segments":[{"side":"same","text":"The card is drawn on "},{"side":"removed","text":"three"},{"side":"added","text":"two"},{"side":"same","text":" clients."}]}]}]},
            "decidability":{"decidable":true}""" + (translation?.let { ""","translation":$it}""" } ?: "}"))
        val reads = mapOf<String, JsonElement>("project" to j("""{"id":"$project","title":"Export"}"""),
            "criteriaDecisions" to buildJsonObject { putJsonArray("pending") { add(row) }; putJsonArray("settled") {} })
        return CardCatalog.project("s1", project, reads).single { it.family == CardFamily.CRITERIA_CHANGE }
    }

    @Test fun aCriteriaChangeIsDrawnTranslatedAndFlipsWholeToItsDiff() {
        show { BusinessCard(criteriaCard("""{"lang":"zh-Hans","proposed":[{"text":"卡片在两个客户端上画出。","verificationMethod":"单元测试。"}]}"""),
            true, open = {}, submit = { _, _ -> }) }
        flips(listOf("卡片在两个客户端上画出。"), listOf("threetwo"))
    }

    @Test fun aCriteriaChangeWithoutATranslationIsDrawnAsItsDiff() {
        show { BusinessCard(criteriaCard(null), true, open = {}, submit = { _, _ -> }) }
        assertTrue(has("threetwo")); noFoot()
    }

    // The start request.

    private fun startReads(translation: String?): Map<String, JsonElement> {
        val row = j("""{"itemId":"item-1","kind":"START_REQUEST","title":"Start this project?","assignee":"OWNER","waitingSince":"2026-11-18T01:00:00.000Z",
            "actions":[],"startRequest":{"settings":{"line":"PROJECT_BRANCH","projectBranchName":"refs/heads/project/p1","automatic":false,"maxConcurrentTasks":3,
            "mergeCheckCommand":null},"why":"B and C build on A","criteriaDigest":"$seal","planDigest":"pp","repository":null,"warnings":[]}""" +
            (translation?.let { ""","translation":$it}""" } ?: "}"))
        return mapOf("project" to j("""{"id":"$project","title":"Aurora","startedAt":null,"exceptionEscalationSeconds":1800,
            "acceptanceCriteriaItems":[{"id":"c1","ordinal":1,"text":"Done."}]}"""), "openItems" to j("""{"needsYou":[],"withCoordinator":[],"startRequest":$row}"""),
            "acceptanceConfirmation" to j("""{"state":"UNCONFIRMED","confirmed":false,"currentVersion":{"digest":"$seal","material":[]}}"""))
    }

    @Test fun aStartRequestsWhyIsDrawnTranslatedAndFlipsWhole() {
        val reads = startReads("""{"lang":"zh-Hans","why":"B 和 C 建立在 A 之上"}""")
        val card = CardCatalog.project("s1", project, reads).single { it.family == CardFamily.START }
        val sent = mutableListOf<CardVerb>()
        show { CoordinatorStartCard(card, reads, fresh = true, result = CardActionState(), open = {}, discuss = {}) { verb, _ -> sent += verb } }
        flips(listOf("B 和 C 建立在 A 之上"), listOf("B and C build on A"))
        compose.onNodeWithTag("start:item-1:START").performScrollTo().performClick()
        assertEquals("the translation changes no press", listOf(CardVerb.START), sent)
    }

    @Test fun aStartRequestWithAFailedTranslationIsDrawnAsWritten() {
        val reads = startReads("""{"lang":"zh-Hans","failed":true}""")
        val card = CardCatalog.project("s1", project, reads).single { it.family == CardFamily.START }
        show { CoordinatorStartCard(card, reads, fresh = true, result = CardActionState(), open = {}, discuss = {}) { _, _ -> } }
        assertTrue(has("B and C build on A")); noFoot()
    }

    // The done request.

    private val doc = j("""{"id":"$project","title":"Project closeout","status":"OPEN",
        "acceptanceCriteriaItems":[{"id":"c1","ordinal":1,"text":"The release is on main"},{"id":"c2","ordinal":2,"text":"The live check was completed"}],
        "derivedDone":{"done":false,"criteria":[{"definitionId":"c1","satisfied":true},{"definitionId":"c2","satisfied":true,"landingReason":"NOTHING_TO_LAND"}],
         "counts":{"criteria":2,"met":2,"landed":2,"onMain":1,"byReason":{"NOTHING_TO_LAND":1}}}}""")
    private fun doneRow(translation: String?) = j("""{"itemId":"req1","kind":"DONE_REQUEST","title":"Is this project done?","waitingSince":"2026-11-18T01:00:00.000Z",
        "doneRequest":{"criteriaDigest":"$seal","judgment":"The goal is met.",
        "gaps":[{"criterionKey":"c2","title":"The live check was completed","whyNotProven":"The task made no commits.",
                 "coordinatorChecked":"main contains the release files","evidenceRefs":["run-42"]}]}""" + (translation?.let { ""","translation":$it}""" } ?: "}"))

    private fun doneCard(row: JsonObject, notTranslated: Boolean = false, notes: MutableList<Pair<String, Boolean>> = mutableListOf()) = show {
        ProjectDoneCard(doc, row, "2026-11-17T10:00:00.000Z", 0, 0, null, true, Instant.parse("2026-11-18T02:00:00.000Z"), enabled = true, error = null,
            tag = "done", onRecord = {}, onNotYet = { note, asWritten -> notes += note to asWritten; false }, onReopen = {}, notTranslated = notTranslated)
    }

    @Test fun aDoneRequestIsDrawnTranslatedAndFlipsWhole() {
        doneCard(doneRow("""{"lang":"zh-Hans","judgment":"目标达成。","gaps":[{"title":"线上检查已完成","whyNotProven":"任务没有提交。","coordinatorChecked":"main 包含发布文件"}]}"""))
        flips(listOf("目标达成。", "任务没有提交。", "main 包含发布文件"), listOf("The goal is met.", "The task made no commits.", "main contains the release files"))
    }

    @Test fun aDoneRequestWithoutATranslationIsDrawnAsWritten() {
        doneCard(doneRow(null))
        assertTrue(has("The goal is met.")); noFoot()
    }

    @Test fun aNotYetNoteRefusedUntranslatedOffersRetryAndSendAsWritten() {
        val notes = mutableListOf<Pair<String, Boolean>>()
        doneCard(doneRow(null), notTranslated = true, notes = notes)
        compose.onNodeWithTag("done-not-yet").performScrollTo().performClick()
        compose.onNodeWithTag("done-note").performTextInput("线上还没验证")
        compose.waitForIdle()
        compose.onNodeWithTag("done-translation-failed", useUnmergedTree = true).assertExists()
        assertTrue(has(TranslationCopy.SEND_FAILED))
        press(TranslationCopy.RETRY)
        press(TranslationCopy.SEND_AS_WRITTEN)
        compose.waitUntil(5_000) { notes.size == 2 }
        assertEquals(listOf("线上还没验证" to false, "线上还没验证" to true), notes)
    }

    // A crossing.

    private fun crossing(translation: String?) = CrossingBatch(listOf(j("""{"id":"h1","kind":"FILE_TASK","state":"PENDING","title":"Rotate the key",
        "reason":"The other project owns the key.","fromProjectId":"p0","fromProject":{"title":"Runner"},"toProjectId":"$project",
        "requestedAt":"2026-11-18T01:00:00.000Z","decidedAt":null""" + (translation?.let { ""","translation":$it}""" } ?: "}"))))

    @Test fun aCrossingIsDrawnTranslatedAndFlipsWhole() {
        var answered: Boolean? = null
        showPage { CrossingReview(crossing("""{"lang":"zh-Hans","title":"轮换密钥","reason":"密钥归另一个项目。"}"""), CrossingCardStore.State(), close = {}) { answered = it } }
        flips(listOf("轮换密钥", "密钥归另一个项目。"), listOf("Rotate the key", "The other project owns the key."))
        compose.onNodeWithTag("crossing-batch-h1:review:approve").performClick()
        assertEquals(true, answered)
    }

    @Test fun aCrossingWithAFailedTranslationIsDrawnAsWritten() {
        showPage { CrossingReview(crossing("""{"lang":"zh-Hans","failed":true}"""), CrossingCardStore.State(), close = {}) {} }
        assertTrue(has("Rotate the key")); noFoot()
    }

    // A question's record.

    @Test fun aQuestionsRecordIsDrawnTranslatedAndFlipsWhole() {
        val record = j("""{"itemId":"q1","question":{"question":"Keep the old columns?","options":[{"label":"Keep them"},{"label":"Drop them"}]},
            "askedAt":"2026-11-18T01:00:00.000Z","resolution":"ANSWERED","resolvedBy":"USER","resolvedAt":"2026-11-18T01:05:00.000Z",
            "answer":{"option":0,"text":null},"delivery":null,"withdrawReason":null,
            "translation":{"lang":"zh-Hans","question":"保留旧列吗？","options":[{"label":"保留"},{"label":"删除"}]}}""")
        val card = InteractionCard("item:q1", CardFamily.QUESTION_RECORD, "Answered", record, "s1", project, "q1", "record", status = "Recorded")
        showPage { QuestionRecordReview(card, open = {}) }
        flips(listOf("保留旧列吗？", "保留", "删除"), listOf("Keep the old columns?", "Keep them", "Drop them"))
    }
}
