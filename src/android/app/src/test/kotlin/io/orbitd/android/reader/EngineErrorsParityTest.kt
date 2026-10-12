package io.orbitd.android.reader

import org.junit.Assert.*
import org.junit.Test
import java.io.File

/**
 * `EngineErrors` is a hand copy of @orbit/shared `events.ts`, the predicate the server's retry sweeper
 * runs; this reads that file back, as OrbitKit's EngineErrorsParityTests does, so a marker added on one
 * end reds here instead of one client drawing a dead red line while the server is already re-sending.
 * It compares declarations; EngineErrorsTest covers what the predicates decide.
 */
class EngineErrorsParityTest {
    /** Whole-line comments dropped (they quote the markers) and `'…' + '…'` wraps joined. */
    private val events: String by lazy {
        val file = generateSequence(File(System.getProperty("user.dir"))) { it.parentFile }
            .map { File(it, "src/shared/src/events.ts") }.firstOrNull { it.isFile }
        assertNotNull("src/shared/src/events.ts was not found above the test's working directory", file)
        file!!.readText().replace(Regex("(?m)^[ \\t]*//[^\\n]*\\n"), "").replace(Regex("['\"]\\s*\\+\\s*['\"]"), "")
    }

    private fun declared(pattern: String, what: String): String =
        Regex(pattern, RegexOption.DOT_MATCHES_ALL).find(events)?.groupValues?.get(1) ?: error("$what is not declared in events.ts")

    private fun strings(name: String): List<String> =
        Regex("'([^']*)'").findAll(declared("$name = \\[(.*?)\\];", name)).map { it.groupValues[1] }.toList()
            .also { assertTrue("no entries in $name", it.isNotEmpty()) }

    @Test fun retryableStatusesAreTheSameOnBothEnds() {
        val shared = Regex("(\\d+)").findAll(declared("const RETRYABLE_API_ERROR_STATUSES = new Set\\(\\[(.*?)\\]\\)",
            "RETRYABLE_API_ERROR_STATUSES")).map { it.value.toInt() }.toSet()
        assertEquals(shared, EngineErrors.retryableStatuses)
    }

    @Test fun retryableMarkersAreTheSameOnBothEnds() =
        assertEquals(strings("RETRYABLE_API_ERROR_MARKERS"), EngineErrors.retryableMarkers)

    @Test fun retryableEnginePrefixesAreTheSameOnBothEnds() =
        assertEquals(strings("RETRYABLE_ENGINE_ERROR_PREFIXES"), EngineErrors.retryableEngineErrorPrefixes)

    @Test fun usageLimitMarkersAndTheirOffsetAreTheSameOnBothEnds() {
        assertEquals(strings("USAGE_LIMIT_ERROR_MARKERS"), EngineErrors.usageLimitMarkers)
        assertEquals(declared("const USAGE_LIMIT_MARKER_MAX_OFFSET = (\\d+)", "USAGE_LIMIT_MARKER_MAX_OFFSET").toInt(),
            EngineErrors.USAGE_LIMIT_MAX_OFFSET)
    }

    @Test fun benignStderrMarkersAreTheSameOnBothEnds() {
        val benign = strings("BENIGN_ENGINE_STDERR_MARKERS")
        benign.forEach { assertTrue(it, EngineStderr.isBenign("prefix $it suffix")) }
        assertFalse(EngineStderr.isBenign("No conversation found with session ID: abc"))
    }

    @Test fun statusPatternsAreTriedInTheSameOrder() {
        val shared = Regex("lower\\.match\\(/(.*?)/\\)").findAll(declared("const status =(.*?);", "the status match")).map { it.groupValues[1] }.toList()
        assertEquals(shared, EngineErrors.statusPatterns.map { it.pattern })
    }
}
