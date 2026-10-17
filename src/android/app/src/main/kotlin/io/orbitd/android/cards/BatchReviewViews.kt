package io.orbitd.android.cards

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import io.orbitd.android.R
import io.orbitd.android.core.cards.*
import io.orbitd.android.text.MarkdownText
import io.orbitd.android.ui.LocalOrbitColors
import kotlinx.serialization.json.JsonObject

/** What the write does, one row per consequence (iOS `BatchImpactRowView`): its mark, the count and what happens to it, and the
 * reason on a line of its own. Drawn by the batch review and by a single create alike. */
@Composable
internal fun ImpactRows(preview: JsonObject) {
    val rows = BatchReview.impactRows(preview)
    if (rows.isEmpty()) return
    Column(Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.surface, RoundedCornerShape(12.dp)).testTag("batch-impact")) {
        rows.forEachIndexed { index, row ->
            if (index > 0) HorizontalDivider(Modifier.padding(start = 58.dp))
            val (icon, tone) = when (row.kind) {
                BatchImpactRow.Kind.STARTING -> R.drawable.ic_play to LocalOrbitColors.current.success
                BatchImpactRow.Kind.WAITING -> R.drawable.ic_clock to MaterialTheme.colorScheme.onSurfaceVariant
                BatchImpactRow.Kind.MANUAL_START -> R.drawable.ic_remove_circle to MaterialTheme.colorScheme.onSurfaceVariant
                BatchImpactRow.Kind.CANNOT_RUN -> R.drawable.ic_warning to LocalOrbitColors.current.needsYou
            }
            Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 12.dp), horizontalArrangement = Arrangement.spacedBy(12.dp),
                verticalAlignment = Alignment.CenterVertically) {
                Box(Modifier.size(30.dp).background(tone.copy(alpha = 0.15f), RoundedCornerShape(8.dp)), contentAlignment = Alignment.Center) {
                    Icon(painterResource(icon), null, Modifier.size(16.dp), tint = tone)
                }
                Column(Modifier.weight(1f)) {
                    Text(row.head, style = MaterialTheme.typography.bodyLarge.copy(fontWeight = FontWeight.SemiBold))
                    row.reason?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
                }
            }
        }
    }
}

/**
 * The batch-create review's body (A08-7; iOS `BatchCreateReviewBody`): the consequences first, then where the batch lands and its
 * shape, then the tasks — by level ("Level 2 · 2 in parallel") when they wait on each other, one numbered list when they do not —
 * each naming every prerequisite by its number, and each one press from its own page ([page] is the open one, by window index).
 */
@Composable
internal fun BatchReviewBody(card: InteractionCard, open: (String) -> Unit, page: Int?, openPage: (Int?) -> Unit) {
    val input = card.source.obj("input") ?: return
    val preview = input.obj("preview") ?: return
    val tasks = BatchReview.tasks(preview)
    val levels = BatchReview.levels(tasks)
    val rows = levels.flatMap { it.rows }
    val truncated = preview.number("titlesTruncated") ?: 0
    val total = if (truncated == 0) preview.number("taskCount") ?: tasks.size else null
    page?.let { index -> rows.firstOrNull { it.index == index } }?.let { row ->
        BatchTaskPage(row, levels, BatchReview.detail(row, BatchReview.details(input)), total, open, openPage)
        return
    }
    Column(verticalArrangement = Arrangement.spacedBy(22.dp)) {
        ImpactRows(preview)
        Column(verticalArrangement = Arrangement.spacedBy(7.dp)) {
            BatchReview.detailLine(preview).takeIf { it.isNotEmpty() }?.let {
                Text(it, Modifier.padding(horizontal = 16.dp).testTag("batch-detail"), style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            if (levels.size > 1) levels.forEachIndexed { index, level ->
                LevelBlock(level, first = index == 0, last = index == levels.lastIndex) { BatchRows(level.rows, openPage) }
            } else if (rows.isNotEmpty()) BatchRows(rows, openPage)
            if (truncated > 0) Text(BatchReview.more(truncated), Modifier.padding(horizontal = 16.dp), style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

/** A level's heading and its rows, on the rail that runs down the levels. */
@Composable
private fun LevelBlock(level: BatchLevel, first: Boolean, last: Boolean, rows: @Composable () -> Unit) {
    val rail = MaterialTheme.colorScheme.onSurfaceVariant
    Row(Modifier.fillMaxWidth().height(IntrinsicSize.Min).testTag("batch-level:${level.number}")) {
        Column(Modifier.width(14.dp).fillMaxHeight(), horizontalAlignment = Alignment.CenterHorizontally) {
            Box(Modifier.width(1.5.dp).height(4.dp).background(if (first) Color.Transparent else rail.copy(alpha = 0.35f)))
            Box(Modifier.size(10.dp).background(rail.copy(alpha = 0.5f), CircleShape))
            Box(Modifier.width(1.5.dp).weight(1f).background(if (last) Color.Transparent else rail.copy(alpha = 0.35f)))
        }
        Column(Modifier.weight(1f).padding(start = 8.dp, bottom = if (last) 0.dp else 10.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(BatchReview.levelName(level), style = MaterialTheme.typography.bodySmall.copy(fontWeight = FontWeight.SemiBold),
                    color = MaterialTheme.colorScheme.onSurfaceVariant)
                BatchReview.levelParallel(level)?.let { Text(" · $it", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
            }
            rows()
        }
    }
}

@Composable
private fun BatchRows(rows: List<BatchLevelRow>, openPage: (Int?) -> Unit) {
    Column(Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.surface, RoundedCornerShape(12.dp))) {
        rows.forEachIndexed { index, row ->
            if (index > 0) HorizontalDivider(Modifier.padding(start = 50.dp))
            BatchRow(row) { openPage(row.index) }
        }
    }
}

/** One task: its number, its title, and under it every prerequisite's number — "Waits on ① ②, and a task outside". */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun BatchRow(row: BatchLevelRow, press: () -> Unit) {
    Row(Modifier.fillMaxWidth().clickable(role = Role.Button, onClick = press).heightIn(min = 48.dp).padding(horizontal = 14.dp, vertical = 11.dp)
        .testTag("batch-row:${row.number}"), horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
        NumberBadge(row.number, 24)
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(row.title, style = MaterialTheme.typography.bodyLarge)
            if (row.waitsOn.isNotEmpty() || row.waitsOutside) FlowRow(horizontalArrangement = Arrangement.spacedBy(4.dp),
                verticalArrangement = Arrangement.spacedBy(2.dp), itemVerticalAlignment = Alignment.CenterVertically) {
                Text(BatchReview.waitsOn, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                row.waitsOn.forEach { NumberBadge(it, 18) }
                if (row.waitsOutside) Text(if (row.waitsOn.isEmpty()) BatchReview.outsideTask else BatchReview.andOutsideTask,
                    style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
        Icon(painterResource(R.drawable.ic_chevron_forward), null, Modifier.size(14.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.6f))
    }
}

@Composable
private fun NumberBadge(number: Int, size: Int) {
    Box(Modifier.size(size.dp).background(MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.12f), CircleShape), contentAlignment = Alignment.Center) {
        Text("$number", style = (if (size >= 24) MaterialTheme.typography.labelMedium else MaterialTheme.typography.labelSmall).copy(fontWeight = FontWeight.SemiBold))
    }
}

/**
 * One task's page inside the review (iOS `BatchTaskPage`): "Task 2 of 3", its title, how it is judged and its labels, what it waits on
 * and what waits on it (each one press away), what counts as done and its description — read off the body the runner sends. The page
 * decides nothing: the batch's yes stays on the review it came from.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun BatchTaskPage(row: BatchLevelRow, levels: List<BatchLevel>, detail: BatchTaskDetail?, total: Int?, open: (String) -> Unit,
    openPage: (Int?) -> Unit) {
    val rows = levels.flatMap { it.rows }
    Column(Modifier.fillMaxWidth().testTag("batch-task-page:${row.number}"), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        TextButton(onClick = { openPage(null) }, Modifier.testTag("batch-task-page:back")) {
            Icon(painterResource(R.drawable.ic_back), null, Modifier.size(16.dp)); Spacer(Modifier.width(4.dp)); Text("Back")
        }
        Text(BatchReview.taskPageTitle(row.number, total), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Text(row.title, style = MaterialTheme.typography.titleLarge)
        val chips = listOfNotNull(detail?.judgedBy) + detail?.labels.orEmpty()
        if (chips.isNotEmpty()) FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            chips.forEach {
                Text(it, Modifier.background(MaterialTheme.colorScheme.surfaceVariant, RoundedCornerShape(50)).padding(horizontal = 10.dp, vertical = 4.dp),
                    style = MaterialTheme.typography.bodySmall)
            }
        }
        val prerequisites = rows.filter { it.number in row.waitsOn }
        if (prerequisites.isNotEmpty() || row.waitsOutside) PageSection(BatchReview.waitsOn) {
            prerequisites.forEach { BatchRow(it) { openPage(it.index) } }
            if (row.waitsOutside) Text(BatchReview.outsideTaskSection, Modifier.padding(horizontal = 14.dp, vertical = 8.dp), style = MaterialTheme.typography.bodyMedium)
        }
        BatchReview.neededBy(row, levels).takeIf { it.isNotEmpty() }?.let { after ->
            PageSection(BatchReview.neededBy) { after.forEach { BatchRow(it) { openPage(it.index) } } }
        }
        detail?.acceptanceCriteria?.takeIf { it.isNotBlank() }?.let { PageSection(BatchReview.doneWhen) { MarkdownText(it, open = open) } }
        detail?.description?.takeIf { it.isNotBlank() }?.let { PageSection(BatchReview.descriptionHeading) { MarkdownText(it, open = open) } }
    }
}

@Composable
private fun PageSection(heading: String, content: @Composable ColumnScope.() -> Unit) {
    Column(Modifier.padding(top = 12.dp), verticalArrangement = Arrangement.spacedBy(7.dp)) {
        Text(heading, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        content()
    }
}
