package io.orbitd.android.cards

import android.graphics.Bitmap
import android.os.Bundle
import android.os.Process
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import io.orbitd.android.MainActivity
import androidx.compose.ui.unit.dp
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import io.orbitd.android.OrbitApplication
import io.orbitd.android.core.net.ServerAddress
import io.orbitd.android.core.cards.OwnerRequest
import io.orbitd.android.core.protocol.Wire
import io.orbitd.android.ui.OrbitTheme
import java.io.File
import kotlinx.coroutines.runBlocking
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/** Screenshots of the PROJECT_REOPEN card (docs/project-reopen-request-design.md §6) for the iOS comparison: the transcript card, the project-page row, the folded lines. */
@RunWith(AndroidJUnit4::class)
class ProjectReopenShotDeviceTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()
    private val instrument get() = InstrumentationRegistry.getInstrumentation()
    private val app get() = instrument.targetContext.applicationContext as OrbitApplication
    private val output get() = File(app.filesDir, "a08-cards").also { it.mkdirs() }

    private fun request(state: String, extra: String = "") = Wire.decode("""{"id":"01a0d6a9-d763-70e1-b4cf-8793e971b506","kind":"PROJECT_REOPEN","state":"$state",
        "title":"Reopen project “Share to Orbit”?","why":"The share sheet needs a dark-mode fix that changes its acceptance criteria.",
        "askedBySessionId":"s1","askedBySessionTitle":"Fix share sheet colours","projectId":"p1","createdAt":"2026-11-24T08:00:00.000Z"$extra,
        "payload":{"projectId":"p1","statusAtAsk":"DONE","settledAt":"2026-11-18T09:00:00.000Z","plannedWork":"Restyle the share sheet for dark mode and add a screenshot check.",
        "askers":[{"sessionId":"s1","title":"Fix share sheet colours"},{"sessionId":"s2","title":"Audit dark mode"}]}}""".encodeToByteArray(), OwnerRequest.serializer())

    private fun capture(name: String) {
        instrument.uiAutomation.takeScreenshot().let { bitmap -> File(output, "$name.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }; bitmap.recycle() }
    }

    @Test fun reopenCardShots() {
        instrument.sendStatus(0, Bundle().apply { putString("a08_pid", Process.myPid().toString()) })
        val handle = runBlocking { app.session.login(ServerAddress.parse("http://127.0.0.1:18768", true), "a08@example.test", "a08-fixture-password") }
        val store = OwnerRequestStore.of(app.session, handle, app.processScope)
        val view = mutableStateOf("transcript")
        compose.activityRule.scenario.onActivity { it.setContent { OrbitTheme(darkTheme = false) {
            Column(Modifier.padding(16.dp).verticalScroll(rememberScrollState())) {
                when (view.value) {
                    "transcript" -> OwnerRequestCard(request("PENDING"), store, { "mac-mini" }, {}, discuss = {})
                    "project-page" -> ProjectReopenCard(request("PENDING"), store, onProjectPage = true)
                    "reopened" -> OwnerRequestResolved(request("DONE", ""","resolvedAt":"2026-11-24T14:02:00.000Z""""), store, { "mac-mini" })
                    else -> OwnerRequestResolved(request("DECLINED", ""","resolutionNote":"Not this quarter""""), store, { "mac-mini" })
                }
            }
        } } }
        for (name in listOf("transcript", "project-page", "reopened", "declined")) {
            view.value = name; compose.waitForIdle(); Thread.sleep(500); capture("reopen-$name")
        }
        runBlocking { app.session.logout() }
    }
}
