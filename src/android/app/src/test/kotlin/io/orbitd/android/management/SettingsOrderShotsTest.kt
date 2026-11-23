package io.orbitd.android.management

import android.graphics.Bitmap
import android.graphics.Canvas
import androidx.activity.compose.setContent
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import io.orbitd.android.MainActivity
import io.orbitd.android.OrbitApplication
import io.orbitd.android.TestOrbitApplication
import io.orbitd.android.core.auth.*
import io.orbitd.android.core.net.*
import io.orbitd.android.navigation.Destination
import io.orbitd.android.navigation.OrbitRoute
import io.orbitd.android.ui.OrbitTheme
import java.io.File
import java.time.Instant
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/** The screenshots of Settings in the order the owner picked on docs/mocks/ios-settings-web-groups (1A 2A 3A), the web Settings nav's:
 * Personal — General, Notifications, Appearance, Profile, Shared links, Access tokens, Terminals — then Machines — one machine offline,
 * so it says what needs you — then Providers, then Sign out; the Profile page with the email and Change password; and the General page
 * with its settings, each with its hint under it, Optimize For's segments below Smart model selection. Compose/Robolectric shots of the real `SettingsScreen` over fake
 * reads, written to PNGs under `src/android/build/evidence/ios-settings-order-android/`; what the pictures are for is asserted too, so
 * a shot that drew the old order fails rather than being kept. The account and machines are invented. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = TestOrbitApplication::class, qualifiers = "w411dp-h900dp")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class SettingsOrderShotsTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()

    private val output: File by lazy {
        val root = generateSequence(File(System.getProperty("user.dir"))) { it.parentFile }
            .first { File(it, "src/android").isDirectory && File(it, "docs/evidence").isDirectory }
        File(root, "src/android/build/evidence/ios-settings-order-android").also { it.mkdirs() }
    }

    private fun signedIn(): SessionHandle {
        val session = (compose.activity.application as OrbitApplication).session
        compose.waitUntil(60_000) { session.state.value is AuthState.SignedOut }
        runBlocking { session.login(ServerAddress.parse("https://fixture.test"), "alex@example.com", "fixture-password") }
        return (session.state.value as AuthState.SignedIn).handle
    }

    /** The account, two machines — one of them offline — and an empty list for every other read the two pages make. */
    private fun stub() = object : OrbitApi {
        override suspend fun request(handle: SessionHandle, request: ApiRequest): ApiResponse {
            val now = Instant.now()
            val body = when (request.path) {
                listOf("users", "me") -> """{"id":"u1","email":"alex@example.com","name":"Alex","preferences":{"theme":"system",""" +
                    """"defaultPermissionMode":"auto","enableOrchestration":true}}"""
                listOf("runners") -> """[{"id":"r1","name":"workstation","online":true,"lastHeartbeatAt":"$now","maxConcurrent":4},""" +
                    """{"id":"r2","name":"spare-box","online":false,"lastHeartbeatAt":"${now.minusSeconds(3 * 86_400)}","maxConcurrent":2}]"""
                else -> "[]"
            }
            return ApiResponse(200, body.encodeToByteArray())
        }
    }

    private fun open(page: String?) {
        val api = ManagementApi(stub(), signedIn())
        compose.activityRule.scenario.onActivity { activity -> activity.setContent { OrbitTheme {
            SettingsScreen(api, OrbitRoute(Destination.SETTINGS, page), 0, {}, {}, logout = {}, changed = {}, workspaceDeleted = {},
                deviceAlerts = { true }, notifications = {}, about = {})
        } } }
    }

    private fun await(text: String) = compose.waitUntil(60_000) {
        compose.onAllNodesWithText(text, substring = true).fetchSemanticsNodes().isNotEmpty()
    }

    private fun top(text: String) = compose.onNodeWithText(text).fetchSemanticsNode().positionInRoot.y

    /** The screen as a PNG, and never a blank one; the semantics tree goes beside it. */
    private fun shot(name: String) {
        compose.waitForIdle()
        val roots = compose.onAllNodes(isRoot())
        File(output, "$name-semantics.txt").writeText(
            (0 until roots.fetchSemanticsNodes().size).joinToString("\n\n") { roots[it].printToString() })
        val view = compose.activity.window.decorView
        assertTrue("$name: the view was never laid out (${view.width}×${view.height})", view.width > 0 && view.height > 0)
        val bitmap = Bitmap.createBitmap(view.width, view.height, Bitmap.Config.ARGB_8888)
        view.draw(Canvas(bitmap))
        val pixels = IntArray(bitmap.width * bitmap.height)
        bitmap.getPixels(pixels, 0, bitmap.width, 0, 0, bitmap.width, bitmap.height)
        assertTrue("$name: the shot is blank — the graphics mode drew nothing", pixels.any { it != 0 })
        val file = File(output, "$name.png")
        file.outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
        assertTrue("$name: no PNG was written", file.length() > 0)
        println("shot $name ${bitmap.width}×${bitmap.height} -> $file")
        bitmap.recycle()
    }

    @Test fun theListTakesTheWebNavsGroups() {
        open(null)
        await("1 needs you")
        val order = listOf(SETTINGS_PERSONAL, GENERAL, "Notifications", "Appearance", SETTINGS_PROFILE, "Shared links", AccessTokens.TITLE,
            MachinesAndModels.MACHINES, SETTINGS_PROVIDERS, "Sign out")
        val tops = order.map(::top)
        assertEquals("top to bottom: $order", tops.sorted(), tops)
        // No Terminals row: each machine's page lists its own terminals (docs/mocks/terminals-on-machine-page).
        listOf("Preferences", "Account", "Instance", "Admin", "Email", "Change password", MachinesAndModels.TITLE, SESSION_RECAPS, Terminals.TITLE)
            .forEach { compose.onAllNodesWithText(it).assertCountEquals(0) }
        compose.onAllNodesWithText("Orbit ", substring = true).assertCountEquals(0)
        shot("settings-home")
    }

    @Test fun theProfilePageHoldsTheEmailAndChangePassword() {
        open("account")
        await("alex@example.com")
        assertTrue(top("Email") < top("Change password"))
        compose.onNode(hasText("Change password") and hasClickAction()).assertExists()
        assertEquals(SETTINGS_PROFILE, settingsTitle("account"))
        shot("settings-profile")
    }

    @Test fun theGeneralPageHoldsTheSettings() {
        open("sessions")
        await(SESSION_RECAPS)
        // The fixture sets no modelRouting, which reads as on (smartModelSelection), so Optimize For shows, on Balance.
        compose.onNode(hasText(SMART_MODEL_SELECTION) and isToggleable()).assertIsOn()
        compose.onNode(hasText("Balance") and isSelectable()).assertIsSelected()
        compose.onNode(hasText(SESSION_RECAPS) and isToggleable()).assertIsOn()
        shot("settings-sessions")
    }
}
