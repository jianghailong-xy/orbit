package io.orbitd.android.translation

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
import io.orbitd.android.core.protocol.Wire
import io.orbitd.android.management.ManagementApi
import io.orbitd.android.management.SESSION_RECAPS
import io.orbitd.android.management.SettingsScreen
import io.orbitd.android.navigation.Destination
import io.orbitd.android.navigation.OrbitRoute
import io.orbitd.android.ui.OrbitTheme
import java.io.File
import java.util.concurrent.CopyOnWriteArrayList
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * Settings › Sessions › Translation on Android (docs/mocks/session-translation/01-board.png, frames 2 and 9): the group with its switch
 * and what it does, Your language from a bottom sheet of the seven, Agents work in English and read-only; each written alone as it
 * moves; off by default; and, on a server without a DeepSeek key, all of it disabled under frame 2's notice. The real `SettingsScreen`
 * over a fake account, whose frames go under `src/android/build/evidence/session-translation-android/`.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = TestOrbitApplication::class, qualifiers = "w411dp-h1100dp")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class TranslationSettingsTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()

    /** The account's preferences as the server holds them, and every write to them. */
    private var preferences = JsonObject(mapOf("defaultPermissionMode" to JsonPrimitive("auto")))
    private var available = true
    private val writes = CopyOnWriteArrayList<JsonObject>()

    private fun user() = buildJsonObject {
        put("id", "u1"); put("email", "owner@example.test"); put("name", "Owner"); put("preferences", preferences)
        put("translationAvailable", available)
    }

    private fun stub() = object : OrbitApi {
        override suspend fun request(handle: SessionHandle, request: ApiRequest): ApiResponse {
            val body = when (request.path) {
                listOf("users", "me") -> user().toString()
                listOf("users", "me", "preferences") -> {
                    val patch = Wire.json.parseToJsonElement(request.body!!.decodeToString()).jsonObject
                    writes += patch
                    preferences = JsonObject(preferences + patch)
                    user().toString()
                }
                else -> "[]"
            }
            return ApiResponse(200, body.encodeToByteArray())
        }
    }

    private fun signedIn(): SessionHandle {
        val session = (compose.activity.application as OrbitApplication).session
        compose.waitUntil(60_000) { session.state.value is AuthState.SignedOut }
        runBlocking { session.login(ServerAddress.parse("https://fixture.test"), "owner@example.test", "fixture-password") }
        return (session.state.value as AuthState.SignedIn).handle
    }

    private fun open() {
        val api = ManagementApi(stub(), signedIn())
        compose.activityRule.scenario.onActivity { activity -> activity.setContent { OrbitTheme {
            SettingsScreen(api, OrbitRoute(Destination.SETTINGS, "sessions"), 0, {}, {}, logout = {}, changed = {}, workspaceDeleted = {},
                deviceAlerts = { true }, notifications = {}, about = {})
        } } }
        compose.waitUntil(60_000) { compose.onAllNodesWithText(TranslationCopy.TRANSLATE_CONVERSATIONS).fetchSemanticsNodes().isNotEmpty() }
        compose.waitUntil(60_000) { compose.onAllNodes(hasText(TranslationCopy.TRANSLATE_CONVERSATIONS) and isToggleable() and isEnabled())
            .fetchSemanticsNodes().isNotEmpty() || !available }
    }

    private val output: File by lazy {
        val root = generateSequence(File(System.getProperty("user.dir"))) { it.parentFile }.first { File(it, "src/android/settings.gradle.kts").isFile }
        File(root, "src/android/build/evidence/session-translation-android").also { it.mkdirs() }
    }

    private fun shot(name: String) {
        compose.waitForIdle()
        File(output, "$name-semantics.txt").writeText(compose.onRoot(useUnmergedTree = true).printToString())
        val view = compose.activity.window.decorView
        val bitmap = Bitmap.createBitmap(view.width, view.height, Bitmap.Config.ARGB_8888)
        view.draw(Canvas(bitmap))
        val pixels = IntArray(bitmap.width * bitmap.height).also { bitmap.getPixels(it, 0, bitmap.width, 0, 0, bitmap.width, bitmap.height) }
        assertTrue("$name: the shot is blank", pixels.any { it != 0 })
        File(output, "$name.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
        println("shot $name ${bitmap.width}×${bitmap.height} -> ${File(output, "$name.png")}")
        bitmap.recycle()
    }

    private fun top(text: String) = compose.onNodeWithText(text).fetchSemanticsNode().positionInRoot.y
    private val toggle get() = compose.onNode(hasText(TranslationCopy.TRANSLATE_CONVERSATIONS) and isToggleable())

    @Test fun theGroupIsOffByDefaultAndEachRowIsWrittenAloneAsItMoves() {
        open()
        // The group, after the default permission and before the rest, as the board places it under Session defaults.
        compose.onNodeWithText(TranslationCopy.TITLE).assertIsDisplayed()
        assertTrue(top("Default permission") < top(TranslationCopy.TITLE) && top(TranslationCopy.TITLE) < top("Session orchestration"))
        compose.onNodeWithText(TranslationCopy.TRANSLATE_CONVERSATIONS_HINT).assertIsDisplayed()
        compose.onNodeWithText(TranslationCopy.FOOTER).assertIsDisplayed()
        toggle.assertIsOff()
        compose.onNodeWithText(Translation_name_default).assertIsDisplayed()
        compose.onNodeWithText(TranslationCopy.ENGLISH).assertIsDisplayed()
        compose.onAllNodesWithText(TranslationCopy.UNAVAILABLE).assertCountEquals(0)
        // Agents work in is shown, never offered.
        compose.onNode(hasText(TranslationCopy.AGENTS_WORK_IN) and hasClickAction()).assertDoesNotExist()

        toggle.performClick()
        compose.waitUntil(60_000) { writes.isNotEmpty() }
        assertEquals(buildJsonObject { put("translationEnabled", true) }, writes.single())
        compose.waitUntil(60_000) { runCatching { toggle.assertIsOn() }.isSuccess }

        // Your language: a bottom sheet of the seven, one of them picked; a pick is written alone.
        compose.onNode(hasText(TranslationCopy.YOUR_LANGUAGE) and hasClickAction()).performClick()
        compose.waitUntil(60_000) { compose.onAllNodesWithText("German").fetchSemanticsNodes().isNotEmpty() }
        listOf("Chinese (Traditional)", "Japanese", "Korean", "Spanish", "French", "German").forEach { compose.onNodeWithText(it).assertExists() }
        compose.onNode(hasText(Translation_name_default) and isSelectable()).assertIsSelected()
        compose.onNode(hasText("Japanese") and isSelectable()).performClick()
        compose.waitUntil(60_000) { writes.size == 2 }
        assertEquals(buildJsonObject { put("translationLanguage", "ja") }, writes[1])
        compose.waitUntil(60_000) { compose.onAllNodesWithText("Japanese").fetchSemanticsNodes().size == 1 }
        compose.onAllNodesWithText(SESSION_RECAPS).assertCountEquals(1)
    }

    @Test fun theBoardsFrameNine() {
        preferences = JsonObject(preferences + ("translationEnabled" to JsonPrimitive(true)) + ("translationLanguage" to JsonPrimitive("zh-Hans")))
        open()
        toggle.assertIsOn()
        compose.onNodeWithText(Translation_name_default).assertIsDisplayed()
        shot("5-settings-translation-group")
    }

    @Test fun aServerWithoutADeepSeekKeyDrawsItDisabledUnderTheNotice() {
        available = false
        preferences = JsonObject(preferences + ("translationEnabled" to JsonPrimitive(true)))
        open()
        compose.waitUntil(60_000) { compose.onAllNodesWithText(TranslationCopy.UNAVAILABLE).fetchSemanticsNodes().isNotEmpty() }
        // Whatever the preference says, the switch reads off and nothing can be pressed.
        toggle.assertIsOff().assertIsNotEnabled()
        compose.onNode(hasText(TranslationCopy.YOUR_LANGUAGE) and hasClickAction()).assertIsNotEnabled()
        assertTrue(top(TranslationCopy.TRANSLATE_CONVERSATIONS) < top(TranslationCopy.UNAVAILABLE) && top(TranslationCopy.UNAVAILABLE) < top(TranslationCopy.YOUR_LANGUAGE))
        shot("6-settings-unavailable")
        assertTrue(writes.isEmpty())
    }

    private companion object { const val Translation_name_default = "Chinese (Simplified)" }
}
