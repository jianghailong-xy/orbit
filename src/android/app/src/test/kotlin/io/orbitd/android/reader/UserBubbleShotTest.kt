package io.orbitd.android.reader

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.unit.dp
import io.orbitd.android.MainActivity
import io.orbitd.android.TestOrbitApplication
import io.orbitd.android.core.net.ApiResponse
import io.orbitd.android.core.realtime.RunEvent
import io.orbitd.android.management.AccountTranslation
import io.orbitd.android.management.LocalTranslation
import io.orbitd.android.text.LocalReaderResources
import io.orbitd.android.text.ReaderResources
import io.orbitd.android.translation.LocalShownOriginals
import io.orbitd.android.translation.ShownOriginals
import io.orbitd.android.ui.OrbitTheme
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.io.ByteArrayOutputStream
import java.io.File
import java.time.Instant

/**
 * The reader's own turn as iOS draws it (OrbitApp `UserBubbleView`): a sent screenshot above a tinted bubble on the trailing side, the
 * owner's words in it with the English the agent got under them ("Show both languages"), and copy · time · "Sent to the agent in
 * English · Hide original" under it — no "You" heading, no "Attachment" caption or "Open image". The reply under it is the document
 * alone (`AssistantBubbleView`): no "Assistant" heading, no Copy message. Frames go to `src/android/build/evidence/user-bubble-android/`.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = TestOrbitApplication::class, qualifiers = "w411dp-h891dp-xhdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class UserBubbleShotTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()

    private val server = FakeReaderServer()
    private val ago = Instant.now().minusSeconds(130).toString()
    private val id = "01a0cca7-8609-70ed-a0e2-d4b55b832b61"

    /** A portrait phone screenshot's shape: light page, a few grey lines, a blue bar at its foot. */
    private fun screenshot(): ByteArray {
        val bitmap = Bitmap.createBitmap(540, 1170, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(bitmap)
        canvas.drawColor(Color.rgb(248, 248, 250))
        val grey = Paint().apply { color = Color.rgb(200, 200, 206) }
        for (i in 0 until 14) canvas.drawRect(40f, 160f + i * 64f, if (i % 3 == 2) 330f else 500f, 184f + i * 64f, grey)
        canvas.drawRect(30f, 1060f, 510f, 1130f, Paint().apply { color = Color.rgb(30, 110, 220) })
        return ByteArrayOutputStream().also { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }.toByteArray()
    }

    private fun show() {
        val png = screenshot()
        server.respond = { ApiResponse(200, png) }
        val handle = runBlocking { server.signIn() }
        val resources = ReaderResources(server.auth, handle, sessionId = "s1")
        val events = listOf(
            RunEvent("user", 1, buildJsonObject {
                put("text", "Please review the rendering of the Android session chat window.")
                putJsonObject("translation") { put("state", "DONE"); put("from", "zh-Hans"); put("original", "Android session 聊天窗口的渲染请 review 下") }
                putJsonArray("attachments") { addJsonObject { put("id", id); put("name", "Screenshot_1259.png"); put("mime", "image/png") } }
            }, "turn-1", ago),
            RunEvent("assistant", 2, buildJsonObject { put("text", "I'll compare it with the iPhone frame and send you both.") }, "turn-1", ago))
        val rows = transcriptRows(events)
        compose.runOnUiThread { compose.activity.setContent { OrbitTheme {
            // The reader's per-message state, as SessionReader provides it: where "Hide original" acts.
            CompositionLocalProvider(LocalReaderResources provides resources, LocalShownOriginals provides ShownOriginals(),
                LocalTranslation provides AccountTranslation(enabled = true, available = true, language = "zh-Hans", bilingual = true)) {
                Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
                    Column(Modifier.fillMaxWidth().padding(16.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
                        rows.forEach { row -> TranscriptRowView(row, { error("no full read") }, null, {}) }
                    }
                }
            }
        } } }
        compose.waitForIdle()
    }

    private fun count(matcher: SemanticsMatcher) = compose.onAllNodes(matcher, useUnmergedTree = true).fetchSemanticsNodes().size

    @Test fun aSentScreenshotInBothLanguagesIsTheTrailingBubbleAndTheReplyHasNoHeading() {
        show()
        compose.waitUntil(30_000) { count(hasTestTag("user-turn-image")) == 1 }
        val own = hasAnyAncestor(hasTestTag("event:1"))
        compose.onAllNodes(hasTestTag("user-bubble") and own, useUnmergedTree = true).assertCountEquals(1)
        compose.onAllNodes(hasTestTag("translation-english") and own, useUnmergedTree = true).assertCountEquals(1)
        compose.onAllNodes(hasText("Hide original") and own, useUnmergedTree = true).assertCountEquals(1)
        listOf("You", "Attachment", "Open image", "Screenshot_1259.png").forEach { word ->
            compose.onAllNodes(hasText(word) and own, useUnmergedTree = true).assertCountEquals(0)
        }
        val reply = hasAnyAncestor(hasTestTag("event:2"))
        compose.onAllNodes(hasText("I'll compare it with the iPhone frame and send you both.") and reply, useUnmergedTree = true).assertCountEquals(1)
        listOf("Assistant", "Copy message").forEach { word -> compose.onAllNodes(hasText(word) and reply, useUnmergedTree = true).assertCountEquals(0) }
        shot("01-image-bilingual")
    }

    /** The foot rides the copy/time line where all of it fits, after a dot; where it does not, it drops under them with no dot left
     * hanging off the time (iOS `meta`'s ViewThatFits). */
    @Test fun theMetaLineDropsTheFootUnderTheTimeWithoutADotWhereItDoesNotFit() {
        for ((width, fits) in listOf(400 to true, 200 to false)) {
            compose.runOnUiThread { compose.activity.setContent { OrbitTheme {
                androidx.compose.foundation.layout.Box(Modifier.width(width.dp)) {
                    UserTurnMetaLine(lead = { androidx.compose.material3.Text("2m ago", Modifier.testTag("lead")) },
                        foot = { androidx.compose.material3.Text("Sent to the agent in English", Modifier.testTag("foot")) }, dotted = true)
                }
            } } }
            compose.waitForIdle()
            val lead = compose.onNodeWithTag("lead", useUnmergedTree = true).fetchSemanticsNode().boundsInRoot
            val foot = compose.onNodeWithTag("foot", useUnmergedTree = true).fetchSemanticsNode().boundsInRoot
            val dots = compose.onAllNodes(hasText("·"), useUnmergedTree = true).fetchSemanticsNodes().filter { it.layoutInfo.isPlaced }
            if (fits) {
                assertEquals("one line at ${width}dp", lead.center.y, foot.center.y, 1f)
                assertEquals("the dot between them", 1, dots.size)
            } else {
                assertTrue("the foot under the time at ${width}dp", foot.top >= lead.bottom)
                assertEquals("no dot left hanging", 0, dots.size)
                assertEquals("both on the trailing edge", lead.right, foot.right, 1f)
            }
        }
    }

    private fun shot(name: String) {
        compose.waitForIdle()
        val root = generateSequence(File(System.getProperty("user.dir"))) { it.parentFile }
            .first { File(it, "src/android/settings.gradle.kts").isFile }
        val output = File(root, "src/android/build/evidence/user-bubble-android").also { it.mkdirs() }
        val view = compose.activity.window.decorView
        val bitmap = Bitmap.createBitmap(view.width, view.height, Bitmap.Config.ARGB_8888)
        view.draw(Canvas(bitmap))
        File(output, "$name.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
        bitmap.recycle()
    }
}
