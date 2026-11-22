package io.orbitd.android.management

import android.content.ComponentName
import androidx.activity.ComponentActivity
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import io.orbitd.android.core.auth.AuthState
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.ExternalResource
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

/** The tiers the fixtures serve: the mock's five models (docs/mocks/subagent/05.png) and a pool with no models of its own. */
internal object SubagentFixtures {
    val TIERS = """{"providers":[
        {"slug":"deepseek","label":"DeepSeek","kind":"key","providerId":"${ManagementFixture.KEY_DEEPSEEK}","billing":"key",
          "models":[{"model":"deepseek-chat","levels":["S","M"],"source":"catalogue","editable":false,"outputPricePerMTok":0.6,
            "quality":{"subagent":{"averageRating":3.2,"ratedCount":14,"runCount":30,"raters":[
              {"engine":"claude","provider":"claude","model":"claude-opus-5-5","label":"Opus 5.5","count":10},
              {"engine":"codex","provider":"codex","model":"gpt-5.6-sol","label":null,"count":4}]},
              "tasks":{"firstPassRate":null,"firstPassTaskCount":0,"completedTaskCount":0}}}]},
        {"slug":"claude","label":"Claude","kind":"builtin","providerId":null,"billing":"subscription",
          "models":[{"model":"claude-sonnet-5-5","levels":["S","M"],"source":"catalogue","editable":false,"outputPricePerMTok":null,
              "quality":{"subagent":{"averageRating":null,"ratedCount":3,"runCount":12,"raters":[
                {"engine":"claude","provider":"claude","model":"claude-opus-5-5","label":"Opus 5.5","count":3}]},
                "tasks":{"firstPassRate":null,"firstPassTaskCount":5,"completedTaskCount":6}}},
            {"model":"claude-opus-5-5","levels":["L","XL"],"source":"catalogue","editable":false,"outputPricePerMTok":null,
              "quality":{"subagent":{"averageRating":4.4,"ratedCount":23,"runCount":41,"raters":[
                {"engine":"claude","provider":"claude","model":"claude-opus-5-5","label":"Opus 5.5","count":15},
                {"engine":"claude","provider":"claude","model":"claude-sonnet-5-5","label":"Sonnet 5.5","count":8}]},
                "tasks":{"firstPassRate":0.86,"firstPassTaskCount":45,"completedTaskCount":52}}}]},
        {"slug":"codex","label":"Codex","kind":"builtin","providerId":null,"billing":"subscription",
          "models":[{"model":"gpt-5.6-sol","levels":["S","M","L","XL"],"source":"catalogue","editable":false,"outputPricePerMTok":null}]},
        {"slug":"my-endpoint","label":"My endpoint","kind":"key","providerId":"${ManagementFixture.KEY_OPENAI}","billing":"key",
          "models":[{"model":"qwen-coder","levels":[],"source":null,"editable":true,"outputPricePerMTok":null}]},
        {"slug":"kimi","label":"Kimi","kind":"builtin","providerId":null,"billing":"subscription","models":[]},
        {"slug":"team-codex","label":"Team Codex","kind":"pool","providerId":null,"billing":"subscription","models":[]}]}"""

    /** A built-in engine's whole catalogue, every model the owner's to tier (board 2026-11-20): a family's tiers, grok-4.7 tiered by
     *  the owner, the rest Not set. */
    val BUILTIN = """{"providers":[
        {"slug":"cursor","label":"Cursor","kind":"builtin","providerId":null,"billing":"subscription",
          "models":[{"model":"claude-opus-5-6","levels":["L","XL"],"source":"catalogue","editable":true,"outputPricePerMTok":null},
            {"model":"composer-2.5","levels":["S"],"source":"catalogue","editable":true,"outputPricePerMTok":null},
            {"model":"grok-4.7","levels":["L"],"source":"owner","editable":true,"outputPricePerMTok":null},
            {"model":"kimi-k3","levels":[],"source":null,"editable":true,"outputPricePerMTok":null}]},
        {"slug":"my-endpoint","label":"My endpoint","kind":"key","providerId":"${ManagementFixture.KEY_OPENAI}","billing":"key",
          "models":[{"model":"qwen-coder","levels":["M"],"source":"owner","editable":true,"outputPricePerMTok":null}]}]}"""

    /** Cursor's catalogue with older family members: they read "Older · uses <newest>" after the tiered rows, before Not set. */
    val OLDER = """{"providers":[
        {"slug":"cursor","label":"Cursor","kind":"builtin","providerId":null,"billing":"subscription",
          "models":[{"model":"claude-opus-5-5","levels":["L","XL"],"source":"catalogue","editable":true,"outputPricePerMTok":null},
            {"model":"gemini-4-neon","levels":["L","XL"],"source":"catalogue","editable":true,"outputPricePerMTok":null},
            {"model":"claude-opus-5","levels":[],"source":null,"editable":true,"outputPricePerMTok":null,"supersededBy":"claude-opus-5-5"},
            {"model":"claude-opus-4-8","levels":[],"source":null,"editable":true,"outputPricePerMTok":null,"supersededBy":"claude-opus-5-5"},
            {"model":"gemini-4-argon","levels":[],"source":null,"editable":true,"outputPricePerMTok":null,"supersededBy":"gemini-4-neon"},
            {"model":"grok-4.7","levels":[],"source":null,"editable":true,"outputPricePerMTok":null}]}]}"""
}

/** The SubAgents settings and Model tiers (docs/subagent-design.md §7): what is read, what is drawn, and what is written. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = ManagementShellApplication::class, qualifiers = "w411dp-h2400dp")
class SubagentsTest {
    @get:Rule(order = 0) val host = object : ExternalResource() {
        override fun before() {
            val app = RuntimeEnvironment.getApplication()
            shadowOf(app.packageManager).addActivityIfNotPresent(ComponentName(app, ComponentActivity::class.java))
        }
    }
    @get:Rule(order = 1) val compose = createAndroidComposeRule<ComponentActivity>()
    private val fixture = ManagementFixture

    @Before fun start() { fixture.reset(); fixture.subagentTiers = SubagentFixtures.TIERS; fixture.subagentBlocked = listOf("team-codex") }

    private fun api(): ManagementApi {
        val session = fixture.session()
        runBlocking { fixture.signIn(session) }
        return ManagementApi(session, (session.state.value as AuthState.SignedIn).handle)
    }
    private fun await(text: String) = compose.waitUntil(60_000) {
        compose.onAllNodesWithText(text, substring = true, useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty()
    }
    private fun written(prefix: String) = fixture.bodies.filter { it.startsWith(prefix) }
        .map { Json.parseToJsonElement(it.removePrefix(prefix).trim()).jsonObject }

    @Test fun theTiersResponseDecodesAndTheWorkspaceFieldsDefaultWhenAbsent() {
        val providers = Subagents.decode(Json.parseToJsonElement(SubagentFixtures.TIERS))
        assertEquals(listOf("deepseek", "claude", "codex", "my-endpoint", "kimi", "team-codex"), providers.map { it.slug })
        val deepseek = providers[0].models.single()
        assertEquals(SubagentTierModel("deepseek-chat", listOf("S", "M"), "catalogue", false, 0.6), deepseek.copy(quality = SubagentQuality.NONE))
        assertEquals(3.2, deepseek.quality.averageRating)
        assertEquals(listOf(10, 4), deepseek.quality.raters.map { it.count })
        assertEquals(ManagementFixture.KEY_OPENAI, providers[3].providerId)
        assertNull(providers[1].providerId)
        assertEquals("subscription", providers[1].billing)
        assertEquals(SubagentTierModel("qwen-coder", emptyList(), null, true, null), providers[3].models.single())
        assertEquals("pool", providers[5].kind)
        // Not an object (a server before the route answers 404 or a list): no providers, not a crash.
        assertEquals(emptyList<SubagentProvider>(), Subagents.decode(JsonArray(emptyList())))

        assertEquals(SubagentSettings(true, 4, true), SubagentSettings.of(buildJsonObject { put("name", "a") }))
        assertEquals(SubagentSettings(false, 9, false), SubagentSettings.of(buildJsonObject {
            put("subagentsEnabled", false); put("subagentsMaxRunning", 9); put("workflowsEnabled", false) }))
        assertEquals(listOf("kimi"), Subagents.blocked(Json.parseToJsonElement("""{"preferences":{"subagentBlockedProviders":["kimi"]}}""")))
        assertEquals(emptyList<String>(), Subagents.blocked(Json.parseToJsonElement("""{"preferences":{"theme":"system"}}""")))
    }

    @Test fun tierPriceAndAllowedText() {
        assertEquals("Not set", Subagents.tierText(emptyList()))
        assertEquals("S–XL by effort", Subagents.tierText(listOf("S", "M", "L", "XL")))
        assertEquals("L · XL", Subagents.tierText(listOf("L", "XL")))
        assertEquals("M", Subagents.tierText(listOf("M")))
        val older = SubagentTierModel("claude-opus-5", emptyList(), null, true, null, "claude-opus-5-5")
        assertEquals("Older · uses claude-opus-5-5", Subagents.modelTierText(older))
        assertEquals("M", Subagents.modelTierText(older.copy(levels = listOf("M"))))
        assertEquals("Not set", Subagents.modelTierText(older.copy(supersededBy = null)))
        val model = SubagentTierModel("m", emptyList(), null, false, null)
        assertEquals("$0.60", Subagents.priceText(model.copy(outputPricePerMTok = 0.6), "key"))
        assertEquals("$15.00", Subagents.priceText(model.copy(outputPricePerMTok = 15.0), "subscription"))
        assertEquals("Subscription", Subagents.priceText(model, "subscription"))
        assertEquals("—", Subagents.priceText(model, "key"))
        val providers = Subagents.decode(Json.parseToJsonElement(SubagentFixtures.TIERS))
        assertEquals("6 of 6", Subagents.allowedLine(providers, emptyList()))
        assertEquals("5 of 6", Subagents.allowedLine(providers, listOf("team-codex", "gone")))
    }

    @Test fun workspacePatchSendsSubagentFieldsOnlyWhenTheyMoved() {
        val saved = buildJsonObject { put("name", "app") }
        assertEquals(buildJsonObject { put("name", "app"); put("effort", ""); put("enabled", true) },
            workspacePatch(saved, "app", "", "", "", true, SubagentSettings(true, 4, true)))
        assertEquals(buildJsonObject { put("name", "app"); put("effort", ""); put("enabled", true); put("subagentsEnabled", false)
            put("subagentsMaxRunning", 16); put("workflowsEnabled", false) },
            workspacePatch(saved, "app", "", "", "", true, SubagentSettings(false, 16, false)))
    }

    @Test fun theGroupsRowsSayTheMocksWordsAndDoneSendsWhatMoved() {
        val api = api()
        var done = 0
        compose.setContent { WorkspaceSettings(api, ManagementFixture.WORKSPACE, 0, { done++ }, {}, {}) }
        await("5 of 6 · Edit")
        listOf(Subagents.GROUP, Subagents.SWITCH_DETAIL, Subagents.WORKFLOWS, Subagents.WORKFLOWS_DETAIL, Subagents.PROVIDERS,
            Subagents.PROVIDERS_DETAIL, Subagents.RUNNING, Subagents.RUNNING_DETAIL).forEach {
            assertTrue("$it is drawn", compose.onAllNodesWithText(it, useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty())
        }
        // Optimize For is the account's, on Settings › General: the Agent's form draws and writes none of it.
        assertEquals(0, compose.onAllNodesWithText("Optimize For", useUnmergedTree = true).fetchSemanticsNodes().size)
        compose.onNodeWithTag("subagents-running", useUnmergedTree = true).assertTextEquals("4")
        val switch = hasText(Subagents.SWITCH_DETAIL) and isToggleable()
        compose.onNode(switch).assertIsOn()
        compose.onNode(hasText(Subagents.WORKFLOWS_DETAIL) and isToggleable()).assertIsOn()

        compose.onNode(switch).performScrollTo().performClick()
        compose.onNodeWithContentDescription("More").performScrollTo().performClick().performClick()
        compose.onNodeWithContentDescription("Fewer").performClick()
        compose.onNodeWithTag("subagents-running", useUnmergedTree = true).assertTextEquals("5")
        compose.onNodeWithText("Done").performClick()
        compose.waitUntil(60_000) { done == 1 }
        val patch = written("PATCH workspaces/${ManagementFixture.WORKSPACE}").single()
        assertEquals(JsonPrimitive(false), patch["subagentsEnabled"])
        assertEquals(JsonPrimitive(5), patch["subagentsMaxRunning"])
        assertTrue("no runner route", fixture.calls.none { it.contains("runner/") })
    }

    @Test fun theWorkflowsSwitchIsSavedWithDoneAndFollowsSubAgents() {
        val api = api()
        var done = 0
        compose.setContent { WorkspaceSettings(api, ManagementFixture.WORKSPACE, 0, { done++ }, {}, {}) }
        await("5 of 6 · Edit")
        val workflows = hasText(Subagents.WORKFLOWS_DETAIL) and isToggleable()
        compose.onNode(workflows).performScrollTo().assertIsOn().assertIsEnabled().performClick()
        compose.onNode(workflows).assertIsOff()
        // SubAgents off takes Workflows with it, and it cannot be turned on while SubAgents is off.
        val switch = hasText(Subagents.SWITCH_DETAIL) and isToggleable()
        compose.onNode(switch).performScrollTo().performClick()
        compose.onNode(workflows).assertIsOff().assertIsNotEnabled()
        compose.onNode(switch).performClick()
        compose.onNode(workflows).assertIsOff().assertIsEnabled()
        compose.onNodeWithText("Done").performClick()
        compose.waitUntil(60_000) { done == 1 }
        val patch = written("PATCH workspaces/${ManagementFixture.WORKSPACE}").single()
        assertEquals(JsonPrimitive(false), patch["workflowsEnabled"])
        assertNull("SubAgents ends where it started, so it is not sent", patch["subagentsEnabled"])
    }

    @Test fun storedSubagentFieldsPrefillAndAnUnchangedFormWritesNothing() {
        fixture.workspaceExtra = ""","subagentsEnabled":false,"subagentsMaxRunning":16"""
        val api = api()
        var done = 0
        compose.setContent { WorkspaceSettings(api, ManagementFixture.WORKSPACE, 0, { done++ }, {}, {}) }
        await("5 of 6 · Edit")
        compose.onNode(hasText(Subagents.SWITCH_DETAIL) and isToggleable()).assertIsOff()
        // Workflows follows SubAgents: off, and not to be turned on while SubAgents is off.
        compose.onNode(hasText(Subagents.WORKFLOWS_DETAIL) and isToggleable()).assertIsOff().assertIsNotEnabled()
        compose.onNodeWithTag("subagents-running", useUnmergedTree = true).assertTextEquals("16")
        compose.onNodeWithContentDescription("More").assertIsNotEnabled()
        compose.onNodeWithText("Done").performClick()
        compose.waitUntil(60_000) { done == 1 }
        assertEquals(emptyList<String>(), fixture.writes("workspaces/${ManagementFixture.WORKSPACE}"))
    }

    @Test fun theBlockedListMovesAsIosMovesIt() {
        assertEquals(listOf("team-codex", "claude"), Subagents.blocked(listOf("team-codex"), "claude", allowed = false))
        assertEquals(listOf("team-codex", "claude"), Subagents.blocked(listOf("claude", "team-codex"), "claude", allowed = false))
        assertEquals(listOf("team-codex"), Subagents.blocked(listOf("claude", "team-codex"), "claude", allowed = true))
        val providers = Subagents.decode(Json.parseToJsonElement(SubagentFixtures.TIERS))
        assertEquals("5 of 6 · Edit", Subagents.providersButton(providers, listOf("team-codex")))
    }

    @Test fun theProvidersListBlocksWhatIsSwitchedOffAndWritesTheWholeList() {
        val api = api()
        compose.setContent { WorkspaceSettings(api, ManagementFixture.WORKSPACE, 0, {}, {}, {}) }
        await("5 of 6 · Edit")
        compose.onNodeWithTag("subagent-providers").performScrollTo().performClick()
        await("Team Codex")
        compose.onNode(hasTestTag("subagent-provider:team-codex")).assertIsOff()
        compose.onNode(hasTestTag("subagent-provider:claude")).assertIsOn().performClick()
        await("4 of 6 · Edit")
        compose.onNode(hasTestTag("subagent-provider:claude")).assertIsOff()
        // Each switch writes the whole list at once, as iOS's sheet does: no Save.
        val prefs = written("PATCH users/me/preferences").single()
        assertEquals(buildJsonObject { putJsonArray("subagentBlockedProviders") { add("team-codex"); add("claude") } }, prefs)
        assertEquals(listOf("team-codex", "claude"), fixture.subagentBlocked)
        compose.onNode(hasTestTag("subagent-provider:team-codex")).performClick()
        await("5 of 6 · Edit")
        assertEquals(buildJsonObject { putJsonArray("subagentBlockedProviders") { add("claude") } },
            written("PATCH users/me/preferences").last())
        // The account's list is its own write: the Agent's form has nothing to save.
        assertEquals(emptyList<String>(), fixture.writes("workspaces/${ManagementFixture.WORKSPACE}"))
    }

    @Test fun modelTiersListTheModelsAndAnEditableOneTakesATier() {
        val api = api()
        compose.setContent { MachinesAndModelsSettings(api, 0, null, {}, {}) }
        await("qwen-coder")
        listOf(Subagents.TIERS, Subagents.TIERS_FOOTER, "Provider", "Model", "Tier", "Price / M out", "deepseek-chat", "claude-opus-5-5",
            "S · M", "L · XL", "S–XL by effort", "$0.60", "Subscription", "—", "Not set").forEach {
            assertTrue("$it is drawn", compose.onAllNodesWithText(it, substring = true, useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty())
        }
        // Providers with no models have no row.
        assertEquals(0, compose.onAllNodesWithText("Kimi", useUnmergedTree = true).fetchSemanticsNodes().size)
        // Only the editable model opens a menu.
        assertEquals(0, compose.onAllNodesWithTag("tier:deepseek:deepseek-chat", useUnmergedTree = true).fetchSemanticsNodes().size)
        val reads = fixture.calls.count { it == "GET providers/subagent-tiers" }
        compose.onNodeWithTag("tier:my-endpoint:qwen-coder", useUnmergedTree = true).performScrollTo().performClick()
        compose.waitUntil(60_000) { compose.onAllNodesWithText("XL").fetchSemanticsNodes().isNotEmpty() }
        assertEquals("Clear is offered once a tier is set", 0, compose.onAllNodesWithText("Clear").fetchSemanticsNodes().size)
        compose.onNodeWithText("L").performClick()
        compose.waitUntil(60_000) { fixture.calls.count { it == "GET providers/subagent-tiers" } > reads }
        assertEquals(buildJsonObject { put("model", "qwen-coder"); put("tier", "L") },
            written("PATCH providers/mine/${ManagementFixture.KEY_OPENAI}/model-tier").single())
    }

    /** The Quality lines (docs/subagent-design.md §7.1, board docs/mocks/model-quality/01-board.png, owner's A1·B1·C1). */
    @Test fun theQualityLinesReadAsIosAndWebReadThem() {
        val claude = Subagents.decode(Json.parseToJsonElement(SubagentFixtures.TIERS)).first { it.slug == "claude" }
        val opus = Subagents.qualityLines(claude.models.first { it.model == "claude-opus-5-5" }.quality)
        assertEquals(QualityLines(false, QualityLine("4.4 · 23 rated of 41", false), "Rated by Opus 5.5 (15) · Sonnet 5.5 (8)",
            QualityLine("86% first pass · 52 tasks", false)), opus)
        val sonnet = Subagents.qualityLines(claude.models.first { it.model == "claude-sonnet-5-5" }.quality)
        assertEquals(QualityLines(false, QualityLine(Subagents.NOT_ENOUGH_RATINGS, true), null, QualityLine(Subagents.NOT_ENOUGH_TASKS, true)), sonnet)
        // Absent on an older server, or nothing run: No runs yet.
        assertTrue(Subagents.qualityLines(SubagentQuality.of(null)).empty)
        // A rater with no label is named by its provider.
        val deepseek = Subagents.decode(Json.parseToJsonElement(SubagentFixtures.TIERS)).first { it.slug == "deepseek" }.models.single()
        assertEquals("Rated by Opus 5.5 (10) · codex (4)", Subagents.qualityLines(deepseek.quality).raters)
    }

    @Test fun modelTiersShowQualityUnderTheModelAndATapSaysWhoRated() {
        val api = api()
        compose.setContent { MachinesAndModelsSettings(api, 0, null, {}, {}) }
        await("qwen-coder")
        listOf("4.4 · 23 rated of 41", "86% first pass · 52 tasks", Subagents.NOT_ENOUGH_RATINGS, Subagents.NOT_ENOUGH_TASKS,
            Subagents.NO_RUNS_YET, Subagents.QUALITY_FOOTER).forEach {
            assertTrue("$it is drawn", compose.onAllNodesWithText(it, substring = true, useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty())
        }
        // Only a line with an average says who rated.
        assertEquals(0, compose.onAllNodesWithTag("quality-raters:claude:claude-sonnet-5-5", useUnmergedTree = true).fetchSemanticsNodes().size)
        compose.onNodeWithTag("quality-raters:claude:claude-opus-5-5", useUnmergedTree = true).performScrollTo().performClick()
        await("Rated by Opus 5.5 (15) · Sonnet 5.5 (8)")
    }

    @Test fun aBuiltInEnginesModelTakesATierThroughTheBuiltinDoor() {
        fixture.subagentTiers = SubagentFixtures.BUILTIN
        val api = api()
        compose.setContent { MachinesAndModelsSettings(api, 0, null, {}, {}) }
        await("kimi-k3")
        // Every catalogue model opens the menu; the owner's tiers carry Yours, a catalogue tier does not.
        listOf("claude-opus-5-6", "composer-2.5", "grok-4.7", "kimi-k3").forEach {
            assertEquals(it, 1, compose.onAllNodesWithTag("tier:cursor:$it", useUnmergedTree = true).fetchSemanticsNodes().size)
        }
        assertEquals(1, compose.onAllNodesWithTag("tier-yours:cursor:grok-4.7", useUnmergedTree = true).fetchSemanticsNodes().size)
        assertEquals(1, compose.onAllNodesWithTag("tier-yours:my-endpoint:qwen-coder", useUnmergedTree = true).fetchSemanticsNodes().size)
        assertEquals(0, compose.onAllNodesWithTag("tier-yours:cursor:claude-opus-5-6", useUnmergedTree = true).fetchSemanticsNodes().size)
        // A catalogue tier: the four, no Clear.
        compose.onNodeWithTag("tier:cursor:claude-opus-5-6", useUnmergedTree = true).performScrollTo().performClick()
        compose.waitUntil(60_000) { compose.onAllNodesWithText("XL").fetchSemanticsNodes().isNotEmpty() }
        assertEquals("no Clear on a catalogue tier", 0, compose.onAllNodesWithText("Clear").fetchSemanticsNodes().size)
        compose.onNodeWithText("S").performClick()
        compose.waitUntil(60_000) { fixture.bodies.any { it.contains("model-tier") } }
        assertEquals(buildJsonObject { put("model", "claude-opus-5-6"); put("tier", "S") },
            written("PATCH providers/builtin/cursor/model-tier").single())
    }

    @Test fun aBuiltInEnginesOwnerTierClears() {
        fixture.subagentTiers = SubagentFixtures.BUILTIN
        val api = api()
        compose.setContent { MachinesAndModelsSettings(api, 0, null, {}, {}) }
        await("grok-4.7")
        compose.onNodeWithTag("tier:cursor:grok-4.7", useUnmergedTree = true).performScrollTo().performClick()
        await("Clear")
        compose.onNodeWithText("Clear").performClick()
        compose.waitUntil(60_000) { fixture.bodies.any { it.contains("model-tier") } }
        assertEquals(buildJsonObject { put("model", "grok-4.7"); put("tier", JsonNull) },
            written("PATCH providers/builtin/cursor/model-tier").single())
    }

    @Test fun clearSendsANullTier() {
        fixture.subagentTiers = SubagentFixtures.TIERS.replace(""""levels":[],"source":null""", """"levels":["M"],"source":"owner"""")
        val api = api()
        compose.setContent { MachinesAndModelsSettings(api, 0, null, {}, {}) }
        await("qwen-coder")
        compose.onNodeWithTag("tier:my-endpoint:qwen-coder", useUnmergedTree = true).performScrollTo().performClick()
        await("Clear")
        compose.onNodeWithText("Clear").performClick()
        compose.waitUntil(60_000) { fixture.bodies.any { it.contains("model-tier") } }
        assertEquals(buildJsonObject { put("model", "qwen-coder"); put("tier", JsonNull) },
            written("PATCH providers/mine/${ManagementFixture.KEY_OPENAI}/model-tier").single())
    }
}
