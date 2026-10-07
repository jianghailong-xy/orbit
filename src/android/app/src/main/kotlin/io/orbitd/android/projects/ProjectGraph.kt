package io.orbitd.android.projects

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectTransformGestures
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.TransformOrigin
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import io.orbitd.android.ui.LocalOrbitColors
import kotlinx.serialization.json.JsonObject
import kotlin.math.atan2
import kotlin.math.cos
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt
import kotlin.math.sin

// ProjectGraphView.swift: the project's task graph card, its full-screen view, and the task page's
// inline component. Nothing here is sized to the raw layout: marks are small cards scaled in place
// inside a bounded viewport, edges are drawn into it, so a 500-mark plan stays within what Compose
// can measure.

/** The project page's graph: the summary line, the plan scaled to fit (never under 0.5, at most 520
 * tall), a full-screen view with pinch and zoom, and the notice when the server read less than all. */
@Composable
fun ProjectGraph(graph: JsonObject, openTask: (String) -> Unit) {
    val parsed = remember(graph) { DependencyGraph.of(graph) }
    var expanded by rememberSaveable { mutableStateOf(listOf<String>()) }
    var fullscreen by rememberSaveable { mutableStateOf(false) }
    val (marks, edges) = remember(parsed, expanded) { ProjectGraphLayout.prepare(parsed, expanded.toSet()) }
    fun press(mark: GraphMark) {
        if (mark.kind == MarkKind.TASK) openTask(mark.taskId ?: mark.id)
        else if (ProjectGraphLayout.canOpen(mark)) expanded = expanded + mark.id
    }
    Column(Modifier.fillMaxWidth().testTag("project-graph"), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Row(verticalAlignment = Alignment.Top) {
            Text(ProjectGraphLayout.summary(parsed.taskCount, marks), Modifier.weight(1f), style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant)
            TextButton(onClick = { fullscreen = true }, modifier = Modifier.semantics { contentDescription = "Show the task graph full screen" }) { Text("Expand graph") }
        }
        GraphViewport(marks, edges, maxInlineHeight = 520f, minScale = 0.5f, focusId = null, press = ::press)
        if (parsed.truncated) {
            val (title, detail) = ProjectGraphLayout.truncatedNotice(parsed.maxTasks)
            Text("⚠ $title $detail", style = MaterialTheme.typography.labelMedium, color = LocalOrbitColors.current.needsYou)
        }
    }
    if (fullscreen) Dialog(onDismissRequest = { fullscreen = false }, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        Surface(Modifier.fillMaxSize().testTag("project-graph-fullscreen")) {
            var zoom by rememberSaveable { mutableFloatStateOf(1f) }
            var pan by remember { mutableStateOf(Offset.Zero) }
            Column {
                Row(Modifier.fillMaxWidth().padding(horizontal = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text("Task graph", Modifier.weight(1f), style = MaterialTheme.typography.titleMedium)
                    TextButton(onClick = { zoom = (zoom / 1.25f).coerceIn(0.2f, 3f) }) { Text("Zoom out") }
                    TextButton(onClick = { zoom = (zoom * 1.25f).coerceIn(0.2f, 3f) }) { Text("Zoom in") }
                    TextButton(onClick = { fullscreen = false }) { Text("Done") }
                }
                FullGraph(marks, edges, zoom, pan, { z, p -> zoom = z; pan = p }) { mark ->
                    if (mark.kind == MarkKind.TASK) { fullscreen = false; openTask(mark.taskId ?: mark.id) } else press(mark)
                }
            }
        }
    }
}

/** The task page's dependency component: inline only, the task being read outlined and inert. */
@Composable
fun TaskDependencyGraphView(graph: JsonObject, focusTaskId: String?, openTask: (String) -> Unit) {
    val parsed = remember(graph) { DependencyGraph.of(graph) }
    Box(Modifier.fillMaxWidth().testTag("task-dependency-graph")) {
        GraphViewport(parsed.marks, parsed.edges, maxInlineHeight = 420f, minScale = 0.5f, focusId = focusTaskId) { mark ->
            if (mark.id != focusTaskId && mark.kind == MarkKind.TASK) openTask(mark.taskId ?: mark.id)
        }
    }
}

/** The plan laid out for the width it has, scaled to fit and drawn into a bounded, clipped box. */
@Composable
private fun GraphViewport(marks: List<GraphMark>, edges: List<GraphEdge>, maxInlineHeight: Float, minScale: Float, focusId: String?,
    press: (GraphMark) -> Unit) {
    var widthDp by remember { mutableFloatStateOf(0f) }
    val density = LocalDensity.current
    Box(Modifier.fillMaxWidth().onSizeChanged { widthDp = with(density) { it.width.toDp().value } }) {
        if (widthDp > 0) {
            val layout = remember(marks, edges, widthDp) { ProjectGraphLayout.layout(marks, edges, widthDp.toDouble()) }
            val fit = layout.fit(widthDp.toDouble()).toFloat()
            val tall = if (layout.height > 0) maxInlineHeight / layout.height.toFloat() else 1f
            val scale = max(minScale, min(fit, tall))
            val shownWidth = min(widthDp, (layout.width * scale).toFloat())
            val shownHeight = min(maxInlineHeight, (layout.height * scale).toFloat())
            Box(Modifier.align(Alignment.TopCenter).size(shownWidth.dp, shownHeight.dp).clipToBounds()) {
                GraphContent(layout, edges, scale, Offset.Zero, shownWidth, shownHeight, focusId, press)
            }
        }
    }
}

/** Full screen: the whole plan, pinch or buttons to zoom between 0.2× and 3×, drag to move. */
@Composable
private fun FullGraph(marks: List<GraphMark>, edges: List<GraphEdge>, zoom: Float, pan: Offset, change: (Float, Offset) -> Unit, press: (GraphMark) -> Unit) {
    var size by remember { mutableStateOf(androidx.compose.ui.unit.IntSize.Zero) }
    val density = LocalDensity.current
    val widthDp = with(density) { size.width.toDp().value }
    val heightDp = with(density) { size.height.toDp().value }
    val currentZoom by rememberUpdatedState(zoom)
    val currentPan by rememberUpdatedState(pan)
    Box(Modifier.fillMaxSize().clipToBounds().onSizeChanged { size = it }.pointerInput(Unit) {
        detectTransformGestures { _, move, gesture, _ ->
            change((currentZoom * gesture).coerceIn(0.2f, 3f), currentPan + Offset(move.x / density.density, move.y / density.density))
        }
    }) {
        if (widthDp > 0) {
            val layout = remember(marks, edges, widthDp) { ProjectGraphLayout.layout(marks, edges, widthDp.toDouble()) }
            GraphContent(layout, edges, zoom, pan, widthDp, heightDp, null, press)
        }
    }
}

/** Edges and marks in graph units, drawn at `scale` and moved by `pan` (dp), only where visible. */
@Composable
private fun GraphContent(layout: ProjectGraphLayout.Layout, edges: List<GraphEdge>, scale: Float, pan: Offset, viewWidth: Float, viewHeight: Float,
    focusId: String?, press: (GraphMark) -> Unit) {
    val marks = layout.placements.map { it.mark }
    val states = remember(layout) { marks.associate { it.id to ProjectGraphLayout.state(it) } }
    val waiting = remember(layout, edges) { ProjectGraphLayout.waitingOn(marks, edges) }
    val colors = graphColors()
    Canvas(Modifier.fillMaxSize()) {
        val unit = density * scale
        fun at(p: ProjectGraphLayout.Point) = Offset((p.x.toFloat() * unit) + pan.x * density, (p.y.toFloat() * unit) + pan.y * density)
        layout.routes.forEach { route ->
            if (route.points.size < 2) return@forEach
            val state = states[route.source] ?: ProjectGraphLayout.State.PENDING
            val color = colors.edge(state)
            val path = Path().apply { val first = at(route.points.first()); moveTo(first.x, first.y); route.points.drop(1).forEach { val p = at(it); lineTo(p.x, p.y) } }
            drawPath(path, color, style = Stroke(width = (if (state == ProjectGraphLayout.State.COMPLETE) 1.2f else 1.5f) * density,
                cap = StrokeCap.Round, join = StrokeJoin.Round,
                pathEffect = if (state == ProjectGraphLayout.State.FAILED) PathEffect.dashPathEffect(floatArrayOf(4 * density, 3 * density)) else null))
            // The arrowhead follows the last segment into the dependent.
            val tip = at(route.points.last()); val before = at(route.points[route.points.size - 2])
            val angle = atan2(tip.y - before.y, tip.x - before.x)
            val length = 6f * density; val spread = 0.45f
            val head = Path().apply {
                moveTo(tip.x, tip.y)
                lineTo(tip.x - length * cos(angle - spread), tip.y - length * sin(angle - spread))
                lineTo(tip.x - length * cos(angle + spread), tip.y - length * sin(angle + spread))
                close()
            }
            drawPath(head, color)
        }
    }
    layout.placements.forEach { placement ->
        val box = placement.box
        val x = box.x.toFloat() * scale + pan.x
        val y = box.y.toFloat() * scale + pan.y
        // Only what the viewport shows is composed; a large plan costs what is on screen.
        if (x + box.width.toFloat() * scale < 0 || y + box.height.toFloat() * scale < 0 || x > viewWidth || y > viewHeight) return@forEach
        key(placement.mark.id) {
            Box(Modifier.offset { IntOffset((x * density).roundToInt(), (y * density).roundToInt()) }
                .graphicsLayer(scaleX = scale, scaleY = scale, transformOrigin = TransformOrigin(0f, 0f))
                .size(box.width.dp, box.height.dp)) {
                MarkCard(placement.mark, waiting[placement.mark.id] ?: 0, placement.mark.id == focusId, colors) { press(placement.mark) }
            }
        }
    }
}

private class GraphColors(val accent: Color, val success: Color, val failed: Color, val muted: Color) {
    fun edge(state: ProjectGraphLayout.State) = when (state) {
        ProjectGraphLayout.State.COMPLETE -> success.copy(alpha = 0.45f)
        ProjectGraphLayout.State.FAILED -> failed.copy(alpha = 0.8f)
        ProjectGraphLayout.State.ACTIVE, ProjectGraphLayout.State.QUEUED -> accent.copy(alpha = 0.8f)
        ProjectGraphLayout.State.PENDING -> muted.copy(alpha = 0.7f)
    }
    fun rail(tone: ProjectGraphLayout.Tone) = when (tone) {
        ProjectGraphLayout.Tone.READY, ProjectGraphLayout.Tone.ACTIVE -> accent
        ProjectGraphLayout.Tone.QUEUED -> accent.copy(alpha = 0.4f)
        ProjectGraphLayout.Tone.COMPLETE -> success.copy(alpha = 0.5f)
        ProjectGraphLayout.Tone.FAILED -> failed
        ProjectGraphLayout.Tone.BLOCKED -> muted.copy(alpha = 0.5f)
    }
    fun segment(status: String) = when (status) {
        "DONE" -> success; "IN_PROGRESS" -> accent; "FAILED" -> failed; "CANCELLED" -> muted.copy(alpha = 0.5f); else -> muted.copy(alpha = 0.35f)
    }
}

@Composable
private fun graphColors() = GraphColors(MaterialTheme.colorScheme.primary, LocalOrbitColors.current.success, MaterialTheme.colorScheme.error,
    MaterialTheme.colorScheme.onSurfaceVariant)

/** A task card (rail, title, one line of state) or a fold (title ×N, its bar and legend, dashed). */
@Composable
private fun MarkCard(mark: GraphMark, waitingOn: Int, focus: Boolean, colors: GraphColors, press: () -> Unit) {
    val shape = RoundedCornerShape(9.dp)
    val muted = MaterialTheme.colorScheme.onSurfaceVariant
    if (mark.kind == MarkKind.TASK) {
        val tone = ProjectGraphLayout.tone(mark)
        val complete = tone == ProjectGraphLayout.Tone.COMPLETE
        val loud = tone == ProjectGraphLayout.Tone.READY || tone == ProjectGraphLayout.Tone.ACTIVE || tone == ProjectGraphLayout.Tone.FAILED
        val border = when {
            focus -> colors.accent
            tone == ProjectGraphLayout.Tone.READY -> colors.accent.copy(alpha = 0.45f)
            tone == ProjectGraphLayout.Tone.FAILED -> colors.failed.copy(alpha = 0.4f)
            else -> muted.copy(alpha = 0.25f)
        }
        Row(Modifier.fillMaxSize()
            .then(if (focus || tone == ProjectGraphLayout.Tone.READY) Modifier.drawBehind {
                drawRoundRect(colors.accent.copy(alpha = 0.14f), topLeft = Offset(-3.dp.toPx(), -3.dp.toPx()),
                    size = androidx.compose.ui.geometry.Size(size.width + 6.dp.toPx(), size.height + 6.dp.toPx()),
                    cornerRadius = androidx.compose.ui.geometry.CornerRadius(12.dp.toPx()), style = Stroke(6.dp.toPx() / 2))
            } else Modifier)
            .background(muted.copy(alpha = if (complete) 0.08f else 0.03f), shape).border(if (focus) 2.dp else 1.dp, border, shape)
            .clickable(enabled = !focus, role = Role.Button, onClick = press).testTag("graph-mark:${mark.id}")) {
            Box(Modifier.width(3.dp).fillMaxHeight().background(colors.rail(tone), RoundedCornerShape(topStart = 9.dp, bottomStart = 9.dp)))
            Column(Modifier.padding(horizontal = 8.dp).fillMaxHeight(), verticalArrangement = Arrangement.Center) {
                Text(mark.title, fontSize = 12.sp, lineHeight = 14.sp, maxLines = 2, overflow = TextOverflow.Ellipsis,
                    fontWeight = if (complete) FontWeight.Normal else FontWeight.SemiBold, color = if (complete) muted else MaterialTheme.colorScheme.onSurface)
                Text(ProjectGraphLayout.meta(mark, waitingOn), fontSize = 10.sp, lineHeight = 12.sp, maxLines = 1, overflow = TextOverflow.Ellipsis,
                    fontWeight = if (loud) FontWeight.SemiBold else FontWeight.Normal,
                    color = when (tone) { ProjectGraphLayout.Tone.READY, ProjectGraphLayout.Tone.ACTIVE -> colors.accent; ProjectGraphLayout.Tone.FAILED -> colors.failed; else -> muted })
            }
        }
    } else {
        val settled = mark.kind == MarkKind.SETTLED
        val ink = if (ProjectGraphLayout.state(mark) == ProjectGraphLayout.State.FAILED) colors.failed else if (settled) colors.success else colors.accent
        Column(Modifier.fillMaxSize().background(ink.copy(alpha = 0.07f), RoundedCornerShape(10.dp))
            .drawBehind {
                drawRoundRect(ink.copy(alpha = 0.5f), cornerRadius = androidx.compose.ui.geometry.CornerRadius(10.dp.toPx()),
                    style = Stroke(1.dp.toPx(), pathEffect = PathEffect.dashPathEffect(floatArrayOf(4.dp.toPx(), 3.dp.toPx()))))
            }
            .clickable(enabled = ProjectGraphLayout.canOpen(mark), role = Role.Button, onClick = press).padding(horizontal = 9.dp).testTag("graph-mark:${mark.id}"),
            verticalArrangement = Arrangement.spacedBy(5.dp, Alignment.CenterVertically)) {
            Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(ProjectGraphLayout.foldTitle(mark), fontSize = 12.sp, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false),
                    color = if (settled) muted else MaterialTheme.colorScheme.onSurface)
                if (!settled) Text("×${ProjectGraphLayout.number(mark.taskCount)}", fontSize = 10.sp, color = muted)
            }
            val segments = ProjectGraphLayout.foldSegments(mark)
            val total = max(1, segments.sumOf { it.second })
            Row(Modifier.fillMaxWidth().height(5.dp).background(muted.copy(alpha = 0.15f), RoundedCornerShape(50)), horizontalArrangement = Arrangement.spacedBy(1.dp)) {
                segments.forEach { (status, count) -> Box(Modifier.weight(count.toFloat() / total).fillMaxHeight().background(colors.segment(status))) }
            }
            Text(ProjectGraphLayout.foldLegend(mark), fontSize = 10.sp, lineHeight = 12.sp, color = muted, maxLines = 2)
        }
    }
}
