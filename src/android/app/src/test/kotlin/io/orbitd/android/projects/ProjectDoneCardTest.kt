package io.orbitd.android.projects

import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Column
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

    private fun card(doc: JsonObject, request: JsonObject?, record: JsonObject? = null, sealRead: Boolean = true) {
        compose.runOnUiThread { compose.activity.setContent { OrbitTheme(darkTheme = false) {
            Column(Modifier.verticalScroll(rememberScrollState())) {
                ProjectDoneCard(doc, request, "2026-09-29T10:00:00.000Z", ProjectDone.openItemsCount(buildJsonObject {
                    put("needsYou", JsonArray(emptyList())); put("withCoordinator", JsonArray(emptyList())); request?.let { put("doneRequest", it) } }), 0,
                    record, sealRead, now, enabled = true, error = null, tag = "done",
                    onRecord = { recorded++ }, onNotYet = if (request == null) null else { note -> notes += note; true }, onReopen = { reopened++ })
            }
        } } }
        compose.waitForIdle()
    }
    private fun shows(text: String) = compose.onNodeWithText(text, substring = false).performScrollTo().assertIsDisplayed()
    private fun texts(): List<String> = compose.onAllNodes(hasText("", substring = true), useUnmergedTree = true).fetchSemanticsNodes()
        .flatMap { node -> if (SemanticsProperties.Text in node.config) node.config[SemanticsProperties.Text].map { it.text } else emptyList() }

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
        // Done when's criteria, one press away.
        compose.onNodeWithTag("done-criteria").assertTextEquals(ProjectDone.showAll(2)).performClick()
        shows("met · Landed on main"); shows("met · nothing to land")
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

    @Test fun aCardNobodyAskedForSaysSoCarriesOrbitsGapsAndOffersNoNotYet() {
        val unmet = j(doc.toString().replace(""""satisfied":true,"landingReason":"NOTHING_TO_LAND"""", """"satisfied":false,"landingReason":"NOTHING_TO_LAND"""")
            .replace(""""met":2""", """"met":1"""))
        card(unmet, null)
        compose.onNodeWithTag("done-meta").assertTextEquals("Project closeout · record as done anyway")
        shows("Orbit cannot prove this criterion is met by its work yet.")
        compose.onNodeWithTag("done-record").performScrollTo().assertTextEquals(ProjectDone.recordAsDoneAnyway)
        compose.onAllNodesWithTag("done-not-yet").assertCountEquals(0)
        card(unmet, null, sealRead = false)
        compose.onNodeWithTag("done-record").performScrollTo().assertIsNotEnabled()
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
