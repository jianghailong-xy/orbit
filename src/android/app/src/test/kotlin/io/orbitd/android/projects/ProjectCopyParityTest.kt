package io.orbitd.android.projects

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.time.Instant

/** Every word the Android Projects pages share with iOS is the pinned Swift source's, byte for byte
 * (`TaskCopyParityTest`'s rule): each copy object's String constants and String-valued maps must appear
 * as a literal in the named sources. */
class ProjectCopyParityTest {
    private val root = generateSequence(File(System.getProperty("user.dir"))) { it.parentFile }
        .first { File(it, "src/macos/OrbitKit/Sources/OrbitKit").isDirectory }
    private fun swift(vararg paths: String) = paths.joinToString("\n") { File(root, it).readText() }
        // `"a" + "b"` across lines, and `out += "b"` after `"a"`, are one sentence to a reader.
        .replace(Regex("\"\\s*\\+\\s*\""), "")
        .replace(Regex("\"\\s*out\\s*\\+=\\s*\""), "")
    private val kit = "src/macos/OrbitKit/Sources/OrbitKit/App/"
    private val views = "src/macos/OrbitApp/Sources/OrbitApp/Views/"

    private fun strings(owner: Any): Map<String, String> = owner.javaClass.declaredFields
        .flatMap { field ->
            field.isAccessible = true
            when (val value = runCatching { field.get(owner) }.getOrNull()) {
                is String -> listOf(field.name to value)
                is Map<*, *> -> value.filterValues { it is String }.map { (k, v) -> "${field.name}[$k]" to v as String }
                else -> emptyList()
            }
        }.toMap()

    private fun assertIn(owner: Any, source: String, composed: Set<String> = emptySet()) {
        val missing = strings(owner).filterKeys { it !in composed }.filterValues { !source.contains("\"$it\"") }
        assertTrue("${owner.javaClass.simpleName} strings not in the Swift source: $missing", missing.isEmpty())
    }

    @Test fun projectPageWords() = assertIn(ProjectPage, swift("${kit}ProjectPage.swift", "${kit}ProjectPageSections.swift", "${views}ProjectsView.swift"))
    @Test fun startWords() = assertIn(StartProjectCopy, swift("${kit}StartProject.swift", "${kit}ProjectRunSettings.swift", "${kit}CriteriaDecision.swift"))
    /** The main branch's own words are new on every client at once: MainBranchCopyTest holds them to the web's projectStart.ts,
     * whose words the Swift parity tests hold OrbitKit's to. */
    @Test fun runSettingsWords() = assertIn(RunSettings, swift("${kit}ProjectRunSettings.swift", "${kit}StartProject.swift"),
        composed = setOf("defaultMainBranch", "mainBranch", "mainBranchHint", "lastChosen", "typeABranch"))
    @Test fun markdownWords() = assertIn(ProjectMarkdown, swift("${kit}ShareMarkdown.swift"))
    @Test fun crossingsWords() = assertIn(ProjectCrossings, swift("${kit}ProjectCrossings.swift"))
    @Test fun doneWords() = assertIn(ProjectDone, swift("${kit}ProjectDone.swift"))
    @Test fun attentionWords() {
        val source = swift("${kit}ProjectAttention.swift")
        // The two composed chips: Swift interpolates the start's and the close's own words, and so does Kotlin.
        assertIn(ProjectAttention, source, composed = setOf("readyToStartSays", "readyToCloseSays"))
        assertTrue(source.contains("\"Needs you · \\(StartProject.readyToStart)\""))
        assertTrue(ProjectAttention.readyToStartSays == "Needs you · ${StartProjectCopy.readyToStart}")
        assertTrue(source.contains("\"Needs you · \\(ProjectDone.readyToClose)\""))
        assertTrue(ProjectAttention.readyToCloseSays == "Needs you · ${ProjectDone.readyToClose}")
        val lanes = ProjectLane.entries.flatMap { listOf(it.title, it.note) }.filter { !source.contains("\"$it\"") }
        assertTrue("lane words not in ProjectAttention.swift: $lanes", lanes.isEmpty())
    }
    /** The coordinator chip's words for what it holds: every kind ProjectAttention.swift's `coordinatorLeadCopy` names — a delivery
     * review included (A05-6, iOS 164d91245) — and the chip they make. */
    @Test fun coordinatorChipWords() {
        val block = swift("${kit}ProjectAttention.swift").substringAfter("private static func coordinatorLeadCopy").substringBefore("\n    }\n")
        val words = Regex("""case \.(\w+): return "([^"]+)"""").findAll(block).associate { it.groupValues[1] to it.groupValues[2] }
        val kinds = mapOf("integrationConflict" to "INTEGRATION_CONFLICT", "integrationCheckFailed" to "INTEGRATION_CHECK_FAILED",
            "integrationError" to "INTEGRATION_ERROR", "taskFailed" to "TASK_FAILED", "deliveryReview" to "DELIVERY_REVIEW")
        assertEquals(kinds.keys, words.keys)
        val now = Instant.parse("2026-10-05T00:00:00Z")
        words.forEach { (case, said) ->
            val project = Json.parseToJsonElement("""{"id":"p","title":"P","status":"OPEN","_count":{"tasks":1},"buckets":{"ready":1},
                "lastActivityAt":"2026-10-04T23:59:00Z","attention":{"coordinatorItems":{"count":1,"leadKind":"${kinds[case]}",
                "oldestWaitingSince":"2026-10-04T23:42:00Z"}}}""").jsonObject
            assertEquals(case, AttentionChip(false, "Coordinator · $said · 18m"), ProjectAttention.chip(project, now))
        }
    }
}
