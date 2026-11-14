package io.orbitd.android.reader

import androidx.activity.compose.setContent
import androidx.compose.material3.MaterialTheme
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import io.orbitd.android.MainActivity
import io.orbitd.android.TestOrbitApplication
import io.orbitd.android.core.realtime.RunEvent
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * A06-9: what delivery appended to a message, split off the person's words where the apiserver recorded it
 * (OrbitKit's DeliveredMessageTests, case for case) and drawn as one quiet line, ⊕ shut and ⊖ open (owner,
 * 2026-10-27; docs/mocks/attached-context-note).
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = TestOrbitApplication::class, qualifiers = "w411dp-h891dp")
class AttachedNoteTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()
    private val conditions = "<list-conditions list=\"6ba7b810\" title=\"FineWeb\">\n  配额挡住派发｜12 个就绪任务被配额挡住\n</list-conditions>"
    private val backgroundJobs = "<background-jobs>\n  你不在的时候结束了：\n    bgj_3a1af2b50428｜job｜npm run build｜completed｜退出码 0\n</background-jobs>"
    private val refList = "<referenced-list id=\"6ba7b810\">\n  标题   FineWeb CC-MAIN-2025-26\n</referenced-list>"
    private val refTask = "<referenced-task id=\"550e8400\">\n  标题   [W 009/250] → WARC\n</referenced-task>"
    private val sessionMessage = "<orbit-session-message from-session=\"34Y\" from-title=\"Worker\" from-agent=\"orbit\">\n这条消息来自另一个 Orbit 会话。\n</orbit-session-message>"
    private val coordinator = "<orbit_project_coordinator_context>\n  你是项目的协调会话。\n</orbit_project_coordinator_context>"
    // A wiki chat's blocks as the apiserver appends them (wiki contract `chat.notes`, wiki-chat-notes.ts). Android has no
    // chat this phase: it draws them as any block it does not know, and counts nothing from them (design §9).
    private val wikiChat = "<orbit_wiki_chat>\nYou are chatting beside a page of this repository's Orbit wiki.\n</orbit_wiki_chat>"
    private val wikiPage = "<orbit_wiki_page of=\"doc\" doc=\"1.1\" slug=\"sessions-runtime\" section=\"2\" key=\"turn-delivery\" repoSha=\"1f1f\">\n" +
        "1.1 Sessions runtime · §2 Turn delivery\nThe runner leases one turn at a time.\n  - src/runner-go/inbox.go@1f1f#L10-40\n</orbit_wiki_page>"
    private val wikiSelection = "<orbit_wiki_selection doc=\"1.1\" slug=\"sessions-runtime\" section=\"2\" key=\"turn-delivery\" sentences=\"1\" sources=\"1\">\n" +
        "§2 Turn delivery\nThe runner leases one turn at a time.\n  - src/runner-go/inbox.go@1f1f#L10-40\n</orbit_wiki_selection>"

    @Test fun splitsExactlyWhereTheRecordedNoteBegins() {
        val note = "\n\n$backgroundJobs"
        assertEquals("继续" to backgroundJobs, splitRecordedNote("继续$note", note))
        val typed = "这是什么？\n\n$conditions"
        assertEquals("a pasted board stays the person's", typed, splitRecordedNote("$typed\n\n$conditions", "\n\n$conditions")?.first)
        assertNull(splitRecordedNote("q\n\n$conditions", null))
        assertNull(splitRecordedNote("q", "\n\n$conditions"))
        assertNull("a blank note records nothing", splitRecordedNote("q\n\n", "\n\n"))
        assertEquals("第一行\r", splitRecordedNote("第一行\r$note", note)?.first)
        val event = RunEvent("user", 1, buildJsonObject { put("text", "继续$note"); put("controlPlaneNote", note) })
        assertEquals("继续", event.personWords())
        assertEquals("继续", RunEvent("user", 2, buildJsonObject { put("text", "继续") }).personWords())
    }

    @Test fun namesEveryBlockOneDeliveryAppended() {
        assertEquals("background jobs", describeNote("\n\n$backgroundJobs"))
        assertEquals("list conditions", describeNote(conditions))
        assertEquals("", describeNote(coordinator))  // Orbit's routine on every coordinator turn: unnamed
        assertEquals("referenced list", describeNote(refList))
        assertEquals("referenced task", describeNote(refTask))
        assertEquals("session message", describeNote("\n\n$sessionMessage"))
        assertEquals("referenced task ×2, background jobs",
            describeNote("\n\n$refTask\n\n$refTask\n\n$backgroundJobs\n\n$coordinator"))
        assertEquals("referenced list", describeNote("\n\n$refList\n\n$coordinator"))
        assertEquals("context", describeNote("<orbit_something_new>\n  x\n</orbit_something_new>"))
        assertEquals("context", describeNote("<background-jobs-v2>\n  x\n</background-jobs-v2>"))
        assertEquals("context", describeNote("[Image #1]"))
    }

    @Test fun drawsAWikiChatsBlocksAsAnyBlockItDoesNotKnow() {
        val note = "\n\n$wikiChat\n\n$wikiPage\n\n$wikiSelection"
        assertEquals("context ×3", describeNote(note))
        assertEquals("Is the lease really ninety seconds?" to note.trim(), splitRecordedNote("Is the lease really ninety seconds?$note", note))
        val event = RunEvent("user", 1, buildJsonObject { put("text", "Is the lease really ninety seconds?$note"); put("controlPlaneNote", note) })
        assertEquals("Is the lease really ninety seconds?", event.personWords())
    }

    @Test fun theLineSaysWhatIsAttachedAndOpensToWhatTheModelRead() {
        compose.runOnUiThread { compose.activity.setContent { MaterialTheme { AttachedNoteEntry(backgroundJobs) } } }
        // One line and nothing else to press: none of the card it replaced.
        compose.onNodeWithText("⊕ Orbit attached: background jobs").assertIsDisplayed()
        compose.onAllNodesWithText("Orbit context", substring = true).assertCountEquals(0)
        compose.onAllNodesWithText("View full context").assertCountEquals(0)
        val head = compose.onNodeWithContentDescription("⊕ Orbit attached: background jobs")
        head.assert(SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, "Collapsed"))
        compose.onNodeWithText(backgroundJobs).assertDoesNotExist()
        head.performClick()
        compose.onNodeWithText(backgroundJobs).assertIsDisplayed()
        // The plus that opened it is a minus while it is open.
        compose.onNodeWithText("⊖ Orbit attached: background jobs").assertIsDisplayed()
        head.assert(SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, "Expanded"))
        head.performClick()
        compose.onNodeWithText(backgroundJobs).assertDoesNotExist()
        compose.onNodeWithText("⊕ Orbit attached: background jobs").assertIsDisplayed()
    }
}
