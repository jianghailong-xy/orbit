package io.orbitd.android.increments

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.RectF
import android.os.ParcelFileDescriptor
import android.os.SystemClock
import android.view.accessibility.AccessibilityNodeInfo
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.test.*
import androidx.test.ext.junit.runners.AndroidJUnit4
import io.orbitd.android.core.cards.EvidenceFiles
import io.orbitd.android.core.cards.OwnerReview
import java.io.ByteArrayOutputStream
import java.time.Instant
import java.time.temporal.ChronoUnit
import java.util.concurrent.ConcurrentHashMap
import okhttp3.mockwebserver.MockResponse
import okio.Buffer
import org.junit.Test
import org.junit.runner.RunWith

/**
 * The evidence card's files on a device (docs/orbit-files-design.md §2.6, board docs/mocks/orbit-files/4-card.png): a coordinator
 * conversation served by the test's own fixture, T6's route in its own shape, and real PNG bytes to decode. Its screenshots are the five
 * scenes the board draws — today, the default state, the Evidence files page, the viewer, and expired — and what the board does not
 * draw: failed cases, a report opened, and the doors of a file that can only be saved or shared.
 *
 * The dated `Expired` is the fixture's: the latest version never expires (§2.8) and only the latest version is a card, so real data
 * reaches this card with the undated placeholder of a row that went, which [aRowThatWent] draws.
 */
@RunWith(AndroidJUnit4::class)
class EvidenceFilesDeviceTest : IncrementDeviceTest() {
    private val coord = "34T8edSessionCoord0001"
    private val project = "34T8edProjectFiles0001"
    private val task = "34T8edTaskEvidence0001"
    private val key = "evidence:$task:2"
    private val lightOpen = "34T8edFileLightOpen001"
    private val lightShut = "34T8edFileLightShut001"
    private val darkOpen = "34T8edFileDarkOpen0001"
    private val darkShut = "34T8edFileDarkShut0001"
    private val deskOpen = "34T8edFileDeskOpen0001"
    private val deskShut = "34T8edFileDeskShut0001"
    private val webkitOpen = "34T8edFileWebkitOpen01"
    private val webkitShut = "34T8edFileWebkitShut01"
    private val report = "34T8edFileReportJson01"
    private val page = "34T8edFileNotesPage001"
    private val vector = "34T8edFileNotesVector1"
    private val mislabelled = "34T8edFileMislabelled1"
    private val mislaid = "34T8edFileLostBytes001"
    override val ids get() = listOf(workspace, runner, coord, project, task, lightOpen, lightShut, darkOpen, darkShut, deskOpen, deskShut, webkitOpen, webkitShut,
        report, page, vector, mislabelled, mislaid)
    private val sha = "3f9a1c07aabbccddeeff00112233445566778899aabbccddeeff001122334455"
    private val submittedAt = Instant.now().minusSeconds(360).toString()

    private val bytes = ConcurrentHashMap<String, ByteArray>()
    @Volatile private var citations = ""
    @Volatile private var files = ""

    private fun detail() = """{"id":"$coord","title":"Coordinate the keyboard work","projectId":"$project","status":"AWAITING_INPUT","runState":"AWAITING_INPUT",
        "lifecycleState":"OPEN","agentId":"$workspace","agent":{"id":"$workspace","name":"Alpha"},"assignedRunnerId":"$runner","provider":"claude","model":"claude-opus-5-5",
        "createdAt":"${ago(600)}","lastTurnAt":"${ago(6)}","pendingApprovals":1,"lastAssistantText":"Reading what came in.",
        "capabilities":{"canSend":true,"canComplete":true},"tags":[]}"""
    override fun sessions(view: String, project: String?) = if (view == "open") "[${detail()}]" else "[]"

    private fun queue() = """{"decidingSessionId":"$coord","count":1,"oldestAgeSeconds":360,"pending":[{"taskId":"$task","title":"P4.3 keyboard windows for menus and selects",
        "status":"IN_PROGRESS","projectId":"$project","ownerCard":null,"criterion":{"key":"keys","text":"On desktop and phone, focus, scrolling and closing in menus and selects behave as they did before the migration."},
        "evidenceRevision":"2","submittedAt":"$submittedAt","ageSeconds":360,"claim":"Menus and selects match the migration on Chromium and WebKit.",
        "gaps":["Ran on Chromium and WebKit, not Firefox.","The phone viewport was emulated, not a real device."],"citations":[$citations],
        "decidability":{"decidable":true,"refusal":null,"requiredAction":null},"independence":{"independent":true,"disqualification":null,"requiredAction":null}}],
        "waitingOnYou":[],"waitingOnCoordinator":[],"sentToCoordinator":[],"decided":[]}"""

    override fun answer(req: Req): MockResponse? = when {
        req.path == "sessions/$coord" && req.method == "GET" -> json(detail())
        req.path == "sessions/$coord/events/page" -> json(page(listOf(event(1, "user", """{"text":"Decide each task’s evidence as it comes in."}"""),
            event(2, "assistant", """{"text":"Reading what came in."}"""))))
        req.path == "tasks/evidence-decisions/pending" -> json(queue())
        req.path == "tasks/$task/evidence/2/files" -> json(files)
        req.path.startsWith("attachments/") -> bytes[req.path.removePrefix("attachments/")]?.let {
            MockResponse().setHeader("Content-Type", "application/octet-stream").setBody(Buffer().write(it))
        } ?: json("""{"message":"attachment not found"}""", 404)
        req.path == "projects/$project" -> json("""{"id":"$project","title":"Keyboard windows","status":"OPEN","goal":"Windows.","createdAt":"${ago(2000)}",
            "startedAt":"${ago(1900)}","coordinatorSessionId":"$coord","_count":{"tasks":4},"acceptanceCriteriaItems":[]}""")
        req.path == "projects/$project/open-items" -> json("""{"needsYou":[],"withCoordinator":[]}""")
        req.path == "projects/$project/promotions/current" -> empty200()
        req.path == "projects/$project/promotions/merged" -> json("[]")
        req.path.startsWith("projects/$project/") -> json("{}")
        else -> null
    }

    // ---- The fixture: the board's nine files, and pictures like the ones it draws. ----

    /** A page with a menu on it, as the board's tiles have: bars, a panel when it is open, and its selected row. */
    private fun picture(width: Int, height: Int, dark: Boolean, open: Boolean): ByteArray {
        val bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(bitmap)
        val paint = Paint(Paint.ANTI_ALIAS_FLAG)
        val unit = width / 20f
        fun bar(left: Float, top: Float, right: Float, tall: Float, color: Int) {
            paint.color = color
            canvas.drawRoundRect(RectF(left, top, right, top + tall), tall / 2, tall / 2, paint)
        }
        val quiet = if (dark) Color.rgb(74, 77, 86) else Color.rgb(208, 211, 218)
        canvas.drawColor(if (dark) Color.rgb(24, 25, 29) else Color.rgb(244, 245, 247))
        paint.color = if (dark) Color.rgb(38, 40, 46) else Color.WHITE
        canvas.drawRect(0f, 0f, width.toFloat(), unit * 2.4f, paint)
        bar(unit, unit * 0.9f, unit * 8, unit * 0.6f, quiet)
        repeat(3) { bar(unit, unit * (4f + it * 1.3f), width - unit * (1f + it * 2.5f), unit * 0.5f, quiet) }
        val top = unit * if (open) 8f else 11f
        paint.color = if (dark) Color.rgb(38, 40, 46) else Color.WHITE
        canvas.drawRoundRect(RectF(unit * 2, top, width - unit * 2, top + unit * if (open) 11f else 5f), unit, unit, paint)
        repeat(if (open) 5 else 2) {
            val row = top + unit * (1.2f + it * 1.9f)
            if (it == 1) bar(unit * 3, row, width - unit * 3, unit * 0.8f, Color.rgb(61, 107, 229))
            else bar(unit * 3, row + unit * 0.1f, width - unit * 5, unit * 0.5f, quiet)
        }
        return ByteArrayOutputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it); it.toByteArray() }.also { bitmap.recycle() }
    }

    private fun servePictures() {
        bytes[lightOpen] = picture(780, 1688, dark = false, open = true)
        bytes[lightShut] = picture(780, 1688, dark = false, open = false)
        bytes[darkOpen] = picture(780, 1688, dark = true, open = true)
        bytes[darkShut] = picture(780, 1688, dark = true, open = false)
        bytes[deskOpen] = picture(1440, 900, dark = false, open = true)
        bytes[deskShut] = picture(1440, 900, dark = false, open = false)
        bytes[webkitOpen] = picture(780, 1688, dark = false, open = true)
        bytes[webkitShut] = picture(780, 1688, dark = false, open = false)
    }

    private fun q(text: String?) = if (text == null) "null" else quote(text)
    private fun file(id: String, name: String?, folder: String? = "menu-shots", mime: String? = "image/png", size: Long? = 214L * 1024, expiredAt: String? = null, gone: Boolean = false) =
        """{"id":"$id","kind":"file","name":${q(name)},"label":null,"mimeType":${q(mime)},"sizeBytes":$size,"sha256":"$sha","folder":${q(folder)},"width":null,"height":null,
        "expiredAt":${q(expiredAt)},"gone":$gone,"testReport":null,"createdAt":null,"sessionId":null,"taskId":null,"fileBundleId":null}"""
    private fun pageOf(rows: List<String>, count: Int = rows.size, total: Long = 1_887_437) =
        """{"revision":"2","submittedAt":"$submittedAt","fileCount":$count,"totalBytes":$total,"files":${rows.joinToString(",", "[", "]")},"nextOffset":null}"""
    private fun nine(expiredAt: String? = null) = listOf(
        file(lightOpen, "chromium-light-phone/menu-open.png", expiredAt = expiredAt), file(lightShut, "chromium-light-phone/menu-shut.png", expiredAt = expiredAt),
        file(darkOpen, "chromium-dark-phone/menu-open.png", expiredAt = expiredAt), file(darkShut, "chromium-dark-phone/menu-shut.png", expiredAt = expiredAt),
        file(deskOpen, "chromium-light-desktop/menu-open.png", expiredAt = expiredAt), file(deskShut, "chromium-light-desktop/menu-shut.png", expiredAt = expiredAt),
        file(webkitOpen, "webkit-light-phone/menu-open.png", expiredAt = expiredAt), file(webkitShut, "webkit-light-phone/menu-shut.png", expiredAt = expiredAt),
        file(report, "report.json", folder = null, mime = "application/json", size = 12L * 1024, expiredAt = expiredAt))
    private val toolCalls = listOf("Ran the keyboard suite", "Ran the type check").mapIndexed { index, label ->
        """{"kind":"TOOL_CALL","ref":"bgj_5f0c2a9e41d$index","resolved":true,"reason":null,"label":"$label"}""" }
    private val bundle = """{"kind":"FILE","ref":"34T8edFileBundle000001","resolved":true,"reason":null,"label":"8 files · 1.8 MB"}"""
    private fun reportCitation(passed: Int = 46, failed: Int = 0, failedNames: List<String> = emptyList()) =
        """{"kind":"FILE","ref":"$report","resolved":true,"reason":null,"label":"report.json · 12 KB · application/json","testReport":{"format":"playwright",
        "total":${passed + failed + 2},"passed":$passed,"failed":$failed,"skipped":2,"durationMs":38000,"failedNames":${failedNames.joinToString(",", "[", "]") { quote(it) }},
        "skippedNames":["[webkit] › menu › scrolls with the keyboard","[webkit] › select › wraps at the last option"]}}"""
    private fun serveTheBoard() {
        servePictures()
        citations = (toolCalls + bundle + reportCitation()).joinToString(",")
        files = pageOf(nine())
    }

    // ---- The journeys. ----

    private fun openCard() {
        signIn()
        open("orbit-session:$coord")
        await("the evidence card") { exists(hasTestTag("transcript-list")) && app.realtime.state.value.session?.fresh == true }
        scrollTranscriptTo(hasTestTag(key))
        awaitTag(key)
    }
    private fun routeReads() = calls.count { it.startsWith("GET tasks/$task/evidence/2/files") }
    private fun attachmentReads() = calls.filter { it.startsWith("GET attachments/") }.map { it.removePrefix("GET attachments/") }
    private fun openPage() {
        await("the heading") { textOf("$key:files-head").startsWith("FILES ·") }
        compose.onNodeWithTag("$key:files").performClick()
        await("the Evidence files page") { exists(hasTestTag("evidence-files")) && exists(hasTestTag("evidence-files:version")) }
        SystemClock.sleep(1_000)
    }
    private fun settled() { SystemClock.sleep(1_000); settle() }

    /** Scene 1: a version citing no file. */
    @Test fun today() = journey {
        servePictures()
        citations = (toolCalls + """{"kind":"COMMIT","ref":"3b1230329","resolved":true,"reason":null,"label":"3b1230329 keyboard windows"}""").joinToString(",")
        files = pageOf(nine())
        openCard()
        verify("the criterion is drawn", says(key, "On desktop and phone", substring = true))
        verify("it has no file area", !exists(hasTestTag("$key:files"), unmerged = true))
        settled()
        capture("1-today")
        verify("the route was not called", routeReads() == 0)
        verify("no bytes were read", attachmentReads().isEmpty())
    }

    /** Scenes 2, 3 and 4: the area, the page, and the viewer on the third of eight pictures, swiped to the fourth. */
    @Test fun theDefaultStateThePageAndTheViewer() = journey {
        serveTheBoard()
        openCard()
        await("the heading") { textOf("$key:files-head") == "FILES · 9 · 1.8 MB" }
        verify("five more", says("$key:files-more", "+5"))
        verify("the report's line", textOf("$key:files-report:0") == "Playwright · 46 passed · 0 failed · 2 skipped")
        await("the four thumbnails to be read") { attachmentReads().size == 4 }
        settled()
        capture("2-default")
        openPage()
        verify("the version line", says("evidence-files:version", "Revision 2 · ${OwnerReview.receiptTime(submittedAt)}") && says("evidence-files:version", "9 files · 1.8 MB"))
        verify("the report", says("evidence-files:report:0", "Playwright report") && says("evidence-files:report:0", "46 passed · 0 failed · 2 skipped · 38s"))
        verify("the first folder and its count", textOf("evidence-files:group:chromium-light-phone") == "chromium-light-phone  2")
        settled()
        capture("3-evidence-files")
        compose.onNodeWithTag("evidence-files:report:0").performClick()
        await("the skipped cases") { says("evidence-files:report:0", "Skipped · 2") }
        settled()
        capture("3b-report-open")
        compose.onNodeWithTag("evidence-files:report:0").performClick()
        await("the report to fold") { !says("evidence-files:report:0", "Skipped · 2") }
        compose.onNodeWithTag("evidence-files:tile:$darkOpen").performClick()
        await("the viewer") { textOf("evidence-viewer:position") == "3 of 8" }
        await("the picture") { exists(hasTestTag("evidence-viewer:image"), unmerged = true) }
        await("its facts") { textOf("evidence-viewer:facts") == "214 KB · 780 × 1688 · sha256 3f9a1c07" }
        verify("its path", textOf("evidence-viewer:path") == "chromium-dark-phone/menu-open.png")
        settled()
        capture("4-viewer")
        compose.onNodeWithTag("evidence-viewer:pager").performTouchInput { swipeLeft() }
        await("the next picture") { textOf("evidence-viewer:position") == "4 of 8" }
        verify("its path", textOf("evidence-viewer:path") == "chromium-dark-phone/menu-shut.png")
        settled()
        capture("4b-viewer-next")
        compose.onNodeWithTag("evidence-viewer:pager").performTouchInput { pinch(center - Offset(150f, 0f), center - Offset(300f, 0f), center + Offset(150f, 0f), center + Offset(300f, 0f)) }
        settled()
        capture("4d-viewer-pinched")
        verify("a pinch does not turn the page", textOf("evidence-viewer:position") == "4 of 8")
        compose.onNodeWithTag("evidence-viewer:pager").performTouchInput { pinch(center - Offset(300f, 0f), center - Offset(10f, 0f), center + Offset(300f, 0f), center + Offset(10f, 0f)) }
        settled()
        compose.onNodeWithTag("evidence-viewer:doors").performClick()
        await("the viewer's two doors") { exists(hasTestTag("evidence-files:download")) && exists(hasTestTag("evidence-files:share")) }
        settled()
        capture("4c-viewer-doors")
    }

    /** What the board does not draw: a run that failed names its cases, up to three, and counts the rest. */
    @Test fun failedCasesAreNamed() = journey {
        serveTheBoard()
        citations = (toolCalls + bundle + reportCitation(40, 6, listOf("[webkit] › menu › closes on Escape", "[webkit] › select › keeps focus", "[chromium] › menu › wraps", "four", "five"))).joinToString(",")
        openCard()
        await("the failing line") { textOf("$key:files-report:0") == "Playwright · 40 passed · 6 failed · 2 skipped" }
        verify("the rest are counted", says("$key:files", "3 more"))
        settled()
        capture("2b-failed-cases")
    }

    /**
     * Scene 5, from the fixture: every file of this version has expired. Real data does not reach a card with this today: a dated `Expired` is
     * on an older version only, and only the latest version is a card.
     */
    @Test fun everyFileExpiredIsAFixture() = journey {
        val expiredAt = Instant.now().minus(6, ChronoUnit.DAYS).toString()
        val on = EvidenceFiles.expiryDate(expiredAt)!!
        citations = (toolCalls + bundle + reportCitation()).joinToString(",")
        files = pageOf(nine(expiredAt))
        openCard()
        await("the heading") { textOf("$key:files-head") == "FILES · 9 · 1.8 MB · EXPIRED ${on.uppercase()}" }
        verify("the tile is the dated placeholder", says("$key:files-tile:$lightOpen", "${EvidenceFiles.expired}\n$on"))
        verify("the report's summary outlives its file", textOf("$key:files-report:0") == "Playwright · 46 passed · 0 failed · 2 skipped")
        settled()
        capture("5-expired")
        verify("no bytes were read", attachmentReads().isEmpty())
        openPage()
        verify("the report is still there", says("evidence-files:report:0", "46 passed · 0 failed · 2 skipped · 38s"))
        settled()
        capture("5b-expired-page")
        compose.onNodeWithTag("evidence-files:grid").performScrollToNode(hasTestTag("evidence-files:tile:$report"))
        settled()
        capture("5c-expired-page-end")
        compose.onNodeWithTag("evidence-files:tile:$report").assertHasNoClickAction()
    }

    /** What real data reaches today: a row that went, from what the version recorded. The same placeholder, with no date and no size. */
    @Test fun aRowThatWent() = journey {
        citations = """{"kind":"FILE","ref":"$lightOpen","resolved":false,"reason":"not found"}"""
        files = pageOf(listOf(file(lightOpen, null, folder = null, mime = null, size = null, gone = true)), total = 0)
        openCard()
        await("the heading") { textOf("$key:files-head") == "FILES · 1 · EXPIRED" }
        verify("the undated placeholder", says("$key:files-tile:$lightOpen", EvidenceFiles.expired))
        settled()
        capture("5d-gone-card")
        openPage()
        verify("one file, and no size it can't state", says("evidence-files:version", "1 file"))
        settled()
        capture("5e-gone-page")
        compose.onNodeWithTag("evidence-files:tile:$lightOpen").assertHasNoClickAction()
    }

    /** An SVG, a page, and bytes labelled a picture that aren't one: none of them is drawn, and each is two presses from being saved or shared. */
    @Test fun whatMayOnlyBeSavedOrShared() = journey {
        servePictures()
        // Its own name each run: the shared emulator's Downloads may remember an earlier one, and would save this under another name.
        val stamp = System.currentTimeMillis() % 1_000_000
        val saved = "report-$stamp.html"
        val path = "notes/$saved"
        // Listed, and its bytes do not come.
        val lost = "lost-$stamp.txt"
        bytes[page] = "<!doctype html><title>report</title><script>document.title='ran'</script>".encodeToByteArray()
        bytes[vector] = "<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>".encodeToByteArray()
        bytes[mislabelled] = "<!doctype html><script>document.title='ran'</script>".encodeToByteArray()
        citations = (toolCalls + bundle).joinToString(",")
        files = pageOf(listOf(file(lightOpen, "shots/menu-open.png"), file(mislabelled, "shots/not-a-picture.png", size = 54),
            file(page, path, mime = "text/html", size = 74), file(vector, "notes/vector.svg", mime = "image/svg+xml", size = 72),
            file(mislaid, "notes/$lost", mime = "text/plain", size = 9)), total = 214L * 1024 + 200)
        openCard()
        await("the mislabelled file to be read and refused") { attachmentReads().size == 2 && says("$key:files-tile:$mislabelled", "PNG") }
        openPage()
        verify("the page's kind", says("evidence-files:tile:$page", "HTML"))
        verify("the vector's kind", says("evidence-files:tile:$vector", "SVG"))
        verify("neither was read", attachmentReads().none { it == page || it == vector })
        settled()
        capture("6-only-saved-or-shared")
        compose.onNodeWithContentDescription(EvidenceFiles.downloadName(path)).performClick()
        await("its two doors") { exists(hasTestTag("evidence-files:download")) && exists(hasTestTag("evidence-files:share")) }
        verify("no viewer opened", !exists(hasTestTag("evidence-viewer")))
        settled()
        capture("6b-doors")
        compose.onNodeWithTag("evidence-files:share").performClick()
        await("the file to be read for its share") { attachmentReads().any { it == page } }
        settled(); SystemClock.sleep(2_000)
        capture("6c-share-sheet")
        instrumentation.uiAutomation.executeShellCommand("input keyevent KEYCODE_BACK").close()
        settled(); SystemClock.sleep(1_000)
        compose.onNodeWithContentDescription(EvidenceFiles.downloadName(path)).performClick()
        await("its two doors again") { exists(hasTestTag("evidence-files:download")) }
        compose.onNodeWithTag("evidence-files:download").performClick()
        settled(); SystemClock.sleep(2_500)
        capture("6d-save-screen")
        // The system's own button, and then the bytes the app wrote through what it answered.
        await("the save screen's button") { pressSystemButton("SAVE") }
        // The app's window is not back the moment the system's screen goes: until it is, there is nothing here for a test to read.
        await("the save's own word") { runCatching { textOf("evidence-files:notice") == EvidenceFiles.saved }.getOrDefault(false) }
        settled()
        capture("6e-saved")
        val written = shell("cat /sdcard/Download/$saved")
        verify("the saved file is the file's bytes", written.contentEquals(bytes[page]))
        shell("rm /sdcard/Download/$saved")
        // A save whose bytes never come: the system's screen has made the file by then, and it must not stay behind empty.
        compose.onNodeWithContentDescription(EvidenceFiles.downloadName("notes/$lost")).performClick()
        await("the lost file's doors") { exists(hasTestTag("evidence-files:download")) }
        compose.onNodeWithTag("evidence-files:download").performClick()
        settled(); SystemClock.sleep(2_500)
        await("the save screen's button") { pressSystemButton("SAVE") }
        await("the save's refusal") { runCatching { textOf("evidence-files:notice") == EvidenceFiles.downloadFailed }.getOrDefault(false) }
        settled()
        capture("6f-save-failed")
        verify("no empty file is left behind", lost !in String(shell("ls /sdcard/Download")))
    }

    /** A button on a screen that is not this app's, by its word: the accessibility tree is the one way in from here. */
    private fun pressSystemButton(word: String): Boolean = instrumentation.uiAutomation.rootInActiveWindow
        ?.findAccessibilityNodeInfosByText(word)?.firstOrNull { it.isClickable }?.performAction(AccessibilityNodeInfo.ACTION_CLICK) == true

    private fun shell(command: String): ByteArray = instrumentation.uiAutomation.executeShellCommand(command).let { descriptor ->
        ParcelFileDescriptor.AutoCloseInputStream(descriptor).use { it.readBytes() }
    }
}
