package io.orbitd.android.composer

import io.orbitd.android.core.net.HttpMethod
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
import java.time.Instant
import java.time.ZoneId
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest

/** The context dialog's and the handoff's rules (boards 02, 03), off the session's detail as the server sends it. */
class CoordinatorHandoffTest {
    private fun obj(json: String) = Json.parseToJsonElement(json).jsonObject
    private fun coordinator(extra: String = "") = obj("""{"id":"S1","lifecycleState":"OPEN",
        "projectMembership":{"projectId":"P1","projectTitle":"Checkout redesign","projectStatus":"OPEN","role":"COORDINATOR"}$extra}""")

    @Test fun startSkipAndRetrySendThePickedSuccessorOrAnEmptyObject() {
        val pick = HandoffSuccessor("claude", "claude")
        val expected = obj("""{"successor":{"engine":"claude","provider":"claude"}}""")
        for (action in listOf(null, "skip", "retry")) {
            val request = CoordinatorHandoffApi.postRequest("P1", action, pick)
            assertEquals(HttpMethod.POST, request.method)
            assertEquals(listOfNotNull("projects", "P1", "coordinator", "handoff", action), request.path)
            assertEquals(expected, obj(request.body!!.decodeToString()))
            assertEquals("{}", CoordinatorHandoffApi.postRequest("P1", action, null).body!!.decodeToString())
        }
    }

    @Test fun sameAsThisOneSaidOnPurposeSendsANullSuccessorWhichClearsASavedPick() {
        for (action in listOf("skip", "retry")) {
            val body = CoordinatorHandoffApi.postRequest("P1", action, HandoffSuccessor.SAME).body!!.decodeToString()
            assertEquals("""{"successor":null}""", body)
        }
    }

    @Test fun outgoingHandoffReadsAnOptionalSuccessor() {
        fun successor(fields: String = "") = CoordinatorHandoff.outgoing(
            coordinator(""","coordinatorHandoff":{"state":"FAILED"$fields}"""),
        )!!.successor

        assertNull(successor())
        assertNull(successor(""","successor":null"""))
        assertEquals(HandoffSuccessor("claude", "claude", "claude-opus-5-5"),
            successor(""","successor":{"engine":"claude","provider":"claude","model":"claude-opus-5-5"}"""))
        assertEquals(HandoffSuccessor(null, "my-key"),
            successor(""","successor":{"provider":"my-key"}"""))
    }

    @Test fun compactIsOfferedOnlyWhereTheEngineAdvertisesIt() {
        val compact = obj("""{"name":"compact","type":"command","provider":"claude","builtin":true}""")
        val review = obj("""{"name":"review","type":"command","provider":"claude"}""")
        val skill = obj("""{"name":"compact","type":"skill","provider":"claude"}""")
        assertTrue(CoordinatorHandoff.compactOffered(listOf(review, compact)))
        assertFalse(CoordinatorHandoff.compactOffered(listOf(review)))
        assertFalse("a skill of that name is not the command", CoordinatorHandoff.compactOffered(listOf(skill)))
        assertFalse("an engine with no slash commands (Codex)", CoordinatorHandoff.compactOffered(emptyList()))
    }

    @Test fun compactEngineGateIsTheComposersSlashMatching() {
        val catalog = ComposerCatalog(runner = obj("""{"commands":[{"name":"compact","type":"command","provider":"claude","builtin":true}]}"""), providers = emptyList())
        assertTrue(CoordinatorHandoff.compactOffered(catalog.slashItems(ProviderEngines.CLAUDE, null)))
        assertFalse(CoordinatorHandoff.compactOffered(catalog.slashItems(ProviderEngines.CODEX, null)))
        assertFalse(CoordinatorHandoff.compactOffered(catalog.slashItems(ProviderEngines.CURSOR, null)))
    }

    @Test fun compactIsDisabledWhileATurnRuns() {
        assertTrue(CoordinatorHandoff.compactEnabled(running = false))
        assertFalse(CoordinatorHandoff.compactEnabled(running = true))
        fun handoff(state: String) = OutgoingHandoff(state, null, null, null, null)
        assertFalse("while the note is written", CoordinatorHandoff.compactEnabled(false, handoff("WRITING")))
        assertFalse("while it hands over", CoordinatorHandoff.compactEnabled(false, handoff("HANDING_OVER")))
        assertTrue(CoordinatorHandoff.compactEnabled(false, handoff("FAILED")))
    }

    @Test fun startANewCoordinatorOnlyInTheCurrentOpenCoordinator() {
        assertTrue(CoordinatorHandoff.startOffered(coordinator()))
        assertFalse("an ordinary session", CoordinatorHandoff.startOffered(obj("""{"id":"S1","lifecycleState":"OPEN"}""")))
        assertFalse("a task run of the project", CoordinatorHandoff.startOffered(obj("""{"id":"S1","lifecycleState":"OPEN",
            "projectMembership":{"projectId":"P1","projectTitle":"X","projectStatus":"OPEN","role":"TASK"}}""")))
        assertFalse("a completed coordinator", CoordinatorHandoff.startOffered(obj("""{"id":"S1","lifecycleState":"COMPLETED",
            "projectMembership":{"projectId":"P1","projectTitle":"X","projectStatus":"OPEN","role":"COORDINATOR"}}""")))
        for (state in listOf("WRITING", "HANDING_OVER", "FAILED", "COMPLETED"))
            assertFalse("a handoff $state", CoordinatorHandoff.startOffered(coordinator(""","coordinatorHandoff":{"state":"$state","startedAt":"2026-11-14T10:00:00Z"}""")))
        assertTrue("a cleared (cancelled) handoff is null", CoordinatorHandoff.startOffered(coordinator(""","coordinatorHandoff":null""")))
    }

    @Test fun theComposerIsLockedOnlyWhileTheNoteIsWrittenAndHandedOver() {
        fun locks(state: String) = CoordinatorHandoff.outgoing(coordinator(""","coordinatorHandoff":{"state":"$state","startedAt":"2026-11-14T10:00:00Z"}"""))!!.locksComposer
        assertTrue(locks("WRITING")); assertTrue(locks("HANDING_OVER"))
        assertFalse(locks("FAILED")); assertFalse(locks("COMPLETED"))
        assertNull(CoordinatorHandoff.outgoing(coordinator()))
    }

    /** Board 02 ⑥: the engine compacts before it can write the note — the row says so, and its clock keeps running. */
    @Test fun aWritingHandoffReadsCompactingWhileTheEngineCompacts() {
        val writing = ""","coordinatorHandoff":{"state":"WRITING","startedAt":"2026-11-14T10:00:00Z"}"""
        val compacting = CoordinatorHandoff.outgoing(coordinator("$writing,\"enginePhase\":\"compacting\""))!!
        assertEquals("Compacting…", CoordinatorHandoff.progressLabel(compacting))
        assertTrue("the timer is still shown", CoordinatorHandoff.showsTimer(compacting))
        assertEquals("0:24", CoordinatorHandoff.elapsed(compacting.startedAt, Instant.parse("2026-11-14T10:00:24Z")))
        for (phase in listOf(""","enginePhase":null""", "")) {
            val plain = CoordinatorHandoff.outgoing(coordinator(writing + phase))!!
            assertEquals("Writing the handoff note", CoordinatorHandoff.progressLabel(plain))
            assertTrue(CoordinatorHandoff.showsTimer(plain))
        }
        val other = CoordinatorHandoff.outgoing(coordinator("$writing,\"enginePhase\":\"warming\""))!!
        assertEquals("a phase this build has not heard of", "Writing the handoff note", CoordinatorHandoff.progressLabel(other))
        val handingOver = CoordinatorHandoff.outgoing(coordinator(""","coordinatorHandoff":{"state":"HANDING_OVER"},"enginePhase":"compacting""""))!!
        assertEquals("Handing over to a new coordinator…", CoordinatorHandoff.progressLabel(handingOver))
        assertFalse(CoordinatorHandoff.showsTimer(handingOver))
    }

    @Test fun aFailureOffersItsThreeExitsButOnlyHandOverOnceTheCoordinatorIsCompleted() {
        assertEquals(listOf("Try again", "Hand over without a note", "Keep this coordinator"), CoordinatorHandoff.failureActions("TURN_FAILED"))
        assertEquals(listOf("Hand over without a note"), CoordinatorHandoff.failureActions("REPLACE_FAILED"))
        assertEquals("The handoff note wasn't written: the turn timed out.", CoordinatorHandoffCopy.failureSentence("TIMED_OUT"))
    }

    /** A session as the server says it — not running: the note turn has ended — with its handoff in [state], or none. */
    private fun ended(state: String?) = obj("""{"id":"S1","status":"AWAITING_INPUT","runState":"AWAITING_INPUT","lifecycleState":"OPEN"""" +
        (state?.let { ""","coordinatorHandoff":{"state":"$it","startedAt":"2026-11-14T10:00:00Z"}""" } ?: "") + "}")

    @Test fun aHandoffInHandIsReadAgainLiveOrNot() {
        assertTrue(CoordinatorHandoff.keepsReading(ended("WRITING")))
        assertTrue(CoordinatorHandoff.keepsReading(ended("HANDING_OVER")))
        assertFalse(CoordinatorHandoff.keepsReading(ended("FAILED")))
        assertFalse(CoordinatorHandoff.keepsReading(ended("COMPLETED")))
        assertFalse(CoordinatorHandoff.keepsReading(ended(null)))
        assertFalse(CoordinatorHandoff.keepsReading(null))
    }

    @OptIn(ExperimentalCoroutinesApi::class)
    @Test fun aNonLiveSessionWritingItsNoteKeepsReloadingUntilTheHandoffSettles() = runTest {
        // The server's answers, one per read: still writing, then handing over, then handed over.
        val answers = ArrayDeque(listOf(ended("WRITING"), ended("HANDING_OVER"), ended("COMPLETED")))
        var current = ended("WRITING")
        var reloads = 0
        val job = launch { CoordinatorHandoff.follow({ current }) { reloads++; current = answers.removeFirst() } }
        runCurrent()
        assertEquals("nothing before the first interval", 0, reloads)
        advanceTimeBy(CoordinatorHandoff.FOLLOW_MS - 1); runCurrent()
        assertEquals(0, reloads)
        advanceTimeBy(1); runCurrent()
        assertEquals("every 4 s while WRITING, though the session is not running", 1, reloads)
        advanceTimeBy(CoordinatorHandoff.FOLLOW_MS); runCurrent()
        assertEquals("and while HANDING_OVER", 2, reloads)
        advanceTimeBy(CoordinatorHandoff.FOLLOW_MS); runCurrent()
        assertEquals(3, reloads)
        assertTrue("COMPLETED ends it", job.isCompleted)
        advanceTimeBy(CoordinatorHandoff.FOLLOW_MS * 5); runCurrent()
        assertEquals(3, reloads)
    }

    @OptIn(ExperimentalCoroutinesApi::class)
    @Test fun aWritingNoteThatFailsStopsReloadingAtFailed() = runTest {
        var current = ended("WRITING")
        var reloads = 0
        val job = launch { CoordinatorHandoff.follow({ current }) { reloads++; if (reloads == 2) current = ended("FAILED") } }
        advanceTimeBy(CoordinatorHandoff.FOLLOW_MS * 10); runCurrent()
        assertEquals(2, reloads)
        assertTrue(job.isCompleted)
    }

    @OptIn(ExperimentalCoroutinesApi::class)
    @Test fun aSessionWithNoHandoffIsNotReloaded() = runTest {
        for (state in listOf(null, "FAILED", "COMPLETED")) {
            var reloads = 0
            val job = launch { CoordinatorHandoff.follow({ ended(state) }) { reloads++ } }
            advanceTimeBy(CoordinatorHandoff.FOLLOW_MS * 10); runCurrent()
            assertEquals("no reload for ${state ?: "no handoff"}", 0, reloads)
            assertTrue(job.isCompleted)
        }
    }

    @Test fun theNotePromptIsOrbitsAndOnlyIt() {
        assertTrue(CoordinatorHandoff.isNotePrompt("From Orbit · handoff note\n\nThe owner is handing this project over…"))
        assertFalse(CoordinatorHandoff.isNotePrompt("Please write a handoff note"))
        assertFalse(CoordinatorHandoff.isNotePrompt(null))
    }

    @Test fun theTimerAndTheClock() {
        assertEquals("0:24", CoordinatorHandoff.elapsed("2026-11-14T10:00:00Z", Instant.parse("2026-11-14T10:00:24Z")))
        assertEquals("12:05", CoordinatorHandoff.elapsed("2026-11-14T10:00:00Z", Instant.parse("2026-11-14T10:12:05Z")))
        assertEquals("3:42 PM", CoordinatorHandoff.clock("2026-11-14T15:42:00Z", ZoneId.of("UTC")))
    }

    @Test fun theNoteReadsAsItsFourSections() {
        val note = "Where things stand\n- 4 of 6 tasks done; Fix login redirect in review.\n\nRulings not yet recorded\nDon't merge Payment retries before Friday's release.\n" +
            "## Waiting on\n- Evidence for Fix login redirect.\n**Next:**\n- Ask for the merge once that evidence is in."
        val parsed = CoordinatorHandoff.sections(note)!!
        val sections = parsed.sections
        assertEquals(emptyList<String>(), parsed.preamble)
        assertEquals(CoordinatorHandoff.SECTIONS, sections.map { it.title })
        assertEquals(listOf("4 of 6 tasks done; Fix login redirect in review."), sections[0].lines)
        assertEquals(listOf("Ask for the merge once that evidence is in."), sections[3].lines)
        assertNull("free text keeps its own shape", CoordinatorHandoff.sections("Nothing structured here."))
    }

    @Test fun linesBeforeTheFirstHeadingAreKeptAboveTheSections() {
        val parsed = CoordinatorHandoff.sections("Handing over after the release.\n\n- Read this first.\nWhere things stand\n- 4 of 6 done.\nNext\n- Merge.")!!
        assertEquals(listOf("Handing over after the release.", "Read this first."), parsed.preamble)
        assertEquals(listOf("Where things stand", "Next"), parsed.sections.map { it.title })
        assertEquals(listOf("4 of 6 done."), parsed.sections[0].lines)
    }

    @Test fun theSuccessorReadsItsHandoff() {
        val received = CoordinatorHandoff.received(obj("""{"coordinatorHandoffReceived":{"handoffFromSessionId":"S0","note":null,
            "handedOverAt":"2026-11-14T15:42:00Z","movedWaits":[{"id":"w1","label":"Waiting for \"Fix login redirect\" to be DONE","paused":false},
            {"id":"w2","label":"Session finishing its turn","paused":true}]}}"""))!!
        assertEquals("S0", received.from); assertNull(received.note); assertEquals(2, received.movedWaits.size)
        assertTrue(received.movedWaits[1].paused)
        assertEquals("a paused wait says so", "Session finishing its turn (paused)", received.movedWaits[1].shownLabel)
        assertEquals("Waiting for \"Fix login redirect\" to be DONE", received.movedWaits[0].shownLabel)
        assertEquals("2 waits moved here", CoordinatorHandoffCopy.waitsMovedHere(2))
        assertEquals("1 wait moved here", CoordinatorHandoffCopy.waitsMovedHere(1))
        assertEquals("2 pending waits move over", CoordinatorHandoffCopy.waitsRowTitle(2))
        assertEquals("1 pending wait moves over", CoordinatorHandoffCopy.waitsRowTitle(1))
    }

    /** Handoff v2 §1: each wait names its kind after its label; a watch, and a wait from a server without `kind`, read as before. */
    @Test fun eachWaitNamesItsKindAndAWaitWithoutOneReadsAsBefore() {
        val waits = CoordinatorHandoff.waits(Json.parseToJsonElement("""[
            {"id":"r1","kind":"SUBAGENT","label":"Deploy 55a189aa3 to production","paused":false},
            {"id":"sw1","kind":"WAKEUP","label":"Check the deploy","paused":false},
            {"id":"bgj_1","kind":"JOB","label":"pnpm test","paused":false},
            {"id":"l1","kind":"LOOP","label":"Babysit CI","paused":false},
            {"id":"w1","kind":"WATCH","label":"Waiting for Fix login redirect","paused":true},
            {"id":"w2","label":"Session finishing its turn","paused":false},
            {"id":"x1","kind":"SOMETHING_NEW","label":"Something new","paused":false}]"""))
        assertEquals(listOf("Deploy 55a189aa3 to production · SubAgent", "Check the deploy · Scheduled wakeup", "pnpm test · Background job",
            "Babysit CI · Wakeup loop", "Waiting for Fix login redirect (paused)", "Session finishing its turn", "Something new"),
            waits.map { it.shownLabel })
    }

    /** Board 03 iOS 2's body, word for word as OrbitKit's `phoneConfirmBody` pins it: the waits a count, none when there are none. */
    @Test fun thePhoneConfirmBodyIsIOSs() {
        assertEquals("This coordinator writes a handoff note, then the project continues in a new conversation. 2 pending waits move over. Nothing is deleted.",
            CoordinatorHandoffCopy.phoneConfirmBody(2, running = false))
        assertEquals("This coordinator writes a handoff note, then the project continues in a new conversation. Nothing is deleted.",
            CoordinatorHandoffCopy.phoneConfirmBody(0, running = false))
        assertTrue(CoordinatorHandoffCopy.phoneConfirmBody(1, running = true).startsWith("After the current turn ends, this coordinator writes a handoff note"))
    }

    /** A refused press reads web's toast title, then the server's message, else what kind of failure it was. */
    @Test fun aRefusedPressSaysCouldntHandOver() {
        assertEquals("Couldn't hand over: This project already has a handoff under way.", CoordinatorHandoff.refusal(
            io.orbitd.android.core.net.ApiError.parse(409, """{"message":"This project already has a handoff under way."}""".encodeToByteArray())))
        assertEquals("Couldn't hand over: Can't reach Orbit. Check your connection and try again.",
            CoordinatorHandoff.refusal(io.orbitd.android.core.net.NetworkException()))
    }
}
