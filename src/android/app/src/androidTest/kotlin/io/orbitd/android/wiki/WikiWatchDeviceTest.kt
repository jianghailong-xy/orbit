package io.orbitd.android.wiki

import android.content.Intent
import android.graphics.Bitmap
import android.net.Uri
import android.os.Bundle
import android.os.Process
import android.util.Log
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import io.orbitd.android.BuildConfig
import io.orbitd.android.MainActivity
import io.orbitd.android.OrbitApplication
import io.orbitd.android.core.auth.AuthState
import io.orbitd.android.core.net.ServerAddress
import io.orbitd.android.core.protocol.Wire
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.net.HttpURLConnection
import java.net.URL

/** The production Activity, AuthSession and navigation against the loopback fixture (scripts/wiki-watch-fixture.py):
 * each journey signs in through the real login form from a cold-start link, acts through the screens, and reads the
 * fixture's journal and state back. Controlled HTTP only — not a deployed backend, iOS parity or a physical phone. */
@RunWith(AndroidJUnit4::class)
class WikiWatchDeviceTest {
    @get:Rule val compose = createEmptyComposeRule()
    private val instrument get() = InstrumentationRegistry.getInstrumentation()
    private val app get() = instrument.targetContext.applicationContext as OrbitApplication
    private val output get() = File(app.filesDir, "a12-wiki-watch").also { it.mkdirs() }
    private val server = "http://127.0.0.1:18770"

    private fun http(path: String, body: String? = null): JsonObject = (URL(server + path).openConnection() as HttpURLConnection).run {
        connectTimeout = 5_000; readTimeout = 5_000
        if (body != null) { requestMethod = "POST"; doOutput = true; outputStream.use { it.write(body.toByteArray()) } }
        try { check(responseCode == 200); Wire.json.parseToJsonElement(inputStream.bufferedReader().use { it.readText() }).jsonObject }
        finally { disconnect() }
    }
    private fun JsonObject.string(key: String) = getValue(key).jsonPrimitive.content
    private fun journal(): List<JsonObject> = http("/__stats").getValue("journal").jsonArray.map { it.jsonObject }
    private fun requests(method: String, suffix: String) = journal().filter { it.string("method") == method && it.string("path").substringBefore('?').endsWith(suffix) }
    private fun await(text: String, timeout: Long = 20_000) {
        compose.waitUntil(timeout) { compose.onAllNodesWithText(text, substring = true).fetchSemanticsNodes().isNotEmpty() }
    }
    private fun awaitTag(tag: String, timeout: Long = 20_000) {
        compose.waitUntil(timeout) { compose.onAllNodes(hasTestTag(tag)).fetchSemanticsNodes().isNotEmpty() }
    }
    private fun press(tag: String) {
        compose.waitUntil(15_000) { compose.onAllNodes(hasTestTag(tag) and isEnabled()).fetchSemanticsNodes().isNotEmpty() }
        // At a large font a control can sit below its page's fold: it is scrolled into view first, as a person would.
        if (compose.onAllNodes(hasTestTag(tag) and hasAnyAncestor(hasScrollAction())).fetchSemanticsNodes().isNotEmpty())
            compose.onNodeWithTag(tag).performScrollTo()
        compose.onNodeWithTag(tag).performClick()
    }
    /** A row of a lazy list: scrolled into view first, then pressed. */
    private fun pressIn(list: String, tag: String) {
        awaitTag(list)
        compose.waitUntil(15_000) {
            runCatching { compose.onNodeWithTag(list).performScrollToNode(hasTestTag(tag)) }.isSuccess
        }
        press(tag)
    }
    private fun capture(name: String) {
        // Let the frame on screen catch up with the tree the test just read.
        compose.waitForIdle(); Thread.sleep(500)
        // A dialog or a sheet is a second root: every root's tree is kept.
        val roots = compose.onAllNodes(isRoot())
        File(output, "$name-semantics.txt").writeText((0 until roots.fetchSemanticsNodes().size).joinToString("\n\n") { roots[it].printToString() })
        // UiAutomation answers null when the device is too starved to take one in time (seen under host load): it is
        // asked again, and a capture still without one says so beside its semantics tree instead of failing the journey.
        val bitmap = (1..3).firstNotNullOfOrNull { attempt -> instrument.uiAutomation.takeScreenshot() ?: null.also { Thread.sleep(1_000L * attempt) } }
        if (bitmap == null) { File(output, "$name-screenshot-missing.txt").writeText("takeScreenshot returned null 3 times\n"); return }
        File(output, "$name.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }; bitmap.recycle()
    }
    private fun launch(raw: String) = Intent(Intent.ACTION_VIEW, Uri.parse(raw), app, MainActivity::class.java)
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)

    /** A cold start from [target]'s link, then [block]; the journal is kept whatever happens. A [throughLogin] journey
     * signs in on the login form, which the link waits on across recreation; the others sign in before the Activity
     * starts. AuthSession publishes SignedIn and SignedOut from its own thread, and under the Compose test rule (an
     * unconfined test dispatcher) a live composition collecting that state can resume and recompose on that thread
     * (CalledFromWrongThreadException at dark/200%, emulator-5554); the app's own dispatcher always resumes on the
     * main thread. So only the journey about the login form signs in while a composition is up, and every journey
     * signs out after its Activity is gone. */
    private fun journey(name: String, target: (JsonObject) -> String, throughLogin: Boolean = false,
        block: (ActivityScenario<MainActivity>, JsonObject) -> Unit) {
        http("/__control", """{"reset":true}""")
        val ids = http("/__ids")
        instrument.sendStatus(0, Bundle().apply { putString("a12_pid", Process.myPid().toString()) })
        File(output, "$name-identity.txt").writeText("sha=${BuildConfig.SOURCE_SHA}\ndirty=${BuildConfig.SOURCE_DIRTY}\nfixture=loopback-18770\n" +
            "link=${target(ids)}\nlogin=${if (throughLogin) "form" else "before-launch"}\n")
        // Restore is the Activity's to start; it is idempotent, so the journey starts it, then signs out.
        runBlocking { app.session.restore(); app.session.logout() }
        assertTrue(app.session.state.value is AuthState.SignedOut)
        if (!throughLogin) runBlocking { app.session.login(ServerAddress.parse(server, true), "a12@example.test", "a12-fixture-password") }
        try {
            ActivityScenario.launch<MainActivity>(launch(target(ids))).use { scenario ->
                try {
                    if (throughLogin) {
                        await("Email")
                        // The link waits on the login form, across recreation.
                        scenario.recreate()
                        compose.onNodeWithText("Instance address").performTextReplacement(server)
                        compose.onNodeWithText("Email").performTextInput("a12@example.test")
                        compose.onNodeWithText("Password").performTextInput("a12-fixture-password")
                        compose.onAllNodesWithText("Sign in")[1].performScrollTo().performClick()
                    }
                    compose.waitUntil(20_000) { app.session.state.value is AuthState.SignedIn && app.realtime.state.value.directoryFresh }
                    block(scenario, ids)
                    File(output, "$name-result.txt").writeText("PASS · controlled HTTP only\n")
                } catch (error: Throwable) {
                    // Written down first: a crash while the scenario closes would otherwise lose what failed.
                    File(output, "$name-failure.txt").writeText(error.stackTraceToString())
                    Log.e("A12", "journey $name failed", error)
                    capture("$name-failed"); throw error
                }
            }
        } finally { File(output, "$name-journal.json").writeText(http("/__stats").toString()); runBlocking { app.session.logout() } }
    }

    // MARK: the Wiki

    /** `orbit://wiki/<space>` (the notification's space) opens that space's home, through login and recreation. */
    @Test fun aSpaceLinkOpensItsHomeThroughLoginAndRecreation() = journey("space-link", { "orbit://wiki/${it.string("space")}" }, throughLogin = true) { scenario, ids ->
        awaitTag("wiki-status-line")
        compose.onNodeWithTag("wiki-space-picker").assertTextContains("a12-fixture")
        compose.onNodeWithText("Principles").assertExists()
        listOf("GET /api/wiki/spaces", "/api/wiki/spaces/${ids.string("space")}/entries", "/timeline", "/health").forEach { path ->
            assertTrue("missing read $path", journal().any { it.string("method") == "GET" && it.string("path").substringBefore('?').endsWith(path.removePrefix("GET ")) })
        }
        capture("space-home")
        scenario.recreate()
        awaitTag("wiki-status-line")
        // The Contents sheet: Home, Browse, the index and the plan, then the confirmed plan's documents.
        press("wiki-bar-contents")
        awaitTag("wiki-contents-sheet")
        compose.onNodeWithTag("wiki-contents-browse").assertExists()
        compose.onNodeWithTag("wiki-contents-plan").assertExists()
        capture("space-contents")
    }

    /** Search under the title finds the entry; Edit writes once, with the base revision, and the page shows the server's answer. */
    @Test fun searchOpensAnEntryAndEditWritesOnceWithItsRevision() = journey("search-edit", { "orbit://wiki/${it.string("space")}" }) { scenario, ids ->
        awaitTag("wiki-search")
        compose.onNodeWithTag("wiki-search").performTextInput("A12 Wiki")
        press("wiki-hit:${ids.string("entry")}")
        awaitTag("wiki-entry-title")
        compose.onNodeWithTag("wiki-entry-title").assertTextEquals("A12 Wiki source entry")
        assertEquals(1, requests("GET", "/api/wiki/search").size)
        press("wiki-entry-edit")
        awaitTag("wiki-entry-form-summary")
        compose.onNodeWithTag("wiki-entry-form-summary").performTextReplacement("Edited on Android with server readback.")
        scenario.recreate()
        awaitTag("wiki-entry-form-summary")
        compose.onNodeWithTag("wiki-entry-form-summary").assertTextContains("Edited on Android with server readback.")
        press("wiki-entry-form-save")
        compose.waitUntil(15_000) { http("/__stats").getValue("entry").jsonObject.string("summary") == "Edited on Android with server readback." }
        val writes = requests("POST", "/changesets")
        assertEquals(1, writes.size)
        val op = writes.single().getValue("body").jsonObject.getValue("ops").jsonArray.single().jsonObject
        assertEquals("amend", op.string("op")); assertEquals(1, op.getValue("baseRevision").jsonPrimitive.int)
        // The page says it landed and reads the entry again (iOS's entry page draws no summary; the lists do).
        await("Saved")
        val write = journal().indexOfLast { it.string("method") == "POST" && it.string("path").endsWith("/changesets") }
        compose.waitUntil(15_000) { journal().drop(write + 1).any { it.string("method") == "GET" && it.string("path").contains("/api/wiki/entries/${ids.string("entry")}") } }
        capture("search-edit-recorded")
        // Back returns to the home, the query still in its field.
        compose.onNodeWithContentDescription("Back").performClick()
        compose.onNodeWithTag("wiki-search").assertTextContains("A12 Wiki")
    }

    /** An entry a review mode applied: Confirm is the owner's answer, and its turn source opens the session; Back returns. */
    @Test fun anEntryLinkConfirmsAndItsSourceOpensTheSessionThenReturns() = journey("entry-source", { "orbit-wiki:${it.string("entry")}" }) { _, ids ->
        awaitTag("wiki-entry-title")
        press("wiki-entry-confirm")
        compose.waitUntil(15_000) { http("/__stats").getValue("entry").jsonObject.string("trust") == "confirmed" }
        assertEquals(1, requests("POST", "/api/wiki/entries/${ids.string("entry")}/confirm").size)
        await("Confirmed")
        capture("entry-confirmed")
        // The source's card names the session it cites.
        compose.waitUntil(15_000) { requests("POST", "/api/link-previews").isNotEmpty() }
        pressIn("wiki-entry-list", "wiki-source:${ids.string("source")}")
        compose.waitUntil(20_000) { app.realtime.state.value.session?.id == ids.string("session") }
        capture("entry-source-session")
        compose.onNodeWithContentDescription("Back").performClick()
        awaitTag("wiki-entry-title")
        compose.onNodeWithTag("wiki-entry-title").assertTextEquals("A12 Wiki source entry")
    }

    /** Review: the banner opens it, Accept records one decision, and the next card takes its place. */
    @Test fun reviewAcceptRecordsOneDecisionAndMovesOn() = journey("review", { "orbit://wiki/${it.string("space")}" }) { _, _ ->
        press("wiki-review-banner")
        awaitTag("wiki-review-page")
        compose.onNodeWithTag("wiki-review-position").assertTextEquals("1 of 2")
        capture("review-first")
        press("wiki-review-accept")
        compose.waitUntil(15_000) { requests("POST", "/decide").isNotEmpty() }
        val decision = requests("POST", "/decide").single().getValue("body").jsonObject.getValue("decisions").jsonArray.single().jsonObject
        assertEquals("accept", decision.string("action"))
        compose.waitUntil(15_000) { compose.onAllNodesWithTag("wiki-review-position").fetchSemanticsNodes().isEmpty() }
        await("Accepted")
        capture("review-recorded")
        // Reject asks for its reason and sends it.
        press("wiki-review-reject")
        press("wiki-review-reject:too_specific")
        compose.waitUntil(15_000) { requests("POST", "/decide").size == 2 }
        assertEquals("too_specific", requests("POST", "/decide").last().getValue("body").jsonObject.getValue("decisions").jsonArray.single().jsonObject.string("reason"))
        awaitTag("wiki-review-empty")
    }

    /** Recently changed folds the maintenance run into one row; its page offers Revert run…, which asks, then reverts once. */
    @Test fun aRunRowOpensItsPageAndRevertAsksThenRevertsOnce() = journey("run", { "orbit://wiki/${it.string("space")}" }) { _, ids ->
        pressIn("wiki-home-list", "wiki-run:${ids.string("changeset")}")
        awaitTag("wiki-run-title")
        compose.onNodeWithTag("wiki-run-title").assertTextEquals("Applied 5 changes")
        capture("run-page")
        press("wiki-run-revert")
        await("Revert this run?")
        assertTrue(requests("POST", "/revert").isEmpty())
        press("wiki-run-revert-confirm")
        compose.waitUntil(15_000) { requests("POST", "/revert").size == 1 }
        // Reverted: the page closes back to the home.
        awaitTag("wiki-status-line")
        capture("run-reverted")
    }

    /** The confirmed plan's document from Contents; a footnote's source opens the session at the quoted record (the
     * deep link a footnote rests on), and Back returns to the same document, where the reader was. */
    @Test fun aDocumentsFootnoteOpensTheQuotedRecordAndBackReturns() = journey("doc-source", { "orbit://wiki/${it.string("space")}" }) { _, ids ->
        press("wiki-bar-contents")
        awaitTag("wiki-contents-sheet")
        press("wiki-contents-doc:session-runtime")
        awaitTag("wiki-doc-list")
        capture("doc-page")
        // Footnote 30 quotes a turn of the inherited session (the fixture points it at A06's record).
        pressIn("wiki-doc-list", "wiki-doc-footnote:30")
        awaitTag("wiki-doc-footnote-sheet")
        capture("doc-footnote-sheet")
        press("wiki-doc-source-open")
        compose.waitUntil(20_000) { app.realtime.state.value.session?.id == ids.string("session") }
        compose.waitUntil(20_000) { journal().any { it.string("path").contains("/events/page") && it.string("path").contains("around=") } }
        await("Jump to latest")
        capture("doc-source-record")
        compose.onNodeWithContentDescription("Back").performClick()
        awaitTag("wiki-doc-list")
        compose.onNodeWithTag("wiki-doc-footnote:30").assertExists()
        capture("doc-returned")
    }

    /** The plan from Contents: the draft waiting for the owner is confirmed once, the version in force becomes it,
     * and one of its documents opens as its own page. */
    @Test fun thePlanConfirmsItsDraftAndOpensOneOfItsDocuments() = journey("plan", { "orbit://wiki/${it.string("space")}" }) { _, _ ->
        // A draft (v2) waits on the owner, over the version in force (v1).
        http("/__control", """{"draft":"v2"}""")
        press("wiki-bar-contents")
        awaitTag("wiki-contents-sheet")
        press("wiki-contents-plan")
        awaitTag("wiki-plan-confirm")
        capture("plan-draft")
        press("wiki-plan-confirm")
        compose.waitUntil(15_000) { requests("POST", "/plan/versions/2/confirm").size == 1 }
        compose.waitUntil(15_000) { http("/__stats").getValue("plan").jsonObject.getValue("confirmed").jsonObject.getValue("version").jsonPrimitive.int == 2 }
        await("Plan v2 confirmed")
        capture("plan-confirmed")
        pressIn("wiki-plan-page", "wiki-plan-doc:session-runtime")
        awaitTag("wiki-plan-doc-page")
        capture("plan-doc")
        compose.onNodeWithContentDescription("Back").performClick()
        awaitTag("wiki-plan-page")
        assertEquals("one confirmation, not two", 1, requests("POST", "/confirm").size)
    }

    /** The plan's Edit sheet: a section is moved by dragging its handle (the owner's decision, card
     * 34bs0PdYUHHwiKHYn3rCp), and the draft it saves carries the new order — the one edit sent. */
    @Test fun aPlanSectionIsMovedByDraggingItsHandle() = journey("plan-drag", { "orbit://wiki/${it.string("space")}" }) { _, _ ->
        http("/__control", """{"draft":"v2"}""")
        val stored = http("/__stats").getValue("plan").jsonObject.getValue("draft").jsonObject.getValue("docs").jsonArray
            .map { it.jsonObject }.first { it.string("slug") == "session-runtime" }.getValue("sections").jsonArray.map { it.jsonObject.string("key") }
        press("wiki-bar-contents")
        awaitTag("wiki-contents-sheet")
        press("wiki-contents-plan")
        pressIn("wiki-plan-page", "wiki-plan-doc:session-runtime")
        awaitTag("wiki-plan-doc-page")
        press("wiki-plan-doc-edit")
        awaitTag("wiki-plan-edit-sheet")
        compose.onNodeWithTag("wiki-plan-edit-list").performScrollToNode(hasTestTag("wiki-plan-edit-row:1"))
        val height = compose.onNodeWithTag("wiki-plan-edit-row:0").fetchSemanticsNode().boundsInRoot.height
        compose.onNodeWithTag("wiki-plan-edit-drag:0").performTouchInput {
            down(center)
            repeat(12) { moveBy(androidx.compose.ui.geometry.Offset(0f, height * 0.11f)); advanceEventTime(30) }
            up()
        }
        compose.waitForIdle()
        capture("plan-drag-moved")
        press("wiki-plan-edit-save")
        compose.waitUntil(15_000) { requests("POST", "/plan/edits").isNotEmpty() }
        val sent = requests("POST", "/plan/edits").single().getValue("body").jsonObject.getValue("doc").jsonObject.getValue("sections").jsonArray
            .map { it.jsonObject.string("key") }
        assertEquals(listOf(stored[1], stored[0]) + stored.drop(2), sent)
        compose.waitUntil(15_000) { compose.onAllNodesWithTag("wiki-plan-edit-sheet").fetchSemanticsNodes().isEmpty() }
        capture("plan-drag-saved")
    }

    /** Wiki settings from the home's gear: the review mode is written as the owner picks it, and spot checks — greyed
     * outside Automatic — become available once the mode is Automatic. */
    @Test fun settingsWriteTheReviewModeAndSpotChecksAsPicked() = journey("settings", { "orbit://wiki/${it.string("space")}" }) { _, _ ->
        press("wiki-bar-settings")
        awaitTag("wiki-settings-page")
        compose.onNodeWithTag("wiki-settings-spot-checks").assertIsNotEnabled()
        capture("settings-tiered")
        press("wiki-settings-mode:automatic")
        compose.waitUntil(15_000) { http("/__stats").getValue("space").jsonObject.getValue("settings").jsonObject.string("reviewMode") == "automatic" }
        val patch = requests("PATCH", "/api/wiki/spaces/${http("/__ids").string("space")}").single().getValue("body").jsonObject
        assertEquals(setOf("reviewMode"), patch.keys)
        compose.waitUntil(15_000) { compose.onAllNodes(hasTestTag("wiki-settings-spot-checks") and isEnabled()).fetchSemanticsNodes().isNotEmpty() }
        press("wiki-settings-spot-checks")
        compose.waitUntil(15_000) { http("/__stats").getValue("space").jsonObject.getValue("settings").jsonObject["automaticSpotChecks"]?.jsonPrimitive?.boolean == true }
        capture("settings-automatic")
    }

    // MARK: Watch

    private fun watchState() = http("/__stats").getValue("watch").jsonObject.string("state")

    /** A watch's link opens its record over Following: Pause and Resume are written and read back, Stop asks first,
     * an ended watch keeps no controls, and Back lands on Following — whose row opens the record again. */
    @Test fun aWatchLinkControlsItsRecordAndBackLandsOnFollowing() = journey("watch", { "orbit://watch/${it.string("watch")}" }) { _, ids ->
        val watch = ids.string("watch")
        awaitTag("watch-detail:$watch")
        capture("watch-active")
        press("watch:$watch:WATCH_PAUSE")
        compose.waitUntil(15_000) { watchState() == "PAUSED" }
        press("watch:$watch:WATCH_RESUME")
        compose.waitUntil(15_000) { watchState() == "ACTIVE" }
        press("watch:$watch:WATCH_CANCEL")
        await("Stop watching?")
        assertEquals("nothing is sent before the confirmation", "ACTIVE", watchState())
        capture("watch-stop-confirmation")
        press("watch-stop-confirm")
        compose.waitUntil(15_000) { watchState() == "CANCELLED" }
        await("Stopped")
        compose.onNodeWithTag("watch:$watch:WATCH_PAUSE").assertDoesNotExist()
        compose.onNodeWithTag("watch:$watch:WATCH_CANCEL").assertDoesNotExist()
        capture("watch-stopped")
        assertEquals(listOf("/pause", "/resume", "/cancel"), journal().filter { it.string("method") == "POST" && it.string("path").startsWith("/api/watches/") }
            .map { "/" + it.string("path").substringAfterLast('/') })
        compose.onNodeWithContentDescription("Back").performClick()
        awaitTag("following-list")
        capture("following")
        pressIn("following-list", "following-row:$watch")
        awaitTag("watch-detail:$watch")
    }

    /** A session's Watching strip: what it waits on, opened to its targets, and a target opening its own page over
     * the session; Back returns to the conversation. */
    @Test fun aSessionsWatchingStripOpensATarget() = journey("strip", { "orbit-session:${it.string("session")}" }) { _, ids ->
        awaitTag("session-watches")
        press("watch-strip-line")
        awaitTag("watch-strip-list")
        capture("strip-open")
        press("watch-strip-target:${ids.string("watch")}:${ids.string("task")}")
        compose.waitUntil(15_000) { journal().any { it.string("method") == "GET" && it.string("path").startsWith("/api/tasks/${ids.string("task")}") } }
        capture("strip-target")
        compose.onNodeWithContentDescription("Back").performClick()
        awaitTag("session-watches")
    }

    /** An entry the server cannot be reached for says so, with Retry, and reads once the connection is back. */
    @Test fun anUnreachableEntrySaysSoAndRetryReadsIt() = journey("offline", { "orbit://wiki/${it.string("space")}" }) { _, ids ->
        awaitTag("wiki-search")
        compose.onNodeWithTag("wiki-search").performTextInput("A12 Wiki")
        awaitTag("wiki-hit:${ids.string("entry")}")
        http("/__control", """{"offline":true,"prefix":"/api/wiki"}""")
        press("wiki-hit:${ids.string("entry")}")
        await("The entry couldn't be loaded")
        compose.onNodeWithTag("wiki-entry-title").assertDoesNotExist()
        capture("offline-entry")
        http("/__control", """{"offline":false}""")
        compose.onNodeWithText("Retry").performClick()
        awaitTag("wiki-entry-title")
        compose.onNodeWithTag("wiki-entry-title").assertTextEquals("A12 Wiki source entry")
    }
}
