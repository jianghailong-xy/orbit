package io.orbitd.android

import androidx.activity.compose.setContent
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import io.orbitd.android.core.auth.*
import io.orbitd.android.core.net.*
import io.orbitd.android.directory.*
import io.orbitd.android.ui.OrbitTheme
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.util.concurrent.CopyOnWriteArrayList

/** The directory's confirmations ask as every confirmation on a phone does (iOS 6969f7840, A13-15): the question, what it does,
 * and its press beside Cancel — Delete permanently, a folder's Delete in iOS's words, and a move to another workspace in one step,
 * End and Move for a session that has to be ended first (iOS SessionWorkspaceMove). */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = TestOrbitApplication::class)
class DirectoryConfirmationTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()
    private val requests = CopyOnWriteArrayList<String>()
    @Volatile private var needsEnd = true
    @Volatile private var reads = 0
    private val session = DirectorySession("s1", title = "Fixture session", workspaceId = "w1", status = "AWAITING_INPUT")
    private val folder = Folder("f1", "w1", "Specs")

    /** Signed in once per test; every dialog shown after the first reuses it. */
    private val api by lazy { signIn() }

    private fun signIn(): DirectoryApi {
        val auth = (compose.activity.application as OrbitApplication).session
        compose.waitUntil(60_000) { auth.state.value is AuthState.SignedOut }
        runBlocking { auth.login(ServerAddress.parse("https://fixture.test"), "a@example.test", "fixture-password") }
        return DirectoryApi(object : OrbitApi {
            override suspend fun request(handle: SessionHandle, request: ApiRequest) = respond(request)
        }, (auth.state.value as AuthState.SignedIn).handle)
    }

    private fun respond(request: ApiRequest): ApiResponse {
        val path = request.path.joinToString("/")
        requests += "${request.method} $path"
        val body = when (path) {
            "sessions/s1/move-targets" -> """{"workspaceId":"w1","folderId":null,"folders":[],"reason":null,"needsEnd":$needsEnd,
                "branch":"orbit/s1","changedFiles":3,"unmergedFiles":2,"mergeTarget":"main",
                "targets":[{"workspaceId":"w2","name":"Beta","conversation":"continues","runnerOnline":true,"folders":[]}]}"""
            // The session is still ending at the first look, and has ended at the next.
            "sessions/s1" -> """{"id":"s1","title":"Fixture session","status":"${if (reads++ == 0) "AWAITING_INPUT" else "SUCCEEDED"}"}"""
            else -> "{}"
        }
        return ApiResponse(200, body.encodeToByteArray())
    }

    private var shown by mutableStateOf<DirectoryDialog?>(null)

    private fun show(dialog: DirectoryDialog) {
        val api = api
        shown = dialog
        compose.activityRule.scenario.onActivity { activity -> activity.setContent { OrbitTheme {
            shown?.let { DirectoryActionDialog(it, api, DirectoryData(ready = true, fresh = true), { next -> shown = next }, {}) }
        } } }
        compose.waitForIdle()
    }

    private fun inDialog(text: String) = hasText(text) and hasClickAction() and hasAnyAncestor(isDialog())

    /** Waits for [condition] while moving the test clock on: the wait for the session to end is a delay in an effect. */
    private fun until(condition: () -> Boolean) {
        val end = System.currentTimeMillis() + 60_000
        while (!condition()) {
            assertTrue("still waiting after 60 s", System.currentTimeMillis() < end)
            compose.mainClock.advanceTimeBy(250); compose.waitForIdle()
        }
    }

    @Test fun deletingPermanentlyAsksWithCancelBesideTheDestructivePress() {
        show(DirectoryDialog.Purge(session))
        compose.onNodeWithText("Delete permanently?").assertExists()
        compose.onNodeWithText("This session and its full transcript will be permanently deleted. This can't be undone.").assertExists()
        compose.onAllNodes(inDialog("Close")).assertCountEquals(0)
        compose.onNode(inDialog("Cancel")).performClick()
        compose.waitForIdle()
        assertNull(shown)
        assertTrue("Cancel deletes nothing", requests.none { it.startsWith("DELETE") })
        show(DirectoryDialog.Purge(session))
        compose.onNode(inDialog("Delete Permanently")).performClick()
        compose.waitUntil(60_000) { requests.contains("DELETE sessions/s1/purge") }
    }

    @Test fun deletingAFolderSaysItsSessionsMoveBackInIosWords() {
        show(DirectoryDialog.DeleteFolder(folder))
        compose.onNodeWithText("Delete “Specs”?").assertExists()
        compose.onNodeWithText("Its sessions move back to the list. No session is deleted.").assertExists()
        compose.onNode(inDialog("Cancel")).assertExists()
        compose.onNode(inDialog("Delete")).performClick()
        compose.waitUntil(60_000) { requests.contains("DELETE session-folders/f1") }
    }

    @Test fun movingToAnotherWorkspaceIsOneStepEndAndMoveForAnIdleSession() {
        show(DirectoryDialog.Move(session))
        compose.waitUntil(60_000) { compose.onAllNodes(hasText("Beta") and hasClickAction()).fetchSemanticsNodes().isNotEmpty() }
        compose.onNode(hasText("Beta") and hasClickAction()).assertIsEnabled().performClick()
        compose.onNodeWithText("Move to Beta?").assertExists()
        compose.onNodeWithText("The session ends first.", substring = true).assertExists()
        compose.onNodeWithText("2 changed files aren’t merged into main yet. They stay on branch orbit/s1", substring = true).assertExists()
        compose.onNode(inDialog("Cancel")).assertExists()
        compose.onNode(inDialog("End and Move")).performClick()
        until { requests.contains("POST sessions/s1/move") }
        val steps = requests.filter { it.startsWith("POST") || it == "GET sessions/s1" }
        assertEquals("ended, waited until it had, then moved",
            listOf("POST sessions/s1/end", "GET sessions/s1", "GET sessions/s1", "POST sessions/s1/move"), steps)
    }

    @Test fun aSessionThatNeedsNoEndMovesWithMove() {
        needsEnd = false
        show(DirectoryDialog.Move(session))
        compose.waitUntil(60_000) { compose.onAllNodes(hasText("Beta") and hasClickAction()).fetchSemanticsNodes().isNotEmpty() }
        compose.onNode(hasText("Beta") and hasClickAction()).performClick()
        compose.onAllNodesWithText("The session ends first.", substring = true).assertCountEquals(0)
        compose.onNode(inDialog("Cancel")).assertExists()
        compose.onNode(inDialog("Move")).performClick()
        compose.waitUntil(60_000) { requests.contains("POST sessions/s1/move") }
        assertFalse("nothing is ended", requests.contains("POST sessions/s1/end"))
    }
}
