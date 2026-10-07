package io.orbitd.android.auth

import android.content.ComponentName
import android.content.Intent
import android.content.IntentFilter
import android.net.Uri
import androidx.browser.customtabs.CustomTabsIntent
import androidx.browser.customtabs.CustomTabsService
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTextClearance
import androidx.compose.ui.test.performTextInput
import androidx.test.platform.app.InstrumentationRegistry
import io.orbitd.android.MainActivity
import io.orbitd.android.OrbitApplication
import io.orbitd.android.R
import io.orbitd.android.TestOrbitApplication
import io.orbitd.android.core.auth.AuthState
import io.orbitd.android.core.auth.GoogleSignIn
import io.orbitd.android.core.net.ApiResponse
import io.orbitd.android.core.net.NetworkException
import io.orbitd.android.core.net.ServerAddress
import io.orbitd.android.core.protocol.GoogleExchangeRequest
import io.orbitd.android.core.protocol.Wire
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.setMain
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TestWatcher
import org.junit.runner.Description
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = TestOrbitApplication::class)
@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
class GoogleSignInFlowTest {
    @get:Rule(order = 0)
    val mainDispatcher = object : TestWatcher() {
        override fun starting(description: Description) { Dispatchers.setMain(UnconfinedTestDispatcher()) }
        override fun finished(description: Description) { Dispatchers.resetMain() }
    }
    @get:Rule(order = 1)
    val compose = createAndroidComposeRule<MainActivity>()

    private val app get() = compose.activity.application as TestOrbitApplication
    private val exchanges get() = synchronized(app.requests) { app.requests.filter { it.api.path == listOf("auth", "google", "exchange") } }
    private fun session() = (compose.activity.application as OrbitApplication).session
    private fun sentence(id: Int) = app.getString(id)

    private fun answerMethods(google: Boolean, signup: Boolean = false) {
        app.methods = { ApiResponse(200, """{"password":true,"google":$google,"googleSignup":$signup}""".encodeToByteArray()) }
    }

    /** Types an instance address and waits for the login page to have asked it what it offers. */
    private fun enterInstance(address: String) {
        compose.waitUntil(5_000) { session().state.value is AuthState.SignedOut }
        compose.onNodeWithText("Instance address").performTextClearance()
        compose.onNodeWithText("Instance address").performTextInput(address)
        val server = ServerAddress.parse(address)
        compose.waitUntil(5_000) {
            synchronized(app.requests) { app.requests.any { it.api.path == listOf("auth", "methods") && it.server == server } }
        }
        compose.waitForIdle()
    }

    private fun installCustomTabsBrowser(): String {
        val service = ComponentName("org.example.browser", "org.example.browser.CustomTabs")
        val packages = shadowOf(app.packageManager)
        packages.addServiceIfNotPresent(service)
        packages.addIntentFilterForService(service, IntentFilter(CustomTabsService.ACTION_CUSTOM_TABS_CONNECTION))
        return service.packageName
    }

    private fun drainStartedActivities() {
        while (shadowOf(app).nextStartedActivity != null) continue
    }

    /** Continue with Google: answers what the app opened in the browser. */
    private fun continueWithGoogle(): Intent {
        drainStartedActivities()
        // After a failed sign-in the form is new, and asks the instance again before offering Google.
        compose.waitUntil(5_000) { compose.onAllNodesWithText("Continue with Google").fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithText("Continue with Google").performScrollTo().performClick()
        compose.waitForIdle()
        return shadowOf(app).nextStartedActivity
    }

    /** The browser opens orbit://auth/google: the redirect activity hands it to the running MainActivity. */
    private fun deliver(callback: String) {
        drainStartedActivities()
        val redirect = Robolectric.buildActivity(GoogleSignInRedirectActivity::class.java,
            Intent(Intent.ACTION_VIEW, Uri.parse(callback)).addCategory(Intent.CATEGORY_BROWSABLE)).create().get()
        assertTrue(redirect.isFinishing)
        val forwarded = shadowOf(redirect).nextStartedActivity
        assertEquals(ComponentName(app, MainActivity::class.java), forwarded.component)
        assertEquals(callback, forwarded.dataString)
        val flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP
        assertEquals(flags, forwarded.flags and flags)
        compose.activityRule.scenario.onActivity {
            InstrumentationRegistry.getInstrumentation().callActivityOnNewIntent(it, forwarded)
        }
        compose.waitForIdle()
    }

    @Test fun theGoogleButtonAndSignupHintFollowTheInstancesSignInMethods() {
        // A server from before Google sign-in answers 404: the password alone, as before.
        enterInstance("https://old.example")
        compose.onNodeWithText("Continue with Google").assertDoesNotExist()
        answerMethods(google = false)
        enterInstance("https://off.example")
        compose.onNodeWithText("Continue with Google").assertDoesNotExist()
        answerMethods(google = true)
        enterInstance("https://on.example")
        compose.onNodeWithText("Continue with Google").assertExists()
        compose.onNodeWithText(sentence(R.string.google_signup_hint)).assertDoesNotExist()
        answerMethods(google = true, signup = true)
        enterInstance("https://open.example")
        compose.onNodeWithText("Continue with Google").assertExists()
        compose.onNodeWithText(sentence(R.string.google_signup_hint)).assertExists()
        // Another address hides them until its own instance answers; an unreachable one never does.
        app.methods = { throw NetworkException() }
        enterInstance("https://unreachable.example")
        compose.onNodeWithText("Continue with Google").assertDoesNotExist()
        compose.onNodeWithText(sentence(R.string.google_signup_hint)).assertDoesNotExist()
        // An address the app would not sign in to is never asked.
        answerMethods(google = true)
        compose.onNodeWithText("Instance address").performTextClearance()
        compose.onNodeWithText("Instance address").performTextInput("http://remote.example")
        compose.mainClock.advanceTimeBy(2_000)
        compose.waitForIdle()
        assertFalse(synchronized(app.requests) { app.requests.any { it.server.value.startsWith("http://remote.example") } })
        compose.onNodeWithText("Continue with Google").assertDoesNotExist()
    }

    @Test fun continueWithGoogleOpensStartInACustomTabAndItsTicketSignsIn() {
        val browser = installCustomTabsBrowser()
        answerMethods(google = true)
        enterInstance("https://orbit.example/team")
        val opened = continueWithGoogle()
        assertEquals(Intent.ACTION_VIEW, opened.action)
        assertEquals(browser, opened.`package`)
        assertTrue("a Custom Tab", opened.hasExtra(CustomTabsIntent.EXTRA_SESSION))
        val start = opened.data!!
        assertEquals("https://orbit.example/team/api/auth/google/start", start.buildUpon().clearQuery().build().toString())
        assertEquals("native", start.getQueryParameter("client"))
        val challenge = start.getQueryParameter("code_challenge")!!
        val state = start.getQueryParameter("client_state")!!

        deliver("orbit://auth/google?ticket=fixture-ticket&state=$state")
        compose.waitUntil(5_000) { session().state.value is AuthState.SignedIn }
        compose.onNodeWithText("Signed in").assertExists()
        val exchange = exchanges.single()
        assertEquals("https://orbit.example/team/", exchange.server.value)
        val sent = Wire.decode(exchange.api.body!!, GoogleExchangeRequest.serializer())
        assertEquals("fixture-ticket", sent.ticket)
        assertEquals("the verifier of the challenge /start was given", challenge, GoogleSignIn.challenge(sent.codeVerifier))
    }

    @Test fun withoutACustomTabsBrowserStartOpensInTheDefaultBrowser() {
        answerMethods(google = true)
        enterInstance("https://orbit.example")
        val opened = continueWithGoogle()
        assertEquals(Intent.ACTION_VIEW, opened.action)
        assertTrue(opened.hasCategory(Intent.CATEGORY_BROWSABLE))
        assertNull(opened.`package`)
        assertFalse(opened.hasExtra(CustomTabsIntent.EXTRA_SESSION))
        assertEquals("/api/auth/google/start", opened.data!!.path)
    }

    @Test fun withNoBrowserAtAllGoogleSignInSaysSoAndKeepsNothing() {
        answerMethods(google = true)
        enterInstance("https://orbit.example")
        shadowOf(app).checkActivities(true)
        compose.onNodeWithText("Continue with Google").performScrollTo().performClick()
        compose.waitForIdle()
        compose.onNodeWithText(sentence(R.string.auth_google_unavailable)).assertExists()
        // The sign-in that could not open was forgotten: no answer can finish it.
        deliver("orbit://auth/google?ticket=fixture-ticket&state=any")
        compose.onNodeWithText(sentence(R.string.auth_google_interrupted)).assertExists()
        assertTrue(exchanges.isEmpty())
    }

    @Test fun eachRefusalInTheCallbackShowsItsOwnSentenceAndNothingIsExchanged() {
        installCustomTabsBrowser()
        answerMethods(google = true)
        enterInstance("https://orbit.example")
        val sentences = mapOf(
            "GOOGLE_NOT_CONFIGURED" to R.string.auth_google_not_configured,
            "GOOGLE_RATE_LIMITED" to R.string.auth_google_rate_limited,
            "GOOGLE_SIGN_IN_BUSY" to R.string.auth_google_sign_in_busy,
            "GOOGLE_BAD_REQUEST" to R.string.auth_google_bad_request,
            "GOOGLE_FLOW_EXPIRED" to R.string.auth_google_flow_expired,
            "GOOGLE_CANCELLED" to R.string.auth_google_cancelled,
            "GOOGLE_EXCHANGE_FAILED" to R.string.auth_google_exchange_failed,
            "GOOGLE_EMAIL_UNVERIFIED" to R.string.auth_google_email_unverified,
            "SOMETHING_NEW" to R.string.auth_google_failed,
        )
        for ((code, sentence) in sentences) {
            val state = continueWithGoogle().data!!.getQueryParameter("client_state")
            deliver("orbit://auth/google?error=$code&state=$state")
            compose.onNodeWithText(sentence(sentence)).assertExists()
            assertTrue(code, session().state.value is AuthState.SignedOut)
        }
        assertTrue(exchanges.isEmpty())
    }

    @Test fun aRefusedExchangeShowsTheRefusalAndSignsNobodyIn() {
        installCustomTabsBrowser()
        answerMethods(google = true)
        enterInstance("https://orbit.example")
        val refusals = listOf(
            ApiResponse(403, """{"code":"GOOGLE_EMAIL_NOT_AUTHORITATIVE","message":"refused"}""".encodeToByteArray())
                to R.string.auth_google_email_not_authoritative,
            ApiResponse(403, """{"code":"GOOGLE_ACCOUNT_NOT_FOUND","message":"refused"}""".encodeToByteArray())
                to R.string.auth_google_account_not_found,
            ApiResponse(403, """{"code":"ACCOUNT_DISABLED","message":"refused"}""".encodeToByteArray())
                to R.string.auth_account_disabled,
            ApiResponse(400, """{"code":"GOOGLE_FLOW_MISMATCH","message":"refused"}""".encodeToByteArray())
                to R.string.auth_google_flow_mismatch,
            ApiResponse(429, """{"statusCode":429,"message":"slow down"}""".encodeToByteArray())
                to R.string.auth_google_rate_limited,
        )
        for ((answer, sentence) in refusals) {
            app.exchange = { answer }
            val state = continueWithGoogle().data!!.getQueryParameter("client_state")
            deliver("orbit://auth/google?ticket=fixture-ticket&state=$state")
            compose.waitUntil(5_000) { auth().message.value != null }
            compose.onNodeWithText(sentence(sentence)).assertExists()
            assertTrue(session().state.value is AuthState.SignedOut)
        }
        assertEquals(refusals.size, exchanges.size)
    }

    @Test fun aCallbackWithAnotherStateIsNeverExchangedAndTheSignInStillFinishes() {
        installCustomTabsBrowser()
        answerMethods(google = true)
        enterInstance("https://orbit.example")
        val state = continueWithGoogle().data!!.getQueryParameter("client_state")
        deliver("orbit://auth/google?ticket=planted-ticket&state=planted-state")
        compose.onNodeWithText(sentence(R.string.auth_google_state_mismatch)).assertExists()
        assertTrue(exchanges.isEmpty())
        deliver("orbit://auth/google?ticket=fixture-ticket&state=$state")
        compose.waitUntil(5_000) { session().state.value is AuthState.SignedIn }
        assertEquals("fixture-ticket", Wire.decode(exchanges.single().api.body!!, GoogleExchangeRequest.serializer()).ticket)
    }

    @Test fun aCallbackAfterTheVerifierIsGoneAsksToTryAgain() {
        // Nothing was started in this process, as after the system ended it while the browser was open.
        deliver("orbit://auth/google?ticket=fixture-ticket&state=from-before")
        compose.onNodeWithText(sentence(R.string.auth_google_interrupted)).assertExists()
        assertTrue(session().state.value is AuthState.SignedOut)
        assertTrue(exchanges.isEmpty())
    }

    @Test fun onlyOrbitAuthGoogleOpensTheRedirectActivity() {
        fun handlers(uri: String) = app.packageManager.queryIntentActivities(
            Intent(Intent.ACTION_VIEW, Uri.parse(uri)).addCategory(Intent.CATEGORY_BROWSABLE), 0,
        ).map { it.activityInfo.name }
        assertEquals(listOf(GoogleSignInRedirectActivity::class.java.name), handlers("orbit://auth/google?ticket=t&state=s"))
        assertEquals(emptyList<String>(), handlers("orbit://auth/other?ticket=t&state=s"))
        assertEquals(emptyList<String>(), handlers("orbit://session/1"))
    }

    private fun auth() = androidx.lifecycle.ViewModelProvider(compose.activity)[AuthViewModel::class.java]
}
