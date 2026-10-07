package io.orbitd.android

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onFirst
import androidx.compose.ui.test.performScrollTo
import io.orbitd.android.core.auth.*
import io.orbitd.android.core.net.*
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
@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
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
        compose.onNodeWithText("Orbit Android").assertIsDisplayed()
        compose.onNodeWithText("Instance address").assertIsDisplayed()
    }

    @Test
    fun buildInformationShowsTheInstalledIdentityAndReturnsHome() {
        awaitLogin()
        compose.onNodeWithText("Build information").performScrollTo().performClick()

        compose.onNodeWithText(BuildConfig.APPLICATION_ID).assertIsDisplayed()
        compose.onNodeWithText(BuildConfig.SOURCE_SHA).assertIsDisplayed()
        compose.onNodeWithText(if (BuildConfig.SOURCE_DIRTY) "modified" else "clean").assertIsDisplayed()

        compose.onNodeWithText("Back").performClick()
        compose.onAllNodesWithText("Sign in").onFirst().assertIsDisplayed()
    }

    @Test
    fun recreationPreservesTheNavigationDestination() {
        awaitLogin()
        compose.onNodeWithText("Build information").performScrollTo().performClick()

        compose.activityRule.scenario.recreate()

        compose.onNodeWithText(BuildConfig.APPLICATION_ID).assertIsDisplayed()
        compose.activityRule.scenario.onActivity { it.onBackPressedDispatcher.onBackPressed() }
        compose.onAllNodesWithText("Sign in").onFirst().assertIsDisplayed()
    }

    @Test
    fun loginIsUsableAndLogoutReturnsToAnEmptyPasswordField() {
        awaitLogin()
        compose.onNodeWithText("Instance address").performTextInput("https://example.test")
        compose.onNodeWithText("Email").performTextInput("fixture@example.test")
        compose.onNodeWithText("Password").performTextInput("fixture-password")
        compose.onAllNodesWithText("Sign in")[1].performScrollTo().performClick()
        compose.waitUntil(5_000) { appSession().state.value is AuthState.SignedIn }
        compose.onNodeWithText("Signed in").assertIsDisplayed()
        compose.activityRule.scenario.recreate()
        compose.onNodeWithText("Signed in").assertIsDisplayed()
        compose.onNodeWithText("Sign out").performClick()
        awaitLogin()
        compose.onNodeWithText("Password").assertIsDisplayed()
        compose.onNodeWithText("fixture-password").assertDoesNotExist()
    }

    private fun appSession() = (compose.activity.application as OrbitApplication).session
    private fun awaitLogin() {
        org.junit.Assert.assertSame("Activity and ViewModel must use the same application session", appSession().state,
            androidx.lifecycle.ViewModelProvider(compose.activity)[io.orbitd.android.auth.AuthViewModel::class.java].state)
        compose.waitUntil(5_000) { appSession().state.value is AuthState.SignedOut }
    }
}

class TestOrbitApplication : OrbitApplication() {
    /** auth/methods answers 404, as a server from before Google sign-in does, unless a test offers Google. */
    @Volatile var methods: () -> ApiResponse = { ApiResponse(404, """{"statusCode":404}""".encodeToByteArray()) }
    @Volatile var exchange: () -> ApiResponse = { ApiResponse(200, LOGIN.encodeToByteArray()) }
    val requests: MutableList<HttpRequest> = java.util.Collections.synchronizedList(mutableListOf())

    override fun createSession(): AuthSession = AuthSession(
        HttpTransport { request ->
            requests += request
            when (request.api.path) {
                listOf("auth", "methods") -> methods()
                listOf("auth", "google", "exchange") -> exchange()
                else -> ApiResponse(200, LOGIN.encodeToByteArray())
            }
        },
        object : CredentialStore {
            private var value: StoredSession? = null
            override suspend fun load() = value
            override suspend fun save(session: StoredSession) { value = session }
            override suspend fun clear() { value = null }
        },
        object : InstanceStore {
            override suspend fun load(): String? = null
            override suspend fun save(server: String) {}
        },
        object : SessionDataStore {
            override suspend fun read(account: AccountKey, kind: DataKind, key: String): ByteArray? = null
            override suspend fun write(account: AccountKey, kind: DataKind, key: String, bytes: ByteArray) {}
            override suspend fun clearAll() {}
        }, "test",
    )
}

private const val LOGIN = """{"accessToken":"fixture-access","refreshToken":"fixture-refresh","user":{"id":"u1","email":"fixture@example.test","name":"Fixture"}}"""
