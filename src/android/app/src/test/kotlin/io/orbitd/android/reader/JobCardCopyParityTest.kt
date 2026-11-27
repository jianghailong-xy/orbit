package io.orbitd.android.reader

import io.orbitd.android.core.cards.BgJob
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * The Job card says what the web's says (board 350t1lTONlrPMjilBdXx7; web `JobCard.tsx` and `lib/bgJobCard.ts`, which landed first): every
 * word [BgJob] draws is a literal, a template or JSX text there. A missing counterpart is a failure, never a skip.
 */
class JobCardCopyParityTest {
    private val root = generateSequence(File(System.getProperty("user.dir"))) { it.parentFile }
        .first { File(it, "src/web/src/components/JobCard.tsx").isFile }
    private val card = File(root, "src/web/src/components/JobCard.tsx").readText()
    private val lib = File(root, "src/web/src/lib/bgJobCard.ts").readText()
    private val tray = File(root, "src/web/src/components/BackgroundShellsTray.tsx").readText()

    private fun has(source: String, name: String, literal: String) = assertTrue("$name no longer contains $literal", source.contains(literal))

    @Test fun everyWordIsTheWebs() {
        has(lib, "bgJobCard.ts", "export const BG_RUN_TOOL = '${BgJob.TOOL}';")
        has(card, "JobCard.tsx", BgJob.showFullOutput)
        has(card, "JobCard.tsx", "title=\"${BgJob.stopTitle}\"")
        has(card, "JobCard.tsx", "confirmText=\"${BgJob.stop}\"")
        has(tray, "BackgroundShellsTray.tsx", "title=\"${BgJob.stopTitle}\"")
        has(card, "JobCard.tsx", "<summary>${BgJob.whatTheAgentRead}</summary>")
        has(card, "JobCard.tsx", "'${BgJob.newOutput}'")
        has(card, "JobCard.tsx", "'${BgJob.killed}'")
        has(card, "JobCard.tsx", "quiet {formatSpan(state.quietMs)}")
        has(card, "JobCard.tsx", "exit {state.exitCode}")
        has(card, "JobCard.tsx", "Show all {lines.length} lines")
        has(card, "JobCard.tsx", "Woke the agent {wakes.length} {wakes.length === 1 ? 'time' : 'times'}")
        has(card, "JobCard.tsx", "`read by the agent at \${clock(wake.readAt)}`")
        has(card, "JobCard.tsx", "`started \${clock(")
        has(card, "JobCard.tsx", "`ran \${elapsed}`")
        has(card, "JobCard.tsx", "`on \${host.where}`")
        has(card, "JobCard.tsx", "export const TAIL_PACE_MS = 5_000;")
        has(card, "JobCard.tsx", "export const TAIL_RETRY_MS = 30_000;")
        has(card, "JobCard.tsx", "const OPEN_LINES = ${BgJob.OPEN_LINES};")
        assertEquals(5_000L, BgJob.TAIL_PACE_MS); assertEquals(30_000L, BgJob.TAIL_RETRY_MS)
        assertEquals("Cancel", BgJob.cancel) // Popconfirm's own default cancelText
        has(File(root, "src/web/src/components/ui/Popconfirm.tsx").readText(), "Popconfirm.tsx", "cancelText = '${BgJob.cancel}'")
    }

    @Test fun everyKilledLineIsTheWebs() {
        listOf("requested", "stopped_by_owner", "runner_shutdown", "session_cancelled", "not_allowed").forEach { reason ->
            val line = BgJob.killedBy(reason)!!
            has(lib, "bgJobCard.ts", if ('\'' in line) "\"$line\"" else "'$line'")
        }
    }

    @Test fun theElapsedTimeAndTheTwoLineHeaderFollowTheWeb() {
        has(lib, "bgJobCard.ts", "if (minutes >= 20) return `\${minutes}m`;")
        has(lib, "bgJobCard.ts", "padStart(2, '0')")
        // R4: at phone width the kind and the run time leave the first line for a second one; the web's PHONE_QUERY is that breakpoint.
        val query = File(root, "src/web/src/lib/useMediaQuery.ts").readText()
        has(query, "useMediaQuery.ts", "PHONE_QUERY")
        assertTrue("the web breakpoint names ${PHONE_WIDTH_DP}px", Regex("PHONE_QUERY\\s*=\\s*'\\(max-width:\\s*(\\d+)px\\)'").find(query)
            ?.groupValues?.get(1)?.toInt() == PHONE_WIDTH_DP)
    }
}
