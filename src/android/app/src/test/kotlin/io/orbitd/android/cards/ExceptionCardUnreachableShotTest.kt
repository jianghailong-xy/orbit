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
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.assertTextEquals
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.unit.dp
import io.orbitd.android.MainActivity
import io.orbitd.android.TestOrbitApplication
import io.orbitd.android.core.cards.CardActionState
import io.orbitd.android.core.cards.CardCatalog
import io.orbitd.android.core.cards.ExceptionCards
import io.orbitd.android.ui.OrbitTheme
import java.io.File
import kotlinx.serialization.json.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * The 2026-11-15 card as the conversation draws it: an escalated landing conflict whose coordinator could not be reached. Its heading
 * names that, and its sentence offers only what the owner can do; with the coordinator reachable the card is what it was. Each frame
 * is written as `<scene>.png` under `src/android/build/evidence/exception-unreachable-android/`.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = TestOrbitApplication::class, qualifiers = "w411dp-h891dp-xhdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class ExceptionCardUnreachableShotTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()
    private val key = "item:01a1de3b-4e36-7479-9f5b-c34f709d7551"

    private val output: File by lazy {
        val root = generateSequence(File(System.getProperty("user.dir"))) { it.parentFile }
            .first { File(it, "src/android/settings.gradle.kts").isFile }
        File(root, "src/android/build/evidence/exception-unreachable-android").also { it.mkdirs() }
    }

    private fun row(unreachable: Boolean) = buildJsonObject {
        put("itemId", "01a1de3b-4e36-7479-9f5b-c34f709d7551"); put("kind", "INTEGRATION_CONFLICT")
        put("title", "Merge conflict: Managed runner entry on Android: Machines & models section, confirmation, machine row")
        put("detailLine", "the merge stopped on a conflict"); put("assignee", "OWNER"); put("assigneeReason", "ESCALATED")
        put("waitingSince", "2026-11-15T08:03:11.030Z"); put("escalatedAt", "2026-11-15T10:59:29.158Z")
        put("taskId", "t1"); put("sessionId", "s9"); put("promotionId", JsonNull); put("fuseEpisodeId", JsonNull)
        put("landingSessionId", "L1"); put("integrationJobId", JsonNull)
        putJsonObject("delivery") { put("state", "NOT_REQUIRED"); put("sessionId", JsonNull); put("at", JsonNull) }
        putJsonArray("actions") {
            (if (unreachable) listOf("OPEN_TASK_SESSION", "CANCEL_TASK", "OPEN_LANDING")
            else listOf("ASK_COORDINATOR_AGAIN", "OPEN_TASK_SESSION", "CANCEL_TASK", "OPEN_LANDING")).forEach { add(it) }
        }
        put("requiredAction", if (unreachable)
            "This task cannot reach the project branch until its merge conflict is repaired — fix the task branch."
        else "This task cannot reach the project branch until its merge conflict is repaired — fix the task branch or ask the coordinator to do it.")
        put("question", JsonNull); put("facts", JsonNull); put("lease", JsonNull)
        put("coordinatorUnreachable", unreachable)
    }

    private fun show(unreachable: Boolean) {
        val card = CardCatalog.project("s1", "p1", mapOf("project" to buildJsonObject { put("id", "p1") },
            "openItems" to buildJsonObject { putJsonArray("needsYou") { add(row(unreachable)) }; putJsonArray("withCoordinator") {} })).single()
        compose.runOnUiThread { compose.activity.setContent { OrbitTheme(darkTheme = false) {
            Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
                Column(Modifier.verticalScroll(rememberScrollState()).padding(12.dp)) {
                    ExceptionCard(card, fresh = true, result = CardActionState(), mergeCard = null, open = {}, discuss = null,
                        review = {}, main = "main") { _, _ -> }
                }
            }
        } } }
        compose.waitForIdle()
    }

    private fun shot(name: String) {
        compose.waitForIdle()
        val decor = compose.activity.window.decorView
        val bitmap = Bitmap.createBitmap(decor.width, decor.height, Bitmap.Config.ARGB_8888)
        decor.draw(Canvas(bitmap))
        File(output, "$name.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
        bitmap.recycle()
    }

    @Test fun unreachableCoordinator() {
        show(unreachable = true)
        compose.onNodeWithTag("$key:heading", useUnmergedTree = true).assertTextEquals(ExceptionCards.escalatedUnreachableHeading)
        compose.onNodeWithTag("$key:required", useUnmergedTree = true)
            .assertTextEquals("This task cannot reach the project branch until its merge conflict is repaired — fix the task branch.")
        compose.onNodeWithTag("$key:RETURN_COORDINATOR").assertDoesNotExist()
        shot("unreachable")
    }

    @Test fun reachableCoordinator() {
        show(unreachable = false)
        compose.onNodeWithTag("$key:heading", useUnmergedTree = true).assertTextEquals("Now yours — no one acted on this for 2h 56m")
        compose.onNodeWithTag("$key:RETURN_COORDINATOR").assertExists()
        shot("reachable")
    }
}
