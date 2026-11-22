package io.orbitd.android.tasks

import io.orbitd.android.core.cards.TaskExemptCopy
import io.orbitd.android.core.protocol.Wire
import io.orbitd.android.projects.ProjectSettingChange
import io.orbitd.android.reader.LandingStepWords
import java.io.File
import java.time.Instant
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.*
import org.junit.Test

/** A task's landing-check exemption (D5): the four fields the task read carries, who marked it from the project's
 *  `settingChanges`, and every word the new views draw, looked up in the web source they come from. */
class TaskLandingExemptTest {
    private fun json(text: String) = Wire.json.parseToJsonElement(text).jsonObject
    private val now = Instant.parse("2026-11-21T12:00:00Z")

    @Test fun theTaskReadDecodesEveryExemptionField() {
        val exempt = TaskLandingExemption.of(json("""{"id":"t1","landingCheckExempt":true,"landingCheckExemptReason":"docs only",
            "landingCheckExemptBySessionId":"S9","landingCheckExemptOwnerSetAt":"2026-11-21T11:40:00Z"}"""))
        assertEquals(TaskLandingExemption("docs only", "S9", "2026-11-21T11:40:00Z"), exempt)
        // Not exempt, or a server that predates the fields: no exemption at all.
        assertNull(TaskLandingExemption.of(json("""{"id":"t1","landingCheckExempt":false,"landingCheckExemptReason":null}""")))
        assertNull(TaskLandingExemption.of(json("""{"id":"t1"}""")))
        assertNull(TaskLandingExemption.of(null))
        // Exempt with no reason, nulls everywhere else.
        assertEquals(TaskLandingExemption(null, null, null), TaskLandingExemption.of(json("""{"id":"t1","landingCheckExempt":true,
            "landingCheckExemptReason":"","landingCheckExemptBySessionId":null,"landingCheckExemptOwnerSetAt":null}""")))
        assertEquals("""{"landingCheckExempt":false}""", TaskLandingExemption.removeRequest.toString())
    }

    private fun change(id: String, taskId: String = "t1", exempt: Boolean = true, revertedAt: String? = null, origin: String = "COORDINATOR",
        field: String = "TASK_LANDING_CHECK_EXEMPT") = """{"id":"$id","projectId":"P1","taskId":"$taskId","field":"$field","origin":"$origin",
        "oldValue":{"exempt":${!exempt},"reason":null},"newValue":{"exempt":$exempt,"reason":"r"},"reason":"r","revertsChangeId":null,
        "revertedAt":${revertedAt?.let { "\"$it\"" } ?: "null"},"revertible":true,"createdAt":"2026-11-21T11:40:00Z"}"""

    @Test fun whoMarkedItIsTheNewestUnrevertedRecordThatSetIt() {
        val changes = ProjectSettingChange.read(json("""{"settingChanges":[
            ${change("c0", field = "LANDING_CHECK").replace(""""oldValue":{"exempt":false,"reason":null},"newValue":{"exempt":true,"reason":"r"}""",
                """"oldValue":{"command":null,"timeoutSeconds":null,"none":false},"newValue":{"command":"make","timeoutSeconds":null,"none":false}""")},
            ${change("c1", taskId = "t2")},
            ${change("c2", exempt = false)},
            ${change("c3", revertedAt = "2026-11-21T11:50:00Z")},
            ${change("c4", origin = "CARD")},
            ${change("c5")}]}"""))
        val marked = TaskLandingExemption.marked(changes, "t1")!!
        assertEquals("c4", marked.id)
        assertEquals("Approved on a card", marked.originLabel)
        assertEquals("marked 20m ago", TaskLandingExemption.markedLine(marked, now))
        assertNull(TaskLandingExemption.marked(changes, "t3"))
        assertNull(TaskLandingExemption.marked(emptyList(), "t1"))
    }

    /** Every word the two new views draw, as the web's TaskLandingExempt and ProjectLandingsWindow write them. */
    @Test fun theNewViewsWordsAreTheWebs() {
        val root = generateSequence(File(System.getProperty("user.dir"))) { it.parentFile }.first { File(it, "src/web/src/components").isDirectory }
        val exempt = File(root, "src/web/src/components/TaskLandingExempt.tsx").readText()
        // The block draws the label, the badge, the reason, the origin and Remove, in the web's constants.
        listOf("TASK_EXEMPT_COPY.LABEL", "TASK_EXEMPT_COPY.BADGE", "TASK_EXEMPT_COPY.REMOVE", "task.landingCheckExemptReason",
            "LANDING_CHECK_ORIGIN_COPY.COORDINATOR", "LANDING_CHECK_ORIGIN_COPY.CARD", "LANDING_CHECK_ORIGIN_COPY.OWNER").forEach {
            assertTrue("TaskLandingExempt.tsx no longer draws $it", exempt.contains(it))
        }
        assertTrue(exempt.contains("`marked ${'$'}{ago(marked.createdAt, Date.now())}`"))
        assertTrue(exempt.contains("{ landingCheckExempt: false }"))
        assertEquals("""{"landingCheckExempt":false}""", TaskLandingExemption.removeRequest.toString())
        assertEquals(listOf("Landing check", "Exempt", "Remove exemption"), listOf(TaskExemptCopy.label, TaskExemptCopy.badge, TaskExemptCopy.remove))

        val window = File(root, "src/web/src/components/ProjectLandingsWindow.tsx").readText()
        assertTrue(window.contains("`${'$'}{step.name} · ${'$'}{TASK_EXEMPT_COPY.SKIPPED}`"))
        assertTrue(window.contains("exemptCheckReason(landingCheckTaskExempt(step.summary)?.reason ?? '')"))
        assertTrue(window.contains("if (landingCheckTaskExempt(entry)) return { glyph: '→', tone: 'skipped' };"))
        assertEquals("→", LandingStepWords.SKIPPED)
        val page = File(root, "src/android/app/src/main/kotlin/io/orbitd/android/reader/LandingSessionPage.kt").readText()
        assertTrue(page.contains("\"${'$'}{step.name} · ${'$'}{TaskExemptCopy.skipped}\""))
        assertTrue(page.contains("\"→\" to"))
        val session = File(root, "src/web/src/lib/landingSession.ts").readText()
        assertTrue(session.contains("entry.kind !== 'CHECK_FINISHED' || entry.data?.skipped !== 'TASK_EXEMPT'"))
    }
}
