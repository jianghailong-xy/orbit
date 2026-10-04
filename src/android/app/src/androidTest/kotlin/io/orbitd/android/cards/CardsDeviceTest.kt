package io.orbitd.android.cards

import android.graphics.Bitmap
import android.os.Bundle
import android.os.Process
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import io.orbitd.android.*
import io.orbitd.android.core.auth.AuthState
import io.orbitd.android.core.cards.*
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
    private fun login(kind: String, mode: String = "") {
        instrument.sendStatus(0, Bundle().apply { putString("a08_pid", Process.myPid().toString()) })
        File(output,"identity.txt").writeText("sha=${BuildConfig.SOURCE_SHA}\ndirty=${BuildConfig.SOURCE_DIRTY}\n")
        http("/__control", """{"case":"$kind","mode":"$mode"}""")
        compose.waitUntil(10_000) { app.session.state.value !is AuthState.Restoring }
        compose.onNodeWithText("Instance address").performTextReplacement(server)
        compose.onNodeWithText("Email").performTextInput("a08@example.test")
        compose.onNodeWithText("Password").performTextInput("a08-fixture-password")
        compose.onAllNodesWithText("Sign in")[1].performScrollTo().performClick()
        compose.waitUntil(15_000) { app.session.state.value is AuthState.SignedIn && app.realtime.state.value.directoryFresh }
        compose.onNodeWithTag("workspace:01a0cca7-8609-70ed-a0e2-d4b55b832b61").performClick()
        compose.onNodeWithText("Card verification").performClick()
        await("Decisions and requests")
    }
    private fun press(tag: String) {
        compose.waitUntil(15_000) { compose.onAllNodes(hasTestTag(tag) and isEnabled()).fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithTag(tag).performScrollTo().assertIsEnabled().performClick()
    }
    private fun journey(name: String, block: () -> Unit) {
        try { block(); File(output,"$name-result.txt").writeText("PASS\n") }
        catch (error: Throwable) { capture("$name-failed"); throw error }
        finally { File(output,"$name-journal.json").writeText(http("/__stats").toString()); runBlocking { app.session.logout() } }
    }

    @Test fun rememberUsesExactRuleAndServerRecord() = journey("remember") {
        login("a1"); press("approval:a1:REMEMBER"); await("Allowed · recorded by the server")
        val journal = http("/__stats"); assertFalse(journal.flag("pending")); assertEquals("ALLOWED", journal.obj("final")?.text("status"))
        val sent = journal.objects("journal").last().obj("body")!!
        val expected = http("/__corpus").objects("requests").single { it.text("key") == "approval:a1" && it.text("verb") == "REMEMBER" }.obj("body")!!
        assertEquals(expected["rememberRules"], sent["rememberRules"]); capture("remember-recorded")
    }
    @Test fun questionKeepsCustomAnswerThroughActivityRecreation() = journey("question") {
        login("a2")
        compose.onNodeWithText("Core").performScrollTo().performClick()
        compose.onAllNodesWithText("Or type your own answer…")[1].performScrollTo().performTextInput("Server state")
        compose.activityRule.scenario.recreate(); await("Decisions and requests")
        press("approval:a2:ANSWER"); await("Allowed · recorded by the server")
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
        http("/__control", """{"case":"owner"}"""); compose.runOnIdle { app.realtime.refreshSession() }; await("Confirm done?")
        press("owner:$sid:owner1:CONFIRM_OWNER")
        compose.waitUntil(15_000) { http("/__stats").objects("journal").last().obj("body")?.text("requestId") == "owner1" }
        val body = http("/__stats").objects("journal").last().obj("body")!!
        assertEquals("owner1", body.text("requestId")); assertEquals("record1", body.text("reviewRecordId")); capture("owner-recorded")
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
            if (verb == "CONFIRM_MERGE") compose.onNodeWithTag("confirm:CONFIRM_MERGE").performClick()
            compose.waitUntil(15_000) { http("/__stats").objects("journal").size > before && !http("/__stats").flag("pending") }
            val recorded = http("/__stats").objects("journal").last()
            assertEquals(kind, recorded.text("case")); assertEquals(200, recorded.number("status"))
            corpus.objects("requests").firstOrNull { it.text("key") == key && it.text("verb") == verb }?.let { assertEquals(it["body"], recorded["body"]) }
            if (kind == "promotion") assertEquals("CONFIRMED", recorded.obj("final")!!.text("state")) // Accepted, not merged.
            File(output,"$kind-semantics.txt").writeText(compose.onRoot().printToString())
            capture("business-$kind")
        }
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
        compose.waitUntil(15_000) { app.session.state.value is AuthState.SignedIn && app.realtime.state.value.session?.fresh == true }
        await("The request may have reached the server")
        compose.onNodeWithTag("approval:a1:ALLOW").performScrollTo().assertIsNotEnabled()
        val before = Wire.json.parseToJsonElement(File(output,"cold-before.json").readText()).jsonObject
        assertEquals(before.objects("journal"), http("/__stats").objects("journal"))
        assertNotEquals(File(output,"cold-prepare-pid.txt").readText(), Process.myPid().toString())
        File(output,"cold-restore-pid.txt").writeText(Process.myPid().toString())
        capture("cold-restored")
    }
}
