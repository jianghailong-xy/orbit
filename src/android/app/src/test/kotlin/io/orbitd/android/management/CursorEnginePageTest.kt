package io.orbitd.android.management

import android.content.ClipboardManager
import android.content.ComponentName
import android.content.Context
import androidx.activity.ComponentActivity
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.semantics.SemanticsProperties
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
import java.time.Instant

/**
 * Cursor CLI on a machine's pages over the controlled server (the owner's board, iOS 2 and 3; web P7a): its row, last among the
 * engines, with its accounts and the next one's month; its engine page with each account's plan and included usage, the build Orbit
 * pins, Add Account's sign-in link with how long it lasts and a new one once it has expired; and the states a machine can't run it in,
 * each with what fixes it.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = ManagementShellApplication::class)
class CursorEnginePageTest {
    @get:Rule(order = 0) val host = object : ExternalResource() {
        override fun before() {
            val app = RuntimeEnvironment.getApplication()
            shadowOf(app.packageManager).addActivityIfNotPresent(ComponentName(app, ComponentActivity::class.java))
        }
    }
    @get:Rule(order = 1) val compose = createAndroidComposeRule<ComponentActivity>()
    private val fixture = ManagementFixture
    private val now = Instant.now()
    private fun at(minutes: Long) = now.plusSeconds(minutes * 60).toString()

    @Before fun start() { fixture.reset() }

    private var record by mutableStateOf<String?>(null)
    private var revision by mutableLongStateOf(0L)
    private var shownOnce = false
    private fun page(where: String?) {
        record = where; revision++
        if (!shownOnce) {
            shownOnce = true
            val session = fixture.session()
            runBlocking { fixture.signIn(session) }
            val api = ManagementApi(session, (session.state.value as AuthState.SignedIn).handle)
            compose.setContent { RunnerScreen(api, fixture.RUNNER, record, revision, {}, {}, {}) }
        }
        compose.waitForIdle()
    }
    private fun await(text: String) = compose.waitUntil(60_000) { compose.onAllNodesWithText(text, substring = true).fetchSemanticsNodes().isNotEmpty() }
    private fun shown(text: String) = compose.onAllNodesWithText(text, substring = true).fetchSemanticsNodes().size
    private fun until(condition: () -> Boolean) {
        val end = System.currentTimeMillis() + 60_000
        while (!condition()) {
            assertTrue("still waiting after 60 s", System.currentTimeMillis() < end)
            compose.mainClock.advanceTimeBy(250); compose.waitForIdle()
        }
    }
    private fun click(matcher: SemanticsMatcher) {
        compose.waitUntil(60_000) { compose.onAllNodes(matcher).fetchSemanticsNodes().isNotEmpty() }
        val node = compose.onAllNodes(matcher).onFirst()
        try { node.performScrollTo() } catch (_: AssertionError) { }
        node.performClick()
        compose.waitForIdle()
    }

    private val caps = """"provider:cursor","cursor-account-login/v1""""
    /** box as the board draws hpc: Cursor CLI's pinned build, Default on the Free plan and Team on Pro, a third of its month used. */
    private fun twoAccounts() {
        fixture.runnerEngines = """[{"engine":"claude","installed":true,"version":"2.1.302","auth":"yes"},
            {"engine":"cursor","installed":true,"version":"2026.10.14-941492e","auth":"yes","update":{"status":"checked","at":"${at(-6)}","okAt":"${at(-6)}"},
              "accounts":[{"id":"default","auth":"yes","home":"/root/.orbit/cursor/default"},
                {"id":"5c2e91a0","name":"Team","auth":"yes","home":"/root/.orbit/cursor-accounts/5c2e91a0"}]}]"""
        fixture.runnerExtra = ""","capabilities":[$caps],"planUsage":{"cursor":{"provider":"cursor","account":"default","planName":"Free",
            "includedUsage":{"startsAt":"${at(-30 * 24 * 60)}","resetsAt":"${at(6 * 24 * 60)}"},
            "accounts":{"5c2e91a0":{"provider":"cursor","account":"5c2e91a0","planName":"Pro",
              "includedUsage":{"period":"monthly","startsAt":"${at(-15 * 24 * 60)}","resetsAt":"${at(5 * 24 * 60)}","percentUsed":34}}}}}"""
    }

    /** iOS 2 ②: the machine's Cursor CLI row comes last, says how many accounts are signed in, the next one and its month — and the
     * footer says Cursor CLI is the one CLI kept on a pinned build. */
    @Test fun theMachinesRowCountsItsAccountsAndShowsTheNextOnesMonth() {
        twoAccounts()
        page(null)
        await("2 accounts signed in")
        await("Next: Team")
        await("Monthly limit")
        assertEquals(1, shown("34%"))
        assertEquals(1, shown(CursorCopy.ENGINES_FOOTER))
        val rows = compose.onAllNodes(hasTestTag("engine-row:claude") or hasTestTag("engine-row:cursor")).fetchSemanticsNodes()
        assertEquals(listOf("engine-row:claude", "engine-row:cursor"), rows.map { it.config[SemanticsProperties.TestTag] })
        assertTrue("Cursor CLI's row after Claude Code's", rows[0].positionInRoot.y < rows[1].positionInRoot.y)
    }

    /** iOS 2 ③: the engine page lists each account with its plan before its directory — Default's usage unavailable rather than 0%,
     * Team's month as a reading and NEXT — Add Account, and the footer on the pinned build; nothing offers to update Cursor CLI. */
    @Test fun theEnginePageListsEachAccountWithItsPlanAndItsUsage() {
        twoAccounts()
        page("engine:cursor")
        await("pinned · checked 6m ago")
        await("Free plan · ~/.orbit/cursor/default")
        await("Pro plan · ~/.orbit/cursor-accounts/5c2e91a0")
        compose.onNodeWithTag("cursor-usage-unavailable")
            .assertTextEquals("Free plan · Usage unavailable — Cursor doesn’t report how much of the Free plan’s usage is left, so Orbit shows no number rather than 0%.")
        assertEquals("NEXT beside Team", 1, shown("NEXT"))
        assertEquals(1, shown("Monthly limit"))
        assertEquals("never a 0% drawn", 0, compose.onAllNodesWithText("0%").fetchSemanticsNodes().size)
        await("Add Account")
        compose.onNodeWithTag("cursor-engine-footer").assertTextEquals(CursorCopy.ENGINE_FOOTER)
        assertEquals(0, shown(RunnerCopy.UPDATE_ENGINES_NOW))
    }

    /** iOS 3 ①②③④⑤: Add Account names the account, starts Cursor's sign-in, and offers its link — on this phone or another device —
     * with how long it lasts; once it expired, the runner's words and a new link. */
    @Test fun addAccountOffersTheLinkWithItsTimeAndANewOneOnceItExpired() {
        twoAccounts()
        val link = "https://cursor.com/loginDeepControl?challenge=Q2hhbGxlbmdl&uuid=7d2e&mode=login&redirectTarget=cli"
        fixture.loginStarted = """{"status":"awaiting_approval","engine":"cursor","url":"$link","expiresAt":"${at(23)}"}"""
        page("engine:cursor")
        click(hasText("Add Account") and hasClickAction())
        await("Sign in on cursor.com with the account you are adding:")
        assertEquals(buildJsonObject { put("engine", "cursor"); put("accountName", "Account 3") }, fixture.loginBodies.single())
        await("Waiting for you to sign in… · link expires in 23 min")
        assertEquals(1, shown("Open cursor.com"))
        click(hasText("Copy Sign-In Link") and hasClickAction())
        await("Sign-In Link Copied")
        val clip = (RuntimeEnvironment.getApplication().getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager).primaryClip
        assertEquals(link, clip?.getItemAt(0)?.text?.toString())
        // The link ran out before anyone used it: the runner says so, and a new run of the sign-in hands a new one.
        fixture.loginRelay = """{"status":"failed","engine":"cursor","reason":"expired","message":"The sign-in link expired before anyone signed in with it."}"""
        until { shown("The sign-in link expired before anyone signed in with it.") > 0 }
        click(hasText(CursorCopy.GET_A_NEW_LINK) and hasClickAction())
        until { fixture.loginBodies.size == 2 }
        assertEquals("cursor", fixture.loginBodies.last()["engine"]?.jsonPrimitive?.content)
    }

    /** iOS 3 ⑦⑧: Sign In Again on a signed-in account is the same link card, for this account. */
    @Test fun signInAgainOffersTheSameLinkForThisAccount() {
        twoAccounts()
        fixture.loginStarted = """{"status":"awaiting_approval","engine":"cursor","account":"5c2e91a0","url":"https://cursor.com/loginDeepControl?challenge=x",
            "expiresAt":"${at(26)}"}"""
        page("engine:cursor")
        click(hasContentDescription("More for Team"))
        click(hasText(AccountCopy.SIGN_IN_AGAIN))
        await("Sign in on cursor.com with this account again:")
        await("link expires in 26 min")
        assertEquals(buildJsonObject { put("engine", "cursor"); put("account", "5c2e91a0") }, fixture.loginBodies.single())
    }

    /** iOS 2's states: a build other than the pinned one is put back with Reinstall; a missing one installed with Install; a runner
     * that predates Cursor CLI says it updates itself, with nothing to press. */
    @Test fun aMachineThatCantRunCursorCliSaysWhyAndOffersWhatFixesIt() {
        fixture.runnerEngines = """[{"engine":"cursor","installed":true,"version":"2026.10.16-e3cb207",
            "installationError":"CURSOR_VERSION_INCOMPATIBLE: Cursor CLI 2026.10.16-e3cb207 is installed, and Orbit runs exactly 2026.10.14-941492e"}]"""
        fixture.runnerExtra = ""","capabilities":["cursor-account-login/v1"]"""
        page("engine:cursor")
        await("Unsupported version")
        await("Orbit runs Cursor CLI 2026.10.14-941492e. Reinstall puts that version back on this runner; sessions here can’t start until then.")
        assertEquals("no accounts on a build it won't run", 0, shown("Add Account"))
        click(hasText(CursorCopy.REINSTALL) and hasClickAction())
        until { fixture.installBodies.isNotEmpty() }
        assertEquals(buildJsonObject { put("engine", "cursor") }, fixture.installBodies.single())

        fixture.runnerEngines = """[{"engine":"cursor","installed":false,"installationError":"CURSOR_NOT_INSTALLED: Cursor CLI 2026.10.14-941492e is not installed"}]"""
        fixture.runnerExtra = ""","capabilities":[$caps]"""
        fixture.installBodies.clear()
        page("engine:cursor")
        await("Install Cursor CLI")
        click(hasText("Install Cursor CLI") and hasClickAction())
        until { fixture.installBodies.isNotEmpty() }
        assertEquals(buildJsonObject { put("engine", "cursor") }, fixture.installBodies.single())
    }

    @Test fun aRunnerThatPredatesCursorCliSaysItUpdatesItself() {
        // The account's other machine knows Cursor CLI, so this one draws its row too: it can't run it until it updates.
        fixture.secondRunner = true
        fixture.runnerTwoExtra = ""","capabilities":["provider:cursor"]"""
        fixture.runnerEngines = """[{"engine":"claude","installed":true,"version":"2.1.302","auth":"yes"}]"""
        page(null)
        await("Update runner")
        await("This runner predates Cursor CLI. It updates itself when no session is running on it.")
        compose.onNodeWithTag("cursor-state-hint", useUnmergedTree = true).assertExists()
        page("engine:cursor")
        compose.waitUntil(60_000) { compose.onAllNodes(hasTestTag("cursor-state")).fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithTag("cursor-state").assertTextEquals("Update runner")
        assertEquals(0, shown("Install Cursor CLI"))
        assertEquals(0, shown(CursorCopy.REINSTALL))
    }
}
