package io.orbitd.android.core.cards

import java.io.File
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class CoordinatorCleanStartTest {
    private val fixture by lazy {
        val root = generateSequence(File(System.getProperty("user.dir"))) { it.parentFile }
            .firstOrNull { File(it, "contracts/coordinator-clean-start.fixtures.json").isFile }
        requireNotNull(root) { "contracts/coordinator-clean-start.fixtures.json was not found" }
        Json.parseToJsonElement(File(root, "contracts/coordinator-clean-start.fixtures.json").readText()).jsonObject
    }
    private fun cases(key: String) = fixture.getValue(key).jsonArray.map { it.jsonObject }
    private val createdAt get() = fixture.getValue("createdAt").jsonPrimitive.content
    private fun stamps(row: JsonObject, key: String) = row.getValue(key).jsonArray.map { it.jsonPrimitive.contentOrNull }

    @Test fun recordsAndOpenItemsMatchSharedPlacementFixtures() {
        val loaded = cases("loaded")
        for (key in listOf("records", "openItems")) cases(key).forEach { row ->
            val expected = row.getValue("expect")
            val placement = if (expected is JsonObject) CoordinatorCleanStart.Placement.After(
                loaded.indexOfFirst { it.text("id") == expected.text("after") }) else when (expected.jsonPrimitive.content) {
                "hidden" -> CoordinatorCleanStart.Placement.Hidden
                "head" -> CoordinatorCleanStart.Placement.Head
                else -> error("Unknown placement: $expected")
            }
            assertEquals(row.text("name"), placement, CoordinatorCleanStart.place(
                if (key == "records") createdAt else null, loaded.map { it.text("ts") }, row.text("stamp")!!))
        }
    }

    @Test fun countsMatchSharedFixtures() {
        cases("counts").forEach { row ->
            val expected = row.getValue("expect").jsonObject
            assertEquals(row.text("name"), CoordinatorCleanStart.Counts(expected.getValue("decisions").jsonPrimitive.int,
                expected.getValue("merges").jsonPrimitive.int), CoordinatorCleanStart.counts(createdAt, stamps(row, "decisions"), stamps(row, "merges")))
        }
    }

    @Test fun noteCopyMatchesSharedFixtures() {
        cases("noteLine").forEach { row ->
            assertEquals(row.getValue("expect").jsonPrimitive.contentOrNull, CoordinatorCleanStart.historyBefore(
                row.getValue("decisions").jsonPrimitive.int, row.getValue("merges").jsonPrimitive.int))
        }
        assertEquals(fixture.text("openPrevious"), CoordinatorCleanStart.openPrevious)
    }

    @Test fun unknownCreationAndMissingRowTimesPreservePlacement() {
        val stamp = "2026-11-16T14:00:00Z"
        assertTrue(CoordinatorCleanStart.drawn(null, stamp))
        assertTrue(CoordinatorCleanStart.drawn("unknown", stamp))
        assertFalse(CoordinatorCleanStart.drawn(null, "unknown"))
        assertEquals(CoordinatorCleanStart.Placement.After(1), CoordinatorCleanStart.place(null, listOf(null, stamp, "unknown"), stamp))
        assertEquals(CoordinatorCleanStart.Counts(0, 0), CoordinatorCleanStart.counts("unknown", listOf(stamp), listOf(stamp)))
    }
}
