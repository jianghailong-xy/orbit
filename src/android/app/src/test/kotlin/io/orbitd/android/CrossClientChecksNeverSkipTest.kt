package io.orbitd.android

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * A test that reads another client's source (web, iOS/macOS, or the shared tables) to hold the same words on both sides FAILS when that
 * file is missing, and never skips (evidence-addressee design §6, D5 = A). A skipped parity check is green on exactly the day its
 * counterpart went missing: on 2026-11-12 an `assumeTrue` let `iosAndMacosSayTheSameWords` skip and the task still passed. This reads
 * every unit test of both modules and fails naming any cross-client one that skips.
 */
class CrossClientChecksNeverSkipTest {
    private val android = generateSequence(File(System.getProperty("user.dir"))) { it.parentFile }
        .first { File(it, "app/src/test").isDirectory && File(it, "core/src/test").isDirectory }

    @Test fun noCrossClientCheckSkips() {
        val files = listOf("app/src/test", "core/src/test").flatMap { File(android, it).walkTopDown().filter { f -> f.isFile && f.extension == "kt" }.toList() }
            .filter { it.name != "CrossClientChecksNeverSkipTest.kt" }
        assertTrue("found too few unit tests under $android to have looked", files.size > 50)
        val skip = Regex("""\bassume(True|False|NotNull|That|NoException)\s*\(|\bAssume\.|@Ignore\b""")
        val offenders = files.filter { f ->
            val text = f.readText()
            listOf("src/web/", "src/macos/", "src/shared/").any(text::contains) && skip.containsMatchIn(text)
        }.map { it.relativeTo(android).path }.sorted()
        assertEquals("these read another client's file and skip when it is missing; make a missing file a failure naming it", emptyList<String>(), offenders)
    }
}
