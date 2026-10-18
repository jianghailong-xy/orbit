package io.orbitd.android.reader

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.*
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import io.orbitd.android.R
import io.orbitd.android.tasks.TaskTime
import io.orbitd.android.ui.LocalOrbitColors
import kotlinx.serialization.json.*

/** The bar's second row while a merge waits on target recovery: what holds it, one line, opening the review (iOS `MergeRecoveryRow`). */
@Composable
internal fun MergeRecoveryRow(recovery: MergeRecovery, working: Boolean, open: () -> Unit) {
    val warning = LocalOrbitColors.current.needsYou
    Row(Modifier.fillMaxWidth().background(warning.copy(alpha = 0.09f)).clickable(onClickLabel = "Opens the merge review", onClick = open)
        .heightIn(min = 30.dp).padding(horizontal = 10.dp), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
        if (working) CircularProgressIndicator(Modifier.size(12.dp), strokeWidth = 1.5.dp)
        else Text("⚠", color = warning, style = MaterialTheme.typography.bodySmall, modifier = Modifier.clearAndSetSemantics { })
        Text(recovery.title, Modifier.weight(1f), style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.SemiBold,
            maxLines = 1, overflow = TextOverflow.Ellipsis)
        Text("›", color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

/**
 * A merge held for target recovery, reviewed full screen (iOS `MergeRecoverySheet`): what holds it, the
 * branches and how local and remote targets stand, the commits the push adds and the complete candidate
 * diff, the merge check — and the step the state asks for pinned at the foot. It reads the bar live, and
 * closes itself once the recovery is gone. [turnActive] is the bar's own gate (`WorktreeBarLogic.turnActive`),
 * so a turn in flight holds the steps back here exactly as it holds Merge and Commit there. With a repair
 * session at work on a server that checks each repair turn by itself, the review is the repair loop's board:
 * the repair row's six states, the check in flight, and the steps they ask for.
 */
@Composable
internal fun MergeRecoveryReview(model: WorktreeModel, d: JsonObject, r: MergeRecovery, turnActive: Boolean, open: (String) -> Unit, close: () -> Unit) {
    val state by model.state.collectAsState()
    var pressed by remember { mutableStateOf<MergeRecovery.Button?>(null) }
    val supported = (d["mergeRecoverySupported"] as? JsonPrimitive)?.booleanOrNull == true
    val working = state.busy || d.string("mergeStatus") == "pending"
    val repair = MergeRecovery.repair(d)
    val landed = r.code == "ALREADY_LANDED"
    // The repair loop's row, the server's check of what the repair left, and the steps (MergeRecovery.review).
    val (row, checking, buttons) = r.review(d)
    val blocked = working || turnActive || repair?.running == true
    val secondary = MaterialTheme.colorScheme.onSurfaceVariant
    // What the check is about to replace fades while the server checks the repair.
    val dim = if (checking) Modifier.alpha(0.4f) else Modifier
    fun run(step: MergeRecovery.Button) {
        pressed = step
        when (step.action) {
            "open" -> repair?.id?.let { close(); open("orbit-session:$it") }
            "repair" -> model.repairRecovery(step.preparePR == true) { id -> close(); open("orbit-session:$id") }
            else -> model.recoverMerge(step.action, r.previewId, r.targetBranch)
        }
    }
    // Opening the repair is never held back, and waiting for its check is never a step.
    fun enabled(step: MergeRecovery.Button) = when (step.action) { "open" -> true; "wait" -> false; else -> !blocked }
    fun title(step: MergeRecovery.Button) = if (working && pressed == step) "Working…" else step.title
    Dialog(close, properties = DialogProperties(usePlatformDefaultWidth = false)) { Surface(Modifier.fillMaxSize().safeDrawingPadding()) { Column {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
            TextButton(onClick = close, modifier = Modifier.semantics { contentDescription = "Close" }) { Text("✕") }
        }
        LazyColumn(Modifier.weight(1f).padding(horizontal = 16.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
            item {
                Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text(r.title, style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.SemiBold, modifier = Modifier.semantics { heading() })
                    if (checking || working) Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                        CircularProgressIndicator(Modifier.size(12.dp), strokeWidth = 1.5.dp)
                        Text(if (checking) "Checking the repair…" else "Working…", color = secondary)
                    } else if (r.checkedAt != null || buttons.headerCheck != null) Row(horizontalArrangement = Arrangement.spacedBy(4.dp), verticalAlignment = Alignment.CenterVertically) {
                        r.checkedAt?.let { Text("Checked ${TaskTime.relative(it) ?: it}", color = secondary, style = MaterialTheme.typography.bodyMedium)
                            if (buttons.headerCheck != null) Text("·", color = secondary) }
                        buttons.headerCheck?.let { check -> TextButton(enabled = !blocked, onClick = { run(check) }) { Text(check.title) } }
                    }
                    r.lede()?.let { Text(it, color = secondary, style = MaterialTheme.typography.bodyMedium) }
                }
            }
            if (repair != null && row != null) item {
                RepairRowView(row, repair.title ?: "Resolve merge recovery for ${r.targetBranch}") { repair.id?.let { open("orbit-session:$it") } }
            }
            d.string("mergeError")?.takeIf { !r.ready && !landed && it.isNotBlank() }?.let { message -> item { Column(dim) { Fold("Details") { Mono(message) } } } }
            r.conflicts?.takeIf { it.isNotEmpty() }?.let { conflicts -> item {
                Column(dim, verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Text(r.conflictsHeading, style = MaterialTheme.typography.titleSmall)
                    conflicts.forEach { SelectionContainer { Text(it, fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.bodySmall) } }
                    r.movedAfterRepairNote?.let { Text(it, color = secondary, style = MaterialTheme.typography.bodySmall) }
                }
            } }
            // Board ⑥: the commits on origin that already carry this session's, before the branches.
            r.landedCommits?.takeIf { landed && it.isNotEmpty() }?.let { commits -> item {
                Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Row { Text("On origin/${r.targetBranch}", Modifier.weight(1f), style = MaterialTheme.typography.titleSmall)
                        Text("${commits.size} ${if (commits.size == 1) "commit" else "commits"}", color = secondary, style = MaterialTheme.typography.bodySmall) }
                    commits.forEach { CommitRow(it, null, merged = MergeRecovery.day(it.date)) }
                    r.landedNote?.let { Text(it, color = secondary, style = MaterialTheme.typography.bodySmall) }
                }
            } }
            item {
                Column(dim, verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    // One line, as the board and the bar's pill draw it: a long branch gives up its middle, never the target.
                    Row {
                        Text(branchLabel(d.string("branch") ?: "this session", secondary), Modifier.weight(1f, fill = false),
                            fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.bodyMedium, maxLines = 1, overflow = TextOverflow.MiddleEllipsis)
                        Text(" → ${r.targetBranch}", fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.bodyMedium, maxLines = 1)
                    }
                    r.targetRelation?.let { Text(it, color = secondary, style = MaterialTheme.typography.bodySmall) }
                    r.repairBranch?.let { Text("Repair branch $it", color = secondary, style = MaterialTheme.typography.bodySmall) }
                    if (landed) r.localNote?.let { Text(it, color = secondary, style = MaterialTheme.typography.bodySmall) }
                }
            }
            val candidate = if (r.candidateSha != null) r.patch else null
            val push = r.pushCommits
            if (!push.isNullOrEmpty()) item {
                var all by rememberSaveable { mutableStateOf(false) }
                val (shown, hidden) = r.inlinePushCommits()
                Column(dim, verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Row { Text("Pushes to origin/${r.targetBranch}", Modifier.weight(1f), style = MaterialTheme.typography.titleSmall)
                        Text("${push.size} ${if (push.size == 1) "commit" else "commits"}", color = secondary, style = MaterialTheme.typography.bodySmall) }
                    (if (all) push else shown).forEach { CommitRow(it, r.origin(it)) }
                    if (hidden > 0 && !all) TextButton(onClick = { all = true }) { Text("All ${push.size} commits · $hidden more from this session") }
                    Text(r.landingNote, color = secondary, style = MaterialTheme.typography.bodySmall)
                }
            // Nothing is pushed for a session already on origin: the local target's own commits are its note above.
            } else r.localCommits?.takeIf { !landed && it.isNotEmpty() }?.let { local -> item {
                Column(dim, verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Row { Text("Local-only commits — included in the push", Modifier.weight(1f), style = MaterialTheme.typography.titleSmall)
                        Text("${local.size}", color = secondary, style = MaterialTheme.typography.bodySmall) }
                    local.forEach { CommitRow(it, null) }
                }
            } }
            candidate?.let { patch -> item {
                val (lines, _) = remember(patch) { diffLines(patch, cap = 4_000) }
                Column(dim) { Fold("Complete candidate diff · against origin/${r.targetBranch}") { DiffLines(lines) } }
            } }
            r.check?.let { check -> item {
                Column(dim, verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Row { Text("Merge check", Modifier.weight(1f), style = MaterialTheme.typography.labelLarge)
                        Text(when (check.status) { "unconfigured" -> "Not configured"; "passed" -> "Passed"; else -> "Failed" },
                            color = if (check.status == "failed") MaterialTheme.colorScheme.error else secondary) }
                    check.output?.takeIf { it.isNotEmpty() }?.let { Fold("Check output") { Mono(it) } }
                    r.reviewNote?.let { Text(it, color = secondary, style = MaterialTheme.typography.bodySmall) }
                }
            } }
        }
        // The step the state asks for, pinned: the review is longer than a phone screen.
        if (buttons.primary != null || buttons.secondary.isNotEmpty() || !supported) {
            HorizontalDivider()
            Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 10.dp), horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(4.dp)) {
                buttons.primary?.let { step -> Button(onClick = { run(step) }, enabled = enabled(step), modifier = Modifier.fillMaxWidth()) {
                    if (step.action == "wait") { CircularProgressIndicator(Modifier.size(14.dp), strokeWidth = 1.5.dp); Spacer(Modifier.width(8.dp)) }
                    Text(title(step))
                } }
                buttons.secondary.forEach { step -> TextButton(onClick = { run(step) }, enabled = enabled(step)) { Text(title(step)) } }
                buttons.note?.let { Text(it, color = secondary, style = MaterialTheme.typography.bodySmall, textAlign = TextAlign.Center) }
                if (!supported) Text("Update the runner to use target synchronization recovery.", color = secondary,
                    style = MaterialTheme.typography.bodyMedium, textAlign = TextAlign.Center)
            }
        }
    } } }
}

/** The repair session's row, opening it: how it stands, its title, and the line the state adds — the check's verdict, its question, its error. */
@Composable
private fun RepairRowView(row: MergeRecovery.RepairRow, title: String, open: () -> Unit) {
    val colors = LocalOrbitColors.current
    val secondary = MaterialTheme.colorScheme.onSurfaceVariant
    val tint = when (row.state) {
        MergeRecovery.RepairState.READY -> colors.success
        MergeRecovery.RepairState.CONFLICTS, MergeRecovery.RepairState.NEEDS_REPLY -> colors.needsYou
        MergeRecovery.RepairState.FAILED -> MaterialTheme.colorScheme.error
        else -> secondary
    }
    Row(Modifier.fillMaxWidth().clickable(onClickLabel = "Opens the repair session", onClick = open),
        horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
        when (row.state) {
            MergeRecovery.RepairState.RUNNING, MergeRecovery.RepairState.CHECKING -> CircularProgressIndicator(Modifier.size(14.dp), strokeWidth = 1.5.dp)
            // No verdict of the repair's to show, so no sign either.
            MergeRecovery.RepairState.FINISHED -> Unit
            else -> Icon(painterResource(when (row.state) {
                MergeRecovery.RepairState.CONFLICTS -> R.drawable.ic_warning
                MergeRecovery.RepairState.NEEDS_REPLY -> R.drawable.ic_suggestion
                MergeRecovery.RepairState.FAILED -> R.drawable.ic_x_circle
                else -> R.drawable.ic_check_circle
            }), null, Modifier.size(18.dp), tint = if (row.state == MergeRecovery.RepairState.COMPLETED) colors.success else tint)
        }
        Column(Modifier.weight(1f)) {
            Text(row.headline, style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.SemiBold)
            Text(title, color = secondary, style = MaterialTheme.typography.bodySmall, maxLines = 1)
            row.line?.let { Text(it, color = tint, style = MaterialTheme.typography.bodySmall, maxLines = 2, overflow = TextOverflow.Ellipsis) }
        }
        Text("›", color = secondary)
    }
}

/** One commit: its subject, then where it comes from, who, when and which — or, for one already on origin, the day it [merged]. */
@Composable
private fun CommitRow(commit: MergeRecovery.Commit, origin: MergeRecovery.Origin?, merged: String? = null) {
    val secondary = MaterialTheme.colorScheme.onSurfaceVariant
    Column {
        Text(commit.subject, style = MaterialTheme.typography.bodyMedium, maxLines = 2, overflow = TextOverflow.Ellipsis)
        Text(buildAnnotatedString {
            origin?.let { withStyle(SpanStyle(color = if (it == MergeRecovery.Origin.SESSION) secondary else LocalOrbitColors.current.needsYou,
                fontWeight = FontWeight.SemiBold)) { append(it.label + " · ") } }
            append(if (merged != null) "Merged $merged · ${commit.author} · " else "${commit.author} · ${TaskTime.relative(commit.date) ?: commit.date} · ")
            withStyle(SpanStyle(fontFamily = FontFamily.Monospace)) { append(commit.sha.take(8)) }
        }, color = secondary, style = MaterialTheme.typography.bodySmall)
    }
}

@Composable
private fun Fold(title: String, body: @Composable () -> Unit) {
    var open by rememberSaveable(title) { mutableStateOf(false) }
    TextButton(onClick = { open = !open }) { Text((if (open) "▾ " else "▸ ") + title) }
    if (open) body()
}

@Composable
private fun Mono(text: String) = SelectionContainer {
    Text(text, Modifier.horizontalScroll(rememberScrollState()), fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.bodySmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant, softWrap = false)
}

@Composable
private fun DiffLines(lines: List<String>) {
    val semantic = LocalOrbitColors.current
    val error = MaterialTheme.colorScheme.error
    val secondary = MaterialTheme.colorScheme.onSurfaceVariant
    SelectionContainer { Text(buildAnnotatedString {
        lines.forEachIndexed { i, line ->
            if (i > 0) append("\n")
            withStyle(SpanStyle(color = when { line.startsWith("@@") -> secondary; line.startsWith("+") -> semantic.success
                line.startsWith("-") -> error; else -> Color.Unspecified })) { append(line) }
        }
    }, Modifier.horizontalScroll(rememberScrollState()), fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.bodySmall, softWrap = false) }
}
