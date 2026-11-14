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

    /** `key: 'value',` and `key: (…) => …'value'…` lines of COORDINATOR_HANDOFF_COPY. */
    private fun constant(key: String): String {
        val copy = shared.substringAfter("export const COORDINATOR_HANDOFF_COPY = {")
        val match = Regex("""(?m)^\s*$key: '((?:[^'\\]|\\.)*)',""").find(copy)
        assertNotNull("COORDINATOR_HANDOFF_COPY.$key is not a plain string", match)
        return match!!.groupValues[1].replace("\\'", "'")
    }

    @Test fun everyConstantIsTheSharedOnesWordForWord() {
        listOf(
            "confirmTitle" to CoordinatorHandoffCopy.CONFIRM_TITLE,
            "noteRowTitle" to CoordinatorHandoffCopy.NOTE_ROW_TITLE,
            "noteRowDetail" to CoordinatorHandoffCopy.NOTE_ROW_DETAIL,
            "cancel" to CoordinatorHandoffCopy.CANCEL,
            "handOver" to CoordinatorHandoffCopy.HAND_OVER,
            "badgeHandingOver" to CoordinatorHandoffCopy.BADGE_HANDING_OVER,
            "writing" to CoordinatorHandoffCopy.WRITING,
            "skipNote" to CoordinatorHandoffCopy.SKIP_NOTE,
            "cancelHandover" to CoordinatorHandoffCopy.CANCEL_HANDOVER,
            "handingOver" to CoordinatorHandoffCopy.HANDING_OVER,
            "noteCardTitle" to CoordinatorHandoffCopy.NOTE_CARD_TITLE,
            "handedOver" to CoordinatorHandoffCopy.HANDED_OVER,
            "openIt" to CoordinatorHandoffCopy.OPEN_IT,
            "tryAgain" to CoordinatorHandoffCopy.TRY_AGAIN,
            "handOverWithoutNote" to CoordinatorHandoffCopy.HAND_OVER_WITHOUT_NOTE,
            "keepThisCoordinator" to CoordinatorHandoffCopy.KEEP_THIS_COORDINATOR,
        ).forEach { (key, kotlin) -> assertEquals(key, constant(key), kotlin) }
    }

    @Test fun theTemplatesAreTheSharedOnes() {
        assertTrue(shared.contains("`This coordinator writes a handoff note, then \${projectTitle} continues in a new conversation that starts from that note. This one is completed — nothing is deleted.`"))
        assertEquals("This coordinator writes a handoff note, then Checkout redesign continues in a new conversation that starts from that note. This one is completed — nothing is deleted.",
            CoordinatorHandoffCopy.confirmBody("Checkout redesign"))
        assertTrue(shared.contains("`After the current turn ends, this coordinator writes a handoff note, then \${projectTitle} continues in a new conversation that starts from that note. This one is completed — nothing is deleted.`"))
        assertEquals("After the current turn ends, this coordinator writes a handoff note, then Checkout redesign continues in a new conversation that starts from that note. This one is completed — nothing is deleted.",
            CoordinatorHandoffCopy.confirmBodyWhileRunning("Checkout redesign"))
        assertTrue(shared.contains("(count === 1 ? '1 pending wait moves over' : `\${count} pending waits move over`)"))
        assertTrue(shared.contains("(count === 1 ? '1 wait moved here' : `\${count} waits moved here`)"))
        assertTrue(shared.contains("`The handoff note wasn't written: \${COORDINATOR_HANDOFF_FAILURE_REASONS[code]}`"))
    }

    @Test fun theFailureReasonsAndTheSectionsAreTheSharedOnes() {
        val reasons = shared.substringAfter("COORDINATOR_HANDOFF_FAILURE_REASONS").substringBefore("};")
        val parsed = Regex("""(\w+): '([^']*)',""").findAll(reasons).associate { it.groupValues[1] to it.groupValues[2] }
        assertEquals(parsed, CoordinatorHandoffCopy.FAILURE_REASONS)
        val sections = shared.substringAfter("COORDINATOR_HANDOFF_SECTIONS = [").substringBefore("]")
        assertEquals(Regex("'([^']*)'").findAll(sections).map { it.groupValues[1] }.toList(), CoordinatorHandoff.SECTIONS)
    }

    @Test fun theNotePromptsHeadIsTheServers() {
        val server = File(root, "src/apiserver/src/projects/coordinator-handoff.ts").readText()
        assertTrue(server.contains("'${CoordinatorHandoffCopy.NOTE_PROMPT_HEAD}',"))
    }

    /** Board 03 (Android 1 and 2), verbatim. */
    @Test fun theDialogsRowsAreBoard03s() {
        assertEquals("Compact", CoordinatorHandoffCopy.COMPACT)
        assertEquals("Summarize earlier turns and keep going here.", CoordinatorHandoffCopy.COMPACT_DETAIL)
        assertEquals("Available when this turn ends.", CoordinatorHandoffCopy.COMPACT_WHILE_RUNNING)
        assertEquals("Start a new coordinator", CoordinatorHandoffCopy.START_NEW_COORDINATOR)
        assertEquals("This one writes a handoff note, then the project continues in a fresh conversation.", CoordinatorHandoffCopy.START_NEW_COORDINATOR_DETAIL)
        assertEquals("/compact", CoordinatorHandoffCopy.COMPACT_COMMAND)
    }
}
