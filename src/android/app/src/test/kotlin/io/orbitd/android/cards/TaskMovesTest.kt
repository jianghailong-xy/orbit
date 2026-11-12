package io.orbitd.android.cards

import io.orbitd.android.core.cards.text
import io.orbitd.android.projects.ProjectCrossings
import java.time.Instant
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/** What the move card is drawn from, without a screen: the read, where a batch goes in the conversation, its words in either session
 * it is drawn in, the batch answer's body and the resolved line. */
class TaskMovesTest {
    private fun batch(count: Int = 8, drawnAs: List<String> = listOf("TARGET_COORDINATOR"), state: String = "PENDING") = buildJsonObject {
        val moves = (1..count).map { TaskMoveFixture.move(it).let { row -> if (state == "PENDING") row else TaskMoveFixture.answered(row, state, "2026-11-11T10:00:00Z") } }
        put("batchKey", "k$count$state"); put("state", state); put("since", moves.first().text("requestedAt")!!)
        if (state != "PENDING") put("decidedAt", "2026-11-11T10:00:00Z")
        putJsonArray("drawnAs") { drawnAs.forEach { add(it) } }
        put("moves", JsonArray(moves))
    }

    @Test fun aReadIsBatchesWithMovesTheCrossingRowCanDraw() {
        assertEquals(1, TaskMoves.batches(JsonArray(listOf(batch())))?.size)
        assertEquals(0, TaskMoves.batches(JsonArray(emptyList()))?.size)
        assertNull(TaskMoves.batches(JsonObject(emptyMap())))
        // A move without a crossing key cannot be answered, so the read is not one.
        val keyless = JsonObject(batch() + ("moves" to JsonArray(listOf(JsonObject(TaskMoveFixture.move(1) - "crossingKey")))))
        assertNull(TaskMoves.batches(JsonArray(listOf(keyless))))
    }

    /** By the owner requests' rule: after the last row stamped at or before the first move was asked, or ahead of every row. */
    @Test fun aBatchGoesWhereItWasAsked() {
        val asked = batch() // since 2026-11-09T00:31:01Z
        val rows = listOf("2026-11-09T00:30:00Z", "2026-11-09T00:31:01Z", "2026-11-09T00:40:00Z", null)
        assertEquals(mapOf(1 to listOf(asked)), TaskMoves.place(rows, listOf(asked)))
        assertEquals(mapOf(-1 to listOf(asked)), TaskMoves.place(listOf("2026-11-10T00:00:00Z"), listOf(asked)))
        assertEquals(mapOf(0 to listOf(asked)), TaskMoves.place(listOf("2026-11-09T00:00:00Z", null), listOf(asked)))
        // A batch with no readable moment is left out, never drawn at the end by accident.
        assertTrue(TaskMoves.place(rows, listOf(JsonObject(asked - "since"))).isEmpty())
    }

    @Test fun theWordsInTheTargetCoordinatorAndInTheSessionThatAsked() {
        val now = Instant.parse("2026-11-11T10:00:00Z")
        val target = batch()
        assertEquals("Move 8 tasks into this project", TaskMoves.title(target))
        assertEquals("Runner link v1: runner ↔ control plane over WebSocket", TaskMoves.fromTitle(target))
        assertEquals("Done", TaskMoves.fromStatus(target))
        assertTrue(TaskMoves.askedLine(target, now).startsWith("Asked by Runner link v1 coordinator · "))
        val asker = batch(1, listOf("REQUESTER"))
        assertEquals("Move 1 task into Runner link hardening", TaskMoves.title(asker))
        assertTrue(TaskMoves.askedLine(asker, now).startsWith("Asked here · "))
        // Both at once (a coordinator moving work into its own project) reads as the target.
        assertEquals("Move 8 tasks into this project", TaskMoves.title(batch(drawnAs = listOf("REQUESTER", "TARGET_COORDINATOR"))))
        assertEquals("Approve 8 moves…", TaskMoves.approveAsk(8))
        assertEquals("Approve move…", TaskMoves.approveAsk(1))
        assertEquals(ProjectCrossings.refuseAsk, TaskMoves.refuseAsk)
        assertEquals("Approve 8 task moves?", TaskMoves.question(8, true))
        assertEquals("Refuse task move?", TaskMoves.question(1, false))
        assertEquals("Approve 8 moves", TaskMoves.confirmLabel(8, true))
        assertEquals(ProjectCrossings.moveApproveConsequence, TaskMoves.consequence(true))
        assertEquals(ProjectCrossings.moveDenyConsequence, TaskMoves.consequence(false))
        // A move that names no criterion says only what it is; one whose criterion is gone says so.
        val bare = JsonObject(TaskMoveFixture.move(1) + ("requestedCriterion" to JsonNull))
        assertEquals("Task to move", TaskMoves.moveLine(bare))
        val gone = JsonObject(TaskMoveFixture.move(1) + ("requestedCriterion" to buildJsonObject { put("key", "k"); put("text", JsonNull) }))
        assertEquals("Task to move · Target criterion requested: ${ProjectCrossings.moveCriterionGone}", TaskMoves.moveLine(gone))
    }

    /** Every move of the batch, by the id its door takes, with the crossing key the card read: the fence the server checks. */
    @Test fun theBatchAnswerSendsEveryMoveWithItsKey() {
        val moves = TaskMoves.moves(batch(3))
        val body = TaskMoves.request(moves, approve = false)
        assertEquals("DENY", body["decision"]!!.jsonPrimitive.content)
        assertEquals(moves.map { mapOf("handoffId" to it.text("id"), "crossingKey" to it.text("crossingKey")) },
            body["moves"]!!.jsonArray.map { m -> m.jsonObject.mapValues { it.value.jsonPrimitive.content } })
        assertEquals("APPROVE", TaskMoves.request(moves, approve = true)["decision"]!!.jsonPrimitive.content)
    }

    @Test fun anAnsweredBatchIsOneLine() {
        assertFalse(TaskMoves.pending(batch(state = "APPLIED")))
        assertEquals("Moved 8 tasks into this project", TaskMoves.resolvedLine(batch(state = "APPLIED")))
        assertEquals("Moved 1 task into Runner link hardening", TaskMoves.resolvedLine(batch(1, listOf("REQUESTER"), "APPLIED")))
        assertEquals("Refused 8 task moves into this project", TaskMoves.resolvedLine(batch(state = "DENIED")))
        assertEquals("Refused a task move into this project", TaskMoves.resolvedLine(batch(1, state = "DENIED")))
        assertEquals("8 task moves into this project: ${ProjectCrossings.label("EXPIRED")}", TaskMoves.resolvedLine(batch(state = "EXPIRED")))
    }
}
