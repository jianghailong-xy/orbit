package io.orbitd.android.composer

import org.junit.Assert.*
import org.junit.Test
import java.io.File

/**
 * The handoff's words are board 02's as `COORDINATOR_HANDOFF_COPY` and `COORDINATOR_HANDOFF_FAILURE_REASONS` hold them
 * (src/shared/src/coordinator-handoff.ts), read as text; the note prompt's head is the server's (apiserver coordinator-handoff.ts);
 * board 03's rows are its own words. A missing file fails, never skips.
 */
class CoordinatorHandoffCopyParityTest {
    private val root: File by lazy {
        generateSequence(File(System.getProperty("user.dir"))) { it.parentFile }
            .firstOrNull { File(it, "src/shared/src/coordinator-handoff.ts").isFile }
            .also { assertNotNull("the repository root was not found above the test's working directory", it) }!!
    }
    private val shared by lazy { File(root, "src/shared/src/coordinator-handoff.ts").readText() }

    /** Single- or double-quoted constants in COORDINATOR_HANDOFF_COPY. */
    private fun constant(key: String): String {
        val copy = shared.substringAfter("export const COORDINATOR_HANDOFF_COPY = {")
        val match = Regex("""(?m)^\s*$key: (?:'((?:[^'\\]|\\.)*)'|"([^"]*)"),""").find(copy)
        assertNotNull("COORDINATOR_HANDOFF_COPY.$key is not a plain string", match)
        return match!!.groupValues[1].replace("\\'", "'").ifEmpty { match.groupValues[2] }
    }

    @Test fun everyConstantIsTheSharedOnesWordForWord() {
        listOf(
            "confirmTitle" to CoordinatorHandoffCopy.CONFIRM_TITLE,
            "cancel" to CoordinatorHandoffCopy.CANCEL,
            "handOver" to CoordinatorHandoffCopy.HAND_OVER,
            "badgeHandingOver" to CoordinatorHandoffCopy.BADGE_HANDING_OVER,
            "writing" to CoordinatorHandoffCopy.WRITING,
            "compacting" to CoordinatorHandoffCopy.COMPACTING,
            "skipNote" to CoordinatorHandoffCopy.SKIP_NOTE,
            "cancelHandover" to CoordinatorHandoffCopy.CANCEL_HANDOVER,
            "handingOver" to CoordinatorHandoffCopy.HANDING_OVER,
            "noteCardTitle" to CoordinatorHandoffCopy.NOTE_CARD_TITLE,
            "handedOver" to CoordinatorHandoffCopy.HANDED_OVER,
            "openIt" to CoordinatorHandoffCopy.OPEN_IT,
            "openPrevious" to CoordinatorHandoffCopy.OPEN_PREVIOUS,
            "tryAgain" to CoordinatorHandoffCopy.TRY_AGAIN,
            "handOverWithoutNote" to CoordinatorHandoffCopy.HAND_OVER_WITHOUT_NOTE,
            "keepThisCoordinator" to CoordinatorHandoffCopy.KEEP_THIS_COORDINATOR,
            "successorRowTitle" to CoordinatorHandoffCopy.SUCCESSOR_ROW_TITLE,
            "successorKeep" to CoordinatorHandoffCopy.SUCCESSOR_KEEP,
            "successorRowDetail" to CoordinatorHandoffCopy.SUCCESSOR_ROW_DETAIL,
        ).forEach { (key, kotlin) -> assertEquals(key, constant(key), kotlin) }
    }

    @Test fun theTemplatesAreTheSharedOnes() {
        // The phones' confirm body (`coordinatorHandoffPhoneConfirmBody`, which OrbitKit's `phoneConfirmBody` is pinned to as well).
        val lead = CoordinatorHandoffCopy.phoneConfirmBody(0, running = false).substringBefore(", then")
        val runningLead = CoordinatorHandoffCopy.phoneConfirmBody(0, running = true).substringBefore(", then")
        assertTrue(shared.contains("const lead = running ? '$runningLead' : '$lead';"))
        assertTrue(shared.contains("const moves = waits > 0 ? ` \${COORDINATOR_HANDOFF_COPY.waitsRowTitle(waits)}.` : '';"))
        val tail = CoordinatorHandoffCopy.phoneConfirmBody(0, running = false).removePrefix(lead).replace(" Nothing is deleted.", "\${moves} Nothing is deleted.")
        assertTrue(shared.contains("return `\${lead}$tail`;"))
        assertEquals("This coordinator writes a handoff note, then the project continues in a new conversation. 2 pending waits move over. Nothing is deleted.",
            CoordinatorHandoffCopy.phoneConfirmBody(2, running = false))
        // A refused press: web's toast title is the line's lead (double-quoted there for its apostrophe).
        assertTrue(shared.contains("refused: \"${CoordinatorHandoffCopy.REFUSED}\","))
        assertTrue(shared.contains("(count === 1 ? '1 pending wait moves over' : `\${count} pending waits move over`)"))
        assertTrue(shared.contains("(count === 1 ? '1 wait moved here' : `\${count} waits moved here`)"))
        assertTrue(shared.contains("`The handoff note wasn't written: \${COORDINATOR_HANDOFF_FAILURE_REASONS[code]}`"))
    }

    @Test fun historyBeforeMatchesSharedTemplate() {
        val template = shared.substringAfter("historyBefore:").substringBefore("openPrevious:")
        assertTrue(template.contains("decisions === 0 && merges === 0"))
        assertTrue(template.contains("decisions === 1 ? 'decision' : 'decisions'"))
        assertTrue(template.contains("merges === 1 ? 'merge' : 'merges'"))
        val kotlin = CoordinatorHandoffCopy.historyBefore(12, 3)!!
            .replace("12", "\${decisions}").replace("decisions and", "\${decisions === 1 ? 'decision' : 'decisions'} and")
            .replace("3", "\${merges}").replace("merges before", "\${merges === 1 ? 'merge' : 'merges'} before")
        assertTrue(template.contains("`$kotlin`"))
        assertNull(CoordinatorHandoffCopy.historyBefore(0, 0))
    }

    @Test fun theFailureReasonsAndTheSectionsAreTheSharedOnes() {
        val reasons = shared.substringAfter("COORDINATOR_HANDOFF_FAILURE_REASONS").substringBefore("};")
        val parsed = Regex("""(\w+): '([^']*)',""").findAll(reasons).associate { it.groupValues[1] to it.groupValues[2] }
        assertEquals(parsed, CoordinatorHandoffCopy.FAILURE_REASONS)
        val sections = shared.substringAfter("COORDINATOR_HANDOFF_SECTIONS = [").substringBefore("]")
        assertEquals(Regex("'([^']*)'").findAll(sections).map { it.groupValues[1] }.toList(), CoordinatorHandoff.SECTIONS)
    }

    /** The shared constant where src/shared holds it (the web task moved it there), the server's literal before that. */
    @Test fun theNotePromptsHeadIsTheServers() {
        val server = File(root, "src/apiserver/src/projects/coordinator-handoff.ts").readText()
        val head = CoordinatorHandoffCopy.NOTE_PROMPT_HEAD
        assertTrue(shared.contains("export const COORDINATOR_HANDOFF_PROMPT_HEAD = '$head';") || server.contains("'$head',"))
        if (shared.contains("COORDINATOR_HANDOFF_PROMPT_HEAD")) {
            assertTrue(shared.contains("export const COORDINATOR_HANDOFF_PROMPT_HEAD = '$head';"))
            assertTrue(server.contains("COORDINATOR_HANDOFF_PROMPT_HEAD,"))
        }
    }

    /** Board 03 (Android 1 and 2), verbatim. */
    @Test fun theDialogsRowsAreBoard03s() {
        assertEquals("Compact", CoordinatorHandoffCopy.COMPACT)
        assertEquals("Summarize earlier turns and keep going here.", CoordinatorHandoffCopy.COMPACT_DETAIL)
        assertEquals("Available when this turn ends.", CoordinatorHandoffCopy.COMPACT_WHILE_RUNNING)
        assertEquals("Start a new coordinator", CoordinatorHandoffCopy.START_NEW_COORDINATOR)
        assertEquals("This one writes a handoff note, then the project continues in a fresh conversation.", CoordinatorHandoffCopy.START_NEW_COORDINATOR_DETAIL)
        // Not on board 03; the line web (CONTEXT_ACTIONS_COPY) and OrbitKit (newCoordinatorWhileRunning) show while a turn runs.
        assertEquals("Begins after this turn ends: a handoff note, then a fresh conversation.", CoordinatorHandoffCopy.START_NEW_COORDINATOR_WHILE_RUNNING)
        assertEquals("/compact", CoordinatorHandoffCopy.COMPACT_COMMAND)
    }
}
