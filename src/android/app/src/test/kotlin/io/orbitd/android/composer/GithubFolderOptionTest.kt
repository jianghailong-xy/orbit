package io.orbitd.android.composer

import android.content.ComponentName
import androidx.activity.ComponentActivity
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.platform.UriHandler
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import io.orbitd.android.core.auth.AuthState
import io.orbitd.android.management.ManagementApi
import io.orbitd.android.management.ManagementFixture
import io.orbitd.android.ui.OrbitTheme
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonObject
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
import org.robolectric.annotation.GraphicsMode
import java.util.concurrent.CopyOnWriteArrayList

/**
 * The setup card's From GitHub option (board 01 P1–P4, web `GithubFolderOption.tsx`): offered only where the deployment has the App,
 * Connect until the account is connected, the repository list, a picked repository with its folder's verdict, and what Use This
 * Repository picks. Each state is drawn to a PNG.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = io.orbitd.android.management.ManagementShellApplication::class, qualifiers = "w411dp-h1100dp-xhdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class GithubFolderOptionTest {
    @get:Rule(order = 0) val host = object : ExternalResource() {
        override fun before() {
            val app = RuntimeEnvironment.getApplication()
            shadowOf(app.packageManager).addActivityIfNotPresent(ComponentName(app, ComponentActivity::class.java))
        }
    }
    @get:Rule(order = 1) val compose = createAndroidComposeRule<ComponentActivity>()

    private val opened = CopyOnWriteArrayList<String>()
    private val picks = CopyOnWriteArrayList<PickedFolder?>()
    private val probed = CopyOnWriteArrayList<String>()
    private val settingsOpened = CopyOnWriteArrayList<Unit>()

    @Before fun reset() = ManagementFixture.reset()

    private fun api(): ManagementApi {
        val session = ManagementFixture.session()
        runBlocking { ManagementFixture.signIn(session) }
        return ManagementApi(session, (session.state.value as AuthState.SignedIn).handle)
    }

    /** The machine's answer about a folder: `orbit-web` is there already, anything else is free. */
    private suspend fun probe(path: String): DirProbeRelay.Outcome {
        probed += path
        val taken = path.endsWith("/orbit-web")
        return DirProbeRelay.Outcome.Answered(DirProbe(path, exists = taken, isDir = taken, isGit = taken, isHome = false))
    }

    private fun card(github: FakeGithub, runner: JsonObject = cloningRunner(), state: MachineSetupState = MachineSetupState(),
                     ready: Boolean = false) {
        val api = api()
        compose.setContent {
            OrbitTheme(darkTheme = false) {
                CompositionLocalProvider(LocalUriHandler provides object : UriHandler { override fun openUri(uri: String) { opened += uri } }) {
                    Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
                        var shown by androidx.compose.runtime.remember { mutableStateOf(state) }
                        Column(Modifier.verticalScroll(rememberScrollState()).padding(14.dp)) {
                            MachineSetupCard(
                                runner = runner, online = true, state = shown, engine = "claude", credential = SetupCredential.SignedIn,
                                ready = ready, otherEngines = emptyList(), keyToUse = null, managementApi = api,
                                probeDir = { path, _ -> probe(path) },
                                onPickFolder = { picks += it; shown = shown.pick(it) },
                                onUseEngine = {}, onUseKey = {}, onOpenMachine = {}, onSignedIn = {},
                                github = github, onOpenGithubSettings = { settingsOpened += Unit },
                            )
                        }
                    }
                }
            }
        }
    }

    private fun chooseFromGithub() {
        compose.ghAwait(MachineSetupCopy.SETUP_FROM_GITHUB)
        compose.onNodeWithText(MachineSetupCopy.SETUP_FROM_GITHUB, useUnmergedTree = true).performClick()
        compose.waitForIdle()
    }

    private fun useButton() = compose.onNode(hasText(MachineSetupCopy.SETUP_USE_REPOSITORY) and hasClickAction())

    @Test fun notOfferedWhereTheDeploymentHasNoApp() {
        card(FakeGithub(GithubIntegration(available = false, connected = false)))
        compose.ghAwait(MachineSetupCopy.SETUP_NEW_FOLDER)
        compose.waitForIdle()
        compose.onAllNodesWithText(MachineSetupCopy.SETUP_FROM_GITHUB, useUnmergedTree = true).assertCountEquals(0)
    }

    @Test fun notConnectedOffersConnectAndStaysChosenAcrossTheTripToGithub() {
        val github = FakeGithub(GithubIntegration(available = true, connected = false))
        card(github)
        chooseFromGithub()
        compose.ghAwait(MachineSetupCopy.SETUP_GITHUB_META)
        compose.ghAwait(MachineSetupCopy.SETUP_CONNECT_GITHUB_META)
        compose.onNodeWithText(MachineSetupCopy.SETUP_NEW_TAG).assertExists()
        useButton().assertIsNotEnabled()
        compose.ghShot("01-from-github-not-connected")

        compose.onNodeWithTag("setup-github-connect").performClick()
        compose.waitUntil(10_000) { opened.isNotEmpty() }
        assertEquals("start ${GithubFlow.RETURN_PATH}", github.calls.first { it.startsWith("start") })
        assertEquals("https://github.com/login/oauth/authorize?client_id=fixture", opened.single())

        // GitHub's sign-in in the browser; the app comes back to the front connected.
        github.view = FakeGithub.connected()
        compose.activityRule.scenario.moveToState(Lifecycle.State.CREATED)
        compose.activityRule.scenario.moveToState(Lifecycle.State.RESUMED)
        compose.ghAwait(MachineSetupCopy.setupGithubAccount("ada", 14))
        compose.onNode(hasText(MachineSetupCopy.SETUP_FROM_GITHUB, substring = true) and isSelected(), useUnmergedTree = false).assertExists()
    }

    @Test fun needsReconnectSaysWhoAndAFailedStartSaysWhy() {
        val github = FakeGithub(GithubIntegration(available = true, connected = true, login = "ada", needsReconnect = true), failStart = "GitHub is down")
        card(github, runner = cloningRunner(clones = false))
        chooseFromGithub()
        compose.ghAwait(MachineSetupCopy.setupGithubSignInAgain("ada"))
        compose.ghAwait(MachineSetupCopy.SETUP_RECONNECT_GITHUB)
        compose.ghAwait(MachineSetupCopy.setupCloneUpdating("orbit@austin"))
        compose.onNodeWithTag("setup-github-connect").performClick()
        compose.ghAwait(MachineSetupCopy.setupGithubConnectFailed("Couldn't load this from Orbit. Please try again."))
        assertTrue(opened.isEmpty())
    }

    @Test fun theListShowsTheFirstEightThenWhatTheSearchFinds() {
        val github = FakeGithub(FakeGithub.connected())
        card(github)
        chooseFromGithub()
        compose.ghAwait("orbit-web")
        compose.ghAwait(MachineSetupCopy.setupGithubAccount("ada", 14))
        compose.ghAwait(MachineSetupCopy.SETUP_GITHUB_ADD_REPOSITORIES)
        compose.onAllNodesWithTag("setup-github-repo", useUnmergedTree = true).assertCountEquals(MachineSetup.FIRST_REPOSITORIES)
        compose.onAllNodesWithContentDescription(MachineSetupCopy.SETUP_GITHUB_PRIVATE, useUnmergedTree = true).fetchSemanticsNodes()
            .let { assertEquals(4, it.size) }
        compose.ghShot("02-from-github-repo-list")

        compose.onNodeWithTag("setup-github-settings").performClick()
        assertEquals(1, settingsOpened.size)

        compose.onNodeWithTag("setup-github-search").performTextInput("site")
        compose.waitUntil(10_000) { github.calls.contains("repos?q=site") }
        compose.waitUntil(10_000) { compose.onAllNodesWithTag("setup-github-repo", useUnmergedTree = true).fetchSemanticsNodes().size == 2 }
        compose.onNodeWithTag("setup-github-search").performTextReplacement("nothing-like-it")
        compose.ghAwait(MachineSetupCopy.SETUP_GITHUB_NONE)
    }

    @Test fun aListGitHubRefusesSaysWhy() {
        card(FakeGithub(FakeGithub.connected(), failList = "rate limited"))
        chooseFromGithub()
        compose.ghAwait(MachineSetupCopy.setupGithubListFailed("Couldn't load this from Orbit. Please try again."))
    }

    @Test fun aPickedRepositoryIsClonedOnlyIntoAFolderThatIsNotThere() {
        val github = FakeGithub(FakeGithub.connected())
        card(github)
        chooseFromGithub()
        compose.ghAwait("orbit-web")
        compose.onAllNodesWithTag("setup-github-repo", useUnmergedTree = true)[0].performClick()
        compose.waitForIdle()
        // Its folder by default is its name, which is there already on this machine.
        compose.ghAwait(MachineSetupCopy.setupGithubFolderExists("orbit@austin"))
        compose.ghAwait(MachineSetupCopy.SETUP_GITHUB_CLONED_META)
        assertTrue(probed.contains("/Users/austin/orbit-repos/orbit-web"))
        useButton().assertIsNotEnabled()
        compose.ghShot("03-from-github-picked-folder-exists")

        compose.onNodeWithTag("setup-github-folder").performTextReplacement("bad/name")
        compose.ghAwait(MachineSetupCopy.SETUP_NEW_FOLDER_INVALID)
        useButton().assertIsNotEnabled()

        compose.onNodeWithTag("setup-github-folder").performTextReplacement("orbit-web-2")
        compose.waitUntil(10_000) { probed.contains("/Users/austin/orbit-repos/orbit-web-2") }
        compose.waitUntil(10_000) { runCatching { useButton().assertIsEnabled() }.isSuccess }
        compose.onNodeWithTag("setup-github-other-branch").performClick()
        compose.waitUntil(10_000) { github.calls.contains("branches 101") }
        compose.ghAwait("release/1.4")
        compose.onNodeWithTag("setup-github-branch").performTextInput("de")
        compose.onNodeWithText("dev", useUnmergedTree = true).performClick()
        compose.waitForIdle()
        compose.ghShot("04-from-github-picked-free-other-branch")

        useButton().performClick()
        compose.waitForIdle()
        val picked = picks.filterNotNull().single() as PickedFolder.Github
        assertEquals(GithubPick(101, "orbit-labs/orbit-web", true, "main", "dev", "orbit-web-2", "/Users/austin/orbit-repos/orbit-web-2"), picked.pick)
        assertEquals(ghJson("""{"github":{"repoId":101,"folder":"orbit-web-2","ref":"dev"}}"""), picked.newWorkspace.toJson())
        // Picked: the step's done line.
        compose.ghAwait("orbit-labs/orbit-web → ~/orbit-repos/orbit-web-2")
        compose.ghAwait(MachineSetupCopy.SETUP_GITHUB_DONE)
    }

    @Test fun oncePickedTheCardSaysWhereTheCloneGoesAndThatItIsReady() {
        val pick = PickedFolder.Github(GithubPick(101, "orbit-labs/orbit-web", true, "main", null, "orbit-web", "/Users/austin/orbit-repos/orbit-web"))
        card(FakeGithub(FakeGithub.connected()), state = MachineSetupState(folder = pick), ready = true)
        compose.ghAwait("orbit-labs/orbit-web → ~/orbit-repos/orbit-web")
        compose.ghAwait(MachineSetupCopy.SETUP_GITHUB_DONE)
        compose.ghAwait(MachineSetupCopy.setupReadyClone("orbit-labs/orbit-web", "~/orbit-repos/orbit-web", "orbit-web"))
        compose.ghShot("05-from-github-picked-ready")
    }
}
