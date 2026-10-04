package io.orbitd.android

import androidx.activity.compose.setContent
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import io.orbitd.android.core.auth.*
import io.orbitd.android.core.net.*
import io.orbitd.android.directory.*
import io.orbitd.android.navigation.*
import io.orbitd.android.ui.OrbitTheme
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
        compose.waitUntil(5_000) { session.state.value is AuthState.SignedOut }
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
