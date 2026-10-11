package io.orbitd.android.directory

import io.orbitd.android.cards.NeedsYouLogic
import io.orbitd.android.core.cards.OwnerReview
import io.orbitd.android.projects.ProjectDone
import io.orbitd.android.projects.StartProjectCopy
import io.orbitd.android.tasks.OwnerConfirmationCopy
import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** The session line says main's iOS words (A05-6): every word of [SessionLineCopy] is a literal of OrbitKit's `SessionLine.swift`
 * or `SessionHeader.swift`, and every built line — rendered here with sentinels, which are put back as Swift's own interpolations —
 * is one literal there, so the words either side of a number or a name are held too. The words the line borrows are held to their
 * owners' Swift declarations. A missing counterpart is a failure, never a skip (ProjectCopyParityTest's rule). */
class SessionLineCopyParityTest {
    private val root = generateSequence(File(System.getProperty("user.dir"))) { it.parentFile }
        .first { File(it, "src/macos/OrbitKit/Sources/OrbitKit").isDirectory }
    private fun swift(name: String) = File(root, "src/macos/OrbitKit/Sources/OrbitKit/App/$name").readText()
    private val line = swift("SessionLine.swift")
    private val header = swift("SessionHeader.swift")

    /** A sentinel that occurs in no sentence. */
    private val count = 23

    private fun assertLiteral(source: String, file: String, words: String) =
        assertTrue("$file no longer says \"$words\"", source.contains("\"$words\""))
    private fun assertSentence(source: String, file: String, rendered: String, vararg values: Pair<String, String>) {
        val template = values.fold(rendered) { text, (from, to) -> text.replace(from, to) }
        assertTrue("$file no longer contains \"$template\"", source.contains("\"$template\""))
    }
    private fun assertDeclares(source: String, file: String, name: String, value: String) =
        assertTrue("$file no longer declares $name as \"$value\"", source.contains("static let $name = \"$value\""))

    @Test fun everyFixedWordIsALiteralOfTheSwiftLineOrHeader() {
        val both = line + header
        listOf(SessionLineCopy.running, SessionLineCopy.queued).forEach { assertLiteral(line, "SessionLine.swift", it) }
        listOf(SessionLineCopy.queued, SessionLineCopy.stateRunning, SessionLineCopy.waitingForReply, SessionLineCopy.succeeded,
            SessionLineCopy.retrying, SessionLineCopy.disconnected, SessionLineCopy.failed, SessionLineCopy.interrupted, SessionLineCopy.ended,
        ).forEach { assertLiteral(header, "SessionHeader.swift", it) }
        assertDeclares(header, "SessionHeader.swift", "unnamedWord", SessionLineCopy.unnamedWord)
        // Every constant of the copy object is held by one of the lines above: a word added here and not there fails.
        val declared = SessionLineCopy::class.java.declaredFields.filter { it.type == String::class.java }
            .map { it.isAccessible = true; it.get(null) as String }
        assertTrue("a SessionLineCopy word is in neither Swift source: $declared", declared.all { both.contains("\"$it\"") })
        assertEquals(12, declared.size)
    }

    @Test fun everyBuiltLineIsOneSwiftLiteral() {
        assertSentence(line, "SessionLine.swift", SessionLineCopy.recapWithTime("§"), "§" to "\\(clock)")
        assertSentence(line, "SessionLine.swift", SessionLineCopy.runningTool("\\(fmtTool(t))"))
        assertSentence(line, "SessionLine.swift", SessionLineCopy.sent("\\(plainPreview(text))"))
        assertSentence(line, "SessionLine.swift", SessionLineCopy.ongoing("\\(subagentRunningLabel(n))"))
        assertSentence(line, "SessionLine.swift", SessionLineCopy.ongoing("\\(bgRunningLabel(bg))"))
        assertSentence(line, "SessionLine.swift", SessionLineCopy.subagentRunning(count), "$count" to "\\(n)")
        assertLiteral(line, "SessionLine.swift", SessionLineCopy.subagentRunning(1))
        assertSentence(line, "SessionLine.swift", SessionLineCopy.bgRunning(count), "$count" to "\\(n)")
        assertLiteral(line, "SessionLine.swift", SessionLineCopy.bgRunning(1))
        // Two is the first count the plural takes, as Swift's `n > 1`.
        assertEquals("Running 2 agents", SessionLineCopy.subagentRunning(2))
        assertEquals("2 background processes running", SessionLineCopy.bgRunning(2))
        // Who has a report under review: OwnerConfirmationReview.swift's `underReviewLine`, over the review bar's words.
        val review = swift("OwnerConfirmationReview.swift")
        assertSentence(review, "OwnerConfirmationReview.swift", SessionLineCopy.underReviewLine("§"),
            OwnerReview.underReview to "\\(underReview)", "§" to "\\(reviewerName(reviewerTitle))")
        val confirmation = swift("OwnerConfirmation.swift")
        assertDeclares(confirmation, "OwnerConfirmation.swift", "underReview", OwnerReview.underReview)
        assertDeclares(confirmation, "OwnerConfirmation.swift", "reviewerFallback", OwnerReview.reviewerFallback)
    }

    /** What waits on you, in its owners' words: `SessionHeader.waitingWord`'s every kind, and the words each kind borrows. */
    @Test fun theWaitingWordsAreTheirOwnersSwiftWords() {
        mapOf("ownerConfirmation" to "OwnerConfirmations.waitingForConfirmation", "ownerItem" to "NeedsYouLogic.oldestItemWord(s.ownerItems) ?? unnamedWord",
            "startRequest" to "StartProject.readyToStart", "doneRequest" to "ProjectDone.readyToClose", "recordAsDone" to "ProjectDone.recordAsDoneRow",
        ).forEach { (kind, word) -> assertTrue("SessionHeader.waitingWord no longer says $word for .$kind", Regex("case \\.$kind:\\s+return ${Regex.escape(word)}\n").containsMatchIn(header)) }
        assertDeclares(swift("OwnerConfirmation.swift"), "OwnerConfirmation.swift", "waitingForConfirmation", OwnerConfirmationCopy.waitingForConfirmation)
        assertDeclares(swift("StartProject.swift"), "StartProject.swift", "readyToStart", StartProjectCopy.readyToStart)
        val done = swift("ProjectDone.swift")
        assertDeclares(done, "ProjectDone.swift", "readyToClose", ProjectDone.readyToClose)
        assertDeclares(done, "ProjectDone.swift", "recordAsDoneRow", ProjectDone.recordAsDoneRow)
        val needsYou = swift("NeedsYou.swift")
        // A merge approval names the branch it merges into: MainBranchCopyTest holds its words to the web's WorkspaceView.tsx.
        mapOf("coordinatorQuestion" to "COORDINATOR_QUESTION", "escalated" to "ESCALATED", "fusePaused" to "FUSE_PAUSED").forEach { (case, kind) ->
            val word = NeedsYouLogic.kindWord(kind) ?: throw AssertionError("Android has no word for $kind")
            assertTrue("NeedsYou.swift no longer says \"$word\" for .$case", needsYou.contains("case .$case: return \"$word\""))
        }
    }

    /** The line's tones are the Swift's, one for one. */
    @Test fun theTonesAreTheSwiftsCases() {
        val cases = Regex("case (\\w+)\\s+//").findAll(line.substringAfter("public enum Tone").substringBefore("}")).map { it.groupValues[1] }.toList()
        assertEquals(cases, SessionLine.Tone.entries.map { it.name.lowercase() })
    }
}
