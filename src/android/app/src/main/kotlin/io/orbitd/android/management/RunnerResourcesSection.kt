package io.orbitd.android.management

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.delay
import kotlinx.serialization.json.JsonObject

/** Resources: CPU, Memory and Disk, each its number, its detail and its last hour (RunnerResources). Polled every heartbeat while
 * the machine is online and the page is up; an offline machine shows its last reading, greyed. */
@Composable
internal fun RunnerResourcesSection(api: ManagementApi, runner: JsonObject, workspaces: List<JsonObject>, now: Long, online: Boolean, resumed: Boolean) {
    val id = runner.text("id")
    val reports = RunnerResources.reports(runner)
    var answer by remember(id) { mutableStateOf(RunnerResources.answerOf(null)) }
    LaunchedEffect(id, reports, online, resumed) {
        if (!reports || !resumed) return@LaunchedEffect
        while (true) {
            runCatching { api.get("runners/$id/resources") as? JsonObject }.getOrNull()?.let { answer = RunnerResources.answerOf(it) }
            if (!online) break
            delay(RunnerResources.POLL_MS)
        }
    }
    val tiles = RunnerResources.tiles(runner, answer, RunnerPage.runnerDisk(workspaces), online)
    val endMs = RunnerResources.endMs(answer, online, now)
    FormSection(RunnerCopy.RESOURCES, RunnerResources.header(runner, answer, online, now).first) {
        tiles.forEachIndexed { index, tile ->
            if (index > 0) HorizontalDivider()
            ResourceTileRow(tile, if (reports) RunnerResources.runs(answer.samples, tile.figure, endMs) else null, online)
        }
    }
}

@Composable
private fun ResourceTileRow(tile: RunnerResources.Tile, runs: List<List<Pair<Float, Float>>>?, online: Boolean) {
    val ink = when {
        !online -> Ink.muted
        tile.warn -> Ink.amber
        else -> MaterialTheme.colorScheme.primary
    }
    Column(Modifier.fillMaxWidth().padding(vertical = 10.dp).testTag("resource-${tile.figure.name.lowercase()}"),
        verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Row(verticalAlignment = Alignment.Bottom) {
            Text(tile.label, Modifier.weight(1f), style = MaterialTheme.typography.labelMedium, color = Ink.muted)
            if (tile.update != null) Text(RunnerCopy.RESOURCES_UPDATE, style = MaterialTheme.typography.labelMedium, color = Ink.amber)
            else Text(tile.percent?.let { "$it%" } ?: "—", fontSize = 22.sp, fontWeight = FontWeight.SemiBold,
                color = when { !online -> Ink.muted; tile.warn -> Ink.amber; else -> MaterialTheme.colorScheme.onSurface })
        }
        Text(tile.update ?: tile.detail, style = MaterialTheme.typography.bodySmall, color = Ink.muted)
        if (tile.update == null && runs != null) Sparkline(runs, ink)
        tile.note?.let { Text(it, style = MaterialTheme.typography.labelSmall, color = Ink.amber) }
    }
}

/** The hour as a line with the area under it; the dashed rule is 90%. */
@Composable
private fun Sparkline(runs: List<List<Pair<Float, Float>>>, ink: Color) {
    val rule = MaterialTheme.colorScheme.onSurface.copy(alpha = .12f)
    Canvas(Modifier.fillMaxWidth().height(36.dp).padding(top = 4.dp)) {
        val w = size.width
        val h = size.height
        drawLine(rule, Offset(0f, h * .1f), Offset(w, h * .1f), strokeWidth = 1f, pathEffect = PathEffect.dashPathEffect(floatArrayOf(6f, 6f)))
        for (run in runs) {
            val points = run.map { (x, y) -> Offset(x * w, h - y * h) }
            if (points.size == 1) { drawCircle(ink, 2.dp.toPx(), points[0]); continue }
            val line = Path().apply { moveTo(points[0].x, points[0].y); points.drop(1).forEach { lineTo(it.x, it.y) } }
            val area = Path().apply { addPath(line); lineTo(points.last().x, h); lineTo(points[0].x, h); close() }
            drawPath(area, ink.copy(alpha = .12f))
            drawPath(line, ink, style = Stroke(width = 1.6.dp.toPx()))
        }
    }
}
