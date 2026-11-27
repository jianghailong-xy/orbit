@file:OptIn(androidx.compose.foundation.layout.ExperimentalLayoutApi::class)

package io.orbitd.android.tasks

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import io.orbitd.android.core.cards.*
import io.orbitd.android.navigation.Destination
import io.orbitd.android.navigation.ObjectId
import io.orbitd.android.navigation.OrbitRoute
import io.orbitd.android.ui.LocalOrbitColors
import kotlinx.serialization.json.*
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

/** What the task card asks of the page it is drawn on: its writes, its sheets, and the page's own sections it reuses. */
internal class TaskRunCardActions(
    val fullPage: () -> Unit,
    val editRunsWith: () -> Unit,
    val retry: () -> Unit,
    val rerunCheck: () -> Unit,
    val closeNotNeeded: () -> Unit,
    /** Accept: the task's own confirmation, or the waiting run's request when its report has no reviewer. */
    val accept: () -> Unit,
    /** Send back, and Accept on a report under review: the conversation's own confirmation card. */
    val openConfirmationCard: () -> Unit,
    val readSession: suspend (String) -> JsonObject?,
)

/**
 * The task card over one of the task's own runs (docs/task-run-sidebar-design.md): the web column's blocks in its order —
 * [TaskRunCardLogic.blocks] — laid out as the iPhone's (OrbitKit `TaskRunCard.swift`, OrbitApp `TasksView.swift` `runCard`), from the
 * page's own pieces: Now is the page's [now], the expanded Activity is the page's own rows.
 */
@Composable
internal fun TaskRunCardList(
    task: JsonObject, here: JsonObject, data: TaskDetailData, owner: OwnerPanelAction?, enabled: Boolean, canStart: Boolean,
    runsWithLine: String, actions: TaskRunCardActions, open: (OrbitRoute) -> Unit, link: (String) -> Unit,
    banners: @Composable () -> Unit, now: @Composable (JsonObject) -> Unit, activityRow: @Composable (TaskActivityItem) -> Unit,
) {
    val muted = MaterialTheme.colorScheme.onSurfaceVariant
    val hereId = here.text("id").orEmpty()
    var session by remember(hereId) { mutableStateOf<JsonObject?>(null) }
    LaunchedEffect(hereId, task.text("updatedAt")) { actions.readSession(hereId)?.let { session = it } }
    var doneMeansShown by rememberSaveable(hereId) { mutableStateOf(false) }
    var activityShown by rememberSaveable(hereId) { mutableStateOf(false) }
    var noteShown by rememberSaveable(hereId) { mutableStateOf(false) }
    var outputShown by rememberSaveable(hereId) { mutableStateOf<String?>(null) }
    val state = TaskRunCardLogic.state(task.text("status"), needsYou = owner != null, running = TaskDetailLogic.liveRun(task) != null)
    val landing = TaskLandingLogic.status(TaskIntegrationView.of(task))?.badge
    val main = task.obj("integration")?.text("mainBranch") ?: "main"
    val landingLine = TaskRunCardLogic.landingLine(landing?.label, session?.text("mergeStatus"), session?.text("mergeTarget"), main, state)
    val activity = TaskDetailLogic.activity(task, data.evidence)
    val runs = task.objects("sessions")

    LazyColumn(Modifier.fillMaxSize().testTag("task-detail"), contentPadding = PaddingValues(16.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp)) {
        TaskRunCardLogic.blocks(state, hasBranch = session?.text("branch") != null, hasRuns = runs.isNotEmpty()).forEach { block ->
            when (block) {
                TaskRunCardBlock.HEAD -> item(key = "card-head") {
                    Column(Modifier.testTag("task-run-card"), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text(TaskRunCardCopy.KICKER, Modifier.weight(1f), style = MaterialTheme.typography.labelMedium, color = muted)
                            TextButton(onClick = actions.fullPage, modifier = Modifier.semantics { contentDescription = "Open the full task page" }) {
                                Text("⤢", style = MaterialTheme.typography.titleMedium)
                            }
                        }
                        Text(task.text("title") ?: "Untitled task", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold,
                            maxLines = 2, overflow = TextOverflow.Ellipsis)
                        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(4.dp),
                            itemVerticalAlignment = Alignment.CenterVertically) {
                            TaskStatusPill(TaskRunCardLogic.pill(task, state, here, data.evidence.lastOrNull()?.let(::evidenceRevision)),
                                Modifier.testTag("task-card-pill"))
                            if (state == TaskRunCardState.DONE && landing != null) {
                                val tone = cardTone(landing.tone)
                                Text(landing.label, Modifier.background(tone.copy(alpha = 0.15f), RoundedCornerShape(50)).padding(horizontal = 6.dp, vertical = 2.dp),
                                    style = MaterialTheme.typography.labelSmall, color = tone, maxLines = 1)
                            }
                            TaskRunCardLogic.meta(task, state, here, ::cardDay)?.let {
                                Text(it, style = MaterialTheme.typography.bodySmall, color = muted, maxLines = 1)
                            }
                        }
                        banners()
                    }
                }
                TaskRunCardBlock.STATE -> item(key = "card-state") {
                    when (state) {
                        TaskRunCardState.RUNNING -> TaskDetailLogic.liveRun(task)?.let { now(it) }
                        TaskRunCardState.NEEDS_YOU -> Tinted(LocalOrbitColors.current.needsYou, "task-card-review") {
                            Text(TaskRunCardCopy.REVIEW_THE_EVIDENCE, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold)
                            val evidence = data.evidence.lastOrNull()?.obj("evidence")
                            evidence?.text("claim")?.trim()?.takeIf { it.isNotEmpty() }?.let { Text(it, style = MaterialTheme.typography.bodyMedium) }
                            evidence?.objects("checks").orEmpty().forEach { check ->
                                val failed = (check["succeeded"] as? JsonPrimitive)?.booleanOrNull == false
                                CheckLine(if (failed) "✕" else "✓", if (failed) false else true, AnnotatedString(TaskDetailLogic.evidenceCheckText(check)))
                            }
                            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                                Button(onClick = actions.accept, enabled = enabled) { Text(TaskRunCardCopy.ACCEPT) }
                                OutlinedButton(onClick = actions.openConfirmationCard) { Text(TaskRunCardCopy.SEND_BACK) }
                            }
                        }
                        TaskRunCardState.DONE -> Tinted(LocalOrbitColors.current.success, "task-card-delivered") {
                            Text(TaskRunCardCopy.DELIVERED, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold)
                            val latest = data.evidence.lastOrNull()
                            val round = TaskRunCardLogic.newestRound(task, here)
                            val first = when {
                                latest?.obj("decision")?.text("decision") == "CONFIRM" ->
                                    TaskRunCardCopy.evidenceAccepted(evidenceRevision(latest), cardClock(latest.obj("decision")?.text("decidedAt")).orEmpty())
                                round != null && TaskRunCardLogic.roundPassed(round) && TaskRunCardLogic.roundExit(round) != null ->
                                    TaskRunCardCopy.checkExited(TaskRunCardLogic.roundExit(round)!!, cardClock(round.text("finishedAt")).orEmpty())
                                else -> TaskRunCardCopy.DONE
                            }
                            CheckLine("✓", true, AnnotatedString(first))
                            val landed = landing?.tone == "green"
                            CheckLine(if (landed) "✓" else "○", if (landed) true else null, AnnotatedString(landingLine))
                        }
                        TaskRunCardState.FAILED -> Tinted(MaterialTheme.colorScheme.error, "task-card-why-it-failed") {
                            Text(TaskRunCardCopy.WHY_IT_FAILED, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold)
                            val rounds = here.objects("acceptanceRounds")
                            if (rounds.isNotEmpty()) rounds.forEach { round ->
                                val roundId = round.text("id").orEmpty()
                                val passed = TaskRunCardLogic.roundPassed(round)
                                CheckLine(if (passed) "✓" else "✕", passed, AnnotatedString(
                                    TaskRunCardCopy.round(TaskRunCardLogic.roundExit(round), TaskRunCardLogic.roundExpected(round), cardClock(round.text("finishedAt")).orEmpty())
                                        + (round.text("branchSha")?.let { " on ${it.take(7)}" } ?: "")))
                                Text(TaskRunCardCopy.OUTPUT, Modifier.padding(start = 21.dp).clickable(role = Role.Button) {
                                    outputShown = if (outputShown == roundId) null else roundId }, style = MaterialTheme.typography.labelMedium,
                                    color = MaterialTheme.colorScheme.primary)
                                if (outputShown == roundId) Text(round.text("outputTail")?.takeIf { it.isNotEmpty() } ?: TaskRunCardCopy.PRINTED_NOTHING,
                                    Modifier.fillMaxWidth().background(muted.copy(alpha = 0.1f), RoundedCornerShape(6.dp)).padding(6.dp),
                                    style = MaterialTheme.typography.labelSmall, fontFamily = FontFamily.Monospace, maxLines = 12)
                            } else here.text("error")?.takeIf { it.isNotEmpty() }?.let { Text(it, style = MaterialTheme.typography.bodyMedium) }
                            task.objects("comments").lastOrNull()?.let { note ->
                                Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                                    Text("↳", style = MaterialTheme.typography.labelMedium, color = muted)
                                    Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                                        val body = note.text("body").orEmpty()
                                        Text(TaskRunCardCopy.latestNote(note.text("authorName") ?: "Unknown", cardDay(note.text("createdAt")).orEmpty()) +
                                            (if (noteShown) body else TaskRunCardLogic.firstLine(body)), style = MaterialTheme.typography.labelMedium, color = muted)
                                        Text(if (noteShown) TaskRunCardCopy.SHOW_LESS else TaskRunCardCopy.READ, Modifier.clickable(role = Role.Button) { noteShown = !noteShown },
                                            style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.primary)
                                    }
                                }
                            }
                            // Three presses, as the web column's: the check, the task, or closing it.
                            val executable = task.text("completionCriterion") == "EXECUTABLE" && !task.text("acceptanceCommand").isNullOrBlank()
                            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                if (executable) {
                                    Button(onClick = actions.rerunCheck, enabled = enabled, modifier = Modifier.testTag("task-card-rerun-check")) { Text(TaskRunCardCopy.RERUN_THE_CHECK) }
                                    OutlinedButton(onClick = actions.retry, enabled = enabled && canStart) { Text(TaskRunCardCopy.RETRY_THE_TASK) }
                                } else Button(onClick = actions.retry, enabled = enabled && canStart) { Text(TaskRunCardCopy.RETRY_THE_TASK) }
                            }
                            OutlinedButton(onClick = actions.closeNotNeeded, enabled = enabled) { Text(TaskRunCardCopy.CLOSE_AS_NOT_NEEDED) }
                        }
                        null -> Unit
                    }
                }
                TaskRunCardBlock.BRANCH -> item(key = "card-branch") {
                    val current = session ?: return@item
                    val commits = current.objects("branchCommits")
                    val merged = (current["branchMerged"] as? JsonPrimitive)?.booleanOrNull == true
                    TaskSectionHeader(TaskRunCardCopy.BRANCH)
                    Column(Modifier.testTag("task-card-branch"), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        KeyValue(TaskRunCardCopy.BRANCH) { Text(current.text("branch").orEmpty(), fontFamily = FontFamily.Monospace,
                            style = MaterialTheme.typography.bodySmall, maxLines = 1, overflow = TextOverflow.Ellipsis) }
                        KeyValue(TaskRunCardCopy.versus(main)) { Text(if (merged) TaskRunCardCopy.inMain(main) else TaskRunCardCopy.ahead(commits.size),
                            style = MaterialTheme.typography.bodyMedium) }
                        if (commits.isNotEmpty() && !merged) KeyValue(TaskRunCardCopy.LEFT) {
                            Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
                                commits.take(3).forEach { commit ->
                                    Text(buildAnnotatedString {
                                        withStyle(SpanStyle(fontFamily = FontFamily.Monospace)) { append(commit.text("sha").orEmpty().take(7)) }
                                        append(" ${commit.text("subject").orEmpty()}")
                                    }, style = MaterialTheme.typography.bodyMedium, maxLines = 2, overflow = TextOverflow.Ellipsis)
                                }
                                if (commits.size > 3) Text(TaskRunCardCopy.more(commits.size - 3), style = MaterialTheme.typography.bodyMedium, color = muted)
                            }
                        }
                        KeyValue(TaskRunCardCopy.LANDING) { Text(landingLine, style = MaterialTheme.typography.bodyMedium) }
                    }
                }
                TaskRunCardBlock.DONE_MEANS -> item(key = "card-done-means") {
                    TaskSectionHeader(TaskRunCardCopy.DONE_MEANS)
                    val executable = task.text("completionCriterion") == "EXECUTABLE"
                    Column(Modifier.testTag("task-card-done-means"), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        TaskRunCardLogic.doneMeans(task.text("acceptanceCriteria"), if (executable) task.text("acceptanceCommand") else null,
                            TaskRunCardLogic.newestRound(task, here), task.text("status"),
                            data.evidence.lastOrNull()?.obj("decision")?.text("decision")).forEach { row ->
                            val passed = when (row.mark) { TaskDoneMeansRow.Mark.PASSED -> true; TaskDoneMeansRow.Mark.FAILED -> false; else -> null }
                            CheckLine(row.mark.glyph, passed, if (row.code) AnnotatedString(row.text) else inlineCode(row.text), code = row.code)
                        }
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text(TaskRunCardCopy.CRITERIA_TEXT_BRIEF, Modifier.weight(1f), style = MaterialTheme.typography.labelMedium, color = muted)
                            Text(if (doneMeansShown) TaskRunCardCopy.HIDE else TaskRunCardCopy.SHOW, Modifier.clickable(role = Role.Button) { doneMeansShown = !doneMeansShown },
                                style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.primary)
                        }
                        if (doneMeansShown) {
                            AcceptanceDraft.blankToNull(AcceptanceDraft(task).criteria)?.let {
                                Text(TaskDetailCopy.acceptanceCriteriaLabel, style = MaterialTheme.typography.labelMedium, color = muted)
                                FoldableMarkdown(it, link)
                            }
                            task.text("description")?.takeIf { it.isNotEmpty() }?.let {
                                Text(TaskDetailCopy.briefHeading, style = MaterialTheme.typography.labelMedium, color = muted)
                                FoldableMarkdown(it, link)
                            }
                        }
                    }
                }
                TaskRunCardBlock.RUNS -> item(key = "card-runs") {
                    TaskSectionHeader(TaskRunCardCopy.RUNS)
                    Column(Modifier.testTag("task-card-runs"), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        runs.forEachIndexed { index, run ->
                            val isHere = ObjectId.same(run.text("id"), hereId)
                            val sub = listOfNotNull(cardDay(run.text("createdAt")), TaskDetailLogic.costLabel(TaskDetailLogic.runCost(run)))
                            Row(Modifier.fillMaxWidth().let { row -> if (isHere) row else row.clickable(role = Role.Button) {
                                run.text("id")?.let { open(OrbitRoute(Destination.SESSION, it)) } } }.padding(vertical = 2.dp),
                                verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                Box(Modifier.size(8.dp).background(runColor(run), CircleShape))
                                Text(buildAnnotatedString {
                                    withStyle(SpanStyle(fontWeight = FontWeight.SemiBold)) { append(TaskRunCardCopy.run(runs.size - index)) }
                                    if (sub.isNotEmpty()) append(" · " + sub.joinToString(" · "))
                                    if (isHere) withStyle(SpanStyle(color = muted)) { append(" · ${TaskRunCardCopy.THIS_CONVERSATION}") }
                                }, style = MaterialTheme.typography.bodyMedium)
                            }
                        }
                    }
                }
                TaskRunCardBlock.RUNS_WITH -> item(key = "card-runs-with") {
                    HorizontalDivider()
                    Row(Modifier.fillMaxWidth().padding(vertical = 4.dp).testTag("task-runs-with"), verticalAlignment = Alignment.CenterVertically) {
                        Text(runsWithLine, Modifier.weight(1f), style = MaterialTheme.typography.bodyMedium, color = muted, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        TextButton(onClick = actions.editRunsWith, enabled = enabled) { Text(TaskRunCardCopy.EDIT) }
                    }
                }
                TaskRunCardBlock.ACTIVITY -> {
                    item(key = "card-activity") {
                        HorizontalDivider()
                        Row(Modifier.fillMaxWidth().clickable(role = Role.Button) { activityShown = !activityShown }.padding(vertical = 10.dp)
                            .testTag("task-card-activity"), verticalAlignment = Alignment.CenterVertically) {
                            Text(TaskRunCardLogic.activityLine(activity.size, task.obj("creatorSession")), Modifier.weight(1f),
                                style = MaterialTheme.typography.bodyMedium, color = muted, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            Text("›", Modifier.rotate(if (activityShown) 90f else 0f), color = muted)
                        }
                    }
                    if (activityShown) items(activity, key = { "card-activity:${it.key}" }) { activityRow(it) }
                }
            }
        }
    }
}

/** One tinted card, the web column's `tdp-state`. */
@Composable
private fun Tinted(tint: Color, tag: String, content: @Composable ColumnScope.() -> Unit) {
    Column(Modifier.fillMaxWidth().background(tint.copy(alpha = 0.1f), RoundedCornerShape(12.dp)).padding(12.dp).testTag(tag),
        verticalArrangement = Arrangement.spacedBy(7.dp), content = content)
}

/** A ✓ / ✕ / ○ line of the state block and the Done means checklist. */
@Composable
private fun CheckLine(glyph: String, passed: Boolean?, text: AnnotatedString, code: Boolean = false) {
    val color = when (passed) { true -> LocalOrbitColors.current.success; false -> MaterialTheme.colorScheme.error; null -> MaterialTheme.colorScheme.onSurfaceVariant }
    Row(horizontalArrangement = Arrangement.spacedBy(7.dp)) {
        Text(glyph, Modifier.width(14.dp), style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.Bold, color = color)
        Text(text, style = MaterialTheme.typography.bodyMedium, fontFamily = if (code) FontFamily.Monospace else null,
            color = if (passed == null) MaterialTheme.colorScheme.onSurfaceVariant else MaterialTheme.colorScheme.onSurface)
    }
}

@Composable
private fun KeyValue(label: String, value: @Composable () -> Unit) {
    Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        Text(label, Modifier.width(72.dp), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Box(Modifier.weight(1f)) { value() }
    }
}

/** A criterion line with its `code` spans drawn as code, as the Markdown it was written in would. */
private fun inlineCode(text: String): AnnotatedString = buildAnnotatedString {
    text.split("`").forEachIndexed { i, part ->
        if (i % 2 == 1) withStyle(SpanStyle(fontFamily = FontFamily.Monospace)) { append(part) } else append(part)
    }
}

@Composable
private fun runColor(run: JsonObject): Color = when (resolvedRunState(run)) {
    "RUNNING" -> LocalOrbitColors.current.running
    "QUEUED", "AWAITING_INPUT" -> LocalOrbitColors.current.needsYou
    "SUCCEEDED" -> LocalOrbitColors.current.success
    "FAILED" -> MaterialTheme.colorScheme.error
    else -> MaterialTheme.colorScheme.onSurfaceVariant
}

@Composable
private fun cardTone(tone: String): Color = when (tone) {
    "green" -> LocalOrbitColors.current.success
    "red" -> MaterialTheme.colorScheme.error
    "amber" -> LocalOrbitColors.current.needsYou
    "blue" -> LocalOrbitColors.current.running
    else -> MaterialTheme.colorScheme.onSurfaceVariant
}

private val dayFormat = DateTimeFormatter.ofPattern("MMM d", Locale.getDefault())
private val clockFormat = DateTimeFormatter.ofPattern("h:mm a", Locale.getDefault())

/** `Sep 28`, as the web column and the iPhone write a run's date. */
internal fun cardDay(iso: String?): String? = TaskTime.parse(iso)?.atZone(ZoneId.systemDefault())?.format(dayFormat)

/** `11:53 AM`, a round's or a decision's time. */
internal fun cardClock(iso: String?): String? = TaskTime.parse(iso)?.atZone(ZoneId.systemDefault())?.format(clockFormat)
