package io.orbitd.android.increments

import androidx.compose.ui.test.*
import androidx.test.ext.junit.runners.AndroidJUnit4
import java.time.Instant
import okhttp3.mockwebserver.MockResponse
import org.junit.Test
import org.junit.runner.RunWith

/**
 * The Claude region check on a device (docs/claude-region-check-contract.md, board 03; the iOS task's probe, `stub.py`), over the test's
 * own fixture: one machine, HPC, whose Claude connection comes out in mainland China (`region` blocked, claude-region/v1), with Claude
 * Code on three accounts, Codex, Kimi Code and Antigravity CLI; "Fix the flaky login test" held in the queue with the refusal as its error,
 * board 03's transcript, and board 02 C's keys. Each journey leaves the screenshot set beside board 03's iPhone frames: the card over the
 * held message (1), after Check again (2), Use another provider and its pick (3), Move (4), the Provider menu (5), the session list (6),
 * the machine page (7) and Claude Code's page (8).
 */
@RunWith(AndroidJUnit4::class)
class ClaudeRegionDeviceTest : IncrementDeviceTest() {
    // Public ids: 22 Base62 characters (ObjectId.canonical), so a link to one opens it.
    private val held = "34RgnHeldSessionFlaky1"
    private val wiki = "34RgnWikiSearchSession"
    private val go = "34RgnGoToolchainSessn1"
    private val elsewhere = "34RgnWorkspaceWikova01"
    override val ids get() = listOf(workspace, runner, held, wiki, go, elsewhere)

    /** When HPC's region was last checked: two minutes before the run, until Check again records a check of its own. */
    @Volatile private var checkedAt = ago(2)
    /** The held session's provider, as Use another provider's pick writes it. */
    @Volatile private var provider = "claude"

    private val refusal = "CLAUDE_REGION_UNSUPPORTED: HPC’s connection to Anthropic is in mainland China, where Anthropic doesn’t offer Claude."

    override fun workspaceJson() = """{"id":"$workspace","name":"orbit-develop","runnerId":"$runner","enabled":true,"position":0,
        "provider":"claude","lastProvider":"claude","lastEngine":"claude","model":"claude-opus-5-5","createdAt":"2026-10-01T01:00:00.000Z"}"""

    private fun updated() = """{"status":"ok","at":"${ago(2)}","okAt":"${ago(2)}"}"""
    override fun runnerJson() = """{"id":"$runner","name":"workstation-gpu","displayName":"HPC","hostname":"workstation","online":true,
        "status":"ONLINE","version":"0.1.240","lastHeartbeatAt":"${Instant.now()}","maxConcurrent":16,"activeSessions":5,"runsAsRoot":true,
        "minFreeDiskMb":null,"enrolledAt":"2026-07-01T00:00:00Z","capabilities":["claude-region/v1","claude-account-move/v1","codex-account-move/v1"],
        "region":{"verdict":"blocked","country":"CN","regionCode":null,"name":"mainland China","viaProxy":false,"checkedAt":"$checkedAt"},
        "antigravity":{"supported":true,"installed":true,"version":"1.3.4","googleLogin":"available","authSource":"google","envKeyAvailable":false},
        "engines":[{"engine":"claude","installed":true,"version":"2.1.302 (Claude Code)","auth":"yes","update":${updated()},"accounts":[
            {"id":"default","name":"Personal","home":"/root/.claude","auth":"yes"},
            {"id":"3c5e8a10","name":"Work","home":"/root/.orbit/claude-accounts/3c5e8a10","auth":"yes"},
            {"id":"8f21b6d4","name":"Team","home":"/root/.orbit/claude-accounts/8f21b6d4","auth":"yes"}]},
          {"engine":"codex","installed":true,"version":"codex-cli 0.164.0","auth":"yes","update":${updated()}},
          {"engine":"kimi","installed":true,"version":"2.1.4","auth":"yes","update":${updated()}},
          {"engine":"antigravity","installed":true,"version":"1.3.4","auth":"yes","authSource":"google","update":${updated()}}],
        "planUsage":{"claude":{"provider":"claude","fiveHour":{"utilization":66,"resetsAt":"${Instant.now().plusSeconds(10_800)}"}},
          "codex":{"provider":"codex","primary":{"utilization":12,"resetsAt":"${Instant.now().plusSeconds(35_400)}","windowDurationMins":300}}},
        "modelCatalog":{"claude":[{"value":"claude-opus-5-5","label":"Opus 5.5","reasoningLevels":["low","medium","high","max"]}],
          "codex":[{"value":"gpt-5.6-sol","label":"GPT-5.6 Sol"}]},
        "runtimeDefaultModels":{"claude":"claude-opus-5-5","codex":"gpt-5.6-sol"}}"""

    /** Board 02 C's keys: DeepSeek, Personal Max and Work (Anthropic), Local vLLM. */
    private val providers = """[{"slug":"deepseek","label":"DeepSeek","runtime":"claude","presetSlug":"deepseek","engines":["claude","opencode","dsh"],
        "models":[{"value":"deepseek-v4.1-flash","label":"DeepSeek V4.1 Flash"}],"defaultModel":"deepseek-v4.1-flash","runsOnOpenCode":true},
        {"slug":"anthropic","label":"Personal Max","runtime":"claude","presetSlug":"anthropic","engines":["claude"],"models":[],"modelsFromRuntime":true},
        {"slug":"anthropic-2","label":"Work","runtime":"claude","presetSlug":"anthropic","engines":["claude"],"models":[],"modelsFromRuntime":true},
        {"slug":"local-vllm","label":"Local vLLM","runtime":"claude","presetSlug":null,"engines":["claude","opencode"],
        "models":[{"value":"qwen3-coder","label":"Qwen3 Coder"}],"defaultModel":"qwen3-coder","runsOnOpenCode":true}]"""

    private val titles = mapOf(held to "Fix the flaky login test", wiki to "Wiki search: highlight matches", go to "Go 1.27 for the runner")
    private val replies = mapOf(held to "The test waits a fixed **500 ms** for the session cookie, and the token refresh sometimes takes longer " +
        "under load. I replaced the sleep with a wait on the cookie itself.", wiki to "Done — matches are highlighted in titles and in the body excerpt.",
        go to "Bumped to Go 1.27, and the runner's tests pass.")
    private val lastTurn = mapOf(held to ago(3), wiki to ago(84), go to ago(290))

    /** A session's row: the held one queued with the refusal (§9, §10), the others parked. */
    private fun detail(id: String): String {
        val heldHere = id == held
        val status = if (heldHere) "PENDING" else "AWAITING_INPUT"
        return """{"id":"$id","title":${quote(titles.getValue(id))},"status":"$status","runStatus":"$status",
            "runState":"${if (heldHere) "QUEUED" else "AWAITING_INPUT"}","lifecycleState":"OPEN","agentId":"$workspace",
            "agent":{"id":"$workspace","name":"orbit-develop"},"assignedRunnerId":"$runner",
            "assignedRunner":{"id":"$runner","name":"workstation-gpu","displayName":"HPC","version":"0.1.240"},
            "engine":"claude","provider":"${if (heldHere) provider else "claude"}","model":"claude-opus-5-5","effort":"high","permissionMode":"default",
            "createdAt":"${ago(400)}","lastTurnAt":"${lastTurn.getValue(id)}","pendingApprovals":0,"tags":[],
            "capabilities":{"canSend":true,"canResume":false,"canComplete":true},"lastAssistantText":${quote(replies.getValue(id))}
            ${if (heldHere) ",\"error\":${quote(refusal)}" else ""}}"""
    }
    override fun sessions(view: String, project: String?) = if (view == "open") "[${detail(held)},${detail(wiki)},${detail(go)}]" else "[]"

    /** Board 03's transcript: the first exchange, the second message, and the runner's own error event for the refusal. */
    private fun events() = listOf(
        event(1, "user", """{"text":"The login test fails about one run in five. Find out why and fix it."}""", ago(40), "t1"),
        event(2, "assistant", """{"text":${quote(replies.getValue(held))}}""", ago(36), "t1"),
        event(3, "turn_end", """{"subtype":"success"}""", ago(36), "t1"),
        event(4, "user", """{"text":"Now do the same for the sign-up test."}""", ago(3), "t2"),
        event(5, "error", """{"message":${quote(refusal)}}""", ago(3), "t2"))

    override fun answer(req: Req): MockResponse? = when {
        req.path == "sessions/$held" && req.method == "GET" -> json(detail(held))
        req.path == "sessions/$held/events/page" -> json(page(events()))
        req.path == "sessions/$held/turns" && req.method == "GET" -> json("[]")
        req.path == "sessions/$held/config" && req.method == "PATCH" -> {
            Regex("\"provider\":\"([^\"]+)\"").find(req.body)?.let { provider = it.groupValues[1] }
            json(detail(held))
        }
        req.path == "sessions/$held/move-targets" -> json("""{"workspaceId":"$workspace","folderId":null,"folders":[],"reason":null,"needsEnd":false,
            "targets":[{"workspaceId":"$elsewhere","name":"orbit-prod · wikova","runnerOnline":true,"folders":[]}]}""")
        req.path == "runners/$runner/region-check" && req.method == "POST" -> {
            val at = Instant.now().toString()
            // The runner checks at once; its answer lands in the region, still blocked.
            checkedAt = at
            json("""{"requestedAt":"$at"}""")
        }
        req.path == "providers" -> json(providers)
        req.path == "providers/pools" || req.path == "providers/shared-pools" -> json("[]")
        else -> null
    }

    private fun openHeld() {
        signIn()
        open("orbit-session:$held")
        await("the held session's card") {
            exists(hasTestTag("session-run-start:why"), unmerged = true) && exists(hasTestTag("session-run-start:CHECK_AGAIN")) &&
                exists(hasTestTag("session-run-start:OTHER_PROVIDER")) && exists(hasTestTag("session-run-start:MOVE_SESSION"))
        }
    }
    private fun height(tag: String) = compose.onNodeWithTag(tag, useUnmergedTree = true).fetchSemanticsNode().size.height

    /** (1) The card over the held message, word for word, its lines whole. */
    @Test fun theCardOverTheHeldMessage() = journey {
        openHeld()
        verify("the why", textOf("session-run-start:why") == "Claude Code can’t use Anthropic on HPC")
        verify("the body and its link", textOf("session-run-start:body") ==
            "HPC’s connection to Anthropic is in mainland China, where Anthropic doesn’t offer Claude. Supported regions")
        verify("the subject", textOf("session-run-start:line:0") == "CLAUDE_REGION_UNSUPPORTED · CN")
        val checked = textOf("session-run-start:line:1")
        verify("the check line: $checked", checked.startsWith("Checked ") && checked.endsWith(" · Claude’s connection: mainland China (no proxy)"))
        verify("the check line wraps, never cut", height("session-run-start:line:1") > height("session-run-start:line:0") * 3 / 2)
        verify("the foot", exists(hasText("No engine ran · your message is still here"), unmerged = true))
        verify("no coded sentence anywhere", !exists(hasText("CLAUDE_REGION_UNSUPPORTED:", substring = true), unmerged = true))
        verify("the waiting message stays", exists(hasText("Now do the same for the sign-up test."), unmerged = true))
        capture("1-card")
        // Where the card stands in the screenshot, for its close-up (kit/compose.py).
        val card = compose.onNodeWithTag("session-run-start", useUnmergedTree = true).fetchSemanticsNode().boundsInWindow
        java.io.File(evidence, "card-band.txt").writeText("${card.left} ${card.top} ${card.right} ${card.bottom}\n")
    }

    /** (2) Check again posts, and the check line moves to the check it asked for. */
    @Test fun checkAgainOnTheCard() = journey {
        openHeld()
        val before = textOf("session-run-start:line:1")
        compose.onNodeWithTag("session-run-start:CHECK_AGAIN").performClick()
        await("Check again's POST") { calls.contains("POST runners/$runner/region-check") }
        await("the check line moved") { textOf("session-run-start:line:1").let { it != before && it.startsWith("Checked ") } }
        await("the press is back") { exists(hasTestTag("session-run-start:CHECK_AGAIN") and isEnabled()) }
        capture("2-card-after-check-again")
    }

    /** (3) Use another provider lists what can run Claude Code here, and DeepSeek takes the waiting message. */
    @Test fun useAnotherProvider() = journey {
        openHeld()
        compose.onNodeWithTag("session-run-start:OTHER_PROVIDER").performClick()
        await("the credentials") { exists(hasTestTag("session-run-start:providers")) }
        verify("DeepSeek and Local vLLM, and no Anthropic credential", exists(hasTestTag("session-run-start:provider:deepseek")) &&
            exists(hasTestTag("session-run-start:provider:local-vllm")) && count(hasTestTag("session-run-start:provider:anthropic")) == 0 &&
            count(hasTestTag("session-run-start:provider:anthropic-2")) == 0)
        capture("3-use-another-provider")
        compose.onNodeWithTag("session-run-start:provider:deepseek").performClick()
        await("the pick's PATCH") { bodies.any { it.first == "PATCH sessions/$held/config" && it.second.contains("\"deepseek\"") } }
        awaitText("Your next message uses DeepSeek.")
        verify("nothing in flight", !exists(hasText("The turn in flight", substring = true), unmerged = true))
        capture("3b-after-deepseek")
    }

    /** (4) Move to another machine opens the session's Move. */
    @Test fun moveToAnotherMachine() = journey {
        openHeld()
        compose.onNodeWithTag("session-run-start:MOVE_SESSION").performClick()
        awaitText("Move session")
        awaitText("orbit-prod · wikova")
        capture("4-move")
    }

    /** (5) The composer's Provider menu: the Anthropic credentials Region not supported, naming no fix; no Claude accounts. */
    @Test fun theProviderMenu() = journey {
        openHeld()
        compose.onNodeWithTag("composer-model").performClick()
        await("the Provider part") { exists(hasText("Personal Max — Region not supported"), unmerged = true) }
        verify("Work too", exists(hasText("Work — Region not supported"), unmerged = true))
        verify("no fix named", !exists(hasText("Region not supported →", substring = true), unmerged = true))
        verify("no Claude accounts under the sign-in", !exists(hasText("Automatic", substring = true) and hasAnyAncestor(isDialog()), unmerged = true))
        runCatching { compose.onNode(hasText("Local vLLM") and hasClickAction()).performScrollTo() }
        capture("5-provider-menu")
    }

    /** (6) The session list: Anthropic unavailable on HPC. */
    @Test fun theSessionList() = journey {
        signIn()
        await("the workspace") { exists(hasText("orbit-develop") and hasClickAction()) }
        compose.onAllNodes(hasText("orbit-develop") and hasClickAction()).onFirst().performClick()
        await("the held row's words") { textOf("session-state:$held") == "Anthropic unavailable on HPC" }
        capture("6-session-list")
    }

    private fun machinePage() {
        signIn()
        open("orbit://runner/$runner")
        await("HPC's page") { exists(hasText("Claude Code can’t use Anthropic here"), unmerged = true) }
    }

    /** (7) HPC's page: the attention item with Check Again, Claude Code Region not supported with Check Again, and the note. */
    @Test fun theMachinePage() = journey {
        machinePage()
        verify("the detail", exists(hasText("Anthropic doesn’t offer Claude in mainland China."), unmerged = true))
        verify("Claude Code's row", exists(hasText("2.1.302 · Region not supported"), unmerged = true))
        verify("Check Again on the item and the row", count(hasText("Check Again") and hasClickAction()) == 2)
        verify("Codex untouched", exists(hasText("0.164.0 · Signed in"), unmerged = true))
        capture("7-machine-page")
        // The note and the check line under it, whole.
        compose.onNodeWithTag("claude-region-checked", useUnmergedTree = true).performScrollTo()
        verify("the check line", exists(hasText("Checked 2m ago · Claude’s connection: mainland China (no proxy)"), unmerged = true))
        capture("7b-machine-engines-note")
        compose.onNode(hasTestTag("engine-row:claude:check-again"), useUnmergedTree = true).onChildren().filterToOne(hasClickAction())
            .performScrollTo().performClick()
        await("Check Again's POST") { calls.contains("POST runners/$runner/region-check") }
        await("the check it asked for") { exists(hasText("Checked just now · Claude’s connection: mainland China (no proxy)"), unmerged = true) }
        capture("7c-machine-after-check-again")
    }

    /** (8) Claude Code's page: its accounts as they are, Check Again in Add Account's place, and the note. */
    @Test fun theClaudeCodePage() = journey {
        machinePage()
        compose.onNodeWithTag("engine-row:claude").performScrollTo().performClick()
        await("Claude Code's page") { exists(hasTestTag("engine-page:check-again")) }
        verify("the head", exists(hasText("2.1.302 · ", substring = true) and hasText(" · Region not supported", substring = true), unmerged = true))
        verify("no Add Account", !exists(hasText("Add Account"), unmerged = true))
        verify("its accounts", listOf("Personal", "Work", "Team").all { exists(hasText(it), unmerged = true) })
        capture("8-claude-code-page")
        compose.onNodeWithTag("claude-region-checked", useUnmergedTree = true).performScrollTo()
        capture("8b-claude-code-page-note")
    }
}
