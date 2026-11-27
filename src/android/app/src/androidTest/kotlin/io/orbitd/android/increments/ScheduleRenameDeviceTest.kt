package io.orbitd.android.increments

import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.*
import androidx.compose.ui.text.TextRange
import io.orbitd.android.core.schedule.ScheduleCopy
import java.time.ZoneId
import java.time.ZonedDateTime
import java.time.temporal.ChronoUnit
import okhttp3.mockwebserver.MockResponse
import org.junit.Test

/**
 * Rename… on the phone (docs/scheduled-tasks-design.md §8.4 *Rename*; board docs/mocks/schedule-rename/01-board-2.png), against a
 * fixture holding the iPhone probe's rows: the row's long-press menu, the dialog with the name selected and Save off, the saved name on
 * the row, the sheet's History with "Renamed from “…”" and Undo, and the sheet's ⋯. Each step leaves a screenshot under
 * files/a15c/ScheduleRenameDeviceTest/<test>.
 */
class ScheduleRenameDeviceTest : IncrementDeviceTest() {
    private val us = "34A1RenameUsApp1070001"
    private val hourly = "34A1RenameMergeMonitor"
    private val sg = "34A1RenameSgApp1070001"
    override val ids get() = listOf(us, hourly, sg, workspace, runner)

    /** "US app 1070 数据就绪巡检", and the name it is given. */
    private val unnamed = "US app 1070 数据就绪巡检"
    private val named = "US app 1070 data readiness"
    private var title = unnamed

    private val today get() = ZonedDateTime.now(ZoneId.systemDefault()).truncatedTo(ChronoUnit.DAYS)
    private fun at(days: Long, hour: Int, minute: Int) = today.plusDays(days).withHour(hour).withMinute(minute).toInstant().toString()

    private fun clock(hour: Int, minute: Int) = "${hour.toString().padStart(2, '0')}:${minute.toString().padStart(2, '0')}"

    private val lastRun get() = """{"id":"r-us","scheduleId":"$us","scheduleRevision":1,"plannedAt":"${at(-1, 9, 7)}","trigger":"SCHEDULED",
        "state":"NO_CHANGE","summary":"nothing new","attempt":1,"startedAt":"${at(-1, 9, 8)}","endedAt":"${at(-1, 9, 11)}","notified":false}"""

    private fun schedule(id: String, name: String, hour: Int, minute: Int, last: String = "null") = """{"id":"$id","title":"$name",
        "intent":"Check yesterday’s US app 1070 data and say what is missing.","prompt":"",
        "rule":{"kind":"DAILY","time":"${clock(hour, minute)}"},"timezone":"Asia/Shanghai","workspaceId":"$workspace","workspaceName":"tea-cli @ SG",
        "agentId":"a1","engine":"claude","accessLevel":"CHECK_ONLY","runLimitMinutes":30,"runsPerWeek":7,
        "envelope":{"workspaceId":"$workspace","accessLevel":"CHECK_ONLY","runsPerWeek":7,"runLimitMinutes":30},"state":"ACTIVE",
        "revision":2,"nextDueAt":"${at(0, hour, minute)}","consecutiveFailures":0,"createdAt":"${ago(60 * 24 * 30)}","lastRun":$last}"""

    override fun workspaceJson() = super.workspaceJson().replace("\"Alpha\"", "\"tea-cli\"")

    private fun usRow() = schedule(us, title, 9, 7, lastRun)

    private fun detail() = """{"schedule":${usRow()},"lastRun":$lastRun,"recentRuns":[$lastRun],"findings":[],
        "usage":{"since":"${at(-25, 0, 0)}","runs":1,"minutes":3},
        "history":[${if (title == named) """{"scheduleId":"$us","title":"$named","revision":2,"changedBy":"USER",
          "before":{"title":"$unnamed"},"after":{"title":"$named"},"createdAt":"${ago(0)}",
          "undo":{"path":"/schedules/$us/undo","body":{"revision":2}}},""" else ""}
          {"scheduleId":"$us","title":"$unnamed","revision":1,"changedBy":"USER","before":null,
          "after":{"accessLevel":"CHECK_ONLY","envelope":{"workspaceId":"$workspace","accessLevel":"CHECK_ONLY","runsPerWeek":7,"runLimitMinutes":30}},
          "createdAt":"${ago(60 * 24 * 30)}"}],"pendingCards":[]}"""

    override fun answer(req: Req): MockResponse? = when {
        req.path == "schedules" && req.method == "GET" -> json("""{"schedules":[${usRow()},
            ${schedule(hourly, "Hourly merge monitor v2", 10, 0)},${schedule(sg, "SG app 1070 data readiness", 10, 30)}],"runs":[]}""")
        req.path == "schedules/drafts" && req.method == "GET" -> json("""{"drafts":[]}""")
        req.path == "schedules/$us/rename" && req.method == "POST" -> { title = named; json("""{"outcome":"APPLIED"}""") }
        req.path == "schedules/$us" && req.method == "GET" -> json(detail())
        req.path == "owner-requests" -> json("""{"requests":[]}""")
        else -> null
    }

    @Test fun renamingASchedule() = journey {
        signIn()
        compose.onNodeWithContentDescription("Open navigation").performClick()
        awaitTag("drawer:scheduled")
        compose.onNodeWithTag("drawer:scheduled").performClick()
        awaitText(unnamed)
        capture("rename-0-scheduled")

        compose.onAllNodes(hasText(unnamed), useUnmergedTree = true).onFirst().performTouchInput { longClick() }
        awaitTag("schedule-menu-rename")
        capture("rename-1-menu")

        compose.onNodeWithTag("schedule-menu-rename", useUnmergedTree = true).performClick()
        awaitTag("schedule-rename-dialog")
        verify("Save is off while the name is unchanged", exists(hasTestTag("schedule-rename-save") and isNotEnabled()))
        capture("rename-2-dialog")
        verify("the field holds the name, selected", compose.onNodeWithTag("schedule-rename-field").fetchSemanticsNode().config.let {
            it[SemanticsProperties.EditableText].text == unnamed && it[SemanticsProperties.TextSelectionRange] == TextRange(0, unnamed.length)
        })
        for (nothing in listOf("", "   ", "  $unnamed ")) {
            compose.onNodeWithTag("schedule-rename-field").performTextReplacement(nothing)
            settle()
            verify("Save is off for \"$nothing\"", exists(hasTestTag("schedule-rename-save") and isNotEnabled()))
            compose.onNodeWithTag("schedule-rename-field").performImeAction()
        }
        verify("nothing was sent", bodies.none { it.first.endsWith("/rename") })
        compose.onNodeWithTag("schedule-rename-field").performTextReplacement(named)
        await("Save on") { exists(hasTestTag("schedule-rename-save") and isEnabled()) }
        capture("rename-3-typed")
        // Pressed with spaces around it: what is sent is the trimmed name.
        compose.onNodeWithTag("schedule-rename-field").performTextReplacement("  $named ")
        compose.onNodeWithTag("schedule-rename-save").performClick()
        await("the row's new name") { exists(hasText(named), unmerged = true) && !exists(hasTestTag("schedule-rename-dialog"), unmerged = true) }
        verify("one rename was sent, the title alone",
            bodies.filter { it.first.endsWith("/rename") }.map { it.second } == listOf("""{"title":"$named"}"""))
        dropFocus()
        capture("rename-4-renamed")

        compose.onAllNodes(hasText(named), useUnmergedTree = true).onFirst().performClick()
        val line = "Renamed from “$unnamed”"
        awaitText(line)
        compose.onNodeWithText(line, useUnmergedTree = true).performScrollTo()
        verify("with its Undo", exists(hasText(ScheduleCopy.Actions.undo), unmerged = true))
        capture("rename-5-history")

        compose.onNodeWithTag("schedule-detail-more").performScrollTo().performClick()
        awaitTag("schedule-detail-rename")
        capture("rename-6-detail-menu")
    }
}
