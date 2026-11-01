package io.orbitd.android.core.cards

import io.orbitd.android.core.protocol.Wire
import io.orbitd.android.core.realtime.RunEvent
import java.time.Instant
import java.time.ZoneId
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/**
 * A fact told to this session is drawn from the card recorded beside the turn (`coordinatorDelivery`) as one line — its sentence, then
 * "Sent to the coordinator · 19:30" — never from the words, which stay what the agent read (web lib/coordinatorDelivery.ts, OrbitKit
 * CoordinatorDelivery).
 */
class CoordinatorDeliveryLineTest {
    private val title = "Wiki model queue: one claim can take more requests than the concurrency room"
    private val task = """{"id":"01a0d6a9-d763-70e1-b4cf-8793e971b511","title":"$title"}"""
    private val told = "From Orbit · project “Runner link v1” has a revision of completion evidence for you to decide\n\nTask “$title” submitted revision 1."

    private fun payload(kind: String, revision: Int? = 1, count: Int? = 3, taskJson: String? = task) = buildString {
        append("""{"kind":"$kind"""")
        append(""","task":${taskJson ?: "null"}""")
        append(""","revision":${revision ?: "null"},"count":${count ?: "null"}""")
        append(""","deliveredAt":"2026-10-31T11:30:00.000Z"}""")
    }
    private fun card(json: String) = Wire.json.parseToJsonElement(json).jsonObject
    private fun echo(json: String?) = RunEvent("user", 9, buildJsonObject {
        put("text", told); json?.let { put("coordinatorDelivery", Wire.json.parseToJsonElement(it)) }
    }, "turn-delivery")

    /** Every kind's sentence, as the design's table writes it — a task's title, a revision, and what is counted. */
    @Test fun eachKindSaysTheDesignsSentence() {
        val expected = linkedMapOf(
            "EVIDENCE_SUBMITTED" to "Evidence revision 1 submitted: $title",
            "EVIDENCE_MOVED_IN" to "Evidence revision 1 moved in: $title",
            "DEPENDENT_READY" to "Can start now: $title",
            "TASK_DISPATCH_REFUSED" to "Could not start: $title",
            "PROJECT_BLOCKER_RAISED" to "Blocker raised: $title",
            "CRITERION_UNLANDED" to "Work not on main yet: 3 tasks",
            "ACCEPTANCE_LANDED" to "All 3 criteria landed",
            "ACCEPTANCE_LANDED_HELD" to "All 3 criteria landed, Done held back",
            "ACCEPTANCE_LANDED_DONE" to "All 3 criteria landed, recorded Done",
            "LOOKS_FINISHED" to "Looks finished, not recorded Done",
            "SETTLED_UNMERGED" to "Settled with work not on main: 3 commits",
            "CRITERIA_APPROVED" to "Criteria proposal approved",
            "CRITERIA_REJECTED" to "Criteria proposal rejected",
        )
        assertEquals("every kind has a sentence, in the shared order", CoordinatorDeliveryLine.kinds, expected.keys.toList())
        expected.forEach { (kind, sentence) ->
            assertEquals(kind, sentence, CoordinatorDeliveryLine.sentence(card(payload(kind))))
        }
    }

    /** One is said in the singular. */
    @Test fun oneIsSaidInTheSingular() {
        assertEquals("Work not on main yet: 1 task", CoordinatorDeliveryLine.sentence(card(payload("CRITERION_UNLANDED", count = 1))))
        assertEquals("The only criterion landed", CoordinatorDeliveryLine.sentence(card(payload("ACCEPTANCE_LANDED", count = 1))))
        assertEquals("The only criterion landed, Done held back",
            CoordinatorDeliveryLine.sentence(card(payload("ACCEPTANCE_LANDED_HELD", count = 1))))
        assertEquals("The only criterion landed, recorded Done",
            CoordinatorDeliveryLine.sentence(card(payload("ACCEPTANCE_LANDED_DONE", count = 1))))
        assertEquals("Settled with work not on main: 1 commit", CoordinatorDeliveryLine.sentence(card(payload("SETTLED_UNMERGED", count = 1))))
        assertEquals("Work not on main yet: 12 tasks", CoordinatorDeliveryLine.sentence(card(payload("CRITERION_UNLANDED", count = 12))))
    }

    @Test fun theFactIsOneCardDrawnFromItsFields() {
        val drawn = transcriptCards(echo(payload("EVIDENCE_SUBMITTED"))).single()
        assertEquals("record:9:coordinatorDelivery", drawn.key)
        assertEquals(CardFamily.SESSION_REQUEST, drawn.family)
        assertEquals("Evidence revision 1 submitted: $title", drawn.title)
        assertEquals("2026-10-31T11:30:00.000Z", drawn.source.text("deliveredAt"))
        val parsed = CoordinatorDeliveryLine.parse(drawn.source)!!
        assertEquals(CoordinatorDelivery("EVIDENCE_SUBMITTED", CoordinatorDelivery.Task("01a0d6a9-d763-70e1-b4cf-8793e971b511", title), 1, null,
            "2026-10-31T11:30:00.000Z"), parsed)
        assertTrue("an ordinary message is no fact", transcriptCards(echo(null)).isEmpty())
    }

    /** A field the sentence does not name is left out of the card — never said, never linked. */
    @Test fun aFieldTheSentenceDoesNotNameIsLeftOut() {
        assertEquals(CoordinatorDelivery("LOOKS_FINISHED", null, null, null, "2026-10-31T11:30:00.000Z"),
            CoordinatorDeliveryLine.parse(card(payload("LOOKS_FINISHED"))))
        assertEquals(CoordinatorDelivery("DEPENDENT_READY", CoordinatorDelivery.Task("01a0d6a9-d763-70e1-b4cf-8793e971b511", title), null, null,
            "2026-10-31T11:30:00.000Z"), CoordinatorDeliveryLine.parse(card(payload("DEPENDENT_READY"))))
        assertEquals(CoordinatorDelivery("CRITERIA_APPROVED", null, null, null, "2026-10-31T11:30:00.000Z"),
            CoordinatorDeliveryLine.parse(card(payload("CRITERIA_APPROVED", revision = null, count = null, taskJson = null))))
    }

    /** A payload missing what its sentence names — or of a kind no client knows, or with a moment that is not one — is none: never half a line. */
    @Test fun aPayloadThatIsNotACardIsNone() {
        listOf(
            payload("TASK_FAILED"),
            payload("EVIDENCE_SUBMITTED").replace("2026-10-31T11:30:00.000Z", "yesterday"),
            payload("EVIDENCE_SUBMITTED").replace(""","deliveredAt":"2026-10-31T11:30:00.000Z"""", ""),
            payload("EVIDENCE_SUBMITTED", taskJson = null),
            payload("EVIDENCE_SUBMITTED", revision = null),
            payload("EVIDENCE_SUBMITTED", revision = 0),
            payload("EVIDENCE_SUBMITTED").replace(""""revision":1""", """"revision":"1""""),
            payload("EVIDENCE_SUBMITTED").replace(""""revision":1""", """"revision":1.5"""),
            payload("DEPENDENT_READY", taskJson = """{"id":"","title":"$title"}"""),
            payload("DEPENDENT_READY", taskJson = """{"id":"t","title":"  "}"""),
            payload("DEPENDENT_READY", taskJson = """{"id":42,"title":"$title"}"""),
            payload("CRITERION_UNLANDED", count = null),
            payload("SETTLED_UNMERGED", count = -2),
            payload("ACCEPTANCE_LANDED").replace(""""count":3""", """"count":true"""),
            """{"task":$task,"revision":1,"count":3,"deliveredAt":"2026-10-31T11:30:00.000Z"}""",
            "\"Evidence revision 1 submitted\"",
            "null",
        ).forEach { json -> assertTrue(json, transcriptCards(echo(json)).isEmpty()) }
    }

    /** A title is the owner's words: what looks like a placeholder or a replacement pattern in one is text. */
    @Test fun aTitleIsNeverAPattern() {
        val odd = "Ship {count} and {revision} for $& now"
        assertEquals("Can start now: $odd",
            CoordinatorDeliveryLine.sentence(card(payload("DEPENDENT_READY", taskJson = """{"id":"t1","title":"$odd"}"""))))
        assertEquals("Evidence revision 2 submitted: $odd",
            CoordinatorDeliveryLine.sentence(card(payload("EVIDENCE_SUBMITTED", revision = 2, taskJson = """{"id":"t1","title":"$odd"}"""))))
    }

    /**
     * The owner's answer to a criteria proposal goes to whichever session filed it. Told to a task's run — the server's `toCoordinator`
     * false — the line says it was sent to this session and opens to what this session was told; told to the coordinator, it says what it
     * always said.
     */
    @Test fun aReplyToATasksRunSaysThisSession() {
        val zone = ZoneId.of("Asia/Shanghai")
        val now = Instant.parse("2026-10-31T12:00:00Z")
        val reply = payload("CRITERIA_REJECTED", revision = null, count = null, taskJson = null)
        val run = CoordinatorDeliveryLine.parse(card(reply.dropLast(1) + ""","toCoordinator":false}"""))!!
        assertEquals(CoordinatorDelivery("CRITERIA_REJECTED", null, null, null, "2026-10-31T11:30:00.000Z", toCoordinator = false), run)
        assertEquals("Sent to this session · 19:30", CoordinatorDeliveryLine.sent(run, now, zone))
        assertEquals("What this session was told", CoordinatorDeliveryLine.told(run))
        assertEquals("Criteria proposal rejected", CoordinatorDeliveryLine.sentence(run))

        val coordinator = CoordinatorDeliveryLine.parse(card(reply.dropLast(1) + ""","toCoordinator":true}"""))!!
        assertTrue(coordinator.toCoordinator)
        assertEquals("Sent to the coordinator · 19:30", CoordinatorDeliveryLine.sent(coordinator, now, zone))
        assertEquals(OwnerAnswerLine.told, CoordinatorDeliveryLine.told(coordinator))
        assertEquals("What the coordinator was told", CoordinatorDeliveryLine.told(coordinator))
    }

    /** Only the server's own `false` says this conversation is not the coordinator: a card stored before the field reads as it was drawn. */
    @Test fun onlyTheServersFalseSaysNotTheCoordinator() {
        assertTrue("a card with no field", CoordinatorDeliveryLine.parse(card(payload("LOOKS_FINISHED")))!!.toCoordinator)
        listOf("\"false\"", "0", "null", "\"no\"").forEach { odd ->
            val json = payload("LOOKS_FINISHED").dropLast(1) + ""","toCoordinator":""" + odd + "}"
            assertTrue(odd, CoordinatorDeliveryLine.parse(card(json))!!.toCoordinator)
        }
    }

    /** Then when it was sent, on the receipts' clock: the time that day, the date as well after it (`OwnerAnswerLine.line`). */
    @Test fun theLineSaysSentToTheCoordinatorAndWhen() {
        val parsed = CoordinatorDeliveryLine.parse(card(payload("LOOKS_FINISHED")))!!
        val zone = ZoneId.of("Asia/Shanghai")
        assertEquals("Sent to the coordinator · 19:30", CoordinatorDeliveryLine.sent(parsed, Instant.parse("2026-10-31T12:00:00Z"), zone))
        assertEquals("Sent to the coordinator · 10/31 19:30", CoordinatorDeliveryLine.sent(parsed, Instant.parse("2026-11-02T12:00:00Z"), zone))
        assertEquals(CoordinatorQueue.sentLine(OwnerReview.receiptTime("2026-10-31T11:30:00.000Z", Instant.parse("2026-10-31T12:00:00Z"), zone)),
            CoordinatorDeliveryLine.sent(parsed, Instant.parse("2026-10-31T12:00:00Z"), zone))
    }
}
