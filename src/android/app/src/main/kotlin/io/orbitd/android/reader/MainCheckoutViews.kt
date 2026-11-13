@file:OptIn(androidx.compose.foundation.layout.ExperimentalLayoutApi::class)

package io.orbitd.android.reader

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLinkStyles
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withLink
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import io.orbitd.android.ui.LocalOrbitColors
import kotlinx.serialization.json.JsonObject
import java.time.Duration
import java.time.Instant

/** Whether the session reading the line works in its own worktree (default yes: a card is only written into one). */
private fun JsonObject?.isolated() = this?.string("isolationStatus")?.let { it == "worktree" } ?: true

@Composable
private fun statusColor(status: String): Color {
    val semantic = LocalOrbitColors.current
    return when (status.take(1).uppercase()) { "A" -> semantic.success; "D" -> MaterialTheme.colorScheme.error; else -> semantic.needsYou }
}

@Composable
private fun FileLine(file: MainCheckout.File, modifier: Modifier = Modifier, leading: (@Composable () -> Unit)? = null) {
    val semantic = LocalOrbitColors.current
    Row(modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
        leading?.invoke()
        Text(file.status.take(1).uppercase(), Modifier.width(12.dp), color = statusColor(file.status), fontFamily = FontFamily.Monospace,
            style = MaterialTheme.typography.bodySmall, fontWeight = FontWeight.Bold)
        Text(file.path, Modifier.weight(1f), fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.bodySmall,
            maxLines = 1, overflow = TextOverflow.MiddleEllipsis)
        if (file.binary) Text("binary", color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodySmall)
        else Text(buildAnnotatedString {
            if ((file.additions ?: 0) > 0 || (file.deletions ?: 0) == 0) withStyle(SpanStyle(color = semantic.success)) { append("+${file.additions ?: 0}") }
            if ((file.deletions ?: 0) > 0) withStyle(SpanStyle(color = MaterialTheme.colorScheme.error)) { append(" −${file.deletions}") }
        }, fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.bodySmall)
    }
}

/**
 * Board 01's card: the files that appeared in the main checkout during this turn, said as fact ("Orbit saw them appear"), with the one
 * recommended action (Move to this worktree), the review, and the rest under ⋯. Without the runner's capability it is the text alone.
 */
@Composable
internal fun MainCheckoutCard(notice: MainCheckout.ChangedNotice, key: String, seq: Long? = null, writtenAt: String? = null) {
    val model = LocalMainCheckout.current
    val console = LocalSessionConsole.current
    val detail = console?.detail
    val mc = model?.state?.collectAsState()?.value
    val actions = model != null && mc?.workspace != null && model.actionsSupported
    // Moved, saved or gone: the card stays as history, its buttons held and one muted line saying why.
    val results = LocalMainCheckoutResults.current
    val handled = MainCheckout.handled(notice, results.filter { seq == null || it.first > seq }.map { it.second },
        mc?.workspace?.get("repoHealth") as? JsonObject, MainCheckout.ageSeconds(writtenAt))
    val busy = mc?.busy == true || handled != null
    val isolated = detail.isolated()
    val sessionBranch = detail?.string("branch")
    val branch = notice.branch ?: "HEAD"
    var left by rememberSaveable(key) { mutableStateOf(false) }
    var menu by remember { mutableStateOf(false) }
    val amber = LocalOrbitColors.current.needsYou
    val secondary = MaterialTheme.colorScheme.onSurfaceVariant
    val shape = RoundedCornerShape(10.dp)
    Column(Modifier.fillMaxWidth().clip(shape).border(1.dp, MaterialTheme.colorScheme.onSurface.copy(alpha = 0.12f), shape)
        .testTag("main-checkout-card")) {
        Row(Modifier.padding(start = 12.dp, end = 12.dp, top = 12.dp), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            Text("!", Modifier.size(20.dp).clip(CircleShape).background(amber.copy(alpha = 0.14f)).border(1.dp, amber.copy(alpha = 0.5f), CircleShape)
                .wrapContentSize(Alignment.Center), color = amber, style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.Bold)
            Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(MainCheckout.cardTitle(notice.fileCount, notice.truncated), style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold)
                Text(buildAnnotatedString {
                    withStyle(SpanStyle(fontFamily = FontFamily.Monospace)) { append(notice.root) }
                    if (notice.branch != null) { append(" on "); withStyle(SpanStyle(fontFamily = FontFamily.Monospace)) { append(notice.branch) } }
                    append(MainCheckout.cardSubtitle(notice.root, notice.branch).removePrefix(if (notice.branch != null) "${notice.root} on ${notice.branch}" else notice.root))
                }, color = secondary, style = MaterialTheme.typography.bodySmall)
            }
        }
        Column(Modifier.padding(top = 10.dp).fillMaxWidth().background(MaterialTheme.colorScheme.onSurface.copy(alpha = 0.03f))
            .padding(horizontal = 12.dp, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            notice.files.take(MainCheckout.CARD_VISIBLE_FILES).forEach { f ->
                FileLine(f, Modifier.clickable(enabled = actions && handled == null, onClickLabel = MainCheckout.COPY_REVIEW_MAIN_CHECKOUT) {
                    model?.open(MainCheckoutState.Sheet.REVIEW)
                }.padding(start = 30.dp))
            }
            val hidden = notice.fileCount - minOf(notice.files.size, MainCheckout.CARD_VISIBLE_FILES)
            if (hidden > 0) Text(MainCheckout.moreFiles(hidden), Modifier.padding(start = 30.dp), color = secondary, style = MaterialTheme.typography.bodySmall)
            if (notice.truncated) Text(MainCheckout.truncatedNote(), Modifier.padding(start = 30.dp), color = secondary, style = MaterialTheme.typography.bodySmall)
        }
        if (actions && !left) Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(6.dp),
                itemVerticalAlignment = Alignment.CenterVertically) {
                if (isolated && model?.sessionId != null) Button(enabled = !busy, onClick = {
                    model.request({ MainCheckout.move(notice.root, notice.fingerprint, notice.files.map { it.path }, model.sessionId, it, model.sessionId) })
                }, contentPadding = PaddingValues(horizontal = 14.dp)) { Text(MainCheckout.COPY_MOVE_TO_THIS_WORKTREE) }
                OutlinedButton(enabled = handled == null, onClick = { model?.open(MainCheckoutState.Sheet.REVIEW) }, contentPadding = PaddingValues(horizontal = 14.dp)) {
                    Text(MainCheckout.reviewAndCommit(branch), maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
                Box {
                    TextButton(enabled = handled == null, onClick = { menu = true }, modifier = Modifier.semantics { contentDescription = "More actions" }) { Text("⋯", fontWeight = FontWeight.Bold) }
                    DropdownMenu(menu, { menu = false }) {
                        HintedItem(MainCheckout.COPY_SAVE_AND_CLEAN, MainCheckout.COPY_SAVE_AND_CLEAN_HINT, enabled = !busy) {
                            menu = false
                            model?.request({ MainCheckout.rescue(notice.root, notice.fingerprint, it, model.sessionId) })
                        }
                        HintedItem(MainCheckout.COPY_ASK_AGENT, MainCheckout.COPY_ASK_AGENT_HINT) {
                            menu = false
                            model?.prefill?.invoke(MainCheckout.askAboutPrompt(notice.root, notice.branch, notice.files.map { it.path }, isolated))
                        }
                        DropdownMenuItem(text = { Text(MainCheckout.COPY_LEAVE_AS_IS) }, onClick = { menu = false; left = true })
                    }
                }
            }
            if (handled != null) HandledLine(handled)
            else if (isolated && sessionBranch != null) Text(buildAnnotatedString {
                val hint = MainCheckout.moveHint(sessionBranch)
                append(hint.substringBefore(sessionBranch))
                withStyle(SpanStyle(fontFamily = FontFamily.Monospace)) { append(sessionBranch) }
                append(hint.substringAfter(sessionBranch))
            }, color = secondary, style = MaterialTheme.typography.bodySmall)
        } else if (handled != null) Box(Modifier.padding(12.dp)) { HandledLine(handled) }
        else Spacer(Modifier.height(10.dp))
    }
}

@Composable
private fun HandledLine(handled: MainCheckout.Handled) {
    Text(handled.line, Modifier.testTag("main-checkout-card-handled"), color = MaterialTheme.colorScheme.onSurfaceVariant,
        style = MaterialTheme.typography.bodySmall)
}

@Composable
private fun HintedItem(title: String, hint: String, enabled: Boolean = true, onClick: () -> Unit) {
    DropdownMenuItem(enabled = enabled, onClick = onClick, text = {
        Column(Modifier.widthIn(max = 300.dp).padding(vertical = 4.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(title)
            Text(hint, color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodySmall)
        }
    })
}

/** Board 03: one action's outcome, as a line in the conversation — ✓ for done, ! for refused or waiting — with its next step as a link. */
@Composable
internal fun MainCheckoutResultRow(result: MainCheckout.Result) {
    val model = LocalMainCheckout.current
    val console = LocalSessionConsole.current
    val detail = console?.detail
    val targets = model?.state?.collectAsState()?.value?.targets.orEmpty()
    val isolated = detail.isolated()
    val line = MainCheckout.resultLine(result, model?.sessionId, targets.firstOrNull { it.id == result.targetSessionId }?.title, isolated)
    val semantic = LocalOrbitColors.current
    val tint = if (line.tone == MainCheckout.Tone.OK) semantic.success else semantic.needsYou
    val primary = MaterialTheme.colorScheme.primary
    fun follow(action: String) {
        model ?: return
        when (action) {
            "view-changes" -> model.open(MainCheckoutState.Sheet.WORKTREE_CHANGES)
            "push" -> model.push()
            "open-in-new-session" -> model.workspaceId?.let { ws -> result.rescueBranch?.let { model.openDraft(ws, MainCheckout.rescuePrompt(it)) } }
            "review-again" -> model.open(MainCheckoutState.Sheet.REVIEW)
            "ask-agent-combine" -> model.prefill(MainCheckout.combinePrompt(result.paths, result.branch))
            "ask-agent-rebase-push" -> model.prefill(MainCheckout.rebasePushPrompt(result.root, result.branch, result.upstream))
            "clean-up-checkout" -> model.cleanUp()
            "cancel" -> model.cancel(result.requestId)
        }
    }
    Row(Modifier.fillMaxWidth().testTag("main-checkout-result"), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        Text(if (line.tone == MainCheckout.Tone.OK) "✓" else "!", Modifier.width(12.dp), color = tint, fontWeight = FontWeight.Bold,
            style = MaterialTheme.typography.bodyMedium)
        Text(buildAnnotatedString {
            withStyle(SpanStyle(fontWeight = FontWeight.SemiBold)) { append(line.lead) }
            append(line.text.removePrefix(line.lead))
            line.link?.let { link ->
                // A link the sentence itself names (MOVE_CONFLICT's "ask the agent to combine them") is that phrase; the rest follow it.
                append("  ")
                withLink(LinkAnnotation.Clickable(link.action, TextLinkStyles(SpanStyle(color = primary))) { follow(link.action) }) { append(link.label) }
            }
        }, Modifier.weight(1f), style = MaterialTheme.typography.bodyMedium)
    }
}

/**
 * Board 01⑤ / 02④: the main checkout's standing state above the composer, in Worktree and Shared sessions alike, from the workspace's
 * heartbeat counts — grey, never red; dirty is not broken. Review while files are uncommitted, Push once only commits are left.
 */
@Composable
internal fun MainCheckoutBar(model: MainCheckoutModel, workspaceId: String, isolated: Boolean) {
    val state by model.state.collectAsState()
    LaunchedEffect(model, workspaceId) { model.bind(workspaceId); model.poll() }
    val bar = MainCheckout.bar(model.repoHealth, model.actionsSupported) ?: return
    val amber = LocalOrbitColors.current.needsYou
    val secondary = MaterialTheme.colorScheme.onSurfaceVariant
    val shape = RoundedCornerShape(8.dp)
    Row(Modifier.fillMaxWidth().padding(bottom = 6.dp).clip(shape).background(MaterialTheme.colorScheme.onSurface.copy(alpha = 0.04f))
        .border(1.dp, MaterialTheme.colorScheme.onSurface.copy(alpha = 0.1f), shape).padding(horizontal = 10.dp, vertical = 5.dp)
        .testTag("main-checkout-bar"), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
        Box(Modifier.size(7.dp).clip(CircleShape).background(if (bar.fileCount > 0) amber else secondary.copy(alpha = 0.5f)))
        Text(MainCheckout.COPY_LABEL, style = MaterialTheme.typography.labelLarge, maxLines = 1)
        bar.branch?.let {
            Text(it, Modifier.clip(RoundedCornerShape(6.dp)).border(1.dp, MaterialTheme.colorScheme.onSurface.copy(alpha = 0.12f), RoundedCornerShape(6.dp))
                .padding(horizontal = 6.dp, vertical = 1.dp).widthIn(max = 120.dp), fontFamily = FontFamily.Monospace,
                style = MaterialTheme.typography.bodySmall, maxLines = 1, overflow = TextOverflow.MiddleEllipsis)
        }
        Text(bar.status, Modifier.weight(1f), color = secondary, style = MaterialTheme.typography.bodySmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
        when (bar.button) {
            MainCheckout.Button.REVIEW -> PillButton(MainCheckout.reviewLabel(isolated), enabled = !state.busy) { model.open(MainCheckoutState.Sheet.REVIEW) }
            MainCheckout.Button.PUSH -> PillButton(MainCheckout.pushLabel(bar.upstream ?: "origin/${bar.branch ?: "HEAD"}"), enabled = !state.busy) { model.push() }
            null -> Unit
        }
    }
}

/** The review sheet and the push warning, wherever the model is opened from: the card, the bar, a result line. */
@Composable
internal fun MainCheckoutSheets(model: MainCheckoutModel, isolated: Boolean, sessionBranch: String?, sessionTitle: String?) {
    val state by model.state.collectAsState()
    if (state.sheet == MainCheckoutState.Sheet.REVIEW) MainCheckoutReviewSheet(model, isolated, sessionBranch, sessionTitle) { model.open(null) }
    state.confirmPush?.let { project ->
        val upstream = state.view?.snapshot?.let { it.upstream ?: "origin/${it.branch ?: "HEAD"}" } ?: "origin"
        AlertDialog(onDismissRequest = model::dismissPush, title = { Text(MainCheckout.pushLabel(upstream) + "?") },
            text = { Text(MainCheckout.managedBranchWarning(project)) },
            confirmButton = { TextButton(onClick = { model.push(confirmed = true) }) { Text("Push") } },
            dismissButton = { TextButton(onClick = model::dismissPush) { Text("Cancel") } })
    }
}

private fun checkedAgo(checkedAt: String?, now: Long): String? {
    val at = runCatching { Instant.parse(checkedAt) }.getOrNull() ?: return null
    val s = Duration.between(at, Instant.ofEpochMilli(now)).seconds.coerceAtLeast(0)
    return "Checked " + when { s < 60 -> "${s}s ago"; s < 3600 -> "${s / 60} min ago"; else -> "${s / 3600} h ago" }
}

/**
 * Board 02 in Compose idiom: the session's diff drawer becomes a bottom sheet. Files to commit (all chosen to begin with), each one's
 * patch on a tap, the commit message, and the three ways out: Commit, Move to a worktree ▾ (worktree sessions), and ⋯ for Save & clean
 * and Ask the agent. A project's branch says the commit skips its landing check, and never blocks.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun MainCheckoutReviewSheet(model: MainCheckoutModel, isolated: Boolean, sessionBranch: String?, sessionTitle: String?, close: () -> Unit) {
    val state by model.state.collectAsState()
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    ModalBottomSheet(onDismissRequest = close, sheetState = sheetState, modifier = Modifier.testTag("main-checkout-sheet")) {
        MainCheckoutReview(model, state, isolated, sessionBranch, sessionTitle, close)
    }
}

@Composable
internal fun MainCheckoutReview(model: MainCheckoutModel, state: MainCheckoutState, isolated: Boolean, sessionBranch: String?, sessionTitle: String?,
    close: () -> Unit) {
    val view = state.view
    val snapshot = view?.snapshot
    val secondary = MaterialTheme.colorScheme.onSurfaceVariant
    val amber = LocalOrbitColors.current.needsYou
    var unchosen by remember(snapshot?.fingerprint) { mutableStateOf(emptySet<String>()) }
    var opened by remember(snapshot?.fingerprint) { mutableStateOf<String?>(null) }
    var message by rememberSaveable { mutableStateOf("") }
    var moveMenu by remember { mutableStateOf(false) }
    var more by remember { mutableStateOf(false) }
    val now = remember(state.view) { System.currentTimeMillis() }
    Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp).padding(bottom = 16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        // The header: what this is, where, on which commit, how much, and how fresh.
        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(4.dp),
            itemVerticalAlignment = Alignment.CenterVertically) {
            Text(MainCheckout.COPY_LABEL, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
            if (snapshot != null) {
                Chip(snapshot.root, mono = true)
                Chip(listOfNotNull(snapshot.branch, MainCheckout.shortSha(snapshot.head).ifEmpty { null }).joinToString(" · "), mono = false)
                if (snapshot.fileCount > 0) Chip(MainCheckout.uncommitted(snapshot.fileCount), tint = amber)
                checkedAgo(snapshot.checkedAt, now)?.let { Text(it, color = secondary, style = MaterialTheme.typography.bodySmall) }
            }
        }
        when {
            snapshot == null && state.viewLoading -> Text("Reading the main checkout…", color = secondary)
            snapshot == null -> Column {
                Text(state.viewError ?: "Couldn't read the main checkout.", color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
                TextButton(onClick = { model.open(MainCheckoutState.Sheet.REVIEW) }) { Text("Try again") }
            }
        }
        snapshot ?: return@Column
        val actions = view!!.actionsSupported
        val chosen = snapshot.files.map { it.path }.filter { it !in unchosen }
        val branch = snapshot.branch ?: "HEAD"
        view.managedBranch?.let { Text(MainCheckout.managedBranchWarning(it.projectTitle), color = amber, style = MaterialTheme.typography.bodySmall,
            modifier = Modifier.testTag("main-checkout-managed")) }
        if (snapshot.files.isNotEmpty()) Text(if (actions) MainCheckout.chooseFiles(chosen.size, snapshot.files.size) else MainCheckout.filesCount(snapshot.fileCount),
            color = secondary, style = MaterialTheme.typography.labelMedium)
        LazyColumn(Modifier.weight(1f, fill = false).heightIn(max = 420.dp)) {
            items(snapshot.files, key = { it.path }) { f ->
                Column {
                    FileLine(f, Modifier.clickable(onClickLabel = "Show diff") {
                        opened = if (opened == f.path) null else f.path
                        if (opened == f.path) model.loadDiff(f.path)
                    }.padding(vertical = 2.dp)) {
                        if (actions) Checkbox(f.path !in unchosen, { on -> unchosen = if (on) unchosen - f.path else unchosen + f.path },
                            Modifier.size(32.dp).semantics { contentDescription = "Commit ${f.path}" })
                    }
                    if (opened == f.path) MainCheckoutDiff(state.diffs[f.path], f.path in state.diffLoading)
                }
            }
        }
        if (snapshot.truncated) Text(MainCheckout.truncatedNote(), color = secondary, style = MaterialTheme.typography.bodySmall)
        Text(MainCheckout.COPY_NOT_SHOWN, color = secondary, style = MaterialTheme.typography.bodySmall)
        if (!actions) return@Column
        OutlinedTextField(message, { message = it }, Modifier.fillMaxWidth().testTag("main-checkout-message"),
            placeholder = { Text(MainCheckout.COPY_COMMIT_MESSAGE) }, minLines = 1, maxLines = 4)
        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(6.dp),
            itemVerticalAlignment = Alignment.CenterVertically) {
            Button(enabled = !state.busy && chosen.isNotEmpty() && message.isNotBlank() && snapshot.branch != null, onClick = {
                model.request({ MainCheckout.commit(snapshot.root, snapshot.fingerprint, chosen, message, it, model.sessionId) }) { message = ""; close() }
            }) { Text(MainCheckout.commitButton(chosen.size, branch)) }
            val targets = state.targets.ifEmpty {
                if (isolated && model.sessionId != null && sessionBranch != null) listOf(MoveTarget(model.sessionId, sessionTitle ?: "This session", sessionBranch, false))
                else emptyList()
            }
            if (targets.isNotEmpty()) Box {
                OutlinedButton(enabled = !state.busy && chosen.isNotEmpty(), onClick = { moveMenu = true }) { Text(MainCheckout.COPY_MOVE_TO_A_WORKTREE + " ▾") }
                DropdownMenu(moveMenu, { moveMenu = false }) {
                    targets.forEach { t ->
                        DropdownMenuItem(enabled = !t.busy, onClick = {
                            moveMenu = false
                            model.request({ MainCheckout.move(snapshot.root, snapshot.fingerprint, chosen, t.id, it, model.sessionId) }) { close() }
                        }, text = {
                            Column(Modifier.widthIn(max = 300.dp)) {
                                Text(buildAnnotatedString {
                                    append(t.title); append(" ")
                                    withStyle(SpanStyle(fontFamily = FontFamily.Monospace, color = secondary)) { append(t.branch) }
                                }, maxLines = 1, overflow = TextOverflow.Ellipsis)
                                when {
                                    t.busy -> Text(MainCheckout.COPY_TARGET_BUSY, color = secondary, style = MaterialTheme.typography.bodySmall)
                                    t.id == model.sessionId -> Text(MainCheckout.COPY_TARGET_OPENED_FROM, color = secondary, style = MaterialTheme.typography.bodySmall)
                                }
                            }
                        })
                    }
                }
            }
            Box {
                TextButton(onClick = { more = true }, Modifier.semantics { contentDescription = "More actions" }) { Text("⋯", fontWeight = FontWeight.Bold) }
                DropdownMenu(more, { more = false }) {
                    HintedItem(MainCheckout.COPY_SAVE_AND_CLEAN, MainCheckout.COPY_SAVE_AND_CLEAN_HINT, enabled = !state.busy) {
                        more = false
                        model.request({ MainCheckout.rescue(snapshot.root, snapshot.fingerprint, it, model.sessionId) }) { close() }
                    }
                    if (model.sessionId != null) HintedItem(MainCheckout.COPY_ASK_AGENT, MainCheckout.COPY_ASK_AGENT_HINT) {
                        more = false
                        model.prefill(MainCheckout.askAboutPrompt(snapshot.root, snapshot.branch, snapshot.files.map { it.path }, isolated))
                        close()
                    }
                }
            }
        }
    }
}

@Composable
private fun Chip(text: String, mono: Boolean = false, tint: Color? = null) {
    val c = tint ?: MaterialTheme.colorScheme.onSurfaceVariant
    Text(text, Modifier.clip(RoundedCornerShape(6.dp)).background(c.copy(alpha = 0.1f)).padding(horizontal = 6.dp, vertical = 2.dp),
        color = c, fontFamily = if (mono) FontFamily.Monospace else null, style = MaterialTheme.typography.bodySmall, maxLines = 1,
        overflow = TextOverflow.MiddleEllipsis)
}

@Composable
private fun MainCheckoutDiff(diff: JsonObject?, loading: Boolean) {
    val secondary = MaterialTheme.colorScheme.onSurfaceVariant
    val patch = diff?.string("patch")
    val box = Modifier.fillMaxWidth().padding(vertical = 4.dp).clip(RoundedCornerShape(6.dp))
        .background(MaterialTheme.colorScheme.onSurface.copy(alpha = 0.04f)).padding(8.dp)
    when {
        patch != null -> {
            val (lines, trimmed) = remember(patch) { diffLines(patch, cap = 400) }
            val semantic = LocalOrbitColors.current
            val error = MaterialTheme.colorScheme.error
            Column(box.testTag("main-checkout-diff")) {
                Text(buildAnnotatedString {
                    lines.forEachIndexed { i, l ->
                        if (i > 0) append("\n")
                        withStyle(SpanStyle(color = when { l.startsWith("@@") -> secondary; l.startsWith("+") -> semantic.success
                            l.startsWith("-") -> error; else -> Color.Unspecified })) { append(l) }
                    }
                }, Modifier.horizontalScroll(rememberScrollState()), fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.bodySmall,
                    softWrap = false)
                if (trimmed || diff.string("patchTruncated") == "true") Text("(diff truncated)", color = secondary, style = MaterialTheme.typography.bodySmall)
            }
        }
        loading -> Text("Loading diff…", box, color = secondary, style = MaterialTheme.typography.bodySmall)
        diff?.string("binary") == "true" -> Text("Binary file", box, color = secondary, style = MaterialTheme.typography.bodySmall)
        diff != null -> Text("No diff to preview", box, color = secondary, style = MaterialTheme.typography.bodySmall)
    }
}

/** Board 04: what switching worktree isolation means for the main checkout. It informs; the switch itself never touches a file. */
@Composable
internal fun WorktreeIsolationDialog(dialog: MainCheckout.IsolationDialog, review: (() -> Unit)?, cleanUp: (() -> Unit)?, confirm: () -> Unit,
    cancel: () -> Unit) {
    val off = dialog is MainCheckout.IsolationDialog.Off
    AlertDialog(onDismissRequest = cancel, modifier = Modifier.testTag("worktree-isolation-dialog"),
        title = { Text(if (off) MainCheckout.ISO_TURN_OFF_TITLE else MainCheckout.ISO_TURN_ON_TITLE) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                when (dialog) {
                    is MainCheckout.IsolationDialog.Dirty -> { Text(dialog.body); Text(MainCheckout.ISO_UNCHANGED) }
                    is MainCheckout.IsolationDialog.Stuck -> { Text(dialog.body); Text(MainCheckout.ISO_UNCHANGED) }
                    MainCheckout.IsolationDialog.Unseen -> { Text(MainCheckout.ISO_UNSEEN); Text(MainCheckout.ISO_UNCHANGED) }
                    is MainCheckout.IsolationDialog.Off -> Text(dialog.body)
                }
            }
        },
        confirmButton = { TextButton(onClick = confirm) { Text(if (off) MainCheckout.ISO_TURN_OFF else MainCheckout.ISO_TURN_ON) } },
        dismissButton = {
            Row {
                if (dialog is MainCheckout.IsolationDialog.Dirty && review != null) TextButton(onClick = review) { Text(MainCheckout.ISO_REVIEW_FILES) }
                if (dialog is MainCheckout.IsolationDialog.Stuck && cleanUp != null) TextButton(onClick = cleanUp) { Text(MainCheckout.ISO_CLEAN_UP_CHECKOUT) }
                TextButton(onClick = cancel) { Text(MainCheckout.ISO_CANCEL) }
            }
        })
}
