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

    private fun ask(id: String, state: String) = OwnerRequest(id = id, kind = "DECISION", state = state, title = "t", createdAt = "2026-11-20T10:00:00Z")

    @Test fun `a pending owner request this session filed counts first and is not a question`() {
        val placed = mapOf(3 to listOf(ask("r2", "PENDING")), -1 to listOf(ask("r1", "PENDING"), ask("done", "DONE")))
        val owner = NeedsYouLogic.ownerRequestRows(placed)
        assertEquals(listOf("owner-request:r1", "owner-request:r2"), owner.map { it.rowId })
        assertTrue(owner.none { it.isQuestion })
        val here = NeedsYouLogic.here(owner + BelowRow("q1", true), emptyList(), ReaderSide.ABOVE)!!
        assertEquals(3, here.count)
        assertEquals("owner-request:r1", here.rowId)
        assertEquals("3 waiting above", here.text)
        assertEquals("1 waiting above", NeedsYouLogic.here(owner.take(1), emptyList(), ReaderSide.ABOVE)?.text)
    }

    @Test fun `a request that is not pending, or sits ahead of older unloaded rows, does not count`() {
        assertTrue(NeedsYouLogic.ownerRequestRows(mapOf(0 to listOf(ask("a", "DONE"), ask("b", "DECLINED")))).isEmpty())
        assertTrue(NeedsYouLogic.ownerRequestRows(mapOf(-1 to listOf(ask("c", "PENDING"))), hasOlder = true).isEmpty())
    }

    // the conversation's own capsule (the owner, 2026-11-15, docs/mocks/needs-you-capsule/07-console-one-capsule; OrbitKit's twin)

    /** Its cards first, in their words and direction; its approvals after them, at its tail — so alone they say "below". */
    @Test fun theConversationsOwnCapsuleCountsItsCardsAndItsApprovals() {
        val alone = NeedsYouLogic.here(emptyList(), listOf(BelowRow("approval:a1", false)), null)!!
        assertEquals("1 waiting below", alone.text)
        assertEquals("approval:a1", alone.rowId)
        assertEquals(ReaderSide.BELOW, alone.side)
        assertEquals(NeedsYouGlyph.HAND, alone.glyph)
        val both = NeedsYouLogic.here(listOf(BelowRow("q1", true)), listOf(BelowRow("approval:a1", false)), ReaderSide.ABOVE)!!
        assertEquals("2 waiting above", both.text)
        assertEquals("q1", both.rowId)
        assertEquals(NeedsYouGlyph.QUESTION, both.glyph)
        assertEquals("1 open question below", NeedsYouLogic.here(listOf(BelowRow("q1", true)), emptyList(), ReaderSide.BELOW)?.text)
        assertNull(NeedsYouLogic.here(emptyList(), emptyList(), ReaderSide.BELOW))
    }

    // swiped away (the owner, 2026-11-15, docs/mocks/needs-you-capsule/06-list-floats; OrbitKit's twin test)

    /** A wait is noticed once, by the conversation's name and what it waits on (the owner, 2026-11-15,
     * docs/mocks/needs-you-capsule/12-once; OrbitKit's twin). */
    @Test fun aWaitIsNoticedOnceByNameAndWhat() {
        val a = session("a", 1, "w1", "orbit-develop", "Android update fails", "2026-11-15T01:00:00Z")
        val b = session("b", 1, "w2", "orbit-op", "Wire up Ollama", "2026-11-15T02:00:00Z")
        val seen = setOf(NeedsYouLogic.waitKey(a))
        val fresh = NeedsYouLogic.newlyWaiting(listOf(a, b), seen)
        assertEquals("only what was not waiting before", listOf("b"), fresh.map { it.target.text("id") })
        assertEquals("Wire up Ollama", fresh.single().title)
        assertEquals("Needs your reply · orbit-op", fresh.single().line)
        assertEquals(NeedsYouGlyph.HAND, fresh.single().glyph)
        val bothSeen = setOf(a, b).map(NeedsYouLogic::waitKey).toSet()
        assertTrue("the same wait, not again", NeedsYouLogic.newlyWaiting(listOf(a, b), bothSeen).isEmpty())
        val bAgain = session("b", 1, "w2", "orbit-op", "Wire up Ollama", "2026-11-15T03:00:00Z")
        assertEquals("stopping again is a new wait", listOf("b"), NeedsYouLogic.newlyWaiting(listOf(a, bAgain), bothSeen).map { it.target.text("id") })
        assertTrue("the conversation on screen has its own card", NeedsYouLogic.newlyWaiting(listOf(a, b), seen, "b").isEmpty())
    }

    /** An owner request stops no turn: the turns after it are the same wait, and the notice says the row's words (OrbitKit's
     * twin). */
    @Test fun anOwnerRequestIsNoticedOnceWhateverTurnsFollow() {
        fun filed(lastTurnAt: String) = buildJsonObject {
            put("id", "t"); put("status", "AWAITING_INPUT"); put("pendingApprovals", 1); put("waitingKind", "OWNER_REQUEST")
            put("title", "Task: Walkthrough"); put("lastTurnAt", lastTurnAt)
            putJsonObject("agent") { put("id", "w"); put("name", "orbit-develop") }
        }
        // The row's own words (docs/mocks/waiting-on-you-removal): the long-standing approval word with no request listed beside it,
        // the request kind's word with one.
        assertEquals("Waiting for approval · orbit-develop", NeedsYouLogic.newlyWaiting(listOf(filed("2026-11-17T22:36:15Z")), emptySet()).single().line)
        val decision = JsonObject(filed("2026-11-17T22:36:15Z") + ("ownerRequests" to buildJsonArray { addJsonObject {
            put("ownerRequestId", "r"); put("kind", "DECISION"); put("title", "Pick one"); put("since", "2026-11-17T22:36:15Z") } }))
        assertEquals("Decision for you · orbit-develop", NeedsYouLogic.newlyWaiting(listOf(decision), emptySet()).single().line)
        val seen = setOf(NeedsYouLogic.waitKey(filed("2026-11-17T22:36:15Z")))
        assertTrue("a later turn is the same wait", NeedsYouLogic.newlyWaiting(listOf(filed("2026-11-17T22:52:34Z")), seen).isEmpty())
    }

    /** Any wait the server names says the row's own words, never the tool call's "Needs your reply" (OrbitKit's twin). */
    @Test fun aNamedWaitIsNoticedInTheRowsWords() {
        val confirming = buildJsonObject {
            put("id", "c"); put("status", "AWAITING_INPUT"); put("pendingApprovals", 1); put("waitingKind", "OWNER_CONFIRMATION")
            put("title", "Task: Ship it"); put("lastTurnAt", "2026-11-18T01:00:00Z")
            putJsonObject("agent") { put("id", "w"); put("name", "orbit-develop") }
        }
        assertEquals("Waiting for your confirmation · orbit-develop", NeedsYouLogic.newlyWaiting(listOf(confirming), emptySet()).single().line)
    }

    /** The first look only takes stock; at most three notices, the rest "and N more"; a notice whose wait ended goes. */
    @Test fun theNoticesTakeStockFirstAndShowAtMostThree() {
        val notices = NeedsYouNotices()
        val a = session("a", 1, lastTurnAt = "2026-11-15T01:00:00Z")
        notices.look(listOf(a), null)
        assertTrue("what waits at launch is not news", notices.toasts.isEmpty())
        val more = (1..4).map { session("n$it", 1, lastTurnAt = "2026-11-15T0${it + 1}:00:00Z") }
        notices.look(listOf(a) + more, null)
        assertEquals(3, notices.toasts.size)
        assertEquals(1, notices.more)
        notices.look(listOf(a) + more.drop(1), null)
        assertEquals("an answered wait takes its notice", listOf("n2", "n3"), notices.toasts.map { it.target.text("id") })
        notices.retake()
        notices.look(listOf(a) + more + session("late", 1, lastTurnAt = "2026-11-15T09:00:00Z"), null)
        assertEquals("back in the foreground: stock again", listOf("n2", "n3"), notices.toasts.map { it.target.text("id") })
        notices.dismiss("n2|2026-11-15T03:00:00Z")
        notices.dismiss("n3|2026-11-15T04:00:00Z")
        assertTrue(notices.toasts.isEmpty())
        assertEquals(0, notices.more)
    }

    /** A terminal asking to be approved is noticed once (the owner, 2026-11-16, under 12-once): the first look takes stock, a new
     * request id draws "Approve a terminal" with its machine and code at the head of the column, the same id never draws a second
     * notice — not on the next look, not after it is flicked away, not back from the background — and an answered one's goes. */
    @Test fun aNewTerminalRequestIsNoticedOnceByItsId() {
        fun r(id: String, machine: String = "dev-laptop", code: String = "7KQ-4MZ") = io.orbitd.android.core.cards.TerminalRequest(
            id, userCode = code, machineName = machine, runnerId = "run-1", createdAt = "2026-11-16T10:00:00Z", expiresAt = "2026-11-16T10:10:00Z")
        val notices = NeedsYouNotices()
        notices.lookTerminals(listOf(r("old")))
        assertTrue("the first look only takes stock", notices.toasts.isEmpty())

        notices.lookTerminals(listOf(r("old"), r("req-1")))
        val toast = notices.toasts.single()
        assertEquals("terminal:req-1", toast.id)
        assertEquals("req-1", toast.terminalRequest)
        assertEquals("Approve a terminal", toast.title)
        assertEquals("dev-laptop · code 7KQ-4MZ", toast.line)
        assertEquals(NeedsYouGlyph.TERMINAL, toast.glyph)

        notices.lookTerminals(listOf(r("old"), r("req-1")))
        assertEquals("the same request: still one notice", 1, notices.toasts.size)
        notices.dismiss(toast.id)
        notices.lookTerminals(listOf(r("old"), r("req-1")))
        assertTrue("flicked away, the same id is not noticed again", notices.toasts.isEmpty())
        notices.retake()
        notices.lookTerminals(listOf(r("old"), r("req-1")))
        notices.lookTerminals(listOf(r("old"), r("req-1")))
        assertTrue("nor back from the background", notices.toasts.isEmpty())

        // A session waiting does not take a terminal's notice away, and a terminal's leads the column.
        val a = session("a", approvals = 1, lastTurnAt = "2026-11-16T10:01:00Z")
        notices.look(emptyList(), null)
        notices.look(listOf(a), null)
        notices.lookTerminals(listOf(r("old"), r("req-1"), r("req-2", "build-box", "R2T-9PX")))
        assertEquals(listOf("terminal:req-2", "a|2026-11-16T10:01:00Z"), notices.toasts.map { it.id })
        notices.look(listOf(a), null)
        assertEquals(2, notices.toasts.size)
        notices.lookTerminals(listOf(r("old")))
        assertEquals("answered or expired: its notice goes", listOf("a|2026-11-16T10:01:00Z"), notices.toasts.map { it.id })
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

    /** The second line names the conversation a press opens (the owner, 2026-10-21): by its title, under the workspace's
     * sentence — and not again when the first line already used that title for want of a workspace name. */
    @Test fun theSecondLineNamesTheConversationAPressOpens() {
        val banner = NeedsYouLogic.banner(listOf(session("s1", 1, "dev", "orbit-develop", "Rebuild the wiki articles report")))
        assertEquals("orbit-develop needs you", banner?.text)
        assertEquals("Rebuild the wiki articles report", banner?.detail)
        assertEquals("a blocked tool call's mark", NeedsYouGlyph.HAND, banner?.glyph)
        assertNull("the title is said once", NeedsYouLogic.banner(listOf(session("s2", 1, "dev", title = "Backfill worktree fences")))?.detail)
        assertNull("a blank title is no line", NeedsYouLogic.banner(listOf(session("s3", 1, "dev", "orbit-develop", "  ")))?.detail)
    }

    /** Several collapse to a count, and the second line is the one a press opens — the oldest — by its title alone (no "Oldest:",
     * the owner's call). The count is the first line, so no "+N"; the age is its last state move. */
    @Test fun severalNameTheOldestOnTheSecondLine() {
        val newer = session("newer", 1, "a", "A", "Newer", lastTurnAt = "2026-08-14T10:00:00.000Z")
        val older = session("older", 1, "b", "B", "Older", lastTurnAt = "2026-08-14T08:00:00.000Z")
        val banner = NeedsYouLogic.banner(listOf(newer, older))
        assertEquals("2 sessions need you", banner?.text)
        assertEquals("Older", banner?.detail)
        assertEquals(0, banner?.more)
        assertEquals("2026-08-14T08:00:00.000Z", banner?.since)
    }

    /** A conversation with no recorded move is aged from its update, the recency key's own fallback. */
    @Test fun aBlockedSessionsAgeFallsBackLikeItsRecency() {
        val row = JsonObject(session("s1", 1, "dev") + ("updatedAt" to JsonPrimitive("2026-08-14T07:00:00.000Z")))
        assertEquals("2026-08-14T07:00:00.000Z", NeedsYouLogic.banner(listOf(row))?.since)
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

    /** The bar's mark is the card a press goes to: a question's while that card is a question, an exception's while it is one. */
    @Test fun theMarkIsTheCardAPressGoesTo() {
        assertEquals(NeedsYouGlyph.QUESTION, NeedsYouLogic.below(listOf(question("q")), ReaderSide.BELOW)?.glyph)
        assertEquals(NeedsYouGlyph.WARNING, NeedsYouLogic.below(listOf(exception("e"), question("q")), ReaderSide.BELOW)?.glyph)
        assertEquals(NeedsYouGlyph.QUESTION, NeedsYouLogic.below(listOf(question("q"), exception("e")), ReaderSide.ABOVE)?.glyph)
    }

    @Test fun nothingBelowIsNoBar() = assertNull(NeedsYouLogic.below(emptyList(), null))

    // the five owner items (contract §7.6 V13; the fifth, owner 2026-10-28)

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
        listOf(Triple("PROMOTION_APPROVAL", "Approve merge to main", NeedsYouGlyph.MERGE),
            Triple("COORDINATOR_QUESTION", "Question from coordinator", NeedsYouGlyph.QUESTION),
            Triple("ESCALATED", "Escalated to you", NeedsYouGlyph.WARNING),
            Triple("FUSE_PAUSED", "Paused", NeedsYouGlyph.PAUSE),
            // §10.7: work that reached main without the owner's confirmation wears the merge's mark — a merge into main is what it is about.
            Triple("LANDED_WITHOUT_CONFIRMATION", "Landed without your confirmation", NeedsYouGlyph.MERGE)).forEach { (kind, text, glyph) ->
            val session = coordinator("c1", "Integration line", listOf(ownerItem(kind, "2026-09-13T10:00:00Z")))
            assertTrue(kind, NeedsYouLogic.needsYou(session))
            val banner = NeedsYouLogic.banner(listOf(session))
            assertEquals(kind, text, banner?.text)
            assertEquals("$kind's second line is its project", "Integration line", banner?.detail)
            assertEquals(kind, glyph, banner?.glyph)
            assertEquals("aged from the item, not the conversation", "2026-09-13T10:00:00Z", banner?.since)
            assertEquals(0, banner?.more)
            assertEquals("and a tap lands in the coordinator conversation", "c1", banner?.target?.text("id"))
            assertEquals("on the card the item is", "item-1", banner?.ownerItem?.itemId)
        }
        assertEquals("promotion:", NeedsYouLogic.cardKey(OwnerItem("i", "PROMOTION_APPROVAL", "", "")))
        assertEquals("item:i", NeedsYouLogic.cardKey(OwnerItem("i", "ESCALATED", "", "")))
        assertEquals("its card is the coordinator conversation's exception card", "item:i",
            NeedsYouLogic.cardKey(OwnerItem("i", "LANDED_WITHOUT_CONFIRMATION", "", "")))
    }

    /** A08-17: a session ROW says an escalated item's need after its word (iOS `NeedsYouLogic.itemWord`); the banner keeps the word and
     * the project, and the other three kinds carry no need. */
    @Test fun aSessionRowSaysAnEscalatedItemsNeed() {
        fun item(kind: String, need: String?) = buildJsonObject {
            put("itemId", "i"); put("kind", kind); put("title", "t"); put("since", "2026-09-13T10:00:00Z"); need?.let { put("need", it) }
        }
        fun row(vararg items: JsonObject) = NeedsYouLogic.oldestItemWord(NeedsYouLogic.ownerItems(items.toList()))
        assertEquals("Escalated to you · the check on the combined tree failed", row(item("ESCALATED", " the check on the combined tree failed ")))
        assertEquals("a blank need leaves the word alone", "Escalated to you", row(item("ESCALATED", "  ")))
        assertEquals("an older server's item has none", "Escalated to you", row(item("ESCALATED", null)))
        assertEquals("Paused", row(item("FUSE_PAUSED", "not the pause's")))
        assertEquals("its need is its own word, said once", "Landed without your confirmation",
            row(item("LANDED_WITHOUT_CONFIRMATION", "Landed without your confirmation")))
        val banner = NeedsYouLogic.banner(listOf(coordinator("c1", "Integration line", listOf(item("ESCALATED", "the check failed")))))
        assertEquals("the bar's first line is the word alone", "Escalated to you", banner?.text)
        assertEquals("and its second line the project, not the need (the owner, 2026-10-21)", "Integration line", banner?.detail)
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
        assertEquals("Approve merge to main", banner?.text)
        assertEquals("Older project", banner?.detail)
        assertEquals(2, banner?.count)
        assertEquals("the one it names, and +1", 1, banner?.more)
    }

    // the bar unfolded (owner 2026-11-13, 03-expand option B)

    @Test fun entriesListEveryConversationInTheBarsOwnOrder() {
        val blockedNew = session("s-new", 1, "dev", "orbit-prod", "Rebuild the report", "2026-09-13T11:00:00Z")
        val blockedOld = session("s-old", 1, "dev", "orbit-prod", "Ship the release", "2026-09-13T07:00:00Z")
        val newer = coordinator("c1", "Newer project", listOf(ownerItem("COORDINATOR_QUESTION", "2026-09-13T12:00:00Z", "new")))
        val older = coordinator("c2", "Older project", listOf(ownerItem("PROMOTION_APPROVAL", "2026-09-13T08:00:00Z", "old")))
        val waiting = listOf(blockedNew, newer, blockedOld, older)
        val entries = NeedsYouLogic.entries(waiting)
        assertEquals(listOf("c2", "c1", "s-old", "s-new"), entries.map { it.target.text("id") })
        assertEquals(listOf("Approve merge to main", "Question from coordinator", "orbit-prod needs you", "orbit-prod needs you"),
            entries.map { it.text })
        assertEquals(listOf("Older project", "Newer project", "Ship the release", "Rebuild the report"), entries.map { it.detail })
        assertEquals(listOf("old", "new", null, null), entries.map { it.ownerItem?.itemId })
        assertEquals("each line is one conversation", listOf(0, 0, 0, 0), entries.map { it.more })
        val banner = NeedsYouLogic.banner(waiting)
        assertEquals("the folded bar names the first line", banner?.target?.text("id"), entries.first().target.text("id"))
        assertEquals(banner?.ownerItem?.itemId, entries.first().ownerItem?.itemId)
    }

    @Test fun entriesNameEachBlockedSessionAndLeaveOutTheFocusedOne() {
        val a = session("a", 1, "a", "A", "First", "2026-08-14T09:00:00.000Z")
        val b = session("b", 1, "b", "B", "Second", "2026-08-14T08:00:00.000Z")
        assertEquals(listOf("B needs you", "A needs you"), NeedsYouLogic.entries(listOf(a, b)).map { it.text })
        assertEquals(listOf("b"), NeedsYouLogic.entries(listOf(a, b), "a").map { it.target.text("id") })
        assertTrue(NeedsYouLogic.entries(emptyList()).isEmpty())
    }

    @Test fun anOwnerItemOutranksABlockedToolCall() {
        val blocked = session("s1", 1, "dev", "wikova-develop")
        val waiting = coordinator("c1", "Integration line", listOf(ownerItem("FUSE_PAUSED", "2026-09-13T10:00:00Z")))
        val banner = NeedsYouLogic.banner(listOf(blocked, waiting))
        assertEquals("Paused", banner?.text)
        assertEquals("Integration line", banner?.detail)
        assertEquals("c1", banner?.target?.text("id"))
        assertEquals("the blocked tool call is the one behind it", 1, banner?.more)
    }

    @Test fun anUnknownKindDoesNotNameTheBar() {
        val unknown = coordinator("c1", "Integration line", listOf(ownerItem("WHAT_IS_THIS", "2026-09-13T10:00:00Z")))
        val banner = NeedsYouLogic.banner(listOf(unknown))
        assertEquals("orbit needs you", banner?.text)
        assertEquals("Project coordinator", banner?.detail)
        assertEquals(NeedsYouGlyph.HAND, banner?.glyph)
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
        assertEquals("Approve merge to main", NeedsYouLogic.banner(listOf(row))?.text)
        assertEquals("Integration line", NeedsYouLogic.banner(listOf(row))?.detail)
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

    /** A revision waiting for the paused coordinator, or sent to it, is not asking the owner (project 34cygPTQe5LPUT7tdUAzG): the
     * corpus has one of each, only the delivery receipt is drawn, and the bar counts neither — without today's evidence card, no evidence at all. */
    @Test fun aRevisionWaitingForTheCoordinatorOrSentToItIsNotCounted() {
        val queue = corpus.obj("snapshot")!!.obj("standing")!!.obj("evidenceDecisions")!!
        val queued = queue.objects("sentToCoordinator")
            .map { "evidence:${it.text("taskId")}:${it.text("evidenceRevision")}" }
        assertEquals(queued.toSet(), CardCatalog.session(corpus.text("sessionId")!!, snapshot())
            .filter { it.family == CardFamily.COORDINATOR_QUEUE }.map { it.key }.toSet())
        val counted = rows(snapshot())
        assertTrue(counted.none { it.rowId in queued })
        val alone = rows(snapshot { standing -> standing["evidenceDecisions"] = JsonObject(queue + ("pending" to JsonArray(emptyList()))) })
        assertTrue(alone.none { it.rowId.startsWith("evidence:") })
        assertEquals(counted.size - 1, alone.size)
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

    /** A08-13: a question that has ended is a record no count reads — the read's, or this window's answer before the read has it. */
    @Test fun aQuestionsRecordIsNotCounted() {
        val items = corpus.obj("snapshot")!!.obj("standing")!!.obj("openItems")!!
        val asked = items.objects("needsYou").single { it.text("itemId") == "q1" }
        val record = CoordinatorQuestions.answeredHere(asked, 0, null, null)
        val answeredHere = NeedsYouLogic.belowRows(corpus.text("sessionId")!!, snapshot(), mapOf("q1" to record))
        assertTrue(answeredHere.none { it.rowId == "item:q1" })
        assertEquals(rows(snapshot()).size - 1, answeredHere.size)
        val read = rows(snapshot { standing ->
            standing["openItems"] = JsonObject(items + ("needsYou" to JsonArray(items.objects("needsYou").filter { it.text("itemId") != "q1" })) +
                ("closedQuestions" to JsonArray(listOf(record))))
        })
        assertTrue(read.none { it.rowId == "item:q1" })
        assertTrue("the record is drawn", CardCatalog.session(corpus.text("sessionId")!!, snapshot(), answered = mapOf("q1" to record))
            .any { it.key == "item:q1" && it.family == CardFamily.QUESTION_RECORD })
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
