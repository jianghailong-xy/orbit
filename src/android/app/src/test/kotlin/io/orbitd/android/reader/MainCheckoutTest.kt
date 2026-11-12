package io.orbitd.android.reader

import io.orbitd.android.core.protocol.Wire
import io.orbitd.android.core.realtime.RunEvent
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
import java.io.File

/**
 * Main checkout Git on Android (docs/main-checkout-git-contract.md): the transcript rows the two notices become, when the bar shows and
 * what it offers, the request bodies, the result lines and the isolation dialogs — held to `src/shared/src/main-checkout-git.fixture.json`
 * and the copy in `src/shared/src/mainCheckoutGit.ts`, which web and the runner are held to as well.
 */
class MainCheckoutTest {
    private fun shared(name: String) = generateSequence(File(System.getProperty("user.dir"))) { it.parentFile }
        .map { File(it, "src/shared/src/$name") }.first { it.isFile }
    private val fixture by lazy { Wire.json.parseToJsonElement(shared("main-checkout-git.fixture.json").readText()).jsonObject }
    private val source by lazy { shared("mainCheckoutGit.ts").readText() }
    private fun json(text: String) = Wire.json.parseToJsonElement(text).jsonObject
    private fun event(seq: Long, type: String, payload: JsonObject) = RunEvent(type, seq, payload)

    // ---- Row mapping ----------------------------------------------------------------------------------------

    @Test fun theChangedNoticeIsACardRowAndAResultNoticeAResultRow() {
        val changed = fixture["changedNotice"]!!.jsonObject
        val result = buildJsonObject {
            put("noticeKind", MainCheckout.NOTICE_RESULT); put("notice", "Pushed main to origin (62325fb..8d41e0c).")
            put("result", fixture["results"]!!.jsonArray[2].jsonObject["result"]!!)
        }
        val rows = transcriptRows(listOf(
            event(1, "user", json("""{"text":"Fix the retry loop"}""")),
            event(2, "assistant", json("""{"text":"Done."}""")),
            event(3, "system", changed),
            event(4, "system", result),
            event(5, "system", json("""{"notice":"Something else to know"}""")),
        ))
        assertEquals(listOf("user", "assistant", MainCheckout.ROW_CARD, MainCheckout.ROW_RESULT, "notice"), rows.map { it.event.type })
        // Each keeps its own sequence (a link to the record lands on it) and its payload, which the row reads.
        assertEquals(listOf("event:3", "event:4"), rows.subList(2, 4).map { it.key })
        val card = MainCheckout.changedNotice(rows[2].event.fields)!!
        assertEquals(3, card.fileCount)
        assertEquals(listOf("src/api/client.ts", "src/api/retry.test.ts", "src/api/retry.ts"), card.files.map { it.path })
        assertEquals(MainCheckout.File("src/api/client.ts", "M", 12, 3), card.files[0])
        assertEquals("push", MainCheckout.resultNotice(rows[3].event.fields)!!.kind)
    }

    @Test fun aNoticeTheClientCannotReadStaysItsTextLine() {
        // A result notice without its result, or a card without its root, is still the sentence it carries.
        val rows = transcriptRows(listOf(
            event(1, "system", json("""{"noticeKind":"main-checkout-action-result","notice":"Cancelled: nothing was changed."}""")),
            event(2, "system", json("""{"noticeKind":"main-checkout-changed","notice":"3 files changed"}""")),
        ))
        assertEquals(listOf("notice" to "Cancelled: nothing was changed.", "notice" to "3 files changed"), rows.map { it.event.type to it.event.body() })
    }

    @Test fun theCardsNoticeIsItsTitleAndSubtitle() {
        val notice = fixture["changedNotice"]!!.jsonObject
        val card = MainCheckout.changedNotice(notice)!!
        assertEquals(notice["notice"]!!.jsonPrimitive.content,
            MainCheckout.cardTitle(card.fileCount, card.truncated) + " " + MainCheckout.cardSubtitle(card.root, card.branch))
        assertEquals("At least 200 files changed in the main checkout during this turn", MainCheckout.cardTitle(200, true))
        assertEquals("and 14 more", MainCheckout.moreFiles(14))
        assertEquals("Orbit stopped counting at 200 files.", MainCheckout.truncatedNote())
        assertEquals("Copies them onto orbit/fix-retry-backoff, then clears them from the main checkout. A recovery branch is saved first.",
            MainCheckout.moveHint("orbit/fix-retry-backoff"))
    }

    // ---- Bar visibility ---------------------------------------------------------------------------------------

    @Test fun theBarReadsTheHeartbeatCounts() {
        val repo = fixture["heartbeatRepo"]!!.jsonObject
        val bar = MainCheckout.bar(repo, actionsSupported = true)!!
        assertEquals("7 uncommitted files · 1 commit not pushed", bar.status)
        assertEquals(MainCheckout.Button.REVIEW, bar.button)
        assertEquals("main", bar.branch)
        assertEquals(repo["fingerprint"]!!.jsonPrimitive.content, bar.fingerprint)
    }

    @Test fun theBarHidesOnACleanPushedCheckoutAndOnARunnerWithoutCounts() {
        val repo = fixture["heartbeatRepo"]!!.jsonObject
        fun with(vararg pairs: Pair<String, JsonElement?>) = JsonObject(repo.toMutableMap().apply {
            pairs.forEach { (k, v) -> if (v == null) remove(k) else put(k, v) }
        })
        assertNull(MainCheckout.bar(with("fileCount" to JsonPrimitive(0), "ahead" to JsonPrimitive(0), "state" to JsonPrimitive("clean")), true))
        assertNull("an older runner reports no counts", MainCheckout.bar(with("fileCount" to null), true))
        assertNull(MainCheckout.bar(null, true))
        // Clean, but a commit not pushed: the bar stays, and offers Push.
        val ahead = MainCheckout.bar(with("fileCount" to JsonPrimitive(0), "state" to JsonPrimitive("clean")), true)!!
        assertEquals("Clean · 1 commit not pushed", ahead.status)
        assertEquals(MainCheckout.Button.PUSH, ahead.button)
        assertEquals("Push to origin/main", MainCheckout.pushLabel(ahead.upstream!!))
        // Dirty, nothing ahead.
        assertEquals("1 uncommitted file", MainCheckout.bar(with("fileCount" to JsonPrimitive(1), "ahead" to JsonPrimitive(0)), true)!!.status)
    }

    @Test fun withoutTheCapabilityTheBarSaysItsStateAndOffersNothing() {
        val bar = MainCheckout.bar(fixture["heartbeatRepo"]!!.jsonObject, actionsSupported = false)!!
        assertEquals("7 uncommitted files · 1 commit not pushed", bar.status)
        assertNull(bar.button)
    }

    @Test fun aWorktreeSessionReviewsAndASharedOneReviewsAndCommits() {
        assertEquals("Review", MainCheckout.reviewLabel(isolated = true))
        assertEquals("Review and commit…", MainCheckout.reviewLabel(isolated = false))
    }

    // ---- Request encoding -------------------------------------------------------------------------------------

    @Test fun eachKindSendsExactlyTheContractsFieldsInItsOrder() {
        val expected = fixture["requests"]!!.jsonArray.map { it.jsonObject }
        val fp = expected[0]["fingerprint"]!!.jsonPrimitive.content
        val built = listOf(
            MainCheckout.move("/root/orbit", fp, listOf("src/api/client.ts", "src/api/retry.ts"), "sess-1", "req-move", null),
            MainCheckout.commit("/root/orbit", fp, listOf("src/api/client.ts"), "  Add retry backoff\n", "req-commit", null),
            MainCheckout.push("/root/orbit", fp, "req-push", null),
            MainCheckout.rescue("/root/orbit", fp, "req-rescue", null),
        ).map(MainCheckout::encode)
        assertEquals(expected, built)
        // Byte for byte, field order included.
        assertEquals(expected.map { it.toString() }, built.map { it.toString() })
    }

    @Test fun theSessionPressedInRidesAlongAndFieldsOfOtherKindsNeverDo() {
        val stray = MainCheckout.Request("push", "/r", "mc1:a:b", "req", files = listOf("x"), message = "m", targetSessionId = "s",
            initiatedFromSessionId = "sess-9")
        assertEquals("""{"kind":"push","root":"/r","fingerprint":"mc1:a:b","requestId":"req","initiatedFromSessionId":"sess-9"}""",
            MainCheckout.encode(stray).toString())
        val rescue = MainCheckout.encode(MainCheckout.rescue("/r", "mc1:a:b", "req", "sess-9"))
        assertFalse("files" in rescue)
        assertEquals("sess-9", rescue["initiatedFromSessionId"]!!.jsonPrimitive.content)
    }

    // ---- Result lines (board 03) ------------------------------------------------------------------------------

    @Test fun everyFixtureResultSaysItsExactLine() {
        fixture["results"]!!.jsonArray.map { it.jsonObject }.forEach { case ->
            val name = case["name"]!!.jsonPrimitive.content
            val result = MainCheckout.result(case["result"]!!.jsonObject)!!
            val view = case["view"] as? JsonObject
            val line = MainCheckout.resultLine(result, sessionId = view?.get("sessionId")?.jsonPrimitive?.content,
                targetTitle = view?.get("targetTitle")?.jsonPrimitive?.content, isolated = view?.get("isolated")?.jsonPrimitive?.booleanOrNull ?: true)
            assertEquals(name, case["lead"]!!.jsonPrimitive.content, line.lead)
            assertEquals(name, case["text"]!!.jsonPrimitive.content, line.text)
            val link = case["link"] as? JsonObject
            assertEquals(name, link?.let { MainCheckout.Link(it["action"]!!.jsonPrimitive.content, it["label"]!!.jsonPrimitive.content) }, line.link)
        }
    }

    @Test fun openInANewSessionAsksAboutTheRescueBranchInTheMacOSClientsWords() {
        assertEquals("The main checkout's uncommitted changes were saved to orbit/rescue-8c9454aa. " +
            "Look at what that branch holds compared with its parent and tell me what it contains.",
            MainCheckout.rescuePrompt("orbit/rescue-8c9454aa"))
    }

    @Test fun theSuccessVariantsReadAsTheContractSays() {
        val move = MainCheckout.Result("r", "move", "/root/orbit", "done", branch = "main", fileCount = 2, remaining = 1,
            rescueBranch = "orbit/rescue-5f2c1a9", targetSessionId = "sess-2")
        assertEquals("Moved 2 files into the worktree of “Bump eslint to 9”. The main checkout still has 1 other uncommitted file. " +
            "A copy of what it held is on orbit/rescue-5f2c1a9.", MainCheckout.resultLine(move, "sess-1", "Bump eslint to 9").text)
        val commit = MainCheckout.Result("r", "commit", "/root/orbit", "done", branch = "main", fileCount = 3, head = "8d41e0c1234",
            subject = "Add retry backoff", upstream = "origin/main")
        assertEquals("Committed 3 files to main in the main checkout as 8d41e0c “Add retry backoff”. Not pushed yet.",
            MainCheckout.resultLine(commit, isolated = false).text)
        val push = MainCheckout.Result("r", "push", "/root/orbit", "done", branch = "b", remoteAfter = "8d41e0c999", upstream = "origin/b")
        assertEquals("Pushed b to origin as a new branch (8d41e0c).", MainCheckout.resultLine(push).text)
        assertEquals(MainCheckout.Tone.WAITING, MainCheckout.resultLine(MainCheckout.Result("r", "push", "/r", "waiting", "RUNNER_OFFLINE")).tone)
    }

    // ---- Board 04 isolation dialogs -----------------------------------------------------------------------------

    @Test fun turningOnAsksOnlyWhenTheCheckoutIsDirtyStuckOrUnseen() {
        val repo = fixture["heartbeatRepo"]!!.jsonObject
        assertEquals(MainCheckout.IsolationDialog.Dirty("The main checkout /root/orbit has 7 uncommitted files. New sessions start from the last " +
            "commit on main (62325fb), so they won't see those files."), MainCheckout.turnOnDialog(repo))
        assertNull(MainCheckout.turnOnDialog(json("""{"root":"/root/orbit","state":"clean","fileCount":0}""")))
        assertEquals(MainCheckout.IsolationDialog.Stuck("The main checkout /root/orbit is stuck in a rebase — new sessions can be created, " +
            "but merges stay blocked until it's cleaned up."), MainCheckout.turnOnDialog(json("""{"root":"/root/orbit","state":"rebase"}""")))
        assertEquals(MainCheckout.IsolationDialog.Unseen, MainCheckout.turnOnDialog(null))
        // An older runner says dirty but not how much: Orbit can't see it, and says so rather than guess.
        assertEquals(MainCheckout.IsolationDialog.Unseen, MainCheckout.turnOnDialog(json("""{"root":"/root/orbit","state":"dirty"}""")))
    }

    @Test fun turningOffAsksOnlyWhileSessionsKeepUnmergedWorktrees() {
        assertNull(MainCheckout.turnOffDialog("/root/orbit", 0))
        assertEquals(MainCheckout.IsolationDialog.Off("New sessions will work directly in /root/orbit. The 2 sessions with unmerged worktrees keep " +
            "them — merge or discard them from each session as before."), MainCheckout.turnOffDialog("/root/orbit", 2))
        val sessions = listOf(
            """{"id":"a","isolationStatus":"worktree","branch":"orbit/a","mergeStatus":null}""",
            """{"id":"b","isolationStatus":"worktree","branch":"orbit/b","mergeStatus":"merged"}""",
            """{"id":"c","isolationStatus":"worktree","branch":"orbit/c","branchMerged":true}""",
            """{"id":"d","isolationStatus":"shared","branch":null}""",
            """{"id":"e","isolationStatus":"worktree","branch":"orbit/e","mergeStatus":"conflict"}""",
        ).map(::json)
        assertEquals(listOf("a", "e"), sessions.filter(MainCheckout::holdsUnmergedWorktree).map { it["id"]!!.jsonPrimitive.content })
    }

    @Test fun moveTargetsAreWorktreeSessionsThisOneFirstARunningOneShownNotOffered() {
        val rows = listOf(
            """{"id":"x","title":"Bump eslint to 9","isolationStatus":"worktree","branch":"orbit/bump-eslint","status":"COMPLETED"}""",
            """{"id":"me","title":"Fix retry backoff","isolationStatus":"worktree","branch":"orbit/fix-retry-backoff","runStatus":"AWAITING_INPUT"}""",
            """{"id":"y","title":"Migrate settings table","isolationStatus":"worktree","branch":"orbit/settings-v2","runStatus":"RUNNING"}""",
            """{"id":"z","title":"Shared","isolationStatus":"shared"}""",
        ).map(::json)
        assertEquals(listOf(MoveTarget("me", "Fix retry backoff", "orbit/fix-retry-backoff", false),
            MoveTarget("x", "Bump eslint to 9", "orbit/bump-eslint", false), MoveTarget("y", "Migrate settings table", "orbit/settings-v2", true)),
            MainCheckoutModel.moveTargets(rows, "me"))
    }

    // ---- Copy parity with @orbit/shared -------------------------------------------------------------------------

    /** Each `key: 'value'` of an `as const` object in mainCheckoutGit.ts. */
    private fun constants(objectName: String): Map<String, String> {
        val body = source.substringAfter("export const $objectName = {").substringBefore("} as const;")
        return Regex("""(\w+):\s*\n?\s*(['"])(.*?)\2,""").findAll(body).associate { it.groupValues[1] to it.groupValues[3].replace("\\'", "'") }
    }

    @Test fun theCopyIsWordForWordTheSharedCopy() {
        val copy = constants("MAIN_CHECKOUT_COPY")
        assertEquals(mapOf("label" to MainCheckout.COPY_LABEL, "moveToThisWorktree" to MainCheckout.COPY_MOVE_TO_THIS_WORKTREE,
            "moveToAWorktree" to MainCheckout.COPY_MOVE_TO_A_WORKTREE, "saveAndClean" to MainCheckout.COPY_SAVE_AND_CLEAN,
            "saveAndCleanHint" to MainCheckout.COPY_SAVE_AND_CLEAN_HINT, "askAgent" to MainCheckout.COPY_ASK_AGENT,
            "askAgentHint" to MainCheckout.COPY_ASK_AGENT_HINT, "leaveAsIs" to MainCheckout.COPY_LEAVE_AS_IS, "review" to MainCheckout.COPY_REVIEW,
            "reviewAndCommitShort" to MainCheckout.COPY_REVIEW_AND_COMMIT_SHORT, "reviewMainCheckout" to MainCheckout.COPY_REVIEW_MAIN_CHECKOUT,
            "commitMessagePlaceholder" to MainCheckout.COPY_COMMIT_MESSAGE, "notShown" to MainCheckout.COPY_NOT_SHOWN,
            "targetOpenedFrom" to MainCheckout.COPY_TARGET_OPENED_FROM, "targetBusy" to MainCheckout.COPY_TARGET_BUSY,
            "cleanUpCheckout" to MainCheckout.COPY_CLEAN_UP_CHECKOUT), copy)
        assertEquals(mapOf("turnOnTitle" to MainCheckout.ISO_TURN_ON_TITLE, "turnOffTitle" to MainCheckout.ISO_TURN_OFF_TITLE,
            "unchanged" to MainCheckout.ISO_UNCHANGED, "unseen" to MainCheckout.ISO_UNSEEN, "reviewFiles" to MainCheckout.ISO_REVIEW_FILES,
            "cancel" to MainCheckout.ISO_CANCEL, "turnOn" to MainCheckout.ISO_TURN_ON, "turnOff" to MainCheckout.ISO_TURN_OFF,
            "cleanUpCheckout" to MainCheckout.ISO_CLEAN_UP_CHECKOUT), constants("WORKTREE_ISOLATION_DIALOG_COPY"))
        assertEquals("Choose files to commit · 3 of 3", MainCheckout.chooseFiles(3, 3))
        assertEquals("Commit 3 files to main", MainCheckout.commitButton(3, "main"))
        assertEquals("This skips project Main checkout Git's landing check.", MainCheckout.managedBranchWarning("Main checkout Git"))
        assertEquals(fixture["capability"]!!.jsonPrimitive.content, MainCheckout.CAPABILITY)
        assertEquals(fixture["fileLimit"]!!.jsonPrimitive.int, MainCheckout.FILE_LIMIT)
        assertEquals(fixture["noticeKinds"]!!.jsonObject.let { listOf(it["changed"]!!.jsonPrimitive.content, it["result"]!!.jsonPrimitive.content) },
            listOf(MainCheckout.NOTICE_CHANGED, MainCheckout.NOTICE_RESULT))
    }
}
