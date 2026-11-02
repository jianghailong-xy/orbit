package io.orbitd.android.management

import android.content.ComponentName
import androidx.activity.ComponentActivity
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
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
import java.time.Instant

/**
 * The machine page of a runner whose Claude connection comes out where Anthropic doesn't offer Claude (docs/claude-region-check-contract.md,
 * board 03; iOS `RunnerDetailContent` and `RunnerEnginePage`): Needs Attention says so with Check Again; the Claude Code row says Region
 * not supported, reads no usage and names no next account, with Check Again in Sign In's place; the note under the engines says why and
 * where Claude's connection came out. Claude Code's page keeps its accounts, each saying its sign-in alone, with Check Again in Add
 * Account's place. A machine that reads no region draws what it draws today.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = ManagementShellApplication::class)
class ClaudeRegionRunnerPageTest {
    @get:Rule(order = 0) val host = object : ExternalResource() {
        override fun before() {
            val app = RuntimeEnvironment.getApplication()
            shadowOf(app.packageManager).addActivityIfNotPresent(ComponentName(app, ComponentActivity::class.java))
        }
    }
    @get:Rule(order = 1) val compose = createAndroidComposeRule<ComponentActivity>()
    private val fixture = ManagementFixture

    @Before fun start() {
        fixture.reset()
        // HPC as board 03 draws it: Claude Code with three accounts, one signed out, and a usage reading; Codex beside it.
        fixture.runnerEngines = """[{"engine":"claude","installed":true,"version":"2.1.302 (Claude Code)","auth":"yes",
            "accounts":[{"id":"default","name":"Personal","home":"/root/.claude","auth":"yes"},
                        {"id":"3c5e8a10","name":"Work","home":"/root/.orbit/claude-accounts/3c5e8a10","auth":"yes"},
                        {"id":"8f21b6d4","name":"Team","home":"/root/.orbit/claude-accounts/8f21b6d4","auth":"no"}]},
            {"engine":"codex","installed":true,"version":"codex-cli 0.164.0","auth":"yes"}]"""
    }

    private val checkedAt = Instant.now().minusSeconds(150).toString()
    private fun region(checked: String = checkedAt) =
        """{"verdict":"blocked","country":"CN","regionCode":null,"name":"mainland China","viaProxy":false,"checkedAt":"$checked"}"""
    private fun machine(region: String?) {
        fixture.runnerExtra = ""","capabilities":["claude-region/v1"],"planUsage":{"provider":"claude",
            "fiveHour":{"utilization":66,"resetsAt":"${Instant.now().plusSeconds(3_600)}"},"sevenDay":{"utilization":12}}""" +
            (region?.let { ""","region":$it""" } ?: "")
    }

    /** The runner's page, or [record]'s (an engine's), on the fixture's runner. */
    private fun page(record: String? = null) {
        val session = fixture.session()
        runBlocking { fixture.signIn(session) }
        val api = ManagementApi(session, (session.state.value as AuthState.SignedIn).handle)
        compose.setContent { RunnerScreen(api, fixture.RUNNER, record, 0, {}, {}, {}) }
        compose.waitForIdle()
    }
    private fun await(text: String) = compose.waitUntil(60_000) { compose.onAllNodesWithText(text, substring = true).fetchSemanticsNodes().isNotEmpty() }
    private fun shown(text: String, substring: Boolean = true) =
        compose.onAllNodesWithText(text, substring = substring, useUnmergedTree = true).fetchSemanticsNodes().size
    private val checkAgain = hasText("Check Again") and hasClickAction()
    private val checks get() = fixture.calls.count { it == "POST runners/${fixture.RUNNER}/region-check" }

    @Test fun theMachinePageSaysWhereWithCheckAgainOnTheItemAndTheClaudeCodeRow() {
        machine(region())
        page()
        await("Claude Code can’t use Anthropic here")
        assertEquals(1, shown("Anthropic doesn’t offer Claude in mainland China."))
        // The Claude Code row: its version and Region not supported, Check Again where Sign In was, no usage and no next account.
        assertEquals(1, shown("2.1.302 · Region not supported", substring = false))
        assertEquals("one on the item, one under the row", 2, compose.onAllNodes(checkAgain).fetchSemanticsNodes().size)
        assertEquals(1, compose.onAllNodes(hasTestTag("engine-row:claude:check-again"), useUnmergedTree = true).fetchSemanticsNodes().size)
        assertEquals(0, shown(RunnerCopy.SIGN_IN, substring = false))
        assertEquals(0, shown("5-hour limit"))
        assertEquals(0, shown("Next:"))
        // Codex on the same machine is untouched.
        assertEquals(1, shown("0.164.0 · Signed in", substring = false))
        // Under the engines, the note — not that a session spends a subscription signed in here.
        assertEquals(1, shown("Claude’s connection from this machine is in mainland China, where Anthropic doesn’t offer Claude, so Orbit won’t use " +
            "Anthropic accounts or keys here, or start a Claude sign-in. Claude Code still runs with other providers’ keys. Supported regions", substring = false))
        assertEquals(1, shown("Checked 2m ago · Claude’s connection: mainland China (no proxy)", substring = false))
        assertEquals(0, shown(RunnerCopy.ENGINES_FOOTER))
        // Each Check Again asks the runner to check now.
        compose.onNode(hasTestTag("engine-row:claude:check-again"), useUnmergedTree = true).onChildren()
            .filterToOne(hasClickAction()).performScrollTo().performClick()
        compose.waitUntil(60_000) { checks == 1 }
    }

    @Test fun theAttentionItemsCheckAgainAsksTheRunner() {
        machine(region())
        // The runner's next check lands in its region at once, still blocked: the press is held until then.
        fixture.onRegionCheck = { machine(region(Instant.now().plusSeconds(1).toString())) }
        page()
        await("Claude Code can’t use Anthropic here")
        compose.onAllNodes(checkAgain)[0].performScrollTo().performClick()
        compose.waitUntil(60_000) { checks == 1 }
        compose.waitUntil(60_000) { compose.onAllNodes(checkAgain and isEnabled()).fetchSemanticsNodes().size == 2 }
    }

    @Test fun claudeCodesPageKeepsItsAccountsWithCheckAgainInAddAccountsPlace() {
        machine(region())
        page("engine:claude")
        await("Region not supported")
        assertEquals(1, shown("2.1.302 · Region not supported", substring = false))
        listOf("Personal", "Work", "Team").forEach { assertEquals(it, 1, shown(it, substring = false)) }
        // Each says its sign-in alone: no quota line, no Sign In or renew, no signed-out note, and nothing marked NEXT.
        assertEquals(0, shown(AccountCopy.ADD_ACCOUNT))
        assertEquals(0, shown(RunnerCopy.NO_QUOTA))
        assertEquals(0, shown("5-hour limit"))
        assertEquals(0, shown(RunnerCopy.SIGN_IN, substring = false))
        assertEquals(0, shown(AccountCopy.ACCOUNT_SIGNED_OUT_NOTE))
        assertEquals(0, shown("NEXT", substring = false))
        assertEquals(1, shown("Checked 2m ago · Claude’s connection: mainland China (no proxy)", substring = false))
        compose.onNode(checkAgain).performScrollTo().performClick()
        compose.waitUntil(60_000) { checks == 1 }
    }

    @Test fun aMachineThatReadsNoRegionDrawsWhatItDrawsToday() {
        machine(null)
        page()
        await(RunnerCopy.ENGINES_FOOTER)
        assertEquals(0, shown("Claude Code can’t use Anthropic here"))
        assertEquals(0, shown("Region not supported"))
        assertEquals(0, compose.onAllNodes(hasText("Check Again")).fetchSemanticsNodes().size)
        // The signed-out account asks for its sign-in on the row, and the window of the account a new session starts on is read.
        assertEquals(1, shown(RunnerCopy.SIGN_IN, substring = false))
        assertEquals(1, shown("5-hour limit"))
    }

    @Test fun claudeCodesPageOnAMachineThatReadsNoRegionIsTodays() {
        machine(null)
        page("engine:claude")
        await(AccountCopy.ADD_ACCOUNT)
        assertEquals(0, shown("Region not supported"))
        assertEquals(0, compose.onAllNodes(hasText("Check Again")).fetchSemanticsNodes().size)
        assertEquals(1, shown(AccountCopy.ACCOUNT_SIGNED_OUT_NOTE))
    }
}
