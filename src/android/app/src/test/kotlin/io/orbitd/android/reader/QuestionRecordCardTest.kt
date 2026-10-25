package io.orbitd.android.reader

import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.*
import androidx.compose.ui.text.TextLayoutResult
import io.orbitd.android.composer.ComposerShell
import io.orbitd.android.composer.ComposerShellApplication
import io.orbitd.android.composer.ComposerShellTest
import io.orbitd.android.core.cards.QuestionRecords
import io.orbitd.android.core.net.ApiResponse
import io.orbitd.android.core.protocol.Wire
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.io.File

/**
 * A06-15 (iOS 94f61b52c, 010e59792): an answered AskUserQuestion in the production session page, drawn from the shared
 * fixture's own cases (`question-record.fixture.json`). Folded, the card is the record — each question's opening and how it was
 * answered; opened, it replays every question and option as offered, the pick ticked, every description whole. A reply given in
 * the conversation is the reply, never a red "Failed"; a result the reader cannot read shows itself, and opens; a result the
 * server clipped is read whole while the card is still folded.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = ComposerShellApplication::class, qualifiers = "w411dp-h891dp")
@GraphicsMode(GraphicsMode.Mode.NATIVE) // line counts and cut descriptions need real text layout
class QuestionRecordCardTest : ComposerShellTest() {
    private val cases: Map<String, JsonObject> by lazy {
        val file = generateSequence(File(System.getProperty("user.dir")).absoluteFile) { it.parentFile }
            .map { File(it, "src/shared/src/question-record.fixture.json") }.first { it.isFile }
        Wire.json.parseToJsonElement(file.readText()).jsonObject["outcome"]!!.jsonArray.map { it.jsonObject }
            .associateBy { it["name"]!!.jsonPrimitive.content }
    }
    private val oneQuestion = "one question, a listed option (the 10:14 screenshot, word for word)"

    /** The call and its result for one of the fixture's cases, as the transcript's events carry them. */
    private fun ask(seq: Long, case: String, result: JsonElement? = null, truncated: Boolean = false): List<JsonObject> {
        val c = cases.getValue(case)
        return listOf(buildJsonObject {
            put("type", "tool_use"); put("seq", seq)
            putJsonObject("payload") { put("id", "toolu_q$seq"); put("name", "AskUserQuestion"); putJsonObject("input") { put("questions", c["questions"]!!) } }
        }, buildJsonObject {
            put("type", "tool_result"); put("seq", seq + 1); if (truncated) put("truncated", true)
            putJsonObject("payload") { put("toolUseId", "toolu_q$seq"); put("content", result ?: c["result"]!!); put("isError", c["isError"]!!) }
        })
    }
    private fun said(seq: Long, type: String, text: String) = buildJsonObject { put("type", type); put("seq", seq); putJsonObject("payload") { put("text", text) } }
    private fun description(case: String, question: Int, option: Int) =
        cases.getValue(case)["questions"]!!.jsonArray[question].jsonObject["options"]!!.jsonArray[option].jsonObject["description"]!!.jsonPrimitive.content
    private fun card(seq: Long) = hasAnyAncestor(hasTestTag("event:$seq"))
    private fun inCard(seq: Long, matcher: SemanticsMatcher, unmerged: Boolean = true) = has(matcher and card(seq), unmerged)
    /** The fixture's own folded lines for a case, so no expected word is typed twice. */
    private fun lines(case: String) = cases.getValue(case)["lines"]!!.jsonArray.map { it.jsonPrimitive.content }
    /** Fails with the card's tree, so a report says what the card held. */
    private fun expect(seq: Long, matcher: SemanticsMatcher, present: Boolean = true) {
        if (inCard(seq, matcher) != present) fail("${matcher.description} ${if (present) "missing from" else "found in"} card $seq:\n" +
            compose.onNodeWithTag("event:$seq", useUnmergedTree = true).printToString(Int.MAX_VALUE))
    }
    private fun glyphs(seq: Long, tag: String) = compose.onAllNodes(hasTestTag(tag) and card(seq), useUnmergedTree = true).fetchSemanticsNodes().size
    private fun layout(matcher: SemanticsMatcher): TextLayoutResult {
        val results = mutableListOf<TextLayoutResult>()
        compose.onNode(matcher, useUnmergedTree = true).fetchSemanticsNode().config[SemanticsActions.GetTextLayoutResult].action!!(results)
        return results.single()
    }
    private fun show(seq: Long) { compose.onNodeWithTag("transcript-list").performScrollToKey("event:$seq"); compose.waitForIdle() }

    @Test fun anAnsweredQuestionFoldsToItsRecordAndOpensToTheReplay() {
        ComposerShell.events = listOf(said(1, "user", "Make the iPad swipe work")) + ask(2, oneQuestion) + said(4, "assistant", "Both, then.")
        signIn(); openSession()
        await { has(hasTestTag("question-record")) }
        // Folded: the row names it a question and its header, its opening keeps two lines, its answer is ticked.
        assertTrue(inCard(2, hasText("Question") and hasClickAction(), unmerged = false))
        expect(2, hasText("Swipe right"))
        lines(oneQuestion).forEach { expect(2, hasText(it)) }
        assertEquals(1, glyphs(2, "circle-picked"))
        val lead = layout(hasText(QuestionRecords.lead(cases.getValue(oneQuestion)["questions"]!!.jsonArray[0].jsonObject["question"]!!.jsonPrimitive.content)))
        assertEquals("one question keeps two lines of its opening", 2, lead.lineCount)
        assertTrue(lead.isLineEllipsized(1))
        assertFalse("the record is the status", inCard(2, hasText("Complete")) || inCard(2, hasText("Failed")))
        assertFalse("its result is not repeated", inCard(2, hasText("Output")))
        assertFalse(inCard(2, hasTestTag("question-replay")))

        // Opened from its record: every option as offered, with its whole description, the pick ticked.
        compose.onNode(hasTestTag("question-record") and card(2)).performClick()
        await { inCard(2, hasTestTag("question-replay")) }
        listOf("Both, like the iPhone (Recommended)", "Open the sidebar only", "Swipe back only").forEach { assertTrue(it, inCard(2, hasText(it))) }
        (0..2).forEach { option ->
            val words = layout(hasText(description(oneQuestion, 0, option)))
            assertFalse("a description is never cut short", words.hasVisualOverflow || (0 until words.lineCount).any(words::isLineEllipsized))
        }
        assertEquals(1, glyphs(2, "circle-picked"))
        assertEquals(2, glyphs(2, "circle"))
        assertFalse("a lone question's header is already in the row", inCard(2, hasText("SWIPE RIGHT")))
        assertFalse(inCard(2, hasText("Output")))
        compose.onNode(hasText("Question") and hasClickAction() and card(2)).assert(SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, "Expanded"))

        // And the row folds it back to the record.
        compose.onNode(hasText("Question") and hasClickAction() and card(2)).performClick()
        await { !inCard(2, hasTestTag("question-replay")) }
        assertTrue(inCard(2, hasTestTag("question-record")))
    }

    @Test fun picksAndTypedWordsAndSeveralQuestionsReadAsTheyWereAnswered() {
        val multi = "multi-select, a pick and typed words after it"
        val two = "two questions, each a listed option"
        ComposerShell.events = listOf(said(1, "user", "Plan it")) + ask(2, multi) + ask(4, two) + said(6, "assistant", "Noted.")
        signIn(); openSession()
        await { has(hasTestTag("question-record")) }
        show(2)
        lines(multi).forEach { expect(2, hasText(it)) }
        compose.onNode(hasTestTag("question-record") and card(2)).performClick()
        await { inCard(2, hasTestTag("question-replay")) }
        assertTrue(inCard(2, hasText(QuestionRecords.MULTIPLE_CHOICE)))
        assertEquals("the pick is a ticked square", 1, glyphs(2, "square-picked"))
        assertEquals(2, glyphs(2, "square"))
        assertTrue(inCard(2, hasText(QuestionRecords.YOUR_ANSWER)))
        assertTrue(inCard(2, hasText("and the Mac menu bar, later")))

        show(4)
        // Several questions keep one line of each opening, each with its answer.
        expect(4, hasTestTag("question-replay"), present = false)
        lines(two).forEach { expect(4, hasText(it)) }
        val second = cases.getValue(two)["questions"]!!.jsonArray[1].jsonObject["question"]!!.jsonPrimitive.content
        assertEquals(1, layout(hasText(QuestionRecords.lead(second)) and card(4)).lineCount)
        compose.onNode(hasTestTag("question-record") and card(4)).performClick()
        await { inCard(4, hasTestTag("question-replay")) }
        // Several questions are told apart by their headers.
        expect(4, hasText("SWIPE RIGHT"))
        expect(4, hasText("TOP-LEFT"))
        assertEquals(2, glyphs(4, "circle-picked"))
    }

    @Test fun aReplyInTheConversationIsTheReplyAndWhatCannotBeReadShowsItself() {
        val replied = "Chat about this: the person's own words, as the call's error"
        val unknown = "a wording this reader does not know"
        val refused = "a call the engine refused"
        ComposerShell.events = listOf(said(1, "user", "Ask me")) + ask(2, replied) + ask(4, unknown) + ask(6, refused) + said(8, "assistant", "OK.")
        signIn(); openSession()
        await { has(hasTestTag("question-record")) }
        show(2)
        val words = cases.getValue(replied)["result"]!!.jsonPrimitive.content
        lines(replied).forEach { expect(2, hasText(it)) }
        expect(2, hasText(QuestionRecords.REPLIED_IN_CHAT))
        assertEquals(1, glyphs(2, "reply"))
        assertFalse("a reply is never a red failure", inCard(2, hasText("Failed")))
        compose.onNode(hasTestTag("question-record") and card(2)).performClick()
        await { inCard(2, hasTestTag("question-replay")) }
        assertTrue(inCard(2, hasText(words)))
        assertFalse(inCard(2, hasText("Output")))

        // A result in a wording the reader does not know opens on its own words.
        show(4)
        expect(4, hasTestTag("question-replay"))
        expect(4, hasText("Output"))
        assertTrue(inCard(4, hasText(cases.getValue(unknown)["result"]!!.jsonPrimitive.content, substring = true)))

        // A call that failed says so, folded, and opens to what the engine said.
        show(6)
        expect(6, hasText("Failed"))
        expect(6, hasTestTag("question-replay"), present = false)
        compose.onNode(hasTestTag("question-record") and card(6)).performClick()
        await { inCard(6, hasText("Output")) }
    }

    @Test fun aResultTheServerClippedIsReadWholeWhileTheCardIsFolded() {
        val whole = cases.getValue(oneQuestion)["result"]!!.jsonPrimitive.content
        // The server's preview cut the answer off: the record would have no answer to show.
        ComposerShell.events = listOf(said(1, "user", "Make the iPad swipe work")) + ask(2, oneQuestion, JsonPrimitive(whole.take(120)), truncated = true) +
            said(4, "assistant", "Both, then.")
        ComposerShell.answers["GET sessions/${ComposerShell.SESSION}/events/3/full"] = {
            ApiResponse(200, buildJsonObject { put("type", "tool_result"); put("seq", 3)
                putJsonObject("payload") { put("toolUseId", "toolu_q2"); put("content", whole); put("isError", false) } }.toString().encodeToByteArray())
        }
        signIn(); openSession()
        await { inCard(2, hasText(lines(oneQuestion).single())) }
        assertTrue(ComposerShell.calls.contains("GET sessions/${ComposerShell.SESSION}/events/3/full"))
        assertFalse("read whole without being opened", inCard(2, hasTestTag("question-replay")))
    }
}
