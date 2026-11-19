package io.orbitd.android.directory

import io.orbitd.android.core.cards.CoordinatorDelivery
import io.orbitd.android.core.cards.CoordinatorDeliveryLine
import io.orbitd.android.core.protocol.Wire
import io.orbitd.android.directory.SessionLine.Tone
import java.time.Instant
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** A message Orbit wrote itself, on the session row (design §3.5, owner 2026-11-07): the row says "Orbit", never "You" — a coordinator's
 * notification in the sentence its line in the conversation says ([CoordinatorDeliveryLine.sentence]), any other message of Orbit's in its
 * first line. OrbitKit's `SessionLineOrbitTests` and the web's `sessionLine says Orbit for the message Orbit wrote`, case for case;
 * SessionLineCopyParityTest holds the word and the line to both. */
class SessionLineOrbitTest {
    private val now = Instant.parse("2026-10-04T10:00:00Z")
    private val evidence = CoordinatorDelivery("EVIDENCE_SUBMITTED", CoordinatorDelivery.Task("task-1", "Write Orbit on the row"), 2, null,
        "2026-11-07T07:30:00.000Z")
    private val notification = "From Orbit · project “Rows” has a revision of completion evidence for you to decide\n\nTask “Write Orbit on the row” …"
    private val wake = "Orbit Watch w-1 matched at generation 2: **CI** finished\n\nThis turn was queued by the watch, not typed by a person."

    /** A row's mark as the server sends it: `{ coordinatorDelivery: <card> | null }`. */
    private fun mark(card: CoordinatorDelivery? = null): JsonElement = buildJsonObject {
        if (card == null) put("coordinatorDelivery", JsonNull) else putJsonObject("coordinatorDelivery") {
            put("kind", card.kind)
            card.task?.let { task -> putJsonObject("task") { put("id", task.id); put("title", task.title) } }
            card.revision?.let { put("revision", it) }
            card.count?.let { put("count", it) }
            put("deliveredAt", card.deliveredAt)
            put("toCoordinator", card.toCoordinator)
        }
    }

    private fun session(status: String, lastAssistantText: String? = null, lastToolUse: String? = null, lastUserText: String? = null,
        lastUserFrom: SessionMessageFrom? = null, lastUserFromOrbit: JsonElement? = null, pendingApprovals: Int = 0) =
        DirectorySession("s", "t", status = status, lastAssistantText = lastAssistantText, lastToolUse = lastToolUse,
            lastUserText = lastUserText, lastUserFrom = lastUserFrom, lastUserFromOrbit = lastUserFromOrbit, pendingApprovals = pendingApprovals)
    private fun line(s: DirectorySession, live: Boolean = true) = SessionLine.make(s, live, now = now)

    @Test fun saysANotificationsOwnSentenceWhileTheTurnRunsAfterItStoppedAndInTrash() {
        assertEquals("Orbit", SessionLineCopy.orbit)
        val said = SessionLine("Orbit: Evidence revision 2 submitted: Write Orbit on the row", Tone.PREVIEW)
        assertEquals(said, line(session("RUNNING", "previous reply", lastUserText = notification, lastUserFromOrbit = mark(evidence))))
        assertEquals(said, line(session("AWAITING_INPUT", "previous reply", lastUserText = notification, lastUserFromOrbit = mark(evidence))))
        assertEquals(said, line(session("INTERRUPTED", lastUserText = notification, lastUserFromOrbit = mark(evidence))))
        assertEquals(said, line(session("FAILED", lastUserText = notification, lastUserFromOrbit = mark(evidence)), live = false))
    }

    @Test fun saysEveryKindOfNotificationAsItsLineInTheConversationSaysIt() {
        CoordinatorDeliveryLine.kinds.forEach { kind ->
            // Read as the conversation reads a card: the fields its sentence does not name are left out.
            val card = CoordinatorDeliveryLine.parse(buildJsonObject {
                put("kind", kind)
                putJsonObject("task") { put("id", "task-1"); put("title", "Build the package") }
                put("revision", 3); put("count", 2); put("deliveredAt", "2026-11-07T07:30:00.000Z")
            }) ?: throw AssertionError("no card for $kind")
            assertEquals(kind, SessionLine("Orbit: ${CoordinatorDeliveryLine.sentence(card)}", Tone.PREVIEW),
                line(session("AWAITING_INPUT", lastUserText = notification, lastUserFromOrbit = mark(card))))
        }
        // Spelled out for three of them, so a sentence that changed is read here as well as in the conversation.
        fun said(card: CoordinatorDelivery) = line(session("AWAITING_INPUT", lastUserText = notification, lastUserFromOrbit = mark(card))).text
        assertEquals("Orbit: Work not on main yet: 2 tasks", said(CoordinatorDelivery("CRITERION_UNLANDED", null, null, 2, "2026-11-07T07:30:00.000Z")))
        assertEquals("Orbit: The only criterion landed, recorded Done",
            said(CoordinatorDelivery("ACCEPTANCE_LANDED_DONE", null, null, 1, "2026-11-07T07:30:00.000Z")))
        assertEquals("Orbit: Criteria proposal approved", said(CoordinatorDelivery("CRITERIA_APPROVED", null, null, null, "2026-11-07T07:30:00.000Z")))
    }

    @Test fun saysTheFirstLineOfAnyOtherMessageOfOrbitsFlattenedLikeAPreview() {
        assertEquals(SessionLine("Orbit: Orbit Watch w-1 matched at generation 2: CI finished", Tone.PREVIEW),
            line(session("AWAITING_INPUT", lastUserText = wake, lastUserFromOrbit = mark())))
        // Blank lines before it are not its first line.
        assertEquals("Orbit: Start the task “Write Orbit on the row”.",
            line(session("RUNNING", lastUserText = "\n  \nStart the task “Write Orbit on the row”.\n\nTask details:", lastUserFromOrbit = mark())).text)
    }

    @Test fun saysYouOnlyForTheOwnersWordsAndNamesAnotherSessionAsBefore() {
        assertEquals("You: ship it", line(session("AWAITING_INPUT", lastUserText = "ship it")).text)
        // An older server sends no mark at all: every message reads as it did.
        assertEquals("You: From Orbit · project “Rows” has a revision of completion evidence for you to decide Task “Write Orbit on the row” …",
            line(session("AWAITING_INPUT", lastUserText = notification)).text)
        assertEquals("Build the package: ship it",
            line(session("AWAITING_INPUT", lastUserText = "ship it", lastUserFrom = SessionMessageFrom("s1", "Build the package"))).text)
    }

    @Test fun changesNothingAboveTheMessageAndAMarkWithNoMessageMakesNoLine() {
        assertEquals(SessionLine("Running Bash…", Tone.RUNNING),
            line(session("RUNNING", lastToolUse = "Bash", lastUserText = notification, lastUserFromOrbit = mark(evidence))))
        assertEquals(SessionLine("Waiting for approval", Tone.APPROVAL),
            line(session("AWAITING_INPUT", lastUserText = notification, lastUserFromOrbit = mark(evidence), pendingApprovals = 1)))
        assertEquals(SessionLine("On it.", Tone.PREVIEW), line(session("AWAITING_INPUT", "On it.", lastUserFromOrbit = mark(evidence))))
    }

    /** A row's `lastUserFromOrbit`, read leniently: an object marks the message Orbit's, with the card when this build can read it; null is
     * anybody else's; a missing key is an older server; and a value this build cannot read is no mark, rather than a list that fails. */
    @Test fun decodesTheMarkAndToleratesAnOlderOrAnOddServer() {
        fun row(extra: String) = Wire.json.decodeFromString(DirectorySession.serializer(),
            """{"id":"s1","status":"AWAITING_INPUT","lastUserText":"From Orbit · project “Rows” has news"$extra}""")
        val card = """{"kind":"EVIDENCE_SUBMITTED","task":{"id":"task-1","title":"Write Orbit on the row"},"revision":2,"count":null,"deliveredAt":"2026-11-07T07:30:00.000Z","toCoordinator":true}"""
        val told = row(""","lastUserFrom":null,"lastUserFromOrbit":{"coordinatorDelivery":$card}""")
        assertEquals(OrbitMessageFrom(evidence), OrbitMessageFrom.of(told.lastUserFromOrbit))
        assertEquals("Orbit: Evidence revision 2 submitted: Write Orbit on the row", line(told).text)
        val plain = row(""","lastUserFromOrbit":{"coordinatorDelivery":null}""")
        assertEquals(OrbitMessageFrom(), OrbitMessageFrom.of(plain.lastUserFromOrbit))
        assertEquals("Orbit: From Orbit · project “Rows” has news", line(plain).text)
        // A card a later server writes, which this build cannot read: still Orbit's, with its first line.
        val later = row(""","lastUserFromOrbit":{"coordinatorDelivery":{"kind":"A_KIND_FROM_A_LATER_SERVER","deliveredAt":"2026-11-07T07:30:00.000Z"}}""")
        assertEquals(OrbitMessageFrom(), OrbitMessageFrom.of(later.lastUserFromOrbit))
        assertNull(OrbitMessageFrom.of(row(""","lastUserFromOrbit":null""").lastUserFromOrbit))
        assertNull(OrbitMessageFrom.of(row("").lastUserFromOrbit))
        assertEquals("You: From Orbit · project “Rows” has news", line(row("")).text)
        // A shape it cannot read at all is none, and the rest of the row still reads.
        val odd = row(",\"lastUserFromOrbit\":\"Orbit\"")
        assertNull(OrbitMessageFrom.of(odd.lastUserFromOrbit))
        assertEquals("You: From Orbit · project “Rows” has news", line(odd).text)
    }

    /** A project's row says its coordinator's own line when nothing outranks it (§4.2, the sixth): a notification the coordinator has not
     * answered yet says Orbit, in its line's sentence. */
    @Test fun theProjectRowsSecondLineSaysOrbitForTheCoordinatorsNotification() {
        fun membership(role: String) = SessionProjectMembership("p1", "Project one", "OPEN", role)
        fun coordinator(mark: JsonElement?, text: String) = DirectorySession("coordinator", "Plan the release", status = "AWAITING_INPUT",
            runState = "AWAITING_INPUT", agentId = "w1", lastAssistantText = "The release plan is ready", lastUserText = text,
            lastUserFromOrbit = mark, lastTurnAt = "2026-10-04T09:40:00Z", projectMembership = membership("COORDINATOR"))
        val task = DirectorySession("task", "Build the package", status = "AWAITING_INPUT", runState = "AWAITING_INPUT", agentId = "w1",
            lastAssistantText = "Built.", lastTurnAt = "2026-10-04T09:30:00Z", projectMembership = membership("TASK"))
        fun rowLine(mark: JsonElement?, text: String) = SessionProjectGrouping.listing(listOf(coordinator(mark, text), task), emptyList(),
            emptyList(), SessionView.OPEN, byTag = false, now = now).projects.single().line
        assertEquals(SessionLine("Orbit: Evidence revision 2 submitted: Write Orbit on the row", Tone.PREVIEW), rowLine(mark(evidence), notification))
        assertEquals(SessionLine("Orbit: Orbit Watch w-1 matched at generation 2: CI finished", Tone.PREVIEW), rowLine(mark(), wake))
        assertEquals(SessionLine("You: Ship the release", Tone.PREVIEW), rowLine(null, "Ship the release"))
    }
}
