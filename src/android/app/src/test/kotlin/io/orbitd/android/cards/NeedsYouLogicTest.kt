package io.orbitd.android.cards

import io.orbitd.android.core.cards.*
import io.orbitd.android.core.protocol.Wire
import io.orbitd.android.core.realtime.SessionSnapshot
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
import java.io.File

/**
 * The needs-you bar (iOS `NeedsYouBannerView`, OrbitKit `NeedsYouLogic`): case for case with OrbitKit's NeedsYouLogicTests
 * for the cross-session line and the in-conversation line, and the shared card corpus for which of this conversation's
 * cards it counts.
 */
class NeedsYouLogicTest {
    private fun session(id: String, approvals: Int = 0, agentId: String? = null, agentName: String? = null,
        title: String? = null, lastTurnAt: String? = null) = buildJsonObject {
        put("id", id); put("status", "RUNNING"); put("pendingApprovals", approvals)
        agentId?.let { put("agentId", it) }; title?.let { put("title", it) }; lastTurnAt?.let { put("lastTurnAt", it) }
        agentName?.let { name -> putJsonObject("agent") { put("id", agentId ?: "a"); put("name", name) } }
    }

    // banner

    @Test fun bannerIsNullWhenNothingIsWaiting() = assertNull(NeedsYouLogic.banner(emptyList()))

    /** The session on screen shows its own approval card inline, so the bar must not point at it. */
    @Test fun bannerExcludesTheFocusedSession() =
        assertNull(NeedsYouLogic.banner(listOf(session("focused", 1, "dev", "wikova-develop")), "focused"))

    /** The same session under its other spelling (UUID vs base62) is still the one on screen. */
    @Test fun theFocusedSessionIsMatchedUnderEitherIdSpelling() {
        val row = session("01a0cca7-8609-70ed-a0e2-d4b55b832b61", 1, "dev", "wikova-develop")
        assertNull(NeedsYouLogic.banner(listOf(row), "01A0CCA7-8609-70ED-A0E2-D4B55B832B61"))
    }

    @Test fun singleWaitingSessionNamesItsWorkspace() {
        val banner = NeedsYouLogic.banner(listOf(session("s1", 1, "dev", "wikova-develop")))
        assertEquals(1, banner?.count)
        assertEquals("wikova-develop needs you", banner?.text)
        assertEquals("s1", banner?.target?.text("id"))
    }

    @Test fun severalWaitingSessionsCollapseToACount() {
        val waiting = listOf(session("s1", 1, "dev", "wikova-develop"), session("s2", 1, "prod", "wikova-prod"))
        assertEquals("2 sessions need you", NeedsYouLogic.banner(waiting)?.text)
    }

    /** Excluding the focused session drops the count too. */
    @Test fun countAndCopyBothDropTheFocusedSession() {
        val waiting = listOf(session("focused", 1, "dev", "wikova-develop"), session("other", 1, "prod", "wikova-prod"))
        val banner = NeedsYouLogic.banner(waiting, "focused")
        assertEquals(1, banner?.count)
        assertEquals("wikova-prod needs you", banner?.text)
        assertEquals("other", banner?.target?.text("id"))
    }

    /** A tap opens the one that has waited longest, whatever order the snapshot arrives in. */
    @Test fun targetIsTheLongestWaitingSessionRegardlessOfInputOrder() {
        val newest = session("newest", 1, "a", "A", lastTurnAt = "2026-08-14T10:00:00.000Z")
        val oldest = session("oldest", 1, "b", "B", lastTurnAt = "2026-08-14T08:00:00.000Z")
        val middle = session("middle", 1, "c", "C", lastTurnAt = "2026-08-14T09:00:00.000Z")
        assertEquals("oldest", NeedsYouLogic.banner(listOf(newest, oldest, middle))?.target?.text("id"))
        assertEquals("oldest", NeedsYouLogic.banner(listOf(oldest, middle, newest))?.target?.text("id"))
    }

    @Test fun singleSessionFallsBackToTitleThenAGenericNoun() {
        assertEquals("Backfill worktree fences needs you",
            NeedsYouLogic.banner(listOf(session("s1", 1, "dev", title = "Backfill worktree fences")))?.text)
        assertEquals("A session needs you", NeedsYouLogic.banner(listOf(session("s2", 1, "dev")))?.text)
    }

    /** A project ready to start is not one of the sessions that need you (`SessionGrouping.countsOnlyAStart`). */
    @Test fun aRowCountingOnlyAStartDoesNotNeedYou() {
        val start = JsonObject(session("c1", 1, "orbit", "orbit") + ("waitingKind" to JsonPrimitive("START_REQUEST")))
        assertFalse(NeedsYouLogic.needsYou(start))
        assertNull(NeedsYouLogic.banner(listOf(start)))
        assertFalse(NeedsYouLogic.needsYou(session("idle", 0)))
    }

    // the conversation on screen

    private fun question(id: String) = BelowRow(id, true)
    private fun exception(id: String) = BelowRow(id, false)

    @Test fun oneQuestionInThisConversationNamesItAndPointsAtIt() {
        val below = NeedsYouLogic.below(listOf(question("criteria:in-1")), ReaderSide.BELOW)
        assertEquals(1, below?.count)
        assertEquals("1 open question below", below?.text)
        assertEquals("criteria:in-1", below?.rowId)
    }

    @Test fun severalQuestionsCountAndTheTapGoesToTheFirst() {
        val below = NeedsYouLogic.below(listOf(question("criteria:in-1"), question("acceptance")), ReaderSide.BELOW)
        assertEquals("2 open questions below", below?.text)
        assertEquals("criteria:in-1", below?.rowId)
    }

    @Test fun aCardAboveTheReaderSaysSo() {
        val above = NeedsYouLogic.below(listOf(exception("item:x1")), ReaderSide.ABOVE)
        assertEquals("1 waiting above", above?.text)
        assertEquals(ReaderSide.ABOVE, above?.side)
        assertEquals("1 open question above", NeedsYouLogic.below(listOf(question("criteria:in-1")), ReaderSide.ABOVE)?.text)
    }

    /** Nothing has reported where the reader is: the count, and no direction it cannot know. */
    @Test fun withNoReaderPlaceReportedTheBarDoesNotGuess() {
        val unknown = NeedsYouLogic.below(listOf(exception("item:x1")), null)
        assertEquals("1 waiting", unknown?.text)
        assertNull(unknown?.side)
        assertEquals("2 open questions", NeedsYouLogic.below(listOf(question("a"), question("b")), null)?.text)
    }

    /** An exception the owner has to press is counted like a question but not called one. */
    @Test fun anExceptionBelowIsCountedButNotCalledAQuestion() {
        val alone = NeedsYouLogic.below(listOf(exception("item:x1")), ReaderSide.BELOW)
        assertEquals(1, alone?.count)
        assertEquals("1 waiting below", alone?.text)
        val mixed = NeedsYouLogic.below(listOf(exception("item:x1"), question("criteria:in-1")), ReaderSide.BELOW)
        assertEquals(2, mixed?.count)
        assertEquals("2 waiting below", mixed?.text)
        assertEquals("the destination is still the first thing waiting, whatever it is", "item:x1", mixed?.rowId)
    }

    @Test fun nothingBelowIsNoBar() = assertNull(NeedsYouLogic.below(emptyList(), null))

    // the four owner items (contract §7.6 V13)

    private fun coordinator(id: String, project: String?, items: List<JsonObject>, approvals: Int? = null) = buildJsonObject {
        put("id", id); put("title", "Project coordinator"); put("status", "AWAITING_INPUT"); put("agentId", "orbit")
        put("pendingApprovals", approvals ?: items.size); put("ownerItems", JsonArray(items))
        put("projectId", "p-$id"); project?.let { put("projectTitle", it) }
        putJsonObject("agent") { put("id", "orbit"); put("name", "orbit") }
        put("lastTurnAt", "2026-09-13T09:00:00Z")
    }
    private fun ownerItem(kind: String, since: String, id: String = "item-1", title: String = "Waiting") = buildJsonObject {
        put("itemId", id); put("kind", kind); put("title", title); put("since", since)
    }

    @Test fun ownerItemsCountTowardNeedsYou() {
        listOf("PROMOTION_APPROVAL" to "Approve merge to main · Integration line",
            "COORDINATOR_QUESTION" to "Question from coordinator · Integration line",
            "ESCALATED" to "Escalated to you · Integration line",
            "FUSE_PAUSED" to "Paused · Integration line").forEach { (kind, text) ->
            val session = coordinator("c1", "Integration line", listOf(ownerItem(kind, "2026-09-13T10:00:00Z")))
            assertTrue(kind, NeedsYouLogic.needsYou(session))
            val banner = NeedsYouLogic.banner(listOf(session))
            assertEquals(kind, text, banner?.text)
            assertEquals("and a tap lands in the coordinator conversation", "c1", banner?.target?.text("id"))
            assertEquals("on the card the item is", "item-1", banner?.ownerItem?.itemId)
        }
        assertEquals("promotion:", NeedsYouLogic.cardKey(OwnerItem("i", "PROMOTION_APPROVAL", "", "")))
        assertEquals("item:i", NeedsYouLogic.cardKey(OwnerItem("i", "ESCALATED", "", "")))
    }

    @Test fun coordinatorItemsDoNotCount() {
        val handling = coordinator("c1", "Integration line", emptyList(), approvals = 0)
        assertFalse(NeedsYouLogic.needsYou(handling))
        assertNull(NeedsYouLogic.banner(listOf(handling)))
        assertTrue(NeedsYouLogic.needsYou(coordinator("c1", "Integration line", listOf(ownerItem("ESCALATED", "2026-09-13T10:00:00Z")))))
    }

    @Test fun theOldestOwnerItemIsTheOneNamed() {
        val newer = coordinator("c1", "Newer project", listOf(ownerItem("COORDINATOR_QUESTION", "2026-09-13T12:00:00Z", "new")))
        val older = coordinator("c2", "Older project", listOf(ownerItem("PROMOTION_APPROVAL", "2026-09-13T08:00:00Z", "old")))
        val banner = NeedsYouLogic.banner(listOf(newer, older))
        assertEquals("old", banner?.ownerItem?.itemId)
        assertEquals("c2", banner?.target?.text("id"))
        assertEquals("Approve merge to main · Older project", banner?.text)
        assertEquals(2, banner?.count)
    }

    @Test fun anOwnerItemOutranksABlockedToolCall() {
        val blocked = session("s1", 1, "dev", "wikova-develop")
        val waiting = coordinator("c1", "Integration line", listOf(ownerItem("FUSE_PAUSED", "2026-09-13T10:00:00Z")))
        val banner = NeedsYouLogic.banner(listOf(blocked, waiting))
        assertEquals("Paused · Integration line", banner?.text)
        assertEquals("c1", banner?.target?.text("id"))
    }

    @Test fun anUnknownKindDoesNotNameTheBar() {
        val unknown = coordinator("c1", "Integration line", listOf(ownerItem("WHAT_IS_THIS", "2026-09-13T10:00:00Z")))
        val banner = NeedsYouLogic.banner(listOf(unknown))
        assertEquals("orbit needs you", banner?.text)
        assertNull(banner?.ownerItem)
    }

    /** The row as the server sends it, an unknown kind beside a known one. */
    @Test fun ownerItemsDecodeFromASessionRow() {
        val row = Wire.json.parseToJsonElement("""
            {"id":"c1","status":"RUNNING","pendingApprovals":2,"projectTitle":"Integration line",
             "ownerItems":[{"itemId":"i1","kind":"PROMOTION_APPROVAL","title":"Merge 3 tasks into main?","since":"2026-09-13T10:00:00Z"},
                           {"itemId":"i2","kind":"WHAT_IS_THIS","title":"From a later server","since":"2026-09-13T11:00:00Z"}]}
        """).jsonObject
        assertEquals(2, NeedsYouLogic.ownerItems(row).size)
        assertEquals("Merge 3 tasks into main?", NeedsYouLogic.ownerItems(row).first().title)
        assertEquals("Approve merge to main · Integration line", NeedsYouLogic.banner(listOf(row))?.text)
    }

    // which of this conversation's cards the bar counts (the shared card corpus)

    private val corpus: JsonObject by lazy {
        val file = generateSequence(File(System.getProperty("user.dir")).absoluteFile) { it.parentFile }
            .map { File(it, "src/shared/src/interaction-cards.fixture.json") }.first { it.isFile }
        Wire.json.parseToJsonElement(file.readText()).jsonObject
    }
    private fun snapshot(edit: (MutableMap<String, JsonElement>) -> Unit = {}): SessionSnapshot {
        val raw = corpus.obj("snapshot")!!
        val standing = raw.obj("standing")!!.toMutableMap().also(edit)
        return SessionSnapshot(raw.obj("detail")!!, raw.objects("approvals"), raw.objects("queuedTurns"), raw.objects("background"), standing)
    }
    private fun rows(snapshot: SessionSnapshot) = NeedsYouLogic.belowRows(corpus.text("sessionId")!!, snapshot)

    /** Every open decision the corpus carries is counted, in the rail's order; approvals stop the turn and are not; the
     * exception and the pause are counted but are not questions. */
    @Test fun theCorpusCountsItsOpenDecisionsAndNotItsApprovals() {
        val counted = rows(snapshot())
        val task = corpus.text("taskId")!!
        val promotion = corpus.obj("snapshot")!!.obj("standing")!!.obj("promotion")!!.text("promotionId")
        assertEquals(listOf("evidence:$task:7", "owner:$task:owner1", "criteria:intent1"), counted.take(3).map { it.rowId })
        assertTrue(counted.single { it.rowId.startsWith("acceptance:") }.isQuestion)
        assertEquals(listOf("item:q1" to true, "item:x1" to false, "item:f1" to false, "promotion:$promotion" to true),
            counted.drop(4).map { it.rowId to it.isQuestion })
        assertTrue(counted.none { it.rowId.startsWith("approval:") })
        assertEquals("8 waiting below", NeedsYouLogic.below(counted, ReaderSide.BELOW)?.text)
    }

    /** Under review the card can still be pressed, but it is not asking the owner yet (contract §5 N1). */
    @Test fun aConfirmationUnderReviewIsNotCounted() {
        val counted = rows(snapshot { standing ->
            val view = standing["ownerConfirmation"]!!.jsonObject
            val waiting = view.obj("waiting")!!
            val review = JsonObject(waiting.obj("review")!! + ("state" to JsonPrimitive("UNDER_REVIEW")))
            standing["ownerConfirmation"] = JsonObject(view + ("waiting" to JsonObject(waiting + ("review" to review))))
        })
        assertTrue(counted.none { it.rowId.startsWith("owner:") })
    }

    /** A merge counts only while it asks; an item counts only while it is the owner's; a settled card is not counted. */
    @Test fun aMergeUnderWayACoordinatorsItemAndSettledCardsAreNotCounted() {
        val counted = rows(snapshot { standing ->
            standing["promotion"] = JsonObject(standing["promotion"]!!.jsonObject + ("state" to JsonPrimitive("CONFIRMED")))
            val items = standing["openItems"]!!.jsonObject
            standing["openItems"] = JsonObject(items + ("needsYou" to JsonArray(items.objects("needsYou").map {
                if (it.text("itemId") == "x1") JsonObject(it + ("assignee" to JsonPrimitive("COORDINATOR"))) else it })))
            standing["acceptanceConfirmation"] = JsonObject(standing["acceptanceConfirmation"]!!.jsonObject + ("state" to JsonPrimitive("CONFIRMED")))
        })
        assertTrue(counted.none { it.rowId.startsWith("promotion:") })
        assertTrue(counted.none { it.rowId == "item:x1" })
        assertTrue(counted.none { it.rowId.startsWith("acceptance:") })
        assertTrue(counted.any { it.rowId == "item:f1" })
    }

    /** The coordinator's "Is this project done?" counts while it asks, after the rail's cards, and not once recorded. */
    @Test fun theProjectDoneQuestionCountsWhileItAsks() {
        val project = corpus.text("projectId")!!
        val derived = buildJsonObject { putJsonObject("counts") { put("criteria", 1); put("met", 1) } }
        fun asking(status: String) = rows(snapshot { standing ->
            standing["project"] = JsonObject(standing["project"]!!.jsonObject + ("derivedDone" to derived) + ("status" to JsonPrimitive(status)))
            val items = standing["openItems"]!!.jsonObject
            standing["openItems"] = JsonObject(items + ("doneRequest" to buildJsonObject {
                put("itemId", "d1"); putJsonObject("doneRequest") { put("requestId", "r1"); putJsonArray("gaps") {} }
            }))
        })
        assertEquals(BelowRow("done:$project", true), asking("OPEN").last())
        assertTrue(asking("DONE").none { it.rowId.startsWith("done:") })
    }
}
