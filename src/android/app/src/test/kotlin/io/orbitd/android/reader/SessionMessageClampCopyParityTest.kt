package io.orbitd.android.reader

import io.orbitd.android.core.cards.SessionMessageClamp
import java.io.File
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * A long message from another session folds at the same height and says the same words on every client: the web's
 * `SessionMessageCard.tsx` thresholds and toggle, word for word. A missing counterpart is a failure, never a skip.
 */
class SessionMessageClampCopyParityTest {
    private val root = generateSequence(File(System.getProperty("user.dir") ?: ".")) { it.parentFile }
        .first { File(it, "src/web/src/components").isDirectory }
    private val card = File(root, "src/web/src/components/SessionMessageCard.tsx").also { assertTrue("SessionMessageCard.tsx is gone", it.isFile) }.readText()

    private fun assertHas(needle: String) = assertTrue("SessionMessageCard.tsx no longer contains $needle", card.contains(needle))

    @Test fun foldsWhereTheWebFolds() {
        assertHas("export const SESSION_MESSAGE_CLAMP_LINES = ${SessionMessageClamp.LINES};")
        assertHas("export const SESSION_MESSAGE_CLAMP_FROM = ${SessionMessageClamp.FROM};")
    }

    @Test fun theToggleSaysTheWebsWords() {
        assertHas("export const SESSION_MESSAGE_SHOW_MORE = '${SessionMessageClamp.SHOW_MORE}';")
        assertHas("export const SESSION_MESSAGE_SHOW_LESS = '${SessionMessageClamp.SHOW_LESS}';")
    }
}
