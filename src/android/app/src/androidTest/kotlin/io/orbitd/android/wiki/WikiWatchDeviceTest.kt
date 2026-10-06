package io.orbitd.android.wiki

import android.content.Intent
import android.graphics.Bitmap
import android.net.Uri
import android.os.Bundle
import android.os.Process
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import io.orbitd.android.BuildConfig
import io.orbitd.android.MainActivity
import io.orbitd.android.OrbitApplication
import io.orbitd.android.core.auth.AuthState
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

/** Production Activity/AuthSession/API navigation against a controlled loopback server. */
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
    private fun await(text: String) { compose.waitUntil(20_000) { compose.onAllNodesWithText(text, substring = true).fetchSemanticsNodes().isNotEmpty() } }
    private fun press(tag: String) {
        compose.waitUntil(15_000) { compose.onAllNodes(hasTestTag(tag) and isEnabled()).fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithTag(tag).performScrollTo().performClick()
    }
    private fun capture(name: String) {
        File(output, "$name-semantics.txt").writeText(compose.onRoot().printToString())
        instrument.uiAutomation.takeScreenshot().let { bitmap ->
            File(output, "$name.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }; bitmap.recycle()
        }
    }
    private fun launch(raw: String) = Intent(Intent.ACTION_VIEW, Uri.parse(raw), app, MainActivity::class.java)
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
    private fun journey(name: String, target: (JsonObject) -> String, block: (ActivityScenario<MainActivity>, JsonObject) -> Unit) {
        http("/__control", """{"reset":true}""")
        val ids = http("/__ids")
        instrument.sendStatus(0, Bundle().apply { putString("a12_pid", Process.myPid().toString()) })
        File(output, "$name-identity.txt").writeText("sha=${BuildConfig.SOURCE_SHA}\ndirty=${BuildConfig.SOURCE_DIRTY}\nfixture=loopback-18770\n")
        compose.waitUntil(10_000) { app.session.state.value !is AuthState.Restoring }
        runBlocking { app.session.logout() }
        ActivityScenario.launch<MainActivity>(launch(target(ids))).use { scenario ->
            try {
                await("Email")
                scenario.recreate()
                compose.onNodeWithText("Instance address").performTextReplacement(server)
                compose.onNodeWithText("Email").performTextInput("a12@example.test")
                compose.onNodeWithText("Password").performTextInput("a12-fixture-password")
                compose.onAllNodesWithText("Sign in")[1].performScrollTo().performClick()
                compose.waitUntil(20_000) { app.session.state.value is AuthState.SignedIn && app.realtime.state.value.directoryFresh }
                block(scenario, ids)
                File(output, "$name-result.txt").writeText("PASS · controlled HTTP only\n")
            } catch (error: Throwable) { capture("$name-failed"); throw error }
            finally { File(output, "$name-journal.json").writeText(http("/__stats").toString()); runBlocking { app.session.logout() } }
        }
    }

    @Test fun coldSpaceLinkIsAHomeAndSurvivesRecreation() = journey("space", { "orbit://wiki/${it.string("space")}" }) { scenario, _ ->
        await("Principles")
        compose.onNodeWithText("Contents").performClick()
        await("Browse by category")
        capture("space-contents")
        scenario.recreate()
        await("Browse by category")
    }

    @Test fun wikiSourceOpensOriginalRecordAndBackRestoresEntry() = journey("source", { "orbit-wiki:${it.string("entry")}" }) { scenario, ids ->
        press("wiki-source:${ids.string("source")}")
        compose.waitUntil(20_000) { app.realtime.state.value.session?.id == ids.string("session") }
        compose.waitUntil(20_000) {
            http("/__stats").toString().contains("around=${ids.string("record")}")
        }
        await("Jump to latest")
        capture("source-record")
        compose.onNodeWithContentDescription("Back").performClick()
        press("wiki-edit")
        scenario.recreate()
        await("One-line summary")
        capture("source-return-edit")
    }

    @Test fun watchControlReadsBackServerStatesAndStopNeedsConfirmation() = journey("watch", { "orbit://watch/${it.string("watch")}" }) { _, ids ->
        press("watch:${ids.string("watch")}:WATCH_PAUSE")
        compose.waitUntil(15_000) { http("/__stats")["watch"]?.jsonObject?.get("state")?.jsonPrimitive?.content == "PAUSED" }
        press("watch:${ids.string("watch")}:WATCH_RESUME")
        compose.waitUntil(15_000) { http("/__stats")["watch"]?.jsonObject?.get("state")?.jsonPrimitive?.content == "ACTIVE" }
        press("watch:${ids.string("watch")}:WATCH_CANCEL")
        await("Stop watching?")
        assertEquals("ACTIVE", http("/__stats").getValue("watch").jsonObject.string("state"))
        capture("watch-stop-confirmation")
        compose.onNodeWithTag("watch-stop-confirm").performClick()
        compose.waitUntil(15_000) { http("/__stats")["watch"]?.jsonObject?.get("state")?.jsonPrimitive?.content == "CANCELLED" }
        await("Stopped")
        capture("watch-stopped")
    }

    @Test fun searchEditAndRecreationKeepOriginalRevisionAndServerResult() = journey("search-edit", { "orbit://wiki/${it.string("space")}" }) { scenario, ids ->
        await("Principles")
        compose.onNodeWithTag("wiki-search").performScrollTo().performTextInput("A12 Wiki")
        press("wiki-entry:${ids.string("entry")}")
        press("wiki-edit")
        compose.onNodeWithTag("wiki-edit-summary").performScrollTo().performTextReplacement("Edited on Android with server readback.")
        scenario.recreate()
        compose.onNodeWithTag("wiki-edit-summary").assertTextContains("Edited on Android with server readback.")
        press("wiki-edit-save")
        compose.waitUntil(15_000) { http("/__stats").getValue("entry").jsonObject.string("summary") == "Edited on Android with server readback." }
        await("Edited on Android with server readback.")
        capture("search-edit-recorded")
        compose.onNodeWithContentDescription("Back").performClick()
        compose.onNodeWithTag("wiki-search").assertTextContains("A12 Wiki")
    }

    @Test fun reviewAcceptUsesExistingCardAndWithdrawsSettledProposal() = journey("review", { "orbit://wiki/${it.string("space")}" }) { _, ids ->
        press("wiki-review")
        press("wiki-op:${ids.string("op")}:WIKI_ACCEPT")
        await("All caught up")
        val decisions = http("/__stats").getValue("journal").jsonArray.map { it.jsonObject }
            .filter { it.string("method") == "POST" && it.string("path").endsWith("/decide") }
        assertEquals(1, decisions.size)
        assertEquals("accept", decisions.single().getValue("body").jsonObject.getValue("decisions").jsonArray.single().jsonObject.string("action"))
        capture("review-recorded")
    }

    @Test fun revokedAndMissingWikiClearPreviouslyLoadedProtectedContent() = journey("wiki-denial", { "orbit-wiki:${it.string("entry")}" }) { _, _ ->
        await("A12 Wiki source entry")
        http("/__control", """{"denial":403}""")
        compose.onNodeWithText("Refresh").performClick()
        await("permission")
        compose.onAllNodesWithText("A12 Wiki source entry").assertCountEquals(0)
        compose.onNodeWithTag("wiki-edit").assertDoesNotExist()
        capture("wiki-forbidden")
        http("/__control", """{"denial":404}""")
        compose.onNodeWithText("Retry").performClick()
        await("no longer available")
        capture("wiki-missing")
    }

    @Test fun lostWatchReplyReconcilesWithoutReplayingMutation() = journey("watch-lost", { "orbit://watch/${it.string("watch")}" }) { _, ids ->
        compose.waitUntil(15_000) { compose.onAllNodesWithTag("watch:${ids.string("watch")}:WATCH_PAUSE").fetchSemanticsNodes().isNotEmpty() }
        http("/__control", """{"lostResponse":true,"prefix":"/api/watches"}""")
        press("watch:${ids.string("watch")}:WATCH_PAUSE")
        compose.waitUntil(15_000) { compose.onAllNodesWithTag("watch:${ids.string("watch")}:WATCH_RESUME").fetchSemanticsNodes().isNotEmpty() }
        val posts = http("/__stats").getValue("journal").jsonArray.map { it.jsonObject }
            .count { it.string("method") == "POST" && it.string("path").endsWith("/pause") }
        assertEquals(1, posts)
        capture("watch-lost-reconciled")
    }
}
