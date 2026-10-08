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
 * draw them on iOS: Antigravity's Google sign-in and its accounts (A13-3/A13-4).
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

    // A13-3 · A13-4: the runner page's Engines rows

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
}
