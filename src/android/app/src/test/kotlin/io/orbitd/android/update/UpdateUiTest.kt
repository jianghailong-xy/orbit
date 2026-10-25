package io.orbitd.android.update

import android.content.Intent
import android.content.pm.PackageInstaller
import android.provider.Settings
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.lifecycle.Lifecycle
import io.orbitd.android.BuildConfig
import io.orbitd.android.MainActivity
import io.orbitd.android.OrbitApplication
import io.orbitd.android.TestOrbitApplication
import io.orbitd.android.signIn
import io.orbitd.android.core.auth.AuthState
import java.io.File
import java.util.concurrent.CopyOnWriteArrayList
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.setMain
import okhttp3.mockwebserver.MockWebServer
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TestWatcher
import org.junit.runner.Description
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

internal object UpdateUiFixture {
    const val SIGNER = "1535cc478f09a4209585518569428c9a0f12bd14add7309fba3547609ca82310"
    val github by lazy { GitHubFixture(MockWebServer().apply { start() }) }
    val inspector = FakeInspector(setOf(SIGNER))
    val installed = CopyOnWriteArrayList<File>()
}

class UpdateTestApplication : TestOrbitApplication() {
    override fun createUpdates() = AppUpdater(this, processScope,
        UpdateConfig(true, UpdateUiFixture.github.listUrl, BuildConfig.APPLICATION_ID, BuildConfig.VERSION_CODE.toLong(), 29, "test"),
        UpdateUiFixture.inspector, { UpdateUiFixture.installed += it })
}

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = UpdateTestApplication::class)
@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
class UpdateUiTest {
    private val code = BuildConfig.VERSION_CODE + 1L

    @get:Rule(order = 0)
    val fixture = object : TestWatcher() {
        override fun starting(description: Description) {
            Dispatchers.setMain(UnconfinedTestDispatcher())
            UpdateUiFixture.github.publish("9.0.0", code, ByteArray(70_000) { it.toByte() }, UpdateUiFixture.SIGNER,
                applicationId = BuildConfig.APPLICATION_ID)
            UpdateUiFixture.inspector.archive = { ArchiveIdentity(BuildConfig.APPLICATION_ID, code, setOf(UpdateUiFixture.SIGNER)) }
            UpdateUiFixture.inspector.canInstall = false
        }
        override fun finished(description: Description) { Dispatchers.resetMain() }
    }

    @get:Rule(order = 1)
    val compose = createAndroidComposeRule<MainActivity>()

    private fun waitForText(text: String) = compose.waitUntil(60_000) { compose.onAllNodesWithText(text).fetchSemanticsNodes().isNotEmpty() }

    @Test
    fun launchPromptsThenSettingsAboutInstallsAfterUnknownAppsPermission() {
        // Starting the app is an automatic check; the newer v* release's Android build is offered once.
        waitForText("Update available")
        compose.onNodeWithText("Orbit 9.0.0 ($code) is available.").assertIsDisplayed()
        compose.onNodeWithText("Notes for 9.0.0").assertIsDisplayed()
        compose.onNodeWithText("Later").performClick()
        compose.waitUntil(60_000) { compose.onAllNodesWithText("Update available").fetchSemanticsNodes().isEmpty() }

        compose.signIn("https://example.test", "fixture@example.test", "fixture-password")
        val app = compose.activity.application as OrbitApplication
        compose.waitUntil(60_000) { app.session.state.value is AuthState.SignedIn }
        compose.onNodeWithContentDescription("Open navigation").performClick()
        compose.onNodeWithText("Settings").performScrollTo().performClick()

        // Settings → About: the installed version, the found update and a manual check.
        compose.onNodeWithText("About").performScrollTo().performClick()
        compose.onNodeWithText("Orbit ${BuildConfig.VERSION_NAME} (${BuildConfig.VERSION_CODE})").assertIsDisplayed()
        compose.onNodeWithText("Check for updates").performScrollTo().performClick()
        waitForText("Download and install")
        compose.onNodeWithText("Download and install").performScrollTo().performClick()

        waitForText("Open settings")
        compose.onNodeWithText("Open settings").performScrollTo().performClick()
        val settings = shadowOf(compose.activity).nextStartedActivity
        assertEquals(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, settings.action)
        assertEquals("package:${compose.activity.packageName}", settings.dataString)

        // Returning from Settings with the permission granted continues the same verified update.
        UpdateUiFixture.inspector.canInstall = true
        compose.activityRule.scenario.moveToState(Lifecycle.State.CREATED)
        compose.activityRule.scenario.moveToState(Lifecycle.State.RESUMED)
        waitForText("Waiting for Android to install the update…")
        assertEquals(File(compose.activity.noBackupFilesDir, "updates/orbit-$code.apk"), UpdateUiFixture.installed.single())

        val confirm = Intent("android.content.pm.action.CONFIRM_INSTALL")
        compose.runOnUiThread { app.updates.onInstallStatus(PackageInstaller.STATUS_PENDING_USER_ACTION, confirm) }
        compose.waitForIdle()
        assertEquals(confirm.action, shadowOf(compose.activity).nextStartedActivity.action)
    }
}
