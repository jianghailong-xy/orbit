package io.orbitd.android.reader

import io.orbitd.android.core.cards.number
import io.orbitd.android.core.cards.text
import io.orbitd.android.navigation.ObjectId
import java.time.Instant
import java.time.ZoneOffset
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The landing session page's model (contract §2.9 LS1/LS6/LS7, §7.2 V6; mockups v4 05 and 07): the decode with every
 * optional slot, the status card's five liveness readings across the three job kinds, the timeline's sections, the menu's
 * doors and their J12 sentences, §2.7a's cadence, and a failed read opening nothing.
 */
class LandingSessionModelTest {
    private val now = Instant.parse("2026-10-20T17:36:00Z")
    private fun iso(secondsBefore: Long) = now.minusSeconds(secondsBefore).toString()
    private fun json(text: String): JsonObject = Json.parseToJsonElement(text).jsonObject
    private val project = "123e4567-e89b-12d3-a456-426614174000"

    private fun checkJson(step: Long = 110, budget: Int = 3600, name: String = "TASK_ACCEPTANCE", count: Int = 3) =
        """{"name":"$name","index":1,"count":$count,"budgetSeconds":$budget,"startedAt":"${iso(step)}"}"""

    /** The landing view with one attempt; every field the server sends, so a test can drop the ones it is about. */
    private fun landingJson(
        subject: String = "TASK", taskId: String? = "t-landing", promotionId: String? = null,
        kind: String = "LAND_TASK", state: String = "RUNNING", liveness: String? = "LIVE", timedOut: Boolean = false,
        step: Long = 110, heartbeat: Long? = 0, outputAge: Long? = 6, claim: Int = 1, round: Int? = 1, phase: String? = "CHECK",
        check: String? = checkJson(step), retryable: Boolean = false, pastPush: Boolean = false, protocol: String = "v2",
        limit: Int? = 600, runner: String = "wikova", source: String? = "s-source", settledAt: String? = null,
        settledAs: String? = null, checks: String = "[]", timeline: String? = null, blocking: String? = null,
    ): JsonObject {
        val attempt = """{"jobId":"j-1","kind":"$kind","state":"$state","generation":1,"phase":${phase?.let { "\"$it\"" } ?: "null"},
            "round":${round ?: "null"},"step":null,"claim":$claim,"runnerName":"$runner","sourceSessionId":${source?.let { "\"$it\"" } ?: "null"},
            "targetRef":"refs/heads/project/launch","startedAt":"${iso(step)}","heartbeatAt":${heartbeat?.let { "\"${iso(it)}\"" } ?: "null"},
            "outputMovedAt":${outputAge?.let { "\"${iso(it)}\"" } ?: "null"},"progressProtocol":"$protocol",
            "check":${if (state == "RUNNING") check ?: "null" else "null"},"liveness":${liveness?.let { "\"$it\"" } ?: "null"},
            "blockingReason":${blocking ?: "null"},"timedOut":$timedOut,"limitSeconds":${limit ?: "null"},
            "retryable":$retryable,"pushBoundaryPassed":$pastPush}"""
        return json("""{"sessionId":"s-landing","projectId":"$project","subject":"$subject","taskId":${taskId?.let { "\"$it\"" } ?: "null"},
            "promotionId":${promotionId?.let { "\"$it\"" } ?: "null"},"episode":4,"openedAt":"${iso(3600)}",
            "settledAt":${settledAt?.let { "\"$it\"" } ?: "null"},"settledAs":${settledAs?.let { "\"$it\"" } ?: "null"},
            "phase":${phase?.let { "\"$it\"" } ?: "null"},"round":${round ?: "null"},"checks":$checks,"liveness":${liveness?.let { "\"$it\"" } ?: "null"},
            "blockingReason":null,"currentAttempt":$attempt,"todos":[],"generations":[]${timeline?.let { ""","timeline":$it""" }.orEmpty()}}""")
    }

    private fun view(
        subject: String = "TASK", taskId: String? = "t-landing", promotionId: String? = null,
        kind: String = "LAND_TASK", state: String = "RUNNING", liveness: String? = "LIVE", timedOut: Boolean = false,
        step: Long = 110, heartbeat: Long? = 0, outputAge: Long? = 6, claim: Int = 1, round: Int? = 1, phase: String? = "CHECK",
        check: String? = checkJson(step), retryable: Boolean = false, pastPush: Boolean = false, protocol: String = "v2",
        limit: Int? = 600, runner: String = "wikova", source: String? = "s-source", settledAt: String? = null,
        settledAs: String? = null, checks: String = "[]", timeline: String? = null, blocking: String? = null,
    ) = LandingSessionModel.read(landingJson(subject, taskId, promotionId, kind, state, liveness, timedOut, step, heartbeat, outputAge,
        claim, round, phase, check, retryable, pastPush, protocol, limit, runner, source, settledAt, settledAs, checks, timeline, blocking))!!
    private fun card(view: LandingView, failed: Boolean = false, updatedAt: Instant? = now, facts: LandingFacts = LandingFacts()) =
        LandingSessionModel.attemptCard(view, now, updatedAt, failed, facts, ZoneOffset.UTC)

    // MARK: the decode

    @Test fun theDetailIsALandingOnlyWhenItsOwnSessionKindSaysSo() {
        val detail = json("""{"id":"s","sessionKind":"LANDING","landing":${landingJson()}}""")
        assertTrue(LandingSessionModel.isLanding(detail))
        assertFalse(LandingSessionModel.isLanding(json("""{"id":"s","sessionKind":"CONVERSATION"}""")))
        assertFalse(LandingSessionModel.isLanding(json("""{"id":"s"}""")))
        assertNull("a conversation has no landing view", LandingSessionModel.view(json("""{"id":"s"}""")))
    }

    /** A server before the timeline: the view decodes without it, and each optional field reads as the fact it did not send. */
    @Test fun anOlderServersViewDecodesWithEveryOptionalSlotMissing() {
        val detail = json("""{"id":"s","title":null,"sessionKind":"LANDING","landing":{
            "sessionId":"s","projectId":"$project","subject":"TASK","taskId":"t-landing","episode":1,"openedAt":"${iso(60)}",
            "currentAttempt":{"jobId":"j-1","kind":"LAND_TASK","state":"RUNNING","generation":1,"phase":"CHECK","claim":1,
              "startedAt":"${iso(30)}","heartbeatAt":"${iso(0)}","progressProtocol":"v2"}}}""")
        val view = LandingSessionModel.view(detail)!!
        assertNull(view.timeline)
        assertNull(view.promotionId)
        assertNull(view.settledAt)
        assertEquals(0, view.checks.size)
        val attempt = view.currentAttempt!!
        assertEquals(1, attempt.claim)
        assertNull(attempt.round)
        assertNull(attempt.check)
        assertNull(attempt.liveness)
        assertFalse(attempt.timedOut)
        assertNull(attempt.limitSeconds)
        assertFalse("an older server never says Retry", attempt.retryable)
        assertFalse("…nor the push boundary", attempt.pushBoundaryPassed)
        assertNull(attempt.sourceSessionId)
        assertEquals("Landing", card(view)!!.word)
        // A subject no attempt claimed yet: the card draws nothing — the page's own "queued" note stands in.
        assertNull(LandingSessionModel.attemptCard(view.copy(currentAttempt = null), now))
    }

    /** LS1: before the session row exists the same view answers under the pre-generated id, without a title — the page
     *  spells one from the subject and, for a task, its title. */
    @Test fun aLandingWithoutItsRowStillTitlesItself() {
        val task = LandingSessionModel.read(landingJson())
        assertEquals("Land · Wire the page", LandingSessionModel.headerTitle(task, null, "Wire the page"))
        assertEquals("Land", LandingSessionModel.headerTitle(task, null, null))
        assertEquals("Land · Wire the page", LandingSessionModel.headerTitle(task, "", "Wire the page"))
        assertEquals("The row's own title", LandingSessionModel.headerTitle(task, "The row's own title"))
        val round = LandingSessionModel.read(landingJson(subject = "PROMOTION", taskId = null, promotionId = "p-1", kind = "CHECK_PROMOTION"))
        assertEquals("Merge project ${ObjectId.toPublic(project)} → main · #4", LandingSessionModel.headerTitle(round, null))
        assertEquals("Run by Orbit · runner wikova", LandingSessionModel.headerSub(task))
        val settled = LandingSessionModel.read(landingJson(settledAt = "2026-10-20T17:31:00Z", settledAs = "LANDED"))
        assertEquals("Run by Orbit · settled 17:31", LandingSessionModel.headerSub(settled, ZoneOffset.UTC))
        assertEquals("Run by Orbit", LandingSessionModel.headerSub(null))
    }

    @Test fun theLogPageDecodesItsChunksAndCursor() {
        val page = LandingSessionModel.logPage(json("""{"jobId":"j-1","entries":[{"claim":1,"round":1,"seq":0,"text":"npm test\n","truncatedBytes":0},
            {"claim":1,"round":1,"seq":1,"text":"done\n","truncatedBytes":2048,"at":"${iso(10)}"}],"nextCursor":"c2"}"""))
        assertEquals("j-1", page.jobId)
        assertEquals(listOf("npm test\n", "done\n"), page.entries.map { it.text })
        assertEquals(2048, page.entries[1].truncatedBytes)
        assertEquals("c2", page.nextCursor)
        assertEquals(LandingLogPage("j", emptyList(), null), LandingSessionModel.logPage(json("""{"jobId":"j","entries":[]}""")))
    }

    // MARK: the status card

    @Test fun liveAndQuietLetTheClockRunAndSayTheOutputsAge() {
        val live = card(view())!!
        assertEquals("Landing", live.word)
        assertEquals("checking", live.state)
        assertEquals("1m 50s of 60m", live.right)
        assertTrue(live.rightIsClock)
        assertEquals("checking · output 6s ago · claim 1 · round 1 of 3 · updated just now", live.detail)
        assertEquals("Task acceptance 1m 50s of 60m", live.budget)
        assertEquals("Output 6s ago · Updated just now", live.live)
        assertTrue(live.fresh)
        assertTrue(live.running)
        assertTrue(live.progress!! in 0.02f..0.04f)

        val quiet = card(view(liveness = "QUIET", outputAge = 840L))!!
        assertEquals("checking · no output for 14m · within its 60m budget · claim 1 · round 1 of 3 · updated just now", quiet.detail)
        assertEquals("No output for 14m · within its 60m budget · Updated just now", quiet.live)
        assertTrue(quiet.fresh)
    }

    @Test fun silentFreezesTheClockAtTheRunnersLastWordAndLegacyAtTheRead() {
        val silent = card(view(liveness = "SILENT", step = 600L, heartbeat = 240L))!!
        assertEquals("6m 0s of 60m", silent.right)
        assertEquals("checking · no word from runner wikova for 4m · claim 1 · round 1 of 3", silent.detail)
        assertEquals("No word from runner wikova for 4m", silent.live)
        assertFalse("a silent runner is not fresh", silent.fresh)
        assertTrue("its ring still turns — the runner is alive", silent.running)

        val legacy = card(view(liveness = "LEGACY", step = 720L, heartbeat = 720L))!!
        assertEquals("12m 0s of 60m", legacy.right)
        assertEquals("checking · reports only between steps · claim 1 · round 1 of 3 · updated 12m ago", legacy.detail)
        assertEquals("Reports only between steps · Updated 12m ago", legacy.live)
    }

    /** LEASE_EXPIRED is the one timeout: the server's own `Timed out` head, the silence against the limit, no clock, no doors. */
    @Test fun leaseExpiredIsTimedOutInTheServersOwnWords() {
        val timedOut = card(view(timedOut = true, liveness = "LEASE_EXPIRED", heartbeat = 1380L, step = 1380L))!!
        assertEquals("Timed out", timedOut.state)
        assertEquals("Timed out", timedOut.right)
        assertFalse(timedOut.rightIsClock)
        assertEquals("No report for 23m · limit 10m", timedOut.detail)
        assertNull(timedOut.budget)
        assertNull(timedOut.live)
        assertFalse(timedOut.running)
        assertTrue(timedOut.timedOut)
        val gates = LandingSessionModel.gates(view(timedOut = true, liveness = "LEASE_EXPIRED", retryable = true), now, now, false)
        assertFalse(gates.stop)
        assertTrue(gates.abandon)
        assertTrue(gates.retry)
    }

    /** A server that says `liveness` but not `timedOut` still times the claim out at LEASE_EXPIRED (the same fact). */
    @Test fun theLivenessWordAloneCanBeTheTimeout() {
        val timedOut = card(view(liveness = "LEASE_EXPIRED", timedOut = false, heartbeat = 600L))!!
        assertEquals("Timed out", timedOut.state)
    }

    @Test fun theThreeJobKindsWearTheirOwnWord() {
        assertEquals("Landing", card(view(kind = "LAND_TASK"))!!.word)
        assertEquals("Merge check", card(view(kind = "CHECK_PROMOTION"))!!.word)
        assertEquals("Merge to main", card(view(kind = "LAND_PROMOTION"))!!.word)
        // The job word names the branch: with the project's main read as `trunk`, the merge says so.
        assertEquals("Merge to trunk", card(view(kind = "LAND_PROMOTION"), facts = LandingFacts(main = "trunk"))!!.word)
    }

    /** §7.2 V6: the M of "round N of M" is the kind's most rounds per claim, never the check's count — a task's landing is "of 3" with
     * one check in flight and with none, and the two merge kinds, which have one round per claim, name no M (iOS LandingSessionPageTests). */
    @Test fun theRoundsMIsTheKindsNeverTheChecksCount() {
        assertEquals("checking · output 6s ago · claim 1 · round 2 of 3 · updated just now",
            card(view(round = 2, check = checkJson(count = 1)))!!.detail)
        assertEquals("rebasing · output 6s ago · claim 1 · round 1 of 3 · updated just now", card(view(phase = "REBASE", check = null))!!.detail)
        assertEquals("checking · output 6s ago · claim 1 · round 1 · updated just now", card(view(kind = "CHECK_PROMOTION"))!!.detail)
        assertEquals("pushing · output 6s ago · claim 1 · round 1 · updated just now",
            card(view(kind = "LAND_PROMOTION", phase = "PUSH", check = null))!!.detail)
    }

    /** Usually is the merge check's own fact: an acceptance check has no usual duration to name (design §3). */
    @Test fun usuallyIsTheMergeChecksAlone() {
        val acceptance = card(view(), facts = LandingFacts(typicalMs = 18 * 60_000))!!
        assertFalse(acceptance.detail.contains("usually"))
        assertNull(acceptance.usualProgress)
        val merge = card(view(kind = "CHECK_PROMOTION", check = checkJson(name = "MERGE_CHECK")), facts = LandingFacts(typicalMs = 18 * 60_000))!!
        assertEquals("Merge check 1m 50s of 60m · usually ~18m", merge.budget)
        assertTrue(merge.detail.contains("usually ~18m"))
        assertNotNull(merge.usualProgress)
    }

    /** Liveness is the runner's own last report: a fresh read does not make a silent job look active. */
    @Test fun freshnessIsTheRunnersReportNotThisAppsRead() {
        val quietForLong = card(view(liveness = "LIVE", heartbeat = 300L))!!
        assertTrue(quietForLong.detail.endsWith("updated 5m ago"))
    }

    @Test fun aQueuedAttemptSaysItsWaitAndTheServersReason() {
        val queued = card(view(state = "QUEUED", phase = null, claim = 0, check = null, heartbeat = null, outputAge = null,
            blocking = """{"code":"WAITING_RUNNER","summary":"Waiting for runner wikova"}"""))!!
        assertEquals("queued", queued.state)
        assertTrue(queued.rightIsClock)
        assertEquals("queued · Waiting for runner wikova", queued.detail)
        assertNull(queued.budget)
        assertFalse(queued.running)
    }

    /** A stop the runner has not answered yet reads Cancelling, not a stopped job (J-T8/M-T10). */
    @Test fun anAnsweredStopRequestSaysCancelling() {
        val timeline = """{"sections":[{"title":"Generation 1","jobId":"j-1","kind":"LAND_TASK","generation":1,"state":"RUNNING",
            "entries":[{"kind":"STOP_REQUESTED","at":"${iso(5)}","claim":1,"text":"Stop requested"}]}],"facts":[]}"""
        assertEquals(LandingSessionCopy.CANCELLING, card(view(timeline = timeline))!!.state)
        assertFalse(LandingSessionModel.gates(view(timeline = timeline), now, now, false).stop)
    }

    @Test fun aFinishedAttemptSaysWhatStoppedIt() {
        val failed = view(state = "CHECK_FAILED", check = null, phase = "CHECK",
            checks = """[{"name":"TASK_ACCEPTANCE","command":"npm test","expectedExitCode":0,"exitCode":1,"timedOut":false,"durationMs":232000}]""")
        val card = card(failed)!!
        assertEquals("checks failed · exit 1 after 3m 52s", card.state)
        assertEquals("Not landed", card.right)
        assertEquals("Task acceptance exited 1 (expected 0) on the combined tree · nothing was pushed", card.failure)
        assertFalse(card.running)
        val merge = view(kind = "CHECK_PROMOTION", taskId = null, promotionId = "p-1", state = "ERROR", check = null)
        assertEquals("Not merged", card(merge)!!.right)
        assertEquals("Stopped with an error", card(merge)!!.state)
        val ready = view(state = "READY", check = null)
        assertEquals("Ready", card(ready)!!.state)
        assertEquals("Passed the check · waiting for the owner", card(ready)!!.detail)
    }

    /** The takeover: claim 2 of the same section, and the section's first claim is where `first started` comes from. */
    @Test fun aTakeoverSaysClaimTwoAndKeepsTheFirstStart() {
        val timeline = """{"sections":[{"title":"Generation 1","jobId":"j-1","kind":"LAND_TASK","generation":1,"state":"RUNNING",
            "entries":[{"kind":"CLAIMED","at":"2026-10-20T17:03:00Z","claim":1,"text":"Claimed"},
                       {"kind":"TAKEN_OVER","at":"2026-10-20T17:31:00Z","claim":2,"text":"Taken over"}]}],"facts":[]}"""
        val takenOver = view(claim = 2, step = 290L, heartbeat = 0L, timeline = timeline)
        assertEquals("2026-10-20T17:03:00Z", LandingSessionModel.firstStartedAt(takenOver, "j-1"))
        assertEquals("checking · output 6s ago · claim 2 · round 1 of 3 · Taken over 17:31 · first started 17:03 · updated just now",
            card(takenOver)!!.detail)
        // A claim that never reported its first start still says the takeover, without inventing one.
        assertEquals("checking · output 6s ago · claim 2 · round 1 of 3 · Taken over 17:31 · updated just now",
            card(view(claim = 2, step = 290L, heartbeat = 0L))!!.detail)
    }

    // MARK: reading this device could not make

    @Test fun aFailedReadFreezesTheCardAtUpdateUnavailableAndOpensNothing() {
        val landing = view(retryable = true, timedOut = true)
        val unavailable = card(landing, failed = true)!!
        assertEquals("Update unavailable", unavailable.state)
        assertEquals("Update unavailable", unavailable.detail)
        assertEquals("1m 50s", unavailable.right)
        assertEquals("Task acceptance 1m 50s of 60m", unavailable.budget)
        assertEquals("Updated 0m ago", unavailable.live)
        assertFalse(unavailable.fresh)
        assertFalse(unavailable.running)
        assertFalse(unavailable.timedOut)
        val gates = LandingSessionModel.gates(landing, now, now, failed = true)
        assertEquals(LandingGates(), gates)
        // The ways to look are not doors: the failed read keeps them, and opens none of the five (LS6).
        assertEquals(listOf("task", "source", "coordinator"), LandingSessionModel.menuItems(landing, gates, true, true, true).map { it.key })
        // The same rule for a read 90 s old: the device has lost the server even though the last answer said nothing was wrong.
        val stale = LandingSessionModel.gates(landing, now, now.minusSeconds(91), failed = false)
        assertEquals(LandingGates(), stale)
        assertFalse(LandingSessionModel.readUnavailable(now, now.minusSeconds(90), false))
        assertTrue(LandingSessionModel.readUnavailable(now, now.minusSeconds(91), false))
    }

    // MARK: the timeline

    @Test fun theTimelineDecodesSectionsAndTheirSectionsState() {
        val timeline = """{"sections":[
            {"title":"Merge check · 1","jobId":"j-check","kind":"CHECK_PROMOTION","generation":1,"state":"CHECK_FAILED",
             "entries":[{"kind":"CHECK_STARTED","at":"${iso(900)}","claim":1,"round":1,"check":{"name":"MERGE_CHECK","index":1},"text":"Merge check started"},
                        {"kind":"CHECK_FINISHED","at":"${iso(600)}","claim":1,"round":1,"check":{"name":"MERGE_CHECK","index":1},
                         "data":{"name":"MERGE_CHECK","index":1,"exitCode":1,"expectedExitCode":0,"timedOut":false,"durationMs":232000},
                         "text":"Merge check failed · exit 1"}]},
            {"title":"Merge to main · 1","jobId":"j-merge","kind":"LAND_PROMOTION","generation":1,"state":"MERGED",
             "entries":[{"kind":"RESULT","at":"${iso(300)}","claim":1,"data":{"state":"LANDED"},"text":"Landed on main · 8ed0ea7"},
                        {"kind":"RESULT","at":"${iso(200)}","claim":1,"data":"LANDED","text":"Landed on main · 8ed0ea7"}]}],
            "facts":[{"kind":"FIX_TASK","text":"Filed fix-1"}],"truncated":true}"""
        val sections = LandingSessionModel.read(landingJson(timeline = timeline)).timeline!!
        assertEquals(listOf("Merge check · 1", "Merge to main · 1"), sections.sections.map { it.title })
        assertEquals(2, sections.sections[0].entries.size)
        assertEquals(1, sections.sections[0].entries[1].checkIndex)
        assertEquals("Merge check failed · exit 1", sections.sections[0].entries[1].text)
        // A line's `data` is the fields its sentence was written from; a value that is not an object reads as none.
        assertNull(sections.sections[0].entries[0].data)
        assertEquals(1, sections.sections[0].entries[1].data?.number("exitCode"))
        assertFalse(LandingSessionModel.checkPassed(sections.sections[0].entries[1]))
        assertEquals("LANDED", sections.sections[1].entries[0].data?.text("state"))
        assertTrue(LandingSessionModel.entryOk(sections.sections[1].entries[0]))
        assertNull(sections.sections[1].entries[1].data)
        assertFalse(LandingSessionModel.entryOk(sections.sections[1].entries[1]))
        assertEquals("Filed fix-1", sections.facts.single().text)
        assertTrue(sections.truncated)
        assertEquals("not landed · CHECK_FAILED", LandingSessionModel.sectionState("CHECK_FAILED"))
        assertEquals("stopped · ERROR", LandingSessionModel.sectionState("ERROR"))
        assertEquals("stopped", LandingSessionModel.sectionState("CANCELLED"))
        assertNull(LandingSessionModel.sectionState("MERGED"))
    }

    @Test fun aTimedOutSectionEndsWithTheReportThatNeverCame() {
        val report = LandingSessionModel.noReportBand(view(timedOut = true, heartbeat = 1380L), ZoneOffset.UTC)
        assertEquals("No report from wikova since 17:13", report)
        assertNull(LandingSessionModel.noReportBand(view()))
    }

    // The timeline's ✓ reads the line's fields, never its sentence (the web's `landingCheckPassed` / `landingEntryOk`).

    private fun line(kind: String, text: String, data: String?) =
        LandingEntry(kind, iso(60), 1, 1, null, null, null, null, text, data?.let { json(it) })
    private fun finished(data: String?, text: String = "Merge check passed · 17m 02s") = line("CHECK_FINISHED", text, data)
    private fun result(state: String?, text: String, kind: String = "RESULT") =
        line(kind, text, state?.let { """{"state":"$it"}""" })

    @Test fun aCheckPassedWhenItExitedWithTheCodeItExpectedAndDidNotTimeOut() {
        assertTrue(LandingSessionModel.checkPassed(finished("""{"exitCode":0,"expectedExitCode":0,"timedOut":false}""")))
        assertTrue(LandingSessionModel.checkPassed(finished("""{"exitCode":3,"expectedExitCode":3,"timedOut":false}""")))
        assertFalse(LandingSessionModel.checkPassed(finished("""{"exitCode":1,"expectedExitCode":0,"timedOut":false}""")))
        assertFalse(LandingSessionModel.checkPassed(finished("""{"exitCode":0,"expectedExitCode":0,"timedOut":true}""")))
        // No exit code is not a pass, and neither is a line with no fields at all.
        assertFalse(LandingSessionModel.checkPassed(finished("""{"exitCode":null,"expectedExitCode":0,"timedOut":false}""")))
        assertFalse(LandingSessionModel.checkPassed(finished(null)))
        assertFalse(LandingSessionModel.checkPassed(finished("{}")))
    }

    @Test fun theWordingChangedTheCheckmarkDidNot() {
        val green = finished("""{"exitCode":0,"expectedExitCode":0,"timedOut":false}""", "Merge check green · 17m 02s")
        assertTrue(LandingSessionModel.checkPassed(green))
        assertTrue(LandingSessionModel.entryOk(green))
        val saysPassed = finished("""{"exitCode":1,"expectedExitCode":0,"timedOut":false}""", "Merge check passed · 3m 52s")
        assertFalse(LandingSessionModel.checkPassed(saysPassed))
        assertFalse(LandingSessionModel.entryOk(saysPassed))
        assertTrue(LandingSessionModel.entryOk(result("LANDED", "Put on main · 8ed0ea7")))
        assertTrue(LandingSessionModel.entryOk(result("ALREADY_LANDED", "Was on main · 8ed0ea7")))
        assertTrue(LandingSessionModel.entryOk(result("NOTHING_TO_LAND", "No commits to push")))
        assertTrue(LandingSessionModel.entryOk(result("NOTHING_TO_LAND", "Nothing to push · the branch carried no commits", "RESULT_FALLBACK")))
    }

    @Test fun everyOtherResultIsACrossWhateverABranchNameInItSays() {
        assertFalse(LandingSessionModel.entryOk(result("READY", "Ready to merge into fix/passed-x")))
        assertFalse(LandingSessionModel.entryOk(result("CONFLICT", "Could not sync main into fix/passed-x · merge conflict")))
        assertFalse(LandingSessionModel.entryOk(result("CHECK_FAILED", "Check failed · nothing was pushed")))
        assertFalse(LandingSessionModel.entryOk(result("ERROR", "Stopped with an error · PUSH_FAILED")))
        assertFalse(LandingSessionModel.entryOk(result("CANCELLED", "Stopped · not landed")))
        assertFalse(LandingSessionModel.entryOk(result("SUPERSEDED", "Superseded · a newer attempt asks the same question")))
        assertFalse(LandingSessionModel.entryOk(result(null, "Landed on main · 8ed0ea7")))
        assertFalse(LandingSessionModel.entryOk(result(null, "Landed on main · 8ed0ea7", "RESULT_FALLBACK")))
    }

    @Test fun noOtherKindOfLineIsACheckOrAResult() {
        assertFalse(LandingSessionModel.checkPassed(line("RESULT", "Merge check passed", """{"exitCode":0,"expectedExitCode":0,"timedOut":false}""")))
        assertFalse(LandingSessionModel.entryOk(line("CLAIMED", "Landed on main", """{"state":"LANDED"}""")))
    }

    // MARK: the doors and the menu

    private fun items(landing: LandingView, hasCoordinator: Boolean = true, hasReview: Boolean = true, nothingPushed: Boolean = false,
        failed: Boolean = false, updatedAt: Instant? = now) =
        LandingSessionModel.menuItems(landing, LandingSessionModel.gates(landing, now, updatedAt, failed), hasCoordinator, hasReview, nothingPushed)

    @Test fun aTaskLandingsMenuLooksAtTheWorkAndOffersTheStopBeforeThePush() {
        val landing = view()
        val menu = items(landing)
        assertEquals(listOf("task", "source", "coordinator", "stop"), menu.map { it.key })
        assertEquals("Open task", menu[0].label)
        assertEquals("Open source session", menu[1].label)
        assertEquals("Stop landing", menu[3].label)
        assertEquals("Before the push only · nothing pushed yet", menu[3].sub)
        assertTrue(menu[3].danger)
        // Past the push boundary the stop is gone (J-T4): the server computed it, the client only reads it.
        assertEquals(listOf("task", "source", "coordinator"), items(view(pastPush = true)).map { it.key })
        assertFalse(LandingSessionModel.gates(view(pastPush = true), now, now, false).stop)
    }

    @Test fun aMergeRoundsMenuHasNoTaskAndNoStopLanding() {
        val round = view(subject = "PROMOTION", taskId = null, promotionId = "p-1", kind = "LAND_PROMOTION", state = "RUNNING",
            claim = 1, pastPush = false, phase = "PUSH")
        val menu = items(round)
        assertEquals(listOf("coordinator", "review", "cancel"), menu.map { it.key })
        assertEquals("Cancel merge", menu[2].label)
        assertEquals("Review card", menu[1].label)
        assertFalse(menu.any { it.label == "Stop landing" })
    }

    @Test fun aMergeCheckTimesOutToReRunTheCheckAndAbandon() {
        val check = view(subject = "PROMOTION", taskId = null, promotionId = "p-1", kind = "CHECK_PROMOTION",
            timedOut = true, liveness = "LEASE_EXPIRED", check = checkJson(name = "MERGE_CHECK"))
        assertNull("a check never pushes: no J12 sentence", LandingSessionModel.pushSentence(check, check.currentAttempt!!))
        val gates = LandingSessionModel.gates(check, now, now, false)
        assertTrue(gates.recheck)
        assertTrue(gates.abandon)
        assertFalse(gates.retry)
        assertFalse(gates.cancel)
        assertEquals(listOf("coordinator", "review", "abandon", "recheck"), items(check, nothingPushed = true).map { it.key })
        assertEquals("Ends this attempt · nothing was pushed", items(check, nothingPushed = true)[2].sub)
    }

    @Test fun aTimedOutTaskOffersTheServersRetryAndAbandon() {
        val timedOut = view(timedOut = true, liveness = "LEASE_EXPIRED", retryable = true)
        val menu = items(timedOut, nothingPushed = true)
        assertEquals(listOf("task", "source", "coordinator", "abandon", "retry"), menu.map { it.key })
        assertEquals("Abandon", menu[3].label)
        assertEquals("Ends this attempt · nothing was pushed", menu[3].sub)
        assertEquals("Retry", menu[4].label)
        assertFalse("a timed-out attempt's stop is gone", menu.any { it.key == "stop" })
        // A legacy claim, or one that named a push: the server's Retry stays, the sentence cannot promise it never pushed.
        assertEquals("Ends this attempt · it may have been pushed", items(timedOut, nothingPushed = false)[3].sub)
    }

    @Test fun aTimedOutConfirmedMergeHasAbandonOnly() {
        val merge = view(subject = "PROMOTION", taskId = null, promotionId = "p-1", kind = "LAND_PROMOTION", timedOut = true,
            liveness = "LEASE_EXPIRED", phase = "PUSH", retryable = false)
        val menu = items(merge, nothingPushed = false)
        assertEquals(listOf("coordinator", "review", "abandon"), menu.map { it.key })
        assertFalse(menu.any { it.key == "retry" || it.key == "recheck" || it.key == "cancel" })
    }

    @Test fun theMenuNeverCarriesCopyLinkOrAnInventedRow() {
        val all = listOf(view(), view(pastPush = true), view(timedOut = true, liveness = "LEASE_EXPIRED", retryable = true),
            view(subject = "PROMOTION", taskId = null, promotionId = "p-1", kind = "LAND_PROMOTION", pastPush = false),
            view(subject = "PROMOTION", taskId = null, promotionId = "p-1", kind = "CHECK_PROMOTION", timedOut = true, liveness = "LEASE_EXPIRED"))
            .flatMap { items(it, hasCoordinator = true, hasReview = true) }
        assertFalse(all.any { it.label.contains("Copy Link") || it.key == "copy" })
        assertEquals(setOf("task", "source", "coordinator", "review", "stop", "cancel", "abandon", "retry", "recheck"), all.map { it.key }.toSet())
    }

    @Test fun aSettledSubjectsMenuHasNoDoor() {
        val settled = view(state = "MERGED", timedOut = true, liveness = "LEASE_EXPIRED", retryable = true,
            settledAt = "2026-10-20T17:31:00Z", settledAs = "LANDED")
        assertEquals(LandingGates(), LandingSessionModel.gates(settled, now, now, false))
        // The ways to look at the work remain; no door does.
        assertEquals(listOf("task", "source", "coordinator"), items(settled).map { it.key })
    }

    @Test fun noCoordinatorOrReviewReadLeavesTheWayOutUnnamed() {
        assertEquals(listOf("task", "source", "stop"), items(view(), hasCoordinator = false, hasReview = false).map { it.key })
        val round = view(subject = "PROMOTION", taskId = null, promotionId = "p-1", kind = "CHECK_PROMOTION")
        assertEquals(listOf<String>(), items(round, hasCoordinator = false, hasReview = false).map { it.key })
    }

    // MARK: J12's push sentence and the timeout line

    @Test fun thePushSentenceFollowsTheClaimProtocolAndWhatItReported() {
        val v2 = view(timedOut = true, protocol = "v2")
        assertEquals(LandingSessionCopy.NOTHING_PUSHED_SENTENCE, LandingSessionModel.pushSentence(v2, v2.currentAttempt!!, ZoneOffset.UTC))
        // A v2 claim that never reported a push cannot have pushed; one line naming the push drops that promise.
        val reported = """{"sections":[{"title":"Generation 1","jobId":"j-1","kind":"LAND_TASK","generation":1,"state":"RUNNING",
            "entries":[{"kind":"STEP","at":"${iso(60)}","claim":1,"phase":"PUSH","text":"Pushing"}]}],"facts":[]}"""
        val named = view(timedOut = true, timeline = reported)
        // A report that named the push says when: the runner's own word at 17:35 (the clock the fixture's `now` makes it).
        assertEquals("May have been pushed — it reported starting the push at 17:35, then went silent.",
            LandingSessionModel.pushSentence(named, named.currentAttempt!!, ZoneOffset.UTC))
        val legacy = view(timedOut = true, protocol = "legacy")
        assertEquals(LandingSessionCopy.MAY_HAVE_PUSHED_SENTENCE, LandingSessionModel.pushSentence(legacy, legacy.currentAttempt!!, ZoneOffset.UTC))
        val at = """{"sections":[{"title":"Generation 1","jobId":"j-1","kind":"LAND_TASK","generation":1,"state":"RUNNING",
            "entries":[{"kind":"STEP","at":"2026-10-20T15:42:00Z","claim":1,"phase":"PUSH","text":"Pushing"}]}],"facts":[]}"""
        val reportedAt = view(timedOut = true, timeline = at, protocol = "legacy")
        assertEquals("May have been pushed — it reported starting the push at 15:42, then went silent.",
            LandingSessionModel.pushSentence(reportedAt, reportedAt.currentAttempt!!, ZoneOffset.UTC))
    }

    @Test fun theTimeoutLineNamesTheRunnerTheClaimAndTheRound() {
        val attempt = view(timedOut = true, step = 1380L, heartbeat = 1380L, claim = 1, round = 1).currentAttempt!!
        assertEquals("Runner wikova took it at 17:13 · stopped at checking · claim 1 · round 1 of 3",
            LandingSessionModel.timeoutLine(attempt, zone = ZoneOffset.UTC))
        // The M is the kind's, not the check's: one check still reads "of 3", and a merge into main names none.
        val one = view(timedOut = true, step = 1380L, heartbeat = 1380L, check = checkJson(step = 1380L, count = 1)).currentAttempt!!
        assertTrue(LandingSessionModel.timeoutLine(one, zone = ZoneOffset.UTC).endsWith(" · claim 1 · round 1 of 3"))
        val merge = view(subject = "PROMOTION", taskId = null, promotionId = "p-1", kind = "LAND_PROMOTION", timedOut = true,
            step = 1380L, heartbeat = 1380L, phase = "PUSH").currentAttempt!!
        assertEquals("Runner wikova took it at 17:13 · stopped at pushing · claim 1 · round 1",
            LandingSessionModel.timeoutLine(merge, zone = ZoneOffset.UTC))
        val unnamed = view(timedOut = true, runner = "").currentAttempt!!
        assertTrue(LandingSessionModel.timeoutLine(unnamed, zone = ZoneOffset.UTC).startsWith("The runner took it at"))
    }

    // MARK: the outcome and the footer

    @Test fun aSettledTaskSegmentDrawsItsOutcome() {
        val landed = view(settledAt = "2026-10-20T17:31:00Z", settledAs = "LANDED", state = "RUNNING",
            checks = """[{"name":"TASK_ACCEPTANCE","expectedExitCode":0,"exitCode":0,"timedOut":false,"durationMs":1061000}]""")
        val outcome = LandingSessionModel.outcomeCard(landed, null, ZoneOffset.UTC)!!
        assertEquals("Landed", outcome.title)
        assertEquals("17:31", outcome.right)
        assertEquals("Landed on project/launch", outcome.detail)
        assertEquals("✓ Passed on the combined tree · 17m 41s", outcome.checkLine)
        assertTrue(outcome.ok)
        assertEquals("Nothing to land", LandingSessionModel.outcomeCard(view(settledAt = "2026-10-20T17:31:00Z", settledAs = "NOTHING_TO_LAND"), null)!!.title)
        assertEquals("Cancelled", LandingSessionModel.outcomeCard(view(settledAt = "2026-10-20T17:31:00Z", settledAs = "CANCELLED"), null)!!.title)
        assertNull(LandingSessionModel.outcomeCard(view(), null))
    }

    /** MERGED reads the receipt beside the landing: the commit, the tasks now on main, and the tested tree. */
    @Test fun aMergedRoundDrawsItsReceipt() {
        val merged = view(subject = "PROMOTION", taskId = null, promotionId = "p-1", kind = "LAND_PROMOTION", settledAt = "2026-10-20T17:31:00Z",
            settledAs = "MERGED", checks = """[{"name":"MERGE_CHECK","expectedExitCode":0,"exitCode":0,"timedOut":false,"durationMs":1061000}]""")
        val promotion = json("""{"promotionId":"p-1","upstreamRef":"refs/heads/main","landsTreeSha":"5e5bfca1234","landsAs":"MERGE_COMMIT",
            "taskIds":["t1","t2"],"tasks":[{"taskId":"t1","title":"Fix D1"},{"taskId":"t2","title":"Logs"}],
            "merged":{"sha":"8ed0ea712345","at":"2026-10-20T17:30:00Z","automatic":true}}""")
        val outcome = LandingSessionModel.outcomeCard(merged, promotion, ZoneOffset.UTC)!!
        assertEquals("Merged into main", outcome.title)
        assertEquals("17:30", outcome.right)
        assertEquals("8ed0ea7 · 2 tasks · automatically", outcome.detail)
        assertEquals("Now on main · 2 tasks", outcome.tasksHeading)
        assertEquals(listOf("Fix D1", "Logs"), outcome.tasks)
        assertEquals("Landed exactly the tested tree 5e5bfca · as a merge commit", outcome.treeLine)
        assertTrue(outcome.ok)
    }

    @Test fun theFooterNamesTheWayOutThatMatters() {
        val task = LandingSessionModel.footer(view(), null)
        assertEquals("Orbit runs this landing — nothing to type here.", task.line)
        assertEquals("Decisions: the coordinator", task.detail)
        assertEquals(LandingFooterLink.COORDINATOR, task.link)
        val round = LandingSessionModel.footer(view(subject = "PROMOTION", taskId = null, promotionId = "p-1"), "MERGE")
        assertEquals("A clean pass merges on its own", round.detail)
        assertEquals(LandingFooterLink.REVIEW_CARD, round.link)
        assertEquals("Merging is decided on the merge card", LandingSessionModel.footer(view(subject = "PROMOTION", taskId = null), "ASK").detail)
        val settled = LandingSessionModel.footer(view(subject = "PROMOTION", taskId = null, settledAt = "2026-10-20T17:31:00Z", settledAs = "MERGED"), null)
        assertEquals("This landing is complete — nothing to type here.", settled.line)
        assertEquals("The next merge into main opens a new landing (#5).", settled.next)
        assertNull(settled.link)
    }

    // MARK: §2.7a's cadence

    @Test fun thePagePollsRunningEveryFourSecondsQueuedEveryFifteenAndStopsWhenSettled() {
        assertEquals(4_000L, LandingSessionModel.nextReadMs(view()))
        assertEquals(4_000L, LandingSessionModel.nextReadMs(view(timedOut = true)))
        assertEquals(15_000L, LandingSessionModel.nextReadMs(view(state = "QUEUED", check = null)))
        assertEquals(15_000L, LandingSessionModel.nextReadMs(view(state = "CHECK_FAILED", check = null)))
        assertNull(LandingSessionModel.nextReadMs(view(settledAt = "2026-10-20T17:31:00Z", settledAs = "LANDED")))
        assertEquals("nothing read yet: ask again, but not every four seconds", 15_000L, LandingSessionModel.nextReadMs(null))
    }
}
