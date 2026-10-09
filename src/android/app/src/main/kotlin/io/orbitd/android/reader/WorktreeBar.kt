package io.orbitd.android.reader

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.Layout
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.*
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import io.orbitd.android.ui.LocalOrbitColors
import kotlinx.coroutines.delay
import kotlinx.serialization.json.*

private fun JsonObject.strings(key: String) = (get(key) as? JsonArray).orEmpty().mapNotNull { (it as? JsonPrimitive)?.contentOrNull }
private fun JsonObject.flag(key: String) = (get(key) as? JsonPrimitive)?.takeIf { !it.isString }?.booleanOrNull

/**
 * The worktree bar above the composer (iOS `WorktreeBar`, web's `SessionOutputs`): the branch this session's
 * work lives on — a coordinator's project integration line (A06-8) — with its `+/−` summary opening the
 * changed files, and the git-state-driven action on the right: Commit while the tree is dirty, Merge once
 * it is clean, then the runner's answer (Merging…, ✓ Merged, ✓ In main, Resolve in session, Retry merge).
 * A session whose directory is not a git repository gets the amber "not isolated" nudge instead.
 */
@Composable
internal fun WorktreeBar(model: WorktreeModel, open: (String) -> Unit) {
    val state by model.state.collectAsState()
    val d = state.detail ?: return
    val files = ChangedFile.of(d)
    val recovery = (d["mergeRecovery"] as? JsonObject)?.let { MergeRecovery.of(it) }
    when (WorktreeBarLogic.mode(d.string("isolationStatus"), d.string("branch"), files.size, d.string("mergeStatus"), d.string("commitStatus"), recovery != null)) {
        WorktreeBarLogic.Mode.HIDDEN -> Unit
        WorktreeBarLogic.Mode.NOT_ISOLATED -> Text("⚠ Shared workDir — not isolated", Modifier.fillMaxWidth().padding(bottom = 6.dp)
            .clip(RoundedCornerShape(8.dp)).background(LocalOrbitColors.current.needsYou.copy(alpha = 0.12f))
            .border(1.dp, LocalOrbitColors.current.needsYou.copy(alpha = 0.4f), RoundedCornerShape(8.dp)).padding(horizontal = 10.dp, vertical = 8.dp),
            color = LocalOrbitColors.current.needsYou, style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.SemiBold)
        WorktreeBarLogic.Mode.WORKTREE -> Pill(model, state, d, d.string("branch")!!, files, recovery, open)
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun Pill(model: WorktreeModel, state: WorktreeState, d: JsonObject, branch: String, files: List<ChangedFile>,
    recovery: MergeRecovery?, open: (String) -> Unit) {
    val clipboard = LocalClipboardManager.current
    var sheet by rememberSaveable { mutableStateOf<String?>(null) }
    var menu by remember { mutableStateOf(false) }
    var copied by remember { mutableStateOf(false) }
    LaunchedEffect(copied) { if (copied) { delay(1_500); copied = false } }
    val displayBranch = WorktreeBarLogic.displayBranch(d, branch)
    val runStatus = d.string("runStatus") ?: d.string("status")
    val committed = runStatus !in setOf("RUNNING", "AWAITING_INPUT", "INTERRUPTED")
    // The session's authoritative run status gates Commit and Merge: a clean mid-turn tree is a checkpoint, not finished work.
    val turnActive = runStatus == "RUNNING"
    val primary = WorktreeBarLogic.primary(d.flag("worktreeDirty"), committed, turnActive)
    val add = files.sumOf { maxOf(0, it.additions) }
    val del = files.sumOf { maxOf(0, it.deletions) }
    val commitFailure = WorktreeBarLogic.commitFailure(d.string("commitStatus"), d.string("commitError"), d.string("commitResultMessage"))
    val failure = if (commitFailure != null) null else WorktreeBarLogic.failureMessage(d.string("mergeStatus"), d.string("mergeError"),
        d.string("commitStatus"), d.string("commitError"))
    val manual = if (failure != null && d.string("commitStatus") != "error") WorktreeBarLogic.manualMergeCommand(d.string("mergeTarget"), branch) else null
    val shape = RoundedCornerShape(8.dp)
    Column(Modifier.fillMaxWidth().padding(bottom = 6.dp).clip(shape).background(MaterialTheme.colorScheme.onSurface.copy(alpha = 0.04f))
        .border(1.dp, MaterialTheme.colorScheme.onSurface.copy(alpha = 0.1f), shape).testTag("worktree-bar")) {
        Column(Modifier.padding(horizontal = 10.dp, vertical = 3.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Row(Modifier.heightIn(min = 24.dp), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                // The branch and its summary open the diff; copying is the long press, so a tap never copies by surprise.
                Box(Modifier.weight(1f)) {
                    BranchSummary(Modifier.combinedClickable(enabled = true, onClickLabel = if (files.isNotEmpty()) "View diff" else null,
                        onLongClickLabel = "Copy branch name", onLongClick = { menu = true },
                        onClick = { if (files.isNotEmpty()) sheet = "diff" else menu = true })) {
                        BranchPill(displayBranch, copied)
                        Text(statText(add, del, files.size, primary == WorktreeBarLogic.Primary.MERGE), fontFamily = FontFamily.Monospace,
                            style = MaterialTheme.typography.bodySmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                    DropdownMenu(menu, { menu = false }) {
                        DropdownMenuItem(text = { Text("Copy branch name") }, onClick = {
                            clipboard.setText(AnnotatedString(displayBranch)); copied = true; menu = false })
                    }
                }
                when (primary) {
                    WorktreeBarLogic.Primary.COMMIT -> CommitControl(model, state, d, turnActive)
                    WorktreeBarLogic.Primary.MERGE -> MergeControl(model, state, d, branch, recovery)
                    WorktreeBarLogic.Primary.NONE -> Unit
                }
            }
            if (commitFailure != null) key(d.string("commitError")) { CommitFailureView(model, state, commitFailure, branch) }
            else if (recovery == null && failure != null) FailureLine(failure, manual)
        }
        // A merge held for target recovery: what holds it, one line, and the review behind it.
        if (commitFailure == null && recovery != null) {
            HorizontalDivider()
            MergeRecoveryRow(recovery, working = d.string("mergeStatus") == "pending") { sheet = "recovery" }
        }
    }
    when (sheet) {
        "diff" -> WorktreeChanges(model, displayBranch) { sheet = null }
        // Once the recovery is gone — merged, or cleared — its review closes itself.
        "recovery" -> if (recovery != null) MergeRecoveryReview(model, d, recovery, open) { sheet = null } else LaunchedEffect(Unit) { sheet = null }
    }
}

/**
 * The branch and its summary share the row as iOS's HStack shares it: the shorter is offered half and takes what
 * it needs, the other gets the rest, so on a phone both truncate rather than the branch leaving the summary none.
 */
@Composable
private fun BranchSummary(modifier: Modifier, content: @Composable () -> Unit) = Layout(content, modifier) { measurables, constraints ->
    val (branch, summary) = measurables
    val gap = 8.dp.roundToPx()
    val room = (constraints.maxWidth - gap).coerceAtLeast(0)
    val branchFirst = branch.maxIntrinsicWidth(constraints.maxHeight) <= summary.maxIntrinsicWidth(constraints.maxHeight)
    val loose = constraints.copy(minWidth = 0)
    val first = (if (branchFirst) branch else summary).measure(loose.copy(maxWidth = room / 2))
    val second = (if (branchFirst) summary else branch).measure(loose.copy(maxWidth = room - first.width))
    val (left, right) = if (branchFirst) first to second else second to first
    val height = maxOf(left.height, right.height)
    layout(left.width + gap + right.width, height) {
        left.place(0, (height - left.height) / 2)
        right.place(left.width + gap, (height - right.height) / 2)
    }
}

@Composable
private fun BranchPill(branch: String, copied: Boolean) {
    val secondary = MaterialTheme.colorScheme.onSurfaceVariant
    Row(Modifier.clip(RoundedCornerShape(6.dp)).background(MaterialTheme.colorScheme.onSurface.copy(alpha = 0.05f))
        .border(1.dp, MaterialTheme.colorScheme.onSurface.copy(alpha = 0.1f), RoundedCornerShape(6.dp)).padding(horizontal = 6.dp, vertical = 2.dp),
        horizontalArrangement = Arrangement.spacedBy(4.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(if (copied) "✓" else "⎇", color = if (copied) LocalOrbitColors.current.success else secondary, style = MaterialTheme.typography.bodySmall,
            modifier = Modifier.clearAndSetSemantics { })
        Text(branchLabel(branch, secondary), fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.bodySmall,
            maxLines = 1, overflow = TextOverflow.MiddleEllipsis, modifier = Modifier.widthIn(max = 220.dp))
    }
}

/** `orbit/<slug>-<hash>` with the prefix and hash dimmed, so the slug reads first (web's `BranchLabel`). */
internal fun branchLabel(branch: String, dim: Color): AnnotatedString = buildAnnotatedString {
    val parts = WorktreeBarLogic.branchParts(branch)
    if (parts == null) append(branch) else {
        withStyle(SpanStyle(color = dim)) { append(parts.first) }
        append(parts.second)
        withStyle(SpanStyle(color = dim)) { append(parts.third) }
    }
}

@Composable
private fun statText(add: Int, del: Int, count: Int, committed: Boolean): AnnotatedString {
    val semantic = LocalOrbitColors.current
    val error = MaterialTheme.colorScheme.error
    val secondary = MaterialTheme.colorScheme.onSurfaceVariant
    return buildAnnotatedString {
        withStyle(SpanStyle(color = semantic.success)) { append("+$add") }
        withStyle(SpanStyle(color = error)) { append(" −$del") }
        withStyle(SpanStyle(color = secondary)) { append(" · $count ${if (count == 1) "file" else "files"}${if (committed) " · committed" else ""}") }
    }
}

/** Commit while the live worktree is dirty: Committing… while pending, Retry commit after a failure; held while a turn runs. */
@Composable
private fun CommitControl(model: WorktreeModel, state: WorktreeState, d: JsonObject, turnActive: Boolean) {
    val status = d.string("commitStatus")
    val pending = status == "pending"
    PillButton(if (pending) "Committing…" else if (status == "error") "Retry commit" else "Commit",
        tint = if (status == "error") MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.primary,
        enabled = !pending && !turnActive && !state.busy) { model.commit() }
}

/** Merge to the target (iOS `WorktreeMergeControl`), its target re-pointable from the caret until the merge is pressed. */
@Composable
private fun MergeControl(model: WorktreeModel, state: WorktreeState, d: JsonObject, branch: String, recovery: MergeRecovery?) {
    val status = d.string("mergeStatus")
    val targets = d.strings("mergeTargets")
    var selected by rememberSaveable { mutableStateOf<String?>(null) }
    val defaultTarget = WorktreeBarLogic.mergeTarget(d)
    val picked = selected?.takeIf { it in targets }
    val worktreeBranch = d.string("worktreeBranch")
    val warning = LocalOrbitColors.current.needsYou
    val error = MaterialTheme.colorScheme.error
    when {
        // The agent ran `git checkout -b` in the worktree: Merge would act on the tracked branch, not the work.
        !worktreeBranch.isNullOrEmpty() && worktreeBranch != branch -> Row(horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalAlignment = Alignment.CenterVertically) {
            Text("⚠ On $worktreeBranch", color = warning, style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.SemiBold,
                maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.widthIn(max = 160.dp).semantics {
                    contentDescription = "This worktree is on \"$worktreeBranch\", which Orbit isn't tracking — the session tracks \"$branch\". Adopt it to merge and diff the work on this branch."
                })
            PillButton(if (state.busy) "Adopting…" else "Adopt", tint = warning, enabled = !state.busy) { model.adoptBranch() }
        }
        recovery != null && d.flag("mergeRecoverySupported") == true -> Unit
        status == "merged" -> {
            val target = d.string("mergeTarget")
            Chip("✓ Merged" + if (target != null && target != "main" && target != "master") " → $target" else "")
        }
        d.flag("branchMerged") == true && status == null ->
            Chip("✓ In ${d.string("mergeTarget") ?: if ("main" in targets) "main" else if ("master" in targets) "master" else "main"}")
        status == "pending" -> PillButton("Merging…", enabled = false) {}
        status == "conflict" -> {
            val onto = WorktreeBarLogic.conflictTarget(d.string("mergeTarget"), targets, (d["agent"] as? JsonObject)?.string("defaultMergeTarget"))
            PillButton(if (state.busy) "Resuming…" else "Resolve in session", tint = error, enabled = !state.busy) { model.resolveInSession(branch, onto) }
        }
        status == "error" -> {
            val target = picked ?: d.string("mergeTarget") ?: defaultTarget
            MergeSplit("Retry merge to ${target ?: "main"}", error, state.busy, targets, target, { model.merge(target) }) { selected = it }
        }
        else -> {
            val target = picked ?: defaultTarget
            MergeSplit("Merge to ${target ?: "main"}", MaterialTheme.colorScheme.primary, state.busy, targets, target, { model.merge(target) }) { selected = it }
        }
    }
}

/** The merge button and its target caret as one capsule; past eight branches the caret opens a searchable list. */
@Composable
private fun MergeSplit(title: String, tint: Color, busy: Boolean, targets: List<String>, current: String?, merge: () -> Unit, pick: (String) -> Unit) {
    val c = if (busy) MaterialTheme.colorScheme.onSurfaceVariant else tint
    var menu by remember { mutableStateOf(false) }
    var search by remember { mutableStateOf(false) }
    Row(Modifier.clip(CircleShape).background(c.copy(alpha = if (busy) 0.08f else 0.14f)).border(1.dp, c.copy(alpha = 0.3f), CircleShape),
        verticalAlignment = Alignment.CenterVertically) {
        Text(title, Modifier.clickable(enabled = !busy, role = Role.Button) { merge() }
            .padding(start = 10.dp, end = if (targets.isEmpty()) 10.dp else 9.dp, top = 3.dp, bottom = 3.dp),
            color = c, style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.SemiBold, maxLines = 1)
        if (targets.isNotEmpty()) {
            Box(Modifier.width(1.dp).height(18.dp).background(c.copy(alpha = 0.3f)))
            Box {
                Text("⌄", Modifier.clickable(onClickLabel = "Choose a branch to merge into") { if (targets.size > 8) search = true else menu = true }
                    .semantics { contentDescription = "Choose a branch to merge into" }.padding(horizontal = 8.dp, vertical = 4.dp),
                    color = c, fontWeight = FontWeight.SemiBold)
                DropdownMenu(menu, { menu = false }) {
                    targets.forEach { b -> DropdownMenuItem(text = { Text(b) }, leadingIcon = { Text(if (b == current) "✓" else " ") },
                        onClick = { menu = false; pick(b) }) }
                }
            }
        }
    }
    if (search) MergeTargetPicker(targets, current, { search = false }) { search = false; pick(it) }
}

/** A searchable list of branches to merge into, for a repository with many (web's merge-target search). */
@Composable
private fun MergeTargetPicker(targets: List<String>, current: String?, close: () -> Unit, pick: (String) -> Unit) {
    var query by rememberSaveable { mutableStateOf("") }
    val filtered = query.trim().lowercase().let { q -> if (q.isEmpty()) targets else targets.filter { it.lowercase().contains(q) } }
    Dialog(close) { Surface(shape = RoundedCornerShape(16.dp)) { Column(Modifier.padding(16.dp).heightIn(max = 520.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("Merge into", Modifier.weight(1f), style = MaterialTheme.typography.titleMedium)
            TextButton(onClick = close) { Text("Cancel") }
        }
        OutlinedTextField(query, { query = it }, Modifier.fillMaxWidth(), placeholder = { Text("Search branches") }, singleLine = true)
        if (filtered.isEmpty()) Text("No results for \"$query\"", Modifier.padding(16.dp), color = MaterialTheme.colorScheme.onSurfaceVariant)
        LazyColumn { items(filtered, key = { it }) { b ->
            Row(Modifier.fillMaxWidth().clickable { pick(b) }.padding(vertical = 12.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(branchLabel(b, MaterialTheme.colorScheme.onSurfaceVariant), Modifier.weight(1f), fontFamily = FontFamily.Monospace,
                    maxLines = 1, overflow = TextOverflow.MiddleEllipsis)
                if (b == current) Text("✓", color = MaterialTheme.colorScheme.primary)
            }
        } }
    } } }
}

/** A failed commit: what happened, why and what to do, git's own words behind "Show git output" (web's `CommitFailure`). */
@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun CommitFailureView(model: WorktreeModel, state: WorktreeState, failure: WorktreeBarLogic.CommitFailure, branch: String) {
    val clipboard = LocalClipboardManager.current
    var showGit by rememberSaveable { mutableStateOf(false) }
    var menu by remember { mutableStateOf(false) }
    val error = MaterialTheme.colorScheme.error
    Box { Column(Modifier.combinedClickable(onClick = {}, onLongClick = { menu = true }, onLongClickLabel = "Copy failure reason"),
        verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text("⊗ ${failure.headline}", color = error, style = MaterialTheme.typography.bodySmall, fontWeight = FontWeight.SemiBold)
        SelectionContainer { Text(failure.why, color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodySmall) }
        Row(Modifier.padding(top = 2.dp), horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
            PillButton(if (state.busy) "Resuming…" else "Resolve in session", tint = error, enabled = !state.busy) { model.resolveCommitInSession(branch, failure.why) }
            if (failure.gitOutput != null) Text((if (showGit) "Hide git output ▾" else "Show git output ▸"), Modifier.clickable { showGit = !showGit }
                .semantics { stateDescription = if (showGit) "Shown" else "Hidden" }, color = MaterialTheme.colorScheme.onSurfaceVariant,
                style = MaterialTheme.typography.bodySmall)
        }
        if (showGit && failure.gitOutput != null) SelectionContainer {
            Text(failure.gitOutput, Modifier.fillMaxWidth().clip(RoundedCornerShape(6.dp)).background(MaterialTheme.colorScheme.onSurface.copy(alpha = 0.05f))
                .padding(horizontal = 8.dp, vertical = 6.dp), fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
    DropdownMenu(menu, { menu = false }) {
        DropdownMenuItem(text = { Text("Copy failure reason") }, onClick = { clipboard.setText(AnnotatedString(failure.why)); menu = false })
        failure.gitOutput?.let { output -> DropdownMenuItem(text = { Text("Copy git output") }, onClick = { clipboard.setText(AnnotatedString(output)); menu = false }) }
    } }
}

/** A failed merge's reason, with the copies a reader needs to take it elsewhere. */
@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun FailureLine(message: String, manual: String?) {
    val clipboard = LocalClipboardManager.current
    var menu by remember { mutableStateOf(false) }
    val error = MaterialTheme.colorScheme.error
    Box { Row(Modifier.combinedClickable(onClick = {}, onLongClick = { menu = true }, onLongClickLabel = "Copy failure reason")
        .semantics(mergeDescendants = true) { contentDescription = message }, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        Text("⚠", color = error, style = MaterialTheme.typography.bodySmall, fontWeight = FontWeight.SemiBold)
        Text(message, color = error, style = MaterialTheme.typography.bodySmall, maxLines = 6, overflow = TextOverflow.Ellipsis)
    }
    DropdownMenu(menu, { menu = false }) {
        DropdownMenuItem(text = { Text("Copy failure reason") }, onClick = { clipboard.setText(AnnotatedString(message)); menu = false })
        manual?.let { command -> DropdownMenuItem(text = { Text("Copy manual merge command") }, onClick = { clipboard.setText(AnnotatedString(command)); menu = false }) }
    } }
}

@Composable
internal fun PillButton(title: String, tint: Color = MaterialTheme.colorScheme.primary, enabled: Boolean = true, action: () -> Unit) {
    val c = if (enabled) tint else MaterialTheme.colorScheme.onSurfaceVariant
    Text(title, Modifier.clip(CircleShape).background(c.copy(alpha = if (enabled) 0.14f else 0.08f)).border(1.dp, c.copy(alpha = 0.3f), CircleShape)
        .clickable(enabled = enabled, role = Role.Button) { action() }.padding(horizontal = 10.dp, vertical = 3.dp),
        color = c, style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.SemiBold, maxLines = 1)
}

@Composable
private fun Chip(title: String) = Text(title, color = LocalOrbitColors.current.success, style = MaterialTheme.typography.labelLarge,
    fontWeight = FontWeight.SemiBold, maxLines = 1)

/** The changed files and each one's diff (iOS `DiffSheet`): a text file's patch, coloured, or a binary file's current bytes (A06-7). */
@Composable
private fun WorktreeChanges(model: WorktreeModel, branch: String, close: () -> Unit) {
    val state by model.state.collectAsState()
    val clipboard = LocalClipboardManager.current
    val files = ChangedFile.of(state.detail)
    var file by rememberSaveable { mutableStateOf<String?>(null) }
    var copied by remember { mutableStateOf(false) }
    LaunchedEffect(copied) { if (copied) { delay(1_500); copied = false } }
    val live = (state.detail?.string("runStatus") ?: state.detail?.string("status")) in setOf("RUNNING", "AWAITING_INPUT", "INTERRUPTED")
    // Re-read when a heartbeat changes the file summary while the sheet stays open.
    LaunchedEffect(files) { model.loadDiff(live) }
    Dialog({ if (file != null) file = null else close() }, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        Surface(Modifier.fillMaxSize().safeDrawingPadding()) { Column {
            val shown = files.firstOrNull { it.path == file }
            Row(Modifier.fillMaxWidth().padding(horizontal = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                if (shown != null) TextButton(onClick = { file = null }) { Text("‹ Worktree changes") }
                else TextButton(onClick = { clipboard.setText(AnnotatedString(branch)); copied = true }) { Text(if (copied) "✓ Copied" else "Copy branch") }
                Text(shown?.path?.substringAfterLast('/') ?: "Worktree changes", Modifier.weight(1f), style = MaterialTheme.typography.titleMedium,
                    maxLines = 1, overflow = TextOverflow.MiddleEllipsis)
                TextButton(onClick = close) { Text("Done") }
            }
            HorizontalDivider()
            if (shown == null) LazyColumn(Modifier.fillMaxSize().testTag("worktree-files")) {
                items(files, key = { it.path }) { f -> DiffFileRow(f) { file = f.path }; HorizontalDivider() }
            } else if (shown.binary) key(shown.path) { WorktreeFilePreview(model, shown) }
            else DiffFileView(state, shown)
        } }
    }
}

/** One changed file: git's status letter, the path with its directory dimmed, and `+/−` or "binary". */
@Composable
internal fun DiffFileRow(file: ChangedFile, open: () -> Unit) {
    val semantic = LocalOrbitColors.current
    val letter = file.status.take(1).uppercase()
    val color = when (letter) { "A" -> semantic.success; "D" -> MaterialTheme.colorScheme.error; "M" -> semantic.needsYou
        "R" -> semantic.running; else -> MaterialTheme.colorScheme.onSurfaceVariant }
    Row(Modifier.fillMaxWidth().clickable(onClick = open).padding(horizontal = 16.dp, vertical = 12.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(letter, Modifier.width(14.dp), color = color, fontFamily = FontFamily.Monospace, fontWeight = FontWeight.Bold, style = MaterialTheme.typography.bodySmall)
        val dir = file.path.substringBeforeLast('/', "")
        Text(buildAnnotatedString {
            if (dir.isNotEmpty()) withStyle(SpanStyle(color = MaterialTheme.colorScheme.onSurfaceVariant)) { append("$dir/") }
            append(file.path.substringAfterLast('/'))
        }, Modifier.weight(1f), fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.bodyMedium, maxLines = 1, overflow = TextOverflow.MiddleEllipsis)
        if (file.binary) Text("binary", color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodySmall)
        else Text(buildAnnotatedString {
            withStyle(SpanStyle(color = semantic.success)) { append("+${file.additions}") }
            withStyle(SpanStyle(color = MaterialTheme.colorScheme.error)) { append(" −${file.deletions}") }
        }, fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.bodySmall)
    }
}

/** One file's unified diff, coloured per line, git's file headers dropped, capped at 1,200 lines. */
@Composable
private fun DiffFileView(state: WorktreeState, file: ChangedFile) {
    val patch = state.diff.firstOrNull { it.string("path") == file.path }
    val text = patch?.string("patch")?.takeIf { it.isNotEmpty() }
    Column(Modifier.fillMaxSize().padding(12.dp)) {
        if (text != null) {
            val (lines, trimmed) = remember(text) { diffLines(text) }
            val semantic = LocalOrbitColors.current
            val error = MaterialTheme.colorScheme.error
            val secondary = MaterialTheme.colorScheme.onSurfaceVariant
            SelectionContainer { LazyColumn(Modifier.weight(1f, fill = false).testTag("worktree-diff")) {
                items(lines.chunked(32)) { chunk -> Text(buildAnnotatedString {
                    chunk.forEachIndexed { i, line ->
                        if (i > 0) append("\n")
                        withStyle(SpanStyle(color = when { line.startsWith("@@") -> secondary; line.startsWith("+") -> semantic.success
                            line.startsWith("-") -> error; else -> Color.Unspecified })) { append(line) }
                    }
                }, Modifier.horizontalScroll(rememberScrollState()), fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.bodySmall, softWrap = false) }
            } }
            if (trimmed) Text("(preview trimmed)", color = secondary, style = MaterialTheme.typography.bodySmall)
            else if (patch.string("truncated") == "true") Text("(diff truncated)", color = secondary, style = MaterialTheme.typography.bodySmall)
        } else Text(when {
            patch?.string("truncated") == "true" -> "Diff too large to preview"
            state.diffLoading -> "Loading diff…"
            state.diffRefreshing -> "Refreshing diff…"
            else -> "No diff to preview"
        }, Modifier.fillMaxWidth().padding(top = 40.dp), color = MaterialTheme.colorScheme.onSurfaceVariant,
            style = MaterialTheme.typography.labelLarge, textAlign = androidx.compose.ui.text.style.TextAlign.Center)
    }
}

/** A unified diff's lines without git's file-header noise (web's `parseUnifiedDiff`), and whether the cap cut it. */
internal fun diffLines(patch: String, cap: Int = 1_200): Pair<List<String>, Boolean> {
    val noise = listOf("diff --git", "index ", "--- ", "+++ ", "new file", "deleted file", "old mode", "new mode", "similarity ", "rename ", "\\")
    val lines = patch.split('\n').filterNot { line -> noise.any { line.startsWith(it) } }
    return lines.take(cap) to (lines.size > cap)
}
