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
import androidx.compose.ui.graphics.Color
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
 * closes itself once the recovery is gone.
 */
@Composable
internal fun MergeRecoveryReview(model: WorktreeModel, d: JsonObject, r: MergeRecovery, open: (String) -> Unit, close: () -> Unit) {
    val state by model.state.collectAsState()
    var pressed by remember { mutableStateOf<MergeRecovery.Button?>(null) }
    val supported = (d["mergeRecoverySupported"] as? JsonPrimitive)?.booleanOrNull == true
    val turnActive = (d.string("runStatus") ?: d.string("status")) == "RUNNING"
    val working = state.busy || d.string("mergeStatus") == "pending"
    val repair = d["mergeRepairSession"] as? JsonObject
    val repairState = repair?.let { it.string("runState") ?: it.string("runStatus") }
    val blocked = working || turnActive || repairState in setOf("QUEUED", "RUNNING")
    val buttons = r.buttons(supported)
    val secondary = MaterialTheme.colorScheme.onSurfaceVariant
    fun run(step: MergeRecovery.Button) {
        pressed = step
        if (step.action == "repair") model.repairRecovery(step.preparePR == true) { id -> close(); open("orbit-session:$id") }
        else model.recoverMerge(step.action, r.previewId, r.targetBranch)
    }
    fun title(step: MergeRecovery.Button) = if (working && pressed == step) "Working…" else step.title
    Dialog(close, properties = DialogProperties(usePlatformDefaultWidth = false)) { Surface(Modifier.fillMaxSize().safeDrawingPadding()) { Column {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
            TextButton(onClick = close, modifier = Modifier.semantics { contentDescription = "Close" }) { Text("✕") }
        }
        LazyColumn(Modifier.weight(1f).padding(horizontal = 16.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
            item {
                Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text(r.title, style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.SemiBold, modifier = Modifier.semantics { heading() })
                    if (working) Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                        CircularProgressIndicator(Modifier.size(12.dp), strokeWidth = 1.5.dp); Text("Working…", color = secondary)
                    } else if (r.checkedAt != null || buttons.headerCheck != null) Row(horizontalArrangement = Arrangement.spacedBy(4.dp), verticalAlignment = Alignment.CenterVertically) {
                        r.checkedAt?.let { Text("Checked ${TaskTime.relative(it) ?: it}", color = secondary, style = MaterialTheme.typography.bodyMedium)
                            if (buttons.headerCheck != null) Text("·", color = secondary) }
                        buttons.headerCheck?.let { check -> TextButton(enabled = !blocked, onClick = { run(check) }) { Text(check.title) } }
                    }
                    lede(r)?.let { Text(it, color = secondary, style = MaterialTheme.typography.bodyMedium) }
                }
            }
            if (repair != null) item {
                val running = repairState in setOf("QUEUED", "RUNNING")
                val failed = repairState == "FAILED"
                Row(Modifier.fillMaxWidth().clickable(onClickLabel = "Opens the repair session") { repair.string("id")?.let { open("orbit-session:$it") } },
                    horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
                    if (running) CircularProgressIndicator(Modifier.size(14.dp), strokeWidth = 1.5.dp)
                    else Text(if (failed) "✕" else "✓", color = if (failed) MaterialTheme.colorScheme.error else LocalOrbitColors.current.success)
                    Column(Modifier.weight(1f)) {
                        Text(if (running) "Repair session running" else if (failed) "Repair session failed" else "Repair session completed",
                            style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.SemiBold)
                        Text(repair.string("title") ?: "Resolve merge recovery for ${r.targetBranch}", color = secondary, style = MaterialTheme.typography.bodySmall, maxLines = 1)
                        if (running) Text("Tap to open the running session", color = secondary, style = MaterialTheme.typography.bodySmall)
                        else if (!failed) Text("Ready to check again", color = secondary, style = MaterialTheme.typography.bodySmall)
                    }
                    Text("›", color = secondary)
                }
            }
            d.string("mergeError")?.takeIf { !r.ready && it.isNotBlank() }?.let { message -> item { Fold("Details") { Mono(message) } } }
            r.conflicts?.takeIf { it.isNotEmpty() }?.let { conflicts -> item {
                Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Text("Conflicts", style = MaterialTheme.typography.titleSmall)
                    conflicts.forEach { SelectionContainer { Text(it, fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.bodySmall) } }
                }
            } }
            item {
                Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    Text(buildAnnotatedString {
                        append(branchLabel(d.string("branch") ?: "this session", secondary)); append(" → "); append(r.targetBranch)
                    }, fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.bodyMedium, maxLines = 2)
                    r.targetRelation?.let { Text(it, color = secondary, style = MaterialTheme.typography.bodySmall) }
                    r.repairBranch?.let { Text("Repair branch $it", color = secondary, style = MaterialTheme.typography.bodySmall) }
                }
            }
            val candidate = if (r.candidateSha != null) r.patch else null
            val push = r.pushCommits
            if (!push.isNullOrEmpty()) item {
                var all by rememberSaveable { mutableStateOf(false) }
                val (shown, hidden) = r.inlinePushCommits()
                Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Row { Text("Pushes to origin/${r.targetBranch}", Modifier.weight(1f), style = MaterialTheme.typography.titleSmall)
                        Text("${push.size} ${if (push.size == 1) "commit" else "commits"}", color = secondary, style = MaterialTheme.typography.bodySmall) }
                    (if (all) push else shown).forEach { CommitRow(it, r.origin(it)) }
                    if (hidden > 0 && !all) TextButton(onClick = { all = true }) { Text("All ${push.size} commits · $hidden more from this session") }
                    Text(r.landingNote, color = secondary, style = MaterialTheme.typography.bodySmall)
                }
            } else r.localCommits?.takeIf { it.isNotEmpty() }?.let { local -> item {
                Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Row { Text("Local-only commits — included in the push", Modifier.weight(1f), style = MaterialTheme.typography.titleSmall)
                        Text("${local.size}", color = secondary, style = MaterialTheme.typography.bodySmall) }
                    local.forEach { CommitRow(it, null) }
                }
            } }
            candidate?.let { patch -> item {
                val (lines, _) = remember(patch) { diffLines(patch, cap = 4_000) }
                Fold("Complete candidate diff · against origin/${r.targetBranch}") { DiffLines(lines) }
            } }
            r.check?.let { check -> item {
                Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
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
                buttons.primary?.let { step -> Button(onClick = { run(step) }, enabled = !blocked, modifier = Modifier.fillMaxWidth()) { Text(title(step)) } }
                buttons.secondary.forEach { step -> TextButton(onClick = { run(step) }, enabled = !blocked) { Text(title(step)) } }
                if (!supported) Text("Update the runner to use target synchronization recovery.", color = secondary,
                    style = MaterialTheme.typography.bodyMedium, textAlign = TextAlign.Center)
            }
        }
    } } }
}

private fun lede(r: MergeRecovery): String? {
    val t = r.targetBranch
    if (r.ready) return if (!r.pushCommits.isNullOrEmpty()) null else "Preserves both target histories." + if (r.addsMergeCommit == true) " Adds one merge commit." else ""
    return when (r.code) {
        "TARGET_DIVERGED" -> "Local $t and origin/$t each have unique commits."
        "TARGET_AHEAD" -> "Local $t has extra commits that are not on origin/$t. Review them before continuing this merge."
        "LOCAL_SYNC_PENDING" -> "The remote contains the reviewed candidate. Save blocking local edits before syncing; this action only updates this machine."
        else -> null
    }
}

/** One commit: its subject, then where it comes from, who, when and which. */
@Composable
private fun CommitRow(commit: MergeRecovery.Commit, origin: MergeRecovery.Origin?) {
    val secondary = MaterialTheme.colorScheme.onSurfaceVariant
    Column {
        Text(commit.subject, style = MaterialTheme.typography.bodyMedium, maxLines = 2, overflow = TextOverflow.Ellipsis)
        Text(buildAnnotatedString {
            origin?.let { withStyle(SpanStyle(color = if (it == MergeRecovery.Origin.SESSION) secondary else LocalOrbitColors.current.needsYou,
                fontWeight = FontWeight.SemiBold)) { append(it.label + " · ") } }
            append("${commit.author} · ${TaskTime.relative(commit.date) ?: commit.date} · ")
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
