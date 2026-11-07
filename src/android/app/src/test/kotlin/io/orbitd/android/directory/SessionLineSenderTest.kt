package io.orbitd.android.directory

import io.orbitd.android.core.protocol.Wire
import io.orbitd.android.directory.SessionLine.Tone
import io.orbitd.android.tasks.TaskDetailCopy
import java.time.Instant
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** Whose message a session row previews (design §3.5, owner 2026-11-07): another Orbit session's message names that session, as the
 * conversation's card names it, and "You" is only ever the owner's own words. OrbitKit's `SessionLineSenderTests` and the web's
 * `sessionLine names who sent the message it previews`, case for case; SessionLineCopyParityTest holds the words to both. */
class SessionLineSenderTest {
    private val now = Instant.parse("2026-10-04T10:00:00Z")
    private val report = "Done: **the package builds**"
    private val from = SessionMessageFrom("session-1", "Build the package")

    private fun session(status: String, lastAssistantText: String? = null, lastToolUse: String? = null, lastUserText: String? = null,
        lastUserFrom: SessionMessageFrom? = null, pendingApprovals: Int = 0) =
        DirectorySession("s", "t", status = status, lastAssistantText = lastAssistantText, lastToolUse = lastToolUse,
            lastUserText = lastUserText, lastUserFrom = lastUserFrom, pendingApprovals = pendingApprovals)
    private fun line(s: DirectorySession, live: Boolean = true) = SessionLine.make(s, live, now = now)

    @Test fun namesAnotherSessionByItsTitleWhileTheTurnRunsAndAfterItStopped() {
        val named = SessionLine("Build the package: Done: the package builds", Tone.PREVIEW)
        assertEquals(named, line(session("RUNNING", "previous reply", lastUserText = report, lastUserFrom = from)))
        assertEquals(named, line(session("INTERRUPTED", "previous reply", lastUserText = report, lastUserFrom = from)))
        // Trash says it the same way.
        assertEquals(named, line(session("FAILED", lastUserText = report, lastUserFrom = from), live = false))
    }

    /** No sender is both the owner's own message (null) and an older server's (no key): the decoding case below reads both as null. */
    @Test fun saysYouForTheOwnersOwnMessageAndForAnOlderServer() {
        assertEquals("You", SessionLineCopy.you)
        assertEquals(SessionLine("You: ship it", Tone.PREVIEW), line(session("RUNNING", lastUserText = "ship it")))
        assertEquals(SessionLine("You: ship it", Tone.PREVIEW), line(session("INTERRUPTED", lastUserText = "ship it")))
    }

    @Test fun callsASenderWithNoTitleWhatTheConversationsCardCallsItNeverYou() {
        assertEquals("Untitled session", TaskDetailCopy.untitledSession)
        listOf("", "   ", "\n\t ", null).forEach { title ->
            assertEquals("title ${title?.let { "\"$it\"" }}", SessionLine("Untitled session: ship it", Tone.PREVIEW),
                line(session("AWAITING_INPUT", lastUserText = "ship it", lastUserFrom = SessionMessageFrom("session-1", title))))
        }
        // A title is named as written, without the spaces around it.
        assertEquals("Build the package: ship it",
            line(session("AWAITING_INPUT", lastUserText = "ship it", lastUserFrom = SessionMessageFrom("session-1", "  Build the package "))).text)
    }

    @Test fun changesNothingAboveTheMessageAndASenderWithNoMessageMakesNoLine() {
        assertEquals(SessionLine("Running Bash…", Tone.RUNNING),
            line(session("RUNNING", lastToolUse = "Bash", lastUserText = report, lastUserFrom = from)))
        assertEquals(SessionLine("Waiting for approval", Tone.APPROVAL),
            line(session("AWAITING_INPUT", lastUserText = report, lastUserFrom = from, pendingApprovals = 1)))
        assertEquals(SessionLine("On it.", Tone.PREVIEW), line(session("AWAITING_INPUT", "On it.", lastUserFrom = from)))
    }

    /** A row's `lastUserFrom`: an object names the sender, null is the owner, a missing key is an older server. */
    @Test fun decodesTheSenderFromARowAndReadsAnOlderServersAsTheOwners() {
        fun row(extra: String) = Wire.json.decodeFromString(DirectorySession.serializer(), """{"id":"s1","status":"RUNNING","lastUserText":"Done"$extra}""")
        val named = row(""","lastUserFrom":{"sessionId":"0195c0de-0000-7000-8000-000000000813","title":"Build the package"}""")
        assertEquals(SessionMessageFrom("0195c0de-0000-7000-8000-000000000813", "Build the package"), named.lastUserFrom)
        assertEquals("Build the package: Done", line(named).text)
        assertNull(row(""","lastUserFrom":null""").lastUserFrom)
        assertNull(row("").lastUserFrom)
        assertEquals("You: Done", line(row("")).text)
        // A sender whose title is missing or null is still a sender, and an untitled one.
        assertEquals("Untitled session: Done", line(row(""","lastUserFrom":{"sessionId":"x"}""")).text)
        assertEquals("Untitled session: Done", line(row(""","lastUserFrom":{"sessionId":"x","title":null}""")).text)
    }

    /** A project's row says its coordinator's own line when nothing outranks it (§4.2, the sixth), so it names who sent the message the
     * same way: a task's report is the task's, and only the owner's words are "You". */
    @Test fun theProjectRowsSecondLineNamesWhoSentTheCoordinatorsMessage() {
        fun membership(role: String) = SessionProjectMembership("p1", "Project one", "OPEN", role)
        fun coordinator(from: SessionMessageFrom?) = DirectorySession("coordinator", "Plan the release", status = "AWAITING_INPUT",
            runState = "AWAITING_INPUT", agentId = "w1", lastAssistantText = "The release plan is ready", lastUserText = report,
            lastUserFrom = from, lastTurnAt = "2026-10-04T09:40:00Z", projectMembership = membership("COORDINATOR"))
        val task = DirectorySession("task", "Build the package", status = "AWAITING_INPUT", runState = "AWAITING_INPUT", agentId = "w1",
            lastAssistantText = "Built.", lastTurnAt = "2026-10-04T09:30:00Z", projectMembership = membership("TASK"))
        fun rowLine(from: SessionMessageFrom?) = SessionProjectGrouping.listing(listOf(coordinator(from), task), emptyList(), emptyList(),
            SessionView.OPEN, byTag = false, now = now).projects.single().line
        assertEquals(SessionLine("Build the package: Done: the package builds", Tone.PREVIEW), rowLine(SessionMessageFrom("task", "Build the package")))
        assertEquals(SessionLine("You: Done: the package builds", Tone.PREVIEW), rowLine(null))
    }
}
