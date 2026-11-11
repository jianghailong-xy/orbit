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
          "models":[{"model":"deepseek-chat","levels":["S","M"],"source":"catalogue","editable":false,"outputPricePerMTok":0.6}]},
        {"slug":"claude","label":"Claude","kind":"builtin","providerId":null,"billing":"subscription",
          "models":[{"model":"claude-sonnet-5-5","levels":["S","M"],"source":"catalogue","editable":false,"outputPricePerMTok":null},
            {"model":"claude-opus-5-5","levels":["L","XL"],"source":"catalogue","editable":false,"outputPricePerMTok":null}]},
        {"slug":"codex","label":"Codex","kind":"builtin","providerId":null,"billing":"subscription",
          "models":[{"model":"gpt-5.6-sol","levels":["S","M","L","XL"],"source":"catalogue","editable":false,"outputPricePerMTok":null}]},
        {"slug":"my-endpoint","label":"My endpoint","kind":"key","providerId":"${ManagementFixture.KEY_OPENAI}","billing":"key",
          "models":[{"model":"qwen-coder","levels":[],"source":null,"editable":true,"outputPricePerMTok":null}]},
        {"slug":"kimi","label":"Kimi","kind":"builtin","providerId":null,"billing":"subscription","models":[]},
        {"slug":"team-codex","label":"Team Codex","kind":"pool","providerId":null,"billing":"subscription","models":[]}]}"""
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
        assertEquals(SubagentTierModel("deepseek-chat", listOf("S", "M"), "catalogue", false, 0.6), providers[0].models.single())
        assertEquals(ManagementFixture.KEY_OPENAI, providers[3].providerId)
        assertNull(providers[1].providerId)
        assertEquals("subscription", providers[1].billing)
        assertEquals(SubagentTierModel("qwen-coder", emptyList(), null, true, null), providers[3].models.single())
        assertEquals("pool", providers[5].kind)
        // Not an object (a server before the route answers 404 or a list): no providers, not a crash.
        assertEquals(emptyList<SubagentProvider>(), Subagents.decode(JsonArray(emptyList())))

        assertEquals(SubagentSettings(true, "cost", 4), SubagentSettings.of(buildJsonObject { put("name", "a") }))
        assertEquals(SubagentSettings(false, "intelligence", 9), SubagentSettings.of(buildJsonObject {
            put("subagentsEnabled", false); put("modelRoutingOptimizeFor", "intelligence"); put("subagentsMaxRunning", 9) }))
        assertEquals(listOf("kimi"), Subagents.blocked(Json.parseToJsonElement("""{"preferences":{"subagentBlockedProviders":["kimi"]}}""")))
        assertEquals(emptyList<String>(), Subagents.blocked(Json.parseToJsonElement("""{"preferences":{"theme":"system"}}""")))
    }

    @Test fun tierPriceAndAllowedText() {
        assertEquals("Not set", Subagents.tierText(emptyList()))
        assertEquals("S–XL by effort", Subagents.tierText(listOf("S", "M", "L", "XL")))
        assertEquals("L · XL", Subagents.tierText(listOf("L", "XL")))
        assertEquals("M", Subagents.tierText(listOf("M")))
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
            workspacePatch(saved, "app", "", "", "", true, false, SubagentSettings(true, "cost", 4)))
        assertEquals(buildJsonObject { put("name", "app"); put("effort", ""); put("enabled", true); put("subagentsEnabled", false)
            put("modelRoutingOptimizeFor", "balance"); put("subagentsMaxRunning", 16) },
            workspacePatch(saved, "app", "", "", "", true, false, SubagentSettings(false, "balance", 16)))
    }

    @Test fun theGroupsRowsSayTheMocksWordsAndDoneSendsWhatMoved() {
        val api = api()
        var done = 0
        compose.setContent { WorkspaceSettings(api, ManagementFixture.WORKSPACE, 0, { done++ }, {}, {}) }
        await("5 of 6 · Edit")
        listOf(Subagents.GROUP, Subagents.SWITCH_DETAIL, Subagents.OPTIMIZE, "Cost", "Balance", "Intelligence", Subagents.PROVIDERS,
            Subagents.PROVIDERS_DETAIL, Subagents.RUNNING, Subagents.RUNNING_DETAIL).forEach {
            assertTrue("$it is drawn", compose.onAllNodesWithText(it, useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty())
        }
        compose.onNodeWithTag("subagents-running", useUnmergedTree = true).assertTextEquals("4")
        val switch = hasText(Subagents.SWITCH_DETAIL) and isToggleable()
        compose.onNode(switch).assertIsOn()
        compose.onNode(hasText("Cost") and isSelectable()).assertIsSelected()

        compose.onNode(switch).performScrollTo().performClick()
        compose.onNode(hasText("Intelligence") and isSelectable()).performScrollTo().performClick()
        compose.onNodeWithContentDescription("More").performScrollTo().performClick().performClick()
        compose.onNodeWithContentDescription("Fewer").performClick()
        compose.onNodeWithTag("subagents-running", useUnmergedTree = true).assertTextEquals("5")
        compose.onNodeWithText("Done").performClick()
        compose.waitUntil(60_000) { done == 1 }
        val patch = written("PATCH workspaces/${ManagementFixture.WORKSPACE}").single()
        assertEquals(JsonPrimitive(false), patch["subagentsEnabled"])
        assertEquals(JsonPrimitive("intelligence"), patch["modelRoutingOptimizeFor"])
        assertEquals(JsonPrimitive(5), patch["subagentsMaxRunning"])
        assertTrue("no runner route", fixture.calls.none { it.contains("runner/") })
    }

    @Test fun storedSubagentFieldsPrefillAndAnUnchangedFormWritesNothing() {
        fixture.workspaceExtra = ""","subagentsEnabled":false,"modelRoutingOptimizeFor":"balance","subagentsMaxRunning":16"""
        val api = api()
        var done = 0
        compose.setContent { WorkspaceSettings(api, ManagementFixture.WORKSPACE, 0, { done++ }, {}, {}) }
        await("5 of 6 · Edit")
        compose.onNode(hasText(Subagents.SWITCH_DETAIL) and isToggleable()).assertIsOff()
        compose.onNode(hasText("Balance") and isSelectable()).assertIsSelected()
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
        compose.setContent { InfrastructureSettings(api, 0, null, {}, {}) }
        await("qwen-coder")
        listOf(Subagents.TIERS, Subagents.TIERS_FOOTER, "Provider", "Model", "Tier", "Price / M out", "deepseek-chat", "claude-opus-5-5",
            "S · M", "L · XL", "S–XL by effort", "$0.60", "Subscription", "—", "Not set").forEach {
            assertTrue("$it is drawn", compose.onAllNodesWithText(it, substring = true, useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty())
        }
        // Providers with no models have no row.
        assertEquals(0, compose.onAllNodesWithText("Kimi", useUnmergedTree = true).fetchSemanticsNodes().size)
        // Only the editable model opens a menu.
        assertEquals(0, compose.onAllNodesWithTag("tier:deepseek-chat", useUnmergedTree = true).fetchSemanticsNodes().size)
        val reads = fixture.calls.count { it == "GET providers/subagent-tiers" }
        compose.onNodeWithTag("tier:qwen-coder", useUnmergedTree = true).performScrollTo().performClick()
        compose.waitUntil(60_000) { compose.onAllNodesWithText("XL").fetchSemanticsNodes().isNotEmpty() }
        assertEquals("Clear is offered once a tier is set", 0, compose.onAllNodesWithText("Clear").fetchSemanticsNodes().size)
        compose.onNodeWithText("L").performClick()
        compose.waitUntil(60_000) { fixture.calls.count { it == "GET providers/subagent-tiers" } > reads }
        assertEquals(buildJsonObject { put("model", "qwen-coder"); put("tier", "L") },
            written("PATCH providers/mine/${ManagementFixture.KEY_OPENAI}/model-tier").single())
    }

    @Test fun clearSendsANullTier() {
        fixture.subagentTiers = SubagentFixtures.TIERS.replace(""""levels":[],"source":null""", """"levels":["M"],"source":"owner"""")
        val api = api()
        compose.setContent { InfrastructureSettings(api, 0, null, {}, {}) }
        await("qwen-coder")
        compose.onNodeWithTag("tier:qwen-coder", useUnmergedTree = true).performScrollTo().performClick()
        await("Clear")
        compose.onNodeWithText("Clear").performClick()
        compose.waitUntil(60_000) { fixture.bodies.any { it.contains("model-tier") } }
        assertEquals(buildJsonObject { put("model", "qwen-coder"); put("tier", JsonNull) },
            written("PATCH providers/mine/${ManagementFixture.KEY_OPENAI}/model-tier").single())
    }
}
