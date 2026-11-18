package io.orbitd.android.translation

import io.orbitd.android.core.protocol.Wire
import io.orbitd.android.core.translation.Translation
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
import java.io.File

/**
 * Android's failure lines are the web's and OrbitKit's (policy board docs/ux/translation-failure-policy.html, frame 7's B column).
 *
 * `src/shared/src/translation-failure-lines.fixture.json` is the contract: translationFailureLines.spec.ts holds it to the board and
 * proves the web's table against it, OrbitKit's TranslationFailureLinesParityTests the native one, and this proves
 * [TranslationFailureCopy] against the same file: every reason (and HTTP status) on a held message and on a card answer, the generic
 * line for none, NO_KEY or a reason this build does not know, and the composer tag. A missing fixture is a failure, never a skip.
 */
class TranslationFailureLinesParityTest {
    private val fixture: JsonObject by lazy {
        val file = generateSequence(File(System.getProperty("user.dir")).absoluteFile) { it.parentFile }
            .map { File(it, "src/shared/src/translation-failure-lines.fixture.json") }.firstOrNull { it.isFile }
        assertNotNull("src/shared/src/translation-failure-lines.fixture.json was not found above ${System.getProperty("user.dir")}. " +
            "The failure lines match on every client only while all of them read this file; if it moved, move this check with it.", file)
        Wire.json.parseToJsonElement(file!!.readText()).jsonObject
    }

    /** As the wire reads it: a reason this client does not know is no reason. */
    private fun reasonOf(raw: String?): Translation.FailureReason? = Translation.FailureReason.entries.firstOrNull { it.name == raw }

    @Test fun everyCaseDrawsTheFixturesSentence() {
        val cases = fixture["cases"]!!.jsonArray.map { it.jsonObject }
        assertTrue("the fixture lost its cases", cases.size > 10)
        for (c in cases) {
            val name = c["name"]!!.jsonPrimitive.content
            val reason = reasonOf(c["reason"]?.jsonPrimitive?.content)
            val status = c["httpStatus"]?.jsonPrimitive?.int
            assertEquals("$name on a held message", c["message"]!!.jsonPrimitive.content,
                TranslationFailureCopy.message(reason, status) ?: TranslationCopy.SEND_FAILED)
            assertEquals("$name on a card answer", c["answer"]!!.jsonPrimitive.content,
                TranslationFailureCopy.answer(reason, status) ?: TranslationCopy.SEND_FAILED)
        }
        // Every reason the wire knows has a case.
        assertEquals(Translation.FailureReason.entries.toSet(), cases.mapNotNull { reasonOf(it["reason"]?.jsonPrimitive?.content) }.toSet())
    }

    @Test fun theComposerTagIsTheFixtures() {
        val tag = fixture["unavailableTag"]!!.jsonPrimitive.content
        assertEquals(tag, TranslationFailureCopy.COMPOSER_UNAVAILABLE)
        assertTrue(TranslationFailureCopy.composerTag("zh-Hans", "en", unavailable = true).endsWith(" · $tag"))
    }
}
