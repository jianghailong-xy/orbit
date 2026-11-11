package io.orbitd.android.reader

import android.graphics.Bitmap
import android.graphics.Canvas
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.unit.dp
import io.orbitd.android.MainActivity
import io.orbitd.android.TestOrbitApplication
import io.orbitd.android.core.cards.OrbitExchangeFold
import io.orbitd.android.core.realtime.RunEvent
import io.orbitd.android.ui.OrbitTheme
import java.io.File
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * NATIVE frames of a coordinator's run of Orbit turns on a phone (docs/mocks/coordinator-exchange-fold/ ⑥ and ⑩): the group shut, its
 * tree opened to the roots, and a root opened to its rows and the task after it. Each is drawn by the production composable and
 * written under `src/android/build/evidence/coordinator-exchange-fold-android/` beside its semantics tree; on a phone each row's
 * answer is on the line under what happened, which is asserted, not eyeballed.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = TestOrbitApplication::class, qualifiers = "w411dp-h891dp")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class ExchangeFoldShotsTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()

    private val b1 = "0195c0de-0000-7000-8000-000000000011"
    private val b4 = "0195c0de-0000-7000-8000-000000000014"
    private val b5 = "0195c0de-0000-7000-8000-000000000016"
    private var seq = 0L
    private fun delivery(kind: String, task: String, title: String, revision: Int? = null) = buildJsonObject {
        put("text", "From Orbit · project “Runner link v1” has news about $title")
        putJsonObject("coordinatorDelivery") {
            put("kind", kind); putJsonObject("task") { put("id", task); put("title", title) }
            put("revision", revision?.let(::JsonPrimitive) ?: JsonNull); put("count", JsonNull); put("deliveredAt", "2026-11-11T09:00:00Z")
        }
    }
    private fun exchange(opening: JsonObject, reply: String, minute: Int): List<RunEvent> {
        val id = "turn-$seq"
        return listOf(RunEvent("user", ++seq, opening, id, "2026-11-11T09:${minute.toString().padStart(2, '0')}:00Z"),
            RunEvent("assistant", ++seq, buildJsonObject { put("text", reply) }, id), RunEvent("turn_end", ++seq, buildJsonObject { }, id))
    }
    private val group = ExchangeFold.fold(Steps.group(transcriptRows(listOf(
        exchange(delivery("EVIDENCE_SUBMITTED", b1, "B1 Targeted hints over NATS", 2), "我确认了 B1（定向提示与 NATS），它正在落地，落地后 B4 会自动开工。", 14),
        exchange(delivery("DEPENDENT_READY", b4, "B4 Link gateway v1"), "B4（链路网关 v1）已经开工，等它交证据我再判。", 44),
        exchange(delivery("EVIDENCE_SUBMITTED", b5, "B5 Event intake rework", 1), "我核实了 B5（事件入库改造）的证据并确认了它，B5 接下来会落地。", 104),
        exchange(buildJsonObject { put("text", "为什么 B4b 被退回了？") }, "It conflicts with B5.", 118),
    ).flatten()))).single { it.exchanges.isNotEmpty() }
    private val tree = ExchangeTree(object : OrbitExchangeFold.Lookup {
        override fun upstreamOf(taskId: String) = mapOf(b4 to listOf(b1), b5 to listOf(b4))[taskId].orEmpty()
    }) {}

    private val output: File by lazy {
        val root = generateSequence(File(System.getProperty("user.dir"))) { it.parentFile }.first { File(it, "src/android/settings.gradle.kts").isFile }
        File(root, "src/android/build/evidence/coordinator-exchange-fold-android").also { it.mkdirs() }
    }

    private fun shot(name: String) {
        compose.waitForIdle()
        File(output, "$name-semantics.txt").writeText(compose.onRoot(useUnmergedTree = true).printToString())
        val view = compose.activity.window.decorView
        val bitmap = Bitmap.createBitmap(view.width, view.height, Bitmap.Config.ARGB_8888)
        view.draw(Canvas(bitmap))
        File(output, "$name.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
        bitmap.recycle()
    }

    @Test fun theGroupOnAPhone() {
        compose.runOnUiThread { compose.activity.setContent { OrbitTheme(darkTheme = false) {
            Surface(color = MaterialTheme.colorScheme.background) { CompositionLocalProvider(LocalExchangeTree provides tree) {
                Column(Modifier.fillMaxWidth().padding(16.dp)) { ExchangeFoldView(group, null) { row -> Text(row.event.body()) } }
            } }
        } } }
        compose.waitForIdle()
        compose.onNodeWithText("3 Orbit updates handled", useUnmergedTree = true).assertIsDisplayed()
        shot("1-group-shut")

        compose.onNodeWithTag("exchanges-line", useUnmergedTree = true).performClick()
        compose.onNodeWithText("B1 Targeted hints over NATS", useUnmergedTree = true).assertIsDisplayed()
        compose.onNodeWithText("3 updates · 2 downstream · last: 我核实了 B5（事件入库改造）的证据并确认了它，B5 接下来会落地。", useUnmergedTree = true)
            .assertExists()
        shot("2-tree-roots")

        compose.onNodeWithTag("branch-line", useUnmergedTree = true).performClick()
        compose.onNodeWithText("B4 Link gateway v1", useUnmergedTree = true).assertIsDisplayed()
        val what = compose.onNodeWithText("Evidence revision 2 submitted", useUnmergedTree = true).fetchSemanticsNode().boundsInRoot
        val reply = compose.onNodeWithText("我确认了 B1（定向提示与 NATS），它正在落地，落地后 B4 会自动开工。", useUnmergedTree = true)
            .fetchSemanticsNode().boundsInRoot
        assertTrue("the answer is not on the line under what happened: $what / $reply", reply.top >= what.bottom - 1f)
        shot("3-branch-open")
    }
}
