package io.orbitd.android.reader

import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.net.Uri
import android.os.*
import android.view.*
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import io.orbitd.android.*
import io.orbitd.android.core.auth.AuthState
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.CopyOnWriteArrayList
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/** Real MainActivity/AuthSession/HTTP/SSE entry; loopback fixture is explicitly not a deployment. */
@RunWith(AndroidJUnit4::class)
class TranscriptDeviceTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()
    private val instrument get() = InstrumentationRegistry.getInstrumentation()
    private val app get() = instrument.targetContext.applicationContext as OrbitApplication
    private val args get() = InstrumentationRegistry.getArguments()
    private val server get() = args.getString("a06_server") ?: "http://127.0.0.1:18766"
    private val evidence get() = File(app.filesDir, "a06-reader").also { it.mkdirs() }
    private val session = "01a0cca7-8609-70ed-a0e2-d4b55b832b60"
    private val workspace = "01a0cca7-8609-70ed-a0e2-d4b55b832b61"
    private val record = "01a0cca7-8609-70ed-a0e2-d4b55b832b63"

    @Test fun readingPagingSelectionLinksAndRestoration() = journey("reading") {
        login()
        compose.onNodeWithTag("workspace:$workspace").performClick()
        compose.onNodeWithText("Long conversation").performClick()
        awaitText("Latest answer 9999", substring = true)
        capture("latest")
        compose.runOnIdle { (app.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager).clearPrimaryClip() }
        SystemClock.sleep(350)
        // Native long press must produce a selectable substring, not only a whole-message button.
        val prose = compose.onNodeWithText("Latest answer 9999", substring = true)
        longPress(prose)
        compose.waitForIdle()
        compose.mainClock.advanceTimeBy(100)
        capture("selection-pressed")
        copyFromNativeToolbar()
        compose.waitForIdle()
        val clipboard = app.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        var copied = ""
        compose.runOnIdle { copied = clipboard.primaryClip?.getItemAt(0)?.coerceToText(app)?.toString().orEmpty() }
        assertTrue("Native Copy must contain selected message text: $copied", copied.isNotBlank() && "Latest answer 9999. Select these words for native partial copy.".contains(copied))
        File(evidence, "selection.txt").writeText("native_long_press=true\nclipboard=$copied\n")
        scrollHistory()
        compose.onNodeWithTag("transcript-list").performScrollToNode(hasText("Load earlier messages"))
        val anchor = compose.onNodeWithTag("event:9801")
        anchor.assertIsDisplayed()
        val before = screenTop(anchor)
        capture("prepend-before")
        compose.onNodeWithText("Load earlier messages").performClick()
        compose.waitUntil(10_000) { app.realtime.state.value.session?.transcript?.seeded == true && compose.onAllNodesWithText("Loading messages…").fetchSemanticsNodes().isEmpty() }
        compose.waitForIdle()
        val after = screenTop(compose.onNodeWithTag("event:9801"))
        val density = app.resources.displayMetrics.density
        File(evidence, "prepend.txt").writeText("seq=9801\nbeforePx=$before\nafterPx=$after\ndensity=$density\ndriftDp=${kotlin.math.abs(after-before)/density}\n")
        assertTrue("Prepending must retain the visible record within 8dp", kotlin.math.abs(after-before)/density <= 8f)
        capture("prepend-after")
        control("{\"stream\":true}")
        SystemClock.sleep(2_000)
        val streamingPosition = screenTop(compose.onNodeWithTag("event:9801"))
        assertTrue(kotlin.math.abs(streamingPosition-after)/density <= 8f)
        control("{\"stream\":false}")
        capture("history-stream")
        compose.activityRule.scenario.recreate()
        compose.waitUntil(10_000) { compose.onAllNodesWithTag("event:9801").fetchSemanticsNodes().isNotEmpty() }
        val firstAvailable = screenTop(compose.onNodeWithTag("event:9801"))
        capture("restored")
        compose.waitForIdle()
        val restored = screenTop(compose.onNodeWithTag("event:9801"))
        File(evidence, "recreated-position.txt").writeText("beforePx=$after\nfirstAvailablePx=$firstAvailable\nsettledPx=$restored\ndensity=$density\n")
        assertTrue("Rotation/recreation preserves saved seq+offset", kotlin.math.abs(restored-after)/density <= 8f)
        // Rich message, image and object links use the product's one return stack.
        compose.onNodeWithText("Jump to latest").performClick()
        awaitText("Latest answer 9999", true)
        scrollHistory()
        compose.onNodeWithTag("transcript-list").performScrollToNode(hasText("Reading fixture"))
        compose.onNodeWithText("Reading fixture").assertIsDisplayed()
        capture("markdown")
        compose.onNodeWithTag("transcript-list").performScrollToNode(hasContentDescription("Fixed 1440 × 2560 image"))
        compose.waitUntil(10_000) { compose.onAllNodesWithContentDescription("Fixed 1440 × 2560 image").fetchSemanticsNodes().isNotEmpty() }
        capture("image")
        compose.onNodeWithContentDescription("Fixed 1440 × 2560 image").performClick()
        compose.onNodeWithText("Close image").assertIsDisplayed().performClick()
        openRecord()
        compose.waitUntil(10_000) { compose.onAllNodesWithTag("event:4899").fetchSemanticsNodes().isNotEmpty() }
        capture("record-anchor")
        compose.onNodeWithTag("event:4899").assertIsDisplayed()
        assertTrue("Around endpoint must preserve the gap", compose.onAllNodesWithText("Jump to latest").fetchSemanticsNodes().isNotEmpty())
        // A05 toolbar/system back must return to the original reader, then the directory.
        instrument.sendKeyDownUpSync(KeyEvent.KEYCODE_BACK)
        compose.waitUntil(10_000) { compose.onAllNodesWithText("Session options").fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithContentDescription("Back").performClick()
        awaitText("Long conversation")
        compose.onNodeWithText("Long conversation").performClick()
        awaitText("Session options")
        control("{\"denial\":403}")
        compose.runOnIdle { app.realtime.refreshSession() }
        awaitText("Session unavailable")
        compose.onNodeWithTag("transcript-list").assertDoesNotExist()
        capture("permission")
        control("{\"denial\":0}")
        compose.onNodeWithText("Retry").performClick()
        compose.waitUntil(15_000) { app.realtime.state.value.session?.fresh == true }
        compose.onNodeWithText("Session options").assertIsDisplayed()
    }

    @Test fun toolOutputWorktreeAndSubagentReading() = journey("tools") {
        login(); openSession()
        awaitText("Latest answer 9999", true)
        scrollHistory()
        compose.onNodeWithTag("transcript-list").performScrollToNode(hasTestTag("event:9982"))
        compose.onNode(hasText("Copy message") and hasAnyAncestor(hasTestTag("event:9982"))).performClick()
        val directCopy = app.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        compose.waitUntil(10_000) { directCopy.primaryClip?.getItemAt(0)?.text?.count { it == '\n' } == 161 }
        compose.onNode(hasText("Show input and output") and hasAnyAncestor(hasTestTag("event:9982"))).performClick()
        compose.waitUntil(10_000) { compose.onAllNodesWithText("Loading messages…").fetchSemanticsNodes().isEmpty() }
        compose.onNodeWithTag("transcript-list").performScrollToNode(hasText("View all 162 lines"))
        compose.onNodeWithText("View all 162 lines").performClick()
        compose.onNodeWithText("Copy all").performClick()
        val clipboard = app.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        var copied = ""
        compose.runOnIdle { copied = clipboard.primaryClip?.getItemAt(0)?.text.toString() }
        assertTrue(copied.startsWith("Output 9990\n") && copied.count { it == '\n' } == 161)
        capture("full-output")
        compose.onNodeWithText("Close output").performClick()
        compose.onNodeWithTag("transcript-list").performScrollToNode(hasText("Open subagent transcript"))
        compose.onNodeWithText("Open subagent transcript").performClick()
        compose.onNodeWithText("Close subagent transcript").assertIsDisplayed()
        capture("subagent")
        compose.onNodeWithText("Close subagent transcript").performClick()
        compose.onNodeWithText("Long conversation").performClick()
        compose.onNodeWithText("View changed files and diff").performClick()
        awaitText("reader.kt")
        capture("diff")
        compose.onNodeWithText("Close diff").performClick()
        compose.onNodeWithTag("session-details").performScrollToNode(hasText("BUILD SUCCESSFUL", substring = true))
        compose.onNodeWithText("BUILD SUCCESSFUL", substring = true).assertIsDisplayed()
        compose.onNodeWithTag("session-details").performScrollToNode(hasText("Checking references"))
        capture("background-work")
        compose.onNodeWithText("Close session details").performClick()
    }

    @Test fun longMarkdownTableAndCode() = journey("rich-long") {
        login(); openSession(); awaitText("Latest answer 9999", true)
        openRecord("01a0cca7-8609-70ed-a0e2-d4b55b832b65")
        awaitText("H0")
        compose.onNodeWithTag("transcript-list").performScrollToNode(hasText("H0") and hasAnyAncestor(hasTestTag("event:418")))
        val table = compose.onNode(hasTestTag("markdown-table") and hasAnyAncestor(hasTestTag("event:418")))
        repeat(6) { table.performTouchInput { swipeLeft() } }
        compose.onNode(hasText("H7") and hasAnyAncestor(hasTestTag("event:418"))).assertIsDisplayed()
        capture("table-30x8")
        openRecord("01a0cca7-8609-70ed-a0e2-d4b55b832b66")
        awaitText("View all 500 lines")
        compose.onNodeWithTag("transcript-list").performScrollToNode(hasText("View all 500 lines") and hasAnyAncestor(hasTestTag("event:618")))
        compose.onNode(hasText("View all 500 lines") and hasAnyAncestor(hasTestTag("event:618"))).performClick()
        compose.onNodeWithTag("long-output").performScrollToNode(hasText("val line499", substring = true))
        compose.onNodeWithText("Copy all").performClick()
        var copied = ""
        compose.runOnIdle { copied = (app.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager).primaryClip?.getItemAt(0)?.text.toString() }
        assertTrue(copied.contains("val line499") && copied.count { it == '\n' } == 499)
        capture("code-500")
        compose.onNodeWithText("Close output").performClick()
        openRecord("01a0cca7-8609-70ed-a0e2-d4b55b832b67")
        compose.waitUntil(15_000) { compose.onAllNodesWithTag("event:18").fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithTag("event:18").assertIsDisplayed()
        capture("long-markdown")
        scrollHistory()
        compose.onNodeWithText("Jump to latest").performClick()
        awaitText("Latest answer 9999", true)
    }

    @Test fun sustainedStreamAndBoundedHistory() = journey("stream") {
        login(); openSession(); awaitText("Latest answer 9999", true)
        val frames = CopyOnWriteArrayList<String>()
        val handlerThread = HandlerThread("a06-frames").apply { start() }
        val listener = Window.OnFrameMetricsAvailableListener { _, metrics, dropped ->
            frames += "${SystemClock.elapsedRealtimeNanos()},${metrics.getMetric(FrameMetrics.TOTAL_DURATION)},$dropped"
        }
        compose.runOnIdle { compose.activity.window.addOnFrameMetricsAvailableListener(listener, Handler(handlerThread.looper)) }
        control("{\"stream\":true}")
        val duration = args.getString("a06_stream_seconds")?.toInt() ?: 12
        val started = SystemClock.elapsedRealtime()
        val memory = mutableListOf<String>()
        try {
            for (second in 0 until duration) {
                if (second % 20 == 5) scrollHistory()
                if (second % 20 == 12) compose.onAllNodesWithText("Jump to latest").fetchSemanticsNodes().takeIf { it.isNotEmpty() }?.let { compose.onNodeWithText("Jump to latest").performClick() }
                SystemClock.sleep(1_000)
                val sample = Debug.MemoryInfo().also(Debug::getMemoryInfo)
                memory += "${SystemClock.elapsedRealtime()-started},${sample.totalPss}"
                assertTrue("A04 replay window remains bounded", app.realtime.state.value.session!!.transcript.events.size <= 2_000)
            }
        } finally {
            control("{\"stream\":false}")
            compose.runOnIdle { compose.activity.window.removeOnFrameMetricsAvailableListener(listener) }
            handlerThread.quitSafely()
            File(evidence, "frames.csv").writeText("elapsedRealtimeNs,hwuiTotalDurationNs,droppedCallbacks\n" + frames.joinToString("\n") + "\n")
            File(evidence, "memory.csv").writeText("elapsedMs,processTotalPssKiB\n" + memory.joinToString("\n") + "\n")
            File(evidence, "stream-duration.txt").writeText("requestedSeconds=$duration\nelapsedMs=${SystemClock.elapsedRealtime()-started}\nmetric=HWUI TOTAL_DURATION diagnostic; not frameDurationCpuMs/frameOverrunMs\n")
        }
        assertTrue(frames.isNotEmpty())
        val transcript = app.realtime.state.value.session!!.transcript
        assertEquals(transcript.events.size, transcript.events.map { it.seq }.distinct().size)
        capture("stream-end")
    }

    @Test fun extremeHistoryTwentyPages() = journey("extreme") {
        login()
        control("{\"reset\":true,\"mode\":\"DS4\"}")
        openSession(); awaitText("Message 99999", true)
        scrollHistory()
        compose.onNodeWithTag("transcript-list").performScrollToNode(hasTestTag("event:99982"))
        compose.onNode(hasText("Show input and output") and hasAnyAncestor(hasTestTag("event:99982"))).performClick()
        compose.waitUntil(10_000) { compose.onAllNodesWithText("View full output").fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithTag("transcript-list").performScrollToNode(hasText("View full output"))
        compose.onNodeWithText("View full output").performClick()
        compose.onNodeWithText("Select a portion to copy, or save the complete text.").assertIsDisplayed()
        compose.onNode(hasText("Save text") and hasAnyAncestor(isDialog())).assertIsDisplayed()
        compose.onNodeWithTag("long-output").performTouchInput { swipeUp() }
        capture("output-512KiB")
        compose.onNodeWithText("Close output").performClick()
        val measurements = mutableListOf<String>()
        repeat(20) { page ->
            compose.onNodeWithTag("transcript-list").performScrollToNode(hasText("Load earlier messages"))
            val seq = 99_801 - page * 200
            val before = compose.onNodeWithTag("event:$seq").fetchSemanticsNode().boundsInRoot.top
            compose.onNodeWithText("Load earlier messages").performClick()
            compose.waitUntil(10_000) { compose.onAllNodesWithText("Loading messages…").fetchSemanticsNodes().isEmpty() }
            compose.waitForIdle()
            val after = compose.onNodeWithTag("event:$seq").fetchSemanticsNode().boundsInRoot.top
            val drift = kotlin.math.abs(after-before)/app.resources.displayMetrics.density
            measurements += "$page,$seq,$before,$after,$drift"
            assertTrue("DS4 prepend $page must hold record $seq within 8dp: $drift", drift <= 8f)
        }
        File(evidence, "extreme-prepend.csv").writeText("page,seq,beforePx,afterPx,driftDp\n"+measurements.joinToString("\n")+"\n")
        capture("extreme-history")
        val expected = compose.onNodeWithTag("event:96001").fetchSemanticsNode().boundsInRoot.top
        repeat(10) {
            compose.onNodeWithContentDescription("Back").performClick()
            awaitText("Long conversation")
            compose.onNodeWithText("Long conversation").performClick()
            compose.waitUntil(10_000) { compose.onAllNodesWithTag("event:96001").fetchSemanticsNodes().isNotEmpty() }
            val actual = compose.onNodeWithTag("event:96001").fetchSemanticsNode().boundsInRoot.top
            File(evidence, "extreme-switch-positions.csv").appendText("$it,$expected,$actual\n")
            assertTrue("Switch $it: anchor $expected -> $actual", kotlin.math.abs(actual-expected)/app.resources.displayMetrics.density <= 8f)
        }
        File(evidence, "extreme-switches.txt").writeText("10 directory/session switches; seq=96001; drift <= 8dp\n")
        compose.onNodeWithText("Jump to latest").performClick()
        awaitText("Message 99999", true)
    }

    private fun login() {
        compose.waitUntil(10_000) { app.session.state.value !is AuthState.Restoring }
        assertTrue(app.session.state.value is AuthState.SignedOut)
        control("{\"reset\":true}")
        compose.onNodeWithText("Instance address").performTextReplacement(server)
        compose.onNodeWithText("Email").performTextInput("a06@example.test")
        compose.onNodeWithText("Password").performTextInput("a06-fixture-password")
        compose.onAllNodesWithText("Sign in")[1].performScrollTo().performClick()
        compose.waitUntil(15_000) { app.session.state.value is AuthState.SignedIn && app.realtime.state.value.directoryFresh }
    }
    private fun openSession() {
        compose.onNodeWithTag("workspace:$workspace").performClick()
        compose.onNodeWithText("Long conversation").performClick()
    }
    private fun openRecord(target: String = record) {
        compose.activityRule.scenario.onActivity { activity ->
            val original = activity.intent
            MainActivity::class.java.getDeclaredMethod("onNewIntent", Intent::class.java).apply { isAccessible = true }
                .invoke(activity, Intent(Intent.ACTION_VIEW, Uri.parse("orbit-session:$session?at=$target")).setClass(activity, MainActivity::class.java))
            activity.intent = original
        }
    }
    private fun scrollHistory() { compose.onNodeWithTag("transcript-list").performTouchInput { swipeDown(durationMillis = 500) } }
    private fun screenTop(node: SemanticsNodeInteraction): Float {
        val bounds = node.fetchSemanticsNode().boundsInWindow
        val location = IntArray(2)
        compose.runOnIdle { compose.activity.window.decorView.getLocationOnScreen(location) }
        val top = bounds.top + location[1]
        File(evidence, "screen-positions.txt").appendText("windowTop=${bounds.top} decorY=${location[1]} screenTop=$top\n")
        return top
    }
    private fun awaitText(text: String, substring: Boolean = false) {
        compose.waitUntil(15_000) { compose.onAllNodesWithText(text, substring = substring).fetchSemanticsNodes().isNotEmpty() }
    }
    private fun control(body: String) {
        (URL("$server/__control").openConnection() as HttpURLConnection).apply {
            requestMethod = "POST"; doOutput = true; connectTimeout = 5_000; readTimeout = 5_000
            outputStream.use { it.write(body.toByteArray()) }; check(responseCode == 200); inputStream.close(); disconnect()
        }
    }
    private fun longPress(node: SemanticsNodeInteraction) {
        val bounds = node.fetchSemanticsNode().boundsInWindow
        val location = IntArray(2); compose.activity.window.decorView.getLocationOnScreen(location)
        val x = bounds.left + 35f + location[0]; val y = bounds.top + 22f + location[1]
        val time = SystemClock.uptimeMillis()
        File(evidence, "selection-input.txt").writeText("bounds=$bounds location=${location.toList()} x=$x y=$y toolType=FINGER\n")
        listOf(MotionEvent.ACTION_DOWN, MotionEvent.ACTION_UP).forEach { action ->
            val pointer = MotionEvent.PointerProperties().apply { id = 0; toolType = MotionEvent.TOOL_TYPE_FINGER }
            val coordinates = MotionEvent.PointerCoords().apply { this.x = x; this.y = y; pressure = 1f; size = 1f }
            val event = MotionEvent.obtain(time, SystemClock.uptimeMillis(), action, 1, arrayOf(pointer), arrayOf(coordinates),
                0, 0, 1f, 1f, 0, 0, InputDevice.SOURCE_TOUCHSCREEN, 0)
            check(instrument.uiAutomation.injectInputEvent(event, true)); event.recycle()
            if (action == MotionEvent.ACTION_DOWN) {
                // Native injection does not advance Compose test delay time. Keep the finger down
                // while the controlled long-press timer elapses; manual device checks use wall time.
                instrument.waitForIdleSync()
                compose.waitForIdle()
                compose.mainClock.advanceTimeBy(900)
                SystemClock.sleep(800)
            }
        }
    }
    private fun copyFromNativeToolbar() {
        val automation = instrument.uiAutomation
        val info = automation.serviceInfo
        val oldFlags = info.flags
        info.flags = oldFlags or android.accessibilityservice.AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS or
            android.accessibilityservice.AccessibilityServiceInfo.FLAG_REPORT_VIEW_IDS
        automation.serviceInfo = info
        fun find(node: android.view.accessibility.AccessibilityNodeInfo?): android.view.accessibility.AccessibilityNodeInfo? {
            if (node == null) return null
            if (node.text?.toString() == "Copy" && node.viewIdResourceName?.startsWith("android:id/") == true) return node
            for (i in 0 until node.childCount) find(node.getChild(i))?.let { return it }
            return null
        }
        try {
            var found: android.view.accessibility.AccessibilityNodeInfo? = null
            compose.waitUntil(8_000) { found = automation.windows.firstNotNullOfOrNull { find(it.root) }; found != null }
            val label = found!!
            var button: android.view.accessibility.AccessibilityNodeInfo? = label
            while (button != null && !button.isClickable) button = button.parent
            File(evidence, "selection-action.txt").writeText("native_toolbar_id=${label.viewIdResourceName}\naction=ACTION_CLICK\n")
            assertTrue("Click the platform's Copy action", button?.performAction(android.view.accessibility.AccessibilityNodeInfo.ACTION_CLICK) == true)
        } finally { info.flags = oldFlags; automation.serviceInfo = info }
    }
    private fun capture(name: String) {
        SystemClock.sleep(300) // Let platform window/toolbar animations settle outside the Compose clock.
        val bitmap = instrument.uiAutomation.takeScreenshot()
        File(evidence, "$name.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }; bitmap.recycle()
    }
    private fun journey(name: String, block: () -> Unit) {
        instrument.sendStatus(0, Bundle().apply { putString("a06_pid", Process.myPid().toString()) })
        File(evidence, "identity.txt").writeText("sha=${BuildConfig.SOURCE_SHA}\ndirty=${BuildConfig.SOURCE_DIRTY}\nsdk=${Build.VERSION.SDK_INT}\n")
        try { block(); File(evidence, "$name-result.txt").writeText("PASS\n") }
        catch (failure: Throwable) { capture("$name-failure"); File(evidence, "$name-result.txt").writeText(failure.stackTraceToString()); throw failure }
        finally { control("{\"stream\":false,\"denial\":0}"); runBlocking { app.session.logout() } }
    }
}
