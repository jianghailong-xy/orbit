package io.orbitd.android.core.cards

import java.time.Instant
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/** The merge into main's words and rules, as OrbitKit holds `PromotionCards` (iOS 6b4bef713's ProjectMergeCardTests and the merge
 * cases of OwnerItemCardsTests, with main's 8297b18a3 blocked reasons and holders): the project sessions page's card, the
 * coordinator conversation's one line, the review both open and the receipt a merge leaves. */
class ProjectMergeCopyTest {
    /** ProjectMergeCardTests' candidate: the project's branch into main, two tasks, ten files, five commits. */
    private fun candidate(state: String, conflicts: List<String> = emptyList(), taskIds: List<String> = listOf("t1", "t2"), merged: String? = null,
        execution: String? = null, files: Int? = 10, commits: Int? = 5, extra: String = "") = Json.parseToJsonElement("""{"promotionId":"pr-1",
        "state":"$state","sourceRef":"refs/heads/project/34ZurCP3bv9yLXGVyUGnx","sourceSha":"5e5bfca23aa1","upstreamRef":"refs/heads/main",
        "commitsAhead":${commits ?: "null"},"filesChanged":${files ?: "null"},"taskIds":${taskIds.json()},"conflicts":${conflicts.json()},
        "askedAt":"2026-10-06T03:31:00Z","merged":${merged ?: "null"}${execution?.let { ",\"execution\":$it" }.orEmpty()}$extra}""").jsonObject
    /** OwnerItemCardsTests' candidate (mock 4): project/bg-jobs, four tasks and the Go suite that passed in 6m 12s. */
    private fun mock4(state: String, conflicts: List<String> = emptyList(), merged: String? = null, execution: String? = null) = Json.parseToJsonElement("""{
        "promotionId":"pr-1","state":"$state","sourceRef":"refs/heads/project/bg-jobs","sourceSha":"58f3a4711d0c","upstreamRef":"refs/heads/main",
        "commitsAhead":7,"filesChanged":18,"taskIds":["t1","t2","t3","t4"],"conflicts":${conflicts.json()},"landsAs":"MERGE_COMMIT",
        "checks":[{"name":"MERGE_CHECK","command":"cd src/runner-go && go test -count=1 ./...","expectedExitCode":0,"exitCode":0,"timedOut":false,"durationMs":372000}],
        "askedAt":"2026-09-13T10:00:00Z","merged":${merged ?: "null"}${execution?.let { ",\"execution\":$it" }.orEmpty()}}""").jsonObject
    private fun List<String>.json() = joinToString(",", "[", "]") { "\"$it\"" }
    private fun running(phase: String) = """{"state":"RUNNING","phase":"$phase","startedAt":"2026-10-06T03:20:00Z"}"""
    private fun at(iso: String) = Instant.parse(iso)

    // MARK: the card on the project's sessions page

    @Test fun thePageCardSaysWhatIsAskedOfMainWithTheBranchUnderIt() {
        assertEquals("Merge into main?", PromotionCards.pageTitle(candidate("READY")))
        assertEquals("Merge into main queued", PromotionCards.pageTitle(candidate("CONFIRMED", execution = """{"state":"QUEUED","startedAt":"x"}""")))
        assertEquals("Merge into main confirmed", PromotionCards.pageTitle(candidate("CONFIRMED")))
        assertEquals("Re-checking before merging into main…", PromotionCards.pageTitle(candidate("RECHECKING", execution = running("CHECK"))))
        assertEquals("Merging into main…", PromotionCards.pageTitle(candidate("CONFIRMED", execution = running("PUSH"))))
        assertEquals("Can’t merge into main yet", PromotionCards.pageTitle(candidate("BLOCKED", conflicts = listOf("a.go"))))
        assertEquals("2 tasks · 10 files", PromotionCards.pageCounts(candidate("READY")))
        assertEquals("1 task · 1 file", PromotionCards.pageCounts(candidate("READY", taskIds = listOf("t1"), files = 1)))
        assertEquals("2 tasks", PromotionCards.pageCounts(candidate("READY", files = null)))
        assertEquals("project/34ZurCP3bv9yLXGVyUGnx · 5 commits ahead of main", PromotionCards.branchLine(candidate("READY")))
        assertEquals("asked 2h 10m ago", PromotionCards.askedLine(candidate("READY"), at("2026-10-06T05:41:00Z")))
        assertEquals(PromotionCards.pageNothingToDo, "Nothing to do — it lands on its own if the re-check passes, and comes back here if it doesn’t.")
    }

    @Test fun theCardNamesTheTasksItCarriesAndCountsTheRest() {
        val titles = listOf("修复 D1", "日志默认关闭", "P6", "P7", "P8")
        val view = candidate("READY", taskIds = listOf("t1", "t2", "t3", "t4", "t5"),
            extra = ""","tasks":${titles.mapIndexed { i, title -> """{"taskId":"t${i + 1}","title":"$title"}""" }.joinToString(",", "[", "]")}""")
        val (shown, more) = PromotionCards.taskTitles(view)
        assertEquals(listOf("修复 D1", "日志默认关闭", "P6"), shown)
        assertEquals(2, more)
        assertEquals("+2 more", PromotionCards.moreTasks(more))
        assertNull(PromotionCards.moreTasks(0))
        assertEquals(titles, PromotionCards.allTaskTitles(view))
        // A server older than `tasks` names none, and the card still counts what the merge carries.
        assertEquals(emptyList<String>() to 2, PromotionCards.taskTitles(candidate("READY")))
    }

    // MARK: the conversation's one line

    @Test fun theConversationsLineIsOrangeOnlyWhileItWaitsOnTheReader() {
        assertEquals("Merge into main is waiting for you" to PromotionTone.NEEDS_YOU, PromotionCards.eventLine(candidate("READY")))
        assertEquals("Merge into main confirmed" to PromotionTone.WORKING, PromotionCards.eventLine(candidate("CONFIRMED")))
        assertEquals("Can’t merge into main yet · 2 files conflict" to PromotionTone.BLOCKED,
            PromotionCards.eventLine(candidate("BLOCKED", conflicts = listOf("a.go", "b.go"))))
        assertEquals("Can’t merge into main yet · checks failed", PromotionCards.eventLine(candidate("BLOCKED")).first)
        assertEquals(PromotionCards.supersededTitle to PromotionTone.QUIET, PromotionCards.eventLine(null))
        assertEquals(PromotionTone.QUIET, PromotionCards.eventLine(candidate("DECLINED")).second)
    }

    @Test fun theRecordsLinesSayWhatWentOntoMainAndWhoMergedIt() {
        val pressed = candidate("MERGED", merged = """{"sha":"8d5a868e90df","at":"2026-10-06T03:42:00Z","automatic":false,"revert":null}""")
        assertEquals("✓ Merged into main · 8d5a868 · 2 tasks", PromotionCards.receiptLine(pressed))
        assertEquals("Merged into main", PromotionCards.timelineTitle(pressed))
        assertEquals("8d5a868 · 2 tasks · by you", PromotionCards.timelineDetail(pressed))
        assertEquals("2 tasks", PromotionCards.nowOnMainLine(pressed))
        assertEquals("5 commits · 10 files", PromotionCards.changesLine(pressed))
        assertNull(PromotionCards.changesLine(candidate("MERGED", files = null, commits = null)))
        val automatic = candidate("MERGED", merged = """{"sha":"8d5a868e90df","at":"2026-10-06T03:42:00Z","automatic":true,"revert":"git revert -m 1 8d5a868e90df"}""")
        assertEquals("✓ Merged into main · 8d5a868 · 2 tasks · automatically", PromotionCards.receiptLine(automatic))
        assertEquals("8d5a868 · 2 tasks · automatically", PromotionCards.timelineDetail(automatic))
        // Only a merge with its own moment is a record; a candidate on offer never is.
        val receipts = PromotionCards.receipts(listOf(pressed, candidate("READY")))
        assertEquals(listOf("merge:pr-1" to "2026-10-06T03:42:00Z"), receipts.map { it.id to it.moment })
    }

    // MARK: the review and the receipt (OwnerItemCardsTests)

    @Test fun theMergeCardDrawsTheFourStatesAndNothingElse() {
        assertEquals(PromotionStage.ASKING_YOU, PromotionCards.stage(mock4("READY")))
        assertEquals(PromotionStage.MERGING, PromotionCards.stage(mock4("CONFIRMED")))
        assertEquals(PromotionStage.MERGING, PromotionCards.stage(mock4("RECHECKING")))
        assertEquals(PromotionStage.MERGED, PromotionCards.stage(mock4("MERGED")))
        assertEquals(PromotionStage.BLOCKED, PromotionCards.stage(mock4("BLOCKED", listOf("a.go"))))
        assertNull(PromotionCards.stage(mock4("CHECKING")))
        assertNull(PromotionCards.stage(mock4("DECLINED")))
        assertNull(PromotionCards.stage(null))
        assertTrue(PromotionCards.confirmable(mock4("READY")))
        listOf("CHECKING", "CONFIRMED", "RECHECKING", "BLOCKED", "MERGED", "DECLINED").forEach { assertFalse(it, PromotionCards.confirmable(mock4(it))) }
        assertFalse(PromotionCards.confirmable(null))
    }

    @Test fun theHeadingsAreTheDesignsWords() {
        assertEquals("Merge project/bg-jobs into main?", PromotionCards.title(mock4("READY")))
        assertEquals("Re-checking project/bg-jobs before merging into main…", PromotionCards.title(mock4("RECHECKING", execution = running("CHECK"))))
        assertEquals("✓ Merged into main", PromotionCards.title(mock4("MERGED")))
        assertEquals("project/bg-jobs can’t merge into main yet", PromotionCards.title(mock4("BLOCKED", listOf("a.go"))))
        assertEquals("Merge confirmed: project/bg-jobs into main", PromotionCards.title(mock4("CONFIRMED")))
        assertEquals("Merge to main", PromotionCards.previewTitle(mock4("READY")))
        assertEquals("Merge to main blocked", PromotionCards.previewTitle(mock4("BLOCKED")))
        assertEquals("Merging… · main", PromotionCards.previewTitle(mock4("CONFIRMED", execution = running("PUSH"))))
        assertEquals(PromotionCards.supersededTitle, PromotionCards.previewTitle(mock4("DECLINED")))
        assertEquals(PromotionCards.supersededTitle, PromotionCards.previewTitle(null))
    }

    @Test fun theReviewSaysWhatIsBeingMerged() {
        val ready = mock4("READY")
        assertEquals("project/bg-jobs · 7 commits ahead of main", PromotionCards.branchLine(ready))
        assertEquals("4 landed on the branch", PromotionCards.tasksLine(ready))
        assertEquals("✓ Passed on the combined tree · cd src/runner-go && go test -count=1 ./... · 6m 12s", PromotionCards.checksLine(ready))
        assertEquals("no conflicts", PromotionCards.upstreamLine(ready))
        assertEquals("3 of 6 met on this branch — merging does not close the project", PromotionCards.criteriaLine(3, 6))
        assertNull("criteria nobody has read are not reported as none met", PromotionCards.criteriaLine(0, 0))
        assertEquals("exactly the tested tree 58f3a47 · as a merge commit", PromotionCards.landsLine(ready))
        assertEquals("asked 2h 10m ago", PromotionCards.askedLine(ready, at("2026-09-13T12:10:00Z")))
        assertEquals("✓ Checks passed", PromotionCards.previewChecks(ready))
        assertTrue(PromotionCards.checksClean(ready))
        assertEquals("2 files conflict with main", PromotionCards.upstreamLine(mock4("BLOCKED", listOf("a.go", "b.go"))))
    }

    /** A check passed when it exited with the code it declared, and not otherwise: the server sends no `passed` field. */
    @Test fun aFailedOrUnfinishedCheckIsNotReportedAsPassed() {
        fun view(vararg checks: String) = Json.parseToJsonElement("""{"promotionId":"pr-1","state":"READY","sourceRef":"project/long-branch",
            "sourceSha":"abc","upstreamRef":"main","taskIds":["t1"],"checks":[${checks.joinToString(",")}]}""").jsonObject
        val passed = """{"name":"build","command":"npm run build","expectedExitCode":0,"exitCode":0,"timedOut":false}"""
        val failed = """{"name":"tests","command":"npm test","expectedExitCode":0,"exitCode":1,"timedOut":false,"durationMs":48000}"""
        val timedOut = """{"name":"tests","command":"npm test","expectedExitCode":0,"exitCode":null,"timedOut":true}"""
        val unfinished = """{"name":"tests","command":"npm test","expectedExitCode":0,"exitCode":null,"timedOut":false}"""
        assertEquals("No checks recorded", PromotionCards.previewChecks(view()))
        assertEquals("✕ Checks failed", PromotionCards.previewChecks(view(failed, passed)))
        assertEquals("✕ Checks failed", PromotionCards.previewChecks(view(unfinished, passed)))
        assertEquals("Checks timed out", PromotionCards.previewChecks(view(timedOut, passed)))
        assertFalse(PromotionCards.checksClean(view(failed, passed)))
        assertEquals("✕ Failed on the combined tree · npm test · 48s\n\n✓ Passed on the combined tree · npm run build", PromotionCards.checksLine(view(failed, passed)))
        assertTrue(PromotionCards.checksLine(view(timedOut)).startsWith("✕ Timed out on the combined tree"))
        assertEquals("no checks recorded", PromotionCards.checksLine(view()))
    }

    @Test fun theMergingAndBlockedCardsSayWhoHasIt() {
        assertEquals("main moved since the check — re-checking the combined tree", PromotionCards.mergingStatusLine(mock4("RECHECKING", execution = running("CHECK"))))
        assertEquals("nothing to do — it lands on its own if the re-check passes, and comes back here if it doesn’t", PromotionCards.nothingToDo)
        assertEquals("2 files conflict with main: src/runner-go/session_pool.go, src/apiserver/prisma/schema.prisma",
            PromotionCards.blockedLine(mock4("BLOCKED", listOf("src/runner-go/session_pool.go", "src/apiserver/prisma/schema.prisma"))))
        assertEquals("5 files conflict with main: a, b, c and 2 more", PromotionCards.blockedLine(mock4("BLOCKED", listOf("a", "b", "c", "d", "e"))))
        val now = at("2026-09-13T12:12:00Z")
        val theirs = Json.parseToJsonElement("""{"itemId":"item-1","kind":"INTEGRATION_CONFLICT","title":"Merge conflict",
            "waitingSince":"2026-09-13T12:00:00Z","assignee":"COORDINATOR","promotionId":"pr-1"}""").jsonObject
        val held = PromotionCards.holder("pr-1", buildJsonObject { put("needsYou", JsonArray(emptyList())); put("withCoordinator", JsonArray(listOf(theirs))) })
        assertEquals(PromotionHolder.Open(theirs), held)
        assertEquals("Coordinator is resolving it · 12m", PromotionCards.resolvingLine(held, now))
        assertTrue(PromotionCards.resolvingSpins(held)); assertFalse(PromotionCards.resolvingIsYours(held))
        // The clock handed it over: the same press, the other holder, and nothing turning over work waiting on the reader.
        val mine = JsonObject(theirs + ("assignee" to JsonPrimitive("OWNER")))
        val handed = PromotionCards.holder("pr-1", buildJsonObject { put("needsYou", JsonArray(listOf(mine))) })
        assertEquals("It is yours · waiting 12m", PromotionCards.resolvingLine(handed, now))
        assertFalse(PromotionCards.resolvingSpins(handed)); assertTrue(PromotionCards.resolvingIsYours(handed))
        // No item read yet, or no readable instant on it: the sentence, and no clock under it.
        assertEquals(PromotionHolder.Unread, PromotionCards.holder("pr-1", null))
        assertEquals("Coordinator is resolving it", PromotionCards.resolvingLine(PromotionHolder.Unread, now))
        assertEquals("Coordinator is resolving it", PromotionCards.resolvingLine(PromotionHolder.Open(JsonObject(theirs + ("waitingSince" to JsonPrimitive("")))), now))
    }

    /** Main's 8297b18a3: a blocked candidate nobody holds has no press — the card does not name the coordinator, and nothing turns. */
    @Test fun aBlockedCandidateNobodyHoldsHasNoPress() {
        val other = Json.parseToJsonElement("""{"itemId":"item-2","kind":"INTEGRATION_ERROR","waitingSince":"2026-09-13T12:00:00Z",
            "assignee":"COORDINATOR","promotionId":"pr-older"}""").jsonObject
        val nobody = PromotionCards.holder("pr-1", buildJsonObject { put("withCoordinator", JsonArray(listOf(other))) })
        assertEquals(PromotionHolder.Gone, nobody)
        assertNull(PromotionCards.resolvingLine(nobody))
        assertFalse(PromotionCards.resolvingSpins(nobody)); assertFalse(PromotionCards.resolvingIsYours(nobody))
        assertEquals(PromotionHolder.Gone, PromotionCards.holder("pr-1", JsonObject(emptyMap())))
    }

    /** Main's 8297b18a3: the reason is the job's own answer when the server recorded it. */
    @Test fun theBlockedReasonIsTheJobsAnswer() {
        fun blocked(reason: String?, conflicts: List<String> = emptyList()) = Json.parseToJsonElement("""{"promotionId":"pr-1","state":"BLOCKED",
            "sourceRef":"refs/heads/orbit/docs-evidence-33cf64","sourceSha":"","upstreamRef":"refs/heads/main","conflicts":${conflicts.json()},
            "blockedReason":${reason?.let { "\"$it\"" } ?: "null"}}""").jsonObject
        assertEquals("nothing to merge — orbit/docs-evidence-33cf64 is already on main", PromotionCards.blockedLine(blocked("ALREADY_LANDED")))
        assertEquals("nothing to merge", PromotionCards.blockedReason(blocked("ALREADY_LANDED")))
        assertEquals("the merge stopped on an error — no check failed", PromotionCards.blockedLine(blocked("ERROR")))
        assertEquals("check errored", PromotionCards.blockedReason(blocked("ERROR")))
        assertEquals("Can’t merge into main yet · check errored", PromotionCards.eventLine(blocked("ERROR")).first)
        assertEquals("the checks on the combined tree did not pass", PromotionCards.blockedLine(blocked("CHECK_FAILED")))
        assertEquals("the checks on the combined tree did not pass", PromotionCards.blockedLine(blocked(null)))
        assertEquals("checks failed", PromotionCards.blockedReason(blocked(null)))
        assertEquals("1 file conflict with main: a.go", PromotionCards.blockedLine(blocked("CONFLICT", listOf("a.go"))))
        assertEquals("1 file conflict", PromotionCards.blockedReason(blocked(null, listOf("a.go"))))
    }

    @Test fun theMergedCardIsAReceiptAndAnAutomaticMergeSaysHowToUndoIt() {
        val now = at("2026-09-13T12:02:00Z")
        val merged = mock4("MERGED", merged = """{"sha":"324cf0031a","at":"2026-09-13T12:00:00Z","automatic":false,"revert":null}""")
        assertEquals("324cf00 · merge of project/bg-jobs · by you · 2m", PromotionCards.mergedLine(merged, now))
        assertEquals("✓ Merged into main", PromotionCards.title(merged))
        assertNull(PromotionCards.revertLine(merged))
        val automatic = mock4("MERGED", merged = """{"sha":"324cf0031a","at":"2026-09-13T12:00:00Z","automatic":true,"revert":"git revert -m 1 324cf0031a"}""")
        assertEquals("✓ Merged into main automatically", PromotionCards.title(automatic))
        assertEquals("324cf00 · merge of project/bg-jobs · under your Automatic setting · 2m", PromotionCards.mergedLine(automatic, now))
        assertEquals("git revert -m 1 324cf0031a", PromotionCards.revertLine(automatic))
    }

    @Test fun aCheckDurationIsWrittenToTheSecond() {
        assertEquals("48s", PromotionCards.duration(48_000))
        assertEquals("6m 12s", PromotionCards.duration(372_000))
        assertEquals("6m", PromotionCards.duration(360_000))
        assertEquals("1h 4m", PromotionCards.duration(3_840_000))
        assertEquals("2h", PromotionCards.duration(7_200_000))
    }

    /** The conversation draws a candidate while it asks, merges or is blocked (iOS delivers those and closes a merged one): a merge
     * that happened is its record's line, and one still checking or already answered is no card at all. */
    @Test fun theConversationsCardIsTheCandidateWhileItAsksMergesOrIsBlocked() {
        fun cards(state: String) = CardCatalog.project("s1", "p1", mapOf("project" to buildJsonObject { put("id", "p1") }, "promotion" to candidate(state)))
            .filter { it.family == CardFamily.PROMOTION }
        listOf("READY", "CONFIRMED", "RECHECKING", "BLOCKED").forEach { assertEquals(it, 1, cards(it).size) }
        listOf("CHECKING", "MERGED", "DECLINED", "CANCELLED", "SUPERSEDED").forEach { assertEquals(it, 0, cards(it).size) }
    }
}
