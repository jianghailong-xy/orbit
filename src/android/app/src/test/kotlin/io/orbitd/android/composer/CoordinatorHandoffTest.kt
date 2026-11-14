package io.orbitd.android.composer

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
        val note = "Where things stand\n- 4 of 6 tasks done; Fix login redirect in review.\n\nAgreed with the owner\nDon't merge Payment retries before Friday's release.\n" +
            "## Waiting on\n- Evidence for Fix login redirect.\n**Next:**\n- Ask for the merge once that evidence is in."
        val sections = CoordinatorHandoff.sections(note)!!
        assertEquals(CoordinatorHandoff.SECTIONS, sections.map { it.title })
        assertEquals(listOf("4 of 6 tasks done; Fix login redirect in review."), sections[0].lines)
        assertEquals(listOf("Ask for the merge once that evidence is in."), sections[3].lines)
        assertNull("free text keeps its own shape", CoordinatorHandoff.sections("Nothing structured here."))
    }

    @Test fun theSuccessorReadsItsHandoff() {
        val received = CoordinatorHandoff.received(obj("""{"coordinatorHandoffReceived":{"handoffFromSessionId":"S0","note":null,
            "handedOverAt":"2026-11-14T15:42:00Z","movedWaits":[{"id":"w1","label":"Waiting for \"Fix login redirect\" to be DONE","paused":false},
            {"id":"w2","label":"Session finishing its turn","paused":true}]}}"""))!!
        assertEquals("S0", received.from); assertNull(received.note); assertEquals(2, received.movedWaits.size)
        assertTrue(received.movedWaits[1].paused)
        assertEquals("2 waits moved here", CoordinatorHandoffCopy.waitsMovedHere(2))
        assertEquals("1 wait moved here", CoordinatorHandoffCopy.waitsMovedHere(1))
        assertEquals("2 pending waits move over", CoordinatorHandoffCopy.waitsRowTitle(2))
        assertEquals("1 pending wait moves over", CoordinatorHandoffCopy.waitsRowTitle(1))
    }
}
