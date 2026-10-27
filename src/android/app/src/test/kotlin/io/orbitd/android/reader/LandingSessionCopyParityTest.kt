package io.orbitd.android.reader

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * A landing's card, record, menu and receipt in the Landings window say the Swift's words (project rule: Kotlin ⊆ Swift). Every
 * fixed word of [LandingSessionCopy] is a literal in OrbitKit's `LandingSessionPage.swift`, and every built sentence — rendered
 * with sentinels, put back as Swift's own interpolations — is one literal there too.
 *
 * The ⋯ menu's labels are the one deliberate difference: the board's v4 07 frame draws Android's menu in sentence case
 * (`Open task`, `Stop landing`), where the Swift page holds iOS's Title Case (`Open Task`, `Stop Landing`). Those six are
 * compared ignoring case, below, and the rest of the object is compared byte for byte.
 */
class LandingSessionCopyParityTest {
    private val root = generateSequence(File(System.getProperty("user.dir"))) { it.parentFile }
        .first { File(it, "src/macos/OrbitKit/Sources/OrbitKit").isDirectory }
    private val kit = "src/macos/OrbitKit/Sources/OrbitKit/App/"
    private val views = "src/macos/OrbitApp/Sources/OrbitApp/Views/"
    private val source = listOf("${kit}LandingSessionPage.swift", "${kit}ProjectPage.swift", "${kit}ProjectPageSections.swift",
        "${views}LandingSessionPageView.swift").joinToString("\n") { File(root, it).readText() }
        // `"a" + "b"` across lines is one sentence to a reader.
        .replace(Regex("\"\\s*\\+\\s*\""), "")

    /** The menu's six, as the Swift page declares them: Android folds the first letter, as v4 07 draws it. */
    private val menuCase = mapOf(
        "OPEN_TASK" to "Open Task", "OPEN_SOURCE_SESSION" to "Open Source Session", "OPEN_COORDINATOR" to "Open Coordinator",
        "REVIEW_CARD" to "Review Card", "STOP_LANDING" to "Stop Landing", "CANCEL_MERGE" to "Cancel Merge",
    )

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
        val missing = strings(LandingSessionCopy).filterKeys { it !in menuCase.keys }
            .filterValues { !source.contains("\"$it\"") }
        assertTrue("LandingSessionCopy strings not in the Swift source: $missing", missing.isEmpty())
    }

    /** `Open task` is `Open Task` with its first letter folded — the board's sentence case, not another word. */
    @Test fun theMenusSentenceCaseIsTheBoardsDifferenceAndNothingElse() {
        val words = strings(LandingSessionCopy)
        menuCase.forEach { (field, swift) ->
            val android = words.getValue(field)
            assertEquals("the menu's $field is the Swift word, sentence-cased", swift.lowercase(), android.lowercase())
            assertTrue("the Swift page no longer declares \"$swift\"", source.contains("\"$swift\""))
            assertTrue("the Android menu's $field differs from the board's sentence case",
                android == swift.lowercase().replaceFirstChar(Char::uppercaseChar))
        }
    }

    @Test fun everyBuiltSentenceIsOneSwiftLiteral() {
        fun sentence(rendered: String, vararg values: Pair<String, String>) {
            val template = values.fold(rendered) { text, (from, to) -> text.replace(from, to) }
            assertTrue("the Swift no longer contains \"$template\"", source.contains("\"$template\""))
        }
        sentence(LandingSessionCopy.taskAcceptanceExited("§a", "§b"), "§a" to "\\(code)", "§b" to "\\(expected)")
        sentence(LandingSessionCopy.mayHavePushedAt("§t"), "§t" to "\\(time)")
        assertEquals("+2 jobs queued", LandingSessionCopy.moreJobsQueued(3)); assertNull(LandingSessionCopy.moreJobsQueued(1))
        sentence("+2 jobs queued", "2" to "\\(others)", "jobs" to "job\\(others == 1 ? \"\" : \"s\")")
        sentence(LandingSessionCopy.bytesOmitted(2048), "2048" to "\\(bytes)")
    }

    /** A merge row's receipt (board 03 e) is the Swift's `mergeReceipt`, expression for expression: the heading, the check that
     *  passed on the combined tree, and the tree that landed. */
    @Test fun theMergeReceiptIsTheSwiftsExpression() {
        val page = File(root, "${kit}LandingSessionPage.swift").readText()
        listOf("heading = \"\\(LandingPageCopy.nowOn) \\(main) · \\(plural(promotion.taskIds.count, \"task\"))\"",
            "heading = \"\\(LandingPageCopy.nowOn) \\(main)\"",
            "treeLine = \"\\(LandingPageCopy.landedExactly) \\(String(sha.prefix(7))) · \\(landsAs)\"",
            "checkLine: passed ? \"\\(LandingPageCopy.passedOnTheTree) · \\(duration(ms: durationMs))\" : nil,",
            "if checks.isEmpty {").forEach {
            assertTrue("LandingSessionPage.swift no longer builds the receipt with $it", page.contains(it))
        }
    }

    /** The results that give the status card its red ✕ head are OrbitKit's three, read from the attempt's state, and both draw the
     *  head from it; the budget bar is the same fraction (Swift: the step's seconds over the budget's seconds). */
    @Test fun theFailureStatesAndTheBudgetFractionAreTheSwifts() {
        val page = File(root, "${kit}LandingSessionPage.swift").readText()
        val states = LandingSessionModel.FAILURE_STATES.joinToString(", ") { "\"$it\"" }
        listOf("public static let failureStates = [$states]",
            "stoppedOnFailure: LandingPageCopy.failureStates.contains(attempt.state))",
            "let budget = Double(check.budgetSeconds)\n").forEach {
            assertTrue("LandingSessionPage.swift no longer says $it", page.contains(it))
        }
        val view = File(root, "${views}LandingSessionPageView.swift").readText()
        assertTrue(view.contains("running: card.running, timedOut: card.timedOut, failed: card.stoppedOnFailure)"))
    }

    /** The landing page's own header line and read-only footer went with the page (owner 2026-10-27): the window has its own
     *  footer, in [io.orbitd.android.directory.SessionLandingsCopy]. None of their words is left here, nor in the Swift. */
    @Test fun thePagesHeaderAndFooterWordsAreGone() {
        val page = File(root, "${kit}LandingSessionPage.swift").readText()
        val words = strings(LandingSessionCopy)
        listOf("settled", "Orbit runs this landing — nothing to type here.", "This landing is complete — nothing to type here.",
            "A clean pass merges on its own", "Merging is decided on the merge card").forEach {
            assertFalse("LandingSessionCopy still says \"$it\"", words.containsValue(it))
            assertFalse("LandingSessionPage.swift still says \"$it\"", page.contains("\"$it\""))
        }
        listOf("headerSub", "footer", "nextMergeOpens").forEach { name ->
            assertFalse("LandingSessionModel.$name is still here", LandingSessionModel::class.java.declaredMethods.any { it.name == name })
            assertFalse("LandingSessionCopy.$name is still here", LandingSessionCopy::class.java.declaredMethods.any { it.name == name })
        }
    }
}
