package io.orbitd.android.translation

import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Column
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import io.orbitd.android.MainActivity
import io.orbitd.android.TestOrbitApplication
import io.orbitd.android.core.translation.Translation
import io.orbitd.android.core.translation.Translation.FailureReason
import io.orbitd.android.management.AccountTranslation
import io.orbitd.android.ui.OrbitTheme
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.time.Instant

/**
 * Why the owner's words were not sent (policy board docs/ux/translation-failure-policy.html, frames 4B and 5, and frame 7's B column),
 * drawn by the production composables: a held message's foot ([UserTranslationFoot]) and a card answer's line ([AnswerNotTranslated]),
 * each the exact sentence for its reason followed by Retry and Send as written (and Cancel, where the held message can be
 * withdrawn), and today's generic line without a reason. Plus the
 * composer tag's words while translation is unavailable (frame 6).
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = TestOrbitApplication::class)
class TranslationFailureLinesTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()

    /** Frame 7, B column: each reason (and HTTP status) with the sentence a held message draws and the one a card answer draws. */
    private val table: List<Triple<Pair<FailureReason?, Int?>, String, String>> = listOf(
        Triple(FailureReason.TIMEOUT to null, "The translator didn't answer in time, so it wasn't sent", "The translator didn't answer in time, so your answer wasn't sent"),
        Triple(FailureReason.NETWORK to null, "The translator was unreachable, so it wasn't sent", "The translator was unreachable, so your answer wasn't sent"),
        Triple(FailureReason.HTTP to 429, "The translator was unreachable, so it wasn't sent", "The translator was unreachable, so your answer wasn't sent"),
        Triple(FailureReason.HTTP to 503, "The translator was unreachable, so it wasn't sent", "The translator was unreachable, so your answer wasn't sent"),
        Triple(FailureReason.HTTP to 401, "The translator refused the message, so it wasn't sent", "The translator refused the message, so your answer wasn't sent"),
        Triple(FailureReason.HTTP to 400, "The translator refused the message, so it wasn't sent", "The translator refused the message, so your answer wasn't sent"),
        Triple(FailureReason.TRUNCATED to null, "Too long to translate, so it wasn't sent", "Too long to translate, so your answer wasn't sent"),
        Triple(FailureReason.MANGLED to null, "The translation came back damaged, so it wasn't sent", "The translation came back damaged, so your answer wasn't sent"),
        Triple(FailureReason.EMPTY to null, "The translation came back damaged, so it wasn't sent", "The translation came back damaged, so your answer wasn't sent"),
        Triple(FailureReason.UNAVAILABLE to null, "Translation is unavailable right now, so it wasn't sent", "Translation is unavailable right now, so your answer wasn't sent"),
        // No reason (an older server, or a turn held before reasons were stored), and NO_KEY, which frame 7 has no line for: today's line.
        Triple(null to null, "Couldn't translate, so it wasn't sent", "Couldn't translate, so it wasn't sent"),
        Triple(FailureReason.NO_KEY to null, "Couldn't translate, so it wasn't sent", "Couldn't translate, so it wasn't sent"),
    )

    private fun show(content: @Composable () -> Unit) {
        compose.runOnUiThread { compose.activity.setContent { OrbitTheme(darkTheme = false) { Surface { Column { content() } } } } }
        compose.waitForIdle()
    }
    private fun has(text: String) = compose.onAllNodesWithText(text, useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty()

    @Test fun everyReasonHasItsSentenceOnAMessageAndOnAnAnswer() {
        table.forEach { (why, message, answer) ->
            assertEquals("$why on a held message", message, TranslationFailureCopy.message(why.first, why.second) ?: TranslationCopy.SEND_FAILED)
            assertEquals("$why on a card answer", answer, TranslationFailureCopy.answer(why.first, why.second) ?: TranslationCopy.SEND_FAILED)
        }
        // Every reason the wire knows is in the table.
        assertEquals(FailureReason.entries.toSet(), table.mapNotNull { it.first.first }.toSet())
        // HTTP without its status says nothing it cannot know: today's generic line, as on the web and OrbitKit.
        assertNull(TranslationFailureCopy.message(FailureReason.HTTP, null))
    }

    @Test fun aHeldMessageDrawsItsReasonThenRetrySendAsWrittenAndCancel() {
        table.forEach { (why, message, _) ->
            var retried = 0; var sent = 0; var cancelled = 0
            show {
                UserTranslationFoot(Translation.Turn(Translation.TurnState.FAILED, "zh-Hans", "再跑一遍全部测试", why.first, why.second),
                    flipped = false, onFlip = {}, retry = { retried++ }, sendAsWritten = { sent++ }, cancel = { cancelled++ })
            }
            assertTrue("$why: $message", has(message))
            table.map { it.second }.filter { it != message }.forEach { other -> assertFalse("$why draws only its own line: $other", has(other)) }
            // The line, then "· Retry · Send as written · Cancel", in that order.
            val drawn = compose.onNodeWithTag("translation-foot", useUnmergedTree = true).onChildren().fetchSemanticsNodes()
                .flatMap { it.config.getOrElse(androidx.compose.ui.semantics.SemanticsProperties.Text) { emptyList() }.map { t -> t.text } }
            assertEquals(listOf(message, "·", TranslationCopy.RETRY, "·", TranslationCopy.SEND_AS_WRITTEN, "·", TranslationCopy.CANCEL), drawn.filter { it.isNotBlank() })
            compose.onNodeWithTag("translation-action:${TranslationCopy.RETRY}", useUnmergedTree = true).performClick()
            compose.onNodeWithTag("translation-action:${TranslationCopy.SEND_AS_WRITTEN}", useUnmergedTree = true).performClick()
            compose.onNodeWithTag("translation-action:${TranslationCopy.CANCEL}", useUnmergedTree = true).performClick()
            compose.waitForIdle()
            assertEquals("$why: Retry", 1, retried); assertEquals("$why: Send as written", 1, sent); assertEquals("$why: Cancel", 1, cancelled)
        }
        // Nothing to withdraw it with (a session's opening prompt): no Cancel.
        show { UserTranslationFoot(Translation.Turn(Translation.TurnState.FAILED, "zh-Hans", "再跑一遍全部测试"), flipped = false, onFlip = {},
            retry = {}, sendAsWritten = {}) }
        assertTrue(has(TranslationCopy.SEND_AS_WRITTEN)); assertFalse(has(TranslationCopy.CANCEL))
    }

    @Test fun aCardAnswerNamesYourAnswerThenRetryAndSendAsWritten() {
        table.forEach { (why, _, answer) ->
            var retried = 0; var sent = 0
            show { AnswerNotTranslated({ retried++ }, { sent++ }, enabled = true, reason = why.first, httpStatus = why.second) }
            assertTrue("$why: $answer", has(answer))
            assertTrue(has(TranslationCopy.RETRY)); assertTrue(has(TranslationCopy.SEND_AS_WRITTEN))
            compose.onNodeWithText(TranslationCopy.RETRY, useUnmergedTree = true).performClick()
            compose.onNodeWithText(TranslationCopy.SEND_AS_WRITTEN, useUnmergedTree = true).performClick()
            compose.waitForIdle()
            assertEquals("$why: Retry", 1, retried); assertEquals("$why: Send as written", 1, sent)
        }
        // Drawn without a reason at all (the default), the card keeps today's line.
        show { AnswerNotTranslated({}, {}, enabled = true) }
        assertTrue(has("Couldn't translate, so it wasn't sent"))
    }

    @Test fun aRefusedAnswersReasonIsReadOffItsBody() {
        val body = io.orbitd.android.composer.ComposerShell.obj("""{"code":"TRANSLATION_FAILED","message":"x","failureReason":"HTTP","httpStatus":503}""")
        val why = Translation.refusalReason(body)
        assertEquals(FailureReason.HTTP to 503, why)
        assertEquals("The translator was unreachable, so your answer wasn't sent", TranslationFailureCopy.answer(why?.first, why?.second))
        assertNull("another refusal", Translation.refusalReason(io.orbitd.android.composer.ComposerShell.obj("""{"code":"OTHER","failureReason":"TIMEOUT"}""")))
        assertNull("no reason: the generic line", Translation.refusalReason(io.orbitd.android.composer.ComposerShell.obj("""{"code":"TRANSLATION_FAILED"}""")))
    }

    @Test fun theComposerTagSaysMessagesWillWaitWhileUnavailable() {
        assertEquals("Chinese → English · unavailable, messages will wait", TranslationFailureCopy.composerTag("zh-Hans", "en", unavailable = true))
        assertEquals("Chinese → English", TranslationFailureCopy.composerTag("zh-Hans", "en", unavailable = false))
        assertEquals("Japanese → German · unavailable, messages will wait", TranslationFailureCopy.composerTag("ja", "de", unavailable = true))
        val until = Instant.parse("2026-11-18T08:00:00Z")
        val account = AccountTranslation(enabled = true, available = true, unavailableUntil = until)
        assertTrue(account.unavailableAt(until.minusSeconds(1)))
        assertFalse("the instant passed", account.unavailableAt(until))
        assertFalse(AccountTranslation(enabled = true, available = true).unavailableAt(until))
    }

    @Test fun theWordsAreEnglish() {
        val words = TranslationFailureCopy::class.java.declaredFields.mapNotNull { f -> f.isAccessible = true; runCatching { f.get(null) }.getOrNull() as? String }
        assertTrue(words.size >= 9)
        words.forEach { w -> assertTrue("not English: $w", w.none { Character.UnicodeScript.of(it.code) == Character.UnicodeScript.HAN }) }
    }
}
