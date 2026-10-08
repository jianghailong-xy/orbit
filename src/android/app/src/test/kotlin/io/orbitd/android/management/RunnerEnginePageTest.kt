package io.orbitd.android.management

import android.content.ClipData
import android.content.ClipboardManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import androidx.activity.ComponentActivity
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
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
 * A runner's page and its engine pages over the controlled server, as RunnerPageParts, RunnerEnginePage and RunnerSignInView
 * draw them on iOS: Antigravity's Google sign-in and its accounts (A13-3/A13-4), one quota window per Engines row (A13-5), an
 * account's row that says where it stands with its presses in its menu, and a sign-in card that starts on the press that
 * raised it, offers one way out and pastes a code in one tap (A13-9).
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = ManagementShellApplication::class)
class RunnerEnginePageTest {
    @get:Rule(order = 0) val host = object : ExternalResource() {
        override fun before() {
            val app = RuntimeEnvironment.getApplication()
            shadowOf(app.packageManager).addActivityIfNotPresent(ComponentName(app, ComponentActivity::class.java))
        }
    }
    @get:Rule(order = 1) val compose = createAndroidComposeRule<ComponentActivity>()
    private val fixture = ManagementFixture
    private val now = Instant.now()
    private fun at(hours: Long) = now.plusSeconds(hours * 3600).toString()

    @Before fun start() { fixture.reset() }

    private var record by mutableStateOf<String?>(null)
    private var revision by mutableLongStateOf(0L)
    private var shownOnce = false
    /** The runner's page, or one of its own ([where]), read again from the fixture as it stands now. */
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
    private fun await(text: String) = compose.waitUntil(10_000) { compose.onAllNodesWithText(text, substring = true).fetchSemanticsNodes().isNotEmpty() }
    private fun gone(text: String) = compose.waitUntil(10_000) { compose.onAllNodesWithText(text, substring = true).fetchSemanticsNodes().isEmpty() }
    private fun shown(text: String) = compose.onAllNodesWithText(text, substring = true).fetchSemanticsNodes().size
    /** Waits for [condition] while moving the test clock on: a delay in an effect elapses only when the clock moves. */
    private fun until(condition: () -> Boolean) {
        val end = System.currentTimeMillis() + 15_000
        while (!condition()) {
            assertTrue("still waiting after 15 s", System.currentTimeMillis() < end)
            compose.mainClock.advanceTimeBy(250); compose.waitForIdle()
        }
    }
    private fun click(matcher: SemanticsMatcher) {
        compose.waitUntil(10_000) { compose.onAllNodes(matcher).fetchSemanticsNodes().isNotEmpty() }
        val node = compose.onAllNodes(matcher).onFirst()
        try { node.performScrollTo() } catch (_: AssertionError) { }
        node.performClick()
        compose.waitForIdle()
    }
    private fun menu(account: String) = click(hasContentDescription("More for $account"))

    /** agy's four buckets, what each has left. */
    private fun buckets(vararg left: Double) = listOf("gemini-weekly", "gemini-5h", "3p-weekly", "3p-5h").zip(left.toList()).joinToString(",", "[", "]") { (id, rest) ->
        """{"id":"$id","window":"${if (id.endsWith("5h")) "5h" else "weekly"}","remainingFraction":$rest,"resetTime":"${at(if (id.endsWith("5h")) 3 else 90)}"}"""
    }
    private fun antigravity(accounts: String, planUsage: String?, auth: String = "yes", authSource: String = "google") =
        """{"engine":"antigravity","installed":true,"version":"1.3.0","auth":"$auth","authSource":"$authSource","accounts":$accounts${planUsage?.let { ""","planUsage":$it""" }.orEmpty()}}"""
    private fun extra(googleLogin: String = "available", capabilities: String = """"antigravity-account-login/v1","antigravity-account-remove/v1"""") =
        ""","capabilities":[$capabilities],"antigravity":{"supported":true,"installed":true,"version":"1.3.0","envKeyAvailable":true,"authSource":"google","googleLogin":"$googleLogin"}"""
    private val twoGoogleAccounts get() = antigravity(
        """[{"id":"default","auth":"yes","home":"/root/.orbit/antigravity/google"},{"id":"5c2e91a0","name":"Work","auth":"yes","home":"/root/.orbit/antigravity-accounts/5c2e91a0"}]""",
        """{"provider":"antigravity","buckets":${buckets(1.0, 1.0, 0.98, 1.0)},"accounts":{"5c2e91a0":{"provider":"antigravity","buckets":${buckets(0.61, 0.04, 1.0, 1.0)}}}}""")
    private val claudeOneAccount get() = """{"engine":"claude","installed":true,"version":"2.1.284 (Claude Code)","auth":"yes"}"""
    private val claudeUsage get() = ""","planUsage":{"claude":{"fiveHour":{"utilization":14,"resetsAt":"${at(2)}"},"sevenDay":{"utilization":98,"resetsAt":"${at(50)}"}}}"""

    // A13-3 · A13-4 · A13-5: the runner page's Engines rows

    @Test fun theAntigravityRowCountsGoogleAccountsAndNamesTheNextOneAboveItsOneWindow() {
        fixture.runnerEngines = "[$claudeOneAccount,$twoGoogleAccounts]"
        fixture.runnerExtra = extra() + claudeUsage
        page(null)
        await("2 accounts signed in")
        compose.onNodeWithText("Antigravity", useUnmergedTree = true).assertExists()
        assertEquals("the engine is Antigravity, not its CLI", 0, shown("Antigravity CLI"))
        // Work's 5 hours are down to 4%: a new session starts on Default, and the row carries Default's binding bucket only.
        await("Next: Default")
        await("3p-weekly"); await("98% remaining")
        assertEquals("one window on the Antigravity row", 0, shown("gemini-weekly"))
        // Claude Code's one account: its weekly window, the one closest to its limit, and not its 5-hour one.
        await("Weekly · all models")
        assertEquals(0, shown("5-hour limit"))
    }

    @Test fun anAntigravityThatCannotSignInWithGoogleSaysWhyOnItsRow() {
        fixture.runnerEngines = """[{"engine":"antigravity","installed":true,"version":"1.3.0","auth":"no"}]"""
        fixture.runnerExtra = extra(googleLogin = "needs_update", capabilities = "")
        page(null)
        await("Update runner")
        await("Update this runner to sign in with Google.")
        assertEquals("no Sign In where it can't sign in", 0, shown("Sign In"))
        // A runner too old to report Antigravity at all keeps its row, from what the server says of it.
        fixture.runnerEngines = """[$claudeOneAccount]"""
        fixture.runnerExtra = ""
        page(null)
        await("Claude Code")
        assertEquals(1, shown("Update this runner to sign in with Google."))
    }

    // A13-3 · A13-4: the Antigravity engine page

    @Test fun theEnginePageListsGoogleAccountsWithGooglesTermsAndAddAccount() {
        fixture.runnerEngines = "[$twoGoogleAccounts]"
        fixture.runnerExtra = extra()
        page("engine:antigravity")
        await("Accounts"); await("Work")
        await("~/.orbit/antigravity-accounts/5c2e91a0")
        await("gemini-5h"); await("4% remaining")
        await("Google terms restrict personal account sign-in through third-party tools; your account may be suspended.")
        click(hasText("Google terms") and hasClickAction())
        val opened = shadowOf(compose.activity).nextStartedActivity
        assertEquals(Intent.ACTION_VIEW, opened?.action)
        assertEquals("https://antigravity.google/terms", opened?.dataString)
        compose.onNode(hasText("Add Account") and hasClickAction()).assertExists()
    }

    @Test fun addAccountIsOfferedOnlyWhereTheRunnerKeepsGoogleAccountsApart() {
        val one = antigravity("""[{"id":"default","auth":"yes","home":"/root/.orbit/antigravity/google"}]""",
            """{"provider":"antigravity","buckets":${buckets(1.0, 1.0, 0.98, 1.0)}}""")
        fixture.runnerEngines = "[$one]"
        fixture.runnerExtra = extra(capabilities = "")
        page("engine:antigravity")
        await("Default"); await("Google terms")
        assertEquals("an older runner would sign Default in again in its place", 0, shown("Add Account"))
        fixture.runnerExtra = extra(googleLogin = "unsupported_platform")
        page("engine:antigravity")
        await("Google sign-in is not supported on macOS runners yet. Use a Gemini API key.")
        assertEquals(0, shown("Add Account"))
        assertEquals("no terms where nothing signs in with Google", 0, shown("Google terms"))
    }

    @Test fun aDefaultOnTheRunnersGeminiKeySaysWhatItRunsOn() {
        val keyed = antigravity("""[{"id":"default","auth":"no","home":"/root/.orbit/antigravity/google"}]""", null, authSource = "env_key")
        fixture.runnerEngines = "[$keyed]"
        fixture.runnerExtra = extra()
        page("engine:antigravity")
        await("env key · runs on your Gemini key")
        assertEquals("on the key it is neither signed in nor out", 0, shown("Signed out"))
        compose.onNode(hasText("Sign in with Google") and hasClickAction()).assertExists()
    }

    // A13-9: an account's row says where it stands; its presses are its menu's

    private fun claudeAccounts(defaultExpires: String?) = """[{"engine":"claude","installed":true,"version":"2.1.284 (Claude Code)","auth":"yes","accounts":[
        {"id":"default","auth":"yes","home":"/root/.claude"${defaultExpires?.let { ""","loginExpiresAt":"$it"""" }.orEmpty()}},
        {"id":"1fda3f43","name":"Work","auth":"yes","home":"/root/.orbit/claude-accounts/1fda3f43","pausedUntil":"${at(2)}"},
        {"id":"7d3e0c11","name":"Old","auth":"no","home":"/root/.orbit/claude-accounts/7d3e0c11"}]}]"""

    @Test fun anAccountRowSaysOnlyWhereItStandsAndItsMenuHoldsThePresses() {
        fixture.runnerEngines = claudeAccounts(at(47))
        fixture.runnerExtra = ""","capabilities":["claude-account-remove/v1"]"""
        page("engine:claude")
        await("Old")
        // Nothing to press on a signed-in row but its menu.
        assertEquals(0, shown("Sign In Again")); assertEquals(0, shown("Pause…")); assertEquals(0, shown("Resume Now"))
        await("Login expires in 2 days")
        compose.onNode(hasText("Renew") and hasClickAction()).assertExists()
        await("Paused"); await("Until ")
        await("Sessions can’t use this account until you sign in again.")
        compose.onNode(hasText("Sign In") and hasClickAction()).assertExists()
        menu("Work")
        for (item in listOf("Rename…", "Sign In Again", "Resume Now", "Change Duration…", "Remove…")) compose.onNodeWithText(item).assertExists()
        click(hasText("Resume Now"))
        compose.waitUntil(10_000) { fixture.pauseBodies.isNotEmpty() }
        assertEquals("runners/${fixture.RUNNER}/accounts/claude/1fda3f43/pause {\"durationMinutes\":null}", fixture.pauseBodies.single())
        menu("Default")
        for (item in listOf("Rename…", "Sign In Again", "Pause…")) compose.onNodeWithText(item).assertExists()
        assertEquals("Default is never removed", 0, shown("Remove…"))
    }

    @Test fun anOnlyAccountSignedOutSaysTheEngineCannotRunThere() {
        fixture.runnerEngines = """[{"engine":"codex","installed":true,"version":"codex-cli 0.158.0","auth":"no"}]"""
        page("engine:codex")
        await("Sessions on this runner can’t use Codex until you sign in again.")
    }

    // A13-9: the sign-in card

    @Test fun signInAgainStartsAtOnceOffersOneWayOutAndPastesTheCodeInOneTap() {
        fixture.runnerEngines = claudeAccounts(at(47))
        fixture.loginStarted = """{"engine":"claude","account":"default","status":"awaiting_code","url":"https://claude.ai/oauth/authorize?code=true"}"""
        fixture.codeSent = """{"engine":"claude","account":"default","status":"done"}"""
        // The runner reports the account signed in again, its login a month off, on its next check-in.
        fixture.onCode = { fixture.runnerEngines = claudeAccounts(at(30 * 24)) }
        page("engine:claude")
        await("Login expires in 2 days")
        menu("Default")
        click(hasText("Sign In Again"))
        // The press asked for the sign-in: the card starts it, with no button of its own to press first.
        compose.waitUntil(10_000) { fixture.loginBodies.isNotEmpty() }
        assertEquals(buildJsonObject { put("engine", "claude"); put("account", "default") }, fixture.loginBodies.single())
        await("Approve it there, then paste the code the page gives you:")
        compose.onNode(hasText("Open the sign-in page") and hasClickAction()).assertExists()
        assertEquals("one way out while it runs", 0, shown("Close"))
        compose.onNode(hasText("Cancel") and hasClickAction()).assertExists()
        (compose.activity.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager).setPrimaryClip(ClipData.newPlainText("code", "  pasted#code  "))
        click(hasText("Paste") and hasClickAction())
        compose.waitUntil(10_000) { fixture.loginBodies.size == 2 }
        assertEquals(buildJsonObject { put("code", "pasted#code") }, fixture.loginBodies[1])
        // Signed in: said for a moment, then the card folds back once the runner reports it.
        await("Signed in — this runner is ready.")
        until { shown("Signed in — this runner is ready.") == 0 && shown("Login expires") == 0 && shown("Approve it there") == 0 }
        assertEquals(0, shown("Cancel"))
    }

    @Test fun aDeviceCodeComesFirstUnderOnePressThatCopiesItAndOpensItsPage() {
        fixture.runnerEngines = """[{"engine":"codex","installed":true,"version":"codex-cli 0.158.0","auth":"no"}]"""
        fixture.loginStarted = """{"engine":"codex","status":"awaiting_approval","userCode":"WXYZ-1234","url":"https://auth.openai.com/codex/device"}"""
        page("engine:codex")
        click(hasText("Sign In") and hasClickAction())
        await("Enter this one-time code on the sign-in page:")
        await("WXYZ-1234")
        assertEquals(buildJsonObject { put("engine", "codex") }, fixture.loginBodies.single())
        click(hasText("Copy Code & Open Sign-In Page") and hasClickAction())
        val clipboard = compose.activity.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        assertEquals("WXYZ-1234", clipboard.primaryClip?.getItemAt(0)?.text?.toString())
        assertEquals("https://auth.openai.com/codex/device", shadowOf(compose.activity).nextStartedActivity?.dataString)
        // Cancel cancels the sign-in on the runner, and the card goes with it.
        click(hasText("Cancel") and hasClickAction())
        gone("WXYZ-1234")
        compose.onNode(hasText("Sign In") and hasClickAction()).assertExists()
    }

    @Test fun addAccountStartsAtOnceUnderAPickedNameWithOneWayOut() {
        fixture.runnerEngines = "[$twoGoogleAccounts]"
        fixture.runnerExtra = extra()
        fixture.loginStarted = """{"engine":"antigravity","status":"awaiting_code","url":"https://accounts.google.com/o/oauth2/auth"}"""
        page("engine:antigravity")
        click(hasText("Add Account") and hasClickAction())
        compose.waitUntil(10_000) { fixture.loginBodies.isNotEmpty() }
        assertEquals(buildJsonObject { put("engine", "antigravity"); put("accountName", "Account 3") }, fixture.loginBodies.single())
        await("Approve it there, then paste the code the page gives you:")
        assertEquals(0, shown("Close"))
        click(hasText("Cancel") and hasClickAction())
        await("Add Account")
    }
}
