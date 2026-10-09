package io.orbitd.android.projects

import io.orbitd.android.core.cards.*
import io.orbitd.android.core.net.ApiError
import io.orbitd.android.tasks.TaskDetailCopy
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/** The project page's crossings, as `GET /projects/:id/handoffs` serves them and as the section reads them — OrbitKit's
 * `ProjectCrossingsTests` (iOS 4dddff557) over the same rows: what is read, which rows can still be answered, their order, and
 * what the second press says it is agreeing to. */
class ProjectCrossingsTest {
    private val key = "c".repeat(64)
    private fun j(text: String) = Json.parseToJsonElement(text)

    /** Three rows the way the production server writes them: every id twinned with its Base62 spelling, the two ends joined by title,
     * and the bookkeeping columns the section does not read. */
    private val list = """
    [
      {"id":"34bMoveRow","publicId":"34bMoveRow","ownerId":"34aOwner","ownerPublicId":"34aOwner",
       "fromProjectId":"34bFrom","fromProjectPublicId":"34bFrom","toProjectId":"34bTo","toProjectPublicId":"34bTo",
       "kind":"MOVE_TASK","subjectTaskId":"34bMovedTask","subjectTaskPublicId":"34bMovedTask",
       "payloadDigest":"${"d".repeat(64)}","crossingKey":"$key",
       "state":"PENDING","title":"Watchdog (as first asked)","reason":"the watchdog belongs to the runner goal",
       "requestedBySessionId":"34bAsker","requestedBySessionPublicId":"34bAsker",
       "requestedAt":"2026-10-06T09:00:00.000Z","decidedBy":null,"decidedByUserId":null,"decidedAt":null,
       "expiresAt":null,"appliedTaskId":null,"appliedAt":null,
       "requestedCriterionDefinitionId":"34bTargetCriterion","requestedCriterionDefinitionPublicId":"34bTargetCriterion",
       "fromProject":{"title":"Coordinator control loop","status":"DONE"},
       "toProject":{"title":"Runner hardening","status":"OPEN"},
       "subjectTask":{"id":"34bMovedTask","publicId":"34bMovedTask","title":"Wire the drain watchdog"},
       "requestedBySession":{"id":"34bAsker","publicId":"34bAsker","title":"Coordinate runner hardening"},
       "requestedCriterion":{"key":"34bTargetCriterion","text":"A wedged drain restarts within a minute."},
       "withdrawnCriterion":{"key":"34bSourceCriterion","text":"The control loop never drops a turn."}},
      {"id":"34bFileRow","publicId":"34bFileRow","fromProjectId":"34bTo","fromProjectPublicId":"34bTo",
       "toProjectId":"34bOther","toProjectPublicId":"34bOther","kind":"FILE_TASK","subjectTaskId":null,
       "crossingKey":"${"e".repeat(64)}","state":"APPLIED","title":"Fix the drain race",
       "reason":null,"requestedAt":"2026-10-05T09:00:00.000Z","decidedAt":"2026-10-05T10:00:00.000Z",
       "expiresAt":"2026-10-06T10:00:00.000Z","fromProject":{"title":"Runner hardening","status":"OPEN"},
       "toProject":{"title":"Release train","status":"OPEN"},"subjectTask":null,"requestedBySession":null,
       "requestedCriterion":null,"withdrawnCriterion":null},
      {"id":"0195c0de-0000-7000-8000-0000000000f3","fromProjectId":"0195c0de-0000-7000-8000-000000000001",
       "toProjectId":"0195c0de-0000-7000-8000-000000000002","kind":"DEPEND_ON_TASK",
       "subjectTaskId":"0195c0de-0000-7000-8000-0000000000a1","crossingKey":"${"f".repeat(64)}",
       "state":"DENIED","title":"Wait on the schema change","reason":null,
       "requestedAt":"2026-10-04T09:00:00.000Z","decidedAt":"2026-10-04T09:30:00.000Z","expiresAt":null}
    ]
    """
    private fun decoded() = ProjectCrossings.rows(j(list))!!

    private fun move(state: String = "PENDING", ends: Boolean = true, subject: Boolean = true, requestedAt: String = "2026-08-22T00:00:00.000Z") = buildJsonObject {
        put("id", "0195c0de-0000-7000-8000-0000000000f1"); put("publicId", "AAACrossing")
        put("fromProjectId", "0195c0de-0000-7000-8000-000000000001"); put("fromProjectPublicId", "AAAFrom")
        put("toProjectId", "0195c0de-0000-7000-8000-000000000002"); put("toProjectPublicId", "AAATo")
        if (ends) { put("fromProject", buildJsonObject { put("title", "Coordinator control loop"); put("status", "OPEN") })
            put("toProject", buildJsonObject { put("title", "Runner hardening"); put("status", "OPEN") }) }
        put("kind", "MOVE_TASK"); put("subjectTaskId", "AAAMovedTask"); put("subjectTaskPublicId", "AAAMovedTask")
        if (subject) put("subjectTask", buildJsonObject { put("id", "AAAMovedTask"); put("title", "Wire the drain watchdog") })
        put("crossingKey", key); put("state", state); put("title", "Watchdog (as first asked)"); put("requestedAt", requestedAt)
    }
    private fun filing(kind: String = "FILE_TASK", state: String = "PENDING", requestedAt: String = "2026-08-22T00:00:00.000Z", id: String = "AAAFiling") = buildJsonObject {
        put("id", id); put("fromProjectId", "AAAFrom"); put("toProjectId", "AAATo")
        put("fromProject", buildJsonObject { put("title", "Coordinator control loop"); put("status", "OPEN") })
        put("toProject", buildJsonObject { put("title", "Runner hardening"); put("status", "OPEN") })
        put("kind", kind); put("crossingKey", key); put("state", state); put("title", "Fix the drain race"); put("requestedAt", requestedAt)
    }

    // MARK: reading

    @Test fun aMoveIsReadWithItsTaskItsEndsAndTheTwoCriteriaItChanges() {
        val row = decoded().first()
        assertTrue(ProjectCrossings.isMove(row)); assertEquals("PENDING", row.text("state")); assertEquals(key, row.text("crossingKey"))
        assertEquals("34bFrom", ProjectCrossings.fromId(row)); assertEquals("34bTo", ProjectCrossings.toId(row))
        assertEquals("Wire the drain watchdog", ProjectCrossings.subjectTitle(row)); assertEquals("34bMovedTask", ProjectCrossings.subjectId(row))
        assertEquals("A wedged drain restarts within a minute.", row.obj("requestedCriterion")?.text("text"))
        assertEquals("34bSourceCriterion", row.obj("withdrawnCriterion")?.text("key"))
        assertEquals("the watchdog belongs to the runner goal", row.text("reason"))
    }

    /** A row from a server older than the move request — no joined titles, no subject read, no criteria — is a row with less on it. */
    @Test fun anOlderServersRowIsReadWithLessOnIt() {
        val rows = decoded()
        assertEquals(3, rows.size)
        assertFalse(ProjectCrossings.isMove(rows[1])); assertEquals("APPLIED", rows[1].text("state"))
        val older = rows[2]
        assertEquals("DEPEND_ON_TASK", older.text("kind")); assertNull(older.obj("fromProject"))
        assertEquals("0195c0de-0000-7000-8000-000000000001", ProjectCrossings.fromId(older))
        assertEquals("a row with no twin is answered at its own id", "0195c0de-0000-7000-8000-0000000000f3", ProjectCrossings.doorId(older))
    }

    /** What a row cannot be answered without is required: a list with a row short of its key is no list. */
    @Test fun aListWithARowShortOfItsKeyIsNotRead() {
        assertNull(ProjectCrossings.rows(j("""[{"id":"r","fromProjectId":"a","toProjectId":"b","kind":"MOVE_TASK","state":"PENDING","title":"t"}]""")))
        assertNull(ProjectCrossings.rows(j("""{"rows":[]}""")))
        assertNull(ProjectCrossings.rows(j("[1]")))
        assertEquals(emptyList<JsonObject>(), ProjectCrossings.rows(j("[]")))
        // A deleted target criterion keeps its key and loses its words.
        val gone = ProjectCrossings.rows(j("""[{"id":"r","fromProjectId":"a","toProjectId":"b","kind":"MOVE_TASK","crossingKey":"k","state":"PENDING",
            "title":"t","requestedAt":"2026-10-06T00:00:00.000Z","requestedCriterion":{"key":"34bGone","text":null}}]"""))!!.single()
        assertNull(gone.obj("requestedCriterion")?.text("text")); assertEquals("34bGone", gone.obj("requestedCriterion")?.text("key"))
    }

    // MARK: which rows can be answered

    @Test fun onlyAPendingCrossingCanBeAnswered() {
        assertTrue(ProjectCrossings.isAnswerable("PENDING"))
        listOf("APPROVED", "DENIED", "APPLIED", "EXPIRED", "", null).forEach { assertFalse("$it is not a question any more", ProjectCrossings.isAnswerable(it)) }
        assertEquals(listOf(true, false, false), decoded().map { ProjectCrossings.isAnswerable(it.text("state")) })
        assertEquals(1, ProjectCrossings.waitingCount(decoded())); assertEquals("1 waiting", ProjectCrossings.waiting(1))
    }

    /** The questions first, the one that has waited longest leading; then history, newest first. */
    @Test fun questionsLeadOldestFirstAndHistoryFollowsNewestFirst() {
        val rows = listOf(filing(state = "APPLIED", requestedAt = "2026-10-01T00:00:00.000Z", id = "old-answer"),
            filing(state = "PENDING", requestedAt = "2026-10-05T00:00:00.000Z", id = "new-question"),
            filing(state = "DENIED", requestedAt = "2026-10-03T00:00:00.000Z", id = "new-answer"),
            filing(state = "PENDING", requestedAt = "2026-10-02T00:00:00.000Z", id = "old-question"))
        assertEquals(listOf("old-question", "new-question", "new-answer", "old-answer"), ProjectCrossings.ordered(rows).map { it.text("id") })
    }

    // MARK: what each state means

    @Test fun aStateIsCalledByItsWordAndAnUnknownOneByItsCode() {
        assertEquals("Waiting for your answer", ProjectCrossings.label("PENDING")); assertEquals("Approved, not yet applied", ProjectCrossings.label("APPROVED"))
        assertEquals("Refused", ProjectCrossings.label("DENIED")); assertEquals("Applied", ProjectCrossings.label("APPLIED"))
        assertEquals("SOMETHING_NEW", ProjectCrossings.label("SOMETHING_NEW"))
    }

    /** A move is already filed, so the filing's "not filed anywhere until you answer" would be false of it. */
    @Test fun aMoveSaysWhatEachStateMeansForAMoveAndAFilingKeepsItsOwnWords() {
        for (state in listOf("PENDING", "APPROVED", "DENIED", "APPLIED")) {
            val meaning = ProjectCrossings.meaning(move(state))
            assertEquals(TaskDetailCopy.moveTaskStateMeaning[state], meaning); assertNotEquals(TaskDetailCopy.crossingStateMeaning[state], meaning)
            assertEquals(TaskDetailCopy.crossingStateMeaning[state], ProjectCrossings.meaning(filing(state = state)))
            assertEquals(TaskDetailCopy.crossingStateMeaning[state], ProjectCrossings.meaning(filing("DEPEND_ON_TASK", state)))
        }
        assertEquals("the task stays in its project until you answer, and confirming moves it", ProjectCrossings.meaning(move()))
        assertEquals("the task was moved when this request was confirmed", ProjectCrossings.meaning(move("APPLIED")))
    }

    // MARK: the second press

    @Test fun theSecondPressNamesTheMoveAndSaysThatConfirmingIsTheMove() {
        val approve = ProjectCrossings.prompt(move(), approve = true)
        assertEquals(ProjectCrossings.Prompt("Approve", "Coordinator control loop", "Runner hardening", "Wire the drain watchdog", ProjectCrossings.moveApproveConsequence), approve)
        assertEquals("Approve moving “Wire the drain watchdog” from Coordinator control loop to Runner hardening?", ProjectCrossings.question(approve))
        assertEquals("Yes, approve", ProjectCrossings.confirmLabel(approve))
        val deny = ProjectCrossings.prompt(move(), approve = false)
        assertEquals("Refuse", deny.verb); assertEquals(ProjectCrossings.moveDenyConsequence, deny.consequence); assertEquals("Yes, refuse", ProjectCrossings.confirmLabel(deny))
        assertEquals("c".repeat(12), ProjectCrossings.shortKey(key))
    }

    /** The task as it reads now; a subject read that came back empty still names it, and two ends sent with no titles are named by id. */
    @Test fun theSecondPressFallsBackToTheAskedTitleAndToIds() {
        val bare = ProjectCrossings.prompt(move(ends = false, subject = false), approve = true)
        assertEquals("Watchdog (as first asked)", bare.subject); assertEquals("AAAFrom", bare.from); assertEquals("AAATo", bare.to)
        assertEquals("AAAMovedTask", ProjectCrossings.subjectId(move()))
    }

    @Test fun aFilingAndADependencyKeepTheirOwnConsequences() {
        for (kind in listOf("FILE_TASK", "DEPEND_ON_TASK")) {
            assertEquals(ProjectCrossings.Prompt("Approve", "Coordinator control loop", "Runner hardening", "Fix the drain race",
                "The writer may then file this work under the target project. It is not filed by this answer."), ProjectCrossings.prompt(filing(kind), approve = true))
            assertEquals("Refusing is final for this crossing. If you change your mind, file the work yourself.", ProjectCrossings.prompt(filing(kind), approve = false).consequence)
        }
    }

    /** The press's body: the answer, and the key of the crossing it was given on — what the server fences an answer on. */
    @Test fun thePressSendsTheAnswerWithTheCrossingKeyItWasGivenOn() {
        assertEquals(buildJsonObject { put("decision", "APPROVE"); put("acknowledgedCrossingKey", key) }, ProjectCrossings.request(move(), approve = true))
        assertEquals("DENY", ProjectCrossings.request(move(), approve = false).text("decision"))
        assertEquals("the door is addressed by the public id", "AAACrossing", ProjectCrossings.doorId(move()))
    }

    @Test fun aRefusalKeepsTheDoorsCodeAndItsReason() {
        val refusal = ProjectCrossings.refusal(ApiError.parse(409, """{"statusCode":409,"error":"Conflict","code":"MOVE_TASK_LANDING_IN_FLIGHT",
            "message":"task AAAMovedTask is being landed — nothing was written and the request is still waiting."}""".encodeToByteArray()))
        assertEquals("MOVE_TASK_LANDING_IN_FLIGHT", refusal.code)
        assertEquals("task AAAMovedTask is being landed — nothing was written and the request is still waiting.", refusal.message)
        val plain = ProjectCrossings.refusal(ApiError.parse(409, """{"statusCode":409,"message":"handoff approval X is APPLIED and cannot be APPROVED"}""".encodeToByteArray()))
        assertNull(plain.code); assertEquals("handoff approval X is APPLIED and cannot be APPROVED", plain.message)
    }
}
