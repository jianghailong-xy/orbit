package io.orbitd.android.cards

import android.app.Activity
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Canvas
import android.net.Uri
import android.os.Looper
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.core.content.FileProvider
import io.orbitd.android.MainActivity
import io.orbitd.android.OrbitApplication
import io.orbitd.android.core.auth.*
import io.orbitd.android.core.cards.EvidenceFile
import io.orbitd.android.core.cards.EvidenceFileList
import io.orbitd.android.core.cards.EvidenceFiles
import io.orbitd.android.core.cards.OwnerReview
import io.orbitd.android.core.net.*
import io.orbitd.android.core.realtime.EventTransport
import io.orbitd.android.core.realtime.SseFrame
import io.orbitd.android.navigation.ObjectId
import java.io.ByteArrayOutputStream
import java.io.File
import java.time.Instant
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CopyOnWriteArrayList
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/** One controlled Orbit server for the evidence card's files: a coordinator conversation whose pending read holds one task's evidence,
 * and T6's route, in its own shape, over whichever files a test puts on it. Not a deployed backend. */
internal object EvidenceFilesServer {
    const val WORKSPACE = "34T8efWorkspaceAlpha01"
    const val COORD = "34T8efSessionCoord0001"
    const val PROJECT = "34T8efProjectFiles0001"
    const val TASK = "34T8efTaskEvidence0001"
    const val KEY = "evidence:$TASK:2"
    const val SHA = "3f9a1c07aabbccddeeff00112233445566778899aabbccddeeff001122334455"
    const val TITLE = "P4.3 keyboard windows"
    const val CRITERION = "Keyboard behaviour matches the migration."
    const val CLAIM = "It matches on both engines."
    const val GAP = "Firefox was not run."
    const val SUBMITTED = "2026-11-02T06:41:00.000Z"
    const val LIGHT_OPEN = "34T8efFileLightOpen001"
    const val LIGHT_SHUT = "34T8efFileLightShut001"
    const val DARK_OPEN = "34T8efFileDarkOpen0001"
    const val DARK_SHUT = "34T8efFileDarkShut0001"
    const val DESK_OPEN = "34T8efFileDeskOpen0001"
    const val DESK_SHUT = "34T8efFileDeskShut0001"
    const val WEBKIT_OPEN = "34T8efFileWebkitOpen01"
    const val WEBKIT_SHUT = "34T8efFileWebkitShut01"
    const val REPORT = "34T8efFileReportJson01"
    const val PAGE = "34T8efFileNotesPage001"
    const val VECTOR = "34T8efFileNotesVector1"
    private val ids = listOf(WORKSPACE, COORD, PROJECT, TASK, LIGHT_OPEN, LIGHT_SHUT, DARK_OPEN, DARK_SHUT, DESK_OPEN, DESK_SHUT, WEBKIT_OPEN, WEBKIT_SHUT, REPORT, PAGE, VECTOR)

    @Volatile var citations = ""
    /** The route's pages by offset; with none, the route says it could not answer. */
    @Volatile var pages: Map<Int, String> = emptyMap()
    /** While set, the route's answer waits on it. */
    @Volatile var hold: CompletableDeferred<Unit>? = null
    /** Whether the version is still in the pending read. */
    @Volatile var pending = true
    /** While set, the bytes of a file wait on it. */
    @Volatile var holdBytes: CompletableDeferred<Unit>? = null
    /** The bytes of these files wait on their own: which picture comes first is the server's to say. */
    val holdFile = ConcurrentHashMap<String, CompletableDeferred<Unit>>()
    /** How many messages the conversation holds above its cards. */
    @Volatile var messages = 0
    val bytes = ConcurrentHashMap<String, ByteArray>()
    val calls = CopyOnWriteArrayList<String>()

    fun reset() { citations = ""; pages = emptyMap(); hold = null; holdBytes = null; pending = true; messages = 0; holdFile.clear(); bytes.clear(); calls.clear() }
    fun attachmentReads() = calls.filter { it.startsWith("GET attachments/") }.map { it.removePrefix("GET attachments/") }
    fun routeReads() = calls.filter { it.startsWith("GET tasks/$TASK/evidence/2/files") }

    /** One entry as `GET /tasks/:taskId/evidence/:revision/files` answers it. */
    fun file(id: String, name: String?, folder: String? = "menu-shots", mimeType: String? = "image/png", sizeBytes: Long? = 214L * 1024, width: Int? = null,
        height: Int? = null, expiredAt: String? = null, gone: Boolean = false) = """{"id":"$id","kind":"file","name":${q(name)},"label":null,"mimeType":${q(mimeType)},
        "sizeBytes":$sizeBytes,"sha256":"$SHA","folder":${q(folder)},"width":$width,"height":$height,"expiredAt":${q(expiredAt)},"gone":$gone,"testReport":null,
        "createdAt":${if (gone) "null" else "\"2026-11-02T06:40:00.000Z\""},"sessionId":null,"taskId":null,"fileBundleId":null}"""
    fun page(files: List<String>, fileCount: Int = files.size, totalBytes: Long = 1_887_437, nextOffset: Int? = null) =
        """{"revision":"2","submittedAt":"$SUBMITTED","fileCount":$fileCount,"totalBytes":$totalBytes,"files":${files.joinToString(",", "[", "]")},"nextOffset":$nextOffset}"""
    private fun q(text: String?) = if (text == null) "null" else "\"$text\""

    /** The board's nine: four folders of two pictures each, and a report. */
    fun nine(expiredAt: String? = null) = listOf(
        file(LIGHT_OPEN, "chromium-light-phone/menu-open.png", expiredAt = expiredAt), file(LIGHT_SHUT, "chromium-light-phone/menu-shut.png", expiredAt = expiredAt),
        file(DARK_OPEN, "chromium-dark-phone/menu-open.png", expiredAt = expiredAt), file(DARK_SHUT, "chromium-dark-phone/menu-shut.png", expiredAt = expiredAt),
        file(DESK_OPEN, "chromium-light-desktop/menu-open.png", expiredAt = expiredAt), file(DESK_SHUT, "chromium-light-desktop/menu-shut.png", expiredAt = expiredAt),
        file(WEBKIT_OPEN, "webkit-light-phone/menu-open.png", expiredAt = expiredAt), file(WEBKIT_SHUT, "webkit-light-phone/menu-shut.png", expiredAt = expiredAt),
        file(REPORT, "report.json", folder = null, mimeType = "application/json", sizeBytes = 12L * 1024, expiredAt = expiredAt))

    const val BUNDLE_CITATION = """{"kind":"FILE","ref":"34T8efFileBundle000001","resolved":true,"reason":null,"label":"8 files · 1.8 MB"}"""
    fun reportCitation(passed: Int = 46, failed: Int = 0, failedNames: String = "", skippedNames: String = "\"[webkit] › menu › scrolls\",\"[webkit] › select › wraps\"") =
        """{"kind":"FILE","ref":"$REPORT","resolved":true,"reason":null,"label":"report.json · 12 KB · application/json","testReport":{"format":"playwright",
        "total":${passed + failed + 2},"passed":$passed,"failed":$failed,"skipped":2,"durationMs":38000,"failedNames":[$failedNames],"skippedNames":[$skippedNames]}}"""
    const val TOOL_CITATION = """{"kind":"TOOL_CALL","ref":"bgj_5f0c2a9e41d7","resolved":true,"reason":null,"label":"Ran the keyboard suite"}"""

    private fun detail() = """{"id":"$COORD","title":"Coordinate the keyboard work","projectId":"$PROJECT","status":"AWAITING_INPUT","runState":"AWAITING_INPUT",
        "lifecycleState":"OPEN","agentId":"$WORKSPACE","agent":{"id":"$WORKSPACE","name":"Alpha"},"createdAt":"2026-11-02T01:00:00.000Z","lastTurnAt":"$SUBMITTED",
        "pendingApprovals":1,"lastAssistantText":"Reading what came in.","capabilities":{"canSend":true,"canComplete":true},"tags":[]}"""
    private fun queue() = """{"decidingSessionId":"$COORD","count":1,"oldestAgeSeconds":600,"pending":[${if (!pending) "" else """{"taskId":"$TASK","title":"$TITLE","status":"IN_PROGRESS",
        "projectId":"$PROJECT","ownerCard":null,"criterion":{"key":"keys","text":"$CRITERION"},"evidenceRevision":"2","submittedAt":"$SUBMITTED","ageSeconds":600,
        "claim":"$CLAIM","gaps":["$GAP"],"citations":[$citations],"decidability":{"decidable":true,"refusal":null,"requiredAction":null},
        "independence":{"independent":true,"disqualification":null,"requiredAction":null}}"""}],"waitingOnYou":[],"waitingOnCoordinator":[],"sentToCoordinator":[],"decided":[]}"""
    private fun eventsPage() = (1..messages).joinToString(",", "[", "]") { """{"seq":$it,"type":"assistant","payload":{"text":"Message $it of the conversation."},"ts":"$SUBMITTED"}""" }
        .let { """{"events":$it,"hasMore":false,"lastSeq":$messages,"latestSeq":$messages}""" }

    private fun ok(body: String) = ApiResponse(200, body.encodeToByteArray())

    val transport = HttpTransport { request ->
        val api = request.api
        val path = api.path.joinToString("/") { part -> ids.firstOrNull { ObjectId.same(it, part) } ?: part }
        if (path == "auth/login") return@HttpTransport ok("""{"accessToken":"t8-access","refreshToken":"t8-refresh","user":{"id":"u1","email":"owner@t8.test","name":"Owner"}}""")
        val query = api.query.joinToString("&") { (k, v) -> "$k=$v" }
        calls += "${api.method.name} $path" + if (query.isEmpty()) "" else "?$query"
        when {
            path == "tasks/$TASK/evidence/2/files" -> {
                hold?.await()
                pages[api.query.toMap()["offset"]?.toInt() ?: 0]?.let(::ok) ?: ApiResponse(500, """{"message":"The route could not answer."}""".encodeToByteArray())
            }
            path.startsWith("attachments/") -> {
                holdBytes?.await()
                holdFile[path.removePrefix("attachments/")]?.await()
                bytes[path.removePrefix("attachments/")]?.let { ApiResponse(200, it) } ?: ApiResponse(404, """{"message":"attachment not found"}""".encodeToByteArray())
            }
            path == "users/me" -> ok("""{"id":"u1","email":"owner@t8.test","name":"Owner"}""")
            path == "workspaces" -> ok("""[{"id":"$WORKSPACE","name":"Alpha","runnerId":"r1","enabled":true,"position":0,"createdAt":"2026-10-01T01:00:00.000Z"}]""")
            path == "runners" -> ok("""[{"id":"r1","name":"Fixture runner","online":true}]""")
            path == "sessions" -> ok(if ((api.query.toMap()["view"] ?: "open") == "open") "[${detail()}]" else "[]")
            path == "sessions/$COORD" -> ok(detail())
            path == "sessions/$COORD/events/page" -> ok(eventsPage())
            path == "tasks/evidence-decisions/pending" -> ok(queue())
            path == "projects/$PROJECT" -> ok("""{"id":"$PROJECT","title":"Keyboard windows","status":"OPEN","goal":"Windows.","createdAt":"2026-11-01T00:00:00Z"}""")
            path == "projects/$PROJECT/open-items" -> ok("""{"needsYou":[],"withCoordinator":[]}""")
            path.startsWith("projects/") -> ok("{}")
            path.startsWith("wiki/") -> ApiResponse(404, """{"code":"WIKI_DISABLED","message":"The wiki is off."}""".encodeToByteArray())
            api.method.name == "GET" -> ok("[]")
            else -> ok("{}")
        }
    }

    /** The streams open and stay quiet: the account is connected, so writes are offered. */
    private val events = object : EventTransport {
        override suspend fun stream(request: HttpRequest, onOpen: suspend () -> Unit, onFrame: suspend (SseFrame) -> Unit) { onOpen(); awaitCancellation() }
    }

    fun session() = AuthSession(transport, object : CredentialStore {
        private var value: StoredSession? = null
        override suspend fun load() = value
        override suspend fun save(session: StoredSession) { value = session }
        override suspend fun clear() { value = null }
    }, object : InstanceStore {
        override suspend fun load(): String? = null
        override suspend fun save(server: String) = Unit
    }, object : SessionDataStore {
        override suspend fun read(account: AccountKey, kind: DataKind, key: String): ByteArray? = null
        override suspend fun write(account: AccountKey, kind: DataKind, key: String, bytes: ByteArray) = Unit
        override suspend fun clearAll() = Unit
    }, "t8-files", eventTransport = events)
}

/** The application with the controlled server in place of the network and the device stores. */
class EvidenceFilesApplication : OrbitApplication() {
    override fun createSession(): AuthSession = EvidenceFilesServer.session()
    // Unit tests must not reach GitHub when an Activity starts.
    override fun createUpdates() = io.orbitd.android.update.AppUpdater(this, processScope,
        io.orbitd.android.update.UpdateConfig.forBuild().copy(enabled = false))
}

/**
 * The evidence card's files as a reader meets them (docs/orbit-files-design.md §2.6, the web's EvidenceFiles.test.tsx): the production
 * Activity, AuthSession and reader over T6's route. The area under the criterion, the page it opens, the viewer a thumbnail opens,
 * what is left once the bytes have gone, and a version that cites no file. Each state's semantics tree and picture are written under
 * `src/android/build/evidence/evidence-files-t8/`.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = EvidenceFilesApplication::class, qualifiers = "w411dp-h1200dp-xhdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class EvidenceFilesCardTest {
    @get:Rule
    val compose = createAndroidComposeRule<MainActivity>()

    private val server = EvidenceFilesServer
    private val key = EvidenceFilesServer.KEY

    @Before fun start() {
        server.reset()
        // FileProvider keeps each authority's roots for the life of the JVM, and each test here has its own cache directory.
        FileProvider::class.java.getDeclaredField("sCache").apply { isAccessible = true }.let { (it.get(null) as MutableMap<*, *>).clear() }
    }

    private fun picture(width: Int, height: Int): ByteArray {
        val bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888).apply { Canvas(this).drawColor(android.graphics.Color.rgb(90, 120, 240)) }
        return ByteArrayOutputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it); it.toByteArray() }.also { bitmap.recycle() }
    }
    private fun serveTheBoard(citations: String = "${EvidenceFilesServer.BUNDLE_CITATION},${server.reportCitation()}") {
        val shot = picture(780, 1688)
        listOf(EvidenceFilesServer.LIGHT_OPEN, EvidenceFilesServer.LIGHT_SHUT, EvidenceFilesServer.DARK_OPEN, EvidenceFilesServer.DARK_SHUT,
            EvidenceFilesServer.DESK_OPEN, EvidenceFilesServer.DESK_SHUT, EvidenceFilesServer.WEBKIT_OPEN, EvidenceFilesServer.WEBKIT_SHUT).forEach { server.bytes[it] = shot }
        server.citations = citations
        server.pages = mapOf(0 to server.page(server.nine()))
    }

    private val theFour = listOf(EvidenceFilesServer.LIGHT_OPEN, EvidenceFilesServer.LIGHT_SHUT, EvidenceFilesServer.DARK_OPEN, EvidenceFilesServer.DARK_SHUT)
    private fun pictureOf(id: String) = "evidence-files:picture:$id"
    private fun tileOnCard(id: String) = "$key:files-tile:$id"
    private fun tileOnPage(id: String) = "evidence-files:tile:$id"

    // ---- What a card with no file is. ----

    @Test fun aVersionCitingNoFileIsTheCardItWasAndAsksForNothing() {
        server.citations = EvidenceFilesServer.TOOL_CITATION
        openCard()
        says(key, EvidenceFilesServer.CRITERION, EvidenceFilesServer.CLAIM, EvidenceFilesServer.GAP, "TOOL_CALL: Ran the keyboard suite", "Reference found", "Cited checks")
        assertEquals("no file area", 0, count(hasTestTag("$key:files")))
        assertEquals("the route is not called", emptyList<String>(), server.routeReads())
        assertEquals("no bytes are read", emptyList<String>(), server.attachmentReads())
        shot("1-today")
    }

    // ---- The default state. ----

    @Test fun theAreaSitsUnderTheCriterionWithFourThumbnailsTheRestAndTheReport() {
        serveTheBoard()
        openCard()
        await { text("$key:files-head") == "FILES · 9 · 1.8 MB" }
        assertEquals(listOf("GET tasks/${EvidenceFilesServer.TASK}/evidence/2/files"), server.routeReads())
        assertEquals("Playwright · 46 passed · 0 failed · 2 skipped", text("$key:files-report:0"))
        says("$key:files-more", "+5")
        listOf(EvidenceFilesServer.LIGHT_OPEN, EvidenceFilesServer.LIGHT_SHUT, EvidenceFilesServer.DARK_OPEN, EvidenceFilesServer.DARK_SHUT).forEach {
            assertEquals(1, count(hasTestTag(tileOnCard(it)), unmerged = true))
        }
        assertEquals("a report does not take a picture's place", 0, count(hasTestTag(tileOnCard(EvidenceFilesServer.REPORT)), unmerged = true))
        // Under the criterion and above everything that came after it.
        val criterion = bounds(hasText(EvidenceFilesServer.CRITERION))
        val area = bounds(hasTestTag("$key:files"))
        val claim = bounds(hasText(EvidenceFilesServer.CLAIM))
        assertTrue("$criterion, then $area", criterion.bottom <= area.top)
        assertTrue("$area, then $claim", area.bottom <= claim.top)
        // Only what it draws is read, and only when it draws it: real bytes, decoded and drawn.
        await { theFour.all { exists(hasTestTag(pictureOf(it)), unmerged = true) } }
        assertEquals(theFour.map(ObjectId::canonical).toSet(), server.attachmentReads().map(ObjectId::canonical).toSet())
        assertEquals(4, server.attachmentReads().size)
        shot("2-default")
    }

    /** A card that is on screen does not move what is under it when its list arrives. */
    @Test fun theAreaHoldsItsPlaceWhileTheListIsRead() {
        serveTheBoard()
        server.hold = CompletableDeferred()
        openCard()
        await { server.routeReads().isNotEmpty() && exists(hasText(EvidenceFiles.loading), unmerged = true) }
        assertEquals(EvidenceFiles.heading, text("$key:files-head"))
        val reading = bounds(hasTestTag("$key:files"))
        server.hold!!.complete(Unit)
        await { text("$key:files-head") == "FILES · 9 · 1.8 MB" }
        assertFalse(exists(hasText(EvidenceFiles.loading), unmerged = true))
        assertEquals("the same height, read or not", reading.height, bounds(hasTestTag("$key:files")).height, 0.5f)
    }

    /** A thumbnail whose bytes did not come back is a tile saying what it is, not a hole. */
    @Test fun aThumbnailThatWillNotReadIsATileRatherThanAHole() {
        serveTheBoard()
        server.bytes.remove(EvidenceFilesServer.LIGHT_SHUT)
        openCard()
        await { draws(tileOnCard(EvidenceFilesServer.LIGHT_SHUT), "PNG") }
        assertFalse(draws(tileOnCard(EvidenceFilesServer.LIGHT_OPEN), "PNG"))
    }

    @Test fun noPlusIsDrawnWhenAllOfThemAre() {
        serveTheBoard()
        server.pages = mapOf(0 to server.page(server.nine().take(4), totalBytes = 856L * 1024))
        openCard()
        await { text("$key:files-head") == "FILES · 4 · 856 KB" }
        assertEquals(0, count(hasTestTag("$key:files-more"), unmerged = true))
    }

    @Test fun whatFailedIsNamedUpToThreeAndTheRestCounted() {
        serveTheBoard("${EvidenceFilesServer.BUNDLE_CITATION},${server.reportCitation(40, 6, "\"one\",\"two\",\"three\",\"four\",\"five\"")}")
        openCard()
        await { text("$key:files-report:0") == "Playwright · 40 passed · 6 failed · 2 skipped" }
        says("$key:files", "one", "two", "three", "3 more")
        assertFalse("the fourth name is the page's", exists(hasText("four"), unmerged = true))
    }

    /** The list lives with the conversation, not the card's row or the page: one read for both. */
    @Test fun theAreaAndItsPageShareOneRead() {
        serveTheBoard()
        openPage()
        says("evidence-files:version", "9 files · 1.8 MB")
        assertEquals(1, server.routeReads().size)
    }

    /** The transcript recycles the row its cards are on. Scrolled away and back, a card reads nothing again. */
    @Test fun aCardScrolledAwayAndBackReadsNothingAgain() {
        serveTheBoard()
        server.messages = 60
        openCard()
        await { text("$key:files-head") == "FILES · 9 · 1.8 MB" }
        // Drawn, not just asked for: a read still on its way when its tile leaves is cancelled with it, and rightly read again.
        await { theFour.all { exists(hasTestTag(pictureOf(it)), unmerged = true) } }
        val list = compose.onNodeWithTag("transcript-list")
        list.performScrollToNode(hasTestTag("event:1"))
        await { !exists(hasTestTag("$key:files"), unmerged = true) }
        list.performScrollToNode(hasTestTag(key))
        await { text("$key:files-head") == "FILES · 9 · 1.8 MB" }
        compose.waitForIdle()
        assertEquals(1, server.routeReads().size)
        assertEquals(4, server.attachmentReads().size)
    }

    /** A copy kept after the server stopped publishing the version asks nothing and draws no files, as the web's stale card does. The page,
     * open when it went, stays open. */
    @Test fun aVersionThatLeftTheReadDrawsNoAreaAndItsOpenPageStays() {
        serveTheBoard()
        openPage()
        server.pending = false
        app().realtime.refreshSession()
        await { exists(hasText("No longer pending", substring = true), unmerged = true) }
        assertEquals(0, count(hasTestTag("$key:files"), unmerged = true))
        assertTrue(exists(hasTestTag("evidence-files:version")))
    }

    /** Signing out takes the page and everything on it away, with no read left to answer into it. */
    @Test fun signingOutTakesThePageAway() {
        serveTheBoard()
        openPage()
        runBlocking { app().session.logout() }
        await { !exists(hasTestTag("evidence-files")) }
    }

    // ---- The page. ----

    @Test fun theAreaOpensThePageByRevisionReportAndFolder() {
        serveTheBoard()
        openPage()
        says("evidence-files:version", "Revision 2 · ${OwnerReview.receiptTime(EvidenceFilesServer.SUBMITTED)}", "9 files · 1.8 MB")
        says("evidence-files:report:0", "Playwright report", "46 passed · 0 failed · 2 skipped · 38s")
        assertFalse("the report's cases are one press away", exists(hasText("[webkit] › menu › scrolls"), unmerged = true))
        listOf("chromium-light-phone", "chromium-dark-phone", "chromium-light-desktop", "webkit-light-phone").forEach {
            scrollPageTo("evidence-files:group:$it"); await { text("evidence-files:group:$it") == "$it  2" }
        }
        scrollPageTo("evidence-files:group:${EvidenceFiles.noFolder}")
        await { text("evidence-files:group:${EvidenceFiles.noFolder}") == "${EvidenceFiles.noFolder}  1" }
        shot("3-page")
    }

    @Test fun theReportOpensIntoTheCasesItFailedAndSkipped() {
        serveTheBoard("${EvidenceFilesServer.BUNDLE_CITATION},${server.reportCitation(40, 6, "\"one\",\"two\",\"three\",\"four\",\"five\"")}")
        openPage()
        compose.onNodeWithTag("evidence-files:report:0").performClick()
        await { exists(hasText("Failed · 6"), unmerged = true) }
        says("evidence-files:report:0", "one", "two", "three", "four", "five", "1 more", "Skipped · 2", "[webkit] › menu › scrolls", "[webkit] › select › wraps")
        compose.onNodeWithTag("evidence-files:report:0").performClick()
        await { !exists(hasText("Failed · 6"), unmerged = true) }
    }

    /** Nothing failed and nothing was skipped: there is nothing to open. */
    @Test fun aReportWithNoCasesToListDoesNotOpen() {
        serveTheBoard("""{"kind":"FILE","ref":"${EvidenceFilesServer.REPORT}","resolved":true,"reason":null,"testReport":{"format":"junit","total":3,"passed":3,"failed":0,"skipped":0,
            "durationMs":null,"failedNames":[],"skippedNames":[]}}""")
        openPage()
        says("evidence-files:report:0", "JUnit report", "3 passed · 0 failed · 0 skipped")
        compose.onNodeWithTag("evidence-files:report:0").assertHasNoClickAction()
    }

    @Test fun aLongListSaysHowManyAreShownAndReadsOn() {
        serveTheBoard()
        val nine = server.nine()
        server.pages = mapOf(0 to server.page(nine.take(2), fileCount = 3000, nextOffset = 2), 2 to server.page(nine.drop(2), fileCount = 3000))
        openPage()
        scrollPageTo("evidence-files:showing")
        await { text("evidence-files:showing") == "Showing 2 of 3000 files" }
        says("evidence-files:more", EvidenceFiles.showMore)
        compose.onNodeWithTag("evidence-files:more").performClick()
        await { !exists(hasTestTag("evidence-files:showing")) && server.routeReads().contains("GET tasks/${EvidenceFilesServer.TASK}/evidence/2/files?offset=2") }
        scrollPageTo(tileOnPage(EvidenceFilesServer.REPORT))
        assertTrue(exists(hasTestTag(tileOnPage(EvidenceFilesServer.REPORT))))
        compose.onNodeWithTag("evidence-files:close").performClick()
        await { !exists(hasTestTag("evidence-files")) }
        assertEquals("the whole list's, whichever page was read", "FILES · 3000 · 1.8 MB", text("$key:files-head"))
    }

    /** A list that could not be read says so on the card and on the page, keeps what a report said, and is read again as its page opens. */
    @Test fun aListThatCouldNotBeReadSaysSoAndIsReadAgainAsItsPageOpens() {
        serveTheBoard()
        server.pages = emptyMap()
        openCard()
        await { exists(hasText(EvidenceFiles.unread), unmerged = true) }
        assertEquals(EvidenceFiles.heading, text("$key:files-head"))
        assertEquals("Playwright · 46 passed · 0 failed · 2 skipped", text("$key:files-report:0"))
        compose.onNodeWithTag("$key:files").performClick()
        await { text("evidence-files:quiet") == EvidenceFiles.unread }
        says("evidence-files:version", "Revision 2")
        server.pages = mapOf(0 to server.page(server.nine()))
        compose.onNodeWithTag("evidence-files:close").performClick()
        await { !exists(hasTestTag("evidence-files")) }
        compose.onNodeWithTag("$key:files").performClick()
        await { text("$key:files-head") == "FILES · 9 · 1.8 MB" }
        await { exists(hasTestTag(tileOnPage(EvidenceFilesServer.LIGHT_OPEN))) }
    }

    /** And when the conversation reads itself again, as it does on a reconnect. */
    @Test fun aListThatCouldNotBeReadIsReadAgainWithTheConversation() {
        serveTheBoard()
        server.pages = emptyMap()
        openCard()
        await { exists(hasText(EvidenceFiles.unread), unmerged = true) }
        server.pages = mapOf(0 to server.page(server.nine()))
        app().realtime.setNetwork(false)
        await { app().realtime.state.value.session?.fresh == false }
        app().realtime.setNetwork(true, "fixture")
        await { text("$key:files-head") == "FILES · 9 · 1.8 MB" }
    }

    /** The viewer is saved by the picture it is on, not by a position in a list that is read again. */
    @Test fun theViewerStaysOnItsPictureAcrossTheActivityBeingRecreated() {
        serveTheBoard()
        openPage()
        compose.onNodeWithTag(tileOnPage(EvidenceFilesServer.DARK_OPEN)).performClick()
        await { text("evidence-viewer:position") == "3 of 8" }
        compose.activityRule.scenario.recreate()
        await { text("evidence-viewer:position") == "3 of 8" }
        assertEquals("chromium-dark-phone/menu-open.png", text("evidence-viewer:path"))
    }

    /** A picture on a later page is not in what a recreated Activity has read: the viewer closes, and does not open by itself once it is. */
    @Test fun aViewerOnALaterPageClosesForGoodWhenTheActivityIsRecreated() {
        serveTheBoard()
        val nine = server.nine()
        server.pages = mapOf(0 to server.page(nine.take(2), fileCount = 9, nextOffset = 2), 2 to server.page(nine.drop(2), fileCount = 9))
        openPage()
        scrollPageTo("evidence-files:more")
        compose.onNodeWithTag("evidence-files:more").performClick()
        await { exists(hasTestTag(tileOnPage(EvidenceFilesServer.DARK_OPEN))) }
        compose.onNodeWithTag(tileOnPage(EvidenceFilesServer.DARK_OPEN)).performClick()
        await { text("evidence-viewer:position") == "3 of 8" }
        compose.activityRule.scenario.recreate()
        await { exists(hasTestTag("evidence-files:more")) || exists(hasTestTag("evidence-files:showing")) }
        await { !exists(hasTestTag("evidence-viewer")) }
        scrollPageTo("evidence-files:more")
        compose.onNodeWithTag("evidence-files:more").performClick()
        await { exists(hasTestTag(tileOnPage(EvidenceFilesServer.DARK_OPEN))) }
        compose.waitForIdle()
        assertFalse("nobody pressed it", exists(hasTestTag("evidence-viewer")))
    }

    /** The page is the reader's, not the row's: it stays open across the Activity being recreated, on the same version. */
    @Test fun thePageStaysOpenAcrossTheActivityBeingRecreated() {
        serveTheBoard()
        openPage()
        compose.activityRule.scenario.recreate()
        await { exists(hasTestTag("evidence-files")) }
        await { exists(hasTestTag("evidence-files:version")) }
        says("evidence-files:version", "9 files · 1.8 MB")
    }

    // ---- The viewer. ----

    @Test fun aThumbnailOpensTheViewerWhichPagesThePicturesOnly() {
        serveTheBoard()
        openPage()
        compose.onNodeWithTag(tileOnPage(EvidenceFilesServer.LIGHT_OPEN)).performClick()
        await { text("evidence-viewer:position") == "1 of 8" }
        await { exists(hasTestTag("evidence-viewer:image"), unmerged = true) }
        assertEquals("chromium-light-phone/menu-open.png", text("evidence-viewer:path"))
        // A folder's rows don't record a size: the picture's own, as it is, whatever it was read down to.
        await { text("evidence-viewer:facts") == "214 KB · 780 × 1688 · sha256 3f9a1c07" }
        shot("4-viewer")
        // Left and right, in the order the page shows them. The report is no picture, so nine files are eight.
        compose.onNodeWithTag("evidence-viewer:pager").performTouchInput { swipeLeft() }
        await { text("evidence-viewer:position") == "2 of 8" }
        assertEquals("chromium-light-phone/menu-shut.png", text("evidence-viewer:path"))
        compose.onNodeWithTag("evidence-viewer:pager").performTouchInput { swipeRight() }
        await { text("evidence-viewer:position") == "1 of 8" }
        compose.onNodeWithTag("evidence-viewer:done").performClick()
        await { !exists(hasTestTag("evidence-viewer")) }
        assertTrue("back on the page", exists(hasTestTag("evidence-files")))
    }

    /**
     * Pinched, a finger moves the picture rather than turning the page, until it is pinched back. The pager also reads the next picture,
     * and either can come first. A pinch before the one under it is drawn has nothing to hold, and the swipe turns the page: CI went red
     * that way (runs 41531514937, 41554340716). So this makes the neighbour come first every time, and pinches the picture on screen.
     */
    @Test fun aPinchedPictureIsMovedRatherThanPagedUntilItIsLetBack() {
        serveTheBoard()
        openPage()
        await { exists(hasTestTag(pictureOf(EvidenceFilesServer.LIGHT_OPEN)), unmerged = true) }
        val onScreen = CompletableDeferred<Unit>()
        server.holdFile[EvidenceFilesServer.LIGHT_OPEN] = onScreen
        compose.onNodeWithTag(tileOnPage(EvidenceFilesServer.LIGHT_OPEN)).performClick()
        await { text("evidence-viewer:position") == "1 of 8" && exists(hasTestTag("evidence-viewer:image"), unmerged = true) }
        val itself = hasTestTag("evidence-viewer:image") and hasContentDescription("chromium-light-phone/menu-open.png")
        assertFalse("the neighbour came first", exists(itself, unmerged = true))
        onScreen.complete(Unit)
        await { exists(itself, unmerged = true) }
        val pager = compose.onNodeWithTag("evidence-viewer:pager")
        pager.performTouchInput { pinch(center - Offset(40f, 0f), center - Offset(320f, 0f), center + Offset(40f, 0f), center + Offset(320f, 0f)) }
        pager.performTouchInput { swipeLeft() }
        compose.waitForIdle()
        assertEquals("1 of 8", text("evidence-viewer:position"))
        pager.performTouchInput { pinch(center - Offset(320f, 0f), center - Offset(10f, 0f), center + Offset(320f, 0f), center + Offset(10f, 0f)) }
        pager.performTouchInput { swipeLeft() }
        await { text("evidence-viewer:position") == "2 of 8" }
    }

    /** A row that knows an image's size is believed; the picture is only read for the one it does not. */
    @Test fun theViewerTakesASizeTheRowKnows() {
        serveTheBoard()
        server.pages = mapOf(0 to server.page(listOf(server.file(EvidenceFilesServer.LIGHT_OPEN, "alone.png", folder = null, width = 1560, height = 3376))))
        openPage()
        compose.onNodeWithTag(tileOnPage(EvidenceFilesServer.LIGHT_OPEN)).performClick()
        await { text("evidence-viewer:position") == "1 of 1" }
        await { text("evidence-viewer:facts") == "214 KB · 1560 × 3376 · sha256 3f9a1c07" }
    }

    /** Bytes labelled a picture that don't decode are no picture: the tile says what it is, and the viewer never pages it. */
    @Test fun aPictureThatWillNotDrawIsATileThatCanOnlyBeHandedOn() {
        serveTheBoard()
        server.bytes[EvidenceFilesServer.LIGHT_SHUT] = "<!doctype html><script>document.title='x'</script>".encodeToByteArray()
        openPage()
        await { server.attachmentReads().any { ObjectId.same(it, EvidenceFilesServer.LIGHT_SHUT) } }
        await { draws(tileOnPage(EvidenceFilesServer.LIGHT_SHUT), "PNG") }
        compose.onNodeWithTag(tileOnPage(EvidenceFilesServer.LIGHT_OPEN)).performClick()
        await { text("evidence-viewer:position") == "1 of 7" }
    }

    // ---- What may only be saved or shared. ----

    private fun serveNotes() {
        serveTheBoard()
        server.bytes[EvidenceFilesServer.PAGE] = "<!doctype html><script>steal()</script>".encodeToByteArray()
        server.bytes[EvidenceFilesServer.VECTOR] = "<svg xmlns='http://www.w3.org/2000/svg'><script>steal()</script></svg>".encodeToByteArray()
        server.pages = mapOf(0 to server.page(listOf(
            server.file(EvidenceFilesServer.LIGHT_OPEN, "shots/alone.png"),
            server.file(EvidenceFilesServer.PAGE, "notes/page.html", mimeType = "text/html", sizeBytes = 13),
            server.file(EvidenceFilesServer.VECTOR, "notes/vector.svg", mimeType = "image/svg+xml", sizeBytes = 90))))
    }

    @Test fun anSvgOrAPageIsNeverReadOrDrawnUntilAPersonHandsItOn() {
        serveNotes()
        openPage()
        await { server.attachmentReads().isNotEmpty() }
        // On the card and on the page: the picture's bytes alone.
        assertEquals(listOf(ObjectId.canonical(EvidenceFilesServer.LIGHT_OPEN)), server.attachmentReads().map(ObjectId::canonical).distinct())
        listOf(EvidenceFilesServer.PAGE to "HTML", EvidenceFilesServer.VECTOR to "SVG").forEach { (id, kind) -> says(tileOnPage(id), kind) }
        says("evidence-files:grid", "page.html", "13 B · sha256 3f9a1c07", "vector.svg", "90 B · sha256 3f9a1c07")
        // Its tile says what a press does, and opens no viewer.
        compose.onNodeWithContentDescription(EvidenceFiles.downloadName("notes/page.html")).performClick()
        await { exists(hasTestTag("evidence-files:download")) && exists(hasTestTag("evidence-files:share")) }
        assertFalse(exists(hasTestTag("evidence-viewer")))
        assertFalse("only the two doors", exists(hasText("Open"), unmerged = true))
        compose.onNodeWithTag("evidence-files:share").performClick()
        await { server.attachmentReads().any { ObjectId.same(it, EvidenceFilesServer.PAGE) } }
        await { startedActivity() != null }
        val chooser = startedActivity()!!
        assertEquals(Intent.ACTION_CHOOSER, chooser.action)
        val sent = chooser.getParcelableExtra<Intent>(Intent.EXTRA_INTENT)!!
        assertEquals(Intent.ACTION_SEND, sent.action)
        assertEquals("text/html", sent.type)
        val stream = sent.getParcelableExtra<Uri>(Intent.EXTRA_STREAM)!!
        assertEquals("content", stream.scheme)
        assertEquals("the private hand-off provider", "${compose.activity.packageName}.attachments", stream.authority)
        assertTrue(stream.toString().endsWith("/page.html"))
    }

    @Test fun anSvgOrAPageIsNoPartOfTheViewersSet() {
        serveNotes()
        openPage()
        compose.onNodeWithTag(tileOnPage(EvidenceFilesServer.LIGHT_OPEN)).performClick()
        await { text("evidence-viewer:position") == "1 of 1" }
        assertFalse("one picture has no dots to page", exists(hasTestTag("evidence-viewer:dots")))
    }

    @Test fun aSaveGoesThroughTheSystemsOwnScreenAndWritesTheBytes() {
        serveNotes()
        openPage()
        await { exists(hasTestTag(tileOnPage(EvidenceFilesServer.VECTOR))) }
        compose.onNodeWithContentDescription(EvidenceFiles.downloadName("notes/vector.svg")).performClick()
        await { exists(hasTestTag("evidence-files:download")) }
        compose.onNodeWithTag("evidence-files:download").performClick()
        await { startedForResult() != null }
        val intent = startedForResult()!!
        assertEquals(Intent.ACTION_CREATE_DOCUMENT, intent.action)
        assertEquals("image/svg+xml", intent.type)
        assertEquals("vector.svg", intent.getStringExtra(Intent.EXTRA_TITLE))
        // The screen answers with where it goes.
        val destination = Uri.parse("content://t8.saved/vector.svg")
        val written = ByteArrayOutputStream()
        shadowOf(compose.activity.contentResolver).registerOutputStream(destination, written)
        shadowOf(compose.activity).receiveResult(intent, Activity.RESULT_OK, Intent().setData(destination))
        await { text("evidence-files:notice") == EvidenceFiles.saved }
        assertArrayEquals(server.bytes[EvidenceFilesServer.VECTOR], written.toByteArray())
    }

    /** A save whose bytes never come says so. That it leaves no empty file takes a real provider: EvidenceFilesDeviceTest holds that. */
    @Test fun aSaveThatFailedSaysSo() {
        serveNotes()
        server.bytes.remove(EvidenceFilesServer.VECTOR)
        openPage()
        await { exists(hasTestTag(tileOnPage(EvidenceFilesServer.VECTOR))) }
        compose.onNodeWithContentDescription(EvidenceFiles.downloadName("notes/vector.svg")).performClick()
        await { exists(hasTestTag("evidence-files:download")) }
        compose.onNodeWithTag("evidence-files:download").performClick()
        await { startedForResult() != null }
        val destination = Uri.parse("content://t8.saved/vector.svg")
        shadowOf(compose.activity).receiveResult(startedForResult()!!, Activity.RESULT_OK, Intent().setData(destination))
        await { text("evidence-files:notice") == EvidenceFiles.downloadFailed }
    }

    /** A save goes on with the conversation when the page closes, because the file it writes to exists already. */
    @Test fun aSaveFinishesEvenIfThePageIsClosedDuringIt() {
        serveNotes()
        openPage()
        await { exists(hasTestTag(tileOnPage(EvidenceFilesServer.VECTOR))) }
        compose.onNodeWithContentDescription(EvidenceFiles.downloadName("notes/vector.svg")).performClick()
        await { exists(hasTestTag("evidence-files:download")) }
        compose.onNodeWithTag("evidence-files:download").performClick()
        await { startedForResult() != null }
        val destination = Uri.parse("content://t8.saved/vector.svg")
        val written = ByteArrayOutputStream()
        shadowOf(compose.activity.contentResolver).registerOutputStream(destination, written)
        val held = CompletableDeferred<Unit>()
        server.holdBytes = held
        shadowOf(compose.activity).receiveResult(startedForResult()!!, Activity.RESULT_OK, Intent().setData(destination))
        await { server.attachmentReads().any { ObjectId.same(it, EvidenceFilesServer.VECTOR) } }
        compose.onNodeWithTag("evidence-files:close").performClick()
        await { !exists(hasTestTag("evidence-files")) }
        held.complete(Unit)
        await { written.size() > 0 }
        assertArrayEquals(server.bytes[EvidenceFilesServer.VECTOR], written.toByteArray())
    }

    @Test fun aShareThatFailedSaysSo() {
        serveNotes()
        server.bytes.remove(EvidenceFilesServer.VECTOR)
        openPage()
        await { exists(hasTestTag(tileOnPage(EvidenceFilesServer.VECTOR))) }
        compose.onNodeWithContentDescription(EvidenceFiles.downloadName("notes/vector.svg")).performClick()
        await { exists(hasTestTag("evidence-files:share")) }
        compose.onNodeWithTag("evidence-files:share").performClick()
        await { text("evidence-files:notice") == EvidenceFiles.shareFailed }
    }

    @Test fun theViewerHandsItsPictureOnTheSameTwoWays() {
        serveTheBoard()
        openPage()
        compose.onNodeWithTag(tileOnPage(EvidenceFilesServer.LIGHT_OPEN)).performClick()
        await { exists(hasTestTag("evidence-viewer:doors")) }
        compose.onNodeWithContentDescription(EvidenceFiles.saveOrShare).performClick()
        await { exists(hasTestTag("evidence-files:download")) && exists(hasTestTag("evidence-files:share")) }
        compose.onNodeWithTag("evidence-files:share").performClick()
        await { startedActivity() != null }
        assertEquals("image/png", startedActivity()!!.getParcelableExtra<Intent>(Intent.EXTRA_INTENT)!!.type)
    }

    /** Nothing in this file draws a file's bytes but a decoded bitmap, and nothing asks another app to open one. */
    @Test fun theViewsHaveNoWebViewAndNoOpenDoor() {
        val root = generateSequence(File(System.getProperty("user.dir")).absoluteFile) { it.parentFile }
            .first { File(it, "src/android/settings.gradle.kts").isFile }
        val views = File(root, "src/android/app/src/main/kotlin/io/orbitd/android/cards/EvidenceFilesViews.kt").readText()
        listOf("android.webkit", "WebView(", "ACTION_VIEW", "AttachmentActions(").forEach { assertFalse("$it is in the views", it in views) }
    }

    /** Whatever the picture's size, a tile keeps one small square of its top: a long screenshot at the width a tile needs, in the middle of
     * a wide one, and a small picture as it is. */
    @Test fun aThumbnailIsTheTopOfThePictureAsOneSmallSquare() {
        fun split(width: Int, height: Int): ByteArray {
            val bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
            Canvas(bitmap).apply {
                drawColor(android.graphics.Color.BLUE)
                drawRect(0f, 0f, width.toFloat(), height * 0.25f, android.graphics.Paint().apply { color = android.graphics.Color.RED })
            }
            return ByteArrayOutputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it); it.toByteArray() }.also { bitmap.recycle() }
        }
        val long = decodeThumbnail(split(780, 6000))
        assertEquals(THUMBNAIL_SIDE, long.width)
        assertEquals(THUMBNAIL_SIDE, long.height)
        assertEquals("all of it is the top of the page", android.graphics.Color.RED, long.getPixel(THUMBNAIL_SIDE / 2, THUMBNAIL_SIDE / 2))
        val wide = decodeThumbnail(split(1920, 1080))
        assertEquals(THUMBNAIL_SIDE, wide.width)
        assertEquals(THUMBNAIL_SIDE, wide.height)
        val small = decodeThumbnail(split(40, 60))
        assertEquals(40, small.width)
        assertEquals(40, small.height)
    }

    // ---- Once the bytes have gone. ----

    private val expiredAt = "2026-10-20T12:00:00.000Z"
    private val expiredOn get() = EvidenceFiles.expiryDate(expiredAt)!!

    @Test fun anExpiredVersionKeepsEverythingButItsPictures() {
        serveTheBoard()
        server.pages = mapOf(0 to server.page(server.nine(expiredAt)))
        openCard()
        val expected = EvidenceFiles.headline(EvidenceFileList(EvidenceFilesServer.SUBMITTED, 9, 1_887_437,
            listOf(EvidenceFile("a", expiredAt = expiredAt))))
        await { text("$key:files-head") == expected }
        assertTrue(expected, expected.startsWith("FILES · 9 · 1.8 MB · EXPIRED "))
        says(tileOnCard(EvidenceFilesServer.LIGHT_OPEN), "${EvidenceFiles.expired}\n$expiredOn")
        assertEquals("the report's summary outlives its file", "Playwright · 46 passed · 0 failed · 2 skipped", text("$key:files-report:0"))
        assertEquals("nothing that has lost its bytes is read", emptyList<String>(), server.attachmentReads())
        shot("5-expired-card")
        compose.onNodeWithTag("$key:files").performClick()
        await { exists(hasTestTag(tileOnPage(EvidenceFilesServer.LIGHT_OPEN))) }
        // Its name, its size and its sha256 are all still there, and the tile presses nothing.
        says("evidence-files:grid", "menu-open.png", "214 KB · sha256 3f9a1c07")
        compose.onNodeWithTag(tileOnPage(EvidenceFilesServer.LIGHT_OPEN)).assertHasNoClickAction()
        says("evidence-files:report:0", "46 passed · 0 failed · 2 skipped · 38s")
        shot("5-expired-page")
    }

    @Test fun oneExpiredFileOfNineIsItsOwnTilesNews() {
        serveTheBoard()
        server.pages = mapOf(0 to server.page(listOf(server.file(EvidenceFilesServer.LIGHT_OPEN, "shots/a.png", expiredAt = expiredAt)) + server.nine().drop(1)))
        openCard()
        await { text("$key:files-head") == "FILES · 9 · 1.8 MB" }
        // Pictures come first, so the one that went falls behind the four that can be drawn.
        await { server.attachmentReads().size == 4 }
        assertFalse(server.attachmentReads().any { ObjectId.same(it, EvidenceFilesServer.LIGHT_OPEN) })
        compose.onNodeWithTag("$key:files").performClick()
        await { exists(hasTestTag(tileOnPage(EvidenceFilesServer.LIGHT_OPEN))) }
        says(tileOnPage(EvidenceFilesServer.LIGHT_OPEN), "${EvidenceFiles.expired}\n$expiredOn")
        compose.onNodeWithTag(tileOnPage(EvidenceFilesServer.LIGHT_SHUT)).performClick()
        await { text("evidence-viewer:position") == "1 of 7" }
    }

    /** A row that went: the same placeholder with no date, its id for a name, what the version recorded. Real data reaches this today. */
    @Test fun aRowThatWentIsTheSamePlaceholderWithNoDateOrSize() {
        server.citations = """{"kind":"FILE","ref":"${EvidenceFilesServer.LIGHT_OPEN}","resolved":false,"reason":"not found"}"""
        server.pages = mapOf(0 to server.page(listOf(server.file(EvidenceFilesServer.LIGHT_OPEN, null, folder = null, mimeType = null, sizeBytes = null, gone = true)), totalBytes = 0))
        openCard()
        await { text("$key:files-head") == "FILES · 1 · EXPIRED" }
        says(tileOnCard(EvidenceFilesServer.LIGHT_OPEN), EvidenceFiles.expired)
        compose.onNodeWithTag("$key:files").performClick()
        await { exists(hasTestTag("evidence-files:version")) }
        says("evidence-files:version", "1 file")
        assertFalse("a size that can't be stated is left out", exists(hasText("0 B", substring = true), unmerged = true))
        says("evidence-files:grid", "sha256 3f9a1c07", EvidenceFilesServer.LIGHT_OPEN)
        compose.onNodeWithTag(tileOnPage(EvidenceFilesServer.LIGHT_OPEN)).assertHasNoClickAction()
        assertEquals(emptyList<String>(), server.attachmentReads())
    }

    // ---- The test's own hands. ----

    private fun app() = compose.activity.application as OrbitApplication
    private fun exists(matcher: SemanticsMatcher, unmerged: Boolean = false) = count(matcher, unmerged) > 0
    private fun count(matcher: SemanticsMatcher, unmerged: Boolean = false) = compose.onAllNodes(matcher, useUnmergedTree = unmerged).fetchSemanticsNodes().size
    private fun bounds(matcher: SemanticsMatcher) = compose.onAllNodes(matcher, useUnmergedTree = true).fetchSemanticsNodes().first().boundsInRoot
    /** The words a node draws, or an empty string while it isn't there. */
    private fun text(tag: String) = compose.onAllNodesWithTag(tag, useUnmergedTree = true).fetchSemanticsNodes().firstOrNull()?.config
        ?.getOrNull(SemanticsProperties.Text)?.joinToString("") { it.text }.orEmpty()
    /** A node tagged [tag], or one inside it, says each of [texts]. */
    private fun says(tag: String, vararg texts: String) = texts.forEach { text ->
        assertTrue("$tag does not say “$text”", exists((hasTestTag(tag) or hasAnyAncestor(hasTestTag(tag))) and hasText(text), unmerged = true))
    }
    private fun draws(tag: String, text: String) = exists((hasTestTag(tag) or hasAnyAncestor(hasTestTag(tag))) and hasText(text), unmerged = true)
    private fun await(condition: () -> Boolean) = compose.waitUntil(60_000) { compose.waitForIdle(); condition() }
    private fun startedActivity() = shadowOf(compose.activity).peekNextStartedActivity()
    private fun startedForResult() = shadowOf(compose.activity).peekNextStartedActivityForResult()?.intent

    private fun openCard() {
        compose.waitUntil(60_000) { app().session.state.value is AuthState.SignedOut }
        app().realtime.setNetwork(true, "fixture")
        runBlocking { app().session.login(ServerAddress.parse("https://t8.test"), "owner@t8.test", "fixture") }
        compose.waitUntil(60_000) { app().session.state.value is AuthState.SignedIn && app().realtime.state.value.directoryFresh }
        compose.activityRule.scenario.onActivity {
            val launch = it.intent
            MainActivity::class.java.getDeclaredMethod("onNewIntent", Intent::class.java).apply { isAccessible = true }
                .invoke(it, Intent(Intent.ACTION_VIEW, Uri.parse("orbit-session:${EvidenceFilesServer.COORD}")).setClass(it, MainActivity::class.java))
            it.intent = launch
        }
        compose.waitForIdle()
        await { exists(hasTestTag(key)) }
    }
    private fun openPage() {
        openCard()
        await { exists(hasTestTag("$key:files")) && text("$key:files-head").startsWith("FILES ·") }
        compose.onNodeWithTag("$key:files").performClick()
        await { exists(hasTestTag("evidence-files")) && exists(hasTestTag("evidence-files:version")) }
    }
    private fun scrollPageTo(tag: String) { compose.onNodeWithTag("evidence-files:grid").performScrollToNode(hasTestTag(tag)) }

    private val output: File by lazy {
        val root = generateSequence(File(System.getProperty("user.dir")).absoluteFile) { it.parentFile }
            .first { File(it, "src/android/settings.gradle.kts").isFile }
        File(root, "src/android/build/evidence/evidence-files-t8").also { it.mkdirs() }
    }

    /** The screen's semantics, for a reader of the run; the pictures of record come from the emulator (EvidenceFilesDeviceTest). */
    private fun shot(name: String) {
        compose.waitForIdle()
        shadowOf(Looper.getMainLooper()).idle()
        val roots = compose.onAllNodes(isRoot())
        File(output, "$name-semantics.txt").writeText((0 until roots.fetchSemanticsNodes().size).joinToString("\n\n") { roots[it].printToString() })
        println("shot $name at ${Instant.now()} -> $output")
    }
}
