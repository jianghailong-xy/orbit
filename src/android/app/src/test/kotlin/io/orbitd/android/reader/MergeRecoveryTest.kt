package io.orbitd.android.reader

import io.orbitd.android.core.protocol.Wire
import io.orbitd.android.reader.MergeRecovery.Button
import io.orbitd.android.reader.MergeRecovery.RepairState
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
import java.time.Instant
import java.time.ZoneOffset
import java.util.Locale

/**
 * The merge recovery's repair loop (project 34hIv3wbdtsxpc5RzDlOk, docs/mocks/merge-recovery-repair-loop-ios.html): the repair
 * row's six states and the step each asks for, the check in flight, a repair left unfinished, a session already on origin
 * (board ⑥, Done), board ④'s footnote — and the review as it was without a repair session or on an older server.
 */
class MergeRecoveryTest {
    private val now = Instant.parse("2026-10-11T11:30:00Z")
    private fun sha(c: Char) = c.toString().repeat(40)
    private fun json(text: String) = Wire.json.parseToJsonElement(text).jsonObject

    /** A recovery as the server stores it, with [fields] over a checked CONFLICT in SOURCE_REPLAY on a fresh repair branch. */
    private fun recovery(vararg fields: Pair<String, JsonElement>): MergeRecovery = MergeRecovery.of(JsonObject(json("""{
        "code":"CONFLICT","targetBranch":"main","previewId":"5971aa","sourceSha":"${sha('a')}","localSha":"${sha('b')}","remoteSha":"${sha('c')}",
        "repairBranch":"orbit/recovery/5971aa","repairWorktree":"/root/.orbit/worktrees/recovery-5971aa","phase":"SOURCE_REPLAY",
        "conflicts":["src/macos/OrbitApp/Sources/OrbitApp/AgentsModel.swift"],"checkedAt":"2026-10-11T11:29:40Z","patch":""}""") + fields))!!
    private val ready = arrayOf("code" to JsonPrimitive("READY"), "candidateSha" to JsonPrimitive(sha('d')),
        "candidateTreeSha" to JsonPrimitive(sha('e')), "conflicts" to JsonArray(emptyList()), "check" to json("""{"status":"unconfigured"}"""))
    private val unfinished = arrayOf("code" to JsonPrimitive("REPAIR_IN_PROGRESS"), "previewId" to JsonPrimitive("77b0c1"),
        "conflicts" to JsonArray(listOf(JsonPrimitive("src/macos/OrbitKit/Tests/OrbitKitTests/SessionListSwitchWiringTests.swift"))))

    private fun repair(runState: String, vararg fields: Pair<String, JsonElement>) = MergeRecovery.repair(JsonObject(mapOf("mergeRepairSession" to
        JsonObject(json("""{"id":"34e2K7Cj2YG2CbwFip9QH","title":"Resolve merge recovery for main","runState":"$runState",
            "lastTurnAt":"2026-10-11T11:28:00Z","finishedAt":null,"lastAssistantText":null,"error":null}""") + fields))))!!
    private fun row(r: MergeRecovery, repair: MergeRecovery.Repair, checking: Boolean = false) = r.repairRow(repair, loop = true, checking = checking, now = now)
    private fun primary(r: MergeRecovery, state: RepairState?) = r.buttons(supported = true, repair = state).primary

    // ── The repair row's six states, and the step each asks for ──

    /** ①: the repair is at work. A check now could only find it unfinished, so the one step opens it; no Check again under the title. */
    @Test fun aRunningRepairIsOpenedAndCheckedWhenItStops() {
        val r = recovery()
        for (state in listOf("RUNNING", "QUEUED")) assertEquals(MergeRecovery.RepairRow(RepairState.RUNNING, "Repair session running",
            "Tap to open the running session"), row(r, repair(state)))
        assertEquals(MergeRecovery.Buttons(Button("Open repair session", "open"), emptyList(), null, "Orbit checks again when the repair stops."),
            r.buttons(supported = true, repair = RepairState.RUNNING))
    }

    /** ②: the repair stopped and the server checks it — a preview in flight, or one owed until this session's turn ends. */
    @Test fun aStoppedRepairIsCheckingUntilTheServersCheckAnswers() {
        val r = recovery()
        for (state in listOf("AWAITING_INPUT", "INTERRUPTED", "SUCCEEDED", "ENDED"))
            assertEquals(MergeRecovery.RepairRow(RepairState.CHECKING, "Repair session finished", "Checking its result…"), row(r, repair(state), checking = true))
        assertEquals(MergeRecovery.Buttons(Button("Checking…", "wait"), emptyList(), null), r.buttons(supported = true, repair = RepairState.CHECKING))
    }

    @Test fun checkingIsAPreviewInFlightOrACheckOwedUntilTheTurnEnds() {
        assertTrue(MergeRecovery.checking(json("""{"mergeStatus":"pending","mergeRecoveryAction":"preview","mergeRepairTurnEndedAt":null}""")))
        assertTrue("owed while this session runs a turn of its own",
            MergeRecovery.checking(json("""{"mergeStatus":"conflict","mergeRecoveryAction":"preview","mergeRepairTurnEndedAt":"2026-10-11T11:28:00.120Z"}""")))
        assertFalse("pushing a reviewed candidate is not a check",
            MergeRecovery.checking(json("""{"mergeStatus":"pending","mergeRecoveryAction":"apply","mergeRepairTurnEndedAt":null}""")))
        assertFalse(MergeRecovery.checking(json("""{"mergeStatus":"error","mergeRecoveryAction":"preview","mergeRepairTurnEndedAt":null}""")))
        assertFalse(MergeRecovery.checking(json("""{"mergeStatus":"pending"}""")))
    }

    /** ③: the check after the repair passed — its result is the candidate to review, and the push is the owner's one step. */
    @Test fun aRepairThatLeftAReadyCandidateIsReviewedAndPushed() {
        val r = recovery(*ready)
        assertTrue(r.ready)
        assertEquals(MergeRecovery.RepairRow(RepairState.READY, "Repair session finished", "Checked just now — ready to merge"), row(r, repair("AWAITING_INPUT")))
        assertEquals(MergeRecovery.Buttons(Button("Sync main and merge", "apply"), listOf(Button("Prepare PR candidate", "repair", preparePR = true)),
            Button("Check again", "preview")), r.buttons(supported = true, repair = RepairState.READY))
        assertEquals("Review synchronization into main", r.title)
    }

    /** ④: conflicts are left — the same repair session carries on with them. */
    @Test fun conflictsLeftAreHandedBackToTheSameRepair() {
        val r = recovery()
        assertEquals(MergeRecovery.RepairRow(RepairState.CONFLICTS, "Repair session finished", "Checked just now — 1 conflict left"), row(r, repair("AWAITING_INPUT")))
        assertEquals("Checked just now — 2 conflicts left", row(recovery("conflicts" to JsonArray(listOf(JsonPrimitive("a.swift"), JsonPrimitive("b.swift")))),
            repair("SUCCEEDED")).line)
        assertEquals("Checked 4m ago — 1 conflict left", row(recovery("checkedAt" to JsonPrimitive("2026-10-11T11:26:00Z")),
            repair("AWAITING_INPUT", "lastTurnAt" to JsonPrimitive("2026-10-11T11:25:30.120Z"))).line)
        assertEquals(MergeRecovery.Buttons(Button("Continue repair", "repair", preparePR = false), listOf(Button("Prepare PR candidate", "repair", preparePR = true)),
            Button("Check again", "preview")), r.buttons(supported = true, repair = RepairState.CONFLICTS))
        assertEquals("Conflicts", r.conflictsHeading)
        assertEquals("Your changes conflict with the synchronized target", r.title)
    }

    /** ⑤: the check found the repair unfinished, and the repair stopped to ask — its question, and the step is to answer it. */
    @Test fun anUnfinishedRepairWaitsForTheOwnersReply() {
        val r = recovery(*unfinished)
        assertEquals(MergeRecovery.RepairRow(RepairState.NEEDS_REPLY, "Repair session needs your reply", "“Keep the target's version?” · 2m ago"),
            row(r, repair("AWAITING_INPUT", "lastAssistantText" to JsonPrimitive("Keep the target's version?"))))
        assertEquals("a long reply reads as one line", "“Both sides changed the closure. Keep the target's version?” · 2m ago",
            row(r, repair("INTERRUPTED", "lastAssistantText" to JsonPrimitive("Both sides changed the closure.\n\n  Keep the target's version?"))).line)
        assertNull("nothing it said, no line", row(r, repair("AWAITING_INPUT")).line)
        assertEquals(MergeRecovery.Buttons(Button("Reply in repair session", "repair", preparePR = false), emptyList(), Button("Check again", "preview")),
            r.buttons(supported = true, repair = RepairState.NEEDS_REPLY))
        assertEquals("The repair isn’t finished", r.title)
        assertEquals("Some files in the repair worktree are still unresolved.", r.lede())
        assertEquals("Still unresolved", r.conflictsHeading)
    }

    /** The sixth: the repair session failed — its error. S2 opens a new repair session for a failed one, so its step is Resolve, never Continue. */
    @Test fun aFailedRepairSaysWhyAndANewRepairSessionResolvesIt() {
        val r = recovery()
        val failed = repair("FAILED", "error" to JsonPrimitive("The model provider rejected the request"))
        assertEquals(MergeRecovery.RepairRow(RepairState.FAILED, "Repair session failed", "The model provider rejected the request"), row(r, failed))
        assertEquals("a failure outranks the check its turn queued", RepairState.FAILED, row(r, failed, checking = true).state)
        assertNull(row(r, repair("FAILED")).line)
        val resolve = Button("Resolve in repair session", "repair", preparePR = false)
        val preparePR = Button("Prepare PR candidate", "repair", preparePR = true)
        assertEquals(MergeRecovery.Buttons(resolve, listOf(preparePR), Button("Check again", "preview")), r.buttons(supported = true, repair = row(r, failed).state))
        assertEquals("a repair left unfinished by a failed session: no PR candidate there, as on board ⑤",
            MergeRecovery.Buttons(resolve, emptyList(), Button("Check again", "preview")), recovery(*unfinished).buttons(supported = true, repair = RepairState.FAILED))
        // Only a session S2 carries on is continued.
        for (state in listOf("AWAITING_INPUT", "SUCCEEDED", "ENDED", "INTERRUPTED"))
            assertEquals(state, Button("Continue repair", "repair", preparePR = false), primary(r, row(r, repair(state)).state))
        assertEquals(Button("Checking…", "wait"), primary(r, RepairState.CHECKING))
    }

    /** The session detail the review reads: a recovery-capable runner, a server that checks each repair turn, and a repair session. */
    private fun detail(runState: String, vararg fields: Pair<String, JsonElement>) = JsonObject(mapOf(
        "mergeRecoverySupported" to JsonPrimitive(true), "mergeStatus" to JsonPrimitive("conflict"), "mergeRecoveryAction" to JsonPrimitive("preview"),
        "mergeRepairTurnEndedAt" to JsonNull, "mergeRepairSession" to json("""{"id":"34e2K7Cj2YG2CbwFip9QH","title":"Resolve merge recovery for main",
            "runState":"$runState","lastTurnAt":"2026-10-11T11:28:00Z","finishedAt":null,"lastAssistantText":null,
            "error":"The model provider rejected the request"}""")) + fields)

    /**
     * A failed repair's turn ends too, so it queues a check: while that check runs (or is owed), the row keeps saying the repair
     * failed, and the page waits for the check as for any other — "Checking the repair…", the snapshot faded, a disabled
     * "Checking…" the one step (web's panel, C2) — for conflicts and for a repair left unfinished alike.
     */
    @Test fun aFailedRepairsCheckIsWaitedForWhileItsRowStaysFailed() {
        val failed = MergeRecovery.RepairRow(RepairState.FAILED, "Repair session failed", "The model provider rejected the request")
        val waiting = MergeRecovery.Buttons(Button("Checking…", "wait"), emptyList(), null)
        for (r in listOf(recovery(), recovery(*unfinished)))
            for (check in listOf("mergeStatus" to JsonPrimitive("pending"), "mergeRepairTurnEndedAt" to JsonPrimitive("2026-10-11T11:28:00.120Z")))
                assertEquals("${r.code}, ${check.first}", MergeRecovery.Review(failed, checking = true, buttons = waiting), r.review(detail("FAILED", check), now))
        // Once the check has answered, the failed repair's own step is back.
        assertEquals(MergeRecovery.Review(failed, false, MergeRecovery.Buttons(Button("Resolve in repair session", "repair", preparePR = false),
            listOf(Button("Prepare PR candidate", "repair", preparePR = true)), Button("Check again", "preview"))), recovery().review(detail("FAILED"), now))
        assertEquals(MergeRecovery.Review(MergeRecovery.RepairRow(RepairState.CHECKING, "Repair session finished", "Checking its result…"), true, waiting),
            recovery().review(detail("AWAITING_INPUT", "mergeStatus" to JsonPrimitive("pending")), now))
        // A repair turn running again outranks a check still in flight from its last one, as on web: the step is to open it.
        assertEquals(MergeRecovery.Review(MergeRecovery.RepairRow(RepairState.RUNNING, "Repair session running", "Tap to open the running session"), false,
            MergeRecovery.Buttons(Button("Open repair session", "open"), emptyList(), null, "Orbit checks again when the repair stops.")),
            recovery().review(detail("RUNNING", "mergeStatus" to JsonPrimitive("pending")), now))
        // Already on origin there is no repair row and no repair check to wait for; Done stays, held back by the bar's gate meanwhile.
        assertEquals(MergeRecovery.Review(null, false, MergeRecovery.Buttons(Button("Done", "confirm-landed"), emptyList(), null)),
            recovery(*landedOnOrigin).review(detail("FAILED", "mergeStatus" to JsonPrimitive("pending")), now))
        assertFalse("an older server's review waits as it always did", recovery().review(
            JsonObject(detail("FAILED", "mergeStatus" to JsonPrimitive("pending")) - "mergeRepairTurnEndedAt"), now).checking)
    }

    /** A check that found none of the board's verdicts after the repair: the row says only when it checked; the page says the rest. */
    @Test fun anotherVerdictAfterTheRepairIsTheChecksTimeAlone() {
        val r = recovery("code" to JsonPrimitive("TARGET_DIVERGED"))
        assertEquals(MergeRecovery.RepairRow(RepairState.FINISHED, "Repair session finished", "Checked just now"), row(r, repair("AWAITING_INPUT")))
        assertEquals(Button("Check again", "preview"), primary(r, RepairState.FINISHED))
    }

    /** A check from before the repair stopped is not the repair's result: no verdict — the server's check of it is still to come. */
    @Test fun aCheckOlderThanTheRepairsStopIsNotItsVerdict() {
        val earlier = recovery("checkedAt" to JsonPrimitive("2026-10-11T11:14:00Z"))
        for (state in listOf("AWAITING_INPUT", "SUCCEEDED"))
            assertEquals(MergeRecovery.RepairRow(RepairState.FINISHED, "Repair session finished", null), row(earlier, repair(state)))
        assertEquals(RepairState.FINISHED, row(recovery(*unfinished, "checkedAt" to JsonPrimitive("2026-10-11T11:14:00Z")),
            repair("AWAITING_INPUT", "lastAssistantText" to JsonPrimitive("Keep the target's version?"))).state)
        assertEquals("no stop to compare with", MergeRecovery.RepairRow(RepairState.FINISHED, "Repair session finished", null),
            row(recovery(), repair("AWAITING_INPUT", "lastTurnAt" to JsonNull)))
        assertEquals("the steps still follow the check", Button("Continue repair", "repair", preparePR = false), primary(earlier, RepairState.FINISHED))
    }

    // ── Board ⑥: already on origin ──

    private val landedOnOrigin = arrayOf("code" to JsonPrimitive("ALREADY_LANDED"), "previewId" to JsonPrimitive("1c0ffee"),
        "repairBranch" to JsonNull, "repairWorktree" to JsonNull, "phase" to JsonNull, "conflicts" to JsonNull, "patch" to JsonPrimitive(""),
        "localCommits" to json("""{"l":[{"sha":"749188d8${"0".repeat(32)}","subject":"feat(suggestions): server-written next-message guess for non-Claude engines","author":"coordinator","date":"2026-10-11T08:31:00+08:00"},
            {"sha":"8a954110${"0".repeat(32)}","subject":"feat(composer): “Double-tap to use” stays, the learned flag goes","author":"coordinator","date":"2026-10-11T07:40:00+08:00"}]}""")["l"]!!,
        "remoteCommits" to json("""{"l":[{"sha":"5e6f7a8b${"0".repeat(32)}","subject":"Merge origin/main into main","author":"Orbit Runner","date":"2026-10-11T11:00:00Z","merge":true}]}""")["l"]!!,
        "landedCommits" to json("""{"l":[{"sha":"bba5d7b3${"0".repeat(32)}","subject":"Explicit self in the session-list currency closure","author":"coordinator","date":"2026-10-11T18:34:12+08:00","sourceSha":"0032a5e1${"0".repeat(32)}"},
            {"sha":"99cd5459${"0".repeat(32)}","subject":"Update AgentsModel.swift, SessionListSwitchWiringTests.swift","author":"coordinator","date":"2026-10-11T17:36:20+08:00","sourceSha":"e4b9d0e1${"0".repeat(32)}"}]}""")["l"]!!)

    private fun r0() = (landedOnOrigin.first { it.first == "landedCommits" }.second as JsonArray)[0]

    @Test fun aSessionAlreadyOnOriginSaysWhereAndEndsWithDone() {
        val r = recovery(*landedOnOrigin)
        assertTrue(r.confirmable)
        assertEquals("Already on origin/main", r.title)
        assertEquals("This session’s changes reached origin/main on Oct 11. Nothing is left to merge.", r.lede(ZoneOffset.UTC, Locale.US, now))
        assertEquals(listOf("bba5d7b3" to "0032a5e1", "99cd5459" to "e4b9d0e1"), r.landedCommits!!.map { it.sha.take(8) to it.sourceSha!!.take(8) })
        assertEquals("Oct 11", MergeRecovery.day(r.landedCommits!!.last().date, ZoneOffset.UTC, Locale.US, now))
        assertEquals("another year's landing names its year", "Oct 11, 2025", MergeRecovery.day("2025-10-11T09:36:20Z", ZoneOffset.UTC, Locale.US, now))
        assertEquals("Matched by content — this branch was rewritten after these merged.", r.landedNote)
        assertEquals("Local main’s own 2 commits aren’t part of this session.", r.localNote)
        assertEquals("Local main: 2 ahead, 1 behind origin/main", r.targetRelation)
        // Done is the one step — whatever the repair session did, and with no Check again beside it.
        for (state in listOf(null, RepairState.FINISHED, RepairState.NEEDS_REPLY, RepairState.RUNNING))
            assertEquals(MergeRecovery.Buttons(Button("Done", "confirm-landed"), emptyList(), null), r.buttons(supported = true, repair = state))
        assertEquals("the check Done would answer is still running", Button("Checking…", "wait"), primary(r, RepairState.CHECKING))
    }

    @Test fun onlyAStoredCheckOfTheSourceCanBeDone() {
        // An older server stores the runner's answer without the previewId Done is fenced on: the review checks instead.
        assertEquals(Button("Check and repair", "preview"), primary(recovery(*landedOnOrigin, "previewId" to JsonNull), null))
        assertFalse(recovery(*landedOnOrigin, "sourceSha" to JsonPrimitive("0032a5e")).confirmable)
        assertEquals(Button("Check again", "preview"), primary(recovery(*landedOnOrigin, "sourceSha" to JsonPrimitive("0032a5e")), null))
        val own = recovery(*landedOnOrigin, "landedCommits" to json("""{"l":[{"sha":"${sha('a')}","subject":"s","author":"a","date":"2026-10-11T09:36:00Z","sourceSha":"${sha('a')}"}]}""")["l"]!!,
            "localCommits" to JsonNull)
        assertNull("the very commits, not copies: nothing was matched by content", own.landedNote)
        assertEquals("Matched by content — this branch was rewritten after it merged.", recovery(*landedOnOrigin,
            "landedCommits" to JsonArray(listOf(r0()))).landedNote)
        assertNull(own.localNote)
        assertEquals("Local main’s own 1 commit isn’t part of this session.", recovery(*landedOnOrigin,
            "localCommits" to JsonArray(listOf(json("""{"sha":"${sha('b')}","subject":"s","author":"a","date":"2026-10-11T09:36:00Z"}""")))).localNote)
        assertEquals("Nothing is left to merge.", recovery(*landedOnOrigin, "landedCommits" to JsonNull).lede())
    }

    // ── Board ④'s footnote: the project's rule ──

    @Test fun theMovedTargetFootnoteIsACarriedRepairsTargetSyncConflictAlone() {
        val note = "origin/main moved after the repair. The repair was kept; only this file conflicts with the new commits."
        val carried = arrayOf("previewId" to JsonPrimitive("e81d4f"), "repairBranch" to JsonPrimitive("orbit/recovery/5971aa"))
        assertEquals("carried + TARGET_SYNC", note, recovery(*carried, "phase" to JsonPrimitive("TARGET_SYNC")).movedAfterRepairNote)
        assertNull("carried + SOURCE_REPLAY: nothing moved", recovery(*carried, "phase" to JsonPrimitive("SOURCE_REPLAY")).movedAfterRepairNote)
        assertNull("a fresh branch, named for this check", recovery("phase" to JsonPrimitive("TARGET_SYNC")).movedAfterRepairNote)
        assertNull(recovery(*carried, *unfinished, "phase" to JsonPrimitive("TARGET_SYNC")).movedAfterRepairNote)
        assertNull("no repair branch, nothing carried", recovery(*carried, "phase" to JsonPrimitive("TARGET_SYNC"), "repairBranch" to JsonNull).movedAfterRepairNote)
        assertEquals("origin/main moved after the repair. The repair was kept; only these files conflict with the new commits.",
            recovery(*carried, "phase" to JsonPrimitive("TARGET_SYNC"), "conflicts" to JsonArray(listOf(JsonPrimitive("a"), JsonPrimitive("b")))).movedAfterRepairNote)
    }

    // ── Without a repair session, and on an older server: the review as it was ──

    @Test fun withoutARepairSessionTheStepsAreAsTheyWere() {
        assertEquals(MergeRecovery.Buttons(Button("Resolve in repair session", "repair", preparePR = false), listOf(Button("Prepare PR candidate", "repair", preparePR = true)),
            Button("Check again", "preview")), recovery().buttons(supported = true))
        assertEquals(MergeRecovery.Buttons(Button("Check again", "preview"), listOf(Button("Resolve in repair session", "repair", preparePR = false),
            Button("Prepare PR candidate", "repair", preparePR = true)), null), recovery(*unfinished).buttons(supported = true))
        assertEquals(Button("Sync main and merge", "apply"), recovery(*ready).buttons(supported = true).primary)
        assertEquals(MergeRecovery.Buttons(null, emptyList(), null), recovery(*landedOnOrigin).buttons(supported = false))
    }

    @Test fun anOlderServerKeepsTheRowItHad() {
        val old = json("""{"mergeRecoverySupported":true,"mergeRepairSession":{"id":"r","title":"Resolve merge recovery for main","status":"AWAITING_INPUT",
            "runStatus":"AWAITING_INPUT","runState":"AWAITING_INPUT"}}""")
        assertFalse(MergeRecovery.followsRepairs(old))
        assertTrue(MergeRecovery.followsRepairs(JsonObject(old + ("mergeRepairTurnEndedAt" to JsonNull))))
        val repair = MergeRecovery.repair(old)!!
        assertEquals(MergeRecovery.Repair("r", "Resolve merge recovery for main", "AWAITING_INPUT", null, null, null), repair)
        assertEquals(MergeRecovery.RepairRow(RepairState.COMPLETED, "Repair session completed", "Ready to check again"),
            recovery().repairRow(repair, loop = false, checking = false, now = now))
        assertEquals(MergeRecovery.RepairRow(RepairState.FAILED, "Repair session failed", null), recovery().repairRow(
            MergeRecovery.repair(json("""{"mergeRepairSession":{"runStatus":"FAILED","error":"boom"}}"""))!!, loop = false, checking = true, now = now))
        assertEquals(RepairState.RUNNING, recovery().repairRow(MergeRecovery.repair(json("""{"mergeRepairSession":{"runStatus":"PENDING"}}"""))!!,
            loop = false, checking = false, now = now).state)
    }

    // ── What the detail and the recovery carry ──

    @Test fun theRepairSessionsNewFieldsAreRead() {
        val stopped = MergeRecovery.repair(json("""{"mergeRepairSession":{"id":"r","runState":"SUCCEEDED","lastTurnAt":null,
            "finishedAt":"2026-10-11T11:27:00Z","lastAssistantText":"Rebased; nothing left to resolve."}}"""))!!
        assertEquals("2026-10-11T11:27:00Z", stopped.stoppedAt)
        assertEquals("Rebased; nothing left to resolve.", stopped.lastAssistantText)
        assertFalse(stopped.running)
        assertNull(MergeRecovery.repair(json("""{"mergeRepairSession":null}""")))
    }

    /** A landed commit names the session's commit it carries; one without is a malformed list, dropped as any malformed commit list is. */
    @Test fun aLandedCommitCarriesItsSource() {
        assertEquals("y", MergeRecovery.of(json("""{"code":"ALREADY_LANDED","targetBranch":"main","landedCommits":[{"sha":"x","subject":"s","author":"a","date":"d","sourceSha":"y"}]}"""))!!
            .landedCommits!!.single().sourceSha)
        assertNull(MergeRecovery.of(json("""{"code":"ALREADY_LANDED","targetBranch":"main","landedCommits":[{"sha":"x","subject":"s","author":"a","date":"d"}]}"""))!!.landedCommits)
        assertNull("an older runner's recovery has none", recovery().landedCommits)
        assertNull("local and remote commits carry no source", recovery(*landedOnOrigin).localCommits!!.first().sourceSha)
    }
}
