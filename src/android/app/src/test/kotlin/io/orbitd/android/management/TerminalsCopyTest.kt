package io.orbitd.android.management

import io.orbitd.android.core.cards.Terminal
import io.orbitd.android.core.cards.TerminalRequest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.time.Instant
import java.time.ZoneOffset

/** The approve card and Settings → Terminals say what iOS says, byte for byte: every String constant of [Terminals] is a literal in
 * OrbitKit's Terminals.swift (which `TerminalsCopyParityTests` holds to the web's lib/terminals.ts), and each line reads as iOS builds it. */
class TerminalsCopyTest {
    private val root = generateSequence(File(System.getProperty("user.dir"))) { it.parentFile }
        .first { File(it, "src/macos/OrbitKit/Sources/OrbitKit").isDirectory }
    private val swift = File(root, "src/macos/OrbitKit/Sources/OrbitKit/App/Terminals.swift").readText()

    private fun constants(holder: Any): Map<String, String> = holder.javaClass.declaredFields.mapNotNull { field ->
        field.isAccessible = true
        (runCatching { field.get(holder) }.getOrNull() as? String)?.let { field.name to it }
    }.toMap()

    @Test fun everyWordIsIosOwn() {
        val words = constants(Terminals)
        assertTrue("Terminals holds no words", words.size >= 13)
        assertEquals("Terminals strings not in Terminals.swift", emptyMap<String, String>(), words.filterValues { !swift.contains("\"$it\"") })
    }

    private val now = Instant.parse("2026-11-12T10:00:00Z").toEpochMilli()
    private val terminal = Terminal("t1", "dev-laptop", "r1", "2026-11-12T09:00:00Z", "2026-11-12T09:00:00Z", "2026-11-12T09:57:00Z",
        "2026-12-12T09:00:00Z")

    @Test fun theLinesReadAsIosBuildsThem() {
        assertEquals("Terminal on dev-laptop · code 7KQ-4MZ",
            Terminals.requestLine(TerminalRequest("q1", "7KQ-4MZ", "dev-laptop", "r1", "2026-11-12T09:58:00Z", "2026-11-12T10:08:00Z")))
        assertEquals("Approved Nov 12, 2026", Terminals.approvedLine(terminal, ZoneOffset.UTC))
        assertEquals("Last used 3m ago", Terminals.lastUsedLine(terminal, now))
        assertEquals("Never used", Terminals.lastUsedLine(terminal.copy(lastUsedAt = null), now))
        assertEquals("Expires Dec 12, 2026 · in 30 days", Terminals.expiresLine(terminal, now, ZoneOffset.UTC))
        assertEquals("Revoke the terminal on dev-laptop?", Terminals.revokeTitle(terminal))
        assertEquals("Couldn't revoke the terminal: the connection dropped", Terminals.notRevoked("the connection dropped"))
        assertEquals("2 signed in", Terminals.settingsValue(2))
        assertEquals("None", Terminals.settingsValue(0))
    }
}
