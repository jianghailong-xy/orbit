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
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.platform.UriHandler
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import io.orbitd.android.management.ManagementFixture
import io.orbitd.android.ui.OrbitTheme
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
 * The setup card's From GitHub (board 01 P1–P4 in board 04 A's place, web `MachineSetupCard.tsx` + `GithubFolderOption.tsx`): a row
 * under the folder's name behind an "or" rule, offered only where the deployment has the App, which swaps the step to the picker and
 * back again with Type a folder name instead;
 * Connect until the account is connected, the repository list, a picked repository with its folder's verdict, the Name following its
 * folder, and what Create workspace sends. Each state is drawn to a PNG.
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
    private val created = CopyOnWriteArrayList<Pair<PickedFolder, String>>()
    private val probed = CopyOnWriteArrayList<String>()
    private val settingsOpened = CopyOnWriteArrayList<Unit>()

    @Before fun reset() = ManagementFixture.reset()

    /** The machine's answer about a folder: `orbit-web` is there already, anything else is free. */
    private suspend fun probe(path: String): DirProbeRelay.Outcome {
        probed += path
        val taken = path.endsWith("/orbit-web")
        return DirProbeRelay.Outcome.Answered(DirProbe(path, exists = taken, isDir = taken, isGit = taken, isHome = false))
    }

    private fun card(github: FakeGithub, runner: JsonObject = cloningRunner(), online: Boolean = true) {
        compose.setContent {
            OrbitTheme(darkTheme = false) {
                CompositionLocalProvider(LocalUriHandler provides object : UriHandler { override fun openUri(uri: String) { opened += uri } }) {
                    Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
                        Column(Modifier.verticalScroll(rememberScrollState()).padding(14.dp)) {
                            MachineSetupCard(
                                runner = runner, online = online,
                                probeDir = { path, _ -> probe(path) },
                                onCreate = { folder, name -> created += folder to name },
                                creating = false, createError = null, onOpenMachine = {},
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
        compose.onNodeWithTag("setup-github-row").performClick()
        compose.waitForIdle()
    }

    private fun createButton() = compose.onNodeWithTag("setup-create")
    private fun nameField() = compose.onNodeWithTag("setup-workspace-name")

    @Test fun notOfferedWhereTheDeploymentHasNoApp() {
        card(FakeGithub(GithubIntegration(available = false, connected = false)))
        compose.ghAwait(MachineSetupCopy.SETUP_FOLDER_HINT)
        compose.waitForIdle()
        compose.onAllNodesWithText(MachineSetupCopy.SETUP_FROM_GITHUB, useUnmergedTree = true).assertCountEquals(0)
        compose.onAllNodesWithText(MachineSetupCopy.SETUP_OR, useUnmergedTree = true).assertCountEquals(0)
    }

    /** Board 04 A: the name field stays the step; From GitHub is the row under it, and the picker goes back to the name. */
    @Test fun theRowUnderTheNameSwapsTheStepToThePickerAndBack() {
        card(FakeGithub(FakeGithub.connected()))
        compose.ghAwait(MachineSetupCopy.SETUP_FROM_GITHUB)
        compose.ghAwait(MachineSetupCopy.SETUP_FOLDER_HINT)
        compose.onNodeWithText(MachineSetupCopy.SETUP_OR, useUnmergedTree = true).assertExists()
        compose.onNodeWithText(MachineSetupCopy.SETUP_GITHUB_META, useUnmergedTree = true).assertExists()
        compose.onNodeWithText(MachineSetupCopy.SETUP_NEW_TAG, useUnmergedTree = true).assertExists()
        compose.onNodeWithTag("setup-new-folder-name").assertExists()
        compose.onNodeWithTag("setup-github-row").assertIsEnabled()
        compose.ghShot("00-from-github-row")

        chooseFromGithub()
        compose.ghAwait(MachineSetupCopy.setupGithubAccount("ada", 14))
        compose.onNodeWithTag("setup-new-folder-name").assertDoesNotExist()
        compose.onNodeWithTag("setup-github-row").assertDoesNotExist()
        compose.onNodeWithText(MachineSetupCopy.SETUP_FOLDER, useUnmergedTree = true).assertExists()
        // The picker takes the folder field's place; the Name and Create workspace stay.
        nameField().assertExists()
        createButton().assertExists()

        compose.onNodeWithTag("setup-folder-name-instead").performClick()
        compose.waitForIdle()
        compose.ghAwait(MachineSetupCopy.SETUP_FOLDER_HINT)
        compose.onNodeWithTag("setup-new-folder-name").assertExists()
        compose.onNodeWithTag("setup-github-row").assertExists()
        compose.onAllNodesWithText(MachineSetupCopy.SETUP_GITHUB_SEARCH, useUnmergedTree = true).assertCountEquals(0)
    }

    /** The row is not the name field's lock: a machine too old to make folders may still clone. Only an offline one can't be asked. */
    @Test fun theRowFollowsTheMachineBeingOnlineNotTheNameFieldsLock() {
        card(FakeGithub(FakeGithub.connected()), runner = cloningRunner(makesFolders = false))
        compose.ghAwait(MachineSetupCopy.SETUP_FROM_GITHUB)
        compose.onNodeWithTag("setup-github-row").assertIsEnabled()
    }

    @Test fun anOfflineMachinesRowCannotBePressed() {
        card(FakeGithub(FakeGithub.connected()), online = false)
        compose.ghAwait(MachineSetupCopy.SETUP_FROM_GITHUB)
        compose.onNodeWithTag("setup-github-row").assertIsNotEnabled()
    }

    @Test fun notConnectedOffersConnectAndStaysChosenAcrossTheTripToGithub() {
        val github = FakeGithub(GithubIntegration(available = true, connected = false))
        card(github)
        chooseFromGithub()
        compose.ghAwait(MachineSetupCopy.SETUP_GITHUB_META)
        compose.ghAwait(MachineSetupCopy.SETUP_CONNECT_GITHUB_META)
        compose.onNodeWithText(MachineSetupCopy.SETUP_NEW_TAG).assertExists()
        // Nothing to create until the account is connected: the field offers Connect, and the way back.
        createButton().assertIsNotEnabled()
        compose.onNodeWithTag("setup-folder-name-instead").assertExists()
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
        // Still on the picker it left from, not back on the folder's name.
        compose.onNodeWithTag("setup-new-folder-name").assertDoesNotExist()
        compose.onNodeWithTag("setup-folder-name-instead").assertExists()
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
        createButton().assertIsNotEnabled()
        compose.ghShot("03-from-github-picked-folder-exists")

        compose.onNodeWithTag("setup-github-folder").performTextReplacement("bad/name")
        compose.ghAwait(MachineSetupCopy.SETUP_NEW_FOLDER_INVALID)
        createButton().assertIsNotEnabled()

        compose.onNodeWithTag("setup-github-folder").performTextReplacement("orbit-web-2")
        compose.waitUntil(10_000) { probed.contains("/Users/austin/orbit-repos/orbit-web-2") }
        compose.waitUntil(10_000) { runCatching { createButton().assertIsEnabled() }.isSuccess }
        // Found: where the clone goes, and the Name follows its folder.
        compose.ghAwait("orbit-labs/orbit-web → ~/orbit-repos/orbit-web-2")
        compose.ghAwait(MachineSetupCopy.SETUP_GITHUB_DONE)
        nameField().assert(hasText("orbit-web-2"))
        compose.onNodeWithTag("setup-github-other-branch").performClick()
        compose.waitUntil(10_000) { github.calls.contains("branches 101") }
        compose.ghAwait("release/1.4")
        compose.onNodeWithTag("setup-github-branch").performTextInput("de")
        compose.onNodeWithText("dev", useUnmergedTree = true).performClick()
        compose.waitForIdle()
        compose.ghShot("04-from-github-picked-free-other-branch")

        createButton().performClick()
        compose.waitForIdle()
        val (folder, name) = created.single()
        val picked = folder as PickedFolder.Github
        assertEquals("orbit-web-2", name)
        assertEquals(GithubPick(101, "orbit-labs/orbit-web", true, "main", "dev", "orbit-web-2", "/Users/austin/orbit-repos/orbit-web-2"), picked.pick)
        assertEquals(ghJson("""{"name":"orbit-web-2","runnerId":"r1","github":{"repoId":101,"folder":"orbit-web-2","ref":"dev"}}"""),
            MachineSetup.createWorkspaceBody(name, "r1", picked))
    }

    /** An edited Name stays the person's; Type a folder name instead drops the repository, and the Name follows the typed folder again. */
    @Test fun anEditedNameIsSentAndTheWayBackDropsTheRepository() {
        card(FakeGithub(FakeGithub.connected()))
        chooseFromGithub()
        compose.ghAwait("orbit-api")
        compose.onAllNodesWithTag("setup-github-repo", useUnmergedTree = true)[1].performClick()
        compose.ghAwait("orbit-labs/orbit-api → ~/orbit-repos/orbit-api")
        nameField().assert(hasText("orbit-api"))
        compose.ghShot("05-from-github-picked-ready")

        nameField().performTextReplacement("api")
        createButton().assertIsEnabled().performClick()
        compose.waitForIdle()
        assertEquals("api", created.single().second)
        assertEquals(ghJson("""{"github":{"repoId":102,"folder":"orbit-api"}}"""), created.single().first.newWorkspace.toJson())

        compose.onNodeWithTag("setup-folder-name-instead").performClick()
        compose.waitForIdle()
        compose.onNodeWithTag("setup-new-folder-name").assertExists()
        compose.onAllNodesWithText("orbit-labs/orbit-api → ~/orbit-repos/orbit-api", useUnmergedTree = true).assertCountEquals(0)
        createButton().assertIsNotEnabled()
    }
}
