package io.orbitd.android.cards

import android.graphics.Bitmap
import android.graphics.Canvas
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Surface
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.unit.dp
import io.orbitd.android.MainActivity
import io.orbitd.android.TestOrbitApplication
import io.orbitd.android.core.cards.*
import io.orbitd.android.ui.OrbitTheme
import java.io.File
import java.time.Instant
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/** The delete card as the conversation draws it (iOS `ToolApprovalCard`'s delete branch, web `DeleteBody`): the real card, its doors
 * pressed. The two pictures of each card go to src/android/build/evidence/native-delete-card. */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [29], application = TestOrbitApplication::class, qualifiers = "w411dp-h891dp")
class DeleteCardViewTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()
    private val hoursAgo = Instant.now().minusSeconds(6 * 3600 + 60).toString()

    private fun runner(workspaces: Boolean = true) = buildJsonObject {
        put("runnerId", "r1"); put("name", "instance-20261027-071926"); put("displayName", JsonNull); put("online", false); put("lastHeartbeatAt", hoursAgo)
        putJsonArray("workspaces") {
            if (workspaces) {
                addJsonObject { put("id", "w1"); put("name", "c2b-loadtest"); put("workDir", JsonNull) }
                addJsonObject { put("id", "w2"); put("name", "site"); put("workDir", "~/site") }
            }
        }
    }
    private val workspace = buildJsonObject {
        put("agentId", "w1"); put("name", "c2b-loadtest"); put("workDir", "/srv/loadtest")
        putJsonObject("runner") { put("id", "r1"); put("name", "workstation-gpu"); put("displayName", "HPC") }
    }
    private fun card(tool: String, input: JsonObject) = InteractionCard("approval:d1", approvalFamily(tool), DeleteCards.title(tool),
        buildJsonObject { put("id", "d1"); put("toolName", tool); put("input", input); put("status", "PENDING") }, "s1", objectId = "d1",
        binding = input.toString(), actions = listOf(CardVerb.DELETE_IT, CardVerb.CHAT), status = "PENDING")

    private fun show(card: InteractionCard, dark: Boolean = false, submit: (CardVerb, CardInput) -> Unit = { _, _ -> }) {
        compose.runOnUiThread { compose.activity.setContent { OrbitTheme(darkTheme = dark) { Surface(Modifier.fillMaxSize()) {
            Column(Modifier.padding(16.dp)) { BusinessCard(card, fresh = true, open = {}, submit = submit) }
        } } } }
        compose.waitForIdle()
    }
    private fun says(words: String) = compose.onNodeWithText(words, useUnmergedTree = true).assertExists()
    private fun never(words: String) = compose.onNodeWithText(words, useUnmergedTree = true).assertDoesNotExist()

    @Test fun whereItStandsIsTheRunnerListsOwnLine() {
        val now = Instant.parse("2026-10-28T11:47:18Z").toEpochMilli()
        val offline = DeleteCard(true, "box", lastHeartbeatAt = "2026-10-28T05:46:18.109Z")
        assertEquals("Offline · last seen 6h ago", deleteStatus(offline, now))
        assertEquals("Online", deleteStatus(offline.copy(online = true), now))
        assertEquals("Offline", deleteStatus(offline.copy(lastHeartbeatAt = null), now))
        assertEquals("On HPC", deleteStatus(DeleteCard(false, "site", host = "HPC"), now))
        assertEquals("On no runner", deleteStatus(DeleteCard(false, "site"), now))
    }

    @Test fun aRunnerCardNamesItAndEveryWorkspaceThatGoesWithIt() {
        val pressed = mutableListOf<CardVerb>()
        show(card(DeleteCards.runnerTool, runner())) { verb, _ -> pressed += verb }
        says("Delete this runner?")
        says("instance-20261027-071926")
        says("Offline · last seen 6h ago")
        says(DeleteCards.goesWith)
        says("− c2b-loadtest")
        says("− site")
        says("~/site")
        says(DeleteCards.runnerNote)
        never(DeleteCards.noWorkspaces)
        never("orbit_runner_delete")
        compose.onNodeWithTag("approval:d1:REMEMBER").assertDoesNotExist()
        compose.onNodeWithTag("approval:d1:DELETE_IT").assertTextEquals("Delete it").performClick()
        compose.waitForIdle()
        assertEquals("the card is the confirmation: no second dialog", listOf(CardVerb.DELETE_IT), pressed)
    }

    @Test fun aRunnerWithNoWorkspacesSaysSo() {
        show(card(DeleteCards.runnerTool, runner(workspaces = false)))
        says(DeleteCards.noWorkspaces)
        never(DeleteCards.goesWith)
    }

    @Test fun aWorkspaceCardNamesItsRunnerAndFolderAndThatItIsNotErased() {
        show(card(DeleteCards.workspaceTool, workspace))
        says("Delete this workspace?")
        says("c2b-loadtest")
        says("On HPC")
        says("/srv/loadtest")
        says(DeleteCards.workspaceNote)
        never(DeleteCards.goesWith)
        never(DeleteCards.noWorkspaces)
    }

    @Test fun sayingNoAsksWhatToDoInsteadAndSendsTheReason() {
        val pressed = mutableListOf<Pair<CardVerb, String>>()
        show(card(DeleteCards.runnerTool, runner())) { verb, input -> pressed += verb to input.text }
        compose.onNodeWithTag("approval:d1:CHAT").assertTextEquals("Chat about this").performClick()
        compose.waitForIdle()
        assertEquals("the first press only opens the reason", emptyList<Pair<CardVerb, String>>(), pressed)
        compose.onNode(hasSetTextAction()).performTextInput("Keep it, the test is not done")
        compose.onNodeWithTag("approval:d1:CHAT").performClick()
        compose.waitForIdle()
        assertEquals(listOf(CardVerb.CHAT to "Keep it, the test is not done"), pressed)
    }

    @Test fun theCardsAsTheyLook() {
        listOf(false, true).forEach { dark ->
            val theme = if (dark) "dark" else "light"
            show(card(DeleteCards.runnerTool, runner()), dark); shot("runner-$theme")
            show(card(DeleteCards.workspaceTool, workspace), dark); shot("workspace-$theme")
        }
    }

    private val output: File by lazy {
        val root = generateSequence(File(System.getProperty("user.dir")).absoluteFile) { it.parentFile }.first { File(it, "src/android/settings.gradle.kts").isFile }
        File(root, "src/android/build/evidence/native-delete-card").also { it.mkdirs() }
    }

    /** The screen as a PNG, never a blank one. */
    private fun shot(name: String) {
        compose.waitForIdle()
        val view = compose.activity.window.decorView
        assertTrue("$name: the view was never laid out", view.width > 0 && view.height > 0)
        val bitmap = Bitmap.createBitmap(view.width, view.height, Bitmap.Config.ARGB_8888)
        view.draw(Canvas(bitmap))
        val pixels = IntArray(bitmap.width * bitmap.height)
        bitmap.getPixels(pixels, 0, bitmap.width, 0, 0, bitmap.width, bitmap.height)
        assertTrue("$name: the shot is blank", pixels.any { it != 0 })
        File(output, "$name.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
        bitmap.recycle()
    }
}
