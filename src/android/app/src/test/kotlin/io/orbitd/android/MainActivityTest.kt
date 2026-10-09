package io.orbitd.android

import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsFocused
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.assertWidthIsEqualTo
import androidx.compose.ui.test.click
import androidx.compose.ui.test.junit4.AndroidComposeTestRule
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performCustomAccessibilityActionWithLabel
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.performTextReplacement
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.unit.dp
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.hasAnyAncestor
import androidx.compose.ui.test.isDialog
import io.orbitd.android.core.auth.*
import io.orbitd.android.core.net.*
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.junit.rules.TestWatcher
import org.junit.runner.Description
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.setMain
import kotlinx.coroutines.test.resetMain
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = TestOrbitApplication::class)
@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class, ExperimentalTestApi::class)
class MainActivityTest {
    @get:Rule(order = 0)
    val mainDispatcher = object : TestWatcher() {
        override fun starting(description: Description) { Dispatchers.setMain(UnconfinedTestDispatcher()) }
        override fun finished(description: Description) { Dispatchers.resetMain() }
    }
    @get:Rule(order = 1)
    val compose = createAndroidComposeRule<MainActivity>()

    @Test
    fun launcherDisplaysTheLogin() {
        awaitLogin()
        // iOS fdeb033ad: the app icon, "Welcome back", standing Email and Password labels, and no server on the page.
        compose.onNodeWithContentDescription("Orbit").assertIsDisplayed()
        compose.onNodeWithText("Welcome back").assertIsDisplayed()
        compose.onNodeWithText("Sign in to continue to Orbit").assertIsDisplayed()
        compose.onNodeWithText("Email").assertIsDisplayed()
        compose.onNodeWithText("Password").assertIsDisplayed()
        compose.onNodeWithText("Instance address").assertDoesNotExist()
        compose.onNodeWithText("Sign In").assertIsNotEnabled()
        compose.onNodeWithText("Email").performTextInput("fixture@example.test")
        compose.onNodeWithText("Sign In").assertIsNotEnabled()
        compose.onNodeWithText("Password").performTextInput("fixture-password")
        compose.onNodeWithText("Sign In").assertIsEnabled()
        // Nothing remembered: the page is on orbitd.io, and asks it what it offers.
        compose.waitUntil(60_000) { app().requests.any { it.api.path == listOf("auth", "methods") } }
        assertEquals(ServerAddress.parse("https://orbitd.io"), app().requests.first { it.api.path == listOf("auth", "methods") }.server)
    }

    @Test
    fun theServerHidesBehindTheLogoAndOnlyAnAddressTheAppSignsInToIsKept() {
        awaitLogin()
        // Three taps on the logo open the Server dialog, on the page's server.
        compose.onNodeWithContentDescription("Orbit").performTouchInput { click(); advanceEventTime(100); click(); advanceEventTime(100); click() }
        compose.onNodeWithText("Server").assertIsDisplayed()
        compose.onNodeWithText("Server address").assert(hasText("orbitd.io"))
        compose.onNodeWithText("For self-hosted Orbit. Leave as orbitd.io unless your admin gave you another address.").assertIsDisplayed()
        compose.onNodeWithText("Server address").performTextReplacement("http://remote.example")
        compose.onNodeWithText("Save").performClick()
        compose.onNodeWithText("Enter a valid server address.").assertIsDisplayed()
        compose.onNodeWithText("Reset to orbitd.io").performClick()
        compose.onNodeWithText("Server address").assert(hasText("orbitd.io"))
        compose.onNodeWithText("Cancel").performClick()
        compose.onNodeWithText("Server address").assertDoesNotExist()
        // TalkBack's "Change server" action opens it too. A host typed without a scheme is HTTPS.
        compose.chooseServer("example.test")
        compose.waitUntil(60_000) { app().requests.any { it.api.path == listOf("auth", "methods") && it.server == ServerAddress.parse("https://example.test") } }
        assertFalse(app().requests.any { it.server.value.startsWith("http://") })
        compose.onNodeWithContentDescription("Orbit").performCustomAccessibilityActionWithLabel("Change server")
        compose.onNodeWithText("Server address").assert(hasText("example.test"))
    }

    /** The brand folds into one row only above the keyboard (the device journey shows that); focus alone, as from a hardware
     * keyboard, keeps the whole page and its Build information link. */
    @Test
    fun aFocusedFieldWithoutTheKeyboardKeepsTheWholeBrand() {
        awaitLogin()
        compose.onNodeWithText("Email").performClick()
        compose.onNodeWithText("Email").assertIsFocused()
        compose.onNodeWithContentDescription("Orbit").assertWidthIsEqualTo(76.dp)
        compose.onNodeWithText("Welcome back").assertIsDisplayed()
        compose.onNodeWithText("Build information").performScrollTo().assertIsDisplayed()
    }

    @Test
    fun thePasswordCanBeShownAndHiddenAgain() {
        awaitLogin()
        // What the field draws (EditableText); `hasText` would also match the untransformed input.
        fun draws(text: String) = SemanticsMatcher("draws \"$text\"") { it.config.getOrNull(SemanticsProperties.EditableText)?.text == text }
        compose.onNodeWithText("Password").performTextInput("fixture-password")
        compose.onNodeWithText("Password").assert(draws("\u2022".repeat(16)))
        compose.onNodeWithContentDescription("Show password").performClick()
        compose.onNodeWithText("Password").assert(draws("fixture-password"))
        compose.onNodeWithContentDescription("Hide password").performClick()
        compose.onNodeWithText("Password").assert(draws("\u2022".repeat(16)))
    }

    /** Only what signed in is remembered (iOS fdeb033ad); each server's email is kept through sign-out (the coordinator's A03c decision). */
    @Test
    fun aFailedSignInRemembersNothingAndASuccessfulOneItsServerAndEmail() {
        awaitLogin()
        app().login = { ApiResponse(401, """{"message":"Unauthorized"}""".encodeToByteArray()) }
        compose.signIn("bad.example", "  fixture@example.test ", "wrong-password")
        compose.waitUntil(60_000) { compose.onAllNodesWithText("Incorrect email or password.").fetchSemanticsNodes().isNotEmpty() }
        assertNull(app().instance)
        assertTrue(app().emails.isEmpty())
        // The form stays, with the email as it was sent and without the password.
        compose.onNodeWithText("Email").assert(hasText("fixture@example.test"))
        compose.onNodeWithText("wrong-password").assertDoesNotExist()

        app().login = { ApiResponse(200, LOGIN.encodeToByteArray()) }
        compose.signIn("example.test", "fixture@example.test", "fixture-password")
        compose.waitUntil(60_000) { appSession().state.value is AuthState.SignedIn }
        assertEquals("https://example.test/", app().instance)
        assertEquals(mapOf("https://example.test/" to "fixture@example.test"), app().emails.toMap())
        compose.onNodeWithContentDescription("Open navigation").performClick()
        compose.onNodeWithText("Settings").performScrollTo().performClick()
        compose.onNodeWithText("Sign out").performScrollTo().performClick()
        compose.onNode(hasText("Sign out") and hasAnyAncestor(isDialog())).performClick()
        awaitLogin()
        // Back on example.test with its email; never the password.
        compose.waitUntil(60_000) { compose.onAllNodes(hasText("Email") and hasText("fixture@example.test")).fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithText("fixture-password").assertDoesNotExist()
        assertFalse(app().emails.values.any { it.contains("password") })
        compose.onNodeWithContentDescription("Orbit").performCustomAccessibilityActionWithLabel("Change server")
        compose.onNodeWithText("Server address").assert(hasText("example.test"))
        // Another server prefills its own email, or none.
        compose.onNodeWithText("Server address").performTextReplacement("other.example")
        compose.onNodeWithText("Save").performClick()
        compose.waitUntil(60_000) { compose.onAllNodes(hasText("Email") and hasText("fixture@example.test")).fetchSemanticsNodes().isEmpty() }
        compose.onNodeWithText("Email").assert(hasText("you@example.com"))
    }

    @Test
    fun buildInformationShowsTheInstalledIdentityAndReturnsHome() {
        awaitLogin()
        compose.onNodeWithText("Build information").performScrollTo().performClick()

        compose.onNodeWithText(BuildConfig.APPLICATION_ID).assertIsDisplayed()
        compose.onNodeWithText(BuildConfig.SOURCE_SHA).assertIsDisplayed()
        compose.onNodeWithText(if (BuildConfig.SOURCE_DIRTY) "modified" else "clean").assertIsDisplayed()

        compose.onNodeWithText("Back").performClick()
        compose.onNodeWithText("Welcome back").assertIsDisplayed()
    }

    @Test
    fun recreationPreservesTheNavigationDestination() {
        awaitLogin()
        compose.onNodeWithText("Build information").performScrollTo().performClick()

        compose.activityRule.scenario.recreate()

        compose.onNodeWithText(BuildConfig.APPLICATION_ID).assertIsDisplayed()
        compose.activityRule.scenario.onActivity { it.onBackPressedDispatcher.onBackPressed() }
        compose.onNodeWithText("Welcome back").assertIsDisplayed()
    }

    @Test
    fun loginIsUsableAndLogoutReturnsToAnEmptyPasswordField() {
        awaitLogin()
        compose.signIn("https://example.test", "fixture@example.test", "fixture-password")
        compose.waitUntil(60_000) { appSession().state.value is AuthState.SignedIn }
        compose.onNodeWithContentDescription("Open navigation").performClick()
        compose.onNodeWithText("Settings").performScrollTo().performClick()
        compose.onNodeWithContentDescription("Edit profile").assertIsDisplayed()
        compose.activityRule.scenario.recreate()
        compose.onNodeWithContentDescription("Edit profile").assertIsDisplayed()
        compose.onNodeWithText("Sign out").performScrollTo().performClick()
        compose.onNodeWithText("Sign out of example.test?").assertIsDisplayed()
        compose.onNode(hasText("Sign out") and hasAnyAncestor(isDialog())).performClick()
        awaitLogin()
        compose.onNodeWithText("Password").assertIsDisplayed()
        compose.onNodeWithText("fixture-password").assertDoesNotExist()
    }

    @Test
    fun unsignedObjectLinkSurvivesRecreationAndLoginThenReturnsHome() {
        awaitLogin()
        compose.activityRule.scenario.onActivity {
            val launchIntent = it.intent
            MainActivity::class.java.getDeclaredMethod("onNewIntent", android.content.Intent::class.java).apply { isAccessible = true }
                .invoke(it, android.content.Intent(android.content.Intent.ACTION_VIEW,
                    android.net.Uri.parse("orbit-task:34TcwNgAIo6tGUiIKjqnQ")).setClass(it, MainActivity::class.java))
            // ActivityScenario filters lifecycle events by the ORIGINAL launch intent.
            // Its monitor identity is restored; Orbit's received/pending navigation stays intact.
            it.intent = launchIntent
        }
        compose.waitForIdle()
        compose.activityRule.scenario.recreate()
        compose.signIn("https://example.test", "fixture@example.test", "fixture-password")
        compose.waitUntil(60_000) { compose.onAllNodesWithText("Linked task").fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithText("Linked task").assertIsDisplayed()
        compose.activityRule.scenario.onActivity { it.onBackPressedDispatcher.onBackPressed() }
        compose.onNodeWithContentDescription("Open navigation").assertIsDisplayed()
        compose.onNodeWithText("Linked task").assertDoesNotExist()
    }

    private fun appSession() = (compose.activity.application as OrbitApplication).session
    private fun app() = compose.activity.application as TestOrbitApplication
    private fun awaitLogin() {
        org.junit.Assert.assertSame("Activity and ViewModel must use the same application session", appSession().state,
            androidx.lifecycle.ViewModelProvider(compose.activity)[io.orbitd.android.auth.AuthViewModel::class.java].state)
        compose.waitUntil(60_000) { appSession().state.value is AuthState.SignedOut }
    }
}

/** Picks the login page's server as a person does: the logo's "Change server" action opens the Server dialog (iOS fdeb033ad). */
@OptIn(ExperimentalTestApi::class)
internal fun AndroidComposeTestRule<*, *>.chooseServer(address: String) {
    onNodeWithContentDescription("Orbit").performCustomAccessibilityActionWithLabel("Change server")
    onNodeWithText("Server address").performTextReplacement(address)
    onNodeWithText("Save").performClick()
    waitForIdle()
}

/** Signs in through the login page. The email is replaced, not typed after: the page prefills the server's remembered one. */
internal fun AndroidComposeTestRule<*, *>.signIn(server: String, email: String, password: String) {
    chooseServer(server)
    onNodeWithText("Email").performTextReplacement(email)
    onNodeWithText("Password").performTextReplacement(password)
    onNodeWithText("Sign In").performScrollTo().performClick()
}

open class TestOrbitApplication : OrbitApplication() {
    // Release unit tests must not reach GitHub when an Activity starts.
    override fun createUpdates() = io.orbitd.android.update.AppUpdater(this, processScope,
        io.orbitd.android.update.UpdateConfig.forBuild().copy(enabled = false))
    /** auth/methods answers 404, as a server from before Google sign-in does, unless a test offers Google. */
    @Volatile var methods: () -> ApiResponse = { ApiResponse(404, """{"statusCode":404}""".encodeToByteArray()) }
    @Volatile var exchange: () -> ApiResponse = { ApiResponse(200, LOGIN.encodeToByteArray()) }
    /** auth/login signs the fixture account in, unless a test turns it down. */
    @Volatile var login: () -> ApiResponse = { ApiResponse(200, LOGIN.encodeToByteArray()) }
    val requests: MutableList<HttpRequest> = java.util.Collections.synchronizedList(mutableListOf())
    /** What a sign-in left for the next one: the instance, and each server's email. */
    @Volatile var instance: String? = null
    val emails: MutableMap<String, String> = java.util.concurrent.ConcurrentHashMap()

    override fun createSession(): AuthSession = AuthSession(
        HttpTransport { request ->
            requests += request
            when {
                request.api.path == listOf("auth", "methods") -> methods()
                request.api.path == listOf("auth", "google", "exchange") -> exchange()
                request.api.path == listOf("auth", "login") -> login()
                // The account Settings shows: the one the login answered with.
                request.api.path == listOf("users", "me") -> ApiResponse(200, USER.encodeToByteArray())
                request.api.path.firstOrNull() == "tasks" -> ApiResponse(200, """{"id":"01a0cca7-8609-70ed-a0e2-d4b55b832b60","title":"Linked task"}""".encodeToByteArray())
                // The signed-in shell's directory reads: empty lists.
                else -> ApiResponse(200, "[]".encodeToByteArray())
            }
        },
        object : CredentialStore {
            private var value: StoredSession? = null
            override suspend fun load() = value
            override suspend fun save(session: StoredSession) { value = session }
            override suspend fun clear() { value = null }
        },
        object : InstanceStore {
            override suspend fun load(): String? = instance
            override suspend fun save(server: String) { instance = server }
        },
        object : SessionDataStore {
            override suspend fun read(account: AccountKey, kind: DataKind, key: String): ByteArray? = null
            override suspend fun write(account: AccountKey, kind: DataKind, key: String, bytes: ByteArray) {}
            override suspend fun clearAll() {}
        }, "test",
        emails = object : EmailStore {
            override suspend fun load(server: String): String? = emails[server]
            override suspend fun save(server: String, email: String) { emails[server] = email }
        },
    )
}

private const val USER = """{"id":"u1","email":"fixture@example.test","name":"Fixture"}"""
private const val LOGIN = """{"accessToken":"fixture-access","refreshToken":"fixture-refresh","user":$USER}"""
