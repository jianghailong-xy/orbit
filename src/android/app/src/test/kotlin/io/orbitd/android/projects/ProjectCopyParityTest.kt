package io.orbitd.android.projects

import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

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
    @Test fun runSettingsWords() = assertIn(RunSettings, swift("${kit}ProjectRunSettings.swift", "${kit}StartProject.swift"))
    @Test fun markdownWords() = assertIn(ProjectMarkdown, swift("${kit}ShareMarkdown.swift"))
    @Test fun attentionWords() {
        val source = swift("${kit}ProjectAttention.swift")
        // The one composed chip: Swift interpolates the start's own word, and so does Kotlin.
        assertIn(ProjectAttention, source, composed = setOf("readyToStartSays"))
        assertTrue(source.contains("\"Needs you · \\(StartProject.readyToStart)\""))
        assertTrue(ProjectAttention.readyToStartSays == "Needs you · ${StartProjectCopy.readyToStart}")
        val lanes = ProjectLane.entries.flatMap { listOf(it.title, it.note) }.filter { !source.contains("\"$it\"") }
        assertTrue("lane words not in ProjectAttention.swift: $lanes", lanes.isEmpty())
    }
}
