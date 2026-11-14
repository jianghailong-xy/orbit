package io.orbitd.android.management

import android.graphics.Bitmap
import android.graphics.Canvas
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Surface
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.unit.dp
import io.orbitd.android.MainActivity
import io.orbitd.android.OrbitApplication
import io.orbitd.android.TestOrbitApplication
import io.orbitd.android.core.auth.*
import io.orbitd.android.core.net.*
import io.orbitd.android.ui.OrbitTheme
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.io.File
import java.time.Instant

/** The Resources section drawn by the real composable over a stubbed GET /runners/:id/resources: a machine that reads its
 * resources (memory nearly full), one too old to, and one offline. PNGs under src/android/build/evidence/runner-resources-android/,
 * each with the words it must show asserted first. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = TestOrbitApplication::class, qualifiers = "w411dp-h900dp")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class RunnerResourcesShotsTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()

    private val gib = 1024L * 1024 * 1024
    private val now = System.currentTimeMillis()
    private val output: File by lazy {
        val root = generateSequence(File(System.getProperty("user.dir")!!)) { it.parentFile }.first { File(it, "src/android").isDirectory }
        File(root, "src/android/build/evidence/runner-resources-android").also { it.mkdirs() }
    }
    private fun json(text: String): JsonObject = Json.parseToJsonElement(text).jsonObject
    private fun iso(ms: Long) = Instant.ofEpochMilli(ms).toString()

    private fun answer(endMs: Long, memAvail: Long): String {
        val samples = (0 until 120).joinToString(",") { i ->
            val t = endMs - (119 - i) * 30_000L
            val cpu = 30 + 12 * Math.sin(i / 7.0)
            val mem = 100.0 * (32 * gib - memAvail) / (32 * gib) - 3 + 3 * i / 119.0
            """{"at":"${iso(t)}","cpu":${"%.1f".format(java.util.Locale.ROOT, cpu)},"mem":${"%.1f".format(java.util.Locale.ROOT, mem)},"disk":78.6}"""
        }
        return """{"at":"${iso(endMs)}","latest":{"cpuPercent":38.2,"cpuCores":8,"load1":3.04,"memTotalBytes":${32 * gib},
            "memAvailableBytes":$memAvail,"diskTotalBytes":${926 * gib},"diskFreeBytes":${198 * gib}},"samples":[$samples]}"""
    }

    private fun signedIn(body: String): ManagementApi {
        val session = (compose.activity.application as OrbitApplication).session
        compose.waitUntil(60_000) { session.state.value is AuthState.SignedOut }
        runBlocking { session.login(ServerAddress.parse("https://fixture.test"), "a@example.test", "fixture-password") }
        val handle = (session.state.value as AuthState.SignedIn).handle
        val stub = object : OrbitApi {
            override suspend fun request(handle: SessionHandle, request: ApiRequest): ApiResponse = when {
                request.path == listOf("users", "me") ->
                    ApiResponse(200, """{"id":"u1","email":"a@example.test","name":"Mia","preferences":{}}""".encodeToByteArray())
                request.path.lastOrNull() == "resources" -> ApiResponse(200, body.encodeToByteArray())
                else -> ApiResponse(200, "[]".encodeToByteArray())
            }
        }
        return ManagementApi(stub, handle)
    }

    private fun runner(reports: Boolean) = json("""{"id":"r1","name":"studio","capabilities":[${if (reports) "\"machine-resources/v1\"" else ""}]}""")
    private val workspaces = listOf(json("""{"id":"w1","workDirFreeBytes":${198 * gib},"workDirTotalBytes":${926 * gib}}"""))

    private fun show(runner: JsonObject, api: ManagementApi, online: Boolean) {
        compose.activityRule.scenario.onActivity { activity -> activity.setContent { OrbitTheme { Surface {
            Column(Modifier.verticalScroll(rememberScrollState()).padding(horizontal = 16.dp, vertical = 8.dp)) {
                RunnerResourcesSection(api, runner, workspaces, now, online, resumed = true)
            }
        } } } }
    }

    private fun shot(name: String) {
        compose.waitForIdle()
        val view = compose.activity.window.decorView
        val bitmap = Bitmap.createBitmap(view.width, view.height, Bitmap.Config.ARGB_8888)
        view.draw(Canvas(bitmap))
        val file = File(output, "$name.png")
        file.outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
        assertTrue("$name: no PNG was written", file.length() > 0)
        println("shot $name ${bitmap.width}x${bitmap.height} -> $file")
        bitmap.recycle()
    }

    private fun await(text: String) = compose.waitUntil(60_000) { compose.onAllNodesWithText(text, substring = true).fetchSemanticsNodes().isNotEmpty() }

    @Test fun live() {
        show(runner(true), signedIn(answer(now - 10_000, 2 * gib)), online = true)
        await("Live · every 30 s · last hour")
        await("8 cores · load 3.0")
        await("30 of 32 GB used")
        await("Nearly full — new sessions may be slow to start.")
        await("728 of 926 GB used · 198 GB free")
        shot("live")
    }

    @Test fun olderRunner() {
        show(runner(false), signedIn("{}"), online = true)
        await("Disk is read from your workspaces")
        await("This runner predates CPU readings.")
        await("This runner predates memory readings.")
        shot("older-runner")
    }

    @Test fun offline() {
        show(runner(true), signedIn(answer(now - 14 * 60_000, 10 * gib)), online = false)
        await("Offline · last reading 14m ago")
        shot("offline")
    }
}
