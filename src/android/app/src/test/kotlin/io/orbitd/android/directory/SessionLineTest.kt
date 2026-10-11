package io.orbitd.android.directory

import io.orbitd.android.directory.SessionLine.Tone
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/** OrbitKit's `SessionLineTests` and `SessionLinePlainPreviewTests`, case for case: the line a session's row — and so a project
 * row's second line — says. */
class SessionLineTest {
    private val now = Instant.parse("2026-10-04T10:00:00Z")

    private fun session(status: String, lastAssistantText: String? = null, lastToolUse: String? = null, lastUserText: String? = null,
        runningBgCount: Int? = null, engineTurnActive: Boolean? = null, pendingApprovals: Int = 0, endReason: String? = null,
        runningSubagentCount: Int? = null, waitingKind: String? = null, ownerItems: String? = null, review: String? = null,
        retryAt: String? = null, error: String? = null, recapText: String? = null, recapAt: String? = null) =
        DirectorySession("s", "t", status = status, lastAssistantText = lastAssistantText, lastToolUse = lastToolUse, lastUserText = lastUserText,
            runningBgCount = runningBgCount, engineTurnActive = engineTurnActive, pendingApprovals = pendingApprovals, endReason = endReason,
            runningSubagentCount = runningSubagentCount, waitingKind = waitingKind, ownerItems = ownerItems?.let { Json.parseToJsonElement(it).jsonArray },
            confirmationUnderReview = review?.let { Json.parseToJsonElement(it).jsonObject }, retryAt = retryAt, error = error,
            recapText = recapText, recapAt = recapAt)
    private fun line(s: DirectorySession, live: Boolean = true) = SessionLine.make(s, live, now = now)

    // The recap (0418): its label is the clock time the server wrote it, computed here with the same formatter and zone the
    // row's own `recapLabel` uses, so the expectation holds wherever the test runs.
    private val recap = "Moved the recap onto the list row; the three states are covered by tests."
    /** The instant `line` builds every line at — the same one a same-day recap is written at, in every time zone. */
    private val recapAt = now.toString()
    private fun clock(iso: String, zone: ZoneId = ZoneId.systemDefault()) =
        DateTimeFormatter.ofPattern("h:mm a", Locale.US).withZone(zone).format(Instant.parse(iso))
    private fun day(iso: String, zone: ZoneId = ZoneId.systemDefault()) =
        DateTimeFormatter.ofPattern("EEE, MMM d", Locale.US).withZone(zone).format(Instant.parse(iso))

    /** A turn the runtime started for itself keeps the session parked while it streams: the row says it is working. */
    @Test fun selfDrivenTurnReadsAsWorkingNotParked() {
        assertEquals(SessionLine("Running Bash…", Tone.RUNNING), line(session("AWAITING_INPUT", "Waiting for the completion notification.", "Bash", engineTurnActive = true)))
        assertEquals(SessionLine("Running…", Tone.RUNNING), line(session("AWAITING_INPUT", engineTurnActive = true)))
        assertEquals(SessionLine("Running…", Tone.RUNNING), line(session("AWAITING_INPUT", runningBgCount = 2, engineTurnActive = true)))
        assertEquals(SessionLine("All done.", Tone.PREVIEW), line(session("AWAITING_INPUT", "All done.", engineTurnActive = false)))
    }

    @Test fun runningPrioritisesApprovalThenToolThenPreview() {
        assertEquals(SessionLine("Waiting for approval", Tone.APPROVAL), line(session("RUNNING", lastToolUse = "Bash", pendingApprovals = 2)))
        assertEquals(SessionLine("Running task_create…", Tone.RUNNING), line(session("RUNNING", "hi", "mcp__orbit__task_create")))
        assertEquals(SessionLine("Working on it", Tone.PREVIEW), line(session("RUNNING", "Working on it")))
        assertEquals(SessionLine("Running…", Tone.RUNNING), line(session("RUNNING")))
    }

    @Test fun runningShowsPendingUserMessageBeforeStaleReply() {
        assertEquals(SessionLine("You: fix the drawer shadow", Tone.PREVIEW), line(session("RUNNING", "previous reply", lastUserText = "fix the drawer shadow")))
        assertEquals(SessionLine("Running Bash…", Tone.RUNNING), line(session("RUNNING", lastToolUse = "Bash", lastUserText = "fix the drawer shadow")))
        assertEquals("You: please run the tests", line(session("RUNNING", lastUserText = "please `run` the **tests**")).text)
    }

    @Test fun pendingAndBackground() {
        assertEquals(SessionLine("Queued", Tone.QUEUED), line(session("PENDING")))
        assertEquals(SessionLine("2 background processes running…", Tone.BACKGROUND), line(session("AWAITING_INPUT", runningBgCount = 2)))
    }

    /** The rolling recap (0418) takes the place of the raw last reply, under its own muted label — and only that place. */
    @Test fun recapTakesThePlaceOfTheReplyPreview() {
        val recapped = line(session("AWAITING_INPUT", "Committed the row change.", recapText = recap, recapAt = recapAt))
        assertEquals(Tone.PREVIEW, recapped.tone)
        assertEquals(recap, recapped.text)
        assertEquals("Recap · ${clock(recapAt)}", recapped.label)

        // A payload that carried the text without a time keeps the word.
        assertEquals(SessionLine(recap, Tone.PREVIEW, "Recap"),
            line(session("AWAITING_INPUT", "Committed the row change.", recapText = recap, recapAt = null)))

        // Another day's recap wears the date too: a bare clock time on yesterday's row misleads.
        val old = "2026-10-01T10:00:00Z"
        assertEquals("Recap · ${day(old)}, ${clock(old)}",
            line(session("AWAITING_INPUT", "Committed the row change.", recapText = recap, recapAt = old)).label)

        // No recap — or a blank one, which the server never stores — is the reply preview it always had.
        assertEquals(SessionLine("Committed the row change.", Tone.PREVIEW), line(session("AWAITING_INPUT", "Committed the row change.")))
        assertEquals(SessionLine("Committed the row change.", Tone.PREVIEW), line(session("AWAITING_INPUT", "Committed the row change.", recapText = "   ")))
        // Trash keeps it too: nothing live is left to outrank it there.
        assertEquals("Recap · ${clock(recapAt)}",
            line(session("AWAITING_INPUT", "reply", recapText = recap, recapAt = recapAt), live = false).label)
    }

    /** The account's Session recaps switch (Settings): off, the same row falls through to the reply. */
    @Test fun recapsOffFallsBackToTheReply() {
        val recapped = session("AWAITING_INPUT", "Committed the row change.", recapText = recap, recapAt = recapAt)
        assertEquals(SessionLine(recap, Tone.PREVIEW, "Recap · ${clock(recapAt)}"),
            SessionLine.make(recapped, live = true, recaps = true, now = now))
        assertEquals(SessionLine("Committed the row change.", Tone.PREVIEW),
            SessionLine.make(recapped, live = true, recaps = false, now = now))
    }

    /** Every live line still outranks the recap: it is newer work, not older prose. */
    @Test fun liveLinesOutrankTheRecap() {
        assertEquals(Tone.APPROVAL, line(session("AWAITING_INPUT", pendingApprovals = 1, recapText = recap, recapAt = recapAt)).tone)
        assertEquals(SessionLine("Running Bash…", Tone.RUNNING), line(session("RUNNING", lastToolUse = "Bash", recapText = recap, recapAt = recapAt)))
        assertEquals(SessionLine("You: and now the footer?", Tone.PREVIEW),
            line(session("AWAITING_INPUT", lastUserText = "and now the footer?", recapText = recap, recapAt = recapAt)))
        assertEquals(SessionLine("Background process running…", Tone.BACKGROUND),
            line(session("AWAITING_INPUT", runningBgCount = 1, recapText = recap, recapAt = recapAt)))
    }

    @Test fun parkedShowsLastReplyAndStripsMarkdown() {
        val parked = line(session("AWAITING_INPUT", "## Done\n\nFixed the `Session` model and ran ```swift\ntest()\n``` — all green."))
        assertEquals(Tone.PREVIEW, parked.tone)
        assertEquals("Done Fixed the Session model and ran — all green.", parked.text)
    }

    @Test fun interruptedTurnShowsTheUnansweredMessage() {
        assertEquals(SessionLine("You: 设置按钮的底色很奇怪，请帮我 review", Tone.PREVIEW),
            line(session("INTERRUPTED", "previous reply", lastUserText = "设置按钮的底色很奇怪，请帮我 review")))
        assertEquals(SessionLine("Background process running…", Tone.BACKGROUND), line(session("AWAITING_INPUT", lastUserText = "run the tests", runningBgCount = 1)))
    }

    @Test fun fallsBackToStateWordWithoutReply() {
        assertEquals(SessionLine("Succeeded", Tone.PREVIEW), line(session("SUCCEEDED")))
        assertEquals(SessionLine("Failed", Tone.PREVIEW), line(session("FAILED")))
        assertEquals(SessionLine("Interrupted", Tone.PREVIEW), line(session("INTERRUPTED")))
        assertEquals(SessionLine("Ended", Tone.PREVIEW), line(session("CANCELLED", endReason = "deleted")))
        assertEquals(SessionLine("Ended", Tone.PREVIEW), line(session("CANCELLED", endReason = "completed"), live = false))
        // The state word's other readings: a retry armed, and a runner that went away.
        assertEquals("Retrying", line(session("FAILED", retryAt = "2026-10-04T10:00:30Z")).text)
        assertEquals("Failed", line(session("FAILED", retryAt = "2026-10-04T09:57:00Z")).text)
        assertEquals("Disconnected", line(session("FAILED", error = "runner offline")).text)
        assertEquals("Waiting for your reply", line(session("AWAITING_INPUT")).text)
    }

    /** The server's `runState` wins over the raw status; a value this build does not know falls through to it. */
    @Test fun theRunStateFieldWinsOverTheRawStatus() {
        assertEquals("Queued", line(DirectorySession("s", status = "AWAITING_INPUT", runState = "QUEUED")).text)
        assertEquals("Waiting for your reply", line(DirectorySession("s", status = "AWAITING_INPUT", runState = "SOMETHING_NEW")).text)
        assertEquals("Ended", line(DirectorySession("s", status = "INTERRUPTED", endReason = "user_ended")).text)
    }

    /** What waits on you, in the words of whatever waits (`SessionHeader.waitingWord`). */
    @Test fun waitingWordsNameWhatWaits() {
        assertEquals("Waiting for your confirmation", line(session("AWAITING_INPUT", pendingApprovals = 1, waitingKind = "OWNER_CONFIRMATION")).text)
        assertEquals("Ready to start", line(session("AWAITING_INPUT", pendingApprovals = 1, waitingKind = "START_REQUEST")).text)
        assertEquals("Ready to close", line(session("AWAITING_INPUT", pendingApprovals = 1, waitingKind = "DONE_REQUEST")).text)
        assertEquals("Record as done…", line(session("AWAITING_INPUT", pendingApprovals = 1, waitingKind = "RECORD_AS_DONE")).text)
        assertEquals("Waiting for approval", line(session("AWAITING_INPUT", pendingApprovals = 1, waitingKind = "UNKNOWN_KIND")).text)
        // An owner item: the oldest known kind's word; an unknown kind or an unreadable instant never wins.
        val items = """[{"itemId":"a","kind":"ESCALATED","title":"x","since":"2026-10-04T09:30:00Z"},
            {"itemId":"b","kind":"FUSE_PAUSED","title":"y","since":"2026-10-04T09:00:00Z"},
            {"itemId":"c","kind":"SOMETHING_NEW","title":"z","since":"2026-10-04T08:00:00Z"},
            {"itemId":"d","kind":"COORDINATOR_QUESTION","title":"q","since":"invalid"}]"""
        assertEquals(SessionLine("Paused", Tone.APPROVAL), line(session("AWAITING_INPUT", pendingApprovals = 1, waitingKind = "OWNER_ITEM", ownerItems = items)))
        assertEquals("Waiting for approval", line(session("AWAITING_INPUT", pendingApprovals = 1, waitingKind = "OWNER_ITEM")).text)
    }

    @Test fun underReviewSaysWhoHasItAndSubagentsAreWork() {
        assertEquals(SessionLine("Under review · Release reviewer", Tone.REVIEW), line(session("AWAITING_INPUT", review = """{"reviewerTitle":" Release reviewer "}""")))
        assertEquals(SessionLine("Under review · Reviewer", Tone.REVIEW), line(session("AWAITING_INPUT", review = """{"reviewerTitle":null}""")))
        assertEquals(SessionLine("Running Agent…", Tone.RUNNING), line(session("RUNNING", runningSubagentCount = 1)))
        assertEquals(SessionLine("Running 3 agents…", Tone.RUNNING), line(session("AWAITING_INPUT", "reply", runningSubagentCount = 3, runningBgCount = 1)))
    }

    /** The list payload's fields decode, null for a server that sends none. */
    @Test fun sessionDecodesPreviewFields() {
        val s = io.orbitd.android.core.protocol.Wire.json.decodeFromString(DirectorySession.serializer(),
            """{"id":"s1","status":"RUNNING","lastAssistantText":"hello","lastToolUse":"Read","lastUserText":"hi there","runningBgCount":1,
               "recapText":"Moved the recap onto the list row.","recapAt":"2026-10-04T09:38:00.000Z",
               "runningSubagentCount":null,"engineTurnActive":null,"waitingKind":null,"ownerItems":[],"retryAt":null,"projectMembership":
               {"projectId":"p1","projectTitle":"Project one","projectStatus":"OPEN","role":"SOMETHING_NEW"}}""")
        assertEquals("hello", s.lastAssistantText); assertEquals("Read", s.lastToolUse); assertEquals("hi there", s.lastUserText)
        assertEquals(1, s.runningBgCount); assertNull(s.runningSubagentCount)
        assertEquals("Moved the recap onto the list row.", s.recapText); assertEquals("2026-10-04T09:38:00.000Z", s.recapAt)
        assertEquals(SessionProjectMembership("p1", "Project one", "OPEN", "SOMETHING_NEW"), s.projectMembership)
        assertFalse(s.projectMembership!!.isCoordinator)
    }

    // SessionLinePlainPreviewTests

    @Test fun orbitReferenceKeepsItsNameAndDropsItsTarget() {
        val line = plainPreview("Filed [runner + web：配额按账户归属](orbit-task:34TcwQ8x2kLmNpRsTuVwX) for the quota split.")
        assertEquals("Filed runner + web：配额按账户归属 for the quota split.", line)
        assertFalse(line.contains("]("))
    }

    @Test fun ordinaryLinkKeepsItsTextAndDropsItsUrl() {
        assertEquals("See the migration guide before upgrading.", plainPreview("See [the migration guide](https://example.com/docs/migrate?from=6#steps) before upgrading."))
    }

    @Test fun everyLinkInAMultiLineReplyIsFlattenedListItemsIncluded() {
        val md = listOf("Done:", "- [Fix login redirect](orbit-task:34TqaiYd61qX2pspp4su0) landed", "- CI: [run 123](https://github.com/o/r/actions/runs/123)").joinToString("\n")
        assertEquals("Done: Fix login redirect landed CI: run 123", plainPreview(md))
    }

    @Test fun inlineCodeInsideALinksTextIsUnwrapped() {
        assertEquals("Moved it to plainPreview.ts.", plainPreview("Moved it to [`plainPreview.ts`](src/web/src/lib/plainPreview.ts)."))
    }

    @Test fun imageReadsAsItsAltTextALinkedOneIncluded() {
        assertEquals("CI run is green", plainPreview("![CI run](https://example.com/shot.png) is green"))
        assertEquals("badge passing", plainPreview("[![badge](https://example.com/b.svg)](https://example.com/ci) passing"))
        assertEquals("done", plainPreview("![](orbit-attachment:abc) done"))
    }

    @Test fun bracketsInsideCodeAreLeftAlone() {
        assertEquals("Call render[0](x) and read xs[i].", plainPreview("Call `render[0](x)` and read `xs[i]`."))
        assertEquals("[x](y) is not a link, z is", plainPreview("`[x](y)` is not a link, [z](https://example.com/z) is"))
        assertEquals("Then ship it.", plainPreview("```ts\nconst a = [x](y);\n```\nThen [ship it](https://example.com)."))
    }

    @Test fun theRestFlattensAsBefore() {
        assertEquals("Heading quoted bold and em item", plainPreview("## Heading\n> quoted\n- **bold** and _em_ item"))
        assertEquals("[x] done, [y] (not a link)", plainPreview("- [x] done, [y] (not a link)"))
        assertEquals("run npm test twice", plainPreview("run `npm test`\n\n  twice"))
        // ICU's whitespace, which the Swift matches with, includes the ideographic space.
        assertEquals("a b", plainPreview("a　　b"))
    }

    @Test fun theListRowShowsLinkText() {
        assertEquals(SessionLine("Filed Fix login redirect.", Tone.PREVIEW), line(session("AWAITING_INPUT", "Filed [Fix login redirect](orbit-task:34TqaiYd61qX2pspp4su0).")))
        assertEquals(SessionLine("You: Look at this run", Tone.PREVIEW), line(session("AWAITING_INPUT", lastUserText = "Look at [this run](https://github.com/o/r/actions/runs/123)")))
    }
}
