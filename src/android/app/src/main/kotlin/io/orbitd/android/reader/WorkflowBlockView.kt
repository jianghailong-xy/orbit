package io.orbitd.android.reader

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import io.orbitd.android.R
import io.orbitd.android.core.cards.WorkflowFinished
import io.orbitd.android.ui.LocalOrbitColors

// An Orbit workflow (`mcp__orbit__workflow`) as Android draws it, following iOS (board docs/mocks/subagent-workflow part 4, OrbitApp
// `WorkflowBlockViews.swift`): the folded block, the page of its calls by phase, and the strip of the turn its end opens. The words are
// [WorkflowBlock]'s and [WorkflowFinishedStrip]'s.

/**
 * The folded block: `✦ Workflow <description>` with a spinner or how it ended, then the grey `<phase> · <done> of <started> · $<cost>`,
 * then, italic while it runs, how many calls run and wait. A tap opens its calls. [child] draws a nested record as the transcript does.
 */
@Composable
internal fun WorkflowBlockView(row: TranscriptRow, highlighted: Boolean, child: @Composable (TranscriptRow) -> Unit) {
    val block = workflowBlock(row)
    var showingCalls by rememberSaveable(row.key) { mutableStateOf(false) }
    val grey = MaterialTheme.colorScheme.onSurfaceVariant
    Column(Modifier.fillMaxWidth().background(if (highlighted) MaterialTheme.colorScheme.secondaryContainer else MaterialTheme.colorScheme.surface)
        .padding(horizontal = 10.dp, vertical = 6.dp).testTag(row.key)) {
        Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(6.dp)).background(AgentTone.copy(alpha = 0.06f))
            .drawBehind { drawRect(AgentTone, size = size.copy(width = 3.dp.toPx())) }
            .clickable(onClickLabel = "Show calls", role = Role.Button) { showingCalls = true }
            .padding(start = 12.dp, end = 10.dp, top = 8.dp, bottom = 8.dp).testTag("workflow-block"),
            verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(7.dp), verticalAlignment = Alignment.CenterVertically) {
                Text("✦", Modifier.clearAndSetSemantics { }, color = AgentTone, style = MaterialTheme.typography.labelLarge)
                Text(WorkflowBlock.LABEL, fontWeight = FontWeight.SemiBold, style = MaterialTheme.typography.labelLarge)
                Text(block.title, Modifier.weight(1f), color = grey, style = MaterialTheme.typography.labelLarge,
                    maxLines = 1, overflow = TextOverflow.Ellipsis)
                WorkflowStateGlyph(block.state)
            }
            Column(Modifier.padding(start = 20.dp), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                Text(block.progress, Modifier.testTag("workflow-progress"), color = grey, style = MaterialTheme.typography.bodySmall,
                    maxLines = 1, overflow = TextOverflow.Ellipsis)
                block.live?.let { Text(it, Modifier.testTag("workflow-live"), color = grey, fontStyle = FontStyle.Italic,
                    style = MaterialTheme.typography.bodySmall, maxLines = 1) }
                block.error?.let { Text(it, Modifier.testTag("workflow-error"), color = MaterialTheme.colorScheme.error,
                    style = MaterialTheme.typography.bodySmall, maxLines = 3, overflow = TextOverflow.Ellipsis) }
            }
        }
    }
    if (showingCalls) WorkflowCallsPage(row, { showingCalls = false }, child)
}

/** The block's words, from what the reader holds: the server's workflow and its calls' runs, and the transcript's calls. */
@Composable
private fun workflowBlock(row: TranscriptRow): WorkflowBlock {
    val id = row.event.toolId()
    val workflow = id?.let { LocalWorkflowRuns.current[it] }
    val runs = LocalSubagentRuns.current
    val running = LocalTaskActivity.current?.isRunning(id) == true
    return remember(row, workflow, runs, running) { WorkflowBlock.describe(row, workflow, { runs[it] }, running) }
}

/** A spinner while it runs, then how it ended. */
@Composable
private fun WorkflowStateGlyph(state: WorkflowBlock.State) {
    val red = MaterialTheme.colorScheme.error
    when (state) {
        WorkflowBlock.State.RUNNING -> CircularProgressIndicator(Modifier.size(14.dp).testTag("workflow-running"),
            color = MaterialTheme.colorScheme.onSurfaceVariant, strokeWidth = 2.dp)
        WorkflowBlock.State.DONE -> Text("✓", Modifier.semantics { stateDescription = "Finished" }, color = LocalOrbitColors.current.success,
            fontWeight = FontWeight.Bold, style = MaterialTheme.typography.labelLarge)
        WorkflowBlock.State.FAILED -> Text("✕", Modifier.semantics { stateDescription = "Failed" }, color = red,
            fontWeight = FontWeight.Bold, style = MaterialTheme.typography.labelLarge)
        WorkflowBlock.State.STOPPED -> Text("■", Modifier.semantics { stateDescription = "Stopped" }, color = red,
            style = MaterialTheme.typography.labelMedium)
    }
}

/** One row of the calls page, whatever it is: each phase's head, its calls, its `N more`. */
private sealed interface CallsRow {
    val key: String
    data class Head(val title: String, val first: Boolean) : CallsRow { override val key get() = "head:$title" }
    data class Call(val call: WorkflowBlock.Call) : CallsRow { override val key get() = "call:${call.id}" }
    data class More(val words: String, val section: String) : CallsRow { override val key get() = "more:$section" }
    data object Empty : CallsRow { override val key get() = "empty" }
}

/**
 * The page a workflow opens to: its calls by phase, each section headed by its counts, each row its label, the line it handed back and how
 * it stands. A row opens the call's SubAgent detail — the same block a `delegate` call draws, opened.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun WorkflowCallsPage(row: TranscriptRow, dismiss: () -> Unit, child: @Composable (TranscriptRow) -> Unit) {
    val block = workflowBlock(row)
    /** Ended phases the reader opened past their first rows. */
    var unfolded by rememberSaveable(row.key, "unfolded") { mutableStateOf(emptyList<String>()) }
    var detail by rememberSaveable(row.key, "detail") { mutableStateOf<String?>(null) }
    val call = detail?.let { id -> block.calls.firstOrNull { it.id == id } }
    Dialog(dismiss, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        Surface(Modifier.fillMaxSize().testTag("workflow-calls")) {
            Column(Modifier.fillMaxSize().safeDrawingPadding()) {
                BackHandler(enabled = call != null) { detail = null }
                // As on iOS: the list's title leads, a call's detail centres its own under a back button.
                val done = @Composable { TextButton(dismiss, Modifier.testTag("workflow-calls-done")) { Text("Done", fontWeight = FontWeight.SemiBold) } }
                if (call != null) CenterAlignedTopAppBar(
                    title = { Text(call.label, maxLines = 1, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.titleMedium) },
                    navigationIcon = { IconButton({ detail = null }, Modifier.testTag("workflow-call-back")) { Icon(painterResource(R.drawable.ic_back), "Back") } },
                    windowInsets = WindowInsets(0))
                else TopAppBar(
                    title = { Text(block.title.ifEmpty { WorkflowBlock.LABEL }, maxLines = 1, overflow = TextOverflow.Ellipsis,
                        fontWeight = FontWeight.SemiBold, style = MaterialTheme.typography.titleMedium) },
                    actions = { done() }, windowInsets = WindowInsets(0))
                if (call != null) {
                    // One call's SubAgent: the block a `delegate` call draws, opened — Why, steps, what it handed back.
                    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).testTag("workflow-call-detail")) {
                        SubagentBlockView(call.row, highlighted = false, startOpen = true, child = child)
                    }
                } else {
                    val rows = buildList {
                        block.sections.forEach { section ->
                            add(CallsRow.Head(section.header.uppercase(), first = isEmpty()))
                            val all = section.id in unfolded
                            (if (all) section.calls else section.calls.take(section.shown)).forEach { add(CallsRow.Call(it)) }
                            if (!all) section.more?.let { add(CallsRow.More(it, section.id)) }
                        }
                        if (isEmpty()) add(CallsRow.Empty)
                    }
                    LazyColumn(Modifier.fillMaxSize().testTag("workflow-calls-list"), contentPadding = PaddingValues(bottom = 16.dp)) {
                        items(rows, key = { it.key }) { item ->
                            when (item) {
                                is CallsRow.Head -> Text(item.title, Modifier.padding(start = 16.dp, end = 16.dp, top = if (item.first) 8.dp else 20.dp,
                                    bottom = 6.dp).testTag("workflow-phase"), color = MaterialTheme.colorScheme.onSurfaceVariant,
                                    fontWeight = FontWeight.SemiBold, style = MaterialTheme.typography.labelMedium)
                                is CallsRow.Call -> WorkflowCallRow(item.call) { detail = item.call.id }
                                is CallsRow.More -> Text(item.words, Modifier.fillMaxWidth()
                                    .clickable(role = Role.Button) { unfolded = unfolded + item.section }
                                    .padding(horizontal = 16.dp, vertical = 12.dp).testTag("workflow-more"),
                                    color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodyLarge)
                                CallsRow.Empty -> Text("No calls yet", Modifier.padding(16.dp), color = MaterialTheme.colorScheme.onSurfaceVariant)
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun WorkflowCallRow(call: WorkflowBlock.Call, onOpen: () -> Unit) {
    val grey = MaterialTheme.colorScheme.onSurfaceVariant
    Column(Modifier.fillMaxWidth()) {
        Row(Modifier.fillMaxWidth().clickable(onClickLabel = "Open", role = Role.Button, onClick = onOpen)
            .padding(horizontal = 16.dp, vertical = 12.dp).alpha(if (call.state == WorkflowBlock.CallState.QUEUED) 0.55f else 1f)
            .testTag("workflow-call:${call.id}"),
            horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(call.label, fontWeight = FontWeight.SemiBold, style = MaterialTheme.typography.bodyLarge, maxLines = 1)
            Text(call.result.orEmpty(), Modifier.weight(1f), color = grey, style = MaterialTheme.typography.bodyLarge,
                maxLines = 1, overflow = TextOverflow.Ellipsis)
            when (call.state) {
                WorkflowBlock.CallState.QUEUED -> Text("Queued", color = grey, style = MaterialTheme.typography.labelMedium)
                WorkflowBlock.CallState.RUNNING -> CircularProgressIndicator(Modifier.size(14.dp), color = grey, strokeWidth = 2.dp)
                WorkflowBlock.CallState.DONE -> Text("✓", Modifier.semantics { stateDescription = "Done" }, color = LocalOrbitColors.current.success,
                    fontWeight = FontWeight.Bold, style = MaterialTheme.typography.labelLarge)
                WorkflowBlock.CallState.FAILED -> Text("✕", Modifier.semantics { stateDescription = "Failed" }, color = MaterialTheme.colorScheme.error,
                    fontWeight = FontWeight.Bold, style = MaterialTheme.typography.labelLarge)
            }
            Text("›", Modifier.clearAndSetSemantics { }, color = MaterialTheme.colorScheme.outline, style = MaterialTheme.typography.titleMedium)
        }
        HorizontalDivider(Modifier.padding(start = 16.dp), color = MaterialTheme.colorScheme.outline.copy(alpha = 0.2f))
    }
}

/** The way back from a workflow's finished strip to its block, when that block is drawn; null where it is not. */
internal val LocalWorkflowCardJump = compositionLocalOf<(String) -> (() -> Unit)?> { { null } }

/**
 * The turn a workflow's end opened (board part 4 ②): a pale purple strip per workflow — how it ended, then its calls, failures, time and
 * cost. The parent's answer follows it as its own reply. A tap scrolls to the workflow's block.
 */
@Composable
internal fun WorkflowFinishedStripView(wake: WorkflowFinished) {
    val workflows = LocalWorkflowRuns.current.values
    val jump = LocalWorkflowCardJump.current
    Column(Modifier.fillMaxWidth().testTag("workflow-finished-strip"), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        wake.runs.forEach { run ->
            val server = WorkflowFinishedStrip.workflow(run, workflows)
            val strip = WorkflowFinishedStrip.describe(run, server)
            val reveal = server?.toolUseId?.let(jump)
            val rail = if (strip.failed) MaterialTheme.colorScheme.error else AgentTone
            Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(6.dp)).background(AgentTone.copy(alpha = 0.09f))
                .drawBehind { drawRect(rail, size = size.copy(width = 3.dp.toPx())) }
                .then(if (reveal != null) Modifier.clickable(onClickLabel = "Show the workflow", role = Role.Button, onClick = reveal) else Modifier)
                .padding(start = 12.dp, end = 10.dp, top = 8.dp, bottom = 8.dp),
                verticalArrangement = Arrangement.spacedBy(3.dp)) {
                Text(strip.title, color = if (strip.failed) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurface,
                    fontWeight = FontWeight.SemiBold, style = MaterialTheme.typography.labelLarge)
                Text(strip.line, color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodySmall)
            }
        }
    }
}
