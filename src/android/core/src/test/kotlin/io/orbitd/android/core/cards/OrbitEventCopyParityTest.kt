package io.orbitd.android.core.cards

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * The generic From Orbit line says the web's words (`OrbitEventLine.tsx`, landed first) and OrbitKit's (`OrbitEvent.swift`), and draws
 * for the same turns. A missing counterpart is a failure, never a skip.
 */
class OrbitEventCopyParityTest {
    private val root = generateSequence(File(System.getProperty("user.dir"))) { it.parentFile }
        .first { File(it, "src/web/src/components/OrbitEventLine.tsx").isFile }
    private val web = File(root, "src/web/src/components/OrbitEventLine.tsx").readText()
    private val swift = File(root, "src/macos/OrbitKit/Sources/OrbitKit/Transcript/OrbitEvent.swift").readText()

    private fun has(source: String, name: String, literal: String) = assertTrue("$name no longer contains $literal", source.contains(literal))

    @Test fun everyWordIsTheWebsAndOrbitKits() {
        has(web, "OrbitEventLine.tsx", "export const ORBIT_EVENT_TITLE = '${OrbitEvent.title}';")
        has(web, "OrbitEventLine.tsx", "export const ORBIT_EVENT_MARK = '${OrbitEvent.mark}';")
        has(web, "OrbitEventLine.tsx", "return describeNote(note) || '${OrbitEvent.unnamed}';")
        has(web, "OrbitEventLine.tsx", "<summary>${OrbitEvent.rawSummary}</summary>")
        assertTrue(Regex(">\\s*${OrbitEvent.details}\\s*<").containsMatchIn(web))
        has(swift, "OrbitEvent.swift", "public static let title = \"${OrbitEvent.title}\"")
        has(swift, "OrbitEvent.swift", "public static let mark = \"${OrbitEvent.mark}\"")
        has(swift, "OrbitEvent.swift", "public static let details = \"${OrbitEvent.details}\"")
        has(swift, "OrbitEvent.swift", "public static let whatTheAgentRead = \"${OrbitEvent.rawSummary}\"")
        has(swift, "OrbitEvent.swift", "public static let unnamed = \"${OrbitEvent.unnamed}\"")
    }

    @Test fun itDrawsForTheTurnsTheOtherEndsDrawItFor() {
        assertTrue(OrbitEvent.draws("", "<orbit-future-thing>\n  x\n</orbit-future-thing>", hasAttachments = false))
        assertFalse(OrbitEvent.draws("Ship it", "<orbit-future-thing>\n  x\n</orbit-future-thing>", hasAttachments = false))
        assertFalse(OrbitEvent.draws("", "<orbit-future-thing>\n  x\n</orbit-future-thing>", hasAttachments = true))
        assertFalse(OrbitEvent.draws("", null, hasAttachments = false))
        assertTrue(OrbitEvent.name("") == OrbitEvent.unnamed && OrbitEvent.name("session reply") == "session reply")
    }
}
