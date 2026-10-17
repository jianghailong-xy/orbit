package io.orbitd.android.composer

import io.orbitd.android.reader.SteerDelivery
import org.junit.Assert.*
import org.junit.Test
import java.io.File

/**
 * The tray's words are the web's and iOS's, word for word (docs/mocks/steer-tray): each is read out of the sources that say it there —
 * web `PendingTray.tsx`, `WorkspaceView.tsx`, `Transcript.tsx` and `steerDelivery.ts`, OrbitKit `PendingTray.swift` and
 * `SteerDelivery.swift`, OrbitApp `PendingTrayView.swift`, `ConsoleModel.swift` and `ComposerView.swift`. So are the words under a steer
 * once it settled. A missing source fails, never skips.
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
    private val web by lazy { read("src/web/src/components/PendingTray.tsx", "src/web/src/components/WorkspaceView.tsx",
        "src/web/src/components/Transcript.tsx", "src/web/src/lib/steerDelivery.ts") }
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

    @Test fun everyClientSaysHowASteerCameOutTheSameWay() {
        // The state line under a settled steer: web `steerDeliveryState`, OrbitKit `SteerDelivery.state(_:)`.
        listOf("acknowledged", SteerDelivery.REQUEUED, "failed", "unconfirmed").map(SteerDelivery::label).forEach { words ->
            assertTrue("the web says \"$words\"", web.contains("'$words'") || web.contains("\"$words\""))
            assertTrue("iOS says \"$words\"", ios.contains("\"$words\""))
        }
        // What only the web says: the way back to the composer — under a bubble and under a receipt — and a discard it refused.
        assertEquals("under the bubble and under the receipt", 2, Regex(">\\s*${SteerDelivery.PUT_BACK}\\s*<").findAll(web).count())
        assertTrue(web.contains("\"${SteerDelivery.COULDNT_DISCARD}\""))
        // Why a steer did not land, each code to its words (web `deliveryFailureExplanation`), and the server's reason for any other.
        val explanation = web.substringAfter("export function deliveryFailureExplanation(").substringBefore("\n}\n")
        val codes = listOf("CURRENT_WORK_TARGET_COMPLETED", "CURRENT_WORK_INTERRUPTED", "CURRENT_WORK_SESSION_ENDED", "CURRENT_WORK_SESSION_FINALIZED",
            "CURRENT_WORK_SESSION_REAPED", "CURRENT_WORK_RUNTIME_REJECTED")
        codes.forEach { code ->
            val words = SteerDelivery.failureExplanation(code, "the server's reason")!!
            assertTrue("the web says \"$words\" for $code",
                Regex("case '$code':\\s*(?:case '[A-Z_]+':\\s*)*return '${Regex.escape(words)}';").containsMatchIn(explanation))
        }
        assertEquals("no code the web explains is left to the server's reason here", codes.size, Regex("case '").findAll(explanation).count())
        assertEquals("the server's reason", SteerDelivery.failureExplanation("CURRENT_WORK_SOMETHING_NEW", "the server's reason"))
        assertNull(SteerDelivery.failureExplanation(null, null))
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
