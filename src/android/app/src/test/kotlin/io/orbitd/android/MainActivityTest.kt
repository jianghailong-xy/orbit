package io.orbitd.android

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
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
        compose.onNodeWithContentDescription("Open navigation").performClick()
        compose.onNodeWithText("Settings").performScrollTo().performClick()
        compose.onNodeWithText("Signed in").assertIsDisplayed()
        compose.activityRule.scenario.recreate()
        compose.onNodeWithText("Signed in").assertIsDisplayed()
        compose.onNodeWithText("Sign out").performClick()
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
        compose.onNodeWithText("Instance address").performTextInput("https://example.test")
        compose.onNodeWithText("Email").performTextInput("fixture@example.test")
        compose.onNodeWithText("Password").performTextInput("fixture-password")
        compose.onAllNodesWithText("Sign in")[1].performScrollTo().performClick()
        compose.waitUntil(5_000) { compose.onAllNodesWithText("Linked task").fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithText("Linked task").assertIsDisplayed()
        compose.activityRule.scenario.onActivity { it.onBackPressedDispatcher.onBackPressed() }
        compose.onNodeWithContentDescription("Open navigation").assertIsDisplayed()
        compose.onNodeWithText("Linked task").assertDoesNotExist()
    }

    private fun appSession() = (compose.activity.application as OrbitApplication).session
    private fun awaitLogin() {
        org.junit.Assert.assertSame("Activity and ViewModel must use the same application session", appSession().state,
            androidx.lifecycle.ViewModelProvider(compose.activity)[io.orbitd.android.auth.AuthViewModel::class.java].state)
        compose.waitUntil(5_000) { appSession().state.value is AuthState.SignedOut }
    }
}

class TestOrbitApplication : OrbitApplication() {
    override fun createSession(): AuthSession = AuthSession(
        HttpTransport { request -> ApiResponse(200, (if (request.api.path == listOf("auth", "login")) """{"accessToken":"fixture-access","refreshToken":"fixture-refresh","user":{"id":"u1","email":"fixture@example.test","name":"Fixture"}}""" else if (request.api.path.firstOrNull() == "tasks") """{"id":"01a0cca7-8609-70ed-a0e2-d4b55b832b60","title":"Linked task"}""" else "[]").encodeToByteArray()) },
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
