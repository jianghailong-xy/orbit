package io.orbitd.android.composer

import io.orbitd.android.composer.CursorRuntime.RunnerState
import io.orbitd.android.management.CursorCopy
import io.orbitd.android.reader.AutoRetryLogic
import org.junit.Assert.*
import org.junit.Test
import java.io.File

/**
 * Cursor CLI's words on Android are the web's (P7a), read out of the sources that say them there — `lib/cursorRuntime.ts`,
 * `components/RunnerSignIn.tsx`, `components/RunnerEngines.tsx` and `components/Transcript.tsx` — with the web's names for Cursor CLI and
 * its pinned build put back as words. A missing source fails, never skips.
 */
class CursorCopyParityTest {
    private val root: File by lazy {
        val found = generateSequence(File(System.getProperty("user.dir"))) { it.parentFile }.firstOrNull { File(it, "src/web/src").isDirectory }
        assertNotNull("the repository root was not found above the test's working directory", found)
        found!!
    }
    private val web by lazy {
        listOf("lib/cursorRuntime.ts", "components/RunnerSignIn.tsx", "components/RunnerEngines.tsx", "components/Transcript.tsx").joinToString("\n") { path ->
            File(root, "src/web/src/$path").also { assertTrue("$path is missing", it.isFile) }.readText()
        }.replace("\${CURSOR_CLI}", CursorRuntime.CLI).replace("\${CURSOR_PINNED_VERSION}", CursorRuntime.PINNED_VERSION)
            .replace("<b>${CursorCopy.SITE}</b>", CursorCopy.SITE)
    }

    @Test fun theComposerAndTheMachinesSayWhatTheWebSays() {
        val words = listOf(CursorRuntime.MOVE_BLOCKED_NOTE, CursorRuntime.QUEUE_NOTE, CursorRuntime.RUNNING_PLACEHOLDER,
            CursorRuntime.CONTEXT_UNAVAILABLE) + RunnerState.entries.mapNotNull { it.label } +
            listOf(RunnerState.UPDATE_RUNNER, RunnerState.UNSUPPORTED_VERSION, RunnerState.UNSUPPORTED_PLATFORM).map { CursorRuntime.hint(it, null)!! }
        words.forEach { assertTrue("the web says \"$it\"", web.contains(it)) }
        // Auto's note, but for context, which the web — with no Context row in its menu yet — leaves out.
        val auto = CursorRuntime.AUTO_NOTE
        assertTrue("the web says \"$auto\"", web.contains(auto) || web.contains(auto.replace(" or context", "")))
    }

    @Test fun theSignInLinkAndTheUsageSayWhatTheWebSays() {
        val words = listOf(CursorCopy.signInLead(adding = true, again = false), CursorCopy.signInLead(adding = false, again = true),
            CursorCopy.signInLead(adding = false, again = false), CursorCopy.OPEN_SITE, CursorCopy.WAITING, CursorCopy.expiry(0),
            CursorCopy.USAGE_UNAVAILABLE, AutoRetryLogic.cursorLine(AutoRetryLogic.CursorQuota("Default"), "").substringBefore("Upgrade"))
        words.forEach { assertTrue("the web says \"$it\"", web.contains(it)) }
        assertEquals("link expires in 26 min", CursorCopy.expiry(26))
        assertTrue(web.contains("link expires in \${left} min"))
        // The quota card's way to another account, around its name.
        AutoRetryLogic.cursorElsewhere("Team").toList().map { it.substringBefore("Team") }.forEach { assertTrue("the web says \"$it\"", web.contains(it)) }
        // The link's buttons are the web's words in the board's title case (iOS 3).
        listOf(CursorCopy.COPY_LINK, CursorCopy.LINK_COPIED, CursorCopy.GET_A_NEW_LINK).forEach {
            assertTrue("the web says \"$it\"", web.contains("'$it'", ignoreCase = true))
        }
    }
}
