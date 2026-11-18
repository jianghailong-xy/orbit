package io.orbitd.android.projects

import io.orbitd.android.core.cards.*
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
import java.time.Instant
import java.time.ZoneOffset

/** The done card's follow-ups as web's projectDone.ts decides them (ProjectDoneFollowUps.test.tsx, ProjectDoneRecords.test.tsx): the
 * non-code mark, work that ran without a branch, findings grouped by criterion, Move to a follow-up… and criteria met by
 * confirmation — over the CBAI shape the decided board draws. */
class DoneFollowUpsTest {
    private val utc = ZoneOffset.UTC
    private fun j(text: String) = Json.parseToJsonElement(text).jsonObject

    /** CBAI Phase 0: four criteria, three met by work that ran without a branch, the fourth held by one open task. */
    private fun cbai(nonCode: Boolean = false, extra: String = "") = j("""{"id":"p1","title":"CBAI Phase 0","status":"OPEN",
        "nonCode":$nonCode,"nonCodeSetBy":"COORDINATOR","nonCodeSetAt":"2026-11-11T10:20:00Z"$extra,
        "acceptanceCriteriaItems":[{"id":"d1","key":"k1","ordinal":1,"text":"Criterion 1"},{"id":"d2","key":"k2","ordinal":2,"text":"Criterion 2"},
            {"id":"d3","key":"k3","ordinal":3,"text":"Criterion 3"},{"id":"d4","key":"k4","ordinal":4,"text":"External prerequisites settled"}],
        "derivedDone":{"nonCode":$nonCode,"criteria":[
            {"definitionId":"d1","satisfied":true,"landingReason":${if (nonCode) "null" else "\"NO_BRANCH\""}},
            {"definitionId":"d2","satisfied":true,"landingReason":${if (nonCode) "null" else "\"NO_BRANCH\""}},
            {"definitionId":"d3","satisfied":true,"landingReason":${if (nonCode) "null" else "\"NO_BRANCH\""}},
            {"definitionId":"d4","satisfied":false,"landingReason":null}],
          "counts":{"criteria":4,"met":3,"landed":0,"onMain":0,"byReason":{"NO_BRANCH":${if (nonCode) 0 else 3}}}}}""")
    private val unmet4 = j("""{"severity":"REFUSE","code":"DONE_CRITERION_UNSATISFIED","message":"m","criterion":{"key":"k4","ordinal":4,
        "text":"External prerequisites settled"},"reason":null,"tasks":[{"taskId":"t9","title":"Settle external prerequisites"}]}""")

    @Test fun aNonCodeProjectReadsNoLanding() {
        val doc = cbai(nonCode = true)
        assertTrue(DoneFollowUps.nonCode(doc))
        assertEquals("3 of 4 met", ProjectDone.cardTally(ProjectDone.counts(doc), "main", nonCode = true))
        assertEquals("3 of 4 met · 2 wait for confirmation", ProjectDone.cardTally(ProjectDone.counts(doc), "main", nonCode = true, waitingConfirmation = 2))
        assertEquals("4 criteria met · 0 gaps accepted", ProjectDone.receiptTally(ProjectDone.counts(doc), 0, "main", nonCode = true))
        assertEquals("4 criteria · 3 met · 1 not met", ProjectDone.whyNotDoneTally(doc))
        val rows = ProjectDone.criteria(doc).map { DoneFollowUps.rowState(it.derived, true, "main") }
        assertEquals(listOf("met", "met", "met", "not met"), rows.map { it.text })
        assertEquals("Marked by the coordinator · Nov 11", DoneFollowUps.provenance(doc) { ProjectDone.date(it, utc) })
        assertEquals("Marked by you", DoneFollowUps.provenance(j("""{"nonCode":true,"nonCodeSetBy":"OWNER"}""")))
        assertNull(DoneFollowUps.provenance(cbai()))
        assertEquals("“All work is documents”", DoneFollowUps.reasonLine(cbai(true, ""","nonCodeReason":"  All work is documents """")))
        assertNull(DoneFollowUps.reasonLine(cbai(false, ""","nonCodeReason":"x"""")))
    }

    @Test fun branchlessWorkIsItsOwnReasonNeverNoCodeOrNotOnMain() {
        val doc = cbai()
        assertEquals("3 met · 0 landed on main · 3 ran without a branch", ProjectDone.cardTally(ProjectDone.counts(doc)))
        assertEquals("zero parts are dropped", "1 met · 1 landed on main", ProjectDone.cardTally(j("""{"criteria":2,"met":1,"onMain":1,"byReason":{}}""")))
        assertEquals("4 criteria · 0 on main · 3 ran without a branch · 1 not met", ProjectDone.whyNotDoneTally(doc))
        val row = DoneFollowUps.rowState(ProjectDone.criteria(doc).first().derived, false, "main")
        assertEquals(DoneFollowUps.RowState("met · Ran without a branch", warn = true), row)
        assertEquals("an unmet criterion is not met and nothing more", "not met", DoneFollowUps.rowState(ProjectDone.criteria(doc).last().derived, false, "main").text)
        fun unlanded(reason: String, tasks: String = "[]") = j("""{"severity":"WARN","code":"DONE_CRITERION_UNLANDED","message":"m","criterion":{"key":"k1","ordinal":1,"text":"t"},
            "reason":"$reason","tasks":$tasks}""")
        assertEquals("Criterion 1: 6 tasks ran without a branch, so Orbit can’t see whether their changes reached master. Check master yourself before recording it done.",
            ProjectDone.findingLine(unlanded("NO_BRANCH", (1..6).joinToString(",", "[", "]") { """{"taskId":"t$it","title":"T"}""" }), "master"))
        assertEquals("Criterion 1: its work ran without a branch, so Orbit can’t see whether their changes reached main. Check main yourself before recording it done.",
            ProjectDone.findingLine(unlanded("NO_BRANCH"), "main"))
        assertEquals("Criterion 1 is on the project branch, not on main yet", ProjectDone.findingLine(unlanded("ON_PROJECT_BRANCH"), "main"))
        assertEquals("Criterion 1 is being landed on main", ProjectDone.findingLine(unlanded("IN_FLIGHT"), "main"))
        assertEquals("Criterion 1 has nothing to land", ProjectDone.findingLine(unlanded("NOTHING_TO_LAND"), "main"))
        assertEquals("Criterion 1 has no code to land", ProjectDone.findingLine(unlanded("CODELESS"), "main"))
        assertEquals("only work Orbit saw no merge of reads not on main", "Criterion 1 is not on main", ProjectDone.findingLine(unlanded("NO_RECEIPT"), "main"))
    }

    @Test fun findingsAreGroupedUnmetFirstNamingTheirTasks() {
        val warn = j("""{"severity":"WARN","code":"DONE_CRITERION_UNLANDED","message":"m","criterion":{"key":"k1","ordinal":1,"text":"t"},"reason":"NO_BRANCH","tasks":[]}""")
        val running = j("""{"severity":"REFUSE","code":"DONE_TASKS_IN_FLIGHT","message":"m","tasks":[{"taskId":"a"},{"taskId":"b"}]}""")
        val unmet2 = j(unmet4.toString().replace("\"ordinal\":4", "\"ordinal\":2").replace("\"tasks\":[{\"taskId\":\"t9\",\"title\":\"Settle external prerequisites\"}]",
            "\"tasks\":[{\"taskId\":\"a\",\"title\":\"A\"},{\"taskId\":\"b\",\"title\":\"B\"}]"))
        val groups = DoneFollowUps.group(listOf(warn, running, unmet4, unmet2))
        assertEquals(listOf(2, 4), groups.unmet.map { it.obj("criterion")?.number("ordinal") })
        assertEquals(listOf(running), groups.otherRefusals)
        assertEquals(listOf(warn), groups.warnings)
        assertEquals("3 things stand in the way", DoneFollowUps.standsInWay(groups.blocking.size))
        assertEquals("1 thing stands in the way", DoneFollowUps.standsInWay(1))
        assertEquals("Orbit can’t prove 1 thing", DoneFollowUps.cantProve(1))
        assertEquals("Orbit can’t prove 2 things", DoneFollowUps.cantProve(2))
        assertEquals("If you record it done anyway, Orbit keeps criteria 2 and 4 as the gap you accepted.", DoneFollowUps.anywayKeeps(groups))
        assertEquals(ProjectDone.findingsAccepted, DoneFollowUps.anywayKeeps(DoneFollowUps.group(listOf(warn))))
        assertEquals("Criterion 4 is not met — 1 task is still open", ProjectDone.findingLine(unmet4, "main"))
        assertEquals("Criterion 2 is not met — 2 tasks are still open", ProjectDone.findingLine(unmet2, "main"))
        assertEquals("Criterion 4 is not met — it waits for confirmation", ProjectDone.findingLine(unmet4, "main", confirmation = true))
        assertEquals("Criterion 4 is not met — no task serves it", ProjectDone.findingLine(j(unmet4.toString().replace(Regex("\"tasks\":\\[.*]"), "\"tasks\":[]")), "main"))
        assertEquals("takes criterion 4 and its open tasks out of this project", DoneFollowUps.moveHint(4))
        assertEquals("criteria 2, 3 and 4", DoneFollowUps.criteriaPhrase(listOf(2, 3, 4)))
    }

    @Test fun recordIsAnywayOnlyWhileSomethingStandsOrIsUnread() {
        val allMet = j("""{"criteria":3,"met":3}""")
        assertEquals("board 02 ⑤ H: all met and nothing found", ProjectDone.recordAsDone, ProjectDone.recordLabel(allMet, asked = false, doneCheck = j("""{"findings":[]}""")))
        assertEquals(ProjectDone.recordAsDoneAnyway, ProjectDone.recordLabel(allMet, asked = false, doneCheck = null))
        assertEquals(ProjectDone.recordAsDoneAnyway, ProjectDone.recordLabel(allMet, asked = false, doneCheck = j("""{"findings":[{}]}""")))
        assertEquals(ProjectDone.recordAsDoneAnyway, ProjectDone.recordLabel(j("""{"criteria":3,"met":2}"""), asked = true, doneCheck = null))
    }

    @Test fun moveToAFollowUpSaysWhatMovesAndWhatStays() {
        val subject = DoneFollowUps.moveSubject(cbai(), unmet4)!!
        assertEquals(DoneFollowUps.MoveSubject("p1", "CBAI Phase 0", "k4", 4, "External prerequisites settled", unmet4.objects("tasks"), 3, true), subject)
        assertEquals("This project keeps 3 criteria, all met.", DoneFollowUps.moveKeeps(subject))
        assertEquals("This project keeps 3 criteria, all met. You can record it as done right after.", DoneFollowUps.moveConfirmThis(subject))
        assertEquals("CBAI follow-up is created, not started, and gets criterion 4 and its 1 open task.",
            DoneFollowUps.moveConfirmThere(subject, true, "CBAI follow-up"))
        assertEquals("Launch gets criterion 4, after its own criteria.", DoneFollowUps.moveConfirmThere(subject.copy(openTasks = emptyList()), false, "Launch"))
        assertEquals("""{"newProject":{"title":"CBAI Phase 0 · follow-up","goal":"Follow-up of “CBAI Phase 0”: criterion 4."}}""",
            DoneFollowUps.moveBody(subject, true, " CBAI Phase 0 · follow-up ", null).toString())
        assertEquals("""{"toProjectId":"p7"}""", DoneFollowUps.moveBody(subject, false, "", "p7").toString())
        val projects = listOf(j("""{"id":"p1","title":"CBAI Phase 0","status":"OPEN"}"""), j("""{"id":"p7","title":"CBAI Phase 1 · launch","status":"OPEN"}"""),
            j("""{"id":"p8","title":"CBAI vendor accounts","status":"DONE"}"""), j("""{"id":"p9","title":"Marketing site","status":"OPEN"}"""))
        assertEquals("open projects only, never its own", listOf("p7", "p9"), DoneFollowUps.moveCandidates(projects, "p1", "").map { it.text("id") })
        assertEquals(listOf("p7"), DoneFollowUps.moveCandidates(projects, "p1", " launch").map { it.text("id") })
    }

    @Test fun movedRecordsOnBothSides() {
        val out = j("""{"criterionKey":"k4","definitionId":"d4","ordinal":4,"text":"t","toProjectId":"p7","toProjectTitle":"Follow-up","movedAt":"2026-11-11T19:40:00Z"}""")
        assertEquals("Criterion 4 moved to", DoneFollowUps.movedOutLead(out))
        assertEquals("A criterion moved to", DoneFollowUps.movedOutLead(j("""{"ordinal":null}""")))
        assertEquals("by you · Nov 11, 19:40", DoneFollowUps.movedBy("2026-11-11T19:40:00Z") { ProjectDone.dateTime(it, utc) })
        assertEquals("by you", DoneFollowUps.movedBy(null))
    }

    // MARK: criteria met by confirmation (board 03)

    private fun view(kind: String, note: String? = null, shots: Int = 0, revision: Int = 1, session: String? = null) =
        """{"id":"v","revision":$revision,"confirmerKind":"$kind","outcome":"CONFIRMED","sessionId":${session?.let { "\"$it\"" } ?: "null"},
            "checkTaskId":null,"note":${note?.let { "\"$it\"" } ?: "null"},"attachmentIds":${(1..shots).joinToString(",", "[", "]") { "\"a$it\"" }},
            "at":"2026-11-10T10:42:00Z","criterionText":"Old words","criterionVerificationMethod":"Old method"}"""
    private fun item(state: String, current: String? = null, running: String? = null, revision: Int = 2) = j("""{"id":"d5","ordinal":5,"text":"SMS provider is live",
        "verificationMethod":"Template approved","revision":$revision,"satisfiedBy":"CONFIRMATION",
        "confirmation":{"state":"$state","current":${current ?: "null"},"stale":${state == "STALE"},"checkRunning":${running ?: "null"}}}""")

    @Test fun eachConfirmerHasItsRow() {
        val now = Instant.parse("2026-11-11T12:00:00Z")
        val you = DoneFollowUps.confirmationWork(item("CONFIRMED", view("OWNER", "Aliyun SMS template approved", shots = 1)), now, utc)
        assertEquals("Met · confirmed by you", you.sentence); assertTrue(you.met)
        assertEquals("“Aliyun SMS template approved”", you.note); assertEquals("Nov 10, 10:42", you.whenText); assertEquals(listOf("a1"), you.shots)
        val coordinator = DoneFollowUps.confirmationWork(item("CONFIRMED", view("COORDINATOR", session = "s1")), now, utc)
        assertEquals("Met · confirmed by the coordinator", coordinator.sentence); assertEquals("s1", coordinator.conversationId); assertNull(coordinator.runSessionId)
        val pass = DoneFollowUps.confirmationWork(item("CONFIRMED", view("AGENT_CHECK", "merchant is Active", session = "r1")), now, utc)
        assertEquals("Met · Agent check passed", pass.sentence); assertEquals("PASS — merchant is Active", pass.note); assertEquals("r1", pass.runSessionId)
        val fail = DoneFollowUps.confirmationWork(item("CHECK_FAILED", view("AGENT_CHECK", "no filing number", session = "r2")), now, utc)
        assertEquals("Not met · Agent check failed", fail.sentence); assertEquals("FAIL — no filing number", fail.note); assertTrue(fail.failed); assertFalse(fail.met)
        val running = DoneFollowUps.confirmationWork(item("UNCONFIRMED", running = view("AGENT_CHECK", session = "r3").replace("2026-11-10T10:42:00Z", "2026-11-11T11:58:00Z")), now, utc)
        assertEquals("Checking… · Agent check running", running.sentence); assertEquals("started 2m ago", running.whenText); assertTrue(running.running)
        val stale = DoneFollowUps.confirmationWork(item("STALE", view("OWNER")), now, utc)
        assertEquals("Not met · confirmed for an earlier wording", stale.sentence)
        assertEquals("You confirmed revision 1 on Nov 10. The wording has changed since.", stale.note); assertNotNull(stale.stale)
        assertEquals(DoneCopy.CRITERION_WAITS_CONFIRMATION, DoneFollowUps.confirmationWork(item("UNCONFIRMED"), now, utc).sentence)
    }

    @Test fun theDoneCardRowSaysWhoConfirmed() {
        fun derived(satisfied: Boolean, state: String, current: String?, running: String? = null) = j("""{"definitionId":"d5","satisfied":$satisfied,"satisfiedBy":"CONFIRMATION",
            "landingReason":"NO_BRANCH","confirmation":{"state":"$state","current":${current ?: "null"},"checkRunning":${running ?: "null"}}}""")
        assertEquals("met · by you", DoneFollowUps.rowState(derived(true, "CONFIRMED", view("OWNER")), false, "main").text)
        assertEquals("met · by the coordinator", DoneFollowUps.rowState(derived(true, "CONFIRMED", view("COORDINATOR")), false, "main").text)
        assertEquals("met · Agent check PASS", DoneFollowUps.rowState(derived(true, "CONFIRMED", view("AGENT_CHECK")), false, "main").text)
        assertEquals("not met · Agent check failed", DoneFollowUps.rowState(derived(false, "CHECK_FAILED", view("AGENT_CHECK")), false, "main").text)
        assertEquals(DoneFollowUps.RowState("not met · confirmed for an earlier wording", true), DoneFollowUps.rowState(derived(false, "STALE", view("OWNER")), false, "main"))
        assertEquals("not met · checking…", DoneFollowUps.rowState(derived(false, "UNCONFIRMED", null, view("AGENT_CHECK")), false, "main").text)
        assertEquals("not met · waits for confirmation", DoneFollowUps.rowState(derived(false, "UNCONFIRMED", null), false, "main").text)
        assertEquals("Confirmed by you · Nov 10 · “Aliyun SMS template approved” · 1 screenshot",
            DoneFollowUps.confirmationLine(j(view("OWNER", "Aliyun SMS template approved", shots = 1)), utc))
        assertEquals("Confirmed by an Agent check · Nov 10 · 2 screenshots", DoneFollowUps.confirmationLine(j(view("AGENT_CHECK", shots = 2)), utc))
        val doc = j("""{"acceptanceCriteriaItems":[{"id":"d5","key":"k5","ordinal":5,"text":"t"}],"derivedDone":{"criteria":[
            {"definitionId":"d5","satisfied":false,"satisfiedBy":"CONFIRMATION"},{"definitionId":"d6","satisfied":false}]}}""")
        assertEquals(1, DoneFollowUps.waitingConfirmation(doc))
        assertTrue(DoneFollowUps.findingByConfirmation(doc, j("""{"criterion":{"key":"k5","ordinal":5}}""")))
    }

    @Test fun theOwnersWritesRestateWhatTheyChange() {
        val items = listOf(j("""{"id":"d2","ordinal":2,"text":"Two","verificationMethod":"","satisfiedBy":"TASKS"}"""),
            j("""{"id":"d1","ordinal":1,"text":"One","verificationMethod":"Look","completionCriterionOverrideReason":"why"}"""))
        assertEquals("""{"acceptanceCriteriaItems":[{"id":"d1","text":"One","verificationMethod":"Look","completionCriterionOverrideReason":"why","satisfiedBy":"TASKS"},""" +
            """{"id":"d2","text":"Two","verificationMethod":"","satisfiedBy":"CONFIRMATION"}]}""", DoneFollowUps.modeBody(items, "d2", "CONFIRMATION").toString())
        assertEquals("""{"note":"filing no. 123","revision":3,"attachmentIds":["a1"]}""", DoneFollowUps.confirmBody(" filing no. 123 ", 3, "a1").toString())
        assertEquals("{}", DoneFollowUps.confirmBody("  ", null, null).toString())
        assertEquals("8 criteria stated. 2 met by their tasks; 6 by a confirmation — from you, the coordinator, or an Agent check.",
            DoneFollowUps.standingMixed(List(2) { j("""{"satisfiedBy":"TASKS"}""") } + List(6) { j("""{"satisfiedBy":"CONFIRMATION"}""") }))
        assertNull(DoneFollowUps.standingMixed(listOf(j("{}"))))
    }
}
