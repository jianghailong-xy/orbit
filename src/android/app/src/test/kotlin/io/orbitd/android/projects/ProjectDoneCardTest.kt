package io.orbitd.android.projects

import android.graphics.Bitmap
import android.graphics.Canvas
import java.io.File
import org.robolectric.annotation.GraphicsMode
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.ui.unit.dp
import io.orbitd.android.ui.LocalOrbitColors
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.Surface
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import io.orbitd.android.MainActivity
import io.orbitd.android.TestOrbitApplication
import io.orbitd.android.ui.OrbitTheme
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.time.Instant

/** "Is this project done?" as iOS main's `ProjectDoneCard` draws it, asserted over the drawn tree: the whole card — who asked and how
 * long it waited, the coordinator's call, Done when and its tally, what Orbit can't prove, what Orbit checked — Record as done and
 * Not yet… with its note, and the receipt the card turns into in place, with what was accepted and Reopen project. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = TestOrbitApplication::class)
class ProjectDoneCardTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()
    private val now = Instant.parse("2026-10-05T21:00:00.000Z")
    private fun j(text: String) = Json.parseToJsonElement(text).jsonObject
    private val doc = j("""{"id":"p","title":"Project closeout","status":"OPEN",
        "acceptanceCriteriaItems":[{"id":"c1","ordinal":1,"text":"The release is on main"},{"id":"c2","ordinal":2,"text":"The live check was completed"}],
        "derivedDone":{"done":false,"criteria":[{"definitionId":"c1","satisfied":true},{"definitionId":"c2","satisfied":true,"landingReason":"NOTHING_TO_LAND"}],
         "counts":{"criteria":2,"met":2,"landed":2,"onMain":1,"byReason":{"NOTHING_TO_LAND":1}}}}""")
    private val row = j("""{"itemId":"req1","kind":"DONE_REQUEST","title":"Is this project done?","waitingSince":"2026-10-05T20:35:00.000Z",
        "doneRequest":{"criteriaDigest":"${"a".repeat(64)}","judgment":"The goal is met. I checked the release evidence below.",
        "gaps":[{"criterionKey":"c2","title":"The live check was completed","whyNotProven":"The task made no commits.",
                 "coordinatorChecked":"main contains the release files","evidenceRefs":["run-42"]}]}}""")
    private val record = j("""{"projectId":"p","status":"DONE","doneBy":"OWNER","doneAt":"2026-10-01T01:40:00.000Z","criteriaDigest":"d",
        "acceptedGaps":[{"criterionKey":"c2","title":"The live check was completed","whyNotProven":"The task made no commits."}]}""")
    private var recorded = 0
    private var notes = mutableListOf<String>()
    private var reopened = 0

    private fun card(doc: JsonObject, request: JsonObject?, record: JsonObject? = null, sealRead: Boolean = true, doneCheck: JsonObject? = null, running: Int = 0) {
        compose.runOnUiThread { compose.activity.setContent { OrbitTheme(darkTheme = false) {
            Surface(Modifier.fillMaxSize()) {
            Column(Modifier.verticalScroll(rememberScrollState()).padding(16.dp)) {
                ProjectDoneCard(doc, request, "2026-09-29T10:00:00.000Z", ProjectDone.openItemsCount(buildJsonObject {
                    put("needsYou", JsonArray(emptyList())); put("withCoordinator", JsonArray(emptyList())); request?.let { put("doneRequest", it) } }), running,
                    record, sealRead, now, enabled = true, error = null, tag = "done", doneCheck = doneCheck,
                    onRecord = { recorded++ }, onNotYet = if (request == null) null else { note -> notes += note; true }, onReopen = { reopened++ })
            }
            }
        } } }
        compose.waitForIdle()
    }
    private fun shows(text: String) = compose.onNodeWithText(text, substring = false).performScrollTo().assertIsDisplayed()
    @Test @org.robolectric.annotation.GraphicsMode(org.robolectric.annotation.GraphicsMode.Mode.NATIVE)
    fun latestDeclineRow() {
        compose.runOnUiThread { compose.activity.setContent { OrbitTheme(darkTheme = false) {
            ProjectDoneDeclineRow(j("""{"note":"Android build still fails on the release key.","declinedAt":"2026-11-10T10:12:00Z"}"""))
        } } }
        compose.onNodeWithTag("project-done-decline").assertExists()
        compose.onNodeWithText("“Android build still fails on the release key.” ${ProjectDone.declineHint}").assertIsDisplayed()
        compose.waitForIdle()
        val view = compose.activity.window.decorView
        assertTrue(view.width > 0 && view.height > 0)
        val bitmap = android.graphics.Bitmap.createBitmap(view.width, view.height, android.graphics.Bitmap.Config.ARGB_8888)
        view.draw(android.graphics.Canvas(bitmap))
        val output = java.io.File(System.getenv("ORBIT_DECLINE_SCREENSHOT") ?: "build/evidence/not-yet-android.png")
        output.parentFile.mkdirs()
        output.outputStream().use { bitmap.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, it) }
    }

    private fun texts(): List<String> = compose.onAllNodes(hasText("", substring = true), useUnmergedTree = true).fetchSemanticsNodes()
        .flatMap { node -> if (SemanticsProperties.Text in node.config) node.config[SemanticsProperties.Text].map { it.text } else emptyList() }

    @Test @Config(qualifiers = "w411dp-h400dp")
    @org.robolectric.annotation.GraphicsMode(org.robolectric.annotation.GraphicsMode.Mode.NATIVE)
    fun derivedDoneNamesTheConfirmationAndReopensWhileOwnerIsUnchanged() {
        val ending = JsonObject(doc + mapOf("status" to JsonPrimitive("DONE"), "doneBy" to JsonPrimitive("DERIVED")))
        compose.runOnUiThread { compose.activity.setContent { OrbitTheme(darkTheme = false) {
            androidx.compose.material3.Surface {
                val success = LocalOrbitColors.current.success
                Column(Modifier.padding(16.dp).fillMaxWidth().background(success.copy(alpha = 0.08f), RoundedCornerShape(14.dp))
                    .border(1.dp, success.copy(alpha = 0.3f), RoundedCornerShape(14.dp)).padding(12.dp)) {
                    ProjectSettledCard(ending, "ending", confirmedAt = "2026-10-02T12:00:00Z", onReopen = { reopened++; null })
                }
            }
        } } }
        compose.waitForIdle()
        compose.onNodeWithText("From the criteria you confirmed on Oct 2. Not right? Reopen it.").assertIsDisplayed()
        compose.onNodeWithTag("ending-reopen").assertTextEquals("Reopen project")
        System.getenv("ORBIT_DERIVED_SCREENSHOT")?.let { path ->
            val view = compose.activity.window.decorView
            val bitmap = android.graphics.Bitmap.createBitmap(view.width, view.height, android.graphics.Bitmap.Config.ARGB_8888)
            view.draw(android.graphics.Canvas(bitmap))
            java.io.File(path).outputStream().use { bitmap.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, it) }
            bitmap.recycle()
        }
        compose.onNodeWithTag("ending-reopen").performClick()
        compose.waitForIdle()
        assertEquals(1, reopened)
        compose.runOnUiThread { compose.activity.setContent { OrbitTheme {
            ProjectSettledCard(JsonObject(ending + ("doneBy" to JsonPrimitive("OWNER"))), "owner", confirmedAt = "2026-10-02T12:00:00Z", onReopen = { reopened++; null })
        } } }
        compose.waitForIdle()
        compose.onNodeWithTag("owner-reopen").assertDoesNotExist()
        compose.onNodeWithText("From the criteria", substring = true).assertDoesNotExist()
    }

    @Test @Config(qualifiers = "w411dp-h400dp")
    @GraphicsMode(GraphicsMode.Mode.NATIVE)
    fun staleRequestRowUsesTheServerReason() {
        val items = j("""{"latestDoneRequestSuperseded":{"reason":"Criterion 3’s task was reopened after it asked.","supersededAt":"2026-11-10T12:00:00Z"}}""")
        compose.runOnUiThread { compose.activity.setContent { OrbitTheme(darkTheme = false) {
            Surface(Modifier.fillMaxSize()) {
                Column(Modifier.padding(16.dp)) { ProjectStaleDoneRow(ProjectDone.staleRequest(items)!!) }
            }
        } } }
        compose.waitForIdle()
        compose.onNodeWithText(ProjectDone.staleHeading).assertIsDisplayed()
        compose.onNodeWithText("Criterion 3’s task was reopened after it asked. ${ProjectDone.staleDetail}").assertIsDisplayed()
        System.getenv("ORBIT_STALE_SCREENSHOT")?.let { path ->
            val view = compose.activity.window.decorView
            val bitmap = Bitmap.createBitmap(view.width, view.height, Bitmap.Config.ARGB_8888)
            view.draw(Canvas(bitmap))
            File(path).outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
            bitmap.recycle()
        }
    }

    @Test fun theCoordinatorsRequestIsDrawnWholeWithHowLongItHasWaited() {
        card(doc, row)
        shows(ProjectDone.heading)
        compose.onNodeWithTag("done-meta").assertTextEquals("Project closeout · asked by the coordinator · waiting 25m")
        compose.onNodeWithTag("done-judgment").assertTextEquals("The goal is met. I checked the release evidence below.")
        shows("DONE WHEN · 2 CRITERIA"); compose.onNodeWithTag("done-tally").assertTextEquals("2 met · 1 landed on main · 1 nothing to land")
        shows("WHAT ORBIT CAN’T PROVE · 1"); shows("The task made no commits.")
        compose.onNodeWithText("✓ Coordinator checked: main contains the release files · evidence run-42").assertExists()
        // The request the card answers is not one of the open items Orbit checked.
        compose.onNodeWithTag("done-orbit-checked").assertTextEquals(
            "Orbit checked: every criterion is met by its work · nothing running · no open items · criteria confirmed by you on Sep 29")
        compose.onNodeWithTag("done-record").performScrollTo().assertTextEquals(ProjectDone.recordAsDone).assertIsEnabled()
        compose.onNodeWithTag("done-not-yet").assertTextEquals(ProjectDone.notYet)
        assertFalse("no conversation asks why it is not done any more", texts().any { it.contains("Why is this project not done?") })
        // Done when's criteria, open at once up to a dozen (web `DONE_WHEN_OPEN_UP_TO`), each row's state on its own.
        compose.onAllNodesWithTag("done-criteria").assertCountEquals(0)
        compose.onNodeWithTag("done-row:1-state", useUnmergedTree = true).assertTextEquals("met · Landed on main")
        compose.onNodeWithTag("done-row:2-state", useUnmergedTree = true).assertTextEquals("met · nothing to land")
        compose.onNodeWithTag("done-record").performScrollTo().performClick()
        compose.waitForIdle(); assertEquals(1, recorded)
    }

    @Test fun notYetAsksWhatIsMissingAndSendsTheNoteTrimmed() {
        card(doc, row)
        compose.onNodeWithTag("done-not-yet").performScrollTo().performClick()
        shows(ProjectDone.notYetHint)
        compose.onNodeWithTag("done-send").performScrollTo().assertTextEquals(ProjectDone.sendToCoordinator).assertIsNotEnabled()
        compose.onNodeWithTag("done-note").performTextInput("  the deploy is not verified ")
        compose.onNodeWithTag("done-send").performScrollTo().assertIsEnabled().performClick()
        compose.waitForIdle()
        assertEquals(listOf("the deploy is not verified"), notes)
        // Sent: the card is the question again, with nothing typed.
        compose.onNodeWithTag("done-record").assertExists(); compose.onAllNodesWithTag("done-note").assertCountEquals(0)
        compose.onNodeWithTag("done-not-yet").performScrollTo().performClick()
        compose.onNodeWithTag("done-back").performScrollTo().performClick()
        compose.onAllNodesWithTag("done-note").assertCountEquals(0)
    }

    @Test fun aCardNobodyAskedForListsTheDoneCheckAndOffersNoNotYet() {
        val unmet = j(doc.toString().replace(""""satisfied":true,"landingReason":"NOTHING_TO_LAND"""", """"satisfied":false,"landingReason":"NOTHING_TO_LAND"""")
            .replace(""""met":2""", """"met":1"""))
        card(unmet, null, doneCheck = j("""{"findings":[{"severity":"REFUSE","code":"DONE_CRITERION_UNSATISFIED","message":"m",
            "criterion":{"key":"c2","ordinal":2,"text":"The live check was completed"},"tasks":[]},
            {"severity":"WARN","code":"DONE_CRITERION_UNLANDED","message":"m","criterion":{"key":"c1","ordinal":1,"text":"The release is on main"},"tasks":[]}]}"""))
        compose.onNodeWithTag("done-meta").assertTextEquals("Project closeout · record as done anyway")
        // What stands in the way first, and apart from it what Orbit can't prove about where work landed (decided board ③ B–D).
        shows("1 thing stands in the way")
        shows("Criterion 2 is not met — no task serves it")
        shows("Orbit can’t prove 1 thing")
        shows("Criterion 1 is not on main")
        shows("If you record it done anyway, Orbit keeps criterion 2 as the gap you accepted.")
        compose.onNodeWithTag("done-record").performScrollTo().assertTextEquals(ProjectDone.recordAsDoneAnyway)
        compose.onAllNodesWithTag("done-not-yet").assertCountEquals(0)
        card(unmet, null, sealRead = false)
        compose.onNodeWithTag("done-record").performScrollTo().assertIsNotEnabled()
    }

    @Test @Config(qualifiers = "w411dp-h891dp") @GraphicsMode(GraphicsMode.Mode.NATIVE)
    fun doneCheckProposalScreenshot() {
        val check = j("""{"findings":[
            {"severity":"REFUSE","code":"DONE_TASKS_IN_FLIGHT","message":"long server diagnostic","tasks":[{},{}]},
            {"severity":"REFUSE","code":"DONE_CRITERION_UNSATISFIED","message":"long server diagnostic","criterion":{"ordinal":5},"tasks":[{"taskId":"t5","title":"Ship it"}]},
            {"severity":"WARN","code":"DONE_CRITERION_UNLANDED","message":"long server diagnostic","criterion":{"ordinal":6}}]}""")
        val proposal = j("""{"title":"Session Recap","status":"OPEN","derivedDone":{"criteria":[],
            "counts":{"criteria":6,"met":4,"landed":3,"onMain":3,"byReason":{"IN_FLIGHT":2}}}}""")
        card(proposal, null, doneCheck = check, running = 2)
        shows("2 things stand in the way")
        shows("2 tasks are still running")
        shows("Criterion 5 is not met — 1 task is still open")
        shows("Orbit can’t prove 1 thing")
        shows("Criterion 6 is not on main")
        val view = compose.activity.window.decorView
        val bitmap = Bitmap.createBitmap(view.width, view.height, Bitmap.Config.ARGB_8888)
        view.draw(Canvas(bitmap))
        val root = generateSequence(File(System.getProperty("user.dir"))) { it.parentFile }
            .first { File(it, "src/android").isDirectory }
        val file = File(root, "src/android/build/evidence/done-check/android.png")
        file.parentFile.mkdirs()
        file.outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
        assertTrue(file.length() > 0)
        bitmap.recycle()
    }

    @Test fun noFindingsHasNoRedBox() {
        card(doc, null, doneCheck = j("""{"findings":[]}"""))
        compose.onAllNodesWithTag("done-findings").assertCountEquals(0)
        compose.onAllNodesWithText(ProjectDone.findingsAccepted).assertCountEquals(0)
    }

    @Test fun theRecordTurnsTheCardIntoItsReceiptInPlace() {
        card(doc, row, record)
        shows(ProjectDone.thisProjectIsDone); shows(ProjectDone.provenanceBadge)
        compose.onNodeWithTag("done-receipt-line").assertTextContains("You recorded this project done · Oct 1, ", substring = true)
        compose.onNodeWithTag("done-receipt-meta").assertTextContains("Project closeout · recorded by you · 1 gaps accepted · ", substring = true)
        compose.onNodeWithTag("done-receipt-tally").assertTextEquals("2 criteria met · 1 landed on main · 1 nothing to land · 1 gaps accepted")
        compose.onAllNodesWithTag("done-record").assertCountEquals(0)
        compose.onNodeWithTag("done-accepted").assertTextEquals(ProjectDone.seeWhatAccepted).performClick()
        shows("The task made no commits."); compose.onNodeWithTag("done-accepted").assertTextEquals(ProjectDone.showLess)
        compose.onNodeWithTag("done-reopen").performScrollTo().assertTextEquals(ProjectDone.reopenProject).performClick()
        compose.waitForIdle(); assertEquals(1, reopened)
    }
}
