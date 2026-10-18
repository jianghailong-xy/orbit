package io.orbitd.android.projects

import io.orbitd.android.cards.CardFocus
import io.orbitd.android.core.cards.*
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
import java.time.Instant
import java.time.ZoneOffset

/** The owner's done door as OrbitKit `ProjectDoneTests` on main holds it (7c9d0ceec and the fixes after it): the gaps an unasked card
 * carries, the body a press sends, what Orbit checked counts, the receipt, when a request is live and how long it waited, the
 * page's closing row, and which card a coordinator conversation draws. */
class ProjectDoneTest {
    private val utc = ZoneOffset.UTC
    private fun j(text: String) = Json.parseToJsonElement(text).jsonObject
    /** The browser's fixture: two criteria, both met, one on main and one with nothing to land. */
    private fun closeout(criteria: String = """[{"definitionId":"c1","satisfied":true},{"definitionId":"c2","satisfied":true,"landingReason":"NOTHING_TO_LAND"}]""",
        counts: String = """{"criteria":2,"met":2,"landed":2,"onMain":1,"byReason":{"NOTHING_TO_LAND":1}}""", status: String = "OPEN", done: Boolean = false,
        extra: String = "") = j("""
        {"id":"p","title":"Project closeout","status":"$status"$extra,
         "acceptanceCriteriaItems":[{"id":"c1","ordinal":1,"text":"The release is on main"},{"id":"c2","ordinal":2,"text":"The live check was completed"}],
         "derivedDone":{"done":$done,"criteria":$criteria,"counts":$counts}}""")
    private val request = j("""{"criteriaDigest":"${"a".repeat(64)}","judgment":"The goal is met. I checked the release evidence below.",
        "gaps":[{"criterionKey":"c2","title":"The live check was completed","whyNotProven":"The task made no commits.",
                 "coordinatorChecked":"main contains the release files","evidenceRefs":["run-42"]}]}""")
    private fun asking(itemId: String = "req1") = buildJsonObject { put("itemId", itemId); put("kind", "DONE_REQUEST"); put("title", ProjectDone.heading); put("doneRequest", request) }
    private fun items(needsYou: List<JsonObject> = emptyList(), withCoordinator: List<JsonObject> = emptyList(), start: JsonObject? = null, done: JsonObject? = null) =
        buildJsonObject {
            put("needsYou", JsonArray(needsYou)); put("withCoordinator", JsonArray(withCoordinator)); start?.let { put("startRequest", it) }; done?.let { put("doneRequest", it) }
        }
    private val record = j("""{"projectId":"p1","status":"DONE","doneBy":"OWNER","doneAt":"2026-10-01T01:40:00.000Z","criteriaDigest":"d","acceptedGaps":${request["gaps"]}}""")

    // MARK: the counts

    @Test fun theTalliesAreTheBrowsersExamples() {
        val counts = ProjectDone.counts(closeout())
        assertEquals("2 met · 1 landed on main · 1 nothing to land", ProjectDone.cardTally(counts))
        assertEquals("2 criteria met · 1 landed on main · 1 nothing to land · 1 gaps accepted", ProjectDone.receiptTally(counts, 1))
        assertEquals("its parts add up to the criteria", "2 criteria · 1 on main · 1 nothing to land", ProjectDone.whyNotDoneTally(closeout()))
        assertEquals("a read without counts says nothing rather than zeros", "", ProjectDone.cardTally(null))
    }

    @Test fun noCodeToLandIsCountedAsNothingToLandOnTheCardButNamedInTheTally() {
        assertEquals("4 met · 3 landed on main · 2 nothing to land",
            ProjectDone.cardTally(j("""{"criteria":7,"met":4,"landed":3,"onMain":3,"byReason":{"IN_FLIGHT":1,"NO_RECEIPT":1,"CODELESS":2}}""")))
        val seven = closeout(criteria = """[{"definitionId":"c1","satisfied":true},{"definitionId":"c2","satisfied":true},
            {"definitionId":"c3","satisfied":true,"landingReason":"IN_FLIGHT"},{"definitionId":"c4","satisfied":true,"landingReason":"CODELESS"},
            {"definitionId":"c5","satisfied":false},{"definitionId":"c6","satisfied":false,"landingReason":"NO_RECEIPT"},
            {"definitionId":"c7","satisfied":false,"landingReason":"CODELESS"}]""")
        assertEquals("7 criteria · 2 on main · 1 in flight · 1 no code to land · 3 not met", ProjectDone.whyNotDoneTally(seven))
    }

    // MARK: the owner card

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

    @Test fun theNoteNotYetSendsIsTrimmedAndNeverEmpty() {
        assertEquals("the deploy is not verified", ProjectDone.declineNote("  the deploy is not verified \n"))
        assertNull(ProjectDone.declineNote(" \n "))
    }

    /** The request the card answers is not one of the open items Orbit checked — so a card the coordinator asked for says "no open
     * items" — but every other open item counts, the START_REQUEST kept beside the groups included (63f5e83c6, 33a94300f). */
    @Test fun orbitCheckedCountsEveryOpenItemButTheRequestItAnswers() {
        val row = j("""{"itemId":"i1","kind":"UNKNOWN","title":"","waitingSince":""}""")
        val onlyTheRequest = items(done = asking())
        assertEquals(0, ProjectDone.openItemsCount(onlyTheRequest))
        assertEquals("Orbit checked: every criterion is met by its work · nothing running · no open items · criteria confirmed by you on Sep 29",
            ProjectDone.orbitCheckedLine(ProjectDone.counts(closeout()), "2026-09-29T10:00:00.000Z", ProjectDone.openItemsCount(onlyTheRequest), 0, utc))
        assertEquals("nor counted when a server lists it among the owner's rows too", 0, ProjectDone.openItemsCount(items(needsYou = listOf(asking()), done = asking())))
        val withOthers = items(needsYou = listOf(row), withCoordinator = listOf(row, row), done = asking())
        assertEquals(3, ProjectDone.openItemsCount(withOthers))
        assertEquals("Orbit checked: every criterion is met by its work · nothing running · 3 open items",
            ProjectDone.orbitCheckedLine(ProjectDone.counts(closeout()), null, ProjectDone.openItemsCount(withOthers), 0))
        val start = j("""{"itemId":"s1","kind":"UNKNOWN","title":"","waitingSince":""}""")
        assertEquals("a request to start, and any other row: only the one under review is out", 2,
            ProjectDone.openItemsCount(items(needsYou = listOf(asking("req0")), start = start, done = asking())))
        assertEquals("a card nobody asked for answers no request: nothing is left out", 2, ProjectDone.openItemsCount(items(needsYou = listOf(row), start = start)))
        assertEquals(0, ProjectDone.openItemsCount(null))
        assertEquals(2, ProjectDone.runningCount(closeout(counts = """{"criteria":3,"met":3,"landed":1,"onMain":1,"byReason":{"IN_FLIGHT":2}}""")))
        assertEquals(ProjectDone.recordAsDone, ProjectDone.recordLabel(ProjectDone.counts(closeout())))
        assertEquals(ProjectDone.recordAsDoneAnyway, ProjectDone.recordLabel(j("""{"criteria":2,"met":1}""")))
        assertEquals("Orbit checked: 1 of 2 criteria are met by their work · nothing running · no open items",
            ProjectDone.orbitCheckedLine(j("""{"criteria":2,"met":1}"""), null, 0, 0))
    }

    @Test fun theRequestSaysHowLongItHasWaitedAndWhoAsked() {
        val now = Instant.parse("2026-10-05T21:00:00.000Z")
        assertEquals("waiting 25m", ProjectDone.requestWaiting("2026-10-05T20:35:00.000Z", now))
        assertEquals("waiting 3h 20m", ProjectDone.requestWaiting("2026-10-05T17:40:00.000Z", now))
        assertEquals("waiting 10s", ProjectDone.requestWaiting("2026-10-05T20:59:50.000Z", now))
        assertEquals("a request a little ahead of this clock has waited no time", "waiting 1s", ProjectDone.requestWaiting("2026-10-05T21:00:30.000Z", now))
        assertNull(ProjectDone.requestWaiting("not a time", now)); assertNull(ProjectDone.requestWaiting(null, now))
        assertEquals("Aurora · asked by the coordinator · waiting 25m", ProjectDone.meta("Aurora", true, "waiting 25m"))
        assertEquals("Aurora · asked by the coordinator", ProjectDone.meta("Aurora", true, null))
        assertEquals("Aurora · record as done anyway", ProjectDone.meta("Aurora", false, null))
    }

    // MARK: the receipt

    @Test fun theReceiptSaysWhoRecordedItAndWhatWasAccepted() {
        val subject = closeout()
        assertTrue(ProjectDone.recorded(subject, record))
        assertEquals("Project closeout · recorded by you · 1 gaps accepted · Oct 1", ProjectDone.receiptMeta(subject, record, utc))
        assertEquals("You recorded this project done · Oct 1, 01:40", ProjectDone.receiptLine(subject, record, utc))
        assertEquals("2 criteria met · 1 landed on main · 1 nothing to land · 1 gaps accepted", ProjectDone.receiptTally(subject, record))
        // Recorded at another end, read back off the document after a reload.
        val reloaded = closeout(status = "DONE", extra = ""","doneBy":"OWNER","doneAt":"2026-10-01T01:40:00.000Z","acceptedGaps":${request["gaps"]}""")
        assertTrue(ProjectDone.recorded(reloaded, null))
        assertEquals("You recorded this project done · Oct 1, 01:40", ProjectDone.receiptLine(reloaded, null, utc))
        assertFalse(ProjectDone.recorded(closeout(), null))
        assertTrue("a project Orbit recorded done is shown its receipt too", ProjectDone.recorded(closeout(status = "DONE", done = true), null))
        assertEquals("This project is done · recorded by Orbit", ProjectDone.receiptLine(closeout(status = "DONE", done = true), null, utc))
        // The status is the record — not who recorded it once: `doneBy` outlives a reopen, and a projection that says done on a project
        // the read still calls OPEN has not been recorded (63f5e83c6).
        val reopened = closeout(extra = ""","doneBy":"OWNER","doneAt":"2026-10-01T01:40:00.000Z","acceptedGaps":${request["gaps"]}""")
        assertFalse(ProjectDone.recorded(reopened, null)); assertFalse(ProjectDone.recorded(closeout(done = true), null))
        assertEquals("recorded by you · 1 gaps accepted", ProjectDone.provenance("OWNER", 1)); assertEquals("recorded by Orbit", ProjectDone.provenance("DERIVED", 0))
        assertEquals("recorded by Orbit", ProjectDone.settledBadge("DERIVED")); assertEquals("recorded by you", ProjectDone.settledBadge("OWNER"))
    }

    // MARK: which card the coordinator conversation draws

    @Test fun theConversationDrawsOneCardAndAskingOutranksExplaining() {
        val open = closeout()
        assertEquals("an OPEN project nobody asked about draws nothing, however finished it looks", ProjectDone.Slot.None, ProjectDone.slot(open, null, null, null))
        assertEquals("the coordinator's request puts the owner's card up", ProjectDone.Slot.Done("req1"), ProjectDone.slot(open, asking(), "DONE_REQUEST", null))
        assertEquals("a project that looks finished and was not asked about in time gets the card unasked", ProjectDone.Slot.Done(null),
            ProjectDone.slot(open, null, "RECORD_AS_DONE", null))
        assertEquals("the owner's DONE keeps its receipt in the conversation", ProjectDone.Slot.Done(null),
            ProjectDone.slot(closeout(status = "DONE", extra = ""","doneBy":"OWNER""""), null, null, null))
        assertEquals("Orbit's DONE is the old card's terminal state", ProjectDone.Slot.NotDone, ProjectDone.slot(closeout(status = "DONE", done = true), null, null, null))
        assertEquals("an OPEN project the projection already calls done is asked nothing", ProjectDone.Slot.None, ProjectDone.slot(closeout(done = true), null, null, null))
        assertEquals("a server without counts draws no card", ProjectDone.Slot.None,
            ProjectDone.slot(j("""{"status":"OPEN","derivedDone":{"done":false}}"""), asking(), "DONE_REQUEST", null))
        assertEquals("a read that has not answered is not an answer", ProjectDone.Slot.None, ProjectDone.slot(null, null, null, null))
    }

    /** The card's whole life in one conversation: asked, recorded, read back after a reload, reopened, and Not yet… answered. */
    @Test fun theReceiptOutlivesAReloadAndNotYetOrReopenEndAtNothing() {
        val asked = closeout()
        assertEquals(ProjectDone.Slot.Done("req1"), ProjectDone.slot(asked, asking(), "DONE_REQUEST", null))
        assertEquals("the door's record turns the same card into its receipt, in place", ProjectDone.Slot.Done(null), ProjectDone.slot(asked, null, null, record))
        val reloaded = closeout(status = "DONE", extra = ""","doneBy":"OWNER","doneAt":"2026-10-01T01:40:00.000Z","acceptedGaps":${request["gaps"]}""")
        assertEquals("a project the owner recorded done keeps its receipt", ProjectDone.Slot.Done(null), ProjectDone.slot(reloaded, null, null, null))
        assertEquals("2 criteria met · 1 landed on main · 1 nothing to land · 1 gaps accepted", ProjectDone.receiptTally(reloaded, null))
        assertEquals("Reopen project, or Not yet… on a request: nothing is asked, and nothing drawn", ProjectDone.Slot.None, ProjectDone.slot(asked, null, null, null))
        val reopened = closeout(extra = ""","doneBy":"OWNER","doneAt":"2026-10-01T01:40:00.000Z","acceptedGaps":${request["gaps"]}""")
        assertEquals(ProjectDone.Slot.None, ProjectDone.slot(reopened, null, null, null))
    }

    // MARK: the page

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
