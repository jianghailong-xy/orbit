package io.orbitd.android.core.guests

import io.orbitd.android.core.auth.AccountKey
import io.orbitd.android.core.auth.OrbitApi
import io.orbitd.android.core.auth.SessionHandle
import io.orbitd.android.core.net.ApiError
import io.orbitd.android.core.net.ApiRequest
import io.orbitd.android.core.net.ApiResponse
import io.orbitd.android.core.net.HttpMethod
import io.orbitd.android.core.protocol.Wire
import io.orbitd.android.core.realtime.RunEvent
import java.time.Instant
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/** The guest's side of session guests (docs/session-guests-design.md §4), OrbitKit GuestSessionTests: the guest door's reads and its
 * one write, Shared with me, and the guest view's states — in the web's own words (SharedWithMe.tsx, GuestSessionPage.tsx). */
@OptIn(ExperimentalCoroutinesApi::class)
class GuestSessionsTest {
    private val handle = SessionHandle(AccountKey("https://orbit.example/", "bo"))

    private class Sent(val method: HttpMethod, val path: String, val query: List<Pair<String, String>>, val body: String)

    /** Answers [answer] for every request, and keeps what was asked. */
    private class Door(var answer: (ApiRequest) -> Pair<Int, String>) : OrbitApi {
        val sent = mutableListOf<Sent>()
        override suspend fun request(handle: SessionHandle, request: ApiRequest): ApiResponse {
            sent += Sent(request.method, request.path.joinToString("/"), request.query, request.body?.decodeToString().orEmpty())
            val (status, body) = answer(request)
            return ApiResponse(status, body.encodeToByteArray()).requireSuccess()
        }
    }

    private fun door(json: String, status: Int = 200) = Door { status to json }

    private val root = """
    {"title":"Fix the login redirect\nmore","workspaceName":"orbit","status":"RUNNING","runStatus":"RUNNING",
     "sessionState":"RUNNING","runState":"RUNNING","lifecycleState":"OPEN","filingState":"OPEN",
     "createdAt":"2026-11-13T10:00:00.000Z","hasMore":true,"ownerName":"Ana","waitingOnOwner":false,
     "events":[
       {"seq":7,"type":"user","payload":{"text":"hi","externalSender":{"source":"ORBIT_GUEST","name":"Bo"}},"turnId":"t1","ts":"2026-11-13T10:00:01.000Z"},
       {"seq":8,"type":"assistant","payload":{"text":"hello"},"turnId":"t1","ts":"2026-11-13T10:00:02.000Z","truncated":false}
     ]}
    """.trimIndent()

    // The door

    @Test fun sharedWithMeIsOneRead() = runTest {
        val door = door("""{"sessions":[{"id":"34A","title":"Fix it","ownerName":"Ana","status":"RUNNING","sessionState":"RUNNING",
            "lifecycleState":"OPEN","addedAt":"2026-11-13T09:00:00.000Z","lastTurnAt":null}]}""")
        val sessions = door.guestSessions(handle)
        assertEquals(listOf("34A"), sessions.map { it.id })
        assertEquals("Ana", sessions.first().ownerName)
        assertNull(sessions.first().lastTurnAt)
        assertEquals(1, door.sent.size)
        assertEquals(HttpMethod.GET, door.sent[0].method)
        assertEquals("guest-sessions", door.sent[0].path)
        assertEquals(emptyList<Pair<String, String>>(), door.sent[0].query)
    }

    @Test fun theGuestViewsRootDecodesTheHeadAndTheTail() = runTest {
        val door = door(root)
        val session = door.guestSession(handle, "34A", 200)
        assertEquals("Ana", session.ownerName)
        assertEquals("Fix the login redirect\nmore", session.title)
        assertTrue(session.hasMore)
        assertEquals(listOf(7L, 8L), session.events.map { it.seq })
        assertEquals("user", session.events.first().type)
        assertEquals(GuestRunState.RUNNING, session.state.resolvedRunState)
        assertFalse(session.state.waitingOnOwner)
        assertEquals("guest-sessions/34A", door.sent[0].path)
        assertEquals(listOf("limit" to "200", "maxPayload" to "$GUEST_MAX_PAYLOAD"), door.sent[0].query)
    }

    @Test fun aHeadMissingItsNewFieldsStillDecodes() {
        val session = GuestWire.session("""{"title":"T","ownerName":"Ana","status":"CANCELLED","events":[]}""".encodeToByteArray())
        assertEquals(GuestRunState.ENDED, session.state.resolvedRunState)
        assertFalse(session.hasMore)
        assertFalse(session.state.live)
        // Nothing at all reads as Ended; a mistyped field is a default.
        val bare = GuestWire.session("""{"hasMore":"yes","events":[{"seq":1,"type":"user"},{"nope":true}]}""".encodeToByteArray())
        assertEquals(GuestRunState.ENDED, bare.state.resolvedRunState)
        assertEquals(listOf(1L), bare.events.map { it.seq })
        assertFalse(bare.hasMore)
    }

    @Test fun followingAsksAfterTheNewestSeqAndPagingAsksBeforeTheOldest() = runTest {
        val after = door("""{"title":"T","status":"AWAITING_INPUT","runState":"AWAITING_INPUT","lifecycleState":"OPEN",
            "events":[{"seq":9,"type":"assistant","payload":{"text":"x"}}],"after":null,"waitingOnOwner":true}""")
        val now = after.guestEventsAfter(handle, "34A", 8, 200)
        assertEquals(listOf(9L), now.events.map { it.seq })
        assertNull(now.after)
        assertTrue(now.state.waiting)
        assertEquals("guest-sessions/34A/events", after.sent[0].path)
        assertEquals(listOf("after" to "8", "limit" to "200", "maxPayload" to "$GUEST_MAX_PAYLOAD"), after.sent[0].query)

        val before = door("""{"events":[{"seq":3,"type":"user","payload":{"text":"a"}}],"hasMore":false}""")
        val page = before.guestEventsBefore(handle, "34A", 7, 200)
        assertEquals(listOf(3L), page.events.map { it.seq })
        assertFalse(page.hasMore)
        assertEquals(listOf("before" to "7", "limit" to "200", "maxPayload" to "$GUEST_MAX_PAYLOAD"), before.sent[0].query)

        val full = door("""{"seq":8,"type":"tool_call","payload":{"name":"Read"},"turnId":null,"ts":"2026-11-13T10:00:02.000Z"}""")
        assertEquals(8L, full.guestEventFull(handle, "34A", 8).seq)
        assertEquals("guest-sessions/34A/events/8", full.sent[0].path)
    }

    @Test fun aMessageIsTextOnly() = runTest {
        val door = door("""{"turnId":"T9","revived":true}""", 201)
        val accepted = door.sendGuestTurn(handle, "34A", "k1", "Please run the tests")
        assertEquals("T9", accepted.turnId)
        assertTrue(accepted.revived)
        assertEquals(HttpMethod.POST, door.sent[0].method)
        assertEquals("guest-sessions/34A/turns", door.sent[0].path)
        // Nothing but the key and the words: no mode, model, effort or attachment.
        val body = Wire.json.parseToJsonElement(door.sent[0].body) as JsonObject
        assertEquals(mapOf("clientTurnId" to JsonPrimitive("k1"), "content" to JsonPrimitive("Please run the tests")), body.toMap())
    }

    @Test fun notSharedIsTheDoorsOne404() = runTest {
        val door = door("""{"statusCode":404,"code":"GUEST_SESSION_NOT_SHARED"}""", 404)
        try {
            door.guestSession(handle, "34A", 200)
            fail("a 404 must throw")
        } catch (error: ApiError) {
            assertEquals(404, error.status)
        }
    }

    // Shared with me

    private fun summary(id: String = "34A", status: String = "RUNNING", lifecycle: String = "OPEN", lastTurnAt: String? = null) =
        GuestSessionSummary(id, "  \nFix it\nsecond", "Ana", status, status, lifecycle, "2026-11-13T09:00:00.000Z", lastTurnAt)

    @Test fun noGroupWhileThereIsNone() {
        assertFalse(SharedWithMe.showsGroup(emptyList()))
        assertTrue(SharedWithMe.showsGroup(listOf(summary())))
    }

    @Test fun aRowSaysTitleOwnerAndState() {
        assertEquals("Fix it", SharedWithMe.title(summary()))
        assertEquals("Ana · Running", SharedWithMe.subtitle(summary()))
        assertEquals("Ana · Awaiting reply", SharedWithMe.subtitle(summary(status = "AWAITING_INPUT")))
        assertEquals("Ana · Completed", SharedWithMe.subtitle(summary(status = "SUCCEEDED", lifecycle = "COMPLETED")))
    }

    @Test fun aRowsTimeIsItsLastTurnElseWhenItWasShared() {
        val now = Instant.parse("2026-11-13T12:00:00.000Z")
        assertEquals("3h", SharedWithMe.ago(summary(), now))
        assertEquals("2m", SharedWithMe.ago(summary(lastTurnAt = "2026-11-13T11:58:00.000Z"), now))
        assertEquals("now", SharedWithMe.ago(summary(lastTurnAt = "2026-11-13T11:59:59.000Z"), now))
        assertEquals("3d", SharedWithMe.ago(summary(lastTurnAt = "2026-11-10T12:00:00.000Z"), now))
    }

    // The guest view's states

    private fun state(run: GuestRunState, lifecycle: String = "OPEN", waiting: Boolean = false) =
        GuestState(runState = run.name, lifecycleState = lifecycle, waitingOnOwner = waiting)

    @Test fun runningRunsOnTheOwnersMachine() {
        val s = state(GuestRunState.RUNNING)
        assertEquals("Running", s.word)
        assertEquals(GuestTone.RUNNING, s.tone)
        assertEquals("Runs on Ana’s machine", s.hint("Ana"))
        assertEquals(4_000L, GuestFollow.delay(s, moved = false))
        assertEquals("Message Ana’s agent…", GuestCopy.placeholder("Ana"))
    }

    @Test fun waitingOnTheOwnerSaysSoAndTheMessageWaitsItsTurn() {
        val s = state(GuestRunState.AWAITING_INPUT, waiting = true)
        assertTrue(s.waiting)
        assertEquals("Awaiting reply", s.word)
        assertEquals("Your message waits its turn", s.hint("Ana"))
        assertEquals("Waiting for Ana to approve", GuestCopy.waiting("Ana"))
        assertEquals(30_000L, GuestFollow.delay(s, moved = false))
        assertEquals(4_000L, GuestFollow.delay(s, moved = true))
        // Awaiting the next message is not waiting on the owner.
        assertEquals("Runs on Ana’s machine", state(GuestRunState.AWAITING_INPUT).hint("Ana"))
    }

    @Test fun endedRestartsOnTheOwnersMachineAndIsNoLongerFollowed() {
        for (s in listOf(state(GuestRunState.ENDED), state(GuestRunState.SUCCEEDED), state(GuestRunState.FAILED),
            state(GuestRunState.RUNNING, lifecycle = "COMPLETED"))) {
            assertFalse(s.live)
            assertEquals("Send to continue — this restarts the session on Ana’s machine.", s.hint("Ana"))
            // A run still moving is followed even once filed Completed (web `followDelay` asks `isSessionBusy` first).
            if (s.busy) assertEquals(4_000L, GuestFollow.delay(s, moved = false))
            else assertNull(GuestFollow.delay(s, moved = false))
            assertEquals(4_000L, GuestFollow.delay(s, moved = false, expecting = true))
        }
        assertEquals("Completed", state(GuestRunState.SUCCEEDED, lifecycle = "COMPLETED").word)
        assertEquals(GuestTone.DONE, state(GuestRunState.SUCCEEDED, lifecycle = "COMPLETED").tone)
        assertEquals("Ended", state(GuestRunState.ENDED).word)
    }

    @Test fun noLongerSharedReadsInTheWebsWords() {
        assertEquals("This conversation is no longer shared with you.", GuestCopy.NOT_SHARED)
        assertEquals("Ask the person who shared it if you need it again.", GuestCopy.NOT_SHARED_DETAIL)
        assertEquals("Shared by Ana", GuestCopy.sharedBy("Ana"))
        assertEquals("Guest", GuestCopy.GUEST_BADGE)
        assertEquals("Shared with me", GuestCopy.SHARED_WITH_ME)
    }

    @Test fun theGuestsOwnMessagesReadAsTheirs() {
        val session = GuestWire.session(root.encodeToByteArray())
        val mine = GuestTranscript.ownMessages(session.events, " Bo ")
        // Headed `You` (the reader's source), where the owner's own carry no sender at all.
        assertEquals(buildJsonObject { put("source", "ORBIT_READER") }, mine[0].fields["externalSender"])
        assertEquals(JsonPrimitive("hi"), mine[0].fields["text"])
        assertEquals(session.events[1], mine[1])
        // Somebody else's keep `From <name>`.
        assertEquals(session.events, GuestTranscript.ownMessages(session.events, "Cy"))
        assertEquals(session.events, GuestTranscript.ownMessages(session.events, null))
    }

    // The guest view's follow loop and its message

    private fun event(seq: Long, type: String, text: String, guest: String? = null) = buildJsonObject {
        put("seq", seq); put("type", type)
        putJsonObject("payload") {
            put("text", text)
            if (guest != null) putJsonObject("externalSender") { put("source", "ORBIT_GUEST"); put("name", guest) }
        }
    }

    /** A guest door over one session that ended: a message restarts it, echoes as the guest's own and is answered. */
    private class Session {
        val events = mutableListOf<JsonObject>()
        var runState = "ENDED"
        var shared = true
        val asked = mutableListOf<String>()
    }

    private fun conversationDoor(session: Session) = Door { request ->
        val path = request.path.joinToString("/")
        val query = request.query.toMap()
        asked(session, path, query)
        if (!session.shared) return@Door 404 to """{"code":"GUEST_SESSION_NOT_SHARED"}"""
        fun head(events: List<JsonObject>) = """"title":"Fix it","ownerName":"Ana","runState":"${session.runState}","lifecycleState":"OPEN",
            "waitingOnOwner":false,"events":${events.joinToString(",", "[", "]")}"""
        when {
            request.method == HttpMethod.POST -> {
                val content = (Wire.json.parseToJsonElement(request.body!!.decodeToString()) as JsonObject)["content"]!!.let { (it as JsonPrimitive).content }
                val next = (session.events.size + 1).toLong()
                session.events += event(next, "user", content, guest = "Bo")
                session.events += event(next + 1, "assistant", "On it.")
                session.runState = "RUNNING"
                201 to """{"turnId":"T","revived":true}"""
            }
            path == "guest-sessions/34A" -> 200 to "{${head(session.events)},\"hasMore\":false}"
            "after" in query -> 200 to "{${head(session.events.filter { (it["seq"] as JsonPrimitive).content.toLong() > query.getValue("after").toLong() })},\"after\":null}"
            else -> 200 to """{"events":[],"hasMore":false}"""
        }
    }

    private fun asked(session: Session, path: String, query: Map<String, String>) {
        session.asked += path + (query["after"]?.let { "?after=$it" } ?: "")
    }

    @Test fun anEndedSessionIsNotFollowedUntilAMessageRestartsItAndTheMessageReadsAsMine() = runTest {
        val session = Session().apply { events += event(1, "user", "first", guest = "Bo"); events += event(2, "assistant", "done") }
        val view = GuestConversation(conversationDoor(session), handle, "34A", "Bo", backgroundScope) { "k1" }
        val follow = backgroundScope.launch { view.follow() }
        runCurrent()
        assertTrue(view.state.value.loaded)
        assertEquals(GuestCopy.restarts("Ana"), view.state.value.state.hint("Ana"))
        advanceTimeBy(120_000)
        // Ended and quiet: nothing is asked after the root.
        assertEquals(listOf("guest-sessions/34A"), session.asked)

        view.edit("  Please run the tests  ")
        view.send()
        runCurrent()
        // The send asks at once: the echo is the guest's own words, and the run it restarted is followed every 4 s.
        assertEquals("", view.state.value.draft)
        val shown = view.state.value.events
        assertEquals(listOf(1L, 2L, 3L, 4L), shown.map { it.seq })
        assertEquals(JsonPrimitive("Please run the tests"), shown[2].fields["text"])
        assertEquals(buildJsonObject { put("source", "ORBIT_READER") }, shown[2].fields["externalSender"])
        assertEquals(GuestRunState.RUNNING, view.state.value.state.resolvedRunState)
        assertEquals("guest-sessions/34A/events?after=2", session.asked.last())
        val reads = session.asked.size
        advanceTimeBy(4_001)
        assertEquals(reads + 1, session.asked.size)
        follow.cancel()
    }

    @Test fun aRunningSessionIsFollowedEveryFourSecondsAndA404AnyTimeIsNotShared() = runTest {
        val session = Session().apply { runState = "RUNNING"; events += event(1, "user", "hi", guest = "Cy") }
        val view = GuestConversation(conversationDoor(session), handle, "34A", "Bo", backgroundScope)
        val follow = backgroundScope.launch { view.follow() }
        runCurrent()
        // Somebody else's words keep their sender.
        assertTrue(view.state.value.events.single().fields["externalSender"] is JsonObject)
        advanceTimeBy(4_001)
        assertEquals(listOf("guest-sessions/34A", "guest-sessions/34A/events?after=1"), session.asked)
        session.shared = false
        advanceTimeBy(4_001)
        assertTrue(view.state.value.gone)
        val asked = session.asked.size
        advanceTimeBy(60_000)
        assertEquals(asked, session.asked.size)
        assertFalse(follow.isActive)
    }

    @Test fun aSessionNoLongerSharedOpensOnTheNotSharedState() = runTest {
        val session = Session().apply { shared = false }
        val view = GuestConversation(conversationDoor(session), handle, "34A", "Bo", backgroundScope)
        view.follow()
        assertTrue(view.state.value.gone)
        assertFalse(view.state.value.loaded)
    }

    @Test fun aRootTheOwners404AlreadyReadIsNotReadAgain() = runTest {
        val session = Session().apply { events += event(5, "assistant", "x") }
        val first = GuestWire.session("""{"title":"T","ownerName":"Ana","runState":"ENDED","events":[{"seq":5,"type":"assistant"}],"hasMore":true}""".encodeToByteArray())
        val view = GuestConversation(conversationDoor(session), handle, "34A", "Bo", backgroundScope, first)
        assertTrue(view.state.value.loaded)
        assertTrue(view.state.value.hasOlder)
        view.load()
        assertEquals(emptyList<String>(), session.asked)
        view.older()
        runCurrent()
        assertFalse(view.state.value.hasOlder)
        assertEquals(listOf("guest-sessions/34A/events"), session.asked)
    }

    private val RunEvent.text get() = (fields["text"] as? JsonPrimitive)?.content
}
