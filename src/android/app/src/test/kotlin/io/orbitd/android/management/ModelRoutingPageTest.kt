package io.orbitd.android.management

import android.content.ComponentName
import androidx.activity.ComponentActivity
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import io.orbitd.android.core.auth.AuthState
import io.orbitd.android.navigation.Destination
import io.orbitd.android.navigation.OrbitRoute
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
import java.time.Duration
import java.time.Instant

/** Settings → Providers → Model routing, as the web's ModelRoutingPage draws it: the Routing group's Route by tier and Optimize For
 * (only while Route by tier is on), each written alone; then the Models group — the period, every model in its section with its
 * figures and its flag, the folded models with no tier and no runs — and the page's loading, failed and empty states. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = ManagementShellApplication::class, qualifiers = "w411dp-h4000dp")
class ModelRoutingPageTest {
    @get:Rule(order = 0) val host = object : ExternalResource() {
        override fun before() {
            val app = RuntimeEnvironment.getApplication()
            shadowOf(app.packageManager).addActivityIfNotPresent(ComponentName(app, ComponentActivity::class.java))
        }
    }
    @get:Rule(order = 1) val compose = createComposeRule()
    private val fixture = ManagementFixture

    @Before fun start() { fixture.reset(); fixture.subagentTiers = SubagentFixtures.TIERS }

    private fun api(): ManagementApi {
        val session = fixture.session()
        runBlocking { fixture.signIn(session) }
        return ManagementApi(session, (session.state.value as AuthState.SignedIn).handle)
    }
    private fun open(route: String = "model-routing", opened: MutableList<OrbitRoute> = mutableListOf()) {
        val api = api()
        compose.setContent {
            SettingsScreen(api, OrbitRoute(Destination.SETTINGS, route), 0, { opened += it }, {}, logout = {}, changed = {}, workspaceDeleted = {},
                deviceAlerts = { true }, notifications = {}, about = {})
        }
    }
    private fun await(text: String) = compose.waitUntil(60_000) {
        compose.onAllNodesWithText(text, substring = true, useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty()
    }
    private fun count(text: String) = compose.onAllNodesWithText(text, useUnmergedTree = true).fetchSemanticsNodes().size
    private fun textTop(text: String) = compose.onAllNodesWithText(text, useUnmergedTree = true).onFirst().fetchSemanticsNode().positionInRoot.y
    private fun preferenceWrites() = fixture.bodies.filter { it.startsWith("PATCH users/me/preferences") }
        .map { Json.parseToJsonElement(it.removePrefix("PATCH users/me/preferences").trim()).jsonObject }

    @Test fun providersOpensModelRoutingAndHasNoTierTableOfItsOwn() {
        val opened = mutableListOf<OrbitRoute>()
        open("providers", opened)
        await(ModelRouting.TITLE)
        assertEquals(0, count("Model tiers"))
        assertEquals(0, count("Price / M out"))
        compose.onNodeWithTag("model-routing").performScrollTo().performClick()
        compose.runOnIdle { assertEquals(listOf(OrbitRoute(Destination.SETTINGS, "model-routing")), opened) }
        assertEquals(ModelRouting.TITLE, settingsTitle("model-routing"))
    }

    @Test fun theRoutingGroupHoldsTheSwitchAndOptimizeForUnderIt() {
        open()
        await("deepseek-chat")
        assertTrue("the description, then Routing, the switch, its hint, Optimize For and its line, then Models",
            listOf(ModelRouting.DESCRIPTION, ModelRouting.ROUTING, SMART_MODEL_SELECTION, SMART_MODEL_SELECTION_HINT, OPTIMIZE_FOR,
                OPTIMIZE_FOR_DETAIL, ModelRouting.MODELS).map(::textTop).zipWithNext().all { (a, b) -> a < b })
        // The fixture's account names neither: absent reads as on, and as Balance.
        compose.onNode(hasText(SMART_MODEL_SELECTION) and isToggleable()).assertIsOn()
        compose.onNode(hasText("Balance") and isSelectable()).assertIsSelected()
        compose.onNode(hasText("Intelligence") and isSelectable()).performScrollTo().performClick()
        compose.waitUntil(60_000) { fixture.optimizeFor == "intelligence" }
        assertEquals(listOf(buildJsonObject { put("optimizeFor", "intelligence") }), preferenceWrites())
        compose.onNode(hasText("Intelligence") and isSelectable()).assertIsSelected()
        // The switch is written alone too, and turning it off takes Optimize For away; the saved mode is kept.
        compose.onNode(hasText(SMART_MODEL_SELECTION) and isToggleable()).performScrollTo().performClick()
        compose.waitUntil(60_000) { fixture.modelRouting == false }
        compose.waitUntil(60_000) { count(OPTIMIZE_FOR) == 0 }
        assertEquals(buildJsonObject { put("modelRouting", false) }, preferenceWrites().last())
        assertEquals("intelligence", fixture.optimizeFor)
    }

    @Test fun optimizeForShowsOnlyWhileRouteByTierIsOn() {
        fixture.modelRouting = false
        fixture.optimizeFor = "cost"
        open()
        await(SMART_MODEL_SELECTION)
        compose.waitUntil(60_000) { runCatching { compose.onNode(hasText(SMART_MODEL_SELECTION) and isToggleable()).assertIsOff() }.isSuccess }
        assertEquals(0, count(OPTIMIZE_FOR))
        compose.onNode(hasText(SMART_MODEL_SELECTION) and isToggleable()).performScrollTo().performClick()
        compose.waitUntil(60_000) { fixture.modelRouting == true }
        compose.waitUntil(60_000) { runCatching { compose.onNode(hasText("Cost") and isSelectable()).assertIsSelected() }.isSuccess }
        assertTrue(preferenceWrites().none { it.containsKey("optimizeFor") })
    }

    @Test fun theModelsSitInTheirSectionsWithTheirFiguresAndFlags() {
        fixture.routingReport = SubagentFixtures.REPORT
        open()
        await("old-model")
        // Each section's header, in order, and every row under its own.
        val order = listOf(ModelRouting.ROUTED_BY_TIER, "deepseek-chat", "old-model", ModelRouting.CALLED_BY_NAME,
            ModelRouting.CALLED_BY_NAME_NOTE, ModelRouting.NOT_ROUTED)
        assertTrue("sections in order: $order", order.map(::textTop).zipWithNext().all { (a, b) -> a < b })
        assertEquals(0, compose.onAllNodesWithTag("model-routing-idle").fetchSemanticsNodes().size)
        // The flags: under the name, in the flag colour, in the web's words.
        compose.onNodeWithTag("routing-flag:deepseek:deepseek-chat", useUnmergedTree = true).assertTextEquals("1 run at L, outside S · M")
        compose.onNodeWithTag("routing-flag:my-endpoint:qwen-coder", useUnmergedTree = true).assertTextEquals("No tier set, but routed 2 times")
        assertEquals(0, compose.onAllNodesWithTag("routing-flag:claude:claude-opus-5-5", useUnmergedTree = true).fetchSemanticsNodes().size)
        // Ran at, Runs, Done and Cost on the line under each row; the tier outside the model's is marked, not only coloured.
        compose.onNodeWithTag("routing-figures:deepseek:deepseek-chat", useUnmergedTree = true)
            .assertTextEquals("Ran at S 3 · L 1 ⚑   Runs 4   Done 75%   Cost $0.42")
            .assertContentDescriptionEquals("Ran at S 3, L 1 (outside its tier), Runs 4, Done 75%, Cost $0.42")
        compose.onNodeWithTag("routing-figures:gone:old-model", useUnmergedTree = true).assertTextEquals("Ran at S 1   Runs 1   Done 100%   Cost $0.01")
        // claude-sonnet-5-5 is in two sections: tiered with no routed runs, and called by name.
        val sonnet = compose.onAllNodesWithTag("routing-figures:claude:claude-sonnet-5-5", useUnmergedTree = true)
        sonnet.assertCountEquals(2)
        sonnet[0].assertTextEquals("Ran at No runs   Runs 0   Done —   Cost —")
        sonnet[1].assertTextEquals("Ran at Named   Runs 2   Done 100%   Cost $0.00")
        compose.onAllNodesWithTag("routing-figures:codex:gpt-5.6-sol", useUnmergedTree = true)[1]
            .assertTextEquals("Ran at Not routed   Runs 1   Done —   Cost $0.00")
        compose.onNodeWithTag("model-routing-totals", useUnmergedTree = true)
            .assertTextEquals("15 runs, 2 of them workflow calls · 77% done · $0.48 · 1 moved on · 8% without a size · 2 models ran outside their tiers")
        // A model the tier list no longer has: no tier menu, no price.
        assertEquals(0, compose.onAllNodesWithTag("tier:gone:old-model", useUnmergedTree = true).fetchSemanticsNodes().size)
        // The footnotes, the web's two.
        listOf(ModelRouting.SUBAGENTS_FOOT, Subagents.QUALITY_FOOTER).forEach { assertEquals(it, 1, count(it)) }
    }

    @Test fun theModelsWithNoTierAndNoRunsAreFolded() {
        open()
        await("deepseek-chat")
        assertEquals(0, count("qwen-coder"))
        compose.onNodeWithTag("model-routing-idle").assertTextEquals("▸ No tier, no runs · 1 model").performScrollTo().performClick()
        await("qwen-coder")
        compose.onNodeWithTag("model-routing-idle").assertTextEquals("▾ No tier, no runs · 1 model")
        compose.onNodeWithTag("routing-figures:my-endpoint:qwen-coder", useUnmergedTree = true).assertTextEquals("Ran at No runs   Runs 0   Done —   Cost —")
        // No runs at all: the totals line says so.
        compose.onNodeWithTag("model-routing-totals", useUnmergedTree = true).assertTextEquals("No SubAgents ran in the last 30 days.")
    }

    @Test fun thePeriodIsLastThirtyDaysUntilAnotherIsPicked() {
        open()
        await("deepseek-chat")
        fun since(): String? = fixture.queries.lastOrNull { it.startsWith("GET tasks/model-routing/report/subagents") }
            ?.substringAfter("since=", "")?.ifEmpty { null }
        compose.onNode(hasText(ModelRouting.PERIOD) and hasText("Last 30 days")).assertExists()
        val month0 = since()!!
        val month = Duration.between(Instant.parse(month0), Instant.now()).toHours()
        assertTrue("since is 30 days back ($month h)", month in 719..721)
        compose.onNode(hasText(ModelRouting.PERIOD) and hasClickAction()).performScrollTo().performClick()
        compose.onNodeWithText("Last 7 days").performClick()
        await("No SubAgents ran in the last 7 days.")
        // Seven days back from a moment a little after the first read's: 23 days after its since.
        val week = Duration.between(Instant.parse(month0), Instant.parse(since()!!))
        assertTrue("since is 7 days back (${week.toMinutes()} min after the 30 days' since)", week >= Duration.ofDays(23) && week < Duration.ofDays(23).plusHours(1))
        compose.onNode(hasText(ModelRouting.PERIOD) and hasClickAction()).performScrollTo().performClick()
        compose.onNodeWithText("All time").performClick()
        await("No SubAgents ran yet.")
        // All time sends no since at all.
        assertEquals(3, fixture.calls.count { it == "GET tasks/model-routing/report/subagents" })
        assertEquals(2, fixture.queries.count { it.startsWith("GET tasks/model-routing/report/subagents") })
    }

    @Test fun aFailedReadSaysWhyAndRetries() {
        fixture.routingReportFailure = "report read failed"
        open()
        await("Couldn’t load the report: report read failed")
        assertEquals(0, count("deepseek-chat"))
        fixture.routingReportFailure = null
        compose.onNodeWithText(ModelRouting.RETRY).performScrollTo().performClick()
        await("deepseek-chat")
        assertEquals(0, compose.onAllNodesWithText("Couldn’t load the report", substring = true).fetchSemanticsNodes().size)
    }

    @Test fun nothingListedAndNothingRunSaysSo() {
        fixture.subagentTiers = """{"providers":[]}"""
        open()
        await("No SubAgents ran in the last 30 days.")
        assertEquals(0, count("Price / M out"))
        assertEquals(0, compose.onAllNodesWithTag("model-routing-loading").fetchSemanticsNodes().size)
    }
}
