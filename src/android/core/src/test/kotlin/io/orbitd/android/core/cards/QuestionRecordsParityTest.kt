package io.orbitd.android.core.cards

import io.orbitd.android.core.protocol.Wire
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
import java.io.File

/**
 * The answered question card reads one answer the way the browser and OrbitKit do (A06-15, iOS 94f61b52c).
 *
 * `QuestionRecords` is a hand copy of @orbit/shared `questionRecord.ts`, and `src/shared/src/question-record.fixture.json` is
 * the contract: questionRecord.spec.ts proves the browser's reader against it, OrbitKit's QuestionRecordsTests the native one,
 * and this proves Android's against the same file — the outcome of every case, the line the folded card writes for it, a
 * question's opening, and the fixed words. A missing fixture is a failure, never a skip: a check that opts out quietly reports
 * green on exactly the day the thing it watches goes missing.
 */
class QuestionRecordsParityTest {
    private val fixture: JsonObject by lazy {
        val file = generateSequence(File(System.getProperty("user.dir")).absoluteFile) { it.parentFile }
            .map { File(it, "src/shared/src/question-record.fixture.json") }.firstOrNull { it.isFile }
        assertNotNull("src/shared/src/question-record.fixture.json was not found above ${System.getProperty("user.dir")}. The answered " +
            "question card is read the same way on every client only while all of them read this file; if it moved, move this check " +
            "with it rather than deleting it.", file)
        Wire.json.parseToJsonElement(file!!.readText()).jsonObject
    }
    private fun JsonElement?.text() = (this as? JsonPrimitive)?.takeIf { it.isString }?.content

    private fun expected(outcome: JsonElement?): QuestionRecords.Outcome? {
        val o = outcome as? JsonObject ?: return null
        if (o["kind"].text() == "replied") return QuestionRecords.Outcome.Replied(o["words"].text().orEmpty())
        return QuestionRecords.Outcome.Answered(o["answers"]!!.jsonArray.map { a ->
            (a as? JsonObject)?.let { QuestionRecords.Answer(it["picked"]!!.jsonArray.map { i -> i.jsonPrimitive.int }, it["typed"].text()) }
        })
    }

    @Test fun everyCaseReadsAsTheFixtureSays() {
        val cases = fixture["outcome"]!!.jsonArray.map { it.jsonObject }
        assertTrue("the fixture lost its cases", cases.size > 10)
        for (c in cases) {
            val name = c["name"].text()
            val questions = QuestionRecords.questions(buildJsonObject { put("questions", c["questions"]!!) })
            val outcome = QuestionRecords.outcome(questions, c["result"].text(), c["isError"]!!.jsonPrimitive.boolean)
            assertEquals(name, expected(c["outcome"]), outcome)
            val lines = when (outcome) {
                is QuestionRecords.Outcome.Answered -> questions.indices.map { QuestionRecords.answerLine(questions[it], outcome.answers[it]) }
                is QuestionRecords.Outcome.Replied -> listOf(QuestionRecords.replyLine(outcome.words))
                null -> emptyList()
            }
            assertEquals(name, c["lines"]!!.jsonArray.map { it.text() }, lines)
        }
    }

    @Test fun openingsCollapseAsTheFixtureSays() {
        val leads = fixture["lead"]!!.jsonArray.map { it.jsonObject }
        assertTrue(leads.isNotEmpty())
        leads.forEach { assertEquals(it["lead"].text(), QuestionRecords.lead(it["question"].text()!!)) }
    }

    @Test fun wordsAreTheFixtures() = assertEquals(fixture["copy"]!!.jsonObject.mapValues { it.value.text() }, mapOf(
        "repliedInChat" to QuestionRecords.REPLIED_IN_CHAT, "yourAnswer" to QuestionRecords.YOUR_ANSWER,
        "multipleChoice" to QuestionRecords.MULTIPLE_CHOICE))

    /** questionRecord.spec.ts's own reading of an input: every entry kept, and nothing the input does not carry. */
    @Test fun theQuestionsACallAskedAreReadAsTheSharedReaderReadsThem() {
        val input = Wire.json.parseToJsonElement("""{"questions":[
            {"question":"Ship it?","header":"Ship","multiSelect":true,"options":[{"label":"Yes","description":""},{"label":"No"}]},
            {"header":7,"options":"none"}]}""")
        assertEquals(listOf(CardQuestion("Ship it?", "Ship", listOf(QuestionOption("Yes", null), QuestionOption("No", null)), true),
            CardQuestion("", null, emptyList(), false)), QuestionRecords.questions(input))
        assertEquals(emptyList<CardQuestion>(), QuestionRecords.questions(JsonNull))
        assertEquals(emptyList<CardQuestion>(), QuestionRecords.questions(Wire.json.parseToJsonElement("""{"questions":"none"}""")))
    }
}
