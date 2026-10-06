package io.orbitd.android.projects

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.calculateZoom
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import io.orbitd.android.core.cards.*
import kotlinx.serialization.json.JsonObject

/** Edges keep their server direction: prerequisite → dependent, including server-folded marks. */
fun graphLevels(marks: List<JsonObject>, edges: List<JsonObject>): Map<String, Int> {
    val known = marks.mapNotNull { it.text("id") }.toSet()
    val incoming = known.associateWith { id -> edges.filter { it.text("targetMarkId") == id }.mapNotNull { it.text("sourceMarkId") }.filter { it in known } }
    val levels = mutableMapOf<String, Int>()
    repeat(known.size) {
        val ready = known.filter { it !in levels && incoming.getValue(it).all(levels::containsKey) }
        if (ready.isEmpty()) return@repeat
        ready.forEach { id -> levels[id] = incoming.getValue(id).maxOfOrNull { levels.getValue(it) + 1 } ?: 0 }
    }
    // A newer or inconsistent graph remains inspectable; no runnable state is inferred here.
    known.filter { it !in levels }.forEach { levels[it] = 0 }
    return levels
}

@Composable
fun ProjectGraph(graph: JsonObject, openTask: (String) -> Unit) {
    var fullscreen by rememberSaveable { mutableStateOf(false) }
    var selected by remember { mutableStateOf<JsonObject?>(null) }
    Column(Modifier.testTag("project-graph"), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text("Task graph", style = MaterialTheme.typography.titleLarge)
        Text("Prerequisite → dependent · ${graph.number("taskCount") ?: graph.objects("marks").size} tasks", style = MaterialTheme.typography.bodySmall)
        if (graph.flag("truncated")) Text("This graph is limited by the server. Open task details for the full dependencies.")
        if (graph.objects("marks").isEmpty()) Text("No task relationships yet.")
        else {
            GraphCanvas(graph, 280, 1f) { selected = it }
            TextButton(onClick = { fullscreen = true }) { Text("Expand graph") }
        }
    }
    if (fullscreen) Dialog(onDismissRequest = { fullscreen = false }, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        var scale by rememberSaveable { mutableFloatStateOf(1f) }
        Surface(Modifier.fillMaxSize()) {
            Column(Modifier.padding(16.dp).pointerInput(Unit) {
                awaitEachGesture {
                    awaitFirstDown(requireUnconsumed = false)
                    do {
                        val event = awaitPointerEvent()
                        if (event.changes.count { it.pressed } > 1) {
                            scale = (scale * event.calculateZoom()).coerceIn(.6f, 2f)
                            event.changes.forEach { it.consume() }
                        }
                    } while (event.changes.any { it.pressed })
                }
            }) {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    TextButton(onClick = { fullscreen = false }) { Text("Close graph") }
                    TextButton(onClick = { scale = (scale - .2f).coerceAtLeast(.6f) }) { Text("Zoom out") }
                    TextButton(onClick = { scale = (scale + .2f).coerceAtMost(2f) }) { Text("Zoom in") }
                }
                GraphCanvas(graph, null, scale) { selected = it }
            }
        }
    }
    selected?.let { mark ->
        val predecessors = graph.objects("edges").filter { it.text("targetMarkId") == mark.text("id") }.mapNotNull { edge ->
            graph.objects("marks").firstOrNull { it.text("id") == edge.text("sourceMarkId") }
        }
        AlertDialog(onDismissRequest = { selected = null }, title = { Text(mark.text("title") ?: "Task") },
            text = { Column(Modifier.heightIn(max = 440.dp).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(mark.text("status") ?: "${mark.number("taskCount") ?: 0} tasks")
                if (predecessors.isNotEmpty()) {
                    Text("Waits for", style = MaterialTheme.typography.titleSmall)
                    predecessors.forEach { parent -> TextButton(onClick = { selected = parent }) { Text(parent.text("title") ?: "Task") } }
                }
                if (mark.text("kind") != "TASK") {
                    if (!mark.flag("expandable")) Text("The server shows a sample of this group.")
                    (mark.objects("members") + mark.objects("samples")).distinctBy { it.text("taskId") }.forEach { member ->
                        TextButton(onClick = { member.text("taskId")?.let(openTask); selected = null; fullscreen = false }) {
                            Text("${member.text("title")} · ${member.text("status") ?: "Unknown"}")
                        }
                    }
                }
            } },
            confirmButton = { if (mark.text("kind") == "TASK") TextButton(onClick = {
                (mark.text("taskId") ?: mark.text("id"))?.let(openTask); selected = null; fullscreen = false
            }) { Text("Open task") } },
            dismissButton = { TextButton(onClick = { selected = null }) { Text("Close") } })
    }
}

@Composable
private fun GraphCanvas(graph: JsonObject, height: Int?, scale: Float, select: (JsonObject) -> Unit) {
    val marks = graph.objects("marks")
    val edges = graph.objects("edges")
    val levels = remember(graph) { graphLevels(marks, edges) }
    val positions = remember(graph) {
        val row = mutableMapOf<Int, Int>()
        marks.associate { mark ->
            val id = mark.text("id").orEmpty()
            val level = levels[id] ?: 0
            val index = row[level] ?: 0
            row[level] = index + 1
            id to (level to index)
        }
    }
    val cellWidth = 220 * scale
    val cellHeight = 116 * scale
    val width = ((positions.values.maxOfOrNull { it.first } ?: 0) + 1) * cellWidth
    val fullHeight = ((positions.values.maxOfOrNull { it.second } ?: 0) + 1) * cellHeight
    val ink = MaterialTheme.colorScheme.outline
    Box((if (height == null) Modifier.fillMaxSize() else Modifier.height(height.dp)).fillMaxWidth()
        .horizontalScroll(rememberScrollState()).verticalScroll(rememberScrollState())) {
        Box(Modifier.size(width.dp, fullHeight.dp)) {
            Canvas(Modifier.matchParentSize()) {
                edges.forEach { edge ->
                    val source = positions[edge.text("sourceMarkId")] ?: return@forEach
                    val target = positions[edge.text("targetMarkId")] ?: return@forEach
                    val start = Offset(((source.first + 1) * cellWidth - 26).dp.toPx(), (source.second * cellHeight + cellHeight / 2).dp.toPx())
                    val end = Offset((target.first * cellWidth + 8).dp.toPx(), (target.second * cellHeight + cellHeight / 2).dp.toPx())
                    drawLine(ink, start, end, 2.dp.toPx())
                    drawLine(ink, end, end - Offset(7.dp.toPx(), 5.dp.toPx()), 2.dp.toPx())
                    drawLine(ink, end, end - Offset(7.dp.toPx(), -5.dp.toPx()), 2.dp.toPx())
                }
            }
            marks.forEach { mark ->
                val pos = positions.getValue(mark.text("id").orEmpty())
                OutlinedCard(Modifier.offset((pos.first * cellWidth + 8).dp, (pos.second * cellHeight + 8).dp)
                    .size((cellWidth - 34).dp, (cellHeight - 16).dp).clickable { select(mark) }) {
                    Column(Modifier.padding(8.dp)) {
                        Text(mark.text("title") ?: "Task", maxLines = 2, style = MaterialTheme.typography.labelLarge)
                        Text(if (mark.text("kind") == "TASK") mark.text("workState") ?: mark.text("status") ?: "Unknown"
                            else "${mark.number("taskCount") ?: 0} tasks · ${mark.text("kind")}", style = MaterialTheme.typography.bodySmall, maxLines = 2)
                    }
                }
            }
        }
    }
}
