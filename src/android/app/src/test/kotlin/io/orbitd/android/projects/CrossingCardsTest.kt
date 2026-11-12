package io.orbitd.android.projects

import io.orbitd.android.core.cards.OwnerReview
import io.orbitd.android.core.cards.text
import java.time.Instant
import java.time.ZoneOffset
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/** The coordinator conversation's crossing cards (task 34vT0PEhdlq1lILqsg2WG's shared spec): which rows make one card, and what a
 * card and its review say for each kind and state. */
class CrossingCardsTest {
    private val here = "AAATarget"
    private val now = Instant.parse("2026-11-10T12:00:00Z")
    private val utc = ZoneOffset.UTC

    private fun row(id: String, kind: String = "MOVE_TASK", from: String = "AAASource", to: String = here, state: String = "PENDING",
        requestedAt: String = "2026-11-10T09:00:00.000Z", decidedAt: String? = null, criterion: String? = null, criterionText: String? = "text",
        withdrawn: String? = null, reason: String? = null, fromTitle: String? = "Runner v1", publicId: String? = "P$id") = buildJsonObject {
        put("id", id); publicId?.let { put("publicId", it) }; put("fromProjectId", from); put("toProjectId", to); put("kind", kind)
        put("crossingKey", "key-$id"); put("state", state); put("title", "Title $id"); put("requestedAt", requestedAt)
        put("decidedAt", decidedAt?.let(::JsonPrimitive) ?: JsonNull)
        fromTitle?.let { t -> putJsonObject("fromProject") { put("title", t) } }
        if (kind != "FILE_TASK") putJsonObject("subjectTask") { put("title", "Subject $id") }
        criterion?.let { key -> putJsonObject("requestedCriterion") { put("key", key); put("text", criterionText?.let(::JsonPrimitive) ?: JsonNull) } }
        withdrawn?.let { key -> putJsonObject("withdrawnCriterion") { put("key", key); put("text", "old") } }
        reason?.let { put("reason", it) }
    }
    private fun at(minute: Int) = "2026-11-10T09:%02d:00.000Z".format(minute)
    private fun batch(vararg rows: JsonObject) = CrossingBatch(rows.toList())

    // MARK: batching

    @Test fun rowsAskingThisProjectGroupBySourceAndKindOldestFirst() {
        val rows = listOf(
            row("m2", requestedAt = at(2)), row("m1", requestedAt = at(1)),
            row("f1", kind = "FILE_TASK", requestedAt = at(3)),
            row("o1", from = "AAAOther", requestedAt = at(0)),
            row("away", to = "AAAElsewhere", requestedAt = at(4)))
        val batches = CrossingCards.batches(rows, here)
        assertEquals(listOf(listOf("o1"), listOf("m1", "m2"), listOf("f1")), batches.map { b -> b.rows.map { it.text("id") } })
        assertEquals("crossing-batch-Po1", batches[0].id)
        assertEquals(at(1), batches[1].moment)
    }

    @Test fun theTargetIsMatchedByEitherSpellingOfItsId() {
        val uuid = "0195c0de-0000-7000-8000-000000000002"
        val rows = listOf(JsonObject(row("a", to = uuid) + ("toProjectPublicId" to JsonPrimitive("AAAPublic"))))
        assertEquals(1, CrossingCards.batches(rows, "AAAPublic").size)
        assertEquals(1, CrossingCards.batches(rows, uuid.uppercase()).size)
        assertEquals("crossing-batch-a", CrossingCards.batches(listOf(row("a", publicId = null)), here).single().id)
    }

    @Test fun aRowJoinsOnlyWhileTheBatchIsStillOpen() {
        val rows = listOf(
            row("a", state = "APPROVED", requestedAt = at(0), decidedAt = at(5)),
            row("b", requestedAt = at(3)),                                         // a still undecided at 09:03: joins
            row("c", state = "APPROVED", requestedAt = at(10), decidedAt = at(11)), // b still pending: joins
            row("d", kind = "DEPEND_ON_TASK", requestedAt = at(1)))
        assertEquals(listOf(listOf("a", "b", "c"), listOf("d")), CrossingCards.batches(rows, here).map { b -> b.rows.map { it.text("id") } })
        val answered = listOf(
            row("a", state = "APPROVED", requestedAt = at(0), decidedAt = at(5)),
            row("b", state = "DENIED", requestedAt = at(6), decidedAt = at(7)),   // a answered at 09:05: a new card
            row("c", requestedAt = at(7)))                                        // decided exactly then: not open
        assertEquals(listOf(listOf("a"), listOf("b"), listOf("c")), CrossingCards.batches(answered, here).map { b -> b.rows.map { it.text("id") } })
    }

    @Test fun aBatchKnowsWhatWaitsAndHowItWasAnswered() {
        val live = batch(row("a", state = "APPROVED", decidedAt = at(5)), row("b"))
        assertTrue(live.live); assertEquals(1, live.pending.size); assertNull(live.verdict)
        assertEquals(CrossingCards.Verdict.APPROVED, batch(row("a", state = "APPLIED", decidedAt = at(5)), row("b", state = "APPROVED", decidedAt = at(9))).verdict)
        assertEquals(CrossingCards.Verdict.REFUSED, batch(row("a", state = "DENIED", decidedAt = at(5))).verdict)
        val mixed = batch(row("a", state = "DENIED", decidedAt = at(9)), row("b", state = "APPLIED", decidedAt = at(5)))
        assertEquals(CrossingCards.Verdict.MIXED, mixed.verdict); assertEquals(at(9), mixed.decidedAt)
    }

    // MARK: copy per kind

    @Test fun titlesBadgesNounsAndListHeadsPerKind() {
        fun of(kind: String, n: Int, state: String = "PENDING") = CrossingBatch((1..n).map { row("$kind$it", kind = kind, state = state, decidedAt = if (state == "PENDING") null else at(9)) })
        assertEquals("Move these tasks here?", CrossingCards.title(of("MOVE_TASK", 2)))
        assertEquals("Move this task here?", CrossingCards.title(of("MOVE_TASK", 1)))
        assertEquals("File these tasks here?", CrossingCards.title(of("FILE_TASK", 3)))
        assertEquals("File this task here?", CrossingCards.title(of("FILE_TASK", 1)))
        assertEquals("Allow these dependencies?", CrossingCards.title(of("DEPEND_ON_TASK", 2)))
        assertEquals("Allow this dependency?", CrossingCards.title(of("DEPEND_ON_TASK", 1)))
        assertEquals(listOf("move", "file", "depend"), listOf("MOVE_TASK", "FILE_TASK", "DEPEND_ON_TASK").map { CrossingCards.badge(of(it, 1)) })
        assertEquals(listOf("moved", "approved", "approved"), listOf("MOVE_TASK", "FILE_TASK", "DEPEND_ON_TASK").map { CrossingCards.badge(of(it, 1, "APPLIED")) })
        assertEquals(listOf("refused", "refused", "refused"), listOf("MOVE_TASK", "FILE_TASK", "DEPEND_ON_TASK").map { CrossingCards.badge(of(it, 1, "DENIED")) })
        assertEquals("answered", CrossingCards.badge(batch(row("a", state = "DENIED", decidedAt = at(1)), row("b", state = "APPLIED", decidedAt = at(2)))))
        assertEquals(listOf("task", "tasks", "dependency", "dependencies"),
            listOf(of("FILE_TASK", 1), of("MOVE_TASK", 2), of("DEPEND_ON_TASK", 1), of("DEPEND_ON_TASK", 2)).map(CrossingCards::noun))
        assertEquals(listOf("Tasks to move", "Tasks to file", "Tasks waited on"),
            listOf("MOVE_TASK", "FILE_TASK", "DEPEND_ON_TASK").map { CrossingCards.listHead(of(it, 1)) })
        assertEquals("move · 2 waiting", CrossingCards.waitingLine(of("MOVE_TASK", 2)))
        assertEquals("View details & act", CrossingCards.link(of("MOVE_TASK", 1)))
        assertEquals("View details", CrossingCards.link(of("MOVE_TASK", 1, "DENIED")))
    }

    @Test fun theSummaryNamesTheSourceAndTheCriteriaRange() {
        val eight = CrossingBatch((4..11).reversed().map { row("m$it", criterion = "$it") })
        assertEquals("8 tasks from Runner v1 · for criteria 4–11", CrossingCards.summary(eight))
        assertEquals("for criteria 4, 6, 9", CrossingCards.criteria(batch(row("a", criterion = "9"), row("b", criterion = "4"), row("c", criterion = "6"), row("d", criterion = "6"))))
        assertEquals("for criteria alpha, beta", CrossingCards.criteria(batch(row("a", criterion = "beta"), row("b", criterion = "alpha"))))
        assertEquals("1 dependency from Runner v1 · for criterion 4", CrossingCards.summary(batch(row("a", kind = "DEPEND_ON_TASK", criterion = "4"))))
        assertEquals("2 tasks from unnamed project", CrossingCards.summary(batch(row("a", kind = "FILE_TASK", fromTitle = null), row("b", kind = "FILE_TASK"))))
    }

    @Test fun theReviewRowsReasonsAndConsequence() {
        val move = row("a", criterion = "4", criterionText = null, withdrawn = "2", reason = " serves 4 here ")
        assertEquals("Subject a", CrossingCards.subject(move))
        assertEquals("Title f", CrossingCards.subject(row("f", kind = "FILE_TASK")))
        assertEquals(listOf("Target criterion requested: 4 — The target project no longer states this criterion.", "Source criterion it serves now: 2"),
            CrossingCards.rowNotes(move))
        assertEquals(listOf("Target criterion requested: 5", "Refused"), CrossingCards.rowNotes(row("b", criterion = "5", state = "DENIED")))
        assertEquals(listOf("“serves 4 here”", "“other”"), CrossingCards.reasons(batch(move, row("b", reason = "serves 4 here"), row("c", reason = "other"), row("d", reason = ""))))
        assertEquals(CrossingCards.batchMoveConsequence, CrossingCards.consequence(batch(row("a"), row("b"))))
        assertEquals(ProjectCrossings.moveApproveConsequence, CrossingCards.consequence(batch(row("a"))))
        assertEquals(ProjectCrossings.fileApproveConsequence, CrossingCards.consequence(batch(row("a", kind = "DEPEND_ON_TASK"), row("b", kind = "DEPEND_ON_TASK"))))
        assertEquals("Show 5 more", CrossingCards.showMore(CrossingBatch((1..8).map { row("$it") })))
        assertNull(CrossingCards.showMore(CrossingBatch((1..3).map { row("$it") })))
        assertEquals("1 answer was not recorded", CrossingCards.notRecorded(1))
        assertEquals("3 answers were not recorded", CrossingCards.notRecorded(3))
        assertEquals("That answer was not recorded MOVE_TASK_LANDING_IN_FLIGHT",
            CrossingCards.refusalHead(ProjectCrossings.Refusal("MOVE_TASK_LANDING_IN_FLIGHT", "being landed")))
        assertEquals("That answer was not recorded", CrossingCards.refusalHead(ProjectCrossings.Refusal(null, "x")))
    }

    // MARK: the presses

    @Test fun approveAndRefuseSendOneBodyPerWaitingRowWithItsOwnKey() {
        val b = batch(row("a"), row("b", state = "APPROVED", decidedAt = at(1)), row("c", publicId = null))
        val approve = CrossingCards.requests(b, approve = true)
        assertEquals(listOf("Pa", "c"), approve.map { it.first })
        assertEquals(listOf("""{"decision":"APPROVE","acknowledgedCrossingKey":"key-a"}""", """{"decision":"APPROVE","acknowledgedCrossingKey":"key-c"}"""),
            approve.map { it.second.toString() })
        assertEquals("""{"decision":"DENY","acknowledgedCrossingKey":"key-a"}""", CrossingCards.requests(b, approve = false).first().second.toString())
    }

    // MARK: receipts

    @Test fun receiptsSayWhoAnsweredAndWhen() {
        // The receipt reads the app's own receipt clock (OwnerReview.receiptTime), which follows the reader's locale.
        fun clock(iso: String) = OwnerReview.receiptTime(iso, now, utc)
        val approved = batch(row("a", state = "APPLIED", decidedAt = "2026-11-10T09:34:00.000Z"), row("b", state = "APPROVED", decidedAt = "2026-11-10T09:30:00.000Z"))
        assertEquals("Decision recorded · ✓ Approved by you at ${clock("2026-11-10T09:34:00.000Z")}", CrossingCards.receipt(approved, CrossingCards.Answerer.HERE, now = now, zone = utc)!!.line)
        assertEquals("Approved at another end", CrossingCards.receipt(approved, CrossingCards.Answerer.ELSEWHERE, now = now, zone = utc)!!.line)
        val refused = batch(row("a", state = "DENIED", decidedAt = "2026-11-09T18:05:00.000Z"))
        assertEquals("Decision recorded · ✓ Refused by you at ${clock("2026-11-09T18:05:00.000Z")}", CrossingCards.receipt(refused, CrossingCards.Answerer.HERE, now = now, zone = utc)!!.line)
        assertEquals("Refused at another end", CrossingCards.receipt(refused, CrossingCards.Answerer.ELSEWHERE, now = now, zone = utc)!!.line)
        val mixed = batch(row("a", state = "DENIED"), row("b", state = "APPLIED"))
        assertEquals("Decision recorded · ✓ Answered by you at ${clock("2026-11-10T11:58:00Z")}",
            CrossingCards.receipt(mixed, CrossingCards.Answerer.HERE, pressedAt = Instant.parse("2026-11-10T11:58:00Z"), now = now, zone = utc)!!.line)
        assertEquals("Answered at another end", CrossingCards.receipt(mixed, CrossingCards.Answerer.ELSEWHERE, now = now, zone = utc)!!.line)
        assertNull(CrossingCards.receipt(batch(row("a")), CrossingCards.Answerer.HERE))
    }

    @Test fun answeredHereElsewhereOrNeverSeen() {
        assertEquals(CrossingCards.Answerer.HERE, CrossingCards.answerer(seenLive = true, pressed = true))
        assertEquals(CrossingCards.Answerer.ELSEWHERE, CrossingCards.answerer(seenLive = true, pressed = false))
        assertEquals(CrossingCards.Answerer.HERE, CrossingCards.answerer(seenLive = false, pressed = false))
    }

    @Test fun cardsArePlacedAfterTheLastRowAtOrBeforeTheirMoment() {
        val times = listOf("2026-11-10T08:59:00Z", null, "2026-11-10T09:01:00Z", "2026-11-10T09:05:00Z")
        val early = batch(row("e", requestedAt = "2026-11-10T08:00:00.000Z"))
        val mid = batch(row("m", requestedAt = "2026-11-10T09:02:00.000Z"))
        val late = batch(row("l", requestedAt = "2026-11-10T10:00:00.000Z"))
        val placed = CrossingCards.place(times, listOf(early, mid, late))
        assertEquals(listOf(early), placed[-1]); assertEquals(listOf(mid), placed[2]); assertEquals(listOf(late), placed[3])
    }

    // MARK: task moves served to a session (waiting-on-you-removal, owner 11-12)

    private fun asked(row: JsonObject, by: String) = JsonObject(row + ("requestedBySession" to buildJsonObject { put("id", by); put("title", "S $by") }) +
        ("toProject" to buildJsonObject { put("title", "Runner hardening") }))
    private fun read(vararg rows: JsonObject, drawnAs: String = "REQUESTER") = buildJsonObject {
        put("batchKey", "k"); put("state", rows.first().text("state")!!); put("since", rows.first().text("requestedAt")!!)
        putJsonArray("drawnAs") { add(drawnAs) }; put("moves", JsonArray(rows.toList()))
    }

    /** One asker's moves are one card: the batch door takes one asker's moves, so two askers out of one project are two answers. */
    @Test fun movesGroupByAskerAsWell() {
        val rows = listOf(asked(row("a", requestedAt = at(1)), "S1"), asked(row("b", requestedAt = at(2)), "S2"), asked(row("c", requestedAt = at(3)), "S1"),
            row("f1", kind = "FILE_TASK", requestedAt = at(4)), row("f2", kind = "FILE_TASK", requestedAt = at(5)))
        assertEquals(listOf(listOf("a", "c"), listOf("b"), listOf("f1", "f2")),
            CrossingCards.batches(rows, here).map { b -> b.rows.map { it.text("id") } })
    }

    /** The session read becomes the same card under the id the project read spells it with, oldest move first; anything that is not a
     * move, or a read with no moves, is no card. */
    @Test fun aSessionReadIsTheSameCard() {
        val batch = CrossingCards.batch(read(asked(row("b", requestedAt = at(2)), "S1"), asked(row("a", requestedAt = at(1)), "S1")))!!
        assertEquals("crossing-batch-Pa", batch.id)
        assertEquals(listOf("a", "b"), batch.rows.map { it.text("id") })
        assertFalse(batch.inTarget)
        assertTrue(CrossingCards.batch(read(row("a"), drawnAs = "TARGET_COORDINATOR"))!!.inTarget)
        assertNull(CrossingCards.batch(read(row("f", kind = "FILE_TASK"))))
        assertNull(CrossingCards.batch(buildJsonObject { put("batchKey", "k"); putJsonArray("moves") {} }))
    }

    /** In the session that asked, the card names where the tasks go; in the target's coordinator it says "here" and "this project". */
    @Test fun theAskingSessionsCardNamesTheTarget() {
        val many = CrossingCards.batch(read(asked(row("a"), "S1"), asked(row("b", requestedAt = at(1)), "S1")))!!
        assertEquals("Move these tasks into Runner hardening?", CrossingCards.title(many))
        assertEquals("Runner hardening", CrossingCards.toText(many))
        val one = CrossingCards.batch(read(asked(row("a"), "S1")))!!
        assertEquals("Move this task into Runner hardening?", CrossingCards.title(one))
        val target = CrossingCards.batch(read(asked(row("a"), "S1"), asked(row("b", requestedAt = at(1)), "S1"), drawnAs = "TARGET_COORDINATOR"))!!
        assertEquals("Move these tasks here?", CrossingCards.title(target))
        assertEquals("this project", CrossingCards.toText(target))
    }

    /** Both reads serving one batch draw one card, the project read's; a session batch the project read does not hold is added. */
    @Test fun mergedDrawsABatchBothReadsServeOnce() {
        val rows = listOf(asked(row("a", requestedAt = at(1)), "S1"), asked(row("b", requestedAt = at(2)), "S1"))
        val project = CrossingCards.batches(rows, here)
        val same = CrossingCards.batch(read(*rows.toTypedArray(), drawnAs = "TARGET_COORDINATOR"))!!
        val other = CrossingCards.batch(read(asked(row("z", requestedAt = at(0), to = "AAAElsewhere"), "S1")))!!
        val merged = CrossingCards.merged(project, listOf(same, other))
        assertEquals(listOf("crossing-batch-Pz", "crossing-batch-Pa"), merged.map { it.id })
        assertTrue(merged.last().inTarget)
        // The same waiting rows under a later first row (the project read grouped them from an earlier one) are not drawn twice.
        val tail = CrossingCards.batch(read(rows[1], drawnAs = "TARGET_COORDINATOR"))!!
        assertEquals(1, CrossingCards.merged(project, listOf(tail)).size)
    }

    /** A move batch's answer is ONE body: the decision and every waiting move with the crossing key the card read. */
    @Test fun aMoveBatchIsAnsweredWithOneBody() {
        val b = batch(row("a"), row("b", state = "APPLIED", decidedAt = at(3)), row("c"))
        assertEquals("""{"decision":"APPROVE","moves":[{"handoffId":"Pa","crossingKey":"key-a"},{"handoffId":"Pc","crossingKey":"key-c"}]}""",
            CrossingCards.moveRequest(b, approve = true).toString())
        assertEquals("DENY", CrossingCards.moveRequest(b, approve = false)["decision"]!!.jsonPrimitive.content)
    }
}
