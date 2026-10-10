package io.orbitd.android.directory

import java.io.File
import java.time.Instant
import kotlinx.serialization.json.*
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** A project row and its sessions page say main's iOS words (A05-6, A05-7): [SessionProjectCopy]'s every fixed word is declared
 * under its own name in OrbitKit's `SessionProjectCopy.swift`, and every built sentence — rendered here with sentinels, which are put
 * back as Swift's own interpolations — is one literal there. A missing counterpart is a failure, never a skip. */
class SessionProjectCopyParityTest {
    private val root = generateSequence(File(System.getProperty("user.dir"))) { it.parentFile }
        .first { File(it, "src/macos/OrbitKit/Sources/OrbitKit").isDirectory }
    private val copy = File(root, "src/macos/OrbitKit/Sources/OrbitKit/App/SessionProjectCopy.swift").readText()
    private val page = File(root, "src/macos/OrbitApp/Sources/OrbitApp/Views/SessionProjectPage.swift").readText()
    private val projects = File(root, "src/macos/OrbitKit/Sources/OrbitKit/Models/Projects.swift").readText()

    private val count = 23

    private fun assertDeclares(name: String, value: String) =
        assertTrue("SessionProjectCopy.swift no longer declares $name as \"$value\"", copy.contains("static let $name = \"$value\""))
    private fun assertSentence(source: String, rendered: String, vararg values: Pair<String, String>) {
        val template = values.fold(rendered) { text, (from, to) -> text.replace(from, to) }
        assertTrue("the Swift no longer contains \"$template\"", source.contains("\"$template\""))
    }

    @Test fun everyFixedWordIsDeclaredUnderItsSwiftName() {
        listOf("noCoordinator" to SessionProjectCopy.noCoordinator, "openSession" to SessionProjectCopy.openSession, "sessions" to SessionProjectCopy.sessions,
            "openProject" to SessionProjectCopy.openProject, "pin" to SessionProjectCopy.pin, "unpin" to SessionProjectCopy.unpin, "move" to SessionProjectCopy.move,
            "pageSubtitleLoading" to SessionProjectCopy.pageSubtitleLoading, "coordinatorSection" to SessionProjectCopy.coordinatorSection,
            "startReview" to SessionProjectCopy.startReview, "startNotAsked" to SessionProjectCopy.startNotAsked, "startHint" to SessionProjectCopy.startHint,
        ).forEach { (name, value) -> assertDeclares(name, value) }
        val declared = SessionProjectCopy::class.java.declaredFields.filter { it.type == String::class.java }.map { it.isAccessible = true; it.get(null) as String }
        assertEquals("a SessionProjectCopy word is not held above", 12, declared.size)
    }

    @Test fun everyBuiltSentenceIsOneSwiftLiteral() {
        assertSentence(copy, SessionProjectCopy.progress(count, count + 1), "$count/${count + 1}" to "\\(done)/\\(total)")
        assertSentence(copy, SessionProjectCopy.waitingSession("§1", "§2"), "§1" to "\\(text)", "§2" to "\\(title)")
        assertSentence(copy, SessionProjectCopy.pageSubtitle(count), "$count" to "\\(sessions)")
        assertSentence(copy, SessionProjectCopy.pageProgress(count, count + 1, count + 2), "$count/" to "\\(done)/", "${count + 1} done" to "\\(total) done",
            "${count + 2} running" to "\\(running) running")
        assertSentence(copy, SessionProjectCopy.pageNotStarted(count), "$count tasks" to "\\(tasks) \\(tasks == 1 ? \"task\" : \"tasks\")")
        assertEquals("Not started · 1 task", SessionProjectCopy.pageNotStarted(1))
        assertSentence(copy, SessionProjectCopy.startAsked("§"), "§" to "\\(ago)")
        // The start suggestion names the main branch the start opens with: MainBranchCopyTest holds it to the web's sessionProjects.ts.
        assertEquals("Directly into main · Automatic off · 2 at a time",
            SessionProjectCopy.startSuggestion(buildJsonObject { put("line", "MAIN"); put("automatic", false); put("maxConcurrentTasks", 2) }))
        assertSentence(copy, SessionProjectCopy.landingSilentWord(count), "$count" to "\\($0)")
        assertSentence(copy, SessionProjectCopy.landingSilentWord(null))
    }

    /** The landing line's words: the count a server sends alone, several jobs, and the job's own state words. */
    @Test fun theLandingLinesWordsAreTheSwifts() {
        val now = Instant.parse("2026-10-05T11:24:00Z")
        val counted = SessionProjectCopy.landingLine(buildJsonObject { put("activeJobCount", count) }, now)!!.text
        assertSentence(copy, counted, "$count jobs" to "\\(count) \\(count == 1 ? \"job\" : \"jobs\")")
        val several = SessionProjectCopy.landingLine(buildJsonObject { put("activeJobCount", count)
            putJsonObject("inFlight") { put("state", "QUEUED"); put("startedAt", "2026-10-05T11:20:00Z"); put("kind", "SOMETHING_NEW") } }, now)!!.text
        assertEquals("Integration $count jobs · queued · 4m", several)
        assertSentence(copy, "Integration $count jobs", "Integration" to "\\(word)", "$count" to "\\(count)")
        listOf("Integration", "queued", "running").forEach { assertTrue("SessionProjectCopy.swift no longer says \"$it\"", copy.contains("\"$it\"")) }
    }

    @Test fun theCoordinatorLeadsAreTheSwifts() {
        mapOf("integrationConflict" to "INTEGRATION_CONFLICT", "integrationCheckFailed" to "INTEGRATION_CHECK_FAILED", "integrationError" to "INTEGRATION_ERROR",
            "taskFailed" to "TASK_FAILED", "deliveryReview" to "DELIVERY_REVIEW").forEach { (case, kind) ->
            val words = SessionProjectCopy.coordinatorLead(kind) ?: throw AssertionError("no words for $kind")
            assertTrue("SessionProjectCopy.swift no longer says \"$words\" for .$case", copy.contains("case .$case: return \"$words\""))
        }
    }

    /** A project row read aloud, and the status a row says without the sidebar (`ProjectStatus.label`). */
    @Test fun theRowsSpokenWordsAreTheSwifts() {
        val row = SessionProjectRow("p1", "Launch", "DONE", emptyList(), 0, null, null, null, null, null, false, false, false, null,
            SessionLine("x", SessionLine.Tone.PREVIEW), SessionProjectRow.Target.Project("p1"), null, 0)
        listOf(SessionProjectRow.Indicator.NEEDS_YOU, SessionProjectRow.Indicator.RUNNING, SessionProjectRow.Indicator.JOBS).forEach {
            val words = SessionProjectCopy.statusWords(row.copy(indicator = it))
            assertTrue("SessionProjectPage.swift no longer says \"$words\"", page.contains("return \"$words\""))
        }
        mapOf("open" to "OPEN", "done" to "DONE", "cancelled" to "CANCELLED", "unknown" to "SOMETHING_NEW").forEach { (case, status) ->
            assertTrue(projects.contains("case .$case: return \"${SessionProjectCopy.statusLabel(status)}\""))
        }
        assertEquals("Done", SessionProjectCopy.statusWords(row))
    }
}
