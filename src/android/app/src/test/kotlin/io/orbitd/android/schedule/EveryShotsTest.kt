package io.orbitd.android.schedule

import android.graphics.Bitmap
import android.graphics.Canvas
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.unit.dp
import io.orbitd.android.MainActivity
import io.orbitd.android.TestOrbitApplication
import io.orbitd.android.cards.BusinessCard
import io.orbitd.android.cards.OwnerRequestStore
import io.orbitd.android.core.auth.*
import io.orbitd.android.core.cards.CardCatalog
import io.orbitd.android.core.net.OkHttpTransport
import io.orbitd.android.core.net.ServerAddress
import io.orbitd.android.core.realtime.SessionSnapshot
import io.orbitd.android.core.schedule.TaskStartWhenView
import io.orbitd.android.ui.OrbitTheme
import java.io.File
import java.time.Instant
import java.time.ZoneId
import java.time.ZonedDateTime
import java.time.format.DateTimeFormatter
import java.util.Locale
import java.util.TimeZone
import java.util.concurrent.CopyOnWriteArrayList
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/** The Scheduled page with an EVERY schedule: its sentence, its planned end, and a run of missed slots as one row. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = TestOrbitApplication::class, qualifiers = "w411dp-h891dp")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class EveryShotsTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val fixture = Fixture()
    private lateinit var store: ScheduledStore
    private var savedZone: TimeZone = TimeZone.getDefault()

    private val output: File by lazy {
        val root = generateSequence(File(System.getProperty("user.dir"))) { it.parentFile }
            .first { File(it, "src/android/settings.gradle.kts").isFile }
        File(root, "src/android/build/evidence/every-android").also { it.mkdirs() }
    }

    @Before fun setUp() {
        TimeZone.setDefault(TimeZone.getTimeZone("UTC"))
        store = ScheduledStore(fixture.auth, runBlocking { fixture.signIn() }, scope)
    }

    @After fun tearDown() {
        scope.cancel(); runBlocking { fixture.auth.logout() }; fixture.close()
        TimeZone.setDefault(savedZone)
    }

    @Test fun scheduledPageShowsEverySentenceEndAndCollapsedMissedRow() {
        compose.runOnUiThread { compose.activity.setContent { OrbitTheme(darkTheme = false) {
            Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
                ScheduledPage(store, listOf("a1" to "HPC"), "a1", null, {}, {}, {})
            }
        } } }
        store.showPastRuns(true)
        compose.waitUntil(10_000) {
            compose.onAllNodesWithText("Poll queue", substring = true, useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty()
        }
        compose.waitForIdle()
        listOf("Every 30 min, 09:00–18:00, Mon–Fri", "3 runs left", "4 slots missed, 01:00–04:00").forEach { words ->
            assertTrue("on screen: $words", compose.onAllNodesWithText(words, substring = true, useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty())
        }
        val view = compose.activity.window.decorView
        val bitmap = Bitmap.createBitmap(view.width, view.height, Bitmap.Config.ARGB_8888)
        view.draw(Canvas(bitmap))
        File(output, "scheduled-every.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
        bitmap.recycle()
    }

    private class Fixture {
        private val server = MockWebServer().apply {
            dispatcher = object : Dispatcher() {
                override fun dispatch(request: RecordedRequest): MockResponse {
                    val path = request.requestUrl!!.encodedPath
                    fun json(body: Any) = MockResponse().setResponseCode(200).setHeader("Content-Type", "application/json").setBody(body.toString())
                    return when (path) {
                        "/api/auth/login" -> json("""{"accessToken":"or-access","refreshToken":"or-refresh","user":{"id":"u","email":"u@example.test","name":"U"}}""")
                        "/api/schedules" -> json(list())
                        "/api/schedules/drafts" -> json("""{"drafts":[]}""")
                        "/api/owner-requests" -> json("""{"requests":[]}""")
                        "/api/projects" -> json("[]")
                        else -> MockResponse().setResponseCode(404).setBody("{}")
                    }
                }
            }
            start()
        }

        val auth = AuthSession(OkHttpTransport(), object : CredentialStore {
            private var saved: StoredSession? = null
            override suspend fun load() = saved
            override suspend fun save(session: StoredSession) { saved = session }
            override suspend fun clear() { saved = null }
        }, object : InstanceStore {
            override suspend fun load(): String? = null
            override suspend fun save(server: String) {}
        }, object : SessionDataStore {
            override suspend fun read(account: AccountKey, kind: DataKind, key: String): ByteArray? = null
            override suspend fun write(account: AccountKey, kind: DataKind, key: String, bytes: ByteArray) {}
            override suspend fun clearAll() {}
        }, "test", allowLoopbackHttp = true)

        suspend fun signIn(): SessionHandle =
            auth.login(ServerAddress.parse(server.url("/").toString(), allowLoopbackHttp = true), "u@example.test", "fixture-password")

        fun close() = server.shutdown()

        private fun list(): String {
            val day = Instant.now().truncatedTo(java.time.temporal.ChronoUnit.DAYS)
            fun at(h: Int, m: Int) = day.plusSeconds(h * 3600L + m * 60L).toString()
            val schedule = """{"id":"s-every","title":"Poll queue","intent":"Poll queue","prompt":"Poll queue","timezone":"UTC",
                "workspaceId":"a1","workspaceName":"HPC","accessLevel":"CHECK_ONLY","runLimitMinutes":30,"runsPerWeek":7,
                "state":"ACTIVE","revision":1,"consecutiveFailures":0,"nextDueAt":"${day.plusSeconds(86400 + 9 * 3600)}",
                "endAt":"${at(23, 0)}","maxRuns":5,"runsStarted":2,"runsLeft":3,
                "rule":{"kind":"EVERY","minutes":30,"time":"09:00","until":"18:00","weekdays":["MON","TUE","WED","THU","FRI","SAT","SUN"]},
                "createdAt":"${day}"}""".replace("\"weekdays\":[\"MON\",\"TUE\",\"WED\",\"THU\",\"FRI\",\"SAT\",\"SUN\"]", "\"weekdays\":[\"MON\",\"TUE\",\"WED\",\"THU\",\"FRI\"]")
            val runs = listOf("01:00" to 1 * 60, "01:30" to 90, "02:00" to 120, "04:00" to 240).mapIndexed { i, (_, minutes) ->
                """{"id":"r$i","scheduleId":"s-every","plannedAt":"${day.plusSeconds(minutes * 60L)}","state":"MISSED"}"""
            }
            return """{"schedules":[$schedule],"runs":[${runs.joinToString(",")}],"waitingTasks":[]}"""
        }
    }
}
