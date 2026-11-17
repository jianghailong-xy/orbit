package io.orbitd.android.cards

import android.graphics.Bitmap
import android.graphics.Canvas
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.assertTextEquals
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.unit.dp
import io.orbitd.android.MainActivity
import io.orbitd.android.TestOrbitApplication
import io.orbitd.android.core.cards.CardActionState
import io.orbitd.android.core.cards.CardCatalog
import io.orbitd.android.core.cards.ExceptionCards
import io.orbitd.android.projects.CoordinatorChange
import io.orbitd.android.ui.OrbitTheme
import java.io.File
import java.time.Duration
import java.time.Instant
import kotlinx.serialization.json.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * The owner exception card organised around "Who fixes it?" (board docs/mocks/owner-exception-who-fixes ⑤, Android proposal) as the
 * conversation draws it: board ②'s escalated merge conflict in Checkout v2 — 9 files, waiting 3h 1m, 2h 56m of it with the
 * coordinator — (a) with its coordinator's workspace mac-mini disabled, and (b) with the coordinator reachable. Each frame is written as
 * `<scene>.png` under `src/android/build/evidence/exception-unreachable-android/`, and as `android-a.png` / `android-b.png` into the
 * directory `ORBIT_SHOTS_UPLOADS` names when it is set.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = TestOrbitApplication::class, qualifiers = "w411dp-h1180dp-xhdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class ExceptionCardUnreachableShotTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()
    private val key = "item:35aItem0000000000000001"

    private val output: File by lazy {
        val root = generateSequence(File(System.getProperty("user.dir"))) { it.parentFile }
            .first { File(it, "src/android/settings.gradle.kts").isFile }
        File(root, "src/android/build/evidence/exception-unreachable-android").also { it.mkdirs() }
    }

    private val now = Instant.now()
    private fun ago(minutes: Long) = now.minus(Duration.ofMinutes(minutes)).toString()

    private fun row(unreachable: Boolean) = buildJsonObject {
        put("itemId", "35aItem0000000000000001"); put("kind", "INTEGRATION_CONFLICT")
        put("title", "Merge conflict: Retry failed webhook deliveries"); put("detailLine", "9 files conflict with project/35aK2xQm")
        put("assignee", "OWNER"); put("assigneeReason", "ESCALATED")
        put("waitingSince", ago(181)); put("escalatedAt", ago(5))
        put("taskId", "35aTask00000000000001"); put("sessionId", "35aSession000000000001"); put("promotionId", JsonNull); put("fuseEpisodeId", JsonNull)
        put("landingSessionId", "35aLanding00000000001"); put("integrationJobId", JsonNull)
        putJsonObject("delivery") { put("state", "DELIVERED"); put("sessionId", "35aCoord0000000000001"); put("at", ago(180)) }
        putJsonArray("actions") {
            (if (unreachable) listOf("OPEN_TASK_SESSION", "OPEN_LANDING", "CANCEL_TASK")
            else listOf("ASK_COORDINATOR_AGAIN", "OPEN_TASK_SESSION", "OPEN_LANDING", "CANCEL_TASK")).forEach { add(it) }
        }
        put("requiredAction", "This task cannot reach the project branch until its merge conflict is repaired — fix the task branch.")
        put("question", JsonNull); put("lease", JsonNull)
        putJsonObject("facts") {
            putJsonObject("task") { put("id", "35aTask00000000000001"); put("title", "Retry failed webhook deliveries") }
            put("targetRef", "refs/heads/project/35aK2xQm8LrT0vHcE1pZq"); put("targetSha", "9f3c2e1aa0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5")
            putJsonArray("files") {
                listOf("src/webhooks/sender.ts", "src/webhooks/sender.test.ts", "src/webhooks/retry-policy.ts", "src/queue/backoff.ts",
                    "src/queue/backoff.test.ts", "src/config/defaults.ts", "docs/webhooks.md", "package.json", "package-lock.json").forEach { add(it) }
            }
            put("nothingLanded", false); put("check", JsonNull); put("branchUnchanged", false); put("errorCode", JsonNull); put("failure", JsonNull)
        }
        putJsonObject("chat") {
            put("sessionId", "35aCoord0000000000001"); put("stage", "WITH_OWNER"); put("refusal", if (unreachable) "COORDINATOR_UNAVAILABLE" else null)
        }
        put("coordinatorUnreachable", unreachable)
    }

    /** The coordinator as board (a) has it: a LIVE conversation whose workspace, mac-mini, the workspace list says is disabled. */
    private val disabledMacMini = object : CoordinatorDoors {
        override suspend fun status(projectId: String) = buildJsonObject {
            put("projectId", projectId); put("state", "LIVE")
            putJsonObject("coordination") {
                put("sessionId", "35aCoord0000000000001")
                putJsonObject("session") { put("id", "35aCoord0000000000001"); put("lifecycleState", "OPEN") }
                put("workspaceId", "35aWorkspace0000000001"); put("workspaceName", "mac-mini")
            }
            putJsonObject("openability") { put("canOpen", true); put("refusalDetail", JsonNull) }
        }
        override suspend fun workspaces() = listOf(buildJsonObject {
            put("id", "35aWorkspace0000000001"); put("name", "mac-mini"); put("enabled", false); put("runnerId", "r1")
        })
        override suspend fun replace(projectId: String, revision: String, workspaceId: String?) = Unit
        @Composable override fun ChangeSheet(currentWorkspaceId: String?, close: () -> Unit, pick: (CoordinatorChange.Row) -> Unit) = Unit
    }

    private fun show(unreachable: Boolean) {
        val project = buildJsonObject { put("id", "p1"); put("title", "Checkout v2"); put("exceptionEscalationSeconds", 7200) }
        val card = CardCatalog.project("s1", "p1", mapOf("project" to project,
            "openItems" to buildJsonObject { putJsonArray("needsYou") { add(row(unreachable)) }; putJsonArray("withCoordinator") {} })).single()
        compose.runOnUiThread { compose.activity.setContent { OrbitTheme(darkTheme = false) {
            Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
                Column(Modifier.verticalScroll(rememberScrollState()).padding(12.dp)) {
                    ExceptionCard(card, fresh = true, result = CardActionState(), mergeCard = null, open = {}, discuss = {},
                        review = {}, main = "main", projectName = project["title"]?.jsonPrimitive?.content,
                        escalationSeconds = project["exceptionEscalationSeconds"]?.jsonPrimitive?.longOrNull, coordinator = disabledMacMini) { _, _ -> }
                }
            }
        } } }
        compose.waitForIdle()
    }

    private fun shot(name: String, upload: String) {
        compose.waitForIdle()
        val decor = compose.activity.window.decorView
        val bitmap = Bitmap.createBitmap(decor.width, decor.height, Bitmap.Config.ARGB_8888)
        decor.draw(Canvas(bitmap))
        File(output, "$name.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
        System.getenv("ORBIT_SHOTS_UPLOADS")?.takeIf { it.isNotBlank() }?.let { dir ->
            File(dir).mkdirs()
            File(dir, upload).outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
        }
        bitmap.recycle()
    }

    private fun assertText(tag: String, text: String) = compose.onNodeWithTag(tag, useUnmergedTree = true).assertTextEquals(text)

    @Test fun unreachableCoordinator() {
        show(unreachable = true)
        compose.waitUntil(5_000) { compose.onAllNodes(hasText("Enable mac-mini")).fetchSemanticsNodes().isNotEmpty() }
        assertText("$key:heading", ExceptionCards.escalatedUnreachableHeading)
        assertText("$key:clock", "waiting 3h 1m")
        assertText("$key:subline", "Merge conflict · Retry failed webhook deliveries → Checkout v2")
        assertText("$key:who:status", "Its workspace mac-mini is disabled, so it can’t take messages.")
        assertText("$key:who:note", ExceptionCards.askAgainOnceBack)
        compose.onNodeWithTag("$key:who:FIX").assertExists()
        compose.onNodeWithTag("$key:who:CHANGE_WORKSPACE").assertExists()
        // D1: no Ask again until it is back. D2: no chat at all.
        compose.onNodeWithTag("$key:RETURN_COORDINATOR").assertDoesNotExist()
        compose.onNodeWithTag("$key:who:CHAT_FIRST").assertDoesNotExist()
        compose.onNode(hasText("Chat about this")).assertDoesNotExist()
        // D3: no footer; no requiredAction paragraph.
        compose.onNodeWithTag("$key:owner").assertDoesNotExist()
        compose.onNodeWithTag("$key:required").assertDoesNotExist()
        assertText("$key:closes", "✓ ${ExceptionCards.closesByItself}")
        assertText("$key:details", "› Details · 9 files · Open landing")
        shot("unreachable", "android-a.png")
    }

    @Test fun reachableCoordinator() {
        show(unreachable = false)
        assertText("$key:heading", "Now yours — the coordinator didn’t get to it")
        assertText("$key:clock", "waiting 3h 1m")
        assertText("$key:who:status", "Reachable. It had this for 2h 56m and didn’t get to it.")
        compose.onNodeWithTag("$key:RETURN_COORDINATOR").assertExists()
        compose.onNodeWithTag("$key:who:CHAT_FIRST").assertExists()
        compose.onNode(hasText("Chat about this")).assertDoesNotExist()
        assertText("$key:who:note", "It goes back to the coordinator with a fresh 2h clock.")
        compose.onNodeWithTag("$key:MARK_HANDLED").assertExists()
        compose.onNodeWithTag("$key:CANCEL_TASK").assertExists()
        shot("reachable", "android-b.png")
    }
}
