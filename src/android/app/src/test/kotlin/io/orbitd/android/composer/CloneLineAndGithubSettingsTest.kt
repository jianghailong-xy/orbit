package io.orbitd.android.composer

import android.content.ComponentName
import androidx.activity.ComponentActivity
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.platform.UriHandler
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.unit.dp
import io.orbitd.android.management.GithubCopy
import io.orbitd.android.management.GithubSettingsPage
import io.orbitd.android.ui.OrbitTheme
import org.junit.Assert.*
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
 * A GitHub workspace's first line while its clone runs, when it failed (three ways) and once it is done (board 01 P5; web
 * `CreatedWorkspaceLine.tsx`), and Settings → GitHub (board 02; web `GithubIntegrationPage.tsx`). Each state is drawn to a PNG.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = io.orbitd.android.management.ManagementShellApplication::class, qualifiers = "w411dp-h900dp-xhdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class CloneLineAndGithubSettingsTest {
    @get:Rule(order = 0) val host = object : ExternalResource() {
        override fun before() {
            val app = RuntimeEnvironment.getApplication()
            shadowOf(app.packageManager).addActivityIfNotPresent(ComponentName(app, ComponentActivity::class.java))
        }
    }
    @get:Rule(order = 1) val compose = createAndroidComposeRule<ComponentActivity>()

    private val opened = CopyOnWriteArrayList<String>()
    private val retried = CopyOnWriteArrayList<String>()

    private fun page(content: @Composable () -> Unit) = compose.setContent {
        OrbitTheme(darkTheme = false) {
            CompositionLocalProvider(LocalUriHandler provides object : UriHandler { override fun openUri(uri: String) { opened += uri } }) {
                Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) { content() }
            }
        }
    }

    private fun line(state: String?, error: String? = null, repoUrl: String? = "https://github.com/orbit-labs/orbit-web.git") =
        CreatedWorkspaceLine("w1", "orbit-web", "orbit@austin", "/Users/austin/orbit-repos/orbit-web", live = true,
            repository = WorkspaceClone.repositoryOf(repoUrl), cloneState = state, cloneError = error)

    @Composable
    private fun Line(line: CreatedWorkspaceLine, clone: CloneHeard?, github: GithubSource) {
        CreatedWorkspaceLineView(line, settingsEnabled = true, onRename = {}, onOpenSettings = {}, clone = clone, github = github,
            onRetry = { github.retryClone(line.workspaceId); retried += line.workspaceId })
    }

    @Test fun whileItClonesTheLineSaysSoWithGitsPercentage() {
        val github = FakeGithub(FakeGithub.connected())
        page {
            Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Line(line("PENDING"), WorkspaceClone.now("PENDING", null), github)
                HorizontalDivider()
                Line(line("CLONING"), WorkspaceClone.now("CLONING", CloneHeard(CloneState.CLONING, 42, 5), 1), github)
            }
        }
        compose.ghAwait(MachineSetupCopy.CLONE_WAITING)
        compose.ghAwait(MachineSetupCopy.CLONE_CLONING)
        compose.ghAwait("42%")
        compose.onAllNodesWithTag("created-workspace-clone-bar", useUnmergedTree = true).assertCountEquals(1)
        compose.onAllNodesWithText("orbit@austin", substring = true, useUnmergedTree = true).fetchSemanticsNodes().let { assertEquals(2, it.size) }
        compose.onAllNodesWithText(MachineSetupCopy.CREATED_WORKSPACE, substring = true).assertCountEquals(0)
        compose.ghShot("06-clone-line-waiting-and-cloning-42")
    }

    @Test fun aFailedCloneSaysWhyInOneOfThreeWaysAndRetries() {
        val github = FakeGithub(FakeGithub.connected())
        val failed = CloneHeard(CloneState.FAILED)
        page {
            Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Line(line("FAILED", "fatal: could not read from remote repository  "), failed, github)
                HorizontalDivider()
                Line(line("FAILED", "Orbit's GitHub App is no longer installed on orbit-labs/orbit-web."), failed, github)
                HorizontalDivider()
                Line(line("FAILED", "GitHub no longer accepts your sign-in. Connect GitHub in Settings."), failed, github)
                HorizontalDivider()
                Line(line("FAILED", null), failed, github)
            }
        }
        compose.ghAwait(MachineSetupCopy.cloneCouldNot("orbit-labs/orbit-web", "fatal: could not read from remote repository."))
        compose.ghAwait(MachineSetupCopy.cloneAppRemoved("orbit-labs/orbit-web"))
        compose.ghAwait(MachineSetupCopy.CLONE_SIGN_IN_EXPIRED)
        compose.ghAwait(MachineSetupCopy.CLONE_RECONNECT)
        // The install link waits on the integration's installUrl.
        compose.waitUntil(10_000) { compose.onAllNodesWithTag("clone-install", useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty() }
        // No reason read yet: no colon left hanging.
        compose.onAllNodesWithTag("created-workspace-clone-reason", useUnmergedTree = true)[3]
            .assertTextEquals("⚠ Couldn’t clone orbit-labs/orbit-web.")
        compose.onAllNodesWithTag("clone-retry", useUnmergedTree = true).assertCountEquals(4)
        compose.onAllNodesWithTag("clone-settings", useUnmergedTree = true).assertCountEquals(2)
        compose.ghShot("07-clone-line-failed-three-ways")

        compose.onAllNodesWithTag("clone-install", useUnmergedTree = true)[0].performClick()
        assertEquals(FakeGithub.connected().installUrl, opened.last())
        compose.onAllNodesWithTag("clone-reconnect", useUnmergedTree = true)[0].performClick()
        compose.waitUntil(10_000) { opened.size == 2 }
        assertTrue(github.calls.any { it.startsWith("start ") })
        compose.onAllNodesWithTag("clone-retry", useUnmergedTree = true)[0].performClick()
        compose.waitUntil(10_000) { retried.isNotEmpty() }
        assertEquals("retry w1", github.calls.last { it.startsWith("retry") })
    }

    @Test fun onceReadyTheCreatedLineLinksTheRepository() {
        page {
            Column(Modifier.padding(16.dp)) {
                Line(line("READY"), WorkspaceClone.now("READY", CloneHeard(CloneState.CLONING, 90, 99), 1), FakeGithub(FakeGithub.connected()))
            }
        }
        compose.ghAwait(MachineSetupCopy.CREATED_WORKSPACE)
        compose.ghAwait("· orbit-labs/orbit-web")
        compose.onAllNodesWithTag("created-workspace-clone", useUnmergedTree = true).assertCountEquals(0)
        compose.ghShot("08-created-line-ready-with-repository")
    }

    @Test fun aWorkspaceThatIsNotFromGithubDrawsTodaysLine() {
        page { Line(line(null, repoUrl = null), null, FakeGithub(FakeGithub.connected())) }
        compose.ghAwait(MachineSetupCopy.CREATED_WORKSPACE)
        compose.onAllNodesWithText("github", substring = true, ignoreCase = true).assertCountEquals(0)
    }

    @Test fun settingsShowsTheConnectionInstallationsAndWorkspacesAndDisconnects() {
        val github = FakeGithub(FakeGithub.connected())
        page { GithubSettingsPage(github) }
        compose.ghAwait(GithubCopy.ACCOUNT)
        compose.ghAwait("@ada")
        compose.ghAwait(GithubCopy.connectedSince("2026-11-03T10:00:00Z"))
        compose.ghAwait(GithubCopy.BADGE_CONNECTED)
        compose.ghAwait(GithubCopy.INSTALLED_WHERE)
        compose.ghAwait("Organization · All repositories (11)")
        compose.ghAwait("Personal account · 3 selected repositories")
        compose.ghAwait(GithubCopy.INSTALL_ON_ANOTHER)
        compose.ghAwait(GithubCopy.WORKSPACES_FROM_GITHUB)
        compose.ghAwait("Uses Orbit’s GitHub app")
        compose.ghAwait("Uses this machine’s Git credential")
        compose.ghAwait("on ci-box")
        compose.onAllNodesWithTag("github-installation", useUnmergedTree = true).assertCountEquals(2)
        compose.onAllNodesWithTag("github-workspace", useUnmergedTree = true).assertCountEquals(3)
        compose.ghShot("09-settings-github-connected")

        compose.onAllNodesWithText(GithubCopy.CONFIGURE_ON_GITHUB, substring = true)[1].performClick()
        assertEquals("https://github.com/organizations/orbit-labs/settings/installations/9", opened.last())

        compose.onNodeWithTag("github-disconnect").performClick()
        compose.ghAwait(GithubCopy.DISCONNECT_TITLE)
        compose.ghAwait(GithubCopy.disconnectWarning(2))
        compose.ghShot("10-settings-github-disconnect-confirm")
        compose.onNodeWithTag("github-disconnect-confirm").performClick()
        compose.waitUntil(10_000) { github.calls.contains("disconnect") }
        compose.ghAwait(GithubCopy.CONNECT_LEAD)
        compose.onAllNodesWithText(GithubCopy.INSTALLED_WHERE).assertCountEquals(0)
    }

    @Test fun settingsNotConnectedOffersConnectAndANotSetUpDeploymentSaysSo() {
        val github = FakeGithub(GithubIntegration(available = true, connected = false))
        page { GithubSettingsPage(github) }
        compose.ghAwait(GithubCopy.CONNECT_LEAD)
        compose.onNodeWithTag("github-connect").performClick()
        compose.waitUntil(10_000) { opened.isNotEmpty() }
        assertTrue(github.calls.contains("start ${GithubFlow.RETURN_PATH}"))
        compose.ghShot("11-settings-github-not-connected")
    }

    @Test fun settingsNotSetUpHasNoConnect() {
        page { GithubSettingsPage(FakeGithub(GithubIntegration(available = false, connected = false))) }
        compose.ghAwait(GithubCopy.GITHUB_NOT_SET_UP)
        compose.onAllNodesWithTag("github-connect").assertCountEquals(0)
    }

    @Test fun settingsNeedsReconnectAndGithubDidNotAnswer() {
        page {
            GithubSettingsPage(FakeGithub(GithubIntegration(available = true, connected = true, login = "ada", needsReconnect = true,
                installations = null)))
        }
        compose.ghAwait(GithubCopy.needsSignInAgain("ada"))
        compose.ghAwait(GithubCopy.BADGE_SIGN_IN_AGAIN)
        compose.onNodeWithTag("github-reconnect").assertExists()
        compose.onAllNodesWithText(GithubCopy.INSTALLED_WHERE).assertCountEquals(0)
    }

    @Test fun settingsSaysGithubDidNotAnswer() {
        page { GithubSettingsPage(FakeGithub(FakeGithub.connected().copy(installations = null))) }
        compose.ghAwait(GithubCopy.NO_ANSWER)
    }

    @Test fun aLoadFailureRetries() {
        var fail = true
        val github = object : GithubSource by FakeGithub(FakeGithub.connected()) {
            override suspend fun integration(): GithubIntegration {
                if (fail) throw IllegalStateException("down")
                return FakeGithub.connected()
            }
        }
        page { GithubSettingsPage(github) }
        compose.ghAwait(GithubCopy.LOAD_FAILED)
        fail = false
        compose.onNodeWithTag("github-retry").performClick()
        compose.ghAwait(GithubCopy.ACCOUNT)
    }
}
