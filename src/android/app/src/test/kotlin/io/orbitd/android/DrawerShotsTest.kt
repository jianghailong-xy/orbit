package io.orbitd.android

import android.graphics.Bitmap
import android.graphics.Canvas
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import io.orbitd.android.core.auth.AuthState
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.setMain
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TestWatcher
import org.junit.runner.Description
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.io.File

/** The drawer as iOS draws it (CompactShell `NavigationDrawer`): the page slid right as a card, inset pill rows, one-line workspace
 * rows with one state slot, and the New session / Settings bar over the rows' bottom. Shots to build/evidence/drawer-ios-android. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = NavShellApplication::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
class DrawerShotsTest {
    @get:Rule(order = 0)
    val mainDispatcher = object : TestWatcher() {
        override fun starting(description: Description) { Dispatchers.setMain(UnconfinedTestDispatcher()) }
        override fun finished(description: Description) { Dispatchers.resetMain() }
    }
    @get:Rule(order = 1)
    val compose = createAndroidComposeRule<MainActivity>()

    @Before fun start() = NavShell.reset()

    @Test @Config(qualifiers = "w393dp-h852dp-night-xxhdpi") fun dark() = drawer("01-drawer-dark")
    @Test @Config(qualifiers = "w393dp-h852dp-notnight-xxhdpi") fun light() = drawer("02-drawer-light")

    private fun drawer(name: String) {
        NavShell.running = setOf(NavShell.PLAIN)
        signIn()
        compose.onNodeWithContentDescription("Open navigation").performClick(); compose.waitForIdle()
        compose.onNode(hasText("Alpha") and SemanticsMatcher.expectValue(SemanticsProperties.Role, Role.Tab)).performClick()
        compose.waitForIdle()
        compose.onNodeWithContentDescription("Open navigation").performClick(); compose.waitForIdle()
        compose.onNodeWithTag("drawer:settings").assertIsDisplayed()
        shot(name)
    }

    private fun signIn() {
        val app = compose.activity.application as OrbitApplication
        compose.waitUntil(60_000) { app.session.state.value is AuthState.SignedOut }
        app.realtime.setNetwork(true, "fixture")
        runBlocking { NavShell.signIn(app.session) }
        compose.waitUntil(60_000) { compose.waitForIdle(); app.session.state.value is AuthState.SignedIn && app.realtime.state.value.directoryFresh }
    }

    private fun shot(name: String) {
        compose.waitForIdle()
        val root = generateSequence(File(System.getProperty("user.dir")!!)) { it.parentFile }.first { File(it, "src/android").isDirectory }
        val output = File(root, "src/android/build/evidence/drawer-ios-android").also { it.mkdirs() }
        val view = compose.activity.window.decorView
        val bitmap = Bitmap.createBitmap(view.width, view.height, Bitmap.Config.ARGB_8888)
        view.draw(Canvas(bitmap))
        val file = File(output, "$name.png")
        file.outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
        assertTrue("$name: no PNG written", file.length() > 0)
        println("shot $name ${bitmap.width}x${bitmap.height} -> $file")
    }
}
