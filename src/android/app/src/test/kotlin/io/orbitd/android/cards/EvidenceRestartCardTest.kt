package io.orbitd.android.cards

import android.graphics.Bitmap
import android.graphics.Canvas
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.unit.dp
import io.orbitd.android.MainActivity
import io.orbitd.android.TestOrbitApplication
import io.orbitd.android.core.cards.*
import io.orbitd.android.core.realtime.SessionSnapshot
import io.orbitd.android.ui.OrbitTheme
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.io.File

/**
 * The owner's evidence card with Restart the task (docs/evidence-always-has-an-addressee-design.md §3, D2 = A), drawn by the production
 * [BusinessCard]: why the revision cannot be decided, the sentence, and the one press — and no required action of somebody else's. A row
 * without `ownerAction` draws no card. The frame is written to `src/android/build/evidence/evidence-restart-android/`.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = TestOrbitApplication::class, qualifiers = "w411dp-h891dp")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class EvidenceRestartCardTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()
    private val pressed = mutableListOf<Pair<CardVerb, CardInput>>()

    private fun row(ownerAction: String?) = buildJsonObject {
        put("taskId", "t-1"); put("title", "Wire the owner card"); put("projectId", "p-1"); put("ownerCard", JsonNull)
        putJsonObject("criterion") { put("key", "k"); put("text", "The owner card offers Restart the task on every client.") }
        put("evidenceRevision", "3"); put("ageSeconds", 60); put("claim", "The card offers Restart the task.")
        putJsonArray("gaps") { add("No device run.") }; putJsonArray("citations") {}
        putJsonObject("decidability") {
            put("decidable", false); put("refusal", "the criterion was reworded after this revision was submitted")
            put("requiredAction", "RESUBMIT_AGAINST_THE_CURRENT_CRITERION"); put("addressee", "OWNER")
        }
        putJsonObject("independence") { put("independent", true); put("disqualification", JsonNull); put("requiredAction", JsonNull) }
        ownerAction?.let { put("ownerAction", it) }
    }

    private fun cards(ownerAction: String?) = CardCatalog.session("s-owner", SessionSnapshot(
        buildJsonObject { put("id", "s-owner"); put("projectId", "p-1") }, emptyList(), emptyList(), emptyList(),
        mapOf("evidenceDecisions" to buildJsonObject {
            put("decidingSessionId", "s-owner"); put("count", 0); putJsonArray("pending") {}
            putJsonArray("waitingOnYou") { add(row(ownerAction)) }; putJsonArray("sentToCoordinator") {}; putJsonArray("decided") {}
        })))

    private fun show(card: InteractionCard, result: CardActionState = CardActionState()) {
        compose.runOnUiThread { compose.activity.setContent { OrbitTheme(darkTheme = false) {
            Surface(color = MaterialTheme.colorScheme.background) { Column(Modifier.fillMaxWidth().padding(16.dp)) {
                BusinessCard(card, true, result, open = {}, submit = { verb, input -> pressed += verb to input })
            } }
        } } }
        compose.waitForIdle()
    }

    @Test fun theCardOffersRestartTheTaskAndPressingItNamesTheRun() {
        val card = cards("RESTART_TASK").single()
        show(card)
        compose.onNodeWithText(EvidenceRestart.explanation).assertExists()
        compose.onNodeWithText("the criterion was reworded after this revision was submitted", substring = true).assertExists()
        // §3.3: the run's required action is not put in front of the owner.
        compose.onAllNodesWithText("RESUBMIT_AGAINST_THE_CURRENT_CRITERION", substring = true).assertCountEquals(0)
        compose.onAllNodesWithText("Confirm done").assertCountEquals(0)
        shot("01-owner-evidence-card-restart")
        compose.onNodeWithTag("${card.key}:${CardVerb.RESTART_TASK.name}").assertTextEquals("Restart the task").assertIsEnabled().performClick()
        val (verb, input) = pressed.single()
        assertEquals(CardVerb.RESTART_TASK, verb)
        val request = CardRequests.build(card, verb, input)
        assertEquals(listOf("tasks", "t-1", "evidence", "3", "restart"), request.path)
        assertFalse(input.triggerId.isNullOrBlank())
    }

    @Test fun theAnswersAreTheTablesWords() {
        val card = cards("RESTART_TASK").single()
        show(card, CardActionState(message = EvidenceRestart.started, settled = true))
        compose.onNodeWithTag("card-result").assertTextEquals("Restarted: a new run will submit the evidence again.")
        compose.onNodeWithTag("${card.key}:${CardVerb.RESTART_TASK.name}").assertIsNotEnabled()
        shot("02-owner-evidence-card-restarted")
    }

    @Test fun aRowWithoutTheFieldDrawsNoCard() {
        assertTrue(cards(null).isEmpty())
    }

    private fun shot(name: String) {
        compose.waitForIdle()
        val root = generateSequence(File(System.getProperty("user.dir"))) { it.parentFile }
            .first { File(it, "src/android/settings.gradle.kts").isFile }
        val output = File(root, "src/android/build/evidence/evidence-restart-android").also { it.mkdirs() }
        val view = compose.activity.window.decorView
        val bitmap = Bitmap.createBitmap(view.width, view.height, Bitmap.Config.ARGB_8888)
        view.draw(Canvas(bitmap))
        File(output, "$name.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
        bitmap.recycle()
    }
}
