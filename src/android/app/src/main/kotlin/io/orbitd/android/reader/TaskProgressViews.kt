package io.orbitd.android.reader

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.*
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.orbitd.android.core.realtime.RunEvent
import io.orbitd.android.text.CodeText
import io.orbitd.android.ui.LocalOrbitColors
import kotlinx.serialization.json.*

/**
 * The session's background agents and workflows as rows read them (iOS `TaskActivityLookup`): progress by
 * launching call — the end's last word once it ended, the live frame while it runs — and whether it still runs.
 */
internal class TaskActivity(private val live: Map<String, JsonObject>, private val ends: Map<String, JsonObject>,
    private val running: Set<String>) {
    fun progress(id: String?): TaskProgress? {
        id ?: return null
        val end = ends[id]?.let { TaskProgress.from(it) }
        // A frame buffered before a reconnect must not replace the last word the end itself carried.
        return if (id !in running && end != null) end else live[id]?.let { TaskProgress.from(it) } ?: end
    }
    fun isRunning(id: String?): Boolean = id != null && id in running

    companion object {
        /**
         * `background` is the session's REST list (GET /sessions/:id/background), which carries an ended
         * task's `progress`; `events` the loaded window, whose `background_task` events carry it too.
         */
        fun of(live: Map<String, JsonObject>?, events: List<RunEvent>, background: List<JsonObject>): TaskActivity {
            val ends = HashMap<String, JsonObject>()
            val running = HashSet<String>()
            events.filter { it.type == "background_task" }.forEach { e ->
                val id = e.fields.string("toolUseId")?.ifEmpty { null } ?: return@forEach
                (e.fields["progress"] as? JsonObject)?.let { ends[id] = it }
                if ((e.fields.string("status") ?: "running") == "running") running += id else running -= id
            }
            background.forEach { row ->
                val id = row.string("toolUseId")?.ifEmpty { null } ?: return@forEach
                (row["progress"] as? JsonObject)?.let { ends.putIfAbsent(id, it) }
                if (row.string("status") == "running") running += id else if (row.string("status") != null) running -= id
            }
            return TaskActivity(live.orEmpty(), ends, running)
        }
    }
}

internal val LocalTaskActivity = compositionLocalOf<TaskActivity?> { null }

/** How far a workflow (or an agent) has got: its agents by phase and the totals underneath (iOS `TaskProgressView`). */
@Composable
internal fun TaskProgressView(progress: TaskProgress, workflow: TranscriptRow? = null, agentRow: @Composable (TranscriptRow) -> Unit = {}) {
    val groups = remember(progress) { TaskProgressCopy.phaseGroups(progress) }
    val footer = remember(progress) { TaskProgressCopy.footer(progress) }
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(3.dp)) {
        groups.forEach { group ->
            if (group.title.isNotEmpty() || groups.size > 1) Row(Modifier.padding(top = 6.dp), horizontalArrangement = Arrangement.spacedBy(5.dp)) {
                Text(group.title.uppercase(), style = MaterialTheme.typography.labelSmall, fontWeight = FontWeight.SemiBold,
                    color = MaterialTheme.colorScheme.onSurfaceVariant)
                Text("${group.done}/${group.total}", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            group.agents.forEach { agent -> TaskAgentRow(agent, workflow, agentRow) }
        }
        if (footer.isNotEmpty()) {
            HorizontalDivider(Modifier.padding(top = 4.dp))
            Text(footer, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

/**
 * One agent of a workflow: where it stands, its label, what it is on now and its count — and, opened
 * (A06-6, iOS 3efa4e1b1), its model, its error and what it did: the Agent call its activity is nested
 * under, or the latest tool when that is all the runner relayed.
 */
@Composable
private fun TaskAgentRow(agent: TaskProgress.Agent, workflow: TranscriptRow?, agentRow: @Composable (TranscriptRow) -> Unit) {
    var expanded by rememberSaveable(workflow?.key, agent.index) { mutableStateOf(false) }
    val now = TaskProgressCopy.now(agent)
    val detail = TaskProgressCopy.detail(agent)
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Column(Modifier.fillMaxWidth().clickable(onClickLabel = "Show agent activity") { expanded = !expanded }
            .semantics(mergeDescendants = true) { stateDescription = if (expanded) "Expanded" else "Collapsed" }
            .padding(vertical = 5.dp), verticalArrangement = Arrangement.spacedBy(3.dp)) {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(if (expanded) "▾" else "▸", color = MaterialTheme.colorScheme.outline, modifier = Modifier.clearAndSetSemantics { })
                AgentGlyph(TaskProgressCopy.lane(agent))
                Text(agent.label, Modifier.weight(1f), fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.bodyMedium,
                    maxLines = if (expanded) Int.MAX_VALUE else 1, overflow = TextOverflow.Ellipsis)
                if (detail.isNotEmpty()) Text(detail, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            if (!expanded && now.isNotEmpty()) Text(now, Modifier.padding(start = 24.dp), fontFamily = FontFamily.Monospace,
                style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        if (expanded) AgentActivity(agent, workflow, agentRow)
    }
}

@Composable
private fun AgentActivity(agent: TaskProgress.Agent, workflow: TranscriptRow?, agentRow: @Composable (TranscriptRow) -> Unit) {
    // The Agent call this workflow agent ran as: a child of the Workflow call, its own calls nested under it.
    val card = agent.transcriptKey?.let { key -> workflow?.children?.firstOrNull { it.event.type == "tool_use" && it.event.toolId() == key } }
    agent.model?.takeIf { it.isNotEmpty() }?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
    agent.error?.takeIf { it.isNotEmpty() }?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium) }
    if (card != null && (card.children.isNotEmpty() || card.result != null)) {
        Column(Modifier.padding(start = 10.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) { agentRow(card) }
    } else {
        val latest = listOfNotNull(agent.lastToolName, agent.lastToolSummary).filter { it.isNotEmpty() }.joinToString("\n")
        if (latest.isNotEmpty()) {
            Text("Latest tool", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            CodeText(latest)
        }
        Text(if (agent.transcriptKey == null) "Detailed activity is not available for this agent." else "No activity received yet.",
            style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

@Composable
private fun AgentGlyph(lane: TaskProgressCopy.Lane) {
    val semantic = LocalOrbitColors.current
    when (lane) {
        TaskProgressCopy.Lane.DONE -> Text("✓", color = semantic.success, modifier = Modifier.width(16.dp))
        TaskProgressCopy.Lane.FAILED -> Text("✕", color = MaterialTheme.colorScheme.error, modifier = Modifier.width(16.dp))
        TaskProgressCopy.Lane.RUNNING -> CircularProgressIndicator(Modifier.size(12.dp), strokeWidth = 1.5.dp)
        TaskProgressCopy.Lane.QUEUED -> Text("○", color = MaterialTheme.colorScheme.outline, modifier = Modifier.width(16.dp))
    }
}
