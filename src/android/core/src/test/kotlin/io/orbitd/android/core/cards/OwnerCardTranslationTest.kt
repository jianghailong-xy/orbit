package io.orbitd.android.core.cards

import io.orbitd.android.core.protocol.Wire
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
import java.io.File

/**
 * The owner cards' optional `translation` (OwnerCardTranslation / EvidenceTranslation in src/shared/src/translation.ts) read the way
 * the server writes it: each card's fields, index for index, a field the original lacks never added, a step's command and link never
 * touched; an absent or failed translation, or one that changes nothing, is no translation at all.
 */
class OwnerCardTranslationTest {
    private fun j(text: String) = Json.parseToJsonElement(text).jsonObject

    @Test fun theFieldsAreTheServersOwn() {
        val root = generateSequence(File(System.getProperty("user.dir"))) { it.parentFile }.first { File(it, "src/apiserver").isDirectory }
        val server = File(root, "src/apiserver/src/sessions/card-translation.ts").readText()
        listOf("COORDINATOR_QUESTION_FIELDS", "OWNER_REQUEST_FIELDS", "START_REQUEST_FIELDS", "DONE_REQUEST_FIELDS", "EVIDENCE_FIELDS",
            "CONFIRMATION_REVIEW_FIELDS", "CONFIRMATION_PROBLEMS_FIELDS", "CROSSING_FIELDS", "CRITERIA_CHANGE_FIELDS").forEach {
            assertTrue("the server still names $it", server.contains("export const $it"))
        }
        assertTrue(server.contains("steps: [{ text: true }]"))
    }

    @Test fun aCoordinatorQuestionIsReadIndexForIndex() {
        val row = j("""{"kind":"COORDINATOR_QUESTION","question":{"question":"Q?","options":[{"label":"A","description":"a"},{"label":"B"}],"recommendedOption":0},
            "translation":{"lang":"ja","question":"問？","options":[{"label":"甲","description":"甲です"},{"label":"乙","description":"not in the original"}]}}""")
        val q = OwnerCardTranslation.openItem(row, "ja")!!.obj("question")!!
        assertEquals("問？", q.text("question"))
        assertEquals(listOf("甲", "乙"), q.objects("options").map { it.text("label") })
        assertEquals("甲です", q.objects("options")[0].text("description"))
        assertNull("a field the original lacks is not added", q.objects("options")[1]["description"])
        assertEquals(JsonPrimitive(0), q["recommendedOption"])
    }

    @Test fun noTranslationAFailedOneOrOneThatChangesNothingIsNone() {
        val base = """{"kind":"COORDINATOR_QUESTION","question":{"question":"Q?"}"""
        assertNull(OwnerCardTranslation.openItem(j("$base}"), "ja"))
        assertNull(OwnerCardTranslation.openItem(j("""$base,"translation":{"lang":"ja","failed":true}}"""), "ja"))
        assertNull(OwnerCardTranslation.openItem(j("""$base,"translation":{"lang":"ja","question":"Q?"}}"""), "ja"))
        assertNull(OwnerCardTranslation.openItem(j("""$base,"translation":{"lang":"ja"}}"""), "ja"))
    }

    @Test fun aTranslationInAnotherLanguageThanTheOwnersOrWithTranslationOffIsNone() {
        val row = j("""{"kind":"COORDINATOR_QUESTION","question":{"question":"Q?"},"translation":{"lang":"ja","question":"問？"}}""")
        assertNotNull(OwnerCardTranslation.openItem(row, "ja"))
        assertNull("another language than the owner's current one is drawn as the original", OwnerCardTranslation.openItem(row, "zh-Hans"))
        assertNull("translation off", OwnerCardTranslation.openItem(row, null))
        val request = Wire.decode(j("""{"id":"r","kind":"DECISION","state":"PENDING","title":"Pick","why":"W","createdAt":"2026-11-18T00:00:00Z",
            "translation":{"lang":"ja","title":"選ぶ"}}""").toString().encodeToByteArray(), OwnerRequest.serializer())
        assertNull(OwnerCardTranslation.ownerRequest(request, "zh-Hans"))
        assertNull(OwnerCardTranslation.card(InteractionCard("item:q", CardFamily.OWNER_QUESTION, "Q", row, "s", "p", "q", "b", listOf(CardVerb.OWNER_ANSWER)), "zh-Hans"))
    }

    @Test fun aQuestionsDetailLineIsTheServersTranslatedOneWhileDrawnTranslated() {
        val row = j("""{"kind":"COORDINATOR_QUESTION","detailLine":"If you don’t answer: I keep both.","question":{"question":"Q?","ifUnanswered":"I keep both."},
            "translation":{"lang":"ja","question":"問？","ifUnanswered":"両方残す。","detailLine":"If you don’t answer: 両方残す。"}}""")
        assertEquals("If you don’t answer: 両方残す。", OwnerCardTranslation.openItem(row, "ja")!!.text("detailLine"))
        assertEquals("the original keeps row.detailLine", "If you don’t answer: I keep both.", row.text("detailLine"))
        val older = j("""{"kind":"COORDINATOR_QUESTION","detailLine":"d","question":{"question":"Q?"},"translation":{"lang":"ja","question":"問？"}}""")
        assertEquals("a translation served without one keeps row.detailLine", "d", OwnerCardTranslation.openItem(older, "ja")!!.text("detailLine"))
    }

    @Test fun aHandedOverItemsNoteIsDrawnTranslatedUnderItsCaptionOrAsWritten() {
        assertEquals("Why the coordinator handed it over", ExceptionCards.handoverNoteCaption)
        val base = """{"kind":"INTEGRATION_CONFLICT","title":"t","assigneeReason":"HANDED_OVER""""
        val row = j("""$base,"handoverNote":"Your retry policy","translation":{"lang":"ja","handoverNote":"再試行ポリシー"}}""")
        assertEquals("translated while usable", "再試行ポリシー", OwnerCardTranslation.handoverNote(row, "ja", showOriginal = false))
        assertTrue(OwnerCardTranslation.handoverNoteTranslates(row, "ja"))
        assertEquals("flipped: the original", "Your retry policy", OwnerCardTranslation.handoverNote(row, "ja", showOriginal = true))
        listOf(
            row to "ko",
            row to null,
            j("""$base,"handoverNote":"Your retry policy","translation":{"lang":"ja","failed":true}}""") to "ja",
            j("""$base,"handoverNote":"Your retry policy"}""") to "ja",
        ).forEach { (r, owner) ->
            assertEquals("Your retry policy", OwnerCardTranslation.handoverNote(r, owner, showOriginal = false))
            assertFalse("no flip without a usable translation", OwnerCardTranslation.handoverNoteTranslates(r, owner))
        }
        val none = j("""$base,"handoverNote":null,"translation":{"lang":"ja","handoverNote":"x"}}""")
        assertNull("nothing when the note is null", OwnerCardTranslation.handoverNote(none, "ja", showOriginal = false))
        assertFalse(OwnerCardTranslation.handoverNoteTranslates(none, "ja"))
    }

    @Test fun theProjectPagesListRowDrawsTheTranslatedTitleAndDetailLineOrTheOriginals() {
        val base = """{"kind":"COORDINATOR_QUESTION","title":"Coordinator asks: Q?","detailLine":"If you don’t answer: it waits","question":{"question":"Q?"}"""
        val row = j("""$base,"translation":{"lang":"ja","question":"問？","title":"Coordinator asks: 問？","detailLine":"If you don’t answer: 待つ"}}""")
        assertEquals("Coordinator asks: 問？", OwnerCardTranslation.listTitle(row, "ja"))
        assertEquals("If you don’t answer: 待つ", OwnerCardTranslation.listDetailLine(row, "ja"))
        listOf(
            row to "ko",
            row to null,
            j("""$base,"translation":{"lang":"ja","failed":true}}""") to "ja",
            j("$base}") to "ja",
        ).forEach { (r, owner) ->
            assertEquals("Coordinator asks: Q?", OwnerCardTranslation.listTitle(r, owner))
            assertEquals("If you don’t answer: it waits", OwnerCardTranslation.listDetailLine(r, owner))
        }
        val older = j("""$base,"translation":{"lang":"ja","question":"問？","detailLine":"If you don’t answer: 待つ"}}""")
        assertEquals("an older server's translation without a title keeps the original", "Coordinator asks: Q?", OwnerCardTranslation.listTitle(older, "ja"))
        assertEquals("If you don’t answer: 待つ", OwnerCardTranslation.listDetailLine(older, "ja"))
    }

    @Test fun anOwnerRequestsCardTitleIsTranslatedOnlyIntoTheOwnersLanguage() {
        fun title(request: OwnerRequest, owner: String?) = OwnerCardTranslation.ownerRequest(request, owner)?.title ?: request.title
        val request = Wire.decode(j("""{"id":"r","kind":"DECISION","state":"PENDING","title":"Pick a region","why":"W","createdAt":"2026-11-18T00:00:00Z",
            "translation":{"lang":"ja","title":"リージョンを選ぶ"}}""").toString().encodeToByteArray(), OwnerRequest.serializer())
        assertEquals("リージョンを選ぶ", title(request, "ja"))
        assertEquals("Pick a region", title(request, "zh-Hans"))
        assertEquals("Pick a region", title(request, null))
        assertEquals("Pick a region", title(request.copy(translation = j("""{"lang":"ja","failed":true}""")), "ja"))
    }

    @Test fun startAndDoneRequestsReadTheirOwnFields() {
        val start = OwnerCardTranslation.openItem(j("""{"kind":"START_REQUEST","startRequest":{"why":"Because","criteriaDigest":"d"},"translation":{"lang":"ja","why":"理由"}}"""), "ja")!!
        assertEquals("理由", start.obj("startRequest")!!.text("why"))
        assertEquals("d", start.obj("startRequest")!!.text("criteriaDigest"))
        val done = OwnerCardTranslation.openItem(j("""{"kind":"DONE_REQUEST","doneRequest":{"judgment":"Met","gaps":[{"criterionKey":"k","title":"T","whyNotProven":"W"}]},
            "translation":{"lang":"ja","judgment":"達成","gaps":[{"title":"題","whyNotProven":"理由"}]}}"""), "ja")!!.obj("doneRequest")!!
        assertEquals("達成", done.text("judgment"))
        assertEquals("k", done.objects("gaps")[0].text("criterionKey"))
        assertEquals("題", done.objects("gaps")[0].text("title"))
    }

    @Test fun anOwnerRequestLeavesAStepsCommandAndLinkAsWritten() {
        val request = Wire.decode(j("""{"id":"r","kind":"MANUAL_STEP","state":"PENDING","title":"Enable it","why":"It fails","createdAt":"2026-11-18T00:00:00Z",
            "steps":[{"text":"Run this","command":"gcloud services enable x","link":"https://example.test"}],"verifyHint":"Check it",
            "translation":{"lang":"ja","title":"有効にする","why":"失敗する","steps":[{"text":"これを実行"}],"verifyHint":"確認する"}}""").toString().encodeToByteArray(),
            OwnerRequest.serializer())
        val shown = OwnerCardTranslation.ownerRequest(request, "ja")!!
        assertEquals("有効にする", shown.title); assertEquals("失敗する", shown.why); assertEquals("確認する", shown.verifyHint)
        assertEquals(OwnerRequestStep("これを実行", "gcloud services enable x", "https://example.test"), shown.steps!!.single())
        assertNull(OwnerCardTranslation.ownerRequest(request.copy(translation = j("""{"lang":"ja","failed":true}""")), "ja"))
        assertNull(OwnerCardTranslation.ownerRequest(request.copy(translation = null), "ja"))
    }

    @Test fun evidenceCrossingAndCriteriaReadTheirFields() {
        val evidence = OwnerCardTranslation.evidence(j("""{"claim":"Done","gaps":["G1","G2"],"translation":{"lang":"ja","claim":"完了","gaps":["欠1"]}}"""), "ja")!!
        assertEquals("完了", evidence.text("claim")); assertEquals(listOf("欠1", "G2"), evidence.strings("gaps"))
        val crossing = OwnerCardTranslation.crossing(j("""{"id":"h","title":"T","reason":"R","translation":{"lang":"ja","title":"題","reason":"理"}}"""), "ja")!!
        assertEquals("題", crossing.text("title")); assertEquals("理", crossing.text("reason"))
        val criteria = OwnerCardTranslation.criteria(j("""{"proposed":[{"ordinal":1,"text":"T","verificationMethod":"V"}],
            "diff":{"entries":[{"ordinal":1,"onRecord":{"text":"Old"},"proposed":{"text":"T","verificationMethod":"V"},"rewrites":[{"field":"text"}]}]},
            "translation":{"lang":"ja","proposed":[{"text":"案","verificationMethod":"方法"}]}}"""), "ja")!!
        val entry = criteria.obj("diff")!!.objects("entries").single()
        assertEquals("案", entry.obj("proposed")!!.text("text")); assertEquals("方法", entry.obj("proposed")!!.text("verificationMethod"))
        assertEquals("Old", entry.obj("onRecord")!!.text("text"))
        assertTrue("the word-by-word cut is of the agent's words, so it is not drawn translated", entry.objects("rewrites").isEmpty())
    }

    @Test fun anOwnerConfirmationReadsItsReportReviewAndProblems() {
        val view = j("""{"waiting":{"requestId":"r","report":{"text":"Said","translation":{"lang":"ja","text":"言った"}},
            "review":{"state":"REVIEWED","review":{"judgment":"OK","needsYou":[{"key":"k","text":"Pick","options":[{"label":"A"}]}],
              "translation":{"lang":"ja","judgment":"良い","needsYou":[{"text":"選ぶ","options":[{"label":"甲"}]}]}},
              "problems":{"reason":"Broke","problems":[{"text":"P"}],"translation":{"lang":"ja","failed":true}}}}}""")
        val waiting = OwnerCardTranslation.confirmation(view, "ja")!!.obj("waiting")!!
        assertEquals("言った", waiting.obj("report")!!.text("text"))
        val record = waiting.obj("review")!!.obj("review")!!
        assertEquals("良い", record.text("judgment"))
        assertEquals("k", record.objects("needsYou")[0].text("key"))
        assertEquals("甲", record.objects("needsYou")[0].objects("options")[0].text("label"))
        assertEquals("a failed record is drawn as written", "Broke", waiting.obj("review")!!.obj("problems")!!.text("reason"))
    }

    @Test fun theAnswerDoorsTakeSendAsWritten() {
        fun body(card: InteractionCard, verb: CardVerb, input: CardInput) = Json.parseToJsonElement(CardRequests.build(card, verb, input).body!!.decodeToString()).jsonObject
        val question = InteractionCard("item:q", CardFamily.OWNER_QUESTION, "Q", j("""{"question":{"question":"Q?","options":[{"label":"A"}]}}"""),
            "s", "p", "q", "b", listOf(CardVerb.OWNER_ANSWER))
        assertNull(body(question, CardVerb.OWNER_ANSWER, CardInput(text = "words"))["sendAsWritten"])
        assertEquals(JsonPrimitive(true), body(question, CardVerb.OWNER_ANSWER, CardInput(text = "words", sendAsWritten = true))["sendAsWritten"])
        val evidence = InteractionCard("evidence:t:1", CardFamily.EVIDENCE, "E", j("""{"evidenceRevision":"1"}"""), "s", "p", "t", "b",
            listOf(CardVerb.SEND_BACK), context = j("""{"decidingSessionId":"s"}"""))
        assertNull(body(evidence, CardVerb.SEND_BACK, CardInput(text = "no"))["sendAsWritten"])
        assertEquals(JsonPrimitive(true), body(evidence, CardVerb.SEND_BACK, CardInput(text = "no", sendAsWritten = true))["sendAsWritten"])
        val owner = InteractionCard("owner:t:r", CardFamily.OWNER_CONFIRMATION, "O", j("""{"waiting":{"requestId":"r"}}"""), "s", "p", "t", "b",
            listOf(CardVerb.SEND_BACK))
        assertNull(body(owner, CardVerb.SEND_BACK, CardInput(text = "no"))["sendAsWritten"])
        assertEquals(JsonPrimitive(true), body(owner, CardVerb.SEND_BACK, CardInput(text = "no", sendAsWritten = true))["sendAsWritten"])
    }
}
