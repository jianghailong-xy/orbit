package io.orbitd.android.composer

import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.*
import io.orbitd.android.core.cards.ClaudeRegion
import io.orbitd.android.core.net.ApiResponse
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
import org.robolectric.annotation.GraphicsMode
import java.time.Instant
import java.time.ZoneId

/**
 * The Claude region check on the session page (docs/claude-region-check-contract.md, board 03; iOS `SessionRunStartCardView`), over the
 * controlled server: a session HPC's runner refused for its region, held in the queue with the refusal as its error, on a runner whose
 * Claude connection comes out in mainland China. The card says why and where, with its three ways out — Use another provider lists what
 * can run here and moves the session's credential, Move to another machine opens the session's Move, Check again asks the runner to check
 * now — the refusal draws no line in the transcript, the Provider menu marks the Anthropic credentials Region not supported with no fix,
 * and the session list says Anthropic is unavailable on HPC. A runner that reads no region draws what it draws today.
 */
class ClaudeRegionShellTest : ComposerShellTest() {
    private val refusal = "CLAUDE_REGION_UNSUPPORTED: HPC’s connection to Anthropic is in mainland China, where Anthropic doesn’t offer Claude."
    /** Two minutes before the run, as a runner that checked a moment ago reads. */
    private val checkedAt = Instant.now().minusSeconds(120).toString()
    private fun blocked(checked: String = checkedAt) =
        """{"verdict":"blocked","country":"CN","regionCode":null,"name":"mainland China","viaProxy":false,"checkedAt":"$checked"}"""
    /** Board 02 C's keys: DeepSeek, Personal Max and Work (Anthropic), Local vLLM. */
    private val keys = """[{"slug":"deepseek","label":"DeepSeek","runtime":"claude","presetSlug":"deepseek","engines":["claude","opencode","dsh"],
        "models":[{"value":"deepseek-v4.1-flash","label":"DeepSeek V4.1 Flash"}],"defaultModel":"deepseek-v4.1-flash"},
        {"slug":"anthropic","label":"Personal Max","runtime":"claude","presetSlug":"anthropic","engines":["claude"],"models":[],"modelsFromRuntime":true},
        {"slug":"anthropic-2","label":"Work","runtime":"claude","presetSlug":"anthropic","engines":["claude"],"models":[],"modelsFromRuntime":true},
        {"slug":"local-vllm","label":"Local vLLM","runtime":"claude","presetSlug":null,"engines":["claude","opencode"],
        "models":[{"value":"qwen3-coder","label":"Qwen3 Coder"}],"defaultModel":"qwen3-coder"}]"""

    /** HPC, with three Claude accounts; [region] as GET /runners carries it, none for a runner that doesn't check. */
    private fun hpc(region: String?) {
        ComposerShell.runner = ComposerShell.obj("""{"id":"${ComposerShell.RUNNER}","name":"workstation-gpu","displayName":"HPC","online":true,
            "status":"ONLINE","version":"0.1.240","capabilities":["claude-region/v1","claude-account-move/v1"],
            "engines":[{"engine":"claude","installed":true,"auth":"yes","version":"2.1.302 (Claude Code)","accounts":[
              {"id":"default","name":"Personal","auth":"yes"},{"id":"3c5e8a10","name":"Work","auth":"yes"},{"id":"8f21b6d4","name":"Team","auth":"yes"}]},
              {"engine":"codex","installed":true,"auth":"yes"}],
            "modelCatalog":{"claude":[{"value":"claude-opus-5-5","label":"Opus 5.5"}],"codex":[{"value":"gpt-6","label":"GPT-6"}]}
            ${region?.let { ""","region":$it""" } ?: ""}}""")
    }

    /** The session as the server holds it: queued, with the refusal as its error, and its transcript board 03's — the first exchange, the
     * second message and the runner's own error event for the refusal. */
    private fun held(region: String? = blocked(), error: String = refusal) {
        hpc(region)
        ComposerShell.providers = keys
        ComposerShell.session = ComposerShell.fields("""{"title":"Fix the flaky login test","status":"PENDING","runStatus":"PENDING","runState":"QUEUED",
            "engine":"claude","provider":"claude","assignedRunner":{"id":"${ComposerShell.RUNNER}","name":"workstation-gpu","displayName":"HPC","version":"0.1.240"}}""") +
            ("error" to JsonPrimitive(error))
        ComposerShell.events = listOf(
            ComposerShell.obj("""{"type":"user","seq":1,"turnId":"t1","payload":{"text":"The login test fails about one run in five. Find out why and fix it."}}"""),
            ComposerShell.obj("""{"type":"assistant","seq":2,"turnId":"t1","payload":{"text":"I replaced the sleep with a wait on the cookie itself."}}"""),
            ComposerShell.obj("""{"type":"turn_end","seq":3,"turnId":"t1","payload":{"subtype":"success"}}"""),
            ComposerShell.obj("""{"type":"user","seq":4,"turnId":"t2","payload":{"text":"Now do the same for the sign-up test."}}"""),
            buildJsonObject { put("type", "error"); put("seq", 5); put("turnId", "t2"); putJsonObject("payload") { put("message", error) } })
    }

    private fun textOf(tag: String) = compose.onNodeWithTag(tag, useUnmergedTree = true).fetchSemanticsNode()
        .config.getOrNull(SemanticsProperties.Text)?.joinToString("") { it.text }
    private fun press(kind: String) = hasTestTag("session-run-start:$kind")
    private val checkLine get() = "Checked ${ClaudeRegion.checkTime(checkedAt, System.currentTimeMillis(), ZoneId.systemDefault())} · " +
        "Claude’s connection: mainland China (no proxy)"

    private fun openHeld() {
        signIn(); openSession()
        awaitText("Claude Code can’t use Anthropic on HPC")
        await { has(press("CHECK_AGAIN")) && has(press("OTHER_PROVIDER")) }
    }

    @Test fun theCardSaysWhyAndWhereAndOffersItsThreeWaysOut() {
        held(); openHeld()
        assertTrue(shows("This run never started"))
        assertEquals("HPC’s connection to Anthropic is in mainland China, where Anthropic doesn’t offer Claude. Supported regions",
            textOf("session-run-start:body"))
        assertEquals("CLAUDE_REGION_UNSUPPORTED · CN", textOf("session-run-start:line:0"))
        assertEquals(checkLine, textOf("session-run-start:line:1"))
        assertTrue(shows("No engine ran · your message is still here"))
        // In the card's order — Use another provider first, the press the card wants — each with its words.
        val presses = listOf("OTHER_PROVIDER", "MOVE_SESSION", "CHECK_AGAIN").map { compose.onNode(press(it)).fetchSemanticsNode() }
        assertEquals(listOf("Use another provider", "Move to another machine", "Check again"),
            presses.map { node -> node.config.getOrNull(SemanticsProperties.Text)?.joinToString("") { it.text } })
        val (first, second, third) = presses.map { it.boundsInRoot }
        assertTrue("reading order", first.top < third.top || (first.top == third.top && first.left < third.left))
        assertTrue(first.left <= second.left || first.top < second.top)
        // The refusal draws no line of its own, and its turn is no turn that ended without a reply.
        assertFalse("no coded sentence anywhere", has(hasText("CLAUDE_REGION_UNSUPPORTED:", substring = true), unmerged = true))
        assertFalse(has(hasText("This turn ended without a reply", substring = true), unmerged = true))
        assertTrue("the waiting message stays", shows("Now do the same for the sign-up test."))
    }

    /** Wrapped, never cut: the check line takes two lines on a phone (the review of the iOS task). */
    @Test @GraphicsMode(GraphicsMode.Mode.NATIVE) fun theCheckLineWrapsOnAPhone() {
        held(); openHeld()
        assertEquals(checkLine, textOf("session-run-start:line:1"))
        val subject = compose.onNodeWithTag("session-run-start:line:0", useUnmergedTree = true).fetchSemanticsNode().size.height
        val checked = compose.onNodeWithTag("session-run-start:line:1", useUnmergedTree = true).fetchSemanticsNode().size.height
        assertTrue("the check line is two lines tall: $checked against $subject", checked > subject * 1.5)
    }

    @Test fun checkAgainAsksTheRunnerAndReadsItAgain() {
        held()
        ComposerShell.answers["POST runners/${ComposerShell.RUNNER}/region-check"] = {
            // The runner's next check lands in its region, still blocked.
            hpc(blocked(Instant.now().plusSeconds(1).toString()))
            ApiResponse(200, """{"requestedAt":"${Instant.now()}"}""".encodeToByteArray())
        }
        openHeld()
        compose.onNode(press("CHECK_AGAIN") and isEnabled()).performClick()
        await { ComposerShell.calls.contains("POST runners/${ComposerShell.RUNNER}/region-check") }
        val asked = ComposerShell.calls.indexOf("POST runners/${ComposerShell.RUNNER}/region-check")
        await { ComposerShell.calls.drop(asked + 1).contains("GET runners") }
        await { has(press("CHECK_AGAIN") and isEnabled()) }
    }

    @Test fun useAnotherProviderListsWhatCanRunHereAndMovesTheSessionsCredential() {
        held(); openHeld()
        compose.onNode(press("OTHER_PROVIDER")).performClick()
        await { has(hasTestTag("session-run-start:providers")) }
        assertTrue(shows("Use another provider"))
        assertEquals(listOf("deepseek", "local-vllm"), compose.onAllNodes(hasTestTagStartingWith("session-run-start:provider:"))
            .fetchSemanticsNodes().map { it.config[SemanticsProperties.TestTag].removePrefix("session-run-start:provider:") })
        assertFalse("no Anthropic credential", shows("Personal Max") || shows("Work"))
        compose.onNodeWithTag("session-run-start:provider:deepseek").performClick()
        await { ComposerShell.body("PATCH sessions/${ComposerShell.SESSION}/config") != null }
        val pick = ComposerShell.body("PATCH sessions/${ComposerShell.SESSION}/config")!!
        assertEquals("deepseek", pick["provider"]?.jsonPrimitive?.content)
        assertEquals("the engine stays", "claude", pick["engine"]?.jsonPrimitive?.content)
        // Nothing is in flight: the waiting message runs on the pick.
        awaitText("Your next message uses DeepSeek.")
        assertFalse(has(hasText("The turn in flight", substring = true)))
    }

    @Test fun moveToAnotherMachineOpensTheSessionsMove() {
        held(); openHeld()
        compose.onNode(press("MOVE_SESSION")).performClick()
        awaitText("Move session")
    }

    @Test fun theProviderMenuMarksAnthropicCredentialsAndNamesNoFix() {
        held(); openHeld()
        openModelMenu()
        await { shows("Personal Max — Region not supported") }
        val lines = dialogLines()
        assertTrue(lines.toString(), "Work — Region not supported" in lines)
        assertTrue(lines.toString(), "DeepSeek" in lines && "Local vLLM" in lines)
        assertTrue("the sign-in is on HPC, signed in or not", "On HPC" in lines)
        assertFalse("no fix is named", lines.any { it.contains("Region not supported") && it.contains("→") })
        assertFalse("no Claude account is offered under the sign-in", lines.any { it.startsWith("Automatic") || it == "Team" })
    }

    @Test fun theSessionListSaysAnthropicIsUnavailableOnTheMachine() {
        held(); signIn()
        await { has(hasText("Alpha") and hasClickAction()) }
        compose.onAllNodes(hasText("Alpha") and hasClickAction())[0].performClick()
        await { has(hasTestTag("session-state:${ComposerShell.SESSION}"), unmerged = true) }
        assertEquals("Anthropic unavailable on HPC", textOf("session-state:${ComposerShell.SESSION}"))
    }

    /** A runner that reads no region: the card keeps the server's words without the code, the bare code and no check line, and offers no
     * Check again; the Provider menu lists what it lists today. */
    @Test fun aRunnerThatReadsNoRegionDrawsWhatItDrawsToday() {
        held(region = null)
        signIn(); openSession()
        awaitText("Claude Code can’t use Anthropic on HPC")
        await { has(press("OTHER_PROVIDER")) }
        assertEquals("HPC’s connection to Anthropic is in mainland China, where Anthropic doesn’t offer Claude. Supported regions",
            textOf("session-run-start:body"))
        assertEquals("CLAUDE_REGION_UNSUPPORTED", textOf("session-run-start:line:0"))
        assertFalse(has(hasTestTag("session-run-start:line:1"), unmerged = true))
        assertFalse("only where the runner checks at all", has(press("CHECK_AGAIN")))
        openModelMenu()
        await { shows("Personal Max") }
        assertFalse(has(hasText("Region not supported", substring = true)))
    }

    /** An ordinary queued session on that runner keeps its words in the list. */
    @Test fun anotherQueuedSessionStaysQueued() {
        hpc(blocked())
        ComposerShell.session = ComposerShell.fields("""{"status":"PENDING","runStatus":"PENDING","runState":"QUEUED"}""")
        signIn()
        await { has(hasText("Alpha") and hasClickAction()) }
        compose.onAllNodes(hasText("Alpha") and hasClickAction())[0].performClick()
        await { has(hasTestTag("session-state:${ComposerShell.SESSION}"), unmerged = true) }
        assertEquals("Queued", textOf("session-state:${ComposerShell.SESSION}"))
    }

    private fun hasTestTagStartingWith(prefix: String) = SemanticsMatcher("test tag starts with $prefix") {
        it.config.getOrNull(SemanticsProperties.TestTag)?.startsWith(prefix) == true
    }
}
