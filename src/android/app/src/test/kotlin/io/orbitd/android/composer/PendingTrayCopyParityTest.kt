package io.orbitd.android.composer

import io.orbitd.android.reader.SteerDelivery
import org.junit.Assert.*
import org.junit.Test
import java.io.File

/**
 * The tray's words are the web's and iOS's, word for word (docs/mocks/steer-tray): each is read out of the sources that say it there —
 * web `PendingTray.tsx` and `WorkspaceView.tsx`, OrbitKit `PendingTray.swift` and `SteerDelivery.swift`, OrbitApp `PendingTrayView.swift`,
 * `ConsoleModel.swift` and `ComposerView.swift`. A missing source fails, never skips.
 */
class PendingTrayCopyParityTest {
    private val root: File by lazy {
        val found = generateSequence(File(System.getProperty("user.dir"))) { it.parentFile }.firstOrNull { File(it, "src/web/src").isDirectory }
        assertNotNull("the repository root was not found above the test's working directory", found)
        found!!
    }
    private fun read(vararg paths: String) = paths.joinToString("\n") { path ->
        File(root, path).also { assertTrue("$path is missing", it.isFile) }.readText()
    }
    private val web by lazy { read("src/web/src/components/PendingTray.tsx", "src/web/src/components/WorkspaceView.tsx", "src/web/src/lib/steerDelivery.ts") }
    private val ios by lazy {
        read("src/macos/OrbitKit/Sources/OrbitKit/Transcript/PendingTray.swift", "src/macos/OrbitKit/Sources/OrbitKit/Transcript/SteerDelivery.swift",
            "src/macos/OrbitApp/Sources/OrbitApp/Views/Console/PendingTrayView.swift", "src/macos/OrbitApp/Sources/OrbitApp/ConsoleModel.swift",
            "src/macos/OrbitApp/Sources/OrbitApp/Views/ComposerView.swift")
    }

    @Test fun everyClientSaysTheTrayTheSameWay() {
        val shared = listOf(PendingTray.QUEUED, PendingTray.WITHDRAWING, PendingTray.STEER_HINT, PendingTray.WITHDRAW_HINT,
            PendingTray.QUEUE_FOR_NEXT_TURN, PendingTray.STEER_REFUSED, PendingTray.STEER_UNSUPPORTED, PendingTray.TURN_OVER, PendingTray.LABEL,
            PendingTray.TOO_LATE, PendingTray.COULDNT_WITHDRAW, SteerDelivery.label(null), SteerDelivery.label("written"),
            PendingTray.alreadyRead("claude").removePrefix("Claude "))
        shared.forEach { words ->
            assertTrue("the web says \"$words\"", web.contains(words))
            assertTrue("iOS says \"$words\"", ios.contains(words))
        }
        // The button's own word: a line of the web's markup, iOS's label.
        assertTrue(Regex("\\n\\s*${PendingTray.STEER}\\n").containsMatchIn(web))
        assertTrue(ios.contains("Label(\"${PendingTray.STEER}\""))
        // What only the native clients say: a row's direction aloud, and a queued message the runner took first.
        listOf(PendingTray.INTO_TURN, PendingTray.NEXT_TURN, PendingTray.ALREADY_PROCESSING, PendingTray.WITHDRAW).forEach { words ->
            assertTrue("iOS says \"$words\"", ios.contains(words))
        }
    }

    @Test fun aRefusedSteerSaysWhyInTheReadersTerms() {
        assertEquals("This agent can't take a message mid-turn. It stays queued for the next turn.", PendingTray.steerRefusal("STEER_UNSUPPORTED"))
        for (reason in listOf("NO_CURRENT_WORK", "TARGET_LEASE_EXPIRED", null)) {
            assertEquals("The turn is over or being stopped. It stays queued for the next turn.", PendingTray.steerRefusal(reason))
        }
        assertEquals("Codex has already read it.", PendingTray.alreadyRead("codex"))
        assertEquals("The agent has already read it.", PendingTray.alreadyRead("kimi"))
    }
}
