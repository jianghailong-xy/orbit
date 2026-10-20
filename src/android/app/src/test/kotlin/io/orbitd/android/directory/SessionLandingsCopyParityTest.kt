package io.orbitd.android.directory

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The Landings group says the Swift's words (project rule: Kotlin ⊆ Swift). Every fixed word of [SessionLandingsCopy] is a literal in
 * OrbitKit's `SessionProjectLandings.swift` (the settled words it takes from `LandingSessionPage.swift`), and every built sentence is
 * one literal there or in the page's own `earlierLine`/`sourceLabel`. A missing counterpart is a failure, never a skip.
 */
class SessionLandingsCopyParityTest {
    private val root = generateSequence(File(System.getProperty("user.dir"))) { it.parentFile }
        .first { File(it, "src/macos/OrbitKit/Sources/OrbitKit").isDirectory }
    private val kit = "src/macos/OrbitKit/Sources/OrbitKit/App/"
    private val views = "src/macos/OrbitApp/Sources/OrbitApp/Views/"
    private val group = File(root, "${kit}SessionProjectLandings.swift").readText()
    private val source = listOf("${kit}SessionProjectLandings.swift", "${kit}LandingSessionPage.swift",
        "${views}SessionProjectPage.swift", "${kit}ProjectPage.swift").joinToString("\n") { File(root, it).readText() }
        .replace(Regex("\"\\s*\\+\\s*\""), "")

    private fun strings(owner: Any): Map<String, String> = owner.javaClass.declaredFields
        .flatMap { field ->
            field.isAccessible = true
            when (val value = runCatching { field.get(owner) }.getOrNull()) {
                is String -> listOf(field.name to value)
                is Map<*, *> -> value.filterValues { it is String }.map { (k, v) -> "${field.name}[$k]" to v as String }
                else -> emptyList()
            }
        }.toMap()

    @Test fun everyWordIsTheSwifts() {
        val missing = strings(SessionLandingsCopy).filterValues { !source.contains("\"$it\"") }
        assertTrue("SessionLandingsCopy strings not in the Swift source: $missing", missing.isEmpty())
    }

    @Test fun everyBuiltSentenceIsOneSwiftExpression() {
        // `Earlier · 31 landed · 3 nothing to land` — the Swift's `earlierLine`, sentinel-rendered: a segment whose count is 0 is
        // left out, on both sides.
        assertEquals("Earlier · 31 landed · 3 nothing to land", SessionProjectLandings.earlierLine(LandingEarlier(31, 3)))
        assertEquals("Earlier · 31 landed", SessionProjectLandings.earlierLine(LandingEarlier(31, 0)))
        assertEquals("Earlier · 3 nothing to land", SessionProjectLandings.earlierLine(LandingEarlier(0, 3)))
        listOf("var parts = [SessionLandingsCopy.earlier]",
            "if landed > 0 { parts.append(\"\\(landed) \\(SessionLandingsCopy.landed)\") }",
            "if nothing > 0 { parts.append(\"\\(nothing) \\(SessionLandingsCopy.nothingToLand)\") }",
            "parts.joined(separator: \" · \")").forEach {
            assertTrue("SessionProjectLandings.swift no longer builds the fold with $it", group.contains(it))
        }
        // A settled merge is named by the landing page's own two words, in the order the Swift's `settledWord` names them.
        assertEquals("Merged into main" to LandingGroupTone.MERGE, SessionProjectLandings.settledWord("MERGED"))
        assertTrue("SessionProjectLandings.swift no longer says \"Merged into main\"", group.contains("\"Merged into main\""))
        // The source label: where the work went, and what the platform is doing while it is open.
        fun label(state: String, phase: String? = null, settledAs: String? = null, target: String? = "refs/heads/project/x") =
            SessionProjectLandings.sourceLabel(SessionProjectLandings.LandingSummary("s", state = state, phase = phase, settledAs = settledAs, targetRef = target))
        assertEquals(SourceLandingLabel("On project/x ✓", "landed"), label("SETTLED", settledAs = "LANDED"))
        assertEquals(SourceLandingLabel("Landing · checking", "run"), label("RUNNING", phase = "CHECK"))
        assertEquals(SourceLandingLabel("Landing · checks failed", "failed"), label("CHECK_FAILED"))
        assertEquals(SourceLandingLabel("Nothing to land", "quiet"), label("SETTLED", settledAs = "NOTHING_TO_LAND"))
        assertEquals(SourceLandingLabel("Landing · cancelled", "quiet"), label("SETTLED", settledAs = "CANCELLED"))
        listOf("\"\\(SessionLandingsCopy.on) \\(branch) ✓\"", "\"\\(SessionLandingsCopy.landing) · \\(stopped)\"",
            "\"\\(SessionLandingsCopy.landing) · \\(step)\"").forEach {
            assertTrue("SessionProjectLandings.swift no longer composes $it", group.contains(it))
        }
    }

    /** The group's own rules: an in-flight landing is absent, a merged round is the timeline's, and everything older folds. */
    @Test fun theGroupFoldsWhatTheSwiftDoes() {
        val now = java.time.Instant.parse("2026-10-19T12:00:00Z")
        fun row(id: String, title: String, at: String, subject: String = "TASK", state: String, settledAs: String? = null, settledAt: String? = null) =
            DirectorySession(id, title, createdAt = at, sessionKind = "LANDING",
                landing = SessionLandingSummary(subject, state, settledAs, settledAt))
        val rows = listOf(
            row("in-flight", "Land · moving", "2026-10-19T11:00:00Z", state = "IN_FLIGHT"),
            row("waiting", "Land · stopped", "2026-10-19T11:55:00Z", state = "AWAITING_DECISION"),
            row("just-landed", "Land · done", "2026-10-19T08:00:00Z", state = "SETTLED", settledAs = "LANDED", settledAt = "2026-10-19T11:00:00Z"),
            row("merged-round", "Merge → main", "2026-10-19T10:00:00Z", subject = "PROMOTION", state = "SETTLED", settledAs = "MERGED",
                settledAt = "2026-10-19T10:00:00Z"),
            row("old-a", "Land · old", "2026-10-17T08:00:00Z", state = "SETTLED", settledAs = "LANDED", settledAt = "2026-10-17T09:00:00Z"),
            row("old-b", "Land · nothing", "2026-10-16T08:00:00Z", state = "SETTLED", settledAs = "NOTHING_TO_LAND", settledAt = "2026-10-16T09:00:00Z"))
        val group = SessionProjectLandings.group(rows, now, mapOf("waiting" to LandingHolder("Checks failed", "COORDINATOR")))!!
        assertEquals(listOf("waiting"), group.waiting.map { it.id })
        assertEquals("Checks failed · with the coordinator", group.waiting.single().detail)
        assertEquals(LandingGroupTone.FAIL, group.waiting.single().tone)
        assertEquals("an in-flight landing is the Landing card's, and a merged round the timeline's", listOf("just-landed"), group.settled.map { it.id })
        assertEquals(LandingEarlier(landed = 1, nothing = 1), group.earlier)
        assertEquals(listOf("old-a", "old-b"), group.older.map { it.id })
        assertTrue(SessionProjectLandings.group(rows.filter { it.id == "in-flight" }, now) == null)
    }

    /** The fold names only what landed and what had nothing to land: a zero segment is left out, and with both at 0 there is no
     *  fold, no older rows under it, and — with nothing else to list — no group. */
    @Test fun theFoldLeavesOutWhatItDoesNotCount() {
        val now = java.time.Instant.parse("2026-10-19T12:00:00Z")
        fun row(id: String, state: String, settledAs: String? = null, settledAt: String? = null) =
            DirectorySession(id, id, createdAt = "2026-10-15T08:00:00Z", sessionKind = "LANDING",
                landing = SessionLandingSummary("TASK", state, settledAs, settledAt))
        val landedOnly = SessionProjectLandings.group(listOf(
            row("old-landed", "SETTLED", "LANDED", "2026-10-18T09:00:00Z"),
            row("old-again", "SETTLED", "ALREADY_LANDED", "2026-10-17T09:00:00Z"),
            row("old-cancelled", "SETTLED", "CANCELLED", "2026-10-16T09:00:00Z")), now)!!
        assertEquals(LandingEarlier(landed = 2, nothing = 0), landedOnly.earlier)
        assertEquals("Earlier · 2 landed", SessionProjectLandings.earlierLine(landedOnly.earlier!!))
        assertEquals("the fold still opens to every older row", listOf("old-landed", "old-again", "old-cancelled"), landedOnly.older.map { it.id })
        val nothingOnly = SessionProjectLandings.group(listOf(row("old-nothing", "SETTLED", "NOTHING_TO_LAND", "2026-10-18T09:00:00Z")), now)!!
        assertEquals("Earlier · 1 nothing to land", SessionProjectLandings.earlierLine(nothingOnly.earlier!!))

        val old = listOf(
            row("old-cancelled", "SETTLED", "CANCELLED", "2026-10-18T09:00:00Z"),
            row("old-handled", "SETTLED", "HANDLED", "2026-10-17T09:00:00Z"),
            row("old-declined", "SETTLED", "DECLINED", "2026-10-17T08:00:00Z"),
            row("old-deleted", "SETTLED", "DELETED", "2026-10-16T09:00:00Z"),
            row("no-instant", "SETTLED", "CANCELLED"))
        val waiting = SessionProjectLandings.group(listOf(row("waiting", "AWAITING_DECISION")) + old, now)!!
        assertEquals(listOf("waiting"), waiting.waiting.map { it.id })
        assertNull(waiting.earlier)
        assertEquals(emptyList<LandingGroupRow>(), waiting.older)
        assertNull("no bare Landings heading", SessionProjectLandings.group(old, now))
    }
}
