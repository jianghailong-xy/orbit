package io.orbitd.android.directory

import android.graphics.Bitmap
import android.os.SystemClock
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.unit.dp
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import io.orbitd.android.MainActivity
import io.orbitd.android.ui.OrbitTheme
import java.io.File
import kotlinx.serialization.json.*
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Pictures of the comparison rig's fixture rows (scripts/acceptance/session-three-state-check/fixture.json) as the real [SessionRow]
 * draws them on a device, to set beside the approved board (docs/mocks/session-display-three-states/android.png). The runner pushes the
 * fixture to the app's files as `session-display-fixture.json` (row 27 carrying `engineTurnActive`, as the board's fixture does); the
 * pictures go to `files/a07-composer/`. Nine rows to a picture, each under a caption naming its fixture row.
 */
@RunWith(AndroidJUnit4::class)
class SessionDisplayRowsDeviceTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()
    private val instrument get() = InstrumentationRegistry.getInstrumentation()
    private val json = Json { ignoreUnknownKeys = true; coerceInputValues = true }

    @Test fun photographsEveryFixtureRowWithAndWithoutTheFacts() {
        val files = instrument.targetContext.filesDir
        val out = File(files, "a07-composer").apply { mkdirs() }
        val rows = Json.parseToJsonElement(File(files, "session-display-fixture.json").readText()).jsonArray.mapIndexed { i, r ->
            Triple(i + 1, r.jsonObject["name"]!!.jsonPrimitive.content,
                json.decodeFromJsonElement(DirectorySession.serializer(), r.jsonObject["payload"]!!.jsonObject).copy(id = "row${i + 1}",
                    title = r.jsonObject["name"]!!.jsonPrimitive.content))
        }
        val withFacts = rows.filter { it.first % 2 == 1 }
        val withoutFacts = rows.filter { it.first % 2 == 0 }
        listOf("with-facts" to withFacts, "without-facts" to withoutFacts).forEach { (set, list) ->
            list.chunked(9).forEachIndexed { page, chunk ->
                compose.runOnUiThread {
                    compose.activity.setContent {
                        OrbitTheme {
                            // A Surface, as the app's screens have, so the rows' text takes the theme's content colour.
                            Surface(Modifier.fillMaxSize()) { Column(Modifier.fillMaxSize().statusBarsPadding()) {
                                chunk.forEach { (row, name, session) ->
                                    Text("Row $row · $name", Modifier.padding(start = 16.dp, top = 6.dp), style = MaterialTheme.typography.labelSmall,
                                        color = MaterialTheme.colorScheme.outline)
                                    SessionRow(session, null, {}) {}
                                    HorizontalDivider()
                                }
                            } }
                        }
                    }
                }
                compose.waitForIdle()
                SystemClock.sleep(800)
                val shot = (1..3).firstNotNullOfOrNull { instrument.uiAutomation.takeScreenshot() ?: run { SystemClock.sleep(1000); null } }
                assertTrue("no screenshot for $set ${page + 1}", shot != null)
                File(out, "session-rows-$set-${page + 1}.png").outputStream().use { shot!!.compress(Bitmap.CompressFormat.PNG, 100, it) }
                shot!!.recycle()
            }
        }
    }
}
