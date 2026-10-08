package io.orbitd.android.wiki

import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Box
import androidx.compose.runtime.Composable
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import io.orbitd.android.MainActivity
import io.orbitd.android.TestOrbitApplication
import io.orbitd.android.core.net.ApiRequest
import io.orbitd.android.core.net.HttpMethod
import io.orbitd.android.core.protocol.Wire
import io.orbitd.android.directory.DirectoryData
import io.orbitd.android.navigation.Destination
import io.orbitd.android.navigation.OrbitRoute
import io.orbitd.android.ui.OrbitTheme
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** Wiki settings (iOS `WikiSettingsPage`, `WikiMaintenanceForm`, `WikiSettingsView`): the review mode as one choice of
 * three, the spot checks only in Automatic, maintenance off or on — and, over a real store and an in-memory server, the
 * `PATCH /api/wiki/spaces/:id` each press sends, the look-back as 0, the days picked, or null for all of history. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = TestOrbitApplication::class, qualifiers = "w411dp-h1400dp")
class WikiSettingsPageTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()
    private val route = OrbitRoute(Destination.WIKI_SETTINGS)
    private val calls = mutableListOf<String>()
    private val actions = WikiSettingsActions(setMode = { calls += "mode $it" }, setSpotChecks = { calls += "spot checks $it" },
        setUp = { calls += "set up" }, turnOff = { calls += "turn off" })

    @Before fun quiet() { WikiToast.text = null }

    private fun space(settings: String) = Wire.json.decodeFromString(WikiSpace.serializer(),
        """{"id":"sp1","slug":"orbit","repoUrlNorm":"github.com/orbit/orbit","settings":$settings}""")
    private fun show(content: @Composable () -> Unit) {
        compose.activityRule.scenario.onActivity { it.setContent { OrbitTheme { Box { content(); WikiToast.Host() } } } }
        compose.waitForIdle()
    }
    private fun says(tag: String, vararg texts: String) = texts.forEach { text ->
        assertTrue("$tag does not say “$text”", compose.onAllNodes((hasTestTag(tag) or hasAnyAncestor(hasTestTag(tag))) and
            hasText(text, substring = true), useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty())
    }

    // MARK: the page

    @Test fun theReviewModeIsOneChoiceOfThreeAndAnotherIsWritten() {
        show { WikiSettingsPage(route, space("""{"reviewMode":"tiered"}"""), actions = actions) }
        compose.onNodeWithTag("wiki-settings-space").assertTextEquals("orbit · github.com/orbit/orbit")
        compose.onNodeWithTag("wiki-settings-mode:tiered").assertIsSelected().assertTextContains(WikiModeCopy.modeDefault, substring = true)
        compose.onNodeWithTag("wiki-settings-mode:manual").assertIsNotSelected()
            .assertTextContains(WikiModeCopy.modeNote("manual"), substring = true)
        compose.onNodeWithTag("wiki-settings-mode:automatic").assertIsNotSelected().performClick()
        // The mode already on is not written again.
        compose.onNodeWithTag("wiki-settings-mode:tiered").performClick()
        assertEquals(listOf("mode automatic"), calls)
        says("wiki-settings-floors", "${WikiModeCopy.floorsLead} ${WikiModeCopy.floorsNote}")
    }

    @Test fun spotChecksAreOnlyOfferedWhileTheSpaceIsAutomatic() {
        show { WikiSettingsPage(route, space("""{"reviewMode":"tiered","automaticSpotChecks":true}"""), actions = actions) }
        compose.onNodeWithTag("wiki-settings-spot-checks").assertIsNotEnabled().assertIsOn()
        show { WikiSettingsPage(route, space("""{"reviewMode":"manual"}"""), actions = actions) }
        compose.onNodeWithTag("wiki-settings-spot-checks").assertIsNotEnabled().assertIsOff()
        show { WikiSettingsPage(route, space("""{"reviewMode":"automatic"}"""), actions = actions) }
        compose.onNodeWithTag("wiki-settings-spot-checks").assertIsEnabled().assertIsOff().performClick()
        assertEquals(listOf("spot checks true"), calls)
    }

    @Test fun maintenanceOffSaysSoAndOffersSetUp() {
        show { WikiSettingsPage(route, space("""{"reviewMode":"tiered"}"""), actions = actions) }
        says("wiki-settings-off-row", WikiModeCopy.maintenanceName, WikiModeCopy.off)
        compose.onNodeWithText(WikiModeCopy.maintenanceNote).assertExists()
        compose.onAllNodesWithTag("wiki-settings-turn-off").assertCountEquals(0)
        compose.onNodeWithTag("wiki-settings-set-up").assertTextContains(WikiModeCopy.setUp).performClick()
        assertEquals(listOf("set up"), calls)
    }

    @Test fun maintenanceOnSaysWhereOnWhatHowOftenAndHowFarBack() {
        show {
            WikiSettingsPage(route, space("""{"reviewMode":"tiered","maintenance":{"enabled":true,"workspaceId":"w1","provider":"local-vllm","dailyRunLimit":8,"lookbackDays":0}}"""),
                workspaceLabel = { if (it == "w1") "orbit · Mac mini" else null }, actions = actions)
        }
        says("wiki-settings-status", WikiModeCopy.status, WikiModeCopy.on)
        says("wiki-settings-workspace-row", WikiModeCopy.workspace, "orbit · Mac mini")
        says("wiki-settings-provider-row", WikiModeCopy.provider, "local-vllm")
        says("wiki-settings-daily-row", WikiModeCopy.dailyLimit, "8 runs a day")
        says("wiki-settings-lookback-row", WikiModeCopy.lookback, WikiModeCopy.lookbackNow)
        compose.onAllNodesWithText(WikiModeCopy.maintenanceNote).assertCountEquals(0)
        compose.onNodeWithTag("wiki-settings-edit").assertTextContains("Edit…").performClick()
        compose.onNodeWithTag("wiki-settings-turn-off").performClick()
        assertEquals(listOf("set up", "turn off"), calls)
        // A workspace this client does not hold is named by its id.
        show { WikiSettingsPage(route, space("""{"maintenance":{"enabled":true,"workspaceId":"w9"}}"""), actions = actions) }
        says("wiki-settings-workspace-row", "w9")
    }

    @Test fun aModeTheSpaceWentBackToByItselfIsExplained() {
        val settings = """{"reviewMode":"tiered","reviewModeChangedBy":"verification","reviewModeChangedAt":"2026-09-27T12:00:00.000Z"}"""
        show { WikiSettingsPage(route, space(settings), actions = actions) }
        says("wiki-settings-fallback", WikiModeLogic.modeFallback(space(settings).settings)!!)
        show { WikiSettingsPage(route, space("""{"reviewMode":"tiered","reviewModeChangedBy":"owner"}"""), actions = actions) }
        compose.onAllNodesWithTag("wiki-settings-fallback").assertCountEquals(0)
    }

    @Test fun aWriteInFlightTakesNoSecondPress() {
        show { WikiSettingsPage(route, space("""{"reviewMode":"automatic","maintenance":{"enabled":true,"workspaceId":"w1"}}"""), busy = true, actions = actions) }
        compose.onNodeWithTag("wiki-settings-mode:manual").assertIsNotEnabled().performClick()
        compose.onNodeWithTag("wiki-settings-spot-checks").assertIsNotEnabled()
        compose.onNodeWithTag("wiki-settings-edit").assertIsNotEnabled()
        compose.onNodeWithTag("wiki-settings-turn-off").assertIsNotEnabled()
        assertTrue(calls.isEmpty())
    }

    // MARK: the screen, over the server

    private var spaceRead = """{"id":"sp1","slug":"orbit","settings":{"reviewMode":"automatic"}}"""
    private var patchAnswer: Pair<Int, String> = 200 to "{}"
    /** `GET /wiki/system-model`: the account's executor switch, absent (404) from a control plane before P9. */
    private var systemModelAnswer: Pair<Int, String>? = null
    private val rig = WikiTestRig { request -> answer(request) }
    private fun answer(request: ApiRequest): Pair<Int, String>? = when {
        request.method == HttpMethod.PATCH -> patchAnswer
        request.path == listOf("wiki", "system-model") -> systemModelAnswer
        request.path == listOf("wiki", "spaces") -> 200 to "[$spaceRead]"
        request.path == listOf("workspaces") -> 200 to """[{"id":"w2","name":"docs","runnerId":"r2"},{"id":"w1","name":"orbit","runnerId":"r1"}]"""
        request.path == listOf("runners") -> 200 to """[{"id":"r1","name":"host-1","displayName":"Mac mini"},{"id":"r2","name":"wikova","displayName":null}]"""
        request.path == listOf("providers") -> 200 to """[{"slug":"local-vllm","runtime":"claude","defaultModel":"qwen3.8-27b-fp8","models":[]},
            {"slug":"anthropic","runtime":"claude","models":[{"value":"claude-sonnet","label":"Sonnet"}]},{"slug":"openai","runtime":"codex"}]"""
        else -> null
    }
    private fun screen() {
        val store = rig.store()
        val nav = WikiNav({}, {}, "https://wiki.test") {}
        show { WikiSettingsScreen(store, route, DirectoryData(), nav) }
    }
    private fun patches() = rig.requests.filter { it.method == HttpMethod.PATCH }.map { rig.line(it) + " " + rig.body(it) }

    @Test fun setUpWritesTheLookBackAsZeroTheDaysPickedOrNullForAllHistory() {
        screen()
        // From now on: 0, on the workspace named as the space is, with the provider the space names.
        compose.onNodeWithTag("wiki-settings-set-up").performClick()
        compose.onNodeWithTag("wiki-settings-workspace").assertTextContains("orbit · Mac mini", substring = true)
        compose.onNodeWithTag("wiki-settings-lookback").assertTextContains("Last 14 days", substring = true).performClick()
        compose.onNodeWithTag("wiki-settings-lookback:now").performClick()
        compose.onAllNodesWithTag("wiki-settings-lookback-days").assertCountEquals(0)
        compose.onNodeWithTag("wiki-settings-form-submit").assertTextEquals(WikiModeCopy.turnOn).performClick()
        compose.waitForIdle()
        // Some days: the days the stepper reads, on another workspace and provider, a run more a day.
        compose.onNodeWithTag("wiki-settings-set-up").performClick()
        compose.onNodeWithTag("wiki-settings-workspace").performClick()
        compose.onNodeWithTag("wiki-settings-workspace:w2").performClick()
        compose.onNodeWithTag("wiki-settings-provider").performClick()
        compose.onNodeWithTag("wiki-settings-provider:anthropic").assertTextContains("anthropic · claude-sonnet").performClick()
        compose.onNodeWithTag("wiki-settings-daily-plus").performClick()
        compose.onNodeWithTag("wiki-settings-daily-value").assertTextEquals("9 runs a day")
        compose.onNodeWithTag("wiki-settings-lookback-days-plus").performClick()
        compose.onNodeWithTag("wiki-settings-lookback-days-value").assertTextEquals("Last 15 days")
        compose.onNodeWithTag("wiki-settings-form-submit").performClick()
        compose.waitForIdle()
        // All of history: null — a value, not a key left out.
        compose.onNodeWithTag("wiki-settings-set-up").performClick()
        compose.onNodeWithTag("wiki-settings-lookback").performClick()
        compose.onNodeWithTag("wiki-settings-lookback:all").performClick()
        compose.onNodeWithTag("wiki-settings-form-submit").performClick()
        compose.waitForIdle()
        assertEquals(listOf(
            """PATCH /api/wiki/spaces/sp1 {"maintenance":{"enabled":true,"workspaceId":"w1","provider":"local-vllm","dailyRunLimit":8,"lookbackDays":0}}""",
            """PATCH /api/wiki/spaces/sp1 {"maintenance":{"enabled":true,"workspaceId":"w2","provider":"anthropic","dailyRunLimit":9,"lookbackDays":15}}""",
            """PATCH /api/wiki/spaces/sp1 {"maintenance":{"enabled":true,"workspaceId":"w1","provider":"local-vllm","dailyRunLimit":8,"lookbackDays":null}}""",
        ), patches())
        assertEquals(WikiCopy.settingsSaved, WikiToast.text)
        compose.onAllNodesWithTag("wiki-settings-form").assertCountEquals(0)
    }

    @Test fun editOpensOnWhatIsSetAndSavesIt() {
        spaceRead = """{"id":"sp1","slug":"orbit","settings":{"maintenance":{"enabled":true,"workspaceId":"w2","provider":"retired-provider","dailyRunLimit":3,"lookbackDays":null}}}"""
        screen()
        says("wiki-settings-workspace-row", "docs · wikova")
        compose.onNodeWithTag("wiki-settings-edit").performClick()
        compose.onNodeWithTag("wiki-settings-workspace").assertTextContains("docs · wikova", substring = true)
        // The provider the space names stays offered even when it is no longer configured.
        compose.onNodeWithTag("wiki-settings-provider").assertTextContains("retired-provider", substring = true).performClick()
        compose.onNodeWithTag("wiki-settings-provider:retired-provider").assertExists()
        compose.onNodeWithTag("wiki-settings-provider:openai", useUnmergedTree = true).assertDoesNotExist()
        compose.onNodeWithTag("wiki-settings-provider:retired-provider").performClick()
        compose.onNodeWithTag("wiki-settings-lookback").assertTextContains(WikiModeCopy.lookbackAll, substring = true)
        compose.onNodeWithTag("wiki-settings-form-submit").assertTextEquals(WikiModeCopy.save).performClick()
        compose.waitForIdle()
        assertEquals(listOf(
            """PATCH /api/wiki/spaces/sp1 {"maintenance":{"enabled":true,"workspaceId":"w2","provider":"retired-provider","dailyRunLimit":3,"lookbackDays":null}}"""),
            patches())
    }

    /** While the server executes the account's wiki: the provider is not offered, the System model stands read-only
     * with its state, the workspace reads as where the repository is read from, and one sentence says where the wiki's
     * material goes — and the write leaves the provider out (mock 35 ①②, P9). */
    @Test fun theServerExecutesTheWikiAndTheSystemModelStandsWhereTheProviderWas() {
        spaceRead = """{"id":"sp1","slug":"orbit","settings":{"reviewMode":"automatic","maintenance":{"enabled":true,"workspaceId":"w1","provider":"local-vllm","dailyRunLimit":8,"lookbackDays":0}}}"""
        systemModelAnswer = 200 to """{"state":"up","model":"qwen3.8-27b-fp8","since":"2026-10-08T06:00:00.000Z","checkedAt":"2026-10-08T06:29:55.000Z","workerSeenAt":"2026-10-08T06:29:55.000Z","executor":{"mode":"server","serverExecutes":true}}"""
        screen()
        says("wiki-settings-workspace-row", WikiModeCopy.repoFrom, "orbit · Mac mini")
        says("wiki-settings-model-row", WikiRunsCopy.systemModelLabel("qwen3.8-27b-fp8"), WikiRunsCopy.modelState("up"))
        compose.onAllNodesWithTag("wiki-settings-provider-row").assertCountEquals(0)
        compose.onNodeWithTag("wiki-settings-privacy").assertTextContains(WikiModeCopy.privacyNote)
        compose.onNodeWithTag("wiki-settings-mode:automatic").assertTextContains(WikiModeCopy.modeNoteAutomaticServer)
        // The Set up form: the System model in place of the provider, read-only, and the write leaves the provider out.
        compose.onNodeWithTag("wiki-settings-edit").performClick()
        says("wiki-settings-form-model", WikiRunsCopy.systemModelLabel("qwen3.8-27b-fp8"), WikiRunsCopy.modelState("up"))
        compose.onNodeWithText(WikiModeCopy.modelNote).assertExists()
        compose.onAllNodesWithTag("wiki-settings-provider").assertCountEquals(0)
        compose.onNodeWithTag("wiki-settings-workspace").assertTextContains(WikiModeCopy.repoFrom, substring = true)
        compose.onNodeWithTag("wiki-settings-form-privacy").assertTextContains(WikiModeCopy.privacyNote)
        compose.onNodeWithTag("wiki-settings-form-submit").performClick()
        compose.waitForIdle()
        assertEquals(listOf(
            """PATCH /api/wiki/spaces/sp1 {"maintenance":{"enabled":true,"workspaceId":"w1","dailyRunLimit":8,"lookbackDays":0}}"""),
            patches())
    }

    /** Under runner — or from a control plane before the read — the page and the form are word for word what they
     * always were, and the write still names the provider. */
    @Test fun underRunnerThePageAndTheFormAreWhatTheyAlwaysWere() {
        spaceRead = """{"id":"sp1","slug":"orbit","settings":{"reviewMode":"automatic","maintenance":{"enabled":true,"workspaceId":"w1","provider":"local-vllm","dailyRunLimit":8,"lookbackDays":0}}}"""
        systemModelAnswer = 404 to """{"message":"not found"}"""
        screen()
        says("wiki-settings-workspace-row", WikiModeCopy.workspace, "orbit · Mac mini")
        says("wiki-settings-provider-row", WikiModeCopy.provider, "local-vllm")
        compose.onAllNodesWithTag("wiki-settings-model-row").assertCountEquals(0)
        compose.onAllNodesWithTag("wiki-settings-privacy").assertCountEquals(0)
        compose.onNodeWithTag("wiki-settings-mode:automatic").assertTextContains(WikiModeCopy.modeNote("automatic"))
        compose.onNodeWithTag("wiki-settings-edit").performClick()
        compose.onNodeWithTag("wiki-settings-provider").assertTextContains("local-vllm", substring = true)
        compose.onNodeWithTag("wiki-settings-form-submit").performClick()
        compose.waitForIdle()
        assertEquals(listOf(
            """PATCH /api/wiki/spaces/sp1 {"maintenance":{"enabled":true,"workspaceId":"w1","provider":"local-vllm","dailyRunLimit":8,"lookbackDays":0}}"""),
            patches())
    }

    @Test fun theModeTheSpotChecksAndTurnOffAreWrittenAtOnce() {
        spaceRead = """{"id":"sp1","slug":"orbit","settings":{"reviewMode":"automatic","maintenance":{"enabled":true,"workspaceId":"w1"}}}"""
        screen()
        compose.onNodeWithTag("wiki-settings-spot-checks").performClick()
        compose.waitForIdle()
        compose.onNodeWithTag("wiki-settings-mode:manual").performClick()
        compose.waitForIdle()
        compose.onNodeWithTag("wiki-settings-page").performScrollToNode(hasTestTag("wiki-settings-turn-off"))
        compose.onNodeWithTag("wiki-settings-turn-off").performClick()
        compose.waitForIdle()
        assertEquals(listOf("""PATCH /api/wiki/spaces/sp1 {"automaticSpotChecks":true}""", """PATCH /api/wiki/spaces/sp1 {"reviewMode":"manual"}""",
            """PATCH /api/wiki/spaces/sp1 {"maintenance":{"enabled":false}}"""), patches())
        assertEquals(WikiCopy.settingsSaved, WikiToast.text)
    }

    @Test fun aRefusedSetUpSaysWhyAndKeepsTheForm() {
        spaceRead = """{"id":"sp1","slug":"elsewhere","settings":{}}"""
        patchAnswer = 403 to """{"code":"WIKI_OWNER_CHANNEL_ONLY","message":"That workspace is not yours."}"""
        screen()
        compose.onNodeWithTag("wiki-settings-set-up").performClick()
        // No workspace is named as the space is: Turn on waits for one to be picked.
        compose.onNodeWithTag("wiki-settings-workspace").assertTextContains(WikiModeCopy.noWorkspace, substring = true)
        compose.onNodeWithTag("wiki-settings-form-submit").assertIsNotEnabled()
        compose.onNodeWithTag("wiki-settings-workspace").performClick()
        compose.onNodeWithTag("wiki-settings-workspace:w1").performClick()
        compose.onNodeWithTag("wiki-settings-form-submit").assertIsEnabled().performClick()
        compose.waitForIdle()
        compose.onNodeWithText(WikiCopy.refused).assertExists()
        compose.onNodeWithText("That workspace is not yours.").assertExists()
        compose.onNodeWithTag("wiki-refusal-ok").performClick()
        compose.onNodeWithTag("wiki-settings-form").assertExists()
        compose.onNodeWithTag("wiki-settings-workspace").assertTextContains("orbit · Mac mini", substring = true)
        assertNull(WikiToast.text)
    }
}
