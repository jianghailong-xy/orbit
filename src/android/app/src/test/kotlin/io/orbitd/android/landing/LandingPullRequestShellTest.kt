package io.orbitd.android.landing

import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.unit.dp
import io.orbitd.android.MainActivity
import io.orbitd.android.OrbitApplication
import io.orbitd.android.TestOrbitApplication
import io.orbitd.android.core.auth.*
import io.orbitd.android.core.cards.PullRequestWords
import io.orbitd.android.core.cards.WorkspaceLandingWords
import io.orbitd.android.core.net.*
import io.orbitd.android.core.protocol.Wire
import io.orbitd.android.management.ManagementApi
import io.orbitd.android.management.SettingsScreen
import io.orbitd.android.navigation.Destination
import io.orbitd.android.navigation.OrbitRoute
import io.orbitd.android.projects.ProjectLandingCardView
import io.orbitd.android.projects.ProjectPage
import io.orbitd.android.reader.LandingPullRequestCard
import io.orbitd.android.reader.LandingPullRequestEnv
import io.orbitd.android.reader.LandingSessionModel
import io.orbitd.android.reader.LocalLandingPullRequest
import io.orbitd.android.ui.OrbitTheme
import java.io.File
import java.time.Instant
import java.util.concurrent.CopyOnWriteArrayList
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * The landing setting and the pull request landing states on Android (board docs/mocks/protected-branch-landing, owner 2026-11-23),
 * read from the apiserver's own read models that the web captured (`src/web/src/lib/landingBoardServerViews.json`), never hand-written.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = TestOrbitApplication::class, qualifiers = "w411dp-h891dp-xxhdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class LandingPullRequestShellTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()

    private val views = run {
        val root = generateSequence(File(System.getProperty("user.dir"))) { it.parentFile }
            .first { File(it, "src/web/src/lib/landingBoardServerViews.json").isFile }
        Json.parseToJsonElement(File(root, "src/web/src/lib/landingBoardServerViews.json").readText()).jsonObject
    }
    private fun landing(key: String) = views["landing"]!!.jsonObject[key]!!.jsonObject
    private fun pr(key: String) = landing(key)["pullRequest"]!!.jsonObject
    private fun integration(key: String) = views["integration"]!!.jsonObject[key]!!.jsonObject
    private fun settings(key: String) = views["workspaceLanding"]!!.jsonObject[key]!!.jsonObject

    private val opened = CopyOnWriteArrayList<OrbitRoute>()
    private val writes = CopyOnWriteArrayList<Pair<String, JsonObject>>()

    private fun draw(modes: Map<String, String?> = emptyMap(), content: @androidx.compose.runtime.Composable () -> Unit) {
        compose.runOnUiThread { compose.activity.setContent { OrbitTheme(darkTheme = false) {
            CompositionLocalProvider(LocalLandingPullRequest provides LandingPullRequestEnv({ modes[it] }, { opened += it })) {
                Surface(color = MaterialTheme.colorScheme.background) { Column(Modifier.padding(16.dp).verticalScroll(rememberScrollState())) { content() } }
            }
        } } }
        compose.waitForIdle()
    }

    @Test fun everyStateIsDrawnFromTheServersBlock() {
        val expected = listOf("a" to "OPENED", "b" to "WAITING_FOR_REVIEW", "c" to "CHECK_FAILED", "d" to "CATCHING_UP", "e" to "MERGED", "f" to "FELL_BACK",
            "closed" to "CLOSED")
        for ((key, stage) in expected) {
            draw { LandingPullRequestCard(pr(key), "main", "session-1") }
            compose.onNodeWithTag("pull-request:$stage").assertIsDisplayed()
            compose.onNodeWithTag("pull-request:head", useUnmergedTree = true).assertExists()
        }
        draw { LandingPullRequestCard(pr("a"), "main") }
        compose.onNodeWithTag("pull-request:head", useUnmergedTree = true).assertTextEquals("Pull request open")
        compose.onNodeWithTag("pull-request:right", useUnmergedTree = true).assertTextEquals("2 of 6")
        compose.onNodeWithTag("pull-request:detail", useUnmergedTree = true).assertTextEquals("main requires a pull request. Waiting for the required checks.")
        draw { LandingPullRequestCard(pr("c"), "main", "session-1") }
        compose.onNodeWithTag("pull-request:head", useUnmergedTree = true).assertTextEquals("Check failed: PostgreSQL specs")
        compose.onNodeWithTag("pull-request:open-session", useUnmergedTree = true).performClick()
        assertEquals(OrbitRoute(Destination.SESSION, "session-1"), opened.last())
        draw { LandingPullRequestCard(pr("f"), "main") }
        compose.onNodeWithTag("pull-request:right", useUnmergedTree = true).assertTextEquals("Push refused")
        compose.onNodeWithTag("pull-request:action:${PullRequestWords.SETTINGS}", useUnmergedTree = true).performClick()
        assertEquals(OrbitRoute(Destination.SETTINGS, "workspace", pr("f")["workspaceId"]!!.jsonPrimitive.content, recordId = "landing"), opened.last())
    }

    @Test fun theFasterTipLivesInTheWaitingForReviewCardOnly() {
        draw { for (key in listOf("a", "c", "d", "e", "f", "closed")) LandingPullRequestCard(pr(key), "main") }
        compose.onAllNodesWithTag("pull-request:tip", useUnmergedTree = true).assertCountEquals(0)
        draw { LandingPullRequestCard(pr("b"), "main") }
        compose.onNodeWithTag("pull-request:tip", useUnmergedTree = true).assertExists()
        compose.onNodeWithText(PullRequestWords.TIP, useUnmergedTree = true).assertExists()
        compose.onNodeWithTag("pull-request:tip-link", useUnmergedTree = true).performClick()
        assertEquals(OrbitRoute(Destination.SETTINGS, "workspace", pr("b")["workspaceId"]!!.jsonPrimitive.content, recordId = "landing"), opened.last())
    }

    @Test fun theTipIsHiddenOnPushAsMeAndStaysDismissed() {
        val workspace = pr("b")["workspaceId"]!!.jsonPrimitive.content
        draw(mapOf(workspace to "PUSH_AS_ME")) { LandingPullRequestCard(pr("b"), "main") }
        compose.onAllNodesWithTag("pull-request:tip", useUnmergedTree = true).assertCountEquals(0)
        draw(mapOf(workspace to "PULL_REQUEST")) { LandingPullRequestCard(pr("b"), "main") }
        compose.onNodeWithTag("pull-request:tip", useUnmergedTree = true).assertExists()
        compose.onNodeWithContentDescription(PullRequestWords.DISMISS, useUnmergedTree = true).performClick()
        compose.onAllNodesWithTag("pull-request:tip", useUnmergedTree = true).assertCountEquals(0)
        draw(mapOf(workspace to "PULL_REQUEST")) { LandingPullRequestCard(pr("b"), "main") }
        compose.onAllNodesWithTag("pull-request:tip", useUnmergedTree = true).assertCountEquals(0)
    }

    @Test fun theProjectLandingCardCarriesTheInFlightPullRequest() {
        val now = Instant.parse("2026-11-23T23:40:00Z")
        for (key in listOf("a", "b", "d", "f")) {
            val card = ProjectPage.landingCard(integration(key), now, now, false)!!
            assertEquals(key, pr(key)["number"], card.pullRequest!!["number"])
            assertEquals(key, "waiting for GitHub", card.state)
            draw { ProjectLandingCardView(card, null, null, {}, { null }, { null }) }
            compose.onNodeWithTag("pull-request:head", useUnmergedTree = true).assertExists()
        }
    }

    @Test fun anAttemptHeldOnItsPullRequestIsNotDrawnAsStopped() {
        val view = LandingSessionModel.read(landing("b"))
        assertEquals("PULL_REQUEST", view.currentAttempt!!.state)
        assertEquals(pr("b"), view.pullRequest)
        val card = LandingSessionModel.attemptCard(view, Instant.parse("2026-11-23T23:40:00Z"))!!
        assertEquals(PullRequestWords.WAITING_FOR_GITHUB, card.state)
        assertNull(card.failure)
    }

    @Test fun aFailedGitHubCheckIsLabelledWithItsName() {
        val card = LandingSessionModel.attemptCard(LandingSessionModel.read(landing("c")), Instant.parse("2026-11-23T23:40:00Z"))!!
        assertTrue(card.failure, card.failure!!.contains("Check failed: PostgreSQL specs"))
    }

    // ── the workspace's Landing section ──────────────────────────────────────────────────────────────────────────

    private fun stub(landingBlock: JsonObject) = object : OrbitApi {
        override suspend fun request(handle: SessionHandle, request: ApiRequest): ApiResponse {
            val body = when {
                request.path == listOf("workspaces", "w1") && request.method == HttpMethod.GET -> buildJsonObject {
                    put("id", "w1"); put("name", "board"); put("enabled", true); put("repoUrl", "https://github.com/owner/repo.git")
                    put("landing", landingBlock)
                }.toString()
                request.path == listOf("workspaces", "w1") && request.method == HttpMethod.PATCH -> {
                    writes += "w1" to Wire.json.parseToJsonElement(request.body!!.decodeToString()).jsonObject
                    "{}"
                }
                else -> "[]"
            }
            return ApiResponse(200, body.encodeToByteArray())
        }
    }

    private fun openSettings(block: JsonObject, record: String? = null) {
        val session = (compose.activity.application as OrbitApplication).session
        compose.waitUntil(60_000) { session.state.value is AuthState.SignedOut }
        runBlocking { session.login(ServerAddress.parse("https://fixture.test"), "owner@example.test", "fixture-password") }
        val api = ManagementApi(stub(block), (session.state.value as AuthState.SignedIn).handle)
        compose.activityRule.scenario.onActivity { activity -> activity.setContent { OrbitTheme {
            SettingsScreen(api, OrbitRoute(Destination.SETTINGS, "workspace", "w1", recordId = record), 0, { opened += it }, {}, logout = {}, changed = {},
                workspaceDeleted = {}, deviceAlerts = { true }, notifications = {}, about = {})
        } } }
        compose.waitUntil(60_000) { compose.onAllNodesWithTag("landing-setting").fetchSemanticsNodes().isNotEmpty() ||
            compose.onAllNodesWithTag("landing-setting:not-github").fetchSemanticsNodes().isNotEmpty() }
    }

    @Test fun theSectionOffersBothChoicesInTheBoardsWords() {
        openSettings(settings("pullRequest"))
        compose.onNodeWithText(WorkspaceLandingWords.SECTION).performScrollTo().assertIsDisplayed()
        compose.onNodeWithText(WorkspaceLandingWords.PULL_REQUEST_BODY).assertExists()
        compose.onNodeWithText(WorkspaceLandingWords.PUSH_AS_ME_BODY).assertExists()
        compose.onNodeWithTag("landing-setting:PULL_REQUEST:badge", useUnmergedTree = true).assertTextEquals("Default")
        compose.onNodeWithTag("landing-setting:PUSH_AS_ME:badge", useUnmergedTree = true).assertTextEquals("Faster")
        compose.onNodeWithTag("landing-setting:PULL_REQUEST").assertIsSelected()
        compose.onNodeWithTag("landing-setting:PUSH_AS_ME").assertIsNotSelected().assertIsEnabled()
        assertTrue(WorkspaceLandingWords.PUSH_AS_ME_BODY.contains("doesn't wait for a pull request"))
        assertTrue(WorkspaceLandingWords.PUSH_AS_ME_BODY.contains("Needs the right to push to main"))
    }

    @Config(qualifiers = "w411dp-h420dp-xxhdpi")
    @Test fun withoutTheLinkTheNoticeUnderTheChoicesIsBelowTheFirstScreen() {
        openSettings(settings("permissionsPending"))
        compose.onNodeWithTag("landing-setting:permissions-pending").assertIsNotDisplayed()
    }

    @Config(qualifiers = "w411dp-h420dp-xxhdpi")
    @Test fun theTipsLinkOpensTheSettingsScrolledToTheLandingSection() {
        val route = io.orbitd.android.reader.landingSettingsRoute("w1")
        assertEquals("landing", route.recordId)
        openSettings(settings("permissionsPending"), route.recordId)
        compose.waitUntil(30_000) { runCatching { compose.onNodeWithTag("landing-setting:permissions-pending").assertIsDisplayed() }.isSuccess }
    }

    @Test fun choosingPushAsMeIsWrittenAlone() {
        openSettings(settings("pullRequest"))
        compose.onNodeWithTag("landing-setting:PUSH_AS_ME").performScrollTo().performClick()
        compose.waitUntil(60_000) { writes.isNotEmpty() }
        assertEquals("w1" to buildJsonObject { put("landingMode", "PUSH_AS_ME") }, writes.single())
        compose.onNodeWithTag("landing-setting:PUSH_AS_ME").assertIsSelected()
    }

    @Test fun aRefusedPushIsExplainedAndOffersToConnectAgain() {
        openSettings(settings("refused"))
        compose.onNodeWithTag("landing-setting:PUSH_AS_ME").assertIsSelected()
        compose.onNodeWithTag("landing-setting:refused").performScrollTo().assertIsDisplayed()
        // The notice is one box: its bold lead, the sentence and the link are all inside it.
        for (inside in listOf(WorkspaceLandingWords.REFUSED, WorkspaceLandingWords.CONNECT_AGAIN))
            compose.onNode(hasText(inside, substring = true) and hasAnyAncestor(hasTestTag("landing-setting:refused")), useUnmergedTree = true).assertExists()
        compose.onNodeWithText(WorkspaceLandingWords.CONNECT_AGAIN).performClick()
        assertEquals(OrbitRoute(Destination.SETTINGS, "github"), opened.last())
    }

    @Test fun pendingPermissionsAreNamedWithTheirReviewLink() {
        openSettings(settings("permissionsPending"))
        compose.onNodeWithTag("landing-setting:permissions-pending").performScrollTo().assertIsDisplayed()
        compose.onNode(hasText(WorkspaceLandingWords.REVIEW) and hasAnyAncestor(hasTestTag("landing-setting:permissions-pending")), useUnmergedTree = true).assertExists()
        compose.onNodeWithText("Landing through pull requests starts once owner accepts Orbit's updated GitHub permissions.", substring = true).assertExists()
        compose.onNodeWithText(WorkspaceLandingWords.REVIEW).assertExists()
    }

    @Test fun withoutGitHubPushAsMeCannotBeChosenAndSaysWhy() {
        openSettings(settings("notConnected"))
        compose.onNodeWithTag("landing-setting:PUSH_AS_ME").performScrollTo().assertIsNotEnabled()
        compose.onNodeWithText(WorkspaceLandingWords.NOT_CONNECTED).assertExists()
        compose.onNodeWithText(WorkspaceLandingWords.CONNECT).performClick()
        assertEquals(OrbitRoute(Destination.SETTINGS, "github"), opened.last())
    }

    @Test fun aWorkspaceNotFromGitHubHasNoChoice() {
        openSettings(settings("notFromGithub"))
        compose.onNodeWithTag("landing-setting:not-github").performScrollTo().assertTextEquals(WorkspaceLandingWords.NOT_GITHUB)
        compose.onAllNodesWithTag("landing-setting:PUSH_AS_ME").assertCountEquals(0)
    }
}
