package io.orbitd.android.core.cards

import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
import java.time.Instant
import java.time.ZoneId

/**
 * The Claude region check's rules as this app reads them (docs/claude-region-check-contract.md): OrbitKit's ClaudeRegionTests "the
 * rules" and "the session card", case for case — themselves the web's `claudeRegion.test.ts` and `RunNeverStartedCard.region.test.tsx`.
 * The words are ClaudeRegionCopyParityTest's.
 */
class ClaudeRegionTest {
    private val shanghai = ZoneId.of("Asia/Shanghai")
    /** 2026-10-31 12:00 in Shanghai, and HPC's check two minutes before: the card's "Checked 11:58". */
    private val now = Instant.parse("2026-10-31T04:00:00Z").toEpochMilli()
    private val checkedAt = "2026-10-31T03:58:00Z"

    private fun region(verdict: String? = "blocked", country: String = "CN", regionCode: String? = null, name: String = "mainland China",
        viaProxy: Boolean = false, checked: String? = checkedAt) = buildJsonObject {
        verdict?.let { put("verdict", it) }; put("country", country); put("regionCode", regionCode?.let(::JsonPrimitive) ?: JsonNull)
        put("name", name); put("viaProxy", viaProxy); checked?.let { put("checkedAt", it) }
    }
    private val blocked = region()

    private fun refusal(machine: String = "HPC", region: String = "mainland China") =
        "CLAUDE_REGION_UNSUPPORTED: $machine’s connection to Anthropic is in $region, where Anthropic doesn’t offer Claude."
    private fun stopped(machine: String = "HPC", region: String = "mainland China") =
        "CLAUDE_REGION_UNSUPPORTED: Claude Code stopped on $machine: its connection to Anthropic is now in $region, where Anthropic doesn’t offer Claude."

    /** A session's row as GET /sessions/:id carries it: queued is `runState` QUEUED and its run PENDING. */
    private fun session(status: String = "PENDING", error: String?, runState: String? = if (status == "PENDING") "QUEUED" else null) = buildJsonObject {
        put("id", "s"); put("status", status); put("runStatus", status); runState?.let { put("runState", it) }; error?.let { put("error", it) }
    }

    private fun card(session: JsonObject, machine: String = "HPC", region: JsonObject?) =
        SessionRunStart.card(session, machine, region = region, nowMs = now, zone = shanghai)

    // the rules (claudeRegion.test.ts)

    @Test fun onlyABlockedEffectiveVerdictGates() {
        assertTrue(ClaudeRegion.blocked(blocked))
        assertFalse(ClaudeRegion.blocked(null))
        assertFalse(ClaudeRegion.blocked(region("allowed", "SG", name = "Singapore")))
        assertFalse(ClaudeRegion.blocked(region(verdict = null)))
    }

    @Test fun aRegionErrorIsReadByItsCodeAlone() {
        assertTrue(ClaudeRegion.isRegionError(refusal()))
        assertTrue(ClaudeRegion.isRegionError("  " + stopped()))
        assertFalse(ClaudeRegion.isRegionError("runner offline"))
        assertFalse(ClaudeRegion.isRegionError("HPC: CLAUDE_REGION_UNSUPPORTED somewhere in the middle"))
        assertFalse(ClaudeRegion.isRegionError(null))
    }

    @Test fun theTranscriptDrawsNoLineForARefusalAndTheStoppedSentenceWithoutItsCode() {
        assertEquals(ClaudeRegion.ErrorLine.Refusal, ClaudeRegion.errorLine(refusal()))
        assertEquals(ClaudeRegion.ErrorLine.Stopped("Claude Code stopped on HPC: its connection to Anthropic is now in mainland China, " +
            "where Anthropic doesn’t offer Claude."), ClaudeRegion.errorLine(stopped()))
        assertEquals(ClaudeRegion.ErrorLine.NotRegion, ClaudeRegion.errorLine("Claude Code needs authentication"))
        // A machine named like the stopped sentence is still a refusal: the shape is the whole sentence.
        assertEquals(ClaudeRegion.ErrorLine.Refusal, ClaudeRegion.errorLine(refusal("Claude Code stopped on HPC")))
    }

    @Test fun aHeldSessionIsQueuedWithARegionErrorAndSaysWhereAnthropicIsUnavailable() {
        val held = session(error = refusal())
        assertTrue(ClaudeRegion.held(held))
        assertEquals("Anthropic unavailable on HPC", ClaudeRegion.heldWords(ClaudeRegion.held(held), "HPC"))
        // Where the machine is not known, it says nothing of its own.
        assertNull(ClaudeRegion.heldWords(true, null))
        assertNull(ClaudeRegion.heldWords(true, ""))
        assertNull(ClaudeRegion.heldWords(false, "HPC"))
        // Not queued, or queued for anything else: not held.
        assertFalse(ClaudeRegion.held(session("FAILED", refusal())))
        assertFalse(ClaudeRegion.held(session(error = "Waiting for a slot")))
        assertTrue(ClaudeRegion.held(null, "PENDING", stopped()))
        assertFalse(ClaudeRegion.held(null, "AWAITING_INPUT", stopped()))
        // The server's run state wins over the run's status where it names one this build knows, as SessionRunState.resolve reads it.
        assertFalse(ClaudeRegion.held("RUNNING", "PENDING", refusal()))
        assertTrue(ClaudeRegion.held("SOMETHING_NEW", "PENDING", refusal()))
    }

    @Test fun anthropicBoundIsTheSignInAClaudePoolAndAnAnthropicKey() {
        assertTrue(ClaudeRegion.credentialIsAnthropicBound(ClaudeRegion.Credential.Login("claude")))
        assertTrue(ClaudeRegion.credentialIsAnthropicBound(ClaudeRegion.Credential.Pool("claude")))
        assertTrue(ClaudeRegion.credentialIsAnthropicBound(ClaudeRegion.Credential.Key("anthropic")))
        assertFalse(ClaudeRegion.credentialIsAnthropicBound(ClaudeRegion.Credential.Key("deepseek")))
        assertFalse(ClaudeRegion.credentialIsAnthropicBound(ClaudeRegion.Credential.Key(null)))
        assertFalse(ClaudeRegion.credentialIsAnthropicBound(ClaudeRegion.Credential.Login("codex")))
        assertFalse(ClaudeRegion.credentialIsAnthropicBound(ClaudeRegion.Credential.Pool("codex")))
        assertFalse(ClaudeRegion.credentialIsAnthropicBound(ClaudeRegion.Credential.OpenCode))
    }

    @Test fun checkAgainIsAnsweredOnceACheckAtOrAfterTheRequestIsRecorded() {
        val asked = "2026-10-31T04:00:00.250Z"
        assertFalse(ClaudeRegion.checkAnswered("2026-10-31T03:58:00Z", asked))
        assertTrue(ClaudeRegion.checkAnswered("2026-10-31T04:00:00.250Z", asked))
        assertTrue(ClaudeRegion.checkAnswered("2026-10-31T04:00:03Z", asked))
        assertTrue("an offset reads as the same instant", ClaudeRegion.checkAnswered("2026-10-31T12:00:03+08:00", asked))
        assertFalse(ClaudeRegion.checkAnswered(null, asked))
        assertEquals(2_000L, ClaudeRegion.CHECK_POLL_MS)
        assertEquals(30_000L, ClaudeRegion.CHECK_WAIT_MS)
    }

    // the session card (RunNeverStartedCard.region.test.tsx)

    @Test fun theCardReadsTheCauseOffTheCodeAndThePlaceOffTheRunner() {
        val card = card(session(error = refusal()), region = blocked)!!
        assertEquals("This run never started", SessionRunStart.title)
        assertEquals("Claude Code can’t use Anthropic on HPC", card.why)
        assertEquals("HPC’s connection to Anthropic is in mainland China, where Anthropic doesn’t offer Claude.", card.body)
        assertEquals(SessionRunStart.Link("Supported regions", "https://www.anthropic.com/legal/supported-regions"), card.link)
        assertEquals(listOf("CLAUDE_REGION_UNSUPPORTED · CN", "Checked 11:58 · Claude’s connection: mainland China (no proxy)"), card.lines)
        assertEquals(listOf(SessionRunStart.Kind.OTHER_PROVIDER, SessionRunStart.Kind.MOVE_SESSION, SessionRunStart.Kind.CHECK_AGAIN),
            card.actions.map { it.kind })
        assertEquals(listOf("Use another provider", "Move to another machine", "Check again"), card.actions.map { it.label })
        // Use another provider is the press the card wants: drawn filled, the other two beside it.
        assertEquals(listOf(true, false, false), card.actions.map { it.primary })
        assertEquals("No engine ran · your message is still here", card.footer)
    }

    @Test fun theCheckLineSaysAProxyWhenTheCheckWentThroughOne() {
        assertEquals("Checked 11:58 · Claude’s connection: mainland China (through a proxy)",
            card(session(error = refusal()), region = region(viaProxy = true))!!.lines.last())
    }

    @Test fun theCheckTimeOfAnotherDayCarriesItsWeekday() {
        assertEquals("Checked Fri 11:58 · Claude’s connection: mainland China (no proxy)",
            card(session(error = refusal()), region = region(checked = "2026-10-30T03:58:00Z"))!!.lines.last())
    }

    @Test fun aRegionWithNoCheckTimeDrawsTheSubjectAlone() {
        assertEquals(listOf("CLAUDE_REGION_UNSUPPORTED · CN"), card(session(error = refusal()), region = region(checked = null))!!.lines)
    }

    @Test fun anExcludedRegionOfAListedCountryIsNamedByItsOwnCode() {
        val crimea = region(country = "UA", regionCode = "UA-43", name = "Crimea")
        val card = card(session(error = refusal("HPC", "Crimea")), region = crimea)!!
        assertEquals("CLAUDE_REGION_UNSUPPORTED · UA-43", card.lines.first())
        assertEquals("HPC’s connection to Anthropic is in Crimea, where Anthropic doesn’t offer Claude.", card.body)
    }

    @Test fun thePlaceIsNeverReadOutOfTheSentence() {
        // The sentence was written before the last check; the card says where the runner stands now.
        val card = card(session(error = refusal("HPC", "Russia")), region = blocked)!!
        assertTrue(card.body.contains("mainland China"))
        assertFalse(card.body.contains("Russia"))
    }

    @Test fun aRunnerThatNoLongerReadsBlockedKeepsTheServersWordsWithoutTheCode() {
        for (region in listOf(null, region("allowed", "SG", name = "Singapore"))) {
            val card = card(session(error = refusal()), region = region)!!
            assertEquals("Claude Code can’t use Anthropic on HPC", card.why)
            assertEquals(listOf("CLAUDE_REGION_UNSUPPORTED"), card.lines)
            assertEquals("HPC’s connection to Anthropic is in mainland China, where Anthropic doesn’t offer Claude.", card.body)
            assertEquals(listOf(SessionRunStart.Kind.OTHER_PROVIDER, SessionRunStart.Kind.MOVE_SESSION, SessionRunStart.Kind.CHECK_AGAIN),
                card.actions.map { it.kind })
        }
    }

    @Test fun theRegionCauseOutranksEveryCauseReadByPatternWhateverTheMachineIsCalled() {
        // "offline", "not signed in" and an upgrade sentence in a machine's name would otherwise pick other cards, and an Antigravity or
        // DeepSeek Harness repair would claim none.
        for (machine in listOf("offline-box", "not signed in", "old runner, update this runner first", "needs authentication",
            "Antigravity CLI isn't installed on workstation")) {
            val card = card(session(error = refusal(machine, "Russia")), machine = machine, region = null)!!
            assertEquals("Claude Code can’t use Anthropic on $machine", card.why)
            assertEquals(SessionRunStart.Kind.OTHER_PROVIDER, card.actions.first().kind)
        }
    }

    @Test fun aControlPlaneThatPredatesTheHoldFailedTheRunAndTheFootSaysSo() {
        assertEquals("Ended · no engine ran · 0 turns", card(session("FAILED", refusal()), region = blocked)!!.footer)
    }

    @Test fun aStoppedTurnRanAndDrawsNoCardUnlessAMessageWaitsBehindIt() {
        // Parked after the stop, and failed by a control plane that predates the subtypes: no card — its sentence stands in the transcript.
        assertNull(card(session("AWAITING_INPUT", stopped()), region = blocked))
        assertNull(card(session("FAILED", stopped()), region = blocked))
        // Queued behind the stopped turn, the next message waits under the same hold.
        assertEquals("Claude Code can’t use Anthropic on HPC", card(session(error = stopped()), region = blocked)?.why)
    }

    @Test fun aMachineWithNoNameIsThisRunner() {
        assertEquals("Claude Code can’t use Anthropic on this runner", card(session(error = refusal()), machine = "", region = null)!!.why)
    }
}
