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
 * Change: where a project is coordinated from (docs/mocks/coordinator-move-workspace/04-change; web `lib/coordinatorWorkspace.ts`,
 * whose words these are). Android has no session Move (decision D2), so every workspace that can take the project takes a new, empty
 * conversation: the server's `POST /projects/:id/coordinator/replace` with `{ workspaceId }` does the work. A workspace it would refuse
 * (disabled, or on no runner) is greyed with the same reason, so the press is not offered where it cannot succeed.
 */
object CoordinatorChange {
    /** The coordinator menu's item. */
    const val button = "Change workspace…"
    const val title = "Change workspace"
    const val current = "Current"
    const val runnerOffline = "Runner offline"
    const val newConversation = "New conversation"
    const val foot = "Tasks keep running where they are. Only where the project is coordinated from changes."
    const val disabled = "This workspace is disabled."
    const val noRunner = "This workspace has no runner."
    const val cancel = "Cancel"

    /** One workspace in the list. [detail] is `<Provider> · <runner>` (the current one's too, tagged
     * [current] beside it), or why nothing can open there ([reason]). */
    data class Row(val workspaceId: String, val name: String, val detail: String, val reason: String?, val current: Boolean, val runnerOffline: Boolean) {
        /** Only another workspace that can take a new conversation is a press. */
        val pickable get() = !current && reason == null
        /** The row's second line: what a press does, after where (board 04 part 3, Android). */
        val line get() = if (pickable) "$detail · $newConversation" else detail
    }

    /** What the conversation being left behind is, for the confirmation's first paragraph. */
    enum class Outgoing { OPEN, COMPLETED, NONE }

    /** The rows from `GET /workspaces`: the current workspace first, then the rest in the list's own order. [onlineRunnerIds] null is
     * liveness not read yet: no note rather than a wrong one. */
    fun rows(workspaces: List<JsonObject>, currentWorkspaceId: String?, onlineRunnerIds: Set<String>?): List<Row> = workspaces.mapNotNull { w ->
        val id = w.text("id") ?: return@mapNotNull null
        val name = w.text("name") ?: id
        val provider = w.text("lastProvider")?.takeIf { it.isNotEmpty() } ?: ProviderEngines.CLAUDE
        val runner = w.obj("runner")?.let { r -> r.text("displayName")?.takeIf { it.isNotEmpty() } ?: r.text("name")?.takeIf { it.isNotEmpty() } }
        val usual = listOfNotNull(ProviderEngines.cliName(provider), runner).joinToString(" · ")
        if (id == currentWorkspaceId) return@mapNotNull Row(id, name, usual, null, current = true, runnerOffline = false)
        val runnerId = w.text("runnerId")?.takeIf { it.isNotEmpty() }
        val reason = when {
            (w["enabled"] as? JsonPrimitive)?.booleanOrNull == false -> disabled
            runnerId == null -> noRunner
            else -> null
        }
        Row(id, name, reason ?: usual, reason, current = false,
            runnerOffline = reason == null && onlineRunnerIds != null && runnerId !in onlineRunnerIds)
    }.sortedByDescending { it.current }

    /** From `GET /projects/:id/coordinator/status`: none when there is no conversation (or it is in the bin), completed when it has
     * finished — as this page's own Start a new coordinator reads it (`ProjectPage.coordinatorFinished`) — else open. */
    fun outgoing(status: JsonObject?): Outgoing {
        val session = status?.obj("coordination")?.obj("session") ?: return Outgoing.NONE
        if (session.text("deletedAt") != null) return Outgoing.NONE
        return if (session.text("lifecycleState") in setOf("COMPLETED", "ARCHIVED")) Outgoing.COMPLETED else Outgoing.OPEN
    }

    fun title(project: String, to: String) = "Coordinate $project from $to?"

    /** The confirmation's paragraphs (web `changeNewParagraphs` with no reason: without a move there is none to give). */
    fun paragraphs(to: String, from: String?, outgoing: Outgoing): List<String> {
        val where = if (from != null) " in $from" else ""
        return listOf(
            when (outgoing) {
                Outgoing.OPEN -> "It is completed — a turn in flight finishes first — and stays readable$where. A new, empty one opens in $to."
                Outgoing.COMPLETED -> "It stays completed and readable$where. A new, empty one opens in $to."
                Outgoing.NONE -> "A new, empty one opens in $to."
            },
            "Its tasks keep running where they are.",
        )
    }

    fun action(to: String, outgoing: Outgoing) = if (outgoing == Outgoing.OPEN) "Complete and start in $to" else "Start in $to"
}

/**
 * The list, as a bottom sheet (board 04 part 3): the owner's workspaces, the current one first and not a press, one a new conversation
 * cannot open in greyed with why. The workspaces and runners are read when it opens; a read that fails leaves the list empty and says so.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun CoordinatorChangeSheet(api: ProjectApi, currentWorkspaceId: String?, close: () -> Unit, pick: (CoordinatorChange.Row) -> Unit) {
    var rows by remember { mutableStateOf<List<CoordinatorChange.Row>?>(null) }
    var failed by remember { mutableStateOf(false) }
    LaunchedEffect(api, currentWorkspaceId) {
        try {
            val workspaces = api.workspaces()
            val online = try { api.runners().filter { it.flag("online") }.mapNotNull { it.text("id") }.toSet() }
                catch (cancel: CancellationException) { throw cancel } catch (_: Exception) { null }
            rows = CoordinatorChange.rows(workspaces, currentWorkspaceId, online)
        } catch (cancel: CancellationException) { throw cancel } catch (_: Exception) { failed = true }
    }
    ModalBottomSheet(onDismissRequest = close, modifier = Modifier.testTag("coordinator-change-sheet")) {
        CoordinatorChangeList(rows, failed, pick)
    }
}

/** The sheet's content. */
@Composable
internal fun CoordinatorChangeList(rows: List<CoordinatorChange.Row>?, failed: Boolean, pick: (CoordinatorChange.Row) -> Unit) {
    Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(start = 16.dp, end = 16.dp, bottom = 24.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(CoordinatorChange.title, Modifier.semantics { heading() }, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
        when {
            rows == null && failed -> Text("Couldn't load workspaces.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
            rows == null -> CircularProgressIndicator(Modifier.align(Alignment.CenterHorizontally))
            else -> Column(Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.surfaceVariant, RoundedCornerShape(12.dp))) {
                rows.forEachIndexed { index, row ->
                    if (index > 0) HorizontalDivider()
                    Row(Modifier.fillMaxWidth().clickable(enabled = row.pickable) { pick(row) }.alpha(if (row.pickable) 1f else 0.45f)
                        .padding(horizontal = 12.dp, vertical = 10.dp).testTag("coordinator-change:${row.workspaceId}"),
                        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Column(Modifier.weight(1f)) {
                            Text(row.name)
                            Text(row.line, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                        if (row.runnerOffline) Text(CoordinatorChange.runnerOffline, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        if (row.current) Text(CoordinatorChange.current, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
            }
        }
        Text(CoordinatorChange.foot, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}
