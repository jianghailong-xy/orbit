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
    private val web = File(root, "src/web/src/lib/sessionProjects.ts").readText()

    private val count = 23

    private fun assertDeclares(name: String, value: String) =
        assertTrue("SessionProjectCopy.swift no longer declares $name as \"$value\"", copy.contains("static let $name = \"$value\""))
    private fun assertSentence(source: String, rendered: String, vararg values: Pair<String, String>) {
        val template = values.fold(rendered) { text, (from, to) -> text.replace(from, to) }
        assertTrue("the Swift no longer contains \"$template\"", source.contains("\"$template\""))
    }

    @Test fun everyFixedWordIsDeclaredUnderItsSwiftName() {
        listOf("noCoordinator" to SessionProjectCopy.noCoordinator, "openSession" to SessionProjectCopy.openSession,
            "complete" to SessionProjectCopy.complete, "sessions" to SessionProjectCopy.sessions,
            "openProject" to SessionProjectCopy.openProject, "pin" to SessionProjectCopy.pin, "unpin" to SessionProjectCopy.unpin, "move" to SessionProjectCopy.move,
            "pageSubtitleLoading" to SessionProjectCopy.pageSubtitleLoading, "coordinatorSection" to SessionProjectCopy.coordinatorSection,
            "startReview" to SessionProjectCopy.startReview, "startNotAsked" to SessionProjectCopy.startNotAsked, "startHint" to SessionProjectCopy.startHint,
            "landingTimedOut" to SessionProjectCopy.landingTimedOut,
            "landingNoWordFromRunner" to SessionProjectCopy.landingNoWordFromRunner,
        ).forEach { (name, value) -> assertDeclares(name, value) }
        val declared = SessionProjectCopy::class.java.declaredFields.filter { it.type == String::class.java }.map { it.isAccessible = true; it.get(null) as String }
        assertEquals("a SessionProjectCopy word is not held above", 15, declared.size)
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

    /** The mark on a member's own row, where its project has no row (owner 2026-11-07, option A): the web's hover, word for word in
     * the web's `SESSION_PROJECT_COPY` and in OrbitKit's; and the Sessions its long press adds, the web's word too. */
    @Test fun theMarksWordsAreTheWebsAndTheSwifts() {
        assertSentence(copy, SessionProjectCopy.markHint("§"), "§" to "\\(title)")
        val template = SessionProjectCopy.markHint("\${title}")
        assertTrue("sessionProjects.ts no longer says `$template`", web.contains("  markHint: (title: string) => `$template`,"))
        assertTrue("sessionProjects.ts no longer says '${SessionProjectCopy.sessions}'", web.contains("  sessions: '${SessionProjectCopy.sessions}',"))
        // A finished project's row menu leads with it (§4.3, owner 2026-11-07): the same word on all three clients.
        assertTrue("sessionProjects.ts no longer says '${SessionProjectCopy.complete}'", web.contains("  complete: '${SessionProjectCopy.complete}',"))
        assertEquals("Part of Launch · open its sessions", SessionProjectCopy.markHint("Launch"))
    }

    /** The words of the web's `SESSION_PROJECT_COPY` the tests in this file hold, to the Swift that OrbitKit holds to the web's
     * (`startSuggestion` through MainBranchCopyTest). */
    private val held = setOf("noCoordinator", "openSession", "complete", "sessions", "openProject", "pin", "unpin", "move", "coordinatorSection",
        "pageSubtitleLoading", "startReview", "startNotAsked", "startHint", "progress", "markHint", "waitingSession", "pageSubtitle",
        "pageProgress", "startAsked", "pageNotStarted", "startSuggestion")
    /** The web's words this table does not carry: the progress hover, which a phone has no pointer for; Open Coordinator, which no
     * session list draws; and the project page's status line before any count, its empty and its failed states, which the page here
     * draws outside this table (`statusLabel`, its own empty line, the shared StatusMessage). */
    private val notInThisTable = setOf("progressHint", "openCoordinator", "pageStatus", "pageEmpty", "pageUnread", "retry")

    /** Every word of the web's `SESSION_PROJECT_COPY` is held here or named above as not in this table: a word the web adds that
     * Android does not carry fails (OrbitKit's `testEveryWebWordIsHeldHereOrNamed`). */
    @Test fun everyWebWordIsHeldHereOrNamed() {
        val table = web.substringAfter("export const SESSION_PROJECT_COPY = {", "").substringBefore("\n} as const;", "")
        val keys = Regex("^  (\\w+):", RegexOption.MULTILINE).findAll(table).map { it.groupValues[1] }.toList()
        assertTrue("no words read from SESSION_PROJECT_COPY", keys.isNotEmpty())
        val unheld = keys.filter { it !in held && it !in notInThisTable }
        assertTrue("SESSION_PROJECT_COPY says $unheld, which SessionProjectCopy neither holds nor names", unheld.isEmpty())
        val gone = (held + notInThisTable - keys.toSet()).sorted()
        assertTrue("SESSION_PROJECT_COPY no longer says $gone", gone.isEmpty())
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

    /** §7.2 V6: the row's timeout and its SILENT claim, composed from the two new fixed words. */
    @Test fun theLivenessLinesAreTheSwifts() {
        val now = Instant.parse("2026-10-05T11:24:00Z")
        fun line(liveness: String, heartbeat: String?) = SessionProjectCopy.landingLine(buildJsonObject {
            put("activeJobCount", 1)
            putJsonObject("inFlight") {
                put("state", "RUNNING"); put("kind", "LAND_PROMOTION"); put("phase", "CHECK")
                put("startedAt", "2026-10-05T10:53:00Z"); heartbeat?.let { put("heartbeatAt", it) }; put("liveness", liveness)
            }
        }, now)!!
        val timedOut = line("LEASE_EXPIRED", "2026-10-05T11:01:00Z")
        assertEquals("Merge to main · timed out · no report for 23m", timedOut.text)
        assertEquals(SessionLine.Tone.WARNING, timedOut.tone)
        assertEquals("Merge to main · no word from runner · 4m", line("SILENT", "2026-10-05T11:20:00Z").text)
        // The same two sentences, composed in the Swift from the same two literals.
        assertTrue("SessionProjectCopy.swift no longer composes the timeout line",
            copy.contains("landingTimedOut, landingSilentWord(minutes: minutes)]"))
        assertTrue("SessionProjectCopy.swift no longer composes the silent line",
            copy.contains("landingNoWordFromRunner) · \\(minutes)m"))
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

    /** Design §4.3 (owner 2026-11-07), as iOS's `offersComplete(in:)`: a DONE or CANCELLED project's row leads its menu with Complete,
     * in Open only; an OPEN project's row has no completion. */
    @Test fun onlyAFinishedProjectInOpenOffersComplete() {
        val row = SessionProjectRow("p1", "Launch", "OPEN", emptyList(), 0, null, null, null, null, null, false, false, false, null,
            SessionLine("x", SessionLine.Tone.PREVIEW), SessionProjectRow.Target.Project("p1"), null, 0)
        for (status in listOf("OPEN", "DONE", "CANCELLED", "SOMETHING_NEW")) for (view in SessionView.entries) {
            assertEquals("$status in $view", view == SessionView.OPEN && status in setOf("DONE", "CANCELLED"),
                row.copy(status = status).offersComplete(view))
        }
    }
}
