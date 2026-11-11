package io.orbitd.android.projects

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import io.orbitd.android.composer.ProviderEngines
import io.orbitd.android.core.cards.*
import kotlinx.coroutines.CancellationException
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull

/**
 * Starting a project's next coordinator in a workspace the owner picks (docs/mocks/coordinator-move-workspace/03-final ④–⑥; web
 * `lib/coordinatorWorkspace.ts`, whose words these are): the picker's rows and the confirmation's words. The server's
 * `POST /projects/:id/coordinator/replace` with `{ workspaceId }` does the work; a workspace it would refuse (disabled, or on no
 * runner) is greyed with the same reason, so the press is not offered where it cannot succeed.
 */
object StartCoordinatorIn {
    const val menuTitle = "Start a new coordinator in…"
    const val menuDetail = "The same, in a workspace you pick. This project is coordinated from there afterwards."
    const val pickerTitle = "Start a new coordinator in…"
    const val current = "Current"
    const val runnerOffline = "Runner offline"
    const val pickerFoot = "The new coordinator starts empty, on the workspace’s own engine and account."
    const val disabled = "This workspace is disabled."
    const val noRunner = "This workspace has no runner."
    const val keep = "Keep this coordinator"

    /** One workspace in the picker. [reason] is null when a new coordinator can open there. */
    data class Row(val workspaceId: String, val name: String, val detail: String, val reason: String?, val current: Boolean, val runnerOffline: Boolean)

    /** What the conversation being left behind is, for the confirmation's first paragraph. */
    enum class Outgoing { OPEN, COMPLETED, NONE }

    /** The picker's rows from `GET /workspaces`, in the list's own order. [onlineRunnerIds] null is liveness not read yet: no note
     * rather than a wrong one. */
    fun rows(workspaces: List<JsonObject>, currentWorkspaceId: String?, onlineRunnerIds: Set<String>?): List<Row> = workspaces.mapNotNull { w ->
        val id = w.text("id") ?: return@mapNotNull null
        val runnerId = w.text("runnerId")?.takeIf { it.isNotEmpty() }
        val reason = when {
            (w["enabled"] as? JsonPrimitive)?.booleanOrNull == false -> disabled
            runnerId == null -> noRunner
            else -> null
        }
        val provider = w.text("lastProvider")?.takeIf { it.isNotEmpty() } ?: ProviderEngines.CLAUDE
        val runner = w.obj("runner")?.let { r -> r.text("displayName")?.takeIf { it.isNotEmpty() } ?: r.text("name")?.takeIf { it.isNotEmpty() } }
        Row(id, w.text("name") ?: id, reason ?: listOfNotNull(ProviderEngines.cliName(provider), runner).joinToString(" · "), reason,
            current = id == currentWorkspaceId,
            runnerOffline = reason == null && onlineRunnerIds != null && runnerId !in onlineRunnerIds)
    }

    /** From `GET /projects/:id/coordinator/status`: none when there is no conversation (or it is in the bin), completed when it has
     * finished — as this page's own Start a new coordinator reads it (`ProjectPage.coordinatorFinished`) — else open. */
    fun outgoing(status: JsonObject?): Outgoing {
        val session = status?.obj("coordination")?.obj("session") ?: return Outgoing.NONE
        if (session.text("deletedAt") != null) return Outgoing.NONE
        return if (session.text("lifecycleState") in setOf("COMPLETED", "ARCHIVED")) Outgoing.COMPLETED else Outgoing.OPEN
    }

    fun title(workspace: String) = "Start a new coordinator in $workspace?"

    /** The confirmation's paragraphs: where the old conversation stays, and what moves with the new one. */
    fun paragraphs(project: String, to: String, from: String?, outgoing: Outgoing): List<String> {
        val where = if (from != null) " in $from" else ""
        return listOfNotNull(
            when (outgoing) {
                Outgoing.OPEN -> "The current conversation is completed — a turn in flight finishes first — and stays readable$where."
                Outgoing.COMPLETED -> "The current conversation stays completed and readable$where."
                Outgoing.NONE -> null
            },
            "$project is coordinated from a new, empty conversation in $to, and its row moves to $to’s list. Its tasks keep running where they are.",
        )
    }

    fun action(workspace: String, outgoing: Outgoing) = if (outgoing == Outgoing.OPEN) "Complete and start in $workspace" else "Start in $workspace"
}

/**
 * The picker, as a bottom sheet (board 03 part 3): the owner's workspaces, the current one marked, one a new conversation cannot open
 * in greyed with why. The workspaces and runners are read when it opens; a read that fails leaves the list empty and says so.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun StartCoordinatorInSheet(api: ProjectApi, currentWorkspaceId: String?, close: () -> Unit, pick: (StartCoordinatorIn.Row) -> Unit) {
    var rows by remember { mutableStateOf<List<StartCoordinatorIn.Row>?>(null) }
    var failed by remember { mutableStateOf(false) }
    LaunchedEffect(api, currentWorkspaceId) {
        try {
            val workspaces = api.workspaces()
            val online = try { api.runners().filter { it.flag("online") }.mapNotNull { it.text("id") }.toSet() }
                catch (cancel: CancellationException) { throw cancel } catch (_: Exception) { null }
            rows = StartCoordinatorIn.rows(workspaces, currentWorkspaceId, online)
        } catch (cancel: CancellationException) { throw cancel } catch (_: Exception) { failed = true }
    }
    ModalBottomSheet(onDismissRequest = close, modifier = Modifier.testTag("start-coordinator-in-sheet")) {
        StartCoordinatorInList(rows, failed, pick)
    }
}

/** The sheet's content. */
@Composable
internal fun StartCoordinatorInList(rows: List<StartCoordinatorIn.Row>?, failed: Boolean, pick: (StartCoordinatorIn.Row) -> Unit) {
    Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(start = 16.dp, end = 16.dp, bottom = 24.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(StartCoordinatorIn.pickerTitle, Modifier.semantics { heading() }, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
        when {
            rows == null && failed -> Text("Couldn't load workspaces.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
            rows == null -> CircularProgressIndicator(Modifier.align(Alignment.CenterHorizontally))
            else -> Column(Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.surfaceVariant, RoundedCornerShape(12.dp))) {
                rows.forEachIndexed { index, row ->
                    if (index > 0) HorizontalDivider()
                    Row(Modifier.fillMaxWidth().clickable(enabled = row.reason == null) { pick(row) }.alpha(if (row.reason == null) 1f else 0.45f)
                        .padding(horizontal = 12.dp, vertical = 10.dp).testTag("start-coordinator-in:${row.workspaceId}"),
                        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Column(Modifier.weight(1f)) {
                            Text(row.name)
                            Text(row.detail, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                        if (row.runnerOffline) Text(StartCoordinatorIn.runnerOffline, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        if (row.current) Text(StartCoordinatorIn.current, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
            }
        }
        Text(StartCoordinatorIn.pickerFoot, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}
