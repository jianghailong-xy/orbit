package io.orbitd.android.cards

import android.graphics.Bitmap
import android.os.SystemClock
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.unit.dp
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import io.orbitd.android.MainActivity
import io.orbitd.android.core.cards.*
import io.orbitd.android.core.realtime.RunEvent
import io.orbitd.android.ui.OrbitTheme
import java.io.File
import java.time.Instant
import kotlinx.serialization.json.*
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * The three cards a coordinator conversation draws after a project starts (board-4, Coordinator handoff v2), on a device: the criteria
 * decision's receipt in orange, the start's receipt, and Project started with its task set to start by hand — the cases of
 * criteria-decision-receipt.fixture.json and coordinator-start-cards.fixture.json the unit tests read, drawn by the production
 * composables. Frames land in files/coordinator-start-cards/<theme> for scripts/coordinator-start-cards-device-test.sh to pull.
 */
@RunWith(AndroidJUnit4::class)
class CoordinatorStartCardsDeviceTest {
    @get:Rule val compose = createEmptyComposeRule()
    private val instrumentation get() = InstrumentationRegistry.getInstrumentation()
    private val theme = InstrumentationRegistry.getArguments().getString("start_cards_theme") ?: "light"
    private val evidence get() = File(instrumentation.targetContext.filesDir, "coordinator-start-cards/$theme").also { it.mkdirs() }

    private val settled = Json.parseToJsonElement("""{"intentId":"4TdXP1ChQx7vLmN3pR5sT8","decision":"APPROVE","decidedAt":"2026-11-19T15:45:00.000Z",
        "baseSeal":"7219d1bad212","resultingSeal":"9c4f7a1bb001",
        "proposal":{"changed":[{"change":"REWORDED","definitionId":"def-2","ordinal":2,"text":"Every migration is replayed when someone asks"},
          {"change":"ADDED","definitionId":null,"ordinal":4,"text":"The receipt folds out what it approved"}],"rewordedCount":1,"addedCount":1,"droppedCount":0,"unchangedCount":2},
        "diff":{"state":"SNAPSHOT","diff":{"entries":[
          {"change":"SAME","definitionId":"def-1","ordinal":1,"proposed":{"text":"The web suite passes"},"onRecord":{"text":"The web suite passes"},"changed":[],"rewrites":[]},
          {"change":"CHANGED","definitionId":"def-2","ordinal":2,"proposed":{"text":"Every migration is replayed when someone asks"},
           "onRecord":{"text":"Every migration is replayed on a loaded database"},"changed":["text"],
           "rewrites":[{"field":"text","segments":[{"side":"KEPT","text":"Every migration is replayed "},{"side":"REMOVED","text":"on a loaded database"},{"side":"ADDED","text":"when someone asks"}]}]},
          {"change":"SAME","definitionId":"def-3","ordinal":3,"proposed":{"text":"The macOS build passes"},"onRecord":{"text":"The macOS build passes"},"changed":[],"rewrites":[]},
          {"change":"NEW","definitionId":null,"ordinal":4,"proposed":{"text":"The receipt folds out what it approved"},"onRecord":null,"changed":[],"rewrites":[]}],
          "sameCount":2,"changedCount":1,"newCount":1,"removedCount":0}}}""").jsonObject

    private val criteria = listOf("The iOS criteria receipt is orange", "A met criterion's landing reads landingReason",
        "Receipt times show the date when not today", "No count calls an unmet criterion landed", "Android draws the three cards")
    private val confirmation = buildJsonObject {
        put("criteriaDigest", "7219d1bad2120000000000000000000000000000000000000000000000000000")
        putJsonArray("criteriaMaterial") { criteria.forEachIndexed { i, t -> addJsonObject { put("key", "c$i"); put("text", t) } } }
        put("confirmedAt", "2026-11-16T15:45:31.000Z"); put("confirmedById", "owner-1")
        putJsonObject("startedWith") {
            putJsonObject("settings") {
                put("line", "PROJECT_BRANCH"); put("projectBranchName", "refs/heads/project/34ycaQ1bT0kE7vLmN3pR5"); put("automatic", true)
                put("maxConcurrentTasks", 3); put("mergeCheckCommand", "npm run build")
            }
            putJsonArray("differsFromRequest") {}
        }
        putJsonArray("criteria") { criteria.forEachIndexed { i, t -> addJsonObject { put("key", "c$i"); put("ordinal", i + 1); put("text", t); put("since", "UNCHANGED") } } }
        put("wordingRecorded", true)
    }
    private val started = RunEvent("user", 41, buildJsonObject {
        put("text", "From Orbit · project started\n\nThe account owner confirmed the 5 acceptance criteria of project “Coordinator handoff v2” " +
            "(34ycaQ1bT0kE7vLmN3pR5) and started it.\n\n1 of its open tasks is set to be started by hand (autoRunWhenReady=false), so nothing " +
            "starts it unless you do:\n- Walkthrough: a real coordinator handoff with pending work, on a deployed build (34ycbR2cU1lF8wMnO4qS6)")
        putJsonObject("projectStarted") {
            put("by", "CONFIRMATION"); put("projectId", "34ycaQ1bT0kE7vLmN3pR5"); put("projectTitle", "Coordinator handoff v2"); put("criteriaCount", 5)
            putJsonArray("held") { addJsonObject { put("id", "34ycbR2cU1lF8wMnO4qS6"); put("title", "Walkthrough: a real coordinator handoff with pending work, on a deployed build") } }
            put("heldCount", 1)
            putJsonObject("settings") {
                put("line", "PROJECT_BRANCH"); put("projectBranchName", "refs/heads/project/34ycaQ1bT0kE7vLmN3pR5"); put("automatic", true)
                put("maxConcurrentTasks", 3); put("mergeCheckCommand", "npm run build")
            }
            putJsonArray("differsFromRequest") {}
        }
    }, ts = Instant.now().minusSeconds(3_600).toString())

    @Test fun theThreeCardsAfterAProjectStarts() {
        instrumentation.sendStatus(0, android.os.Bundle().apply { putString("start_cards_pid", android.os.Process.myPid().toString()) })
        val receipt = InteractionCard("receipt:CRITERIA_CHANGE:4TdXP1ChQx7vLmN3pR5sT8:", CardFamily.CRITERIA_CHANGE, CriteriaReceipt.heading, settled,
            "s", objectId = "4TdXP1ChQx7vLmN3pR5sT8", binding = "", status = "Recorded")
        val start = InteractionCard("receipt:ACCEPTANCE:p:2026-11-16T15:45:31.000Z", CardFamily.ACCEPTANCE, StartReceipt.heading, confirmation,
            "s", objectId = "p", binding = "", status = "Recorded")
        val projectStarted = transcriptCards(started).single { it.key.endsWith(":projectStarted") }
        val scenario = ActivityScenario.launch(MainActivity::class.java)
        scenario.onActivity { activity -> activity.setContent { OrbitTheme(darkTheme = theme == "dark") {
            Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
                Column(Modifier.fillMaxSize().safeDrawingPadding().verticalScroll(rememberScrollState()).padding(16.dp).testTag("start-cards"),
                    verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    Text("Coordinator handoff v2", style = MaterialTheme.typography.titleMedium)
                    CriteriaReceiptCard(receipt)
                    StartReceiptCard(start)
                    TranscriptCardView(projectStarted, {}, started)
                }
            }
        } } }
        settle()
        for (words in listOf("✓ Approved by you at ", "You started the project on 5 criteria", "by you at 11/16 ", "Project started",
                "1 task is set to start by hand, so it waits for the coordinator:", "What the coordinator was told")) {
            assertTrue(words, compose.onAllNodes(hasText(words, substring = true), useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty())
        }
        capture("01-three-cards")
        click("${receipt.key}:fold"); click("${receipt.key}:unchanged")
        compose.onNodeWithTag("${start.key}:line", useUnmergedTree = true).performScrollTo()
        capture("02-criteria-receipt-what-this-approved")
        click("${start.key}:receipt-toggle")
        compose.onNodeWithTag("${start.key}:receipt-fold", useUnmergedTree = true).performScrollTo()
        capture("03-start-receipt-what-this-confirmed")
        click("turn-project-started:told")
        compose.onNodeWithTag("turn-project-started:words", useUnmergedTree = true).performScrollTo()
        capture("04-project-started-what-the-coordinator-was-told")
        scenario.close()
    }

    private fun click(tag: String) {
        compose.onNodeWithTag(tag, useUnmergedTree = true).performScrollTo().performSemanticsAction(SemanticsActions.OnClick)
        settle()
    }
    private fun settle() {
        compose.waitForIdle()
        instrumentation.waitForIdleSync()
    }
    private fun capture(name: String) {
        settle()
        SystemClock.sleep(500)
        var bitmap: Bitmap? = null
        repeat(3) { if (bitmap == null) bitmap = instrumentation.uiAutomation.takeScreenshot() ?: run { SystemClock.sleep(500); null } }
        val shot = bitmap ?: run { File(evidence, "$name.missing").writeText("takeScreenshot returned null 3 times\n"); return }
        File(evidence, "$name.png").outputStream().use { shot.compress(Bitmap.CompressFormat.PNG, 100, it) }
        shot.recycle()
    }
}
