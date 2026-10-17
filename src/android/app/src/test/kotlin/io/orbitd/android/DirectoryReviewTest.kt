package io.orbitd.android

import androidx.activity.compose.setContent
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import io.orbitd.android.core.auth.*
import io.orbitd.android.core.net.*
import io.orbitd.android.directory.*
import io.orbitd.android.management.LocalSessionRecaps
import io.orbitd.android.navigation.*
import io.orbitd.android.ui.OrbitTheme
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.temporal.ChronoUnit
import java.util.Locale
import kotlinx.coroutines.runBlocking
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = TestOrbitApplication::class)
class DirectoryReviewTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()
    private fun api(response: () -> ApiResponse): DirectoryApi {
        val session = (compose.activity.application as OrbitApplication).session
        compose.waitUntil(60_000) { session.state.value is AuthState.SignedOut }
        runBlocking { session.login(ServerAddress.parse("https://fixture.test"), "a@example.test", "fixture-password") }
        return DirectoryApi(object : OrbitApi {
            override suspend fun request(handle: SessionHandle, request: ApiRequest) = response()
        }, (session.state.value as AuthState.SignedIn).handle)
    }

    @Test fun realUntaggedTagAndUnfiledBucketRenderTogether() {
        val api = api { ApiResponse(200, "[]".encodeToByteArray()) }
        val rows = listOf(DirectorySession("a", title = "Tagged session", workspaceId = "w", tags = listOf(Tag("t", "Untagged"))),
            DirectorySession("b", title = "No tag session", workspaceId = "w"))
        compose.activityRule.scenario.onActivity { activity -> activity.setContent { OrbitTheme {
            DirectoryScreen(OrbitRoute(Destination.WORKSPACE, "w"), DirectoryData(sessions = mapOf("open" to rows), ready = true, fresh = true), api, {}, {})
        } } }
        compose.onNodeWithText("By time").performClick()
        compose.onNodeWithTag("directory-list").performScrollToNode(hasText("No tag session"))
        compose.onNodeWithText("No tag session").assertIsDisplayed()
        compose.onNodeWithTag("directory-list").performScrollToNode(hasText("Tagged session"))
        compose.onNodeWithText("Tagged session").assertIsDisplayed()
    }

    /** The second line over a session the server has recapped (0418): the recap, under its own muted "Recap · <time>" label, takes
     * the place of the raw last reply — and with the account's Session recaps switch off it falls straight back to that reply. */
    @Test fun theRowShowsTheRecapUnderItsLabelAndTheSwitchTakesItAway() {
        val recap = "Moved the recap onto the list row; the three states are covered by tests."
        val writtenAt = Instant.now().truncatedTo(ChronoUnit.SECONDS)
        // Deterministic in any time zone: the instant is today's, by the same formatter and zone the row's label reads it with.
        val label = "Recap · " + DateTimeFormatter.ofPattern("h:mm a", Locale.US).withZone(ZoneId.systemDefault()).format(writtenAt)
        val rows = listOf(
            DirectorySession("a", title = "Recap on the list row", workspaceId = "w",
                lastAssistantText = "Committed the row change.", recapText = recap, recapAt = writtenAt.toString()),
            DirectorySession("b", title = "Drawer shadow fix", workspaceId = "w", lastAssistantText = "Fixed the drawer shadow."))
        val api = api { ApiResponse(200, "[]".encodeToByteArray()) }
        var recaps by mutableStateOf(true)
        compose.activityRule.scenario.onActivity { activity -> activity.setContent { OrbitTheme {
            CompositionLocalProvider(LocalSessionRecaps provides recaps) {
                DirectoryScreen(OrbitRoute(Destination.WORKSPACE, "w"),
                    DirectoryData(sessions = mapOf("open" to rows), ready = true, fresh = true), api, {}, {})
            }
        } } }
        compose.onNodeWithTag("directory-list").performScrollToNode(hasText("Recap on the list row"))
        // The label and the recap, drawn as one line, and not the reply it replaced.
        compose.onNodeWithText("$label $recap", substring = true).assertIsDisplayed()
        compose.onAllNodesWithText("Committed the row change.", substring = true).assertCountEquals(0)
        // A session with no recap is the reply preview it always had.
        compose.onNodeWithTag("directory-list").performScrollToNode(hasText("Drawer shadow fix"))
        compose.onNodeWithText("Fixed the drawer shadow.", substring = true).assertIsDisplayed()

        // The switch off: the same row falls back to the reply, with no label in front of it.
        recaps = false
        compose.onNodeWithText("Committed the row change.", substring = true).assertIsDisplayed()
        compose.onAllNodesWithText("$label $recap", substring = true).assertCountEquals(0)
    }

    @Test fun forbiddenObjectWithdrawsOldDetailsLinksAndActionsThenRecovers() = objectRefresh(403)
    @Test fun deletedObjectWithdrawsOldDetailsLinksAndActionsThenRecovers() = objectRefresh(404)
    @Test fun temporaryNetworkFailureKeepsExplicitlyStaleReadonlyDetailsThenRecovers() = objectRefresh(-1)

    private fun objectRefresh(status: Int) {
        var failure = 0
        val revision = mutableLongStateOf(0)
        val api = api {
            if (failure == -1) throw NetworkException()
            if (failure != 0) throw ApiError.parse(failure, "{}".encodeToByteArray())
            ApiResponse(200, """{"id":"s","title":"Private details","description":"Private description","projectId":"p","capabilities":{"canComplete":true}}""".encodeToByteArray())
        }
        compose.activityRule.scenario.onActivity { activity -> activity.setContent { OrbitTheme {
            ObjectDestination(OrbitRoute(Destination.SESSION, "s"), api, DirectoryData(ready = true, fresh = true), revision.longValue, {}, {})
        } } }
        compose.onNodeWithText("Private details").assertIsDisplayed()
        compose.onNodeWithText("Session options").assertIsDisplayed()
        compose.runOnIdle { failure = status; revision.longValue++ }
        compose.onNodeWithText("Couldn't open this item").assertIsDisplayed()
        if (status == -1) {
            compose.onNodeWithText("Private details").assertExists()
            compose.onNodeWithText("Showing previously loaded details. Reconnect and retry before making changes.").assertExists()
            compose.onNodeWithText("Open project").assertIsNotEnabled()
            compose.onNodeWithText("Session options").assertIsNotEnabled()
        } else {
            compose.onNodeWithText("Private details").assertDoesNotExist()
            compose.onNodeWithText("Private description").assertDoesNotExist()
            compose.onNodeWithText("Open project").assertDoesNotExist()
            compose.onNodeWithText("Session options").assertDoesNotExist()
        }
        compose.runOnIdle { failure = 0; revision.longValue++ }
        compose.onNodeWithText("Private details").assertIsDisplayed()
        compose.onNodeWithText("Session options").assertIsEnabled()
    }
}
