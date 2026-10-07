package io.orbitd.android.management

import android.content.ComponentName
import androidx.activity.ComponentActivity
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import io.orbitd.android.core.auth.AuthState
import kotlinx.coroutines.runBlocking
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

/** The pool page and the share panel over the controlled server: what they say after a failed read, and what they offer each role. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = ManagementShellApplication::class)
class ManagementPanelTest {
    /** The compose rule's host activity is not in the app's manifest; Robolectric resolves it once it is registered. */
    @get:Rule(order = 0) val host = object : ExternalResource() {
        override fun before() {
            val app = RuntimeEnvironment.getApplication()
            shadowOf(app.packageManager).addActivityIfNotPresent(ComponentName(app, ComponentActivity::class.java))
        }
    }
    @get:Rule(order = 1) val compose = createComposeRule()
    private val fixture = ManagementFixture
    private var revision by mutableLongStateOf(0L)

    @Before fun start() { fixture.reset() }

    private fun api(): ManagementApi {
        val session = fixture.session()
        runBlocking { fixture.signIn(session) }
        return ManagementApi(session, (session.state.value as AuthState.SignedIn).handle)
    }
    private fun pool(record: String) {
        val api = api()
        compose.setContent { ProviderManagement(api, revision, record, {}, {}) }
    }
    private fun await(text: String) = compose.waitUntil(10_000) { compose.onAllNodesWithText(text, substring = true).fetchSemanticsNodes().isNotEmpty() }
    private fun reread() { revision++; compose.waitForIdle() }

    @Test fun aFailedPeopleReadKeepsWhoCanUseThePoolAndSaysItFailed() {
        pool("own:${fixture.POOL}")
        await("Me and 1 person")
        fixture.accessFails = true
        reread()
        compose.waitUntil(10_000) { fixture.calls.count { it == "GET providers/shared-pools/${fixture.POOL}" } >= 2 }
        compose.waitForIdle()
        compose.onNodeWithText("Me and 1 person", substring = true).assertExists()
        // Not said to be the owner's alone: no "Just me ·" line, and the owner's mode switch is not on Just me.
        compose.onAllNodesWithText("Just me ·", substring = true).assertCountEquals(0)
        compose.onAllNodes(hasText("Just me") and isSelected()).assertCountEquals(0)
        compose.onNodeWithText("pool read failed", substring = true).assertExists()
    }

    @Test fun aPoolWhosePeopleWereNeverReadIsNotCalledJustMineAndCannotBeDeletedBlind() {
        fixture.accessFails = true
        pool("own:${fixture.POOL}")
        await("Team Codex")
        compose.waitForIdle()
        compose.onAllNodesWithText("Just me", substring = true).assertCountEquals(0)
        compose.onNodeWithText("pool read failed", substring = true).assertExists()
        compose.onNode(hasText("Delete pool") and hasClickAction()).performScrollTo().assertIsNotEnabled()
    }

    @Test fun aMemberTheRuleLeavesOutIsNotOfferedSignInAgain() {
        fixture.viewerRole = "MEMBER"; fixture.viewerCreates = false; fixture.loginState = "SIGNED_OUT"
        fixture.membersCanAddAccounts = false
        pool("shared:${fixture.POOL}")
        await("Team Codex")
        compose.waitForIdle()
        compose.onAllNodes(hasText("Sign in again") and hasClickAction() and isEnabled()).assertCountEquals(0)
    }

    @Test fun aMemberWhoMayAddAccountsButNotKeysIsNotOfferedAKey() {
        fixture.viewerRole = "MEMBER"; fixture.viewerCreates = false
        fixture.membersCanAddAccounts = true; fixture.membersCanAdd = false
        pool("shared:${fixture.POOL}")
        await("Team Codex")
        compose.onNode(hasText("Add account") and hasClickAction()).performClick()
        compose.waitForIdle()
        compose.onAllNodesWithText("Paste an OpenAI API key").assertCountEquals(0)
    }

    @Test fun anAdminWhoDidNotMakeThePoolIsNotOfferedALeaveTheServerRefuses() {
        fixture.viewerRole = "ADMIN"; fixture.viewerCreates = false
        pool("shared:${fixture.POOL}")
        await("Team Codex")
        compose.onNode(hasText("Leave pool") and hasClickAction()).performScrollTo().assertIsNotEnabled()
    }

    @Test fun aShareRefreshThatFailsStopsWritesAndOffersRetry() {
        val api = api()
        compose.setContent { ShareResourcePanel(api, revision, "SESSION", fixture.SESSION) }
        await("Tool calls and output")
        compose.onNode(hasText("Only you") and isSelectable()).assertIsEnabled()
        fixture.shareFails = true
        reread()
        compose.waitUntil(10_000) { fixture.calls.count { it == "GET sessions/${fixture.SESSION}/share" } >= 2 }
        compose.waitForIdle()
        compose.onNodeWithText("share read failed", substring = true).assertExists()
        compose.onNode(hasText("Retry") and hasClickAction()).assertExists()
        compose.onAllNodes(hasText("Only you") and isSelectable() and isEnabled()).assertCountEquals(0)
    }
}
