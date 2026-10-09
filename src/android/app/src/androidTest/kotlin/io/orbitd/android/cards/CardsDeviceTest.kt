package io.orbitd.android.cards

import android.graphics.Bitmap
import android.os.Bundle
import android.os.Process
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import io.orbitd.android.auth.chooseServer
import io.orbitd.android.*
import io.orbitd.android.core.auth.AuthState
import io.orbitd.android.core.cards.*
import io.orbitd.android.core.protocol.Wire
import io.orbitd.android.navigation.ObjectId
import io.orbitd.android.tasks.TaskReopenCopy
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.net.HttpURLConnection
import java.net.URL

/** Real Activity -> AuthSession -> HTTP -> independent fixture journal and final state. */
@RunWith(AndroidJUnit4::class)
class CardsDeviceTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()
    private val instrument get() = InstrumentationRegistry.getInstrumentation()
    private val app get() = instrument.targetContext.applicationContext as OrbitApplication
    private val server = "http://127.0.0.1:18768"
    private val output get() = File(app.filesDir, "a08-cards").also { it.mkdirs() }
    private fun http(path: String, body: String? = null): JsonObject = (URL(server + path).openConnection() as HttpURLConnection).run {
        connectTimeout = 5000; readTimeout = 5000
        if (body != null) { requestMethod = "POST"; doOutput = true; outputStream.use { it.write(body.toByteArray()) } }
        try { check(responseCode == 200); Wire.json.parseToJsonElement(inputStream.bufferedReader().use { it.readText() }).jsonObject } finally { disconnect() }
    }
    private fun await(text: String) { compose.waitUntil(15_000) { compose.onAllNodesWithText(text, substring = true).fetchSemanticsNodes().isNotEmpty() } }
    private fun capture(name: String) {
        instrument.uiAutomation.takeScreenshot().let { bitmap -> File(output, "$name.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG,100,it) }; bitmap.recycle() }
    }
    private fun exists(tag: String) = compose.onAllNodesWithTag(tag).fetchSemanticsNodes().isNotEmpty()
    private fun login(kind: String, mode: String = "",
        ready: String = if (kind == "attachment-only") "Review the Orbit card below." else "Decisions and requests") {
        instrument.sendStatus(0, Bundle().apply { putString("a08_pid", Process.myPid().toString()) })
        File(output,"identity.txt").writeText("sha=${BuildConfig.SOURCE_SHA}\ndirty=${BuildConfig.SOURCE_DIRTY}\n")
        http("/__control", """{"case":"$kind","mode":"$mode"}""")
        compose.waitUntil(10_000) { app.session.state.value !is AuthState.Restoring }
        compose.chooseServer(server)
        compose.onNodeWithText("Email").performTextReplacement("a08@example.test")
        compose.onNodeWithText("Password").performTextReplacement("a08-fixture-password")
        compose.onNodeWithText("Sign In").performScrollTo().performClick()
        compose.waitUntil(15_000) { app.session.state.value is AuthState.SignedIn && app.realtime.state.value.directoryFresh }
        compose.onNodeWithTag("workspace:01a0cca7-8609-70ed-a0e2-d4b55b832b61").performClick()
        compose.onNodeWithText("Card verification").performClick()
        await(ready)
    }
    /** Presses a card's door. A08-2: a card that is a preview in the conversation keeps its doors in its review, so the preview
     * is opened first, as a person would; a door in the review's pinned bar is pressed where it is. */
    private fun press(tag: String) {
        val enabled = { compose.onAllNodes(hasTestTag(tag) and isEnabled()).fetchSemanticsNodes().isNotEmpty() }
        val preview = tag.substringBeforeLast(':') + ":preview"
        compose.waitUntil(15_000) { enabled() || exists(preview) }
        if (!exists(tag) && exists(preview)) compose.onNodeWithTag(preview).performScrollTo().performClick()
        compose.waitUntil(15_000) { enabled() }
        if (compose.onAllNodes(hasTestTag(tag) and hasAnyAncestor(hasScrollAction())).fetchSemanticsNodes().isNotEmpty())
            compose.onNodeWithTag(tag).performScrollTo()
        compose.onNodeWithTag(tag).assertIsEnabled().performClick()
    }
    /** The review's own receipt after a press ("Answer sent", "Decision recorded"), then the review closing itself. */
    private fun receipt(title: String, name: String) {
        var seen = false
        compose.waitUntil(15_000) {
            seen = seen || compose.onAllNodes(hasTestTag("card-review:receipt") and hasText(title)).fetchSemanticsNodes().isNotEmpty()
            seen || !exists("card-review")
        }
        if (seen) capture("$name-receipt")
        File(output, "$name-receipt.txt").writeText("receipt=$title\nseen=$seen\n")
        compose.waitUntil(15_000) { !exists("card-review") }
    }
    private fun closeReview() {
        try { if (exists("card-review:close")) compose.onNodeWithTag("card-review:close").performClick() } catch (_: AssertionError) { /* It closed itself. */ }
        compose.waitUntil(15_000) { !exists("card-review") }
    }
    private fun semantics(name: String) = File(output, "$name-semantics.txt").writeText(compose.onAllNodes(isRoot()).printToString())
    /** Scrolls the transcript to [matcher] as a reader does: a drag first, which is what stops the reader following its tail
     * (a programmatic scroll alone is pinned back to the tail by the next read). */
    private fun scrollTranscriptTo(matcher: SemanticsMatcher) {
        compose.onNodeWithTag("transcript-list").performTouchInput { swipeDown() }
        compose.onNodeWithTag("transcript-list").performScrollToNode(matcher)
    }
    private fun journey(name: String, block: () -> Unit) {
        try { block(); File(output,"$name-result.txt").writeText("PASS\n") }
        catch (error: Throwable) { capture("$name-failed"); runCatching { semantics("$name-failed") }; throw error }
        finally { File(output,"$name-journal.json").writeText(http("/__stats").toString()); runBlocking { app.session.logout() } }
    }

    @Test fun rememberUsesExactRuleAndServerRecord() = journey("remember") {
        login("a1"); press("approval:a1:REMEMBER"); await("Allowed · recorded by the server")
        val journal = http("/__stats"); assertFalse(journal.flag("pending")); assertEquals("ALLOWED", journal.obj("final")?.text("status"))
        val sent = journal.objects("journal").last().obj("body")!!
        val expected = http("/__corpus").objects("requests").single { it.text("key") == "approval:a1" && it.text("verb") == "REMEMBER" }.obj("body")!!
        assertEquals(expected["rememberRules"], sent["rememberRules"]); capture("remember-recorded")
    }
    @Test fun attachmentOnlyMessageKeepsAttachmentWithoutRawJson() = journey("attachment-only") {
        login("attachment-only")
        compose.onNodeWithTag("transcript-list").performScrollToNode(hasTestTag("event:1"))
        compose.onNodeWithText("card-notes.txt").assertIsDisplayed()
        compose.onAllNodesWithText("\"attachments\"", substring = true).assertCountEquals(0)
        capture("attachment-only-readable")
    }
    @Test fun questionKeepsCustomAnswerThroughActivityRecreation() = journey("question") {
        login("a2")
        // A08-2: a question is a preview in the conversation, answered in the review it opens.
        compose.onNodeWithTag("approval:a2:preview").performScrollTo().performClick()
        compose.waitUntil(15_000) { exists("card-review") }
        compose.onNodeWithText("Core").performScrollTo().performClick()
        compose.onAllNodesWithText("Or type your own answer…")[1].performScrollTo().performTextInput("Server state")
        capture("question-review")
        compose.activityRule.scenario.recreate(); await("Decisions and requests")
        // The review stays open across the Activity being recreated, with what was typed in it.
        compose.waitUntil(15_000) { exists("card-review") }
        compose.onNodeWithText("Server state").assertExists()
        press("approval:a2:ANSWER")
        compose.waitUntil(15_000) { !http("/__stats").flag("pending") }
        receipt(CardPreviews.answerSent, "question")
        assertEquals("ALLOWED", http("/__stats").obj("final")?.text("status"))
        val answers = http("/__stats").objects("journal").last().obj("body")!!.obj("answers")!!
        assertEquals(listOf("Core"), answers.strings("Which scope?")); assertEquals(listOf("Server state"), answers.strings("Which evidence?")); capture("question-recorded")
    }
    @Test fun otherEndWinsWithoutClaimingThisPressSucceeded() = journey("other-end") {
        login("a1", "other-end"); press("approval:a1:ALLOW"); await("Denied · recorded by the server")
        assertEquals("DENIED", http("/__stats").obj("final")?.text("status")); capture("other-end-recorded")
    }
    @Test fun lostResponseDoesNotResendOrClaimSuccess() = journey("lost-response") {
        login("a1", "lost-response"); val before = http("/__stats").objects("journal").size
        press("approval:a1:ALLOW"); await("The request may have reached the server")
        capture("lost-response-uncertain")
        compose.activityRule.scenario.recreate(); await("Review the Orbit card below.")
        compose.waitUntil(15_000) { app.realtime.state.value.session?.fresh == true }
        compose.onNodeWithTag("approval:a1:ALLOW").assertDoesNotExist()
        assertEquals(before + 1, http("/__stats").objects("journal").size)
        assertEquals("ALLOWED", http("/__stats").obj("final")?.text("status")); capture("lost-response-checked")
    }
    @Test fun permissionRevocationWithdrawsTheEntireCard() = journey("permission") {
        login("a1", "forbidden"); press("approval:a1:ALLOW"); await("Session unavailable")
        compose.onNodeWithTag("interaction-cards").assertDoesNotExist(); capture("permission-withdrawn")
    }
    @Test fun evidenceAndOwnerDecisionsBindDisplayedRevisions() = journey("decisions") {
        login("evidence")
        val sid = http("/__corpus").text("taskId")!!
        press("evidence:$sid:7:CONFIRM_EVIDENCE"); await("Request accepted")
        assertEquals("7", http("/__stats").objects("journal").last().obj("body")!!.text("evidenceRevision"))
        http("/__control", """{"case":"owner"}"""); compose.runOnIdle { app.realtime.refreshSession() }; await(OwnerReview.heading)
        press("owner:$sid:owner1:CONFIRM_OWNER")
        compose.waitUntil(15_000) { http("/__stats").objects("journal").last().obj("body")?.text("requestId") == "owner1" }
        val body = http("/__stats").objects("journal").last().obj("body")!!
        assertEquals("owner1", body.text("requestId")); assertEquals("record1", body.text("reviewRecordId")); capture("owner-recorded")
    }

    @Test fun ownerQuestionsKeepEvidenceAndAnswersWithTheirQuestion() = journey("owner-question-evidence") {
        login("owner-review")
        val questions = http("/__review-corpus").objects("reviewQuestions")
        val firstRefs = questions[0].strings("evidenceRefs")
        val secondRefs = questions[1].strings("evidenceRefs")
        val task = http("/__corpus").text("taskId")
        // A08-1/A08-2: the owner's card is a preview here; its questions are answered in the review it opens.
        compose.onNodeWithTag("owner:$task:owner1:preview").performScrollTo().performClick()
        compose.waitUntil(15_000) { exists("owner-question:${questions[1].text("key")}") }
        fun question(index: Int) = hasAnyAncestor(hasTestTag("owner-question:${questions[index].text("key")}"))
        fun fold(index: Int) = compose.onNodeWithTag("owner-question:${questions[index].text("key")}:evidence")
        questions.indices.forEach { fold(it).assertTextEquals(OwnerReview.reviewEvidence) }
        (firstRefs + secondRefs).forEach { compose.onNodeWithText(it).assertDoesNotExist() }
        fold(0).performScrollTo().performClick()
        firstRefs.forEach { compose.onNode(hasText(it) and question(0)).performScrollTo().assertIsDisplayed() }
        secondRefs.forEach { compose.onNodeWithText(it).assertDoesNotExist() }
        capture("owner-first-question-evidence")
        fold(1).performScrollTo().performClick()
        secondRefs.forEach { compose.onNode(hasText(it) and question(1)).performScrollTo().assertIsDisplayed() }
        firstRefs.forEach { compose.onNode(hasText(it) and question(1)).assertDoesNotExist() }
        fold(0).performScrollTo().performClick()
        firstRefs.forEach { compose.onNodeWithText(it).assertDoesNotExist() }
        secondRefs.forEach { compose.onNode(hasText(it) and question(1)).performScrollTo().assertIsDisplayed() }
        val confirm = "owner:$task:owner1:CONFIRM_OWNER"
        compose.onNodeWithTag(confirm).assertIsEnabled()
        questions.forEachIndexed { index, q ->
            val recommended = q.objects("options")[q.number("recommendedOption")!!].text("label")!!
            compose.onNode(hasText(recommended) and hasText(OwnerReview.recommended) and question(index)).assertIsSelected()
        }
        compose.onNode(hasText(OwnerReview.otherOwnWords) and question(1)).performScrollTo().performClick()
        compose.onNodeWithTag(confirm).assertIsNotEnabled()
        compose.onNodeWithTag("owner-question:${questions[1].text("key")}:other").performScrollTo().performTextInput("Keep the rollout evidence open")
        semantics("owner-question-evidence")
        capture("owner-second-question-evidence")
        press(confirm)
        compose.waitUntil(15_000) { !http("/__stats").flag("pending") }
        val body = http("/__stats").objects("journal").last().obj("body")!!
        assertEquals("owner1", body.text("requestId")); assertEquals("record1", body.text("reviewRecordId"))
        assertEquals(listOf(
            buildJsonObject { put("key", questions[0].text("key")); put("option", questions[0].number("recommendedOption")) },
            buildJsonObject { put("key", questions[1].text("key")); put("text", "Keep the rollout evidence open") }
        ), body.objects("answers"))
    }

    @Test fun singleTaskShowsTheServerDestinationAndHonestFallbacks() = journey("single-task-destination") {
        login("a4", "single-preview")
        val destination = http("/__review-corpus").obj("taskCreatePreview")!!.objects("lists").first().text("title")!!
        compose.onNodeWithText("Into $destination").performScrollTo().assertIsDisplayed()
        compose.onNodeWithTag("approval:a4:CREATE_TASK").assertIsEnabled()
        capture("single-task-server-list")
        http("/__control", """{"case":"a4","mode":"single-no-preview"}""")
        compose.runOnIdle { app.realtime.refreshSession() }; await("Into Legacy list")
        compose.onNodeWithText("Into Legacy list").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("Into $destination").assertDoesNotExist()
        capture("single-task-fallback-list")
        http("/__control", """{"case":"a4","mode":"single-no-lists"}""")
        compose.runOnIdle { app.realtime.refreshSession() }
        compose.waitUntil(15_000) { app.realtime.state.value.session?.snapshot?.approvals?.singleOrNull()?.obj("input")?.obj("preview")?.get("lists") == JsonArray(emptyList()) }
        compose.onNodeWithText("Into $destination").assertDoesNotExist()
        compose.onNodeWithText("Into Legacy list").assertDoesNotExist()
        capture("single-task-no-destination")
        press("approval:a4:CREATE_TASK"); await("Allowed · recorded by the server")
        val journal = http("/__stats")
        assertFalse(journal.flag("pending")); assertEquals("ALLOWED", journal.obj("final")?.text("status"))
        assertEquals(buildJsonObject { put("behavior", "allow") }, journal.objects("journal").last()["body"])
    }

    @Test fun reassignedExceptionAfterSentRestoresNewActions() = exceptionAssignments("assignment-sent")
    @Test fun reassignedExceptionAfterLostResponseRestoresNewActions() = exceptionAssignments("assignment-lost")

    private fun exceptionAssignments(mode: String) = journey(mode) {
        login("x1", mode)
        val before = http("/__stats").objects("journal").size
        val patches = http("/__review-corpus").objects("exceptionAssignmentChanges")
        val send = "item:x1:RETURN_COORDINATOR"
        val resolve = "item:x1:MARK_HANDLED"
        press(send); await(if (mode == "assignment-lost") "The request may have reached the server" else "Request accepted")
        compose.onNodeWithTag(send).assertIsNotEnabled()
        compose.activityRule.scenario.recreate(); await("Decisions and requests")
        compose.waitUntil(15_000) { app.realtime.state.value.session?.fresh == true }
        await(if (mode == "assignment-lost") "The request may have reached the server" else "Request accepted")
        compose.onNodeWithTag(send).assertIsNotEnabled()
        assertEquals(before + 1, http("/__stats").objects("journal").size)
        fun assignment(index: Int) {
            http("/__control", """{"assignment":$index,"mode":"assignment-sent"}""")
            compose.runOnIdle { app.realtime.refreshSession() }
            compose.waitUntil(15_000) {
                val session = app.realtime.state.value.session
                val items = session?.snapshot?.standing?.get("openItems") as? JsonObject
                val rows = items?.objects(if (index % 2 == 0) "needsYou" else "withCoordinator")
                session?.fresh == true && rows?.singleOrNull()?.text("waitingSince") == patches[index].text("waitingSince")
            }
        }
        for (round in 1..2) {
            assignment(round * 2 - 1)
            compose.onNodeWithTag(send).assertDoesNotExist()
            assignment(round * 2)
            // A new assignment must be actionable, even when the previous reply was lost.
            compose.onNodeWithTag(send).performScrollTo().assertIsEnabled()
            compose.onNodeWithTag(resolve).assertIsEnabled()
            assertEquals(before + round, http("/__stats").objects("journal").size)
            capture("$mode-owner-round-$round")
            if (round == 1) { press(send); await("Request accepted"); compose.onNodeWithTag(send).assertIsNotEnabled() }
        }
        press(resolve)
        compose.onNodeWithTag(resolve).assertIsNotEnabled()
        compose.onNodeWithText("Why is it no longer open?").performScrollTo().performTextInput("Reviewed the second assignment")
        press(resolve); await("Request accepted")
        val stats = http("/__stats")
        assertEquals(before + 3, stats.objects("journal").size)
        assertFalse(stats.flag("pending")); assertEquals("RESOLVED", stats.obj("final")?.text("state"))
        assertEquals(buildJsonObject { put("note", "Reviewed the second assignment") }, stats.objects("journal").last()["body"])
    }

    @Test fun dedicatedBusinessDoorsProduceSeparateRequestsAndRecordedStates() = journey("business-doors") {
        login("a3")
        val corpus = http("/__corpus")
        val cases = listOf(
            Triple("a3", "approval:a3", "KEEP_PLANNING"),
            Triple("a4", "approval:a4", "CREATE_TASK"), Triple("a4p", "approval:a4p", "CREATE_PROJECT"),
            Triple("a5", "approval:a5", "CREATE_BATCH"), Triple("a6", "approval:a6", "CHANGE_DAG"),
            Triple("a7", "approval:a7", "RESOLVE_BLOCKER"), Triple("a8", "approval:a8", "DENY"),
            Triple("criteria", "criteria:intent1", "APPROVE_CRITERIA"),
            Triple("q1", "item:q1", "OWNER_ANSWER"), Triple("x1", "item:x1", "RETRY_TASK"),
            Triple("f1", "item:f1", "RESUME"), Triple("promotion", "promotion:promotion1", "CONFIRM_MERGE"),
            Triple("start", "start:start1", "START"),
            Triple("acceptance", "acceptance:${corpus.text("projectId")}:seal1", "CONFIRM_CRITERIA"))
        cases.forEach { (kind, key, verb) ->
            http("/__control", """{"case":"$kind"}"""); compose.runOnIdle { app.realtime.refreshSession() }
            val before = http("/__stats").objects("journal").size
            press("$key:$verb")
            compose.waitUntil(15_000) { http("/__stats").objects("journal").size > before && !http("/__stats").flag("pending") }
            val recorded = http("/__stats").objects("journal").last()
            assertEquals(kind, recorded.text("case")); assertEquals(200, recorded.number("status"))
            corpus.objects("requests").firstOrNull { it.text("key") == key && it.text("verb") == verb }?.let { assertEquals(it["body"], recorded["body"]) }
            if (kind == "promotion") assertEquals("CONFIRMED", recorded.obj("final")!!.text("state")) // Accepted, not merged.
            semantics(kind)
            capture("business-$kind")
            closeReview()
        }
    }

    // A08c: the needs-you bar and the card increments, each read back from the fixture's own record.

    /** What waits in this conversation is one press away; a card answered in a review opens straight into it (A08-3). */
    @Test fun needsYouBarOpensWhatWaitsHere() = journey("needs-you-here") {
        login("owner")
        await("1 open question below"); capture("needs-you-here-bar")
        compose.onNodeWithTag("needs-you-bar").performClick()
        compose.waitUntil(15_000) { exists("card-review") }
        compose.onNodeWithTag("card-review:title").assertTextEquals(OwnerReview.heading)
        capture("needs-you-here-review")
        closeReview()
        // An exception that became the owner's is a door, not a question: the bar says "waiting" and brings the card into view.
        http("/__control", """{"case":"x1"}"""); compose.runOnIdle { app.realtime.refreshSession() }
        await("1 waiting below")
        compose.onNodeWithTag("needs-you-bar").performClick()
        compose.waitUntil(15_000) { compose.onAllNodes(hasTestTag("item:x1:RETRY_TASK") and isEnabled()).fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithTag("item:x1").assertIsDisplayed()
        assertFalse(exists("card-review")); capture("needs-you-here-door")
    }

    /** Another open session that needs you is named by the bar, and its press opens that session. */
    @Test fun needsYouBarOpensTheSessionWaitingElsewhere() = journey("needs-you-elsewhere") {
        login("a1", "elsewhere")
        val second = http("/__a08c").obj("secondSession")!!
        await("${second.obj("agent")!!.text("name")} needs you"); capture("needs-you-elsewhere-bar")
        compose.onNodeWithTag("needs-you-bar").performClick()
        compose.waitUntil(15_000) { ObjectId.same(app.realtime.state.value.session?.id, second.text("id")) }
        await(second.text("title")!!)
        scrollTranscriptTo(hasText("The second session waits on you."))
        compose.onNodeWithTag("approval:b1:ALLOW").performScrollTo().assertIsDisplayed()
        // The session it opened is the one waiting; nothing else waits elsewhere now, so the bar has nothing to say.
        assertFalse(exists("needs-you-bar"))
        capture("needs-you-elsewhere-opened")
    }

    /** A08-1: a confirmation whose review found problems afterwards keeps that review on its receipt; Reopen task is the
     * server's to record, and once it has, the receipt stops offering it. */
    @Test fun ownerReceiptKeepsItsReviewAndReopensTheTask() = journey("owner-receipt") {
        login("owner-receipt")
        val task = http("/__corpus").text("taskId")!!
        val problems = http("/__a08c").obj("decision")!!.obj("review")!!.obj("problems")!!.objects("problems")
        await(OwnerReview.confirmedHeading); await("1 problem found after you confirmed")
        problems.forEach { compose.onNodeWithText(it.text("text")!!).performScrollTo().assertIsDisplayed() }
        capture("owner-receipt-review")
        press("review-bar:reopen")
        await(TaskReopenCopy.modalTitle); capture("owner-receipt-reopen-asks")
        compose.onNodeWithTag("confirm:REOPEN_TASK").performClick()
        compose.waitUntil(15_000) { http("/__stats").let { it.objects("journal").lastOrNull()?.text("method") == "PATCH" && !it.flag("pending") } }
        val row = http("/__stats").objects("journal").last()
        assertEquals("/api/tasks/$task", row.text("path")); assertEquals(200, row.number("status"))
        assertEquals(buildJsonObject { put("status", "OPEN"); put("supersededByTaskId", JsonNull); put("terminalReason", JsonNull) }, row["body"])
        compose.waitUntil(15_000) { !exists("review-bar:reopen") }
        capture("owner-receipt-reopened")
    }

    /** A08-7: a batch's review lists its tasks by level, opens each task's own page, and its yes names the count. */
    @Test fun batchReviewShowsLevelsAndEachTaskPage() = journey("batch-review") {
        login("a5")
        val preview = http("/__corpus").obj("snapshot")!!.objects("approvals").single { it.text("id") == "a5" }.obj("input")!!.obj("preview")!!
        compose.onNodeWithTag("approval:a5:preview").performScrollTo().performClick()
        compose.waitUntil(15_000) { exists("batch-level:2") }
        compose.onNodeWithTag("card-review:title").assertTextEquals(CardPreviews.batchTitle(2))
        preview.objects("tasks").forEach { compose.onNodeWithText(it.text("title")!!).performScrollTo().assertIsDisplayed() }
        capture("batch-review-levels")
        compose.onNodeWithTag("batch-row:2").performScrollTo().performClick()
        compose.waitUntil(15_000) { exists("batch-task-page:2") }
        capture("batch-review-task-page")
        compose.onNodeWithTag("batch-task-page:back").performScrollTo().performClick()
        compose.waitUntil(15_000) { exists("batch-level:1") }
        compose.onNodeWithTag("approval:a5:CREATE_BATCH").assertTextEquals(BatchReview.createAction(2))
        press("approval:a5:CREATE_BATCH")
        compose.waitUntil(15_000) { !http("/__stats").flag("pending") }
        val recorded = http("/__stats").objects("journal").last()
        assertEquals(200, recorded.number("status")); assertEquals("allow", recorded.obj("body")!!.text("behavior"))
        http("/__corpus").objects("requests").firstOrNull { it.text("key") == "approval:a5" && it.text("verb") == "CREATE_BATCH" }
            ?.let { assertEquals(it["body"], recorded["body"]) }
        receipt(CardPreviews.answerSent, "batch-review")
    }

    /** A08-4: the queue's turns wait at the transcript's end as the turns they will be; Cancel withdraws one on the server. */
    @Test fun queuedTurnsWaitAtTheEndAndCancelOnTheServer() = journey("queued") {
        login("queue", ready = "Review the Orbit card below.")
        val queue = http("/__a08c").objects("queue")
        fun tag(turn: JsonObject) = "queued:" + turn.text("turnId")!!.let { ObjectId.canonical(it) ?: it }
        compose.waitUntil(15_000) { app.realtime.state.value.session?.let { it.fresh && it.snapshot?.queuedTurns?.size == queue.size } == true }
        // The list composes only what is on screen: each queued turn is scrolled to before it is read.
        fun show(turn: JsonObject) = scrollTranscriptTo(hasTestTag(tag(turn)))
        fun cancel(turn: JsonObject) = compose.onNode(hasTestTag("queued-foot:cancel") and hasAnyAncestor(hasTestTag(tag(turn))))
        show(queue[0]); await(queue[0].text("content")!!); cancel(queue[0]).assertExists()
        capture("queued-tail")
        show(queue[1]); compose.onNode(hasTestTag("queued-steer") and hasAnyAncestor(hasTestTag(tag(queue[1])))).assertExists()
        cancel(queue[1]).assertDoesNotExist()
        show(queue[2]); cancel(queue[2]).performScrollTo().assertExists()
        capture("queued-reply")
        show(queue[0]); cancel(queue[0]).performScrollTo().performClick()
        compose.waitUntil(15_000) { http("/__stats").objects("journal").any { it.text("method") == "DELETE" } }
        val row = http("/__stats").objects("journal").single { it.text("method") == "DELETE" }
        assertEquals("/api/sessions/${http("/__corpus").text("sessionId")}/turns/${queue[0].text("turnId")}", row.text("path"))
        assertEquals(200, row.number("status"))
        // The server's queue no longer lists it, and neither does the transcript's end.
        compose.waitUntil(15_000) { app.realtime.state.value.session?.snapshot?.queuedTurns?.size == queue.size - 1 }
        show(queue[1]); assertFalse(exists(tag(queue[0]))); capture("queued-cancelled")
    }

    /** A08-5: a run that never started says why, and "Start it again" is a new run of the task the server records. */
    @Test fun aRunThatNeverStartedOffersANewRun() = journey("run-start") {
        login("run-start", ready = SessionRunStart.title)
        val task = http("/__corpus").text("taskId")!!
        val refused = http("/__a08c").obj("refused")!!
        await(SessionRunStart.refusalProse("FIX_REF").first); await(refused.text("sourceRefusalCode")!!)
        capture("run-start-card")
        press("session-run-start:START_IT_AGAIN")
        compose.waitUntil(15_000) { http("/__stats").objects("journal").any { it.text("path") == "/api/tasks/$task/execute" } }
        val row = http("/__stats").objects("journal").single { it.text("path") == "/api/tasks/$task/execute" }
        assertEquals("POST", row.text("method")); assertEquals(200, row.number("status"))
        assertFalse(row.obj("body")!!.text("triggerId").isNullOrBlank())
        await(SessionRunStart.startingAgain); capture("run-start-again")
    }

    /** A08-6: what this conversation created is one Tasks card above the composer; opened, a row per task. */
    @Test fun theTasksCardListsWhatThisConversationCreated() = journey("session-tasks") {
        login("created", ready = "Review the Orbit card below.")
        val created = http("/__a08c").obj("created")!!
        compose.waitUntil(15_000) { exists("session-tasks") }
        await("1 running"); await("1 failed"); await("1/3 done")
        capture("session-tasks-folded")
        compose.onNodeWithTag("session-tasks:line").performClick()
        created.objects("items").forEach { compose.onNodeWithTag("created-task:${it.text("id")}").performScrollTo().assertIsDisplayed() }
        await("Replaces Reconnect spec, first try")
        capture("session-tasks-open")
    }

    /** A08-11: a wake turn is one line; it opens into what the job did, and a failed job's output tail folds on its own. */
    @Test fun aWakeTurnIsOneLineThatOpens() = journey("wake") {
        login("wake", ready = "Review the Orbit card below.")
        compose.onNodeWithTag("transcript-list").performScrollToNode(hasTestTag("background-wake"))
        await("Background job failed"); await("watch main CI 34997433169")
        compose.onAllNodesWithText("<background-job-wake>", substring = true).assertCountEquals(0)
        capture("wake-line")
        compose.onNodeWithTag("background-wake:line").performClick()
        compose.waitUntil(15_000) { exists("background-wake:fold") }
        capture("wake-fold")
        compose.onNodeWithTag("background-wake:toggle-output").performScrollTo().performClick()
        compose.onNodeWithTag("background-wake:toggle-output").assertTextEquals(BackgroundWakeCard.collapseOutput)
        capture("wake-output-open")
    }

    /** A08-8: a merge-check change offers no standing yes, and saying no is a conversation the server records with its words. */
    @Test fun aMergeCheckChangeAsksWithNoStandingYes() = journey("merge-check") {
        login("a9")
        compose.onNodeWithTag("approval:a9:ALLOW").performScrollTo().assertIsEnabled()
        assertFalse(exists("approval:a9:REMEMBER")); assertFalse(exists("approval:a9:DENY"))
        capture("merge-check-card")
        press("approval:a9:CHAT")
        compose.onNodeWithText("Say what to do instead…").performScrollTo().performTextInput("Keep the full gate")
        press("approval:a9:CHAT"); await("Denied · recorded by the server")
        val sent = http("/__stats").objects("journal").last().obj("body")!!
        assertEquals("deny", sent.text("behavior")); assertEquals("Keep the full gate", sent.text("message")); assertNull(sent["rememberRules"])
        capture("merge-check-recorded")
    }

    /** The host runs these two methods separately, force-stopping the process between them. */
    @Test fun coldPrepareFence() {
        login("a1", "lost-response-pending")
        press("approval:a1:ALLOW"); await("The request may have reached the server")
        compose.onNodeWithTag("approval:a1:ALLOW").assertIsNotEnabled()
        File(output,"cold-prepare-pid.txt").writeText(Process.myPid().toString())
        File(output,"cold-before.json").writeText(http("/__stats").toString())
        capture("cold-before")
    }
    @Test fun coldRestoreFence() = journey("cold-restore") {
        instrument.sendStatus(0, Bundle().apply { putString("a08_pid", Process.myPid().toString()) })
        compose.waitUntil(15_000) { app.session.state.value is AuthState.SignedIn && app.realtime.state.value.directoryFresh }
        // force-stop + launcher is a new navigation task. Re-enter the conversation normally.
        compose.onNodeWithTag("workspace:01a0cca7-8609-70ed-a0e2-d4b55b832b61").performClick()
        compose.onNodeWithText("Card verification").performClick()
        compose.waitUntil(15_000) { app.realtime.state.value.session?.fresh == true }
        await("The request may have reached the server")
        compose.onNodeWithTag("approval:a1:ALLOW").performScrollTo().assertIsNotEnabled()
        val before = Wire.json.parseToJsonElement(File(output,"cold-before.json").readText()).jsonObject
        assertEquals(before.objects("journal"), http("/__stats").objects("journal"))
        assertNotEquals(File(output,"cold-prepare-pid.txt").readText(), Process.myPid().toString())
        File(output,"cold-restore-pid.txt").writeText(Process.myPid().toString())
        capture("cold-restored")
    }
}
