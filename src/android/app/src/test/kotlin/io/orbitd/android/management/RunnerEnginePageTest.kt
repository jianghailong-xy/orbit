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

    // Kimi Code's accounts (docs/mocks/kimi-accounts/02-ios and its Android notes)

    private val kimiCapabilities = ""","capabilities":["kimi-account-login/v1","kimi-account-remove/v1","kimi-account-move/v1","kimi-login-region/v1"]"""
    private fun kimiWindows(five: Int, week: Int, month: Int) = """"provider":"kimi","fiveHour":{"utilization":$five,"resetsAt":"${at(2)}"},
        "sevenDay":{"utilization":$week,"resetsAt":"${at(96)}"},"month":{"utilization":$month,"resetsAt":"${at(552)}"},"monthCode":{"utilization":${month / 2},"resetsAt":"${at(552)}"}"""
    private val kimiUsage get() = ""","planUsage":{"kimi":{${kimiWindows(12, 34, 8)},"accounts":{"5c2e91a0":{${kimiWindows(91, 61, 22)}}}}}"""
    private val kimiDefault = """{"id":"default","auth":"yes","home":"/root/.kimi-code","kimiRegion":"global"}"""
    private val kimiWork = """{"id":"5c2e91a0","name":"Work","auth":"yes","home":"/root/.orbit/kimi-accounts/5c2e91a0","kimiRegion":"mainland-cn"}"""
    private fun kimiEngine(vararg accounts: String) =
        """{"engine":"kimi","installed":true,"version":"2.1.1","auth":"yes","kimiRegion":"global","accounts":[${accounts.joinToString(",")}]}"""
    private fun site(domain: String) = hasText(domain) and hasClickAction()

    @Test fun theKimiRowSaysItsSiteWithOneLoginAndTheNextAccountWithTwo() {
        fixture.runnerEngines = "[${kimiEngine(kimiDefault)}]"
        fixture.runnerExtra = kimiCapabilities + kimiUsage
        page(null)
        await("2.1.1 · kimi.ai · Signed in")
        await("Weekly limit"); await("34%")
        fixture.runnerEngines = "[${kimiEngine(kimiDefault, kimiWork)}]"
        page(null)
        await("2.1.1 · 2 accounts signed in")
        // Work's five hours are 91% used: a new session starts on Default, whose window the row carries.
        await("Next: Default")
        assertEquals("two accounts can be on different sites: each says its own on the engine page", 0, shown("kimi.ai"))
    }

    /** A Kimi login whose plan carries no quota limit was read and held no window: its row says "No quota limit", where
     * an account with no snapshot of its own still says "No quota reported". */
    @Test fun aKimiAccountWithNoQuotaLimitSaysSoWhereAnUnreadOneSaysNoQuotaReported() {
        fixture.runnerEngines = "[${kimiEngine(kimiDefault, kimiWork)}]"
        // Default's snapshot was read and held no window; Work has none under `accounts`.
        fixture.runnerExtra = kimiCapabilities + ""","planUsage":{"kimi":{"provider":"kimi","fetchedAt":"${at(0)}"}}"""
        page("engine:kimi")
        await("Accounts"); await("Work")
        await(RunnerCopy.NO_QUOTA_LIMIT)
        assertEquals("only Default was read", 1, shown(RunnerCopy.NO_QUOTA_LIMIT))
        await(RunnerCopy.NO_QUOTA)
        assertEquals("Work was never read", 1, shown(RunnerCopy.NO_QUOTA))
    }

    /** One account still offers Add Account; the form takes a name first, then asks the site — nothing starts until a site is
     * pressed, neither can be pressed without a name, and the device step names the site of the account being added, with the
     * other site one press away under the same name. */
    @Test fun kimiAddAccountTakesANameThenAsksTheSite() {
        fixture.runnerEngines = "[${kimiEngine(kimiDefault)}]"
        fixture.runnerExtra = kimiCapabilities + kimiUsage
        fixture.loginStarted = """{"engine":"kimi","status":"awaiting_approval","userCode":"7K06-QP86","url":"https://www.kimi.com/code/authorize_device?user_code=7K06-QP86"}"""
        page("engine:kimi")
        await("Accounts"); await("kimi.ai · ~/.kimi-code")
        await("5h limit"); await("Weekly limit"); await("Monthly limit")
        assertEquals("the month is drawn once", 1, shown("Monthly"))
        click(hasText("Add Account") and hasClickAction())
        await("Which Kimi account are you signing in with?")
        await("The two sites keep separate accounts — pick the one you signed up on.")
        compose.onNode(hasSetTextAction()).assertTextContains("Account 2")
        assertTrue("nothing starts until a site is pressed", fixture.loginBodies.isEmpty())
        assertEquals("an account being added has no site yet", 0, shown("Current"))
        compose.onNode(hasSetTextAction()).performTextClearance()
        compose.onNode(site("kimi.com")).assertIsNotEnabled()
        compose.onNode(site("kimi.ai")).assertIsNotEnabled()
        compose.onNode(hasSetTextAction()).performTextInput("Work")
        click(site("kimi.com"))
        compose.waitUntil(10_000) { fixture.loginBodies.isNotEmpty() }
        assertEquals(buildJsonObject { put("engine", "kimi"); put("accountName", "Work"); put("region", "mainland-cn") }, fixture.loginBodies.single())
        await("Sign in with the kimi.com account you are adding, then enter this one-time code:")
        await("7K06-QP86")
        compose.onNode(hasText("Copy Code & Open kimi.com") and hasClickAction()).assertExists()
        fixture.loginStarted = """{"engine":"kimi","status":"awaiting_approval","userCode":"Q2PF-8XWA","url":"https://www.kimi.ai/code/authorize_device?user_code=Q2PF-8XWA"}"""
        click(hasText("Use kimi.ai instead") and hasClickAction())
        compose.waitUntil(10_000) { fixture.loginBodies.size == 2 }
        assertEquals(buildJsonObject { put("engine", "kimi"); put("accountName", "Work"); put("region", "global") }, fixture.loginBodies[1])
        await("Sign in with the kimi.ai account you are adding"); await("Q2PF-8XWA"); await("Use kimi.com instead")
    }

    /** Sign In Again asks the site too, marking Current the account's own — Work's kimi.com, not Default's kimi.ai. */
    @Test fun kimiSignInAgainMarksTheAccountsOwnSiteCurrent() {
        fixture.runnerEngines = "[${kimiEngine(kimiDefault, kimiWork)}]"
        fixture.runnerExtra = kimiCapabilities + kimiUsage
        page("engine:kimi")
        await("kimi.ai · ~/.kimi-code"); await("kimi.com · ~/.orbit/kimi-accounts/5c2e91a0")
        menu("Work")
        click(hasText("Sign In Again"))
        await("Which Kimi account are you signing in with?")
        compose.onNode(site("kimi.com")).assert(hasText(KimiSite.CURRENT))
        compose.onNode(site("kimi.ai")).assert(!hasText(KimiSite.CURRENT))
        assertTrue("the press asked for the site, not the sign-in", fixture.loginBodies.isEmpty())
        click(site("kimi.ai"))
        compose.waitUntil(10_000) { fixture.loginBodies.isNotEmpty() }
        assertEquals(buildJsonObject { put("engine", "kimi"); put("account", "5c2e91a0"); put("region", "global") }, fixture.loginBodies.single())
    }

    /** A runner that declares none of Kimi's capabilities keeps its one login under Sign-In, with no Add Account. Its sign-in
     * still asks the site: kimi.com goes to it unnamed, a bare `kimi login`, and kimi.ai is named for the server to refuse in
     * words that say to update it. */
    @Test fun anOlderRunnerKeepsOneKimiLoginAndGetsKimiComUnnamed() {
        fixture.runnerEngines = """[{"engine":"kimi","installed":true,"version":"2.1.1","auth":"no","kimiRegion":"mainland-cn"}]"""
        page("engine:kimi")
        await("Sign-In"); await("Sessions on this runner can’t use Kimi Code until you sign in again.")
        assertEquals(0, shown("Add Account")); assertEquals(0, shown("Accounts"))
        click(hasText("Sign In") and hasClickAction())
        await("Which Kimi account are you signing in with?")
        compose.onNode(site("kimi.com")).assert(hasText(KimiSite.CURRENT))
        click(site("kimi.com"))
        compose.waitUntil(10_000) { fixture.loginBodies.isNotEmpty() }
        assertEquals("a bare kimi login", buildJsonObject { put("engine", "kimi") }, fixture.loginBodies.single())
        click(hasText("Cancel") and hasClickAction())
        click(hasText("Sign In") and hasClickAction())
        await("Which Kimi account are you signing in with?")
        click(site("kimi.ai"))
        compose.waitUntil(10_000) { fixture.loginBodies.size == 2 }
        assertEquals(buildJsonObject { put("engine", "kimi"); put("region", "global") }, fixture.loginBodies[1])
        // The runner's next check-in refuses it.
        fixture.loginRelay = """{"engine":"kimi","status":"failed","message":"This runner is too old to choose a Kimi site — update it, then try again."}"""
        until { shown("This runner is too old to choose a Kimi site — update it, then try again.") == 1 }
        await("Which Kimi account are you signing in with?")
    }

    /** NEXT sits beside the account a new session starts on, on all four engines' pages, and nowhere with one account. */
    @Test fun everyEnginePageMarksTheNextAccount() {
        fun beside(name: String) {
            await("NEXT")
            assertEquals("one account is next", 1, compose.onAllNodesWithText("NEXT", useUnmergedTree = true).fetchSemanticsNodes().size)
            fun centre(text: String) = compose.onAllNodesWithText(text, useUnmergedTree = true).onFirst().fetchSemanticsNode().boundsInRoot.center.y
            assertEquals("NEXT beside $name", centre(name), centre("NEXT"), 8f)
        }
        fixture.runnerExtra = kimiCapabilities + kimiUsage + ""","antigravity":{"supported":true,"installed":true,"googleLogin":"available"}"""
        fixture.runnerEngines = "[${kimiEngine(kimiDefault, kimiWork)}]"
        page("engine:kimi"); await("Work")
        beside("Default")
        // Claude Code: Work is paused and Old signed out, so Default.
        fixture.runnerEngines = claudeAccounts(at(47))
        page("engine:claude"); await("Old")
        beside("Default")
        // Antigravity: Work's five hours are down to 4%.
        fixture.runnerEngines = "[$twoGoogleAccounts]"
        page("engine:antigravity"); await("gemini-5h")
        beside("Default")
        // Codex: Default's five hours are nearly spent, so the second account.
        fixture.runnerEngines = """[{"engine":"codex","installed":true,"version":"codex-cli 0.158.0","auth":"yes","accounts":[{"id":"default","auth":"yes","home":"/root/.codex"},
            {"id":"1a2b3c4d","name":"Second","auth":"yes","home":"/root/.orbit/codex-accounts/1a2b3c4d"}]}]"""
        fixture.runnerExtra = ""","planUsage":{"codex":{"provider":"codex","primary":{"utilization":85,"windowDurationMins":300},
            "accounts":{"1a2b3c4d":{"provider":"codex","primary":{"utilization":30,"windowDurationMins":300}}}}}"""
        page("engine:codex"); await("Second")
        beside("Second")
        // One account: nothing to choose between.
        fixture.runnerEngines = "[${kimiEngine(kimiDefault)}]"
        fixture.runnerExtra = kimiCapabilities + kimiUsage
        page("engine:kimi"); await("kimi.ai · ~/.kimi-code")
        gone("NEXT")
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
