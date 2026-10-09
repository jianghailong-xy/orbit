package io.orbitd.android.wiki

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.orbitd.android.directory.LoadingMessage
import io.orbitd.android.navigation.OrbitRoute
import io.orbitd.android.toast.OrbitToasts
import kotlinx.coroutines.launch

/** Where a press on a run's page goes (iOS `WikiRunActions`). */
internal class WikiRunActions(
    val revert: () -> Unit = {},
    val openSession: (String) -> Unit = {},
    val openEntry: (String) -> Unit = {},
    val reject: (String, String) -> Unit = { _, _ -> },
)

/** One run — what a maintenance run, an import or a session's proposal applied at once — read by its own id, the
 * Revert confirm, and where a press goes (iOS `WikiRunView`). */
@Composable
internal fun WikiRunScreen(store: WikiStore, route: OrbitRoute, nav: WikiNav) {
    val changesetId = requireNotNull(route.id)
    val state by store.state.collectAsState()
    val scope = rememberCoroutineScope()
    var reverting by rememberSaveable { mutableStateOf(false) }
    var notice by rememberSaveable { mutableStateOf<String?>(null) }
    var noticeTitle by rememberSaveable { mutableStateOf(WikiCopy.runRevertFailed) }
    LaunchedEffect(changesetId) { store.loadRun(changesetId) }
    PageBar.Bind(route, title = "")
    val run = state.run(changesetId)
    Box(Modifier.fillMaxSize().testTag("wiki-run")) {
        when {
            run != null -> WikiRunPage(run, state.busy, WikiRunActions(
                revert = { reverting = true },
                openSession = nav::session,
                openEntry = nav::entry,
                reject = { id, reason ->
                    scope.launch {
                        val answer = store.reject(id, reason)
                        if (answer != null) { noticeTitle = WikiCopy.entryRejectFailed; notice = answer } else OrbitToasts.show(WikiModeCopy.rejected)
                    }
                }))
            // A run the server does not know: nothing to draw, and nothing said it cannot back.
            state.isMissingRun(changesetId) -> Unit
            else -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { LoadingMessage("Loading…") }
        }
    }
    if (reverting && run != null) AlertDialog(onDismissRequest = { reverting = false }, title = { Text(WikiModeCopy.revertTitle) },
        text = { Text(WikiModeLogic.revertBody(WikiModeLogic.runSummary(run)) + "\n" + WikiModeCopy.revertKeeps) },
        dismissButton = { TextButton(onClick = { reverting = false }, modifier = Modifier.testTag("wiki-run-revert-cancel")) { Text(WikiModeCopy.cancel) } },
        confirmButton = { TextButton(onClick = {
            reverting = false
            scope.launch {
                val answer = store.revert(run)
                if (answer != null) { noticeTitle = WikiCopy.runRevertFailed; notice = answer } else { OrbitToasts.show(WikiModeCopy.reverted); nav.back() }
            }
        }, modifier = Modifier.testTag("wiki-run-revert-confirm")) { Text(WikiModeCopy.revertRunConfirm, color = MaterialTheme.colorScheme.error) } })
    WikiRefusalAlert(noticeTitle, notice) { notice = null }
}

/** How many rows a group shows before `Show N more` — the web drawer's number. */
private const val SHOWN_PER_GROUP = 4

/** One run's page, drawn from its own read: the changeset, the entries its ops name, and the server's counts
 * (iOS `WikiRunPage`, the web's run drawer block for block). */
@Composable
internal fun WikiRunPage(run: WikiChangesetView, busy: Boolean, actions: WikiRunActions) {
    val summary = WikiModeLogic.runSummary(run)
    var expanded by rememberSaveable { mutableStateOf(listOf<String>()) }
    // The row whose Reject is asking for its reason.
    var rejecting by rememberSaveable { mutableStateOf<String?>(null) }
    LazyColumn(Modifier.fillMaxSize().testTag("wiki-run-list"), contentPadding = PaddingValues(bottom = 24.dp)) {
        item(key = "head") { RunHead(run, summary, busy, actions) }
        item(key = "counts") {
            WikiCard { Text(WikiModeLogic.runCounts(summary).joinToString("  ·  "), Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 12.dp)
                .testTag("wiki-run-counts"), style = WikiType.label, color = WikiPalette.secondary) }
        }
        fun LazyListScope.group(title: String, rows: List<WikiModeLogic.RunRow>) {
            if (rows.isEmpty()) return
            item(key = "group:$title") {
                Row(Modifier.padding(start = 32.dp, end = 32.dp, top = 18.dp, bottom = 4.dp).semantics { heading() }, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text(title, style = WikiType.label.copy(fontWeight = FontWeight.SemiBold), color = WikiPalette.secondary)
                    Text("${rows.size}", style = WikiType.label, color = WikiPalette.secondary)
                }
            }
            item(key = "rows:$title") {
                val open = title in expanded
                WikiCard {
                    (if (open) rows else rows.take(SHOWN_PER_GROUP)).forEachIndexed { i, row ->
                        if (i > 0) HorizontalDivider(Modifier.padding(start = 16.dp))
                        RunRowView(row, run.entries, open = { row.entryId?.let(actions.openEntry) }) { rejecting = row.entryId }
                    }
                    if (rows.size > SHOWN_PER_GROUP) {
                        HorizontalDivider(Modifier.padding(start = 16.dp))
                        TextButton(onClick = { expanded = if (open) expanded - title else expanded + title },
                            modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp).testTag("wiki-run-more:$title")) {
                            Text(if (open) WikiModeCopy.showLess else WikiModeCopy.showMore(rows.size - SHOWN_PER_GROUP), Modifier.fillMaxWidth())
                        }
                    }
                }
            }
        }
        group(WikiModeCopy.runAdded, summary.added)
        group(WikiModeCopy.runAmended, summary.amended)
        group(WikiModeCopy.runReinforced, summary.reinforced)
    }
    rejecting?.let { id ->
        AlertDialog(onDismissRequest = { rejecting = null }, title = { Text(WikiModeCopy.rejectOnRecord) },
            text = { Column {
                WikiCopy.rejectReasons.forEach { reason ->
                    TextButton(onClick = { rejecting = null; actions.reject(id, reason) },
                        modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp).testTag("wiki-run-reject:$reason")) {
                        Text(WikiCopy.rejectReasonLabel(reason), Modifier.fillMaxWidth())
                    }
                }
            } },
            confirmButton = {},
            dismissButton = { TextButton(onClick = { rejecting = null }) { Text(WikiModeCopy.cancel) } })
    }
}

/** The kicker, the count as the title, when — then Revert run… and Open session side by side. */
@Composable
private fun RunHead(run: WikiChangesetView, summary: WikiModeLogic.RunSummary, busy: Boolean, actions: WikiRunActions) {
    val changeset = run.changeset
    Column(Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(WikiModeCopy.runKicker(changeset.origin), style = WikiType.label.copy(fontWeight = FontWeight.SemiBold), color = WikiPalette.secondary)
        Text(WikiModeCopy.appliedChanges(summary.applied), Modifier.semantics { heading() }.testTag("wiki-run-title"),
            style = MaterialTheme.typography.headlineSmall.copy(fontWeight = FontWeight.Bold))
        changeset.createdAt?.let { Text(WikiModeLogic.runWhen(it), style = WikiType.label, color = WikiPalette.secondary) }
        Row(Modifier.fillMaxWidth().padding(top = 4.dp), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            OutlinedButton(onClick = actions.revert, enabled = !busy && summary.revertible,
                colors = ButtonDefaults.outlinedButtonColors(contentColor = MaterialTheme.colorScheme.error),
                modifier = Modifier.weight(1f).heightIn(min = 48.dp).testTag("wiki-run-revert")) { Text("↩ " + WikiModeCopy.revertRun) }
            changeset.sessionId?.let { session ->
                OutlinedButton(onClick = { actions.openSession(session) }, modifier = Modifier.weight(1f).heightIn(min = 48.dp)
                    .testTag("wiki-run-open-session")) { Text(WikiModeCopy.openSession) }
            }
        }
    }
}

/** An entry of the run: its title and one line, its mark; a swipe takes it back with a reason. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun RunRowView(row: WikiModeLogic.RunRow, entries: List<WikiEntry>, open: () -> Unit, reject: () -> Unit) {
    val entry = row.entryId?.let { id -> entries.firstOrNull { sameWikiId(it.id, id) } }
    val answerable = entry?.let { WikiModeLogic.answerable(it.status, it.trust) } ?: false
    val content = @Composable {
        // TalkBack reaches the swipe's Reject as a custom action, as VoiceOver reaches iOS's swipe actions.
        Box(Modifier.semantics { if (answerable) customActions = listOf(CustomAccessibilityAction(WikiCopy.reject) { reject(); true }) }) {
            WikiRowButton("wiki-run-row:${row.op.id}", enabled = row.entryId != null, onClick = open) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                        Text(row.title, style = WikiType.prose, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        if (row.summary.isNotEmpty()) Text(row.summary, style = WikiType.subtext, color = WikiPalette.secondary, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                    row.trust?.takeIf { WikiCopy.trustLabel(it).isNotEmpty() }?.let { WikiBadge(WikiCopy.trustLabel(it), WikiLogic.trustTone(it)) }
                }
            }
        }
    }
    if (!answerable) { content(); return }
    // iOS's trailing swipe: the row snaps back and asks for the reason.
    val state = rememberSwipeToDismissBoxState()
    LaunchedEffect(state.currentValue) {
        if (state.currentValue == SwipeToDismissBoxValue.EndToStart) { reject(); state.reset() }
    }
    SwipeToDismissBox(state, enableDismissFromStartToEnd = false, backgroundContent = {
        Box(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.error), contentAlignment = Alignment.CenterEnd) {
            Text(WikiCopy.reject, Modifier.padding(horizontal = 20.dp), color = Color.White, style = WikiType.subtext.copy(fontWeight = FontWeight.SemiBold))
        }
    }) { Box(Modifier.background(MaterialTheme.colorScheme.surfaceVariant)) { content() } }
}
