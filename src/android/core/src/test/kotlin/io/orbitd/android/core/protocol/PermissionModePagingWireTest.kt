package io.orbitd.android.core.protocol

import io.orbitd.android.core.cards.PermissionModeDisplay
import java.time.Instant
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.*
import org.junit.Test

/**
 * A session with more mode changes than its detail carries, as a real apiserver on PostgreSQL answered it (resources/wire/
 * permission-mode/paging, made by scripts/permission-mode-actual-stack/capture-paging.mjs): the detail's newest 50 and the two
 * pages before them, read the way the reader reads them — detail first, then each page through [ModeChangeHistory].
 */
class PermissionModePagingWireTest {
    private fun fixture(name: String) = Wire.json.parseToJsonElement(
        javaClass.getResourceAsStream("/wire/permission-mode/paging/$name.json")!!.use { it.readBytes() }.decodeToString()).jsonObject

    private val detail = fixture("session-paging")
    private val pages = listOf(fixture("session-paging-page-1"), fixture("session-paging-page-2"))

    @Test fun theDetailCarriesTheNewestFiftyAndSaysOlderOnesAreRecorded() {
        val changes = PermissionModes.changes(detail)
        assertEquals(50, changes.size)
        // Every entry the server sent was read, each with its seq.
        assertEquals((detail["permissionModeChanges"] as JsonArray).size, changes.size)
        assertTrue(changes.all { it.seq != null })
        assertTrue(PermissionModes.changesHasMore(detail))
        assertEquals(changes.last().toMode, PermissionModes.actual(detail))
    }

    @Test fun thePagesBeforeItReachTheFirstChangeEachOnceInOrderWithWhoMadeIt() {
        var held = ModeChangeHistory().adopt(PermissionModes.changes(detail), PermissionModes.changesHasMore(detail))
        val asked = mutableListOf<Long>()
        for (body in pages) {
            // The window has reached the session's start, so every older page is read, from the oldest held.
            assertTrue(held.needsOlder(oldestEventTs = held.changes.first().at, reachesStart = true))
            val before = held.changes.first().seq!!
            asked += before
            val page = PermissionModes.page(body)
            assertEquals((body["changes"] as JsonArray).size, page.changes.size)
            held = held.withOlder(before, page)
        }
        assertFalse(held.hasMore)
        assertFalse(held.needsOlder(oldestEventTs = held.changes.first().at, reachesStart = true))
        assertEquals(listOf(50, 11), pages.map { PermissionModes.page(it).changes.size })
        assertTrue(PermissionModes.page(pages[0]).hasMore)
        assertFalse(PermissionModes.page(pages[1]).hasMore)

        val all = held.changes
        assertEquals(111, all.size)
        val seqs = all.map { it.seq!! }
        assertEquals("each once", seqs.size, seqs.toSet().size)
        assertEquals("in seq order", seqs.sorted(), seqs)
        assertEquals("the pages were asked for from the oldest held", listOf(PermissionModes.changes(detail).first().seq,
            PermissionModes.page(pages[0]).changes.first().seq), asked)
        // In the order it happened: each change starts from the mode the one before it left, and their times never go back.
        assertNull(all.first().fromMode)
        all.zipWithNext().forEach { (a, b) -> assertEquals("${b.seq} follows ${a.seq}", a.toMode, b.fromMode) }
        val times = all.map { Instant.parse(it.at) }
        assertEquals(times.sorted(), times)
        // Who or what made each: the claim, the owner's six picks with the app each came from, then Claude's reports and the
        // runner's corrections.
        assertEquals("CLAIM", all.first().cause)
        assertEquals(List(6) { "OWNER_PICK" }, all.subList(1, 7).map { it.cause })
        assertEquals(listOf("web", "ios", "android", "web", "ios", "android"), all.subList(1, 7).map { it.client })
        assertEquals(List(52) { listOf("ENGINE_REPORT", "RUNNER_CORRECTION") }.flatten(), all.drop(7).map { it.cause })
        assertTrue(all.drop(7).all { it.client == null })
        // Repeated transitions recorded in the same millisecond are still two changes, told apart by their seq.
        val ties = all.zipWithNext().filter { (a, b) -> a.at == b.at }
        assertTrue("some changes share their millisecond", ties.isNotEmpty())
        // Each page's boundary falls inside such a moment: the page continues from the right change by its seq, not its time.
        val detailChanges = PermissionModes.changes(detail)
        val page1 = PermissionModes.page(pages[0]).changes
        val page2 = PermissionModes.page(pages[1]).changes
        assertEquals(page1.last().at, detailChanges.first().at)
        assertEquals(page2.last().at, page1.first().at)
        // Among them the same transition twice at one moment: two Default → Auto corrections, or two Auto → Default reports.
        val sameMoment = all.groupBy { it.at }.values.filter { it.size > 1 }
        assertTrue("one moment holds the same transition twice",
            sameMoment.any { group -> group.groupBy { it.fromMode to it.toMode }.values.any { it.size > 1 } })
    }

    @Test fun everyChangeIsOneLineOfItsOwnInTheTranscript() {
        var held = ModeChangeHistory().adopt(PermissionModes.changes(detail), true)
        for (body in pages) held = held.withOlder(held.changes.first().seq!!, PermissionModes.page(body))
        val lines = PermissionModeDisplay.lines(held.changes, PermissionModes.intent(detail), PermissionModes.actual(detail), null,
            runsAsRoot = false, scheduledOnClaude = false)
        // A report the runner then corrected is said once, by the correction: the claim one line, each pick one, each correction one.
        assertEquals(1 + 6 + 52, lines.size)
        assertEquals(lines.size, lines.map { it.key }.toSet().size)
        assertEquals("Started in Auto", lines.first().text)
        assertEquals(listOf(", on the web", ", on iOS", ", on Android", ", on the web", ", on iOS", ", on Android").map { " by you$it" },
            lines.subList(1, 7).map { it.after })
        assertTrue(lines.drop(7).all { it.text == "Mode set back to Auto by the runner — Claude had started in Default" })
        // Placed among rows by their moment: every line goes somewhere, once.
        val placed = PermissionModeDisplay.place(listOf(held.changes.first().at), lines)
        assertEquals(lines.size, placed.values.sumOf { it.size })
    }
}
