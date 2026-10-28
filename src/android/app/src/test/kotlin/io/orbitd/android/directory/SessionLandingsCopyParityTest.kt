package io.orbitd.android.directory

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The Landings row and the Landings window say the Swift's words (project rule: Kotlin ⊆ Swift; owner 2026-10-27,
 * docs/mocks/landings-one-window). Every fixed word of [SessionLandingsCopy] is a literal in OrbitKit's `SessionProjectLandings.swift`
 * (the settled words it takes from `LandingSessionPage.swift`), and every built sentence is the Swift's own expression there: the row's
 * count sentence, the task's name, the source session's label. A missing counterpart is a failure, never a skip.
 */
class SessionLandingsCopyParityTest {
    private val root = generateSequence(File(System.getProperty("user.dir"))) { it.parentFile }
        .first { File(it, "src/macos/OrbitKit/Sources/OrbitKit").isDirectory }
    private val kit = "src/macos/OrbitKit/Sources/OrbitKit/App/"
    private val views = "src/macos/OrbitApp/Sources/OrbitApp/Views/"
    private val landings = File(root, "${kit}SessionProjectLandings.swift").readText()
    private val grouping = File(root, "${kit}SessionTimeGrouping.swift").readText()
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

    private fun swiftSays(vararg expressions: String) = expressions.forEach {
        assertTrue("SessionProjectLandings.swift no longer says $it", landings.contains(it))
    }

    @Test fun everyWordIsTheSwifts() {
        val missing = strings(SessionLandingsCopy).filterValues { !source.contains("\"$it\"") }
        assertTrue("SessionLandingsCopy strings not in the Swift source: $missing", missing.isEmpty())
    }

    /** `1 waiting for a decision · 1 in flight · 3 landed · 1 merged into main today` — the Swift's `countLine`, expression for
     *  expression: a count of 0 is left out, today's two share one `today` at the end, and all four at 0 is `Nothing landed today`. */
    @Test fun theRowsCountSentenceIsTheSwiftsExpression() {
        swiftSays("""landed > 0 ? "\(landed) \(SessionLandingsCopy.landed)" : nil,""",
            """merged > 0 ? "\(merged) \(SessionLandingsCopy.mergedInto) \(main)" : nil,""",
            """].compactMap { $0 }.joined(separator: " · ")""",
            """waiting > 0 ? "\(waiting) \(SessionLandingsCopy.waiting)" : nil,""",
            """inFlight > 0 ? "\(inFlight) \(SessionLandingsCopy.inFlight)" : nil,""",
            """today.isEmpty ? nil : "\(today) \(SessionLandingsCopy.today)",""",
            """return parts.isEmpty ? SessionLandingsCopy.nothingLandedToday : parts.joined(separator: " · ")""")
        assertEquals("1 waiting for a decision · 1 in flight · 3 landed · 1 merged into main today",
            SessionProjectLandings.countLine(waiting = 1, inFlight = 1, landed = 3, merged = 1))
        assertEquals("2 in flight", SessionProjectLandings.countLine(0, 2, 0, 0))
        assertEquals("2 landed today", SessionProjectLandings.countLine(0, 0, 2, 0))
        assertEquals("1 merged into master today", SessionProjectLandings.countLine(0, 0, 0, 1, main = "master"))
        assertEquals("2 waiting for a decision · 1 landed · 2 merged into main today", SessionProjectLandings.countLine(2, 0, 1, 2))
        assertEquals("all four at 0", "Nothing landed today", SessionProjectLandings.countLine(0, 0, 0, 0))
    }

    /** The window's rows name what the Swift's do: a task by its name (the server's `Land · ` comes off), a merge round past the read's
     *  20 records `Merged into main`, a settlement this build has no word for the Swift's own fallback, and a merge older than landing
     *  sessions by its record's key. */
    @Test fun theWindowsRowsAreNamedAsTheSwiftNamesThem() {
        swiftSays("""let prefix = "\(LandingPageCopy.land) · """",
            """title: record.map(PromotionCards.timelineTitle) ?? SessionLandingsCopy.mergedIntoMain,""",
            """detail: record.map(PromotionCards.timelineDetail) ?? name,""",
            """default: return (settledAs ?? "Settled", .quiet)""",
            """key: session ?? "merge:\(record.promotionId)"""")
        assertEquals("Ledger migration order", SessionProjectLandings.taskName("Land · Ledger migration order"))
        assertEquals("Merged into main", SessionLandingsCopy.mergedIntoMain)
        assertEquals("Settled" to LandingsWindowTone.QUIET, SessionProjectLandings.settledWord(null))
        assertEquals("SOMETHING_NEW" to LandingsWindowTone.QUIET, SessionProjectLandings.settledWord("SOMETHING_NEW"))
        // A merged round is the merge branch's, never a settled word: the Swift's `settledWord` has no MERGED case either.
        assertFalse(landings.contains("""case "MERGED": return"""))
        assertEquals("MERGED" to LandingsWindowTone.QUIET, SessionProjectLandings.settledWord("MERGED"))
    }

    /** The window files a landing where the Swift does: the session list's own day sections, oldest first and oldest row first, a
     *  merge joined with its round's session by `landingSessionId`, `Now` in the order it started — and the row is no row for a
     *  project that never had a landing, marked by the most urgent one. */
    @Test fun theWindowFilesWhatTheSwiftFiles() {
        swiftSays("""if let id = record.landingSessionId, !id.isEmpty, bySession[id] == nil { bySession[id] = record }""",
            """$0.row.at != $1.row.at ? $0.row.at < $1.row.at : $0.row.key > $1.row.key""",
            """let days = buckets.enumerated().reversed().compactMap { index, rows in""",
            """cards.sort { $0.at != $1.at ? $0.at < $1.at : $0.sessionId < $1.sessionId }""",
            """if landings.isEmpty && !merges.contains(where: { $0.merged != nil }) { return nil }""",
            """mark: !waiting.isEmpty ? .fail : !inFlight.isEmpty ? .running : .ok,""",
            """let today = window.days.first { $0.title == SessionTimeGrouping.bucketTitles[0] }?.rows ?? []""")
        assertTrue(grouping.contains("""static let bucketTitles = ["Today", "Yesterday", "2–7 days ago", "8–30 days ago", "Older"]"""))
        assertEquals(listOf("Today", "Yesterday", "2–7 days ago", "8–30 days ago", "Older"), SessionProjectLandings.dayTitles)
    }

    /** The source label: where the work went, and what the platform is doing while it is open — the Swift's three compositions. */
    @Test fun theSourceLabelIsTheSwiftsComposition() {
        fun label(state: String, phase: String? = null, settledAs: String? = null, target: String? = "refs/heads/project/x") =
            SessionProjectLandings.sourceLabel(SessionProjectLandings.LandingSummary("s", state = state, phase = phase, settledAs = settledAs, targetRef = target))
        assertEquals(SourceLandingLabel("On project/x ✓", "landed"), label("SETTLED", settledAs = "LANDED"))
        assertEquals(SourceLandingLabel("Landing · checking", "run"), label("RUNNING", phase = "CHECK"))
        assertEquals(SourceLandingLabel("Landing · checks failed", "failed"), label("CHECK_FAILED"))
        assertEquals(SourceLandingLabel("Nothing to land", "quiet"), label("SETTLED", settledAs = "NOTHING_TO_LAND"))
        assertEquals(SourceLandingLabel("Landing · cancelled", "quiet"), label("SETTLED", settledAs = "CANCELLED"))
        swiftSays(""""\(SessionLandingsCopy.on) \(branch) ✓"""", """"\(SessionLandingsCopy.landing) · \(stopped)"""",
            """"\(SessionLandingsCopy.landing) · \(step)"""")
    }

    /** The Landings group, its `Earlier` fold and its 24-hour window are gone (owner 2026-10-27), from the Swift and from here: no
     *  word of theirs is left in [SessionLandingsCopy], and no function of theirs in [SessionProjectLandings]. */
    @Test fun theGroupItsFoldAndItsWindowAreGone() {
        listOf("landingsSettledWindow", "earlierLine(", "LandingGroup", "static let earlier", "static let withYou").forEach {
            assertFalse("SessionProjectLandings.swift still has $it", landings.contains(it))
        }
        val words = strings(SessionLandingsCopy)
        listOf("Earlier", "nothing to land", "with you", "with the coordinator", "Waiting for a decision").forEach {
            assertFalse("SessionLandingsCopy still says \"$it\"", words.containsValue(it))
        }
        val functions = SessionProjectLandings::class.java.declaredMethods.map { it.name }.toSet()
        listOf("group", "earlierLine", "holders", "itemReason").forEach { assertFalse("SessionProjectLandings.$it is still here", it in functions) }
    }
}
