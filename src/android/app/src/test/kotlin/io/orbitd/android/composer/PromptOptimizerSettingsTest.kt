package io.orbitd.android.composer

import androidx.activity.compose.setContent
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import io.orbitd.android.MainActivity
import io.orbitd.android.OrbitApplication
import io.orbitd.android.TestOrbitApplication
import io.orbitd.android.core.auth.*
import io.orbitd.android.core.net.*
import io.orbitd.android.core.promptoptimizer.PromptOptimizerCopy
import io.orbitd.android.core.protocol.Wire
import io.orbitd.android.management.ManagementApi
import io.orbitd.android.management.SUGGESTED_REPLIES
import io.orbitd.android.management.SESSION_RECAPS
import io.orbitd.android.management.SettingsScreen
import io.orbitd.android.navigation.Destination
import io.orbitd.android.navigation.OrbitRoute
import io.orbitd.android.ui.OrbitTheme
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
 * Settings › Sessions › Prompt optimizer on Android (board docs/mocks/prompt-optimizer, frames 1 and 1b; iOS SessionSettings'
 * promptOptimizerSection): one switch right under Suggested replies, on by default (absent = on; owner's decision of 2026-11-16), no NEW badge, written alone as it moves; on a
 * server without a DeepSeek key, off and disabled under the DEEPSEEK_API_KEY notice. Frames go to
 * `src/android/build/evidence/prompt-optimizer-android/`.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = TestOrbitApplication::class, qualifiers = "w411dp-h891dp-xxhdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class PromptOptimizerSettingsTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()

    private var preferences = JsonObject(mapOf("defaultPermissionMode" to JsonPrimitive("auto")))
    private var available = true
    private val writes = CopyOnWriteArrayList<JsonObject>()

    private fun user() = buildJsonObject {
        put("id", "u1"); put("email", "owner@example.test"); put("name", "Owner"); put("preferences", preferences)
        put("translationAvailable", true); put("promptOptimizerAvailable", available)
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

    private fun open() {
        val session = (compose.activity.application as OrbitApplication).session
        compose.waitUntil(60_000) { session.state.value is AuthState.SignedOut }
        runBlocking { session.login(ServerAddress.parse("https://fixture.test"), "owner@example.test", "fixture-password") }
        val api = ManagementApi(stub(), (session.state.value as AuthState.SignedIn).handle)
        compose.activityRule.scenario.onActivity { activity -> activity.setContent { OrbitTheme {
            SettingsScreen(api, OrbitRoute(Destination.SETTINGS, "sessions"), 0, {}, {}, logout = {}, changed = {}, workspaceDeleted = {},
                deviceAlerts = { true }, notifications = {}, about = {})
        } } }
        compose.waitUntil(60_000) { compose.onAllNodes(hasText(SUGGESTED_REPLIES) and isToggleable() and isEnabled()).fetchSemanticsNodes().isNotEmpty() }
    }

    private fun top(text: String) = compose.onNodeWithText(text).fetchSemanticsNode().positionInRoot.y
    private val toggle get() = compose.onNode(hasText(PromptOptimizerCopy.TITLE) and isToggleable())

    /** Scrolls the group into the frame's middle, as iOS's frame 1 shows it. */
    private fun frame(name: String) {
        compose.onNodeWithText(SESSION_RECAPS).performScrollTo()
        PromptOptimizerFrames.shot(compose, name)
    }

    @Test fun theSwitchSitsUnderSuggestedRepliesIsOnByDefaultAndIsWrittenAlone() {
        open()
        assertFalse("an untouched account", preferences.containsKey("promptOptimizer"))
        toggle.assertIsOn().assertIsEnabled()
        assertTrue(top(SUGGESTED_REPLIES) < top(PromptOptimizerCopy.TITLE) && top(PromptOptimizerCopy.TITLE) < top(SESSION_RECAPS))
        compose.onNodeWithText(PromptOptimizerCopy.HINT).assertExists()
        compose.onAllNodesWithText(PromptOptimizerCopy.UNAVAILABLE).assertCountEquals(0)
        compose.onAllNodesWithText("NEW", substring = true, ignoreCase = false).assertCountEquals(0)
        frame("1-settings")
        toggle.performClick()
        compose.waitUntil(60_000) { writes.isNotEmpty() }
        assertEquals(buildJsonObject { put("promptOptimizer", false) }, writes.single())
        compose.waitUntil(60_000) { runCatching { toggle.assertIsOff() }.isSuccess }
        toggle.performClick()
        compose.waitUntil(60_000) { writes.size == 2 }
        assertEquals(buildJsonObject { put("promptOptimizer", true) }, writes[1])
    }

    @Test fun anAccountThatTurnedItOffReadsOff() {
        preferences = JsonObject(preferences + ("promptOptimizer" to JsonPrimitive(false)))
        open()
        toggle.assertIsOff().assertIsEnabled()
    }

    @Test fun aServerWithoutAKeyDrawsItOffAndDisabledUnderTheNotice() {
        available = false
        preferences = JsonObject(preferences + ("promptOptimizer" to JsonPrimitive(true)))
        open()
        compose.waitUntil(60_000) { compose.onAllNodesWithText(PromptOptimizerCopy.UNAVAILABLE).fetchSemanticsNodes().isNotEmpty() }
        assertEquals("This server has no DeepSeek key (DEEPSEEK_API_KEY), so it cannot optimize prompts.", PromptOptimizerCopy.UNAVAILABLE)
        toggle.assertIsOff().assertIsNotEnabled()
        assertTrue(top(PromptOptimizerCopy.TITLE) < top(PromptOptimizerCopy.UNAVAILABLE))
        frame("1b-unavailable")
        toggle.performClick()
        compose.waitForIdle()
        assertTrue(writes.isEmpty())
    }
}
