package io.orbitd.android.tasks

import io.orbitd.android.taskprojects.SharePanelCopy
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/** Every word the Android Tasks pages share with iOS is the pinned Swift source's, byte for byte:
 * two clients naming one thing differently is how a reader decides one of them is wrong. Each copy
 * object's String constants and String-valued maps must appear as a literal in the named sources. */
class TaskCopyParityTest {
    private val root = generateSequence(File(System.getProperty("user.dir"))) { it.parentFile }
        .first { File(it, "src/macos/OrbitKit/Sources/OrbitKit").isDirectory }
    private fun swift(vararg paths: String) = paths.joinToString("\n") { File(root, it).readText() }
        // `"a" + "b"` across lines is one literal to a reader.
        .replace(Regex("\"\\s*\\+\\s*\""), "")
    private val kit = "src/macos/OrbitKit/Sources/OrbitKit/App/"
    private val views = "src/macos/OrbitApp/Sources/OrbitApp/Views/"

    private fun strings(owner: Any): Map<String, String> = owner.javaClass.declaredFields
        .flatMap { field ->
            field.isAccessible = true
            when (val value = runCatching { field.get(owner) }.getOrNull()) {
                is String -> listOf("${field.name}" to value)
                is Map<*, *> -> value.map { (k, v) -> "${field.name}[$k]" to v.toString() }
                else -> emptyList()
            }
        }.toMap()

    private fun assertIn(owner: Any, source: String) {
        val missing = strings(owner).filterValues { !source.contains("\"$it\"") }
        assertTrue("${owner.javaClass.simpleName} strings not in the Swift source: $missing", missing.isEmpty())
    }

    @Test fun taskListWordsAreTheListsOwn() = assertIn(TaskListCopy, swift("${kit}TaskListCopy.swift", "${views}TasksView.swift", "${views}TaskListParts.swift"))
    @Test fun taskDetailWordsAreTheDetailsOwn() = assertIn(TaskDetailCopy, swift("${kit}TaskDetailPage.swift", "${views}TasksView.swift"))
    @Test fun reopenWords() = assertIn(TaskReopenCopy, swift("${kit}TaskReopen.swift"))
    @Test fun judgmentWords() = assertIn(TaskJudgmentCopy, swift("${kit}TaskJudgment.swift"))
    @Test fun ownerConfirmationWords() = assertIn(OwnerConfirmationCopy, swift("${kit}OwnerConfirmation.swift"))
    @Test fun runHandoffWords() = assertIn(TaskRunHandoff, swift("${kit}TaskRunHandoff.swift"))
    @Test fun shareWords() = assertIn(SharePanelCopy, swift("${kit}SharePanel.swift"))
    @Test fun markdownWords() = assertIn(TaskMarkdown, swift("${kit}ShareMarkdown.swift"))
}
