package io.orbitd.android.directory

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** The three state words and every mark's word and tone are web's (`src/web/src/lib/sessionDisplay.ts`, the approved board's two
 * functions), in the same drawing order. A missing counterpart is a failure, never a skip. */
class SessionDisplayCopyParityTest {
    private val root = generateSequence(File(System.getProperty("user.dir"))) { it.parentFile }
        .first { File(it, "src/web/src/lib").isDirectory }
    private val web = File(root, "src/web/src/lib/sessionDisplay.ts").readText()

    @Test fun theStateWordsAndIconsAreTheWebs() {
        SessionDisplayState.entries.forEach { state ->
            val phase = when (state) { SessionDisplayState.QUEUED -> "PENDING"; SessionDisplayState.RUNNING -> "RUNNING"; SessionDisplayState.IDLE -> "IDLE" }
            val line = "  $phase: { word: '${state.word}', icon: '${state.icon.name.lowercase()}' },"
            assertTrue("sessionDisplay.ts no longer says \"$line\"", web.contains(line))
        }
    }

    @Test fun theMarksAreTheWebsInTheWebsOrder() {
        SessionMark.entries.forEach { mark ->
            val line = "  ${mark.name}: { word: '${mark.word}', tone: '${mark.tone.name.lowercase()}' },"
            assertTrue("sessionDisplay.ts no longer says \"$line\"", web.contains(line))
        }
        val declared = Regex("^  ([A-Z_]+): \\{ word: '", RegexOption.MULTILINE).findAll(web.substringAfter("export const SESSION_MARKS"))
            .map { it.groupValues[1] }.toList()
        assertEquals(SessionMark.entries.map { it.name }, declared)
    }

    @Test fun theRowIconTipsAreTheWebs() {
        SessionRowIcon.entries.forEach { icon ->
            val line = "  ${icon.name}: '${icon.tip}',"
            assertTrue("sessionDisplay.ts no longer says \"$line\"", web.contains(line))
        }
    }
}
