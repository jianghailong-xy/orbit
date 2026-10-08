package io.orbitd.android.projects

import io.orbitd.android.cards.CardFocus
import io.orbitd.android.core.cards.*
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/** The owner's done door as OrbitKit `ProjectDoneTests` (main 7c9d0ceec) holds it: the gaps an unasked card
 * carries, the body a press sends, when a request is live, and the page's closing row. */
class ProjectDoneTest {
    private fun j(text: String) = Json.parseToJsonElement(text).jsonObject
    private fun closeout(criteria: String = """[{"definitionId":"c1","satisfied":true},{"definitionId":"c2","satisfied":true,"landingReason":"NOTHING_TO_LAND"}]""",
        counts: String = """{"criteria":2,"met":2,"landed":2,"onMain":1,"byReason":{"NOTHING_TO_LAND":1}}""", status: String = "OPEN") = j("""
        {"id":"p","title":"Project closeout","status":"$status",
         "acceptanceCriteriaItems":[{"id":"c1","ordinal":1,"text":"The release is on main"},{"id":"c2","ordinal":2,"text":"The live check was completed"}],
         "derivedDone":{"done":false,"criteria":$criteria,"counts":$counts}}""")
    private val request = j("""{"criteriaDigest":"${"a".repeat(64)}","judgment":"The goal is met. I checked the release evidence below.",
        "gaps":[{"criterionKey":"c2","title":"The live check was completed","whyNotProven":"The task made no commits.",
                 "coordinatorChecked":"main contains the release files","evidenceRefs":["run-42"]}]}""")

    @Test fun aCardNobodyAskedForCarriesOrbitsOwnGaps() {
        val subject = closeout("""[{"definitionId":"c1","satisfied":true,"landingReason":"NO_RECEIPT"},{"definitionId":"c2","satisfied":true,"landingReason":"NOTHING_TO_LAND"}]""")
        val gaps = ProjectDone.syntheticGaps(subject)
        assertEquals("nothing to land is an outcome, not a gap to paper over", listOf("c1"), gaps.map { it.text("criterionKey") })
        assertEquals("The release is on main", gaps.first().text("title"))
        assertEquals("Orbit cannot prove this criterion is on main: Merged outside Orbit.", gaps.first().text("whyNotProven"))
        val unmet = closeout("""[{"definitionId":"c2","satisfied":false,"landingReason":"CODELESS"}]""")
        assertEquals("an unmet criterion is a gap whatever its landing says", "Orbit cannot prove this criterion is met by its work yet.",
            ProjectDone.syntheticGaps(unmet).first().text("whyNotProven"))
        assertEquals("a request's own gaps are the card's, not Orbit's", request.objects("gaps"), ProjectDone.gaps(subject, request))
    }

    @Test fun thePressSendsTheRequestsSealAndItsGapsAsTheyCame() {
        val subject = closeout()
        val body = ProjectDone.body(subject, "34Y7req", request, "ignored")!!
        assertEquals("34Y7req", body.text("requestId"))
        assertEquals("the request's own seal, so a request whose criteria moved is refused", request.text("criteriaDigest"), body.text("criteriaDigest"))
        assertEquals("c2", body.objects("acceptedGaps").first().text("criterionKey"))
        assertEquals(listOf("run-42"), body.objects("acceptedGaps").first().strings("evidenceRefs"))
        val own = ProjectDone.body(subject, null, null, "b")!!
        assertEquals("the request is sent as null, not left out", JsonNull, own["requestId"])
        assertEquals("b", own.text("criteriaDigest"))
        assertNull("no seal read yet is no press", ProjectDone.body(subject, null, null, null))
    }

    @Test fun orbitCheckedCountsTheRequestAmongTheOpenItemsAndThePressSaysAnyway() {
        val row = j("""{"itemId":"i1","kind":"UNKNOWN","title":"","waitingSince":""}""")
        val items = buildJsonObject { put("needsYou", JsonArray(listOf(row))); put("withCoordinator", JsonArray(listOf(row, row))); put("doneRequest", row) }
        assertEquals(4, ProjectDone.openItemsCount(items)); assertEquals(0, ProjectDone.openItemsCount(null))
        assertEquals(2, ProjectDone.runningCount(closeout(counts = """{"criteria":3,"met":3,"landed":1,"onMain":1,"byReason":{"IN_FLIGHT":2}}""")))
        assertEquals(ProjectDone.recordAsDone, ProjectDone.recordLabel(ProjectDone.counts(closeout())))
        assertEquals(ProjectDone.recordAsDoneAnyway, ProjectDone.recordLabel(j("""{"criteria":2,"met":1}""")))
        assertEquals("recorded by you · 1 gaps accepted", ProjectDone.provenance("OWNER", 1))
        assertEquals("recorded by Orbit", ProjectDone.provenance("DERIVED", 0))
        assertEquals("Orbit checked: 1 of 2 criteria are met by their work · nothing running · no open items",
            ProjectDone.orbitCheckedLine(j("""{"criteria":2,"met":1}"""), null, 0, 0))
    }

    @Test fun theRequestIsLiveOnlyOnAnOpenProjectAndThePageRowFollowsIt() {
        val row = buildJsonObject { put("itemId", "req1"); put("kind", "UNKNOWN"); put("doneRequest", request) }
        val bare = j("""{"itemId":"req2","kind":"UNKNOWN"}""")
        val asked = buildJsonObject { put("doneRequest", row) }
        assertEquals(row, ProjectDone.live(asked, "OPEN"))
        assertNull(ProjectDone.live(asked, "DONE"))
        assertNull(ProjectDone.live(buildJsonObject { put("doneRequest", bare) }, "OPEN"))
        assertNull(ProjectDone.live(null, "OPEN"))
        assertEquals(ProjectDone.PageRow.Asked(row), ProjectDone.pageRow(closeout(), asked))
        assertEquals(ProjectDone.PageRow.Own, ProjectDone.pageRow(closeout(), j("{}")))
        assertNull("a request still on its way is not a project nobody asked about", ProjectDone.pageRow(closeout(), null))
        assertNull(ProjectDone.pageRow(closeout(status = "DONE"), j("{}")))
        assertNull("an older server keeps the status door it had", ProjectDone.pageRow(j("""{"status":"OPEN","derivedDone":{"done":false}}"""), j("{}")))
        assertTrue(ProjectDone.readyToClose("OPEN", asked)); assertFalse(ProjectDone.readyToClose("OPEN", j("{}")))
        assertEquals("The coordinator asked · 1 gaps it couldn’t prove", ProjectDone.requestRowDetail(row))
    }

    @Test fun aCardFocusNamesOneCardAndAPromotionFocusAnyCandidate() {
        assertTrue(CardFocus.matches("item:x1", "item:x1"))
        assertFalse(CardFocus.matches("item:x1", "item:q1"))
        assertTrue(CardFocus.matches("start:start1", "start:start1"))
        assertTrue("a project has at most one live candidate", CardFocus.matches("promotion:", "promotion:p9"))
        assertFalse(CardFocus.matches("item:x1", "promotion:p9"))
    }
}
