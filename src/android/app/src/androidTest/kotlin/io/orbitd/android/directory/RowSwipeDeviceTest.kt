package io.orbitd.android.directory

import android.accessibilityservice.AccessibilityServiceInfo
import android.app.UiAutomation
import android.graphics.Bitmap
import android.os.Build
import android.os.ParcelFileDescriptor
import android.os.SystemClock
import android.view.InputDevice
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.accessibility.AccessibilityManager
import android.view.accessibility.AccessibilityNodeInfo
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import io.orbitd.android.MainActivity
import io.orbitd.android.OrbitApplication
import io.orbitd.android.core.auth.AuthState
import io.orbitd.android.core.net.ServerAddress
import io.orbitd.android.hasRowMenu
import io.orbitd.android.navigation.ObjectId
import io.orbitd.android.wiki.TalkBackSpeechRecorder
import java.io.File
import java.time.Instant
import java.util.concurrent.CopyOnWriteArrayList
import kotlin.math.roundToInt
import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.*
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * A session row's swipe on a device, by real touches: injected as a touchscreen's events, or sent by `input touchscreen` where the
 * system's own edge gesture is the point, they go through the system's input pipeline, so the system's Back gesture, the drawer, the
 * list and the row all see them as they see a finger. Over a controlled HTTP fixture, not a deployment; a step
 * leaves a frame in files/row-swipe/<theme>, and the requests made in requests.txt.
 */
@RunWith(AndroidJUnit4::class)
class RowSwipeDeviceTest {
    @get:Rule val compose = createEmptyComposeRule()
    private lateinit var scenario: ActivityScenario<MainActivity>
    private val instrumentation get() = InstrumentationRegistry.getInstrumentation()
    private val app get() = instrumentation.targetContext.applicationContext as OrbitApplication
    private val theme = InstrumentationRegistry.getArguments().getString("row_swipe_theme") ?: "dark"
    private val evidence get() = File(app.filesDir, "row-swipe/$theme").also { it.mkdirs() }
    private val notes = StringBuilder()
    private val calls = CopyOnWriteArrayList<String>()
    /** Every call goes through this one connection. The TalkBack check takes it without suppressing accessibility services: the
     * default connection switches TalkBack off while it is connected, and a single call through it would do so. */
    private var automationFlags = 0
    private val automation: UiAutomation get() = instrumentation.getUiAutomation(automationFlags)

    private val orbit = "34RowSwipeWorkspace001"; private val api = "34RowSwipeWorkspace002"; private val launch = "34RowSwipeProjectLaunch"
    private val release = "34RowSwipeFolderRelease"
    private val pinned = "34RowSwipeSessionPin01"; private val pricing = "34RowSwipeSessionPrc02"; private val jobs = "34RowSwipeSessionJob03"
    private val login = "34RowSwipeSessionLog04"; private val postgres = "34RowSwipeSessionPgc05"; private val held = "34RowSwipeSessionHld06"
    private val notesRow = "34RowSwipeSessionNot07"; private val coordinator = "34RowSwipeSessionCrd08"; private val member = "34RowSwipeSessionMem09"
    private val filed = "34RowSwipeSessionFld10"; private val shipped = "34RowSwipeSessionShp11"; private val badge = "34RowSwipeSessionBdg12"
    private val old = "34RowSwipeSessionOld13"; private val scratch = "34RowSwipeSessionSct14"; private val tracker = "34RowSwipeSessionTrk15"
    private val ids = listOf(orbit, api, launch, release, pinned, pricing, jobs, login, postgres, held, notesRow, coordinator, member, filed, shipped, badge, old, scratch, tracker)
    private val TALKBACK = "com.google.android.marvin.talkback/com.google.android.marvin.talkback.TalkBackService"

    /** The fixture's lists, moved by the writes it is asked for. */
    @Volatile private var open = listOf(pinned, pricing, jobs, login, postgres, held, notesRow, coordinator, member, filed, tracker)
    @Volatile private var completed = listOf(shipped, badge)
    @Volatile private var trash = listOf(old, scratch)
    @Volatile private var pins = setOf(pinned)

    /** Signed in over the fixture and on the list; the session is signed out and the Activity closed after [walk], pass or fail. */
    private fun onTheList(evidence: File, walk: () -> Unit) {
        runBlocking { app.session.restore() }
        compose.waitUntil(10_000) { app.session.state.value !is AuthState.Restoring }
        assertTrue("Requires a dedicated signed-out debug installation", app.session.state.value is AuthState.SignedOut)
        evidence.listFiles()?.forEach { it.delete() }
        MockWebServer().use { server ->
            server.dispatcher = fixture()
            try {
                runBlocking { app.session.login(ServerAddress.parse(server.url("/").toString(), true), "rows@example.test", "row-swipe-fixture-password") }
                scenario = ActivityScenario.launch(MainActivity::class.java)
                compose.waitUntil(30_000) { app.session.state.value is AuthState.SignedIn && app.realtime.state.value.directoryFresh }
                await { exists(rowOf("Partition the jobs table")) }
                walk()
                File(evidence, "result.txt").writeText("PASS\n")
            } catch (failure: Throwable) {
                File(evidence, "failure.txt").writeText(failure.stackTraceToString())
                runCatching { capture("failure", evidence) }
                throw failure
            } finally {
                File(evidence, "notes.txt").writeText(notes.toString())
                File(evidence, "requests.txt").writeText(calls.joinToString("\n"))
                runBlocking { app.session.logout() }
                if (::scenario.isInitialized) scenario.close()
                app.realtime.selectSession(null)
            }
        }
    }

    @Test fun aRowSwipesAsIosDoes() = onTheList(evidence) {
        note("window ${window()} density ${instrumentation.targetContext.resources.displayMetrics.density} gestures ${gestureInsets()} navigation_mode=${shell("settings get secure navigation_mode").trim()}")
        note("row heights: ${listOf("Partition the jobs table", "Polish the pricing page").map { bounds(rowOf(it)).height }} px; project row ${bounds(projectRow()).height} px")
        capture("01-rest")

        // Open · left: Share · Move · Delete, left to right. However long the swipe, it never fires Delete.
        swipeLeft("Partition the jobs table")
        await { exists(button("Delete")) }
        note("buttons: ${listOf("Share", "Move", "Delete").map { bounds(button(it)) }}")
        capture("02-open-left")
        val order = listOf("Share", "Move", "Delete").map { compose.onNode(button(it)).fetchSemanticsNode().boundsInWindow.left }
        assertEquals("left to right the row reads Share · Move · Delete", order.sorted(), order)
        closeByTapOn("Polish the pricing page")
        longSwipeLeft("Partition the jobs table")
        await { exists(button("Delete")) }
        assertFalse("a long swipe never fires Delete", calls.any { it.startsWith("DELETE") })
        capture("03-open-left-long-swipe")

        // While one is open a tap on any row only shuts it.
        closeByTapOn("Polish the pricing page")
        capture("04-shut-by-a-tap")

        // Open · right: Complete · Pin. A second row opening shuts the first.
        swipeRight("Partition the jobs table")
        await { exists(button("Complete")) && exists(button("Pin")) }
        capture("05-open-right")
        swipeLeft("Polish the pricing page")
        await { exists(button("Share")) && !exists(button("Complete")) }
        capture("06-second-row-shuts-the-first")
        closeByTapOn("Polish the pricing page")

        // Held past the full-swipe point, the button that will run grows and its neighbour steps aside; letting go runs it.
        val row = bounds(rowOf("Partition the jobs table"))
        val lift = drag(row.width * 0.2f, row.width * 0.86f, row.center.y, up = false)
        capture("07-full-swipe-armed")
        assertFalse("nothing runs until the finger lifts", calls.any { it.endsWith("/complete") })
        lift()
        await { calls.any { it == "POST /api/sessions/$jobs/complete" } }
        await { toastShows("Session completed") }
        capture("08-full-swipe-completed")
        await { !exists(rowOf("Partition the jobs table")) }
        dismissToasts()

        // A row that can't complete keeps the button, greyed, and a full swipe only opens it.
        longSwipeRight("Held by a review")
        await { exists(button("Complete")) }
        compose.onNode(button("Complete")).assertIsNotEnabled()
        assertFalse(calls.any { it == "POST /api/sessions/$held/complete" })
        capture("09-cannot-complete")
        closeByTapOn("Polish the pricing page")

        // Delete: a press, and the toast offers Undo.
        swipeLeft("Upgrade the Postgres client")
        await { exists(button("Delete")) }
        compose.onNode(button("Delete")).performClick()
        await { calls.any { it == "DELETE /api/sessions/$postgres" } }
        await { toastShows("Moved to Trash") }
        capture("10-delete-pressed")
        await { !exists(rowOf("Upgrade the Postgres client")) }
        dismissToasts()

        // Share and Move open their panels.
        swipeLeft("Polish the pricing page")
        await { exists(button("Move")) }
        compose.onNode(button("Move")).performClick()
        await { exists(hasText("Move session")) }
        capture("11-move-panel")
        compose.onNode(hasText("Close")).performClick(); settle()
        swipeLeft("Polish the pricing page")
        await { exists(button("Share")) }
        compose.onNode(button("Share")).performClick()
        await { exists(hasText("Share session")) }
        capture("12-share-panel")
        compose.onNode(hasText("Close")).performClick(); settle()

        // Pinned: Unpin in Pin's place.
        swipeRight("Release checklist")
        await { exists(button("Unpin")) }
        capture("13-pinned-row-right")
        closeByTapOn("Polish the pricing page")

        // The long press: the same list, with Rename… and Tags… as its own.
        longPress("Polish the pricing page")
        await { exists(hasText("Rename…")) }
        capture("14-long-press-menu")
        compose.onNode(hasText("Close")).performClick(); settle()

        // A project's row: Pin on one side and Move on the other, on its coordinator.
        await { exists(projectRow()) }
        swipeRight(projectRow())
        await { exists(button("Pin")) && !exists(button("Complete")) }
        capture("15-project-row-right")
        closeByTapOn("Polish the pricing page")
        swipeLeft(projectRow())
        await { exists(button("Move")) && !exists(button("Delete")) }
        capture("16-project-row-left")
        closeByTapOn("Polish the pricing page")

        // The project's sessions page: a member has no Move; its coordinator does.
        compose.onNode(projectRow()).performClick(); settle()
        await { exists(hasTestTag("project-sessions")) && exists(rowOf("Wire tests")) }
        swipeLeft("Wire tests")
        await { exists(button("Delete")) }
        assertFalse("a project's member offers no Move", exists(button("Move")))
        capture("17-member-left-no-move")
        pressBack(); await { !exists(button("Delete")) }
        assertTrue("Back shut the row and stayed on the page", exists(hasTestTag("project-sessions")))
        swipeLeft("Coordinate launch")
        await { exists(button("Move")) }
        capture("18-coordinator-left")
        pressBack(); await { !exists(button("Move")) }
        pressBack(); await { !exists(hasTestTag("project-sessions")) }

        // A folder's page swipes as the list does.
        compose.onNodeWithTag("folder-row:$release").performClick(); settle()
        await { exists(rowOf("Cut the beta")) }
        swipeRight("Cut the beta")
        await { exists(button("Complete")) }
        capture("19-folder-page-right")
        pressBack(); await { !exists(button("Complete")) }
        pressBack(); await { exists(rowOf("Polish the pricing page")) }

        // Completed: Move to Open · Pin, and a full swipe moves it back; the other side as Open's.
        pickScope("Completed")
        await { exists(rowOf("Shipped docs")) }
        swipeRight("Shipped docs")
        await { exists(button("Move to Open")) && exists(button("Pin")) }
        capture("20-completed-right")
        closeByTapOn("Fix the push badge")
        swipeLeft("Shipped docs")
        await { exists(button("Delete")) && exists(button("Share")) && exists(button("Move")) }
        capture("21-completed-left")
        closeByTapOn("Fix the push badge")
        longSwipeRight("Fix the push badge")
        await { calls.any { it == "POST /api/sessions/$badge/restore" } }
        await { toastShows("Moved to Open") }
        dismissToasts()

        // Trash: Move to Open alone, and Delete Permanently alone, which asks first.
        pickScope("Trash")
        await { exists(rowOf("Old experiment")) }
        swipeRight("Old experiment")
        await { exists(button("Move to Open")) && !exists(button("Pin")) }
        capture("22-trash-right")
        closeByTapOn("Scratch notes")
        longSwipeLeft("Old experiment")
        await { exists(button("Delete Permanently")) }
        assertFalse("a full swipe never purges", calls.any { it.endsWith("/purge") })
        capture("23-trash-left")
        compose.onNode(button("Delete Permanently")).performClick()
        await { exists(hasText("Delete permanently?")) }
        assertFalse("it asks first", calls.any { it.endsWith("/purge") })
        capture("24-trash-asks-first")
        compose.onNode(hasText("Cancel")).performClick(); settle()
        pickScope("Open")
        await { exists(rowOf("Polish the pricing page")) }

        // A vertical drag on a row is the list's; the list scrolling shuts an open row.
        val before = bounds(rowOf("Polish the pricing page"))
        swipeLeft("Polish the pricing page")
        await { exists(button("Delete")) }
        val middle = window().second / 2
        drag(before.right - 200, middle + 300f, before.right - 190, middle - 300f)
        await { !exists(button("Delete")) }
        capture("25-a-scroll-shuts-the-row")
        drag(before.right - 200, middle - 300f, before.right - 190, middle + 500f)

        // The edges: what the drawer and the system keep (docs/mocks/android-row-swipe).
        edges()

        note("calls\n" + calls.filter { !it.startsWith("GET") }.joinToString("\n"))
    }

    /**
     * TalkBack itself, running: a row's swipe actions are on the node it reads, as custom actions beside the long press that opens the
     * row's menu, and they work from there with no swipe. TalkBack's focus is put on the row, as a finger on it puts it, and photographed;
     * what TalkBack said is read off the test APK's silent speech engine. The actions are performed through the node, as TalkBack's actions
     * menu performs them: the emulator's console cannot make TalkBack's gestures for that menu, nor its double tap and hold, so the gestures
     * themselves are not proved here.
     */
    @Test fun talkBackOffersARowsActions() {
        automationFlags = UiAutomation.FLAG_DONT_SUPPRESS_ACCESSIBILITY_SERVICES
        val out = File(app.filesDir, "row-swipe/talkback").also { it.mkdirs() }
        onTheList(out) {
            val manager = app.getSystemService(AccessibilityManager::class.java)
            val saved = listOf("enabled_accessibility_services", "accessibility_enabled", "tts_default_synth").associateWith { shell("settings get secure $it").trim() }
            val talkBackPackage = TALKBACK.substringBefore('/')
            val notifying = "android.permission.POST_NOTIFICATIONS: granted=true" in shell("dumpsys package $talkBackPackage")
            try {
                // TalkBack asks to post notifications the first time it starts, in a dialog over the app: granted for the run, put back after.
                if (!notifying) shell("pm grant $talkBackPackage android.permission.POST_NOTIFICATIONS")
                shell("settings put secure tts_default_synth ${instrumentation.context.packageName}")
                shell("settings put secure enabled_accessibility_services $TALKBACK")
                shell("settings put secure accessibility_enabled 1")
                val deadline = SystemClock.uptimeMillis() + 30_000
                while (!manager.isTouchExplorationEnabled && SystemClock.uptimeMillis() < deadline) SystemClock.sleep(250)
                assertTrue("TalkBack must be running for this check", manager.isTouchExplorationEnabled)
                note("talkback running: touch_exploration=${manager.isTouchExplorationEnabled} speech engine=${shell("settings get secure tts_default_synth").trim()}")

                val title = "Polish the pricing page"
                val row = talkBackRow(title)
                val custom = row.actionList.filter { it.label != null && it.id != AccessibilityNodeInfo.ACTION_CLICK && it.id != AccessibilityNodeInfo.ACTION_LONG_CLICK }
                note("the row TalkBack reads: \"${spoken(row)}\"; actions ${row.actionList.map { "${it.id}:${it.label}" }}")
                assertEquals("the swipe's actions, in iOS's order", listOf("Complete", "Pin", "Delete", "Move", "Share"), custom.map { it.label.toString() })
                assertTrue("its long press is still the menu, by name", row.actionList.any { it.id == AccessibilityNodeInfo.ACTION_LONG_CLICK && it.label == "Options for $title" })

                // TalkBack's focus on the row, and what it says there.
                val since = System.currentTimeMillis()
                assertTrue(row.performAction(AccessibilityNodeInfo.ACTION_ACCESSIBILITY_FOCUS))
                SystemClock.sleep(2_500)
                capture("talkback-1-row-focused", out)
                note("talkback said: ${heard(since).joinToString(" | ") { "“$it”" }.ifEmpty { "(nothing recorded)" }}")

                // Pin, Share and Delete, each through the row's own action.
                assertTrue(talkBackRow(title).act("Pin"))
                await { calls.any { it == "POST /api/sessions/$pricing/pin" } }
                note("custom action Pin -> POST /api/sessions/$pricing/pin")
                assertTrue(talkBackRow(title).act("Share"))
                await { exists(hasText("Share session")) }
                capture("talkback-2-share-panel", out)
                note("custom action Share -> the share panel")
                compose.onNode(hasText("Close") and hasClickAction() and hasAnyAncestor(isDialog())).performSemanticsAction(SemanticsActions.OnClick)
                compose.waitUntil(5_000) { compose.onAllNodes(isDialog()).fetchSemanticsNodes().isEmpty() }
                assertTrue(talkBackRow(title).performAction(AccessibilityNodeInfo.ACTION_LONG_CLICK))
                await { exists(hasText("Rename…") and hasAnyAncestor(isDialog())) }
                capture("talkback-3-long-press-menu", out)
                note("long click -> the row's menu")
                compose.onNode(hasText("Close") and hasClickAction() and hasAnyAncestor(isDialog())).performSemanticsAction(SemanticsActions.OnClick)
                compose.waitUntil(5_000) { compose.onAllNodes(isDialog()).fetchSemanticsNodes().isEmpty() }
                assertTrue(talkBackRow(title).act("Delete"))
                await { calls.any { it == "DELETE /api/sessions/$pricing" } }
                await { toastShows("Moved to Trash") }
                capture("talkback-4-deleted", out)
                note("custom action Delete -> DELETE /api/sessions/$pricing, toast Moved to Trash")
            } finally {
                if (!notifying) shell("pm revoke $talkBackPackage android.permission.POST_NOTIFICATIONS")
                saved.forEach { (key, value) -> if (value == "null" || value.isBlank()) shell("settings delete secure $key") else shell("settings put secure $key $value") }
                // TalkBack stops a moment after its setting goes: the next holder of the emulator gets plain touch back.
                val off = SystemClock.uptimeMillis() + 15_000
                while (manager.isTouchExplorationEnabled && SystemClock.uptimeMillis() < off) SystemClock.sleep(250)
                note("restored ${saved.keys.associateWith { shell("settings get secure $it").trim() }} touch_exploration=${manager.isTouchExplorationEnabled}")
            }
        }
    }

    // ---- What TalkBack reads. ----

    /** The row TalkBack lands on for [title], read afresh from the app's window. */
    private fun talkBackRow(title: String): AccessibilityNodeInfo {
        var found: AccessibilityNodeInfo? = null
        val deadline = SystemClock.uptimeMillis() + 10_000
        while (found == null && SystemClock.uptimeMillis() < deadline) {
            found = appRoot()?.let(::accessibilityNodes)?.firstOrNull { it.isVisibleToUser && it.isClickable && spoken(it).contains(title) }
            if (found == null) SystemClock.sleep(250)
        }
        return found ?: error("TalkBack has no row that says \"$title\"")
    }
    private fun AccessibilityNodeInfo.act(label: String): Boolean {
        val action = actionList.firstOrNull { it.label?.toString() == label } ?: error("no action \"$label\" in $actionList")
        return performAction(action.id)
    }
    private fun appRoot(): AccessibilityNodeInfo? {
        if (Build.VERSION.SDK_INT >= 34) automation.clearCache() else automation.apply { serviceInfo = serviceInfo }
        val info = automation.serviceInfo
        if (info.flags and AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS == 0)
            automation.serviceInfo = info.apply { flags = flags or AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS }
        return automation.windows.mapNotNull { it.root }.firstOrNull { it.packageName?.toString() == app.packageName } ?: automation.rootInActiveWindow
    }
    private fun accessibilityNodes(root: AccessibilityNodeInfo): Sequence<AccessibilityNodeInfo> =
        sequenceOf(root) + (0 until root.childCount).asSequence().mapNotNull(root::getChild).flatMap(::accessibilityNodes)
    /** What TalkBack says on a node it stops on: its words, its state, then the words of the children it does not stop on. */
    private fun spoken(node: AccessibilityNodeInfo): String {
        fun parts(node: AccessibilityNodeInfo): List<String> {
            val label = node.contentDescription?.toString()?.trim().orEmpty()
            val own = listOf(label.ifEmpty { node.text?.toString()?.trim().orEmpty() }, node.stateDescription?.toString()?.trim().orEmpty())
            val children = if (label.isNotEmpty()) emptyList() else (0 until node.childCount).mapNotNull(node::getChild).filterNot { it.isClickable }.flatMap(::parts)
            return (own + children).filter { it.isNotEmpty() }
        }
        return parts(node).joinToString(", ")
    }
    /** What TalkBack gave the speech engine since [since] (epoch ms), utterance by utterance. */
    private fun heard(since: Long): List<String> {
        val time = "${since / 1000}.${(since % 1000).toString().padStart(3, '0')}"
        return shell("logcat -d -v raw -s ${TalkBackSpeechRecorder.TAG}:I -T $time").lines().map(String::trim)
            .filter { it.isNotEmpty() && !it.startsWith("--------- beginning of") }
    }

    /** Where a right swipe starts decides whose it is. The positions are the window's pixels; the strip is 18 dp past the system's gesture inset. */
    private fun edges() {
        val density = instrumentation.targetContext.resources.displayMetrics.density
        val (left, _) = gestureInsets()
        val row = bounds(rowOf("Polish the pricing page"))
        val y = row.center.y.roundToInt()
        val strip = left + (9 * density).roundToInt()
        note("edge: strip start x=$strip (system inset $left, 18 dp strip)")

        // Just past the system's inset: the drawer.
        assertFalse("the drawer starts shut", drawerOpen())
        drag(strip.toFloat(), row.width * 0.75f, y.toFloat())
        await { drawerOpen() }
        assertFalse("the row stayed shut", exists(button("Complete")))
        capture("26-right-swipe-in-the-strip-opens-the-drawer")
        pressBack(); await { !drawerOpen() }

        // On the row's middle: the row.
        swipeRight("Polish the pricing page")
        await { exists(button("Complete")) }
        assertFalse("the drawer stayed shut", drawerOpen())
        closeByTapOn("Trace the slow login")

        // On what has no swipe: the drawer, as today.
        assertFalse("the drawer starts shut", drawerOpen())
        val folder = bounds(hasTestTag("folder-row:$release"))
        val folderY = folder.center.y.roundToInt()
        drag(folder.width * 0.3f, folder.width * 0.85f, folderY.toFloat())
        await { drawerOpen() }
        capture("27-right-swipe-on-a-folder-row-opens-the-drawer")
        pressBack(); await { !drawerOpen() }

        // The system's own edge, where it has one: Back, not the row. With the list as the root there is nothing to go back to and
        // the system would leave the app, so this is tried over a page pushed on the list.
        if (left > 0) {
            compose.onNode(projectRow()).performClick(); settle()
            await { exists(hasTestTag("project-sessions")) && exists(rowOf("Wire tests")) }
            val member = bounds(rowOf("Wire tests"))
            shell("input touchscreen swipe 2 ${member.center.y.roundToInt()} ${(member.width * 0.7f).roundToInt()} ${member.center.y.roundToInt()} 350")
            await { !exists(hasTestTag("project-sessions")) }
            assertFalse("the row did not take it", exists(button("Complete")))
            note("edge: the system's Back took a right swipe from x=2")
            capture("28-right-swipe-from-the-screen-edge-is-system-back")
            // And a left swipe from the right edge.
            compose.onNode(projectRow()).performClick(); settle()
            await { exists(hasTestTag("project-sessions")) && exists(rowOf("Wire tests")) }
            val w = window().first
            shell("input touchscreen swipe ${w - 2} ${member.center.y.roundToInt()} ${(w * 0.3f).roundToInt()} ${member.center.y.roundToInt()} 350")
            await { !exists(hasTestTag("project-sessions")) }
            assertFalse("the row did not take it", exists(button("Delete")))
            note("edge: the system's Back took a left swipe from x=${w - 2}")
        } else note("edge: no system gesture inset on this navigation mode")
    }

    // ---- The fixture. ----

    private fun ago(minutes: Long) = Instant.now().minusSeconds(minutes * 60).toString()
    private fun membership(role: String) = """"projectMembership":{"projectId":"$launch","projectTitle":"Launch","projectStatus":"OPEN","role":"$role"}"""
    private fun row(id: String, title: String, line: String, minutes: Long, extra: String = "", workspace: String = orbit): String {
        val lifecycle = when (id) { in completed -> "COMPLETED"; in trash -> "TRASH"; else -> "OPEN" }
        val canComplete = id != held && lifecycle == "OPEN"
        return """{"id":"$id","title":"$title","status":"AWAITING_INPUT","runState":"AWAITING_INPUT","lifecycleState":"$lifecycle","agent":{"id":"$workspace","name":"orbit"},
            "agentId":"$workspace","createdAt":"${ago(6000)}","lastTurnAt":"${ago(minutes)}","pendingApprovals":0,"tags":[],"lastAssistantText":"$line",
            ${if (id in pins) """"pinnedAt":"${ago(9000)}",""" else ""}
            "capabilities":{"canComplete":$canComplete,"canRestore":${lifecycle != "OPEN"}}$extra}"""
    }
    private fun session(id: String) = when (id) {
        pinned -> row(id, "Release checklist", "The checklist is posted; two items wait on the store review.", 400)
        pricing -> row(id, "Polish the pricing page", "The new table is in; checking the narrow layout next.", 6)
        jobs -> row(id, "Partition the jobs table", "Done: jobs are partitioned by month and the old table is gone.", 25)
        login -> row(id, "Trace the slow login", "It was the token refresh; the fix is on the branch.", 70)
        postgres -> row(id, "Upgrade the Postgres client", "Upgraded. Nothing else in the lockfile moved.", 95)
        held -> row(id, "Held by a review", "Its report is waiting on a reviewer.", 130)
        notesRow -> row(id, "Write the upgrade notes", "Drafted the notes; waiting on the version number.", 170)
        coordinator -> row(id, "Coordinate launch", "Three of eight tasks are done.", 15, ",${membership("COORDINATOR")}")
        member -> row(id, "Wire tests", "All green on the branch.", 40, ",${membership("TASK")}")
        filed -> row(id, "Cut the beta", "Tagged and building.", 210, ""","folderId":"$release"""")
        tracker -> row(id, "Sweep the old feature flags", "Removed four flags; two are still read.", 1600)
        shipped -> row(id, "Shipped docs", "Published.", 3000, ""","completedAt":"${ago(3000)}"""")
        badge -> row(id, "Fix the push badge", "The count is right now.", 4400, ""","completedAt":"${ago(4400)}"""")
        old -> row(id, "Old experiment", "Abandoned.", 5000, ""","deletedAt":"${ago(5000)}"""")
        else -> row(id, "Scratch notes", "Nothing to keep.", 5200, ""","deletedAt":"${ago(5200)}"""")
    }
    private fun list(rows: List<String>) = rows.joinToString(",", "[", "]") { session(it) }

    private fun fixture() = object : Dispatcher() {
        override fun dispatch(request: RecordedRequest): MockResponse {
            val path = request.requestUrl!!.encodedPath
            calls += "${request.method} ${request.path}"
            if (path == "/api/auth/methods") return MockResponse().setResponseCode(404)
            val parts = path.removePrefix("/api/").split('/').map { part -> ids.firstOrNull { ObjectId.same(it, part) } ?: part }
            calls[calls.size - 1] = "${request.method} /api/${parts.joinToString("/")}" + (request.requestUrl!!.query?.let { "?$it" } ?: "")
            val view = request.requestUrl!!.queryParameter("view") ?: "open"
            val project = request.requestUrl!!.queryParameter("projectId")
            fun id() = parts[1]
            val body = when {
                path == "/api/auth/login" -> """{"accessToken":"row-swipe-access","refreshToken":"row-swipe-refresh","user":{"id":"u1","email":"rows@example.test","name":"Row swipe fixture"}}"""
                path == "/api/users/me" -> """{"id":"u1","email":"rows@example.test","name":"Row swipe fixture","preferences":{"theme":"$theme"}}"""
                path == "/api/workspaces" -> """[{"id":"$orbit","name":"orbit","runnerId":"r1","enabled":true,"position":0,"createdAt":"2026-10-01T01:00:00.000Z"},
                    {"id":"$api","name":"api-server","runnerId":"r1","enabled":true,"position":1,"createdAt":"2026-10-01T02:00:00.000Z"}]"""
                path == "/api/runners" -> """[{"id":"r1","name":"Fixture runner","online":true}]"""
                path == "/api/session-folders" -> """[{"id":"$release","workspaceId":"$orbit","name":"Release"}]"""
                path == "/api/sessions" && project != null -> if (view == "open") list(listOf(coordinator, member).filter { it in open }) else "[]"
                path == "/api/sessions" -> when (view) { "open" -> list(open); "completed" -> list(completed); "trash" -> list(trash); else -> "[]" }
                parts[0] == "sessions" && parts.size == 2 && request.method == "DELETE" -> { open = open - id(); completed = completed - id(); trash = trash + id(); "{}" }
                parts[0] == "sessions" && parts.last() == "purge" -> { trash = trash - id(); "{}" }
                parts[0] == "sessions" && parts.last() == "complete" -> { open = open - id(); completed = completed + id(); "{}" }
                parts[0] == "sessions" && parts.last() == "restore" -> { completed = completed - id(); trash = trash - id(); open = open + id(); "{}" }
                parts[0] == "sessions" && parts.last() == "pin" -> { pins = if (request.method == "POST") pins + id() else pins - id(); "{}" }
                parts[0] == "sessions" && parts.last() == "move-targets" -> """{"workspaceId":"$orbit","folderId":null,"folders":[{"id":"$release","name":"Release","sessionCount":1}],
                    "targets":[{"workspaceId":"$api","name":"api-server","folders":[]}]}"""
                parts[0] == "sessions" && parts.size == 2 && request.method == "GET" -> session(id())
                parts[0] == "sessions" && parts.last() == "events" -> return heartbeatStream()
                parts[0] == "sessions" && parts.last() == "page" -> """{"events":[],"hasMore":false,"lastSeq":0,"latestSeq":0}"""
                path == "/api/events" -> return heartbeatStream()
                path == "/api/projects/sidebar" -> """[{"id":"$launch","title":"Launch","status":"OPEN","createdAt":"2026-10-01T00:00:00Z","buckets":{"running":0},
                    "taskCounts":{"done":3,"failed":0,"total":8},"startedAt":"2026-10-02T00:00:00Z"}]"""
                path == "/api/projects" -> """[{"id":"$launch","title":"Launch","status":"OPEN","goal":"Ship it.","createdAt":"2026-10-01T00:00:00Z"}]"""
                parts[0] == "projects" -> "{}"
                parts[0] == "wiki" -> return MockResponse().setResponseCode(404).setHeader("Content-Type", "application/json").setBody("""{"code":"WIKI_DISABLED","message":"The wiki is off."}""")
                path.endsWith("/logout") -> "{}"
                request.method == "GET" -> "[]"
                else -> "{}"
            }
            return MockResponse().setHeader("Content-Type", "application/json").setBody(body)
        }
    }
    private fun heartbeatStream() = MockResponse().setHeader("Content-Type", "text/event-stream").setChunkedBody(": connected\n\n".repeat(240), 13)
        .throttleBody(13, 1, java.util.concurrent.TimeUnit.SECONDS)

    // ---- Touches, through the system's input. ----

    private fun shell(command: String) = automation.executeShellCommand(command).let { fd -> ParcelFileDescriptor.AutoCloseInputStream(fd).use { it.readBytes().decodeToString() } }
    /**
     * A finger's drag, injected into the system's input as a touchscreen's events with their own times: a down, [steps] moves 16 ms apart,
     * and an up, so a loaded device cannot run them together into a tap, and the velocity is what a finger at that pace has. With [up]
     * false the finger stays down, and the returned function lifts it.
     */
    private fun drag(from: Float, to: Float, y: Float, steps: Int = 12, up: Boolean = true, holdMs: Long = 0): () -> Unit =
        drag(from, y, to, y, steps, up, holdMs)
    private fun drag(x1: Float, y1: Float, x2: Float, y2: Float, steps: Int = 12, up: Boolean = true, holdMs: Long = 0): () -> Unit {
        val downTime = SystemClock.uptimeMillis()
        fun send(action: Int, x: Float, y: Float) {
            val event = MotionEvent.obtain(downTime, SystemClock.uptimeMillis(), action, x, y, 0).apply { source = InputDevice.SOURCE_TOUCHSCREEN }
            assertTrue("the system took the injected touch", automation.injectInputEvent(event, true))
            event.recycle()
        }
        send(MotionEvent.ACTION_DOWN, x1, y1)
        // A long press is timed on the composition's clock, which the test rule drives: it moves only when told to.
        if (holdMs > 0) { SystemClock.sleep(holdMs); compose.mainClock.advanceTimeBy(holdMs) }
        for (i in 1..steps) { SystemClock.sleep(16); send(MotionEvent.ACTION_MOVE, x1 + (x2 - x1) * i / steps, y1 + (y2 - y1) * i / steps) }
        val lift = { send(MotionEvent.ACTION_UP, x2, y2); settle() }
        if (up) lift() else { SystemClock.sleep(300); settle() }
        return lift
    }
    private fun swipe(from: Float, to: Float, y: Float) { drag(from, to, y) }
    private fun swipeLeft(title: String) = swipeLeft(rowOf(title))
    private fun swipeLeft(row: SemanticsMatcher) { compose.onNode(row).performScrollTo(); val b = bounds(row); swipe(b.width * 0.8f, b.width * 0.35f, b.center.y) }
    private fun swipeRight(title: String) = swipeRight(rowOf(title))
    private fun swipeRight(row: SemanticsMatcher) { compose.onNode(row).performScrollTo(); val b = bounds(row); swipe(b.width * 0.25f, b.width * 0.65f, b.center.y) }
    private fun longSwipeLeft(title: String) { compose.onNode(rowOf(title)).performScrollTo(); val b = bounds(rowOf(title)); swipe(b.width * 0.9f, b.width * 0.1f, b.center.y) }
    private fun longSwipeRight(title: String) { compose.onNode(rowOf(title)).performScrollTo(); val b = bounds(rowOf(title)); swipe(b.width * 0.15f, b.width * 0.9f, b.center.y) }
    private fun longPress(title: String) { val c = bounds(rowOf(title)).center; drag(c.x, c.x, c.y, steps = 0, holdMs = 900) }
    private fun tapOn(row: SemanticsMatcher) { val c = bounds(row).center; drag(c.x, c.x, c.y, steps = 0) }
    private fun closeByTapOn(title: String) {
        tapOn(rowOf(title))
        await { !exists(hasTestTag("row-action:Delete")) && !exists(hasTestTag("row-action:Complete")) && !exists(hasTestTag("row-action:Move to Open")) && !exists(hasTestTag("row-action:Pin")) && !exists(hasTestTag("row-action:Move")) && !exists(hasTestTag("row-action:Delete Permanently")) }
        assertTrue("the tap opened nothing", exists(rowOf(title)))
    }
    private fun pressBack() { instrumentation.sendKeyDownUpSync(KeyEvent.KEYCODE_BACK); settle() }
    private fun pickScope(name: String) {
        compose.onNode(hasContentDescription("Session scope", substring = true)).performClick(); settle()
        compose.onNode(hasText(name) and hasAnyAncestor(isPopup())).performClick(); settle()
    }

    // ---- What is on screen. ----

    private fun rowOf(title: String) = hasRowMenu("Options for $title")
    private fun projectRow() = hasTestTag("project-row:$launch")
    private fun button(title: String) = hasTestTag("row-action:$title")
    private fun bounds(matcher: SemanticsMatcher): Rect = compose.onNode(matcher).fetchSemanticsNode().boundsInWindow
    /** The closed drawer stays composed a sheet's width off screen, so its rows are found either way: open is on screen. Its position,
     * not its bounds, which are clipped to the window and so read 0 off screen too. */
    private fun drawerOpen() = compose.onAllNodes(hasText("Tasks")).fetchSemanticsNodes().any { it.positionInWindow.x >= 0f }
    private fun toastShows(text: String) = exists(hasText(text) and hasAnyAncestor(hasTestTag("toast")))
    /** A toast's dwell is a delay on the composition's clock, which the test rule drives: a loaded device turns a real-time wait into a
     * fraction of the toast's own time, so the clock is moved on instead. */
    private fun dismissToasts() {
        val dismiss = hasContentDescription("Dismiss") and hasAnyAncestor(hasTestTag("toast"))
        repeat(20) {
            if (!exists(hasTestTag("toast"))) return
            if (exists(dismiss)) compose.onAllNodes(dismiss).onFirst().performClick()
            compose.mainClock.advanceTimeBy(2_000)
            compose.waitForIdle()
        }
        assertFalse("the toasts went", exists(hasTestTag("toast")))
    }
    private fun window(): Pair<Int, Int> { var size = 0 to 0; scenario.onActivity { size = it.window.decorView.width to it.window.decorView.height }; return size }
    private fun gestureInsets(): Pair<Int, Int> {
        var insets = 0 to 0
        scenario.onActivity { activity ->
            val g = ViewCompat.getRootWindowInsets(activity.window.decorView)?.getInsets(WindowInsetsCompat.Type.systemGestures())
            insets = (g?.left ?: 0) to (g?.right ?: 0)
        }
        return insets
    }
    private fun exists(matcher: SemanticsMatcher) = compose.onAllNodes(matcher).fetchSemanticsNodes().isNotEmpty()
    private fun await(condition: () -> Boolean) = compose.waitUntil(30_000, condition)
    private fun note(line: String) { notes.appendLine(line) }
    private fun settle() {
        compose.waitForIdle()
        instrumentation.waitForIdleSync()
        automation.waitForIdle(300, 5_000)
    }
    /** The screen once it has stopped changing: two shots in a row alike, since the emulator's frames lag the app under load. */
    private fun capture(name: String, into: File = evidence) {
        compose.waitForIdle()
        var last: Bitmap? = null
        var shot: Bitmap? = null
        for (attempt in 1..12) {
            SystemClock.sleep(350)
            val now = automation.takeScreenshot() ?: continue
            if (last != null && last.sameAs(now)) { shot = now; break }
            last?.recycle(); last = now
        }
        val frame = shot ?: last ?: run { File(into, "$name.missing").writeText("takeScreenshot returned null\n"); return }
        if (shot == null) note("$name: the screen was still changing after 12 shots")
        File(into, "$name.png").outputStream().use { frame.compress(Bitmap.CompressFormat.PNG, 100, it) }
        if (last !== frame) last?.recycle()
        frame.recycle()
    }
}
