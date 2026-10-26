package io.orbitd.android.increments

import androidx.compose.ui.test.*
import androidx.test.ext.junit.runners.AndroidJUnit4
import java.time.Instant
import okhttp3.mockwebserver.MockResponse
import org.junit.Test
import org.junit.runner.RunWith

/**
 * A13 and A01b increments on Settings → Machines & models, over the test's own fixture: the page's footers in the web's words
 * (A01b I-PROVIDERS-COPY), and a runner whose Codex Default account is removed from Orbit and used again (A01d A13-22). The shapes are
 * the management JVM tests' (ManagementFixture, RemoveDefaultPageTest, ManagementPanelTest).
 */
@RunWith(AndroidJUnit4::class)
class ManagementIncrementsDeviceTest : IncrementDeviceTest() {
    private val machine = "34A15cRunnerWikova0001"
    override val ids get() = listOf(workspace, runner, machine)

    /** Whether Codex's Default is in use on the machine (A13-22). */
    @Volatile private var defaultInUse = true
    /** The Work account's name, as the server keeps it (A01b I-ENG-RENAME). */
    @Volatile private var workName = "Work"

    private fun engines() = if (defaultInUse) """[{"engine":"codex","installed":true,"version":"codex-cli 0.158.0","auth":"yes","accounts":[
        {"id":"default","home":"/root/.codex","codexHome":"/root/.codex","auth":"yes"},
        {"id":"3fa91c2e","name":"$workName","home":"/root/.orbit/codex-accounts/3fa91c2e","auth":"yes"},
        {"id":"7c21de40","name":"Personal","home":"/root/.orbit/codex-accounts/7c21de40","auth":"yes"}]}]"""
        else """[{"engine":"codex","installed":true,"version":"codex-cli 0.158.0","auth":"yes","accounts":[
        {"id":"3fa91c2e","name":"$workName","home":"/root/.orbit/codex-accounts/3fa91c2e","auth":"yes"},
        {"id":"7c21de40","name":"Personal","home":"/root/.orbit/codex-accounts/7c21de40","auth":"yes"}],
        "removedDefault":{"home":"/root/.codex","fingerprintPrefix":"cxa1_2b7e9013"}}]"""
    private fun machineJson() = """{"id":"$machine","name":"box","displayName":"wikova","hostname":"box-01","version":"0.1.262","online":true,
        "status":"ONLINE","lastHeartbeatAt":"${Instant.now()}","maxConcurrent":2,"activeSessions":0,"runsAsRoot":false,"minFreeDiskMb":null,
        "selfUpdate":null,"capabilities":["codex-account-remove/v1","os:linux"],"engines":${engines()},
        "planUsage":{"codex":{"provider":"codex",${if (defaultInUse) "\"primary\":{\"utilization\":62,\"windowDurationMins\":300}," else ""}
        "accounts":{"3fa91c2e":{"provider":"codex","primary":{"utilization":8,"windowDurationMins":300}},
        "7c21de40":{"provider":"codex","primary":{"utilization":30,"windowDurationMins":300}}}}},"enrolledAt":"2026-09-01T00:00:00Z"}"""
    override fun runnerJson() = machineJson()
    override fun workspaceJson() = """{"id":"$workspace","name":"Alpha","runnerId":"$machine","enabled":true,"position":0,
        "provider":"codex","model":"gpt-6","createdAt":"2026-10-01T01:00:00.000Z"}"""

    override fun answer(req: Req): MockResponse? = when {
        req.path == "runners" -> json("[${machineJson()}]")
        req.path == "runners/$machine" -> json(machineJson())
        req.path == "runners/$machine/accounts/codex/default" && req.method == "DELETE" -> {
            defaultInUse = false
            json("""{"engine":"codex","account":"default","status":"done","message":null}""")
        }
        req.path == "runners/$machine/accounts/codex/3fa91c2e" && req.method == "PATCH" -> {
            kotlinx.serialization.json.Json.parseToJsonElement(req.body).let { it as kotlinx.serialization.json.JsonObject }["name"]
                ?.let { workName = (it as kotlinx.serialization.json.JsonPrimitive).content }
            json("""{"ok":true}""")
        }
        req.path == "runners/$machine/accounts/codex/default/restore" && req.method == "POST" -> {
            defaultInUse = true
            json("""{"ok":true}""")
        }
        req.path == "providers/mine" -> json("""[{"id":"K1","slug":"deepseek","label":"DeepSeek","runtime":"claude","presetSlug":"deepseek",
            "baseUrl":"https://api.deepseek.com/anthropic","hasApiKey":true,"defaultModel":"deepseek-chat","engines":["claude","opencode","dsh"]}]""")
        req.path == "providers" -> json("""[{"slug":"deepseek","label":"DeepSeek","runtime":"claude","defaultModel":"deepseek-chat"}]""")
        req.path == "providers/pools" -> json("""[{"id":"P2","slug":"claude-pool","label":"Claude pool","engine":"claude","members":[
            {"id":"m1","slug":"anthropic-a","label":"Anthropic A","state":"AVAILABLE","next":true,"enabled":true,"planUsage":{"fiveHour":{"utilization":20}}}]}]""")
        req.path == "providers/shared-pools" -> json("[]")
        req.path.startsWith("providers/mine/") && req.path.endsWith("/balance") -> json("""{"ok":true,"isAvailable":true,"fetchedAt":"${Instant.now()}",
            "sharedWith":[],"balances":[{"currency":"CNY","totalBalance":"110.00","grantedBalance":"10.00","toppedUpBalance":"100.00"}]}""")
        else -> null
    }

    private fun machinesAndModels() {
        signIn()
        compose.onAllNodesWithContentDescription("Open navigation").onFirst().performClick()
        compose.onNode(hasText("Settings") and hasClickAction()).performClick()
        await("Settings") { exists(hasText("Machines & models") and hasClickAction()) }
        compose.onNode(hasText("Machines & models") and hasClickAction()).performScrollTo().performClick()
        await("Machines & models") { exists(hasText("wikova"), unmerged = true) }
    }
    private fun scrollTo(text: String) = runCatching {
        compose.onAllNodes(hasScrollAction()).onFirst().performScrollToNode(hasText(text, substring = true))
    }

    /** A01b I-PROVIDERS-COPY: the page's footers say what the web says now, and the old Providers words are gone. */
    @Test fun machinesAndModelsFootersSayWhatTheWebSays() = journey {
        machinesAndModels()
        val footers = listOf("Subscriptions signed in here are spent only by sessions on that machine.",
            "Several accounts under one name.",
            "On your account and usable from every machine — billed per token. Adding or changing a key happens on the web.",
            "Every engine, and everything that can pay for it right now.")
        for (footer in footers) {
            scrollTo(footer)
            await("the footer “$footer”") { exists(hasText(footer, substring = true), unmerged = true) }
        }
        capture("01-footers")
        for (gone in listOf("On your runners", "Use subscriptions signed in on your machines.", "Your API keys", "nothing to paste")) {
            scrollTo(gone)
            verify("the old words “$gone” are gone", !exists(hasText(gone, substring = true), unmerged = true))
        }
    }

    private fun codexAccounts() {
        machinesAndModels()
        compose.onAllNodes(hasText("wikova") and hasClickAction()).onFirst().performClick()
        await("the machine's page") { exists(hasText("Codex") and hasClickAction()) }
        compose.onAllNodes(hasText("Codex") and hasClickAction()).onFirst().performScrollTo().performClick()
        await("Codex's accounts") { exists(hasContentDescription("More for Default")) }
    }

    /** A01b I-ENG-RENAME: an account is renamed in a dialog that is a field with Save and Cancel and no explanatory sentence; Save
     * writes the trimmed name, and the row shows the server's. */
    @Test fun anAccountIsRenamedInADialogWithoutAnExplanation() = journey {
        codexAccounts()
        compose.onNode(hasContentDescription("More for Work")).performScrollTo().performClick()
        await("Rename… for Work") { exists(hasText("Rename…") and hasClickAction()) }
        compose.onNode(hasText("Rename…") and hasClickAction()).performClick()
        await("the rename dialog") { exists(hasText("Rename Account")) }
        val dialog = hasAnyAncestor(isDialog())
        val words = compose.onAllNodes(dialog and SemanticsMatcher("has text") { it.config.contains(androidx.compose.ui.semantics.SemanticsProperties.Text) },
            useUnmergedTree = true).fetchSemanticsNodes().flatMap { it.config[androidx.compose.ui.semantics.SemanticsProperties.Text].map { t -> t.text } }
        note("the dialog's words: $words")
        verify("the dialog says no more than its title, the name and its two buttons", words.toSet() - setOf("Rename Account", "Work", "Save", "Cancel") == emptySet<String>())
        capture("01-rename-dialog")
        compose.onNode(dialog and hasSetTextAction()).performTextReplacement("  Work laptop  ")
        compose.onNode(dialog and hasText("Save") and hasClickAction()).performClick()
        await("the name is written, trimmed") { bodies.any { it.first == "PATCH runners/$machine/accounts/codex/3fa91c2e" &&
            (kotlinx.serialization.json.Json.parseToJsonElement(it.second) as kotlinx.serialization.json.JsonObject)["name"]?.let { n ->
                (n as kotlinx.serialization.json.JsonPrimitive).content } == "Work laptop" } }
        await("the row shows the server's name") { exists(hasContentDescription("More for Work laptop")) }
        capture("02-renamed")
    }

    /** A01d A13-22: Codex's Default is removed from Orbit (asked first, its sign-in kept on the machine) and used again. */
    @Test fun theRunnersDefaultAccountIsRemovedFromOrbitAndUsedAgain() = journey {
        codexAccounts()
        capture("01-codex-accounts")
        compose.onNode(hasContentDescription("More for Default")).performScrollTo().performClick()
        await("Remove… for Default") { exists(hasText("Remove…") and hasClickAction()) }
        compose.onNode(hasText("Remove…") and hasClickAction()).performClick()
        await("the confirmation") { exists(hasText("Remove Default?")) }
        verify("it says the sign-in stays on the machine", exists(hasText("Its sign-in stays on the machine", substring = true)))
        capture("02-remove-default-asks")
        compose.onNode(hasText("Remove") and hasClickAction() and hasAnyAncestor(isDialog())).performClick()
        await("the removal is asked of the runner") { calls.any { it == "DELETE runners/$machine/accounts/codex/default" } }
        await("Default is no longer Orbit's") { exists(hasTestTag("removed-default"), unmerged = true) }
        verify("the line says where it lives", says("removed-default", "Default · ~/.codex isn’t used by Orbit", substring = true))
        capture("03-removed-default")
        compose.onNode(hasText("Use again") and hasClickAction()).performScrollTo().performClick()
        await("Use again asks the server") { calls.any { it == "POST runners/$machine/accounts/codex/default/restore" } }
        verify("with an empty body", bodies.last { it.first == "POST runners/$machine/accounts/codex/default/restore" }.second.trim() in setOf("{}", ""))
        await("Default is back") { !exists(hasTestTag("removed-default"), unmerged = true) && exists(hasContentDescription("More for Default")) }
        capture("04-default-used-again")
    }
}
