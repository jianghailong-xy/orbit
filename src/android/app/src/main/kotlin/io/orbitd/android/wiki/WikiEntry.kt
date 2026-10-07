package io.orbitd.android.wiki

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.*
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import io.orbitd.android.R
import io.orbitd.android.directory.DirectoryData
import io.orbitd.android.directory.LoadingMessage
import io.orbitd.android.directory.StatusMessage
import io.orbitd.android.navigation.ObjectId
import io.orbitd.android.navigation.OrbitRoute
import kotlinx.coroutines.launch
import java.time.Instant

/** One entry's page, and the three forms its actions open (iOS `WikiEntryView` over `WikiEntryPage`). */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun WikiEntryScreen(store: WikiStore, route: OrbitRoute, data: DirectoryData, nav: WikiNav) {
    val entryId = requireNotNull(route.id)
    val state by store.state.collectAsState()
    val scope = rememberCoroutineScope()
    val now = rememberMinuteClock()
    val clipboard = LocalClipboardManager.current
    var form by rememberSaveable { mutableStateOf<String?>(null) }
    var retiring by rememberSaveable { mutableStateOf(false) }
    var reason by rememberSaveable { mutableStateOf("") }
    var notice by rememberSaveable { mutableStateOf<String?>(null) }
    var menu by remember { mutableStateOf(false) }
    var refreshing by remember { mutableStateOf(false) }
    LaunchedEffect(entryId) { store.loadEntry(entryId) }
    DisposableEffect(entryId) { store.entryAppeared(entryId); onDispose { store.entryDisappeared(entryId) } }
    val detail = state.detail(entryId)
    // The cards this page names are asked for whenever what it names changes — on the first read and after every re-read.
    LaunchedEffect(detail) { detail?.let { store.noteLinkCards(wikiEntryCardRefs(it)) } }
    fun finish(answer: String?, done: String) { if (answer != null) notice = answer else WikiToast.show(done) }
    PageBar.Bind(route, title = "", actions = if (detail == null) null else ({
        TextButton(onClick = { form = "edit" }, enabled = !state.busy, modifier = Modifier.testTag("wiki-entry-edit")) { Text(WikiCopy.edit) }
        Box {
            IconButton(onClick = { menu = true }, enabled = !state.busy, modifier = Modifier.testTag("wiki-entry-more")) {
                Icon(painterResource(R.drawable.ic_more), "More actions")
            }
            DropdownMenu(menu, { menu = false }) {
                DropdownMenuItem(text = { Text(WikiCopy.supersede) }, modifier = Modifier.testTag("wiki-entry-supersede"),
                    onClick = { menu = false; form = "supersede" })
                DropdownMenuItem(text = { Text(WikiCopy.retire, color = MaterialTheme.colorScheme.error) }, modifier = Modifier.testTag("wiki-entry-retire"),
                    onClick = { menu = false; retiring = true })
                HorizontalDivider()
                DropdownMenuItem(text = { Text(WikiCopy.copyLink) }, modifier = Modifier.testTag("wiki-entry-copy-link"), onClick = {
                    menu = false
                    // The entry's page on the web — `/wiki/<space>/e/<id>` — the drawer's own Copy link.
                    val slug = state.spaces.firstOrNull { sameWikiId(it.id, detail.entry.spaceId) }?.slug ?: state.currentSpace?.slug
                    if (!slug.isNullOrEmpty()) {
                        clipboard.setText(AnnotatedString("${nav.server.trimEnd('/')}/wiki/$slug/e/${wikiPublicId(detail.entry.id)}"))
                        WikiToast.show(WikiCopy.linkCopied)
                    }
                })
            }
        }
    }))
    PullToRefreshBox(isRefreshing = refreshing, onRefresh = {
        scope.launch { refreshing = true; try { store.loadEntry(entryId) } finally { refreshing = false } }
    }, modifier = Modifier.fillMaxSize().testTag("wiki-entry")) {
        when {
            detail != null -> WikiEntryPage(detail, now, state.busy, sessionTitle = { id ->
                state.linkTitle("session", id) ?: data.sessions.values.flatten().firstOrNull { ObjectId.same(it.id, id) }?.name
            }, sourceTitle = { source -> wikiSourceCard(source)?.let { (kind, id) -> state.linkTitle(kind, id) } },
                openSession = nav::session, openTask = nav::task,
                confirm = { scope.launch { finish(store.confirm(detail.entry), WikiModeCopy.confirmed) } },
                reject = { why -> scope.launch { finish(store.reject(detail.entry.id, why), WikiModeCopy.rejected) } })
            state.isMissing(entryId) -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { StatusMessage(WikiCopy.noEntrySelected, "") }
            state.loadFailed(entryId) -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                StatusMessage("The entry couldn't be loaded", "Check the connection, then try again.") { scope.launch { store.loadEntry(entryId) } }
            }
            else -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { LoadingMessage("Loading…") }
        }
    }
    val shown = detail?.entry
    if (form != null && shown != null) WikiEntryForm(form == "edit", shown, close = { form = null }) { title, summary ->
        val edit = form == "edit"
        val answer = if (edit) store.edit(shown, title, summary) else store.supersede(shown, title, summary)
        finish(answer, if (edit) WikiCopy.saved else WikiCopy.superseded)
        answer == null
    }
    if (retiring) AlertDialog(onDismissRequest = { retiring = false; reason = "" }, title = { Text(WikiCopy.retire) },
        text = { Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Text(WikiCopy.retireNote)
            OutlinedTextField(reason, { reason = it }, Modifier.fillMaxWidth().testTag("wiki-retire-reason"), placeholder = { Text(WikiCopy.reasonPlaceholder) })
        } },
        confirmButton = { TextButton(enabled = reason.isNotBlank(), modifier = Modifier.testTag("wiki-retire-confirm"), onClick = {
            val why = reason.trim(); reason = ""; retiring = false
            val entry = state.detail(entryId)?.entry
            // A retirement says why, as the web's does: no reason, no Retire.
            if (entry != null && why.isNotEmpty()) scope.launch { finish(store.retire(entry, why), WikiCopy.retired) }
        }) { Text(WikiCopy.retireConfirm, color = if (reason.isNotBlank()) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurface.copy(alpha = 0.38f)) } },
        dismissButton = { TextButton(onClick = { retiring = false; reason = "" }) { Text("Cancel") } })
    WikiRefusalAlert(notice) { notice = null }
}

/** Edit or Supersede: the title and the one-line summary, and what the write does. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun WikiEntryForm(edit: Boolean, entry: WikiEntry, close: () -> Unit, submit: suspend (String, String) -> Boolean) {
    var title by rememberSaveable(edit, entry.id) { mutableStateOf(entry.title ?: "") }
    var summary by rememberSaveable(edit, entry.id) { mutableStateOf(entry.summary ?: "") }
    var saving by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    val blank = title.isBlank() || summary.isBlank()
    ModalBottomSheet(onDismissRequest = close, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        modifier = Modifier.testTag("wiki-entry-form")) {
        SheetBar(if (edit) WikiCopy.edit else WikiCopy.supersede, "Cancel", if (edit) WikiCopy.save else WikiCopy.supersedeConfirm,
            confirmEnabled = !blank && !saving, confirmTag = "wiki-entry-form-save", cancel = close) {
            saving = true
            val newTitle = title.trim(); val newSummary = summary.trim()
            scope.launch { val landed = submit(newTitle, newSummary); saving = false; if (landed) close() }
        }
        Column(Modifier.padding(16.dp).imePadding(), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            OutlinedTextField(title, { title = it }, Modifier.fillMaxWidth().testTag("wiki-entry-form-title"), placeholder = { Text(WikiCopy.titlePlaceholder) }, singleLine = true)
            OutlinedTextField(summary, { summary = it }, Modifier.fillMaxWidth().testTag("wiki-entry-form-summary"), placeholder = { Text(WikiCopy.summaryPlaceholder) },
                minLines = 2, maxLines = 5)
            Text(if (edit) WikiCopy.editNote else WikiCopy.supersedeNote, style = WikiType.label, color = WikiPalette.secondary)
            Spacer(Modifier.height(16.dp))
        }
    }
}

/** A sheet's own bar: Cancel, the title, and the confirming action (iOS's sheet navigation bar). */
@Composable
internal fun SheetBar(title: String, cancelLabel: String, confirmLabel: String?, confirmEnabled: Boolean, confirmTag: String,
    cancel: () -> Unit, confirm: () -> Unit) {
    Row(Modifier.fillMaxWidth().padding(horizontal = 8.dp), verticalAlignment = Alignment.CenterVertically) {
        TextButton(onClick = cancel, modifier = Modifier.testTag("$confirmTag-cancel")) { Text(cancelLabel) }
        Text(title, Modifier.weight(1f), textAlign = TextAlign.Center, style = MaterialTheme.typography.titleMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
        if (confirmLabel != null) TextButton(onClick = confirm, enabled = confirmEnabled, modifier = Modifier.testTag(confirmTag)) {
            Text(confirmLabel, fontWeight = FontWeight.SemiBold)
        } else Spacer(Modifier.width(64.dp))
    }
}

/** One entry, as an inset-grouped page: the head, then Details, Sources, Anchors, Where it's used and History. */
@Composable
private fun WikiEntryPage(detail: WikiEntryDetail, now: Instant, busy: Boolean, sessionTitle: (String) -> String?,
    sourceTitle: (WikiSource) -> String?, openSession: (String) -> Unit, openTask: (String) -> Unit, confirm: () -> Unit, reject: (String) -> Unit) {
    val entry = detail.entry
    LazyColumn(Modifier.fillMaxSize().testTag("wiki-entry-list"), contentPadding = PaddingValues(bottom = 24.dp)) {
        item(key = "head") { EntryHead(detail, now, busy, confirm, reject) }
        // Details
        val rows = WikiLogic.fieldRows(entry.kind, entry.fields)
        sectionHeader(WikiCopy.details)
        item(key = "details") {
            WikiCard {
                rows.forEach { row ->
                    Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        Text(row.label, style = WikiType.label, color = WikiPalette.secondary)
                        SelectionContainer { Column { row.lines.forEach { Text(it, style = WikiType.prose) } } }
                    }
                }
            }
        }
        // Sources
        sectionHeader(WikiCopy.sources, detail.sources.size)
        item(key = "sources") {
            WikiCard {
                if (detail.sources.isEmpty()) CardNote(WikiCopy.noSources)
                detail.sources.forEachIndexed { i, source ->
                    if (i > 0) HorizontalDivider(Modifier.padding(start = 16.dp))
                    SourceRow(source, sourceTitle(source), openSession, openTask)
                }
            }
        }
        // Anchors
        val anchors = entry.anchors.orEmpty()
        sectionHeader(WikiCopy.anchors, anchors.size)
        item(key = "anchors") {
            WikiCard {
                if (anchors.isEmpty()) CardNote(WikiCopy.noAnchors)
                anchors.forEach { anchor ->
                    Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Text("◎", style = WikiType.meta, color = WikiPalette.secondary)
                        Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
                            SelectionContainer { Text(WikiLogic.anchorLabel(anchor), style = WikiType.mono) }
                            WikiMarkText(WikiLogic.anchorStateMark(anchor))
                        }
                    }
                }
            }
            // What re-checks the anchors, said only when there are some to re-check.
            if (anchors.isNotEmpty()) Text(WikiCopy.anchorsNote, Modifier.padding(horizontal = 32.dp, vertical = 4.dp), style = WikiType.label, color = WikiPalette.secondary)
        }
        // Where it's used
        sectionHeader(WikiCopy.whereUsed)
        item(key = "used") {
            WikiCard {
                val note = WikiModeLogic.whereUsedNote(entry.status, entry.trust)
                note?.let { CardNote(it) }
                if (detail.exposure.isEmpty()) { if (note == null) CardNote(WikiCopy.noUseYet) }
                else {
                    val pushed = detail.exposure.filter { it.channel == "push" }.mapNotNull { it.sessionId }.toSet().size
                    val fetched = detail.exposure.count { it.channel == "get" }
                    Text(WikiCopy.pushedTo(pushed, fetched), Modifier.padding(horizontal = 16.dp, vertical = 8.dp), style = WikiType.subtext)
                    detail.exposure.take(3).forEach { row -> ExposureRow(row, now, sessionTitle, openSession) }
                }
            }
        }
        // History
        sectionHeader(WikiCopy.history)
        item(key = "history") {
            WikiCard {
                if (detail.history.isEmpty()) CardNote(WikiCopy.noHistory)
                detail.history.forEachIndexed { index, revision ->
                    HistoryRow(revision, if (index == 0) detail.history.getOrNull(1) else null, now)
                }
            }
        }
    }
}

private fun LazyListScope.sectionHeader(title: String, count: Int? = null) {
    item(key = "header:$title") {
        Row(Modifier.padding(start = 32.dp, end = 32.dp, top = 18.dp, bottom = 4.dp).semantics { heading() }, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            Text(title, style = WikiType.label.copy(fontWeight = FontWeight.SemiBold), color = WikiPalette.secondary)
            if (count != null) Text("$count", style = WikiType.label, color = WikiPalette.secondary)
        }
    }
}

@Composable
private fun CardNote(text: String) {
    Text(text, Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 10.dp), style = WikiType.label, color = WikiPalette.secondary)
}

/** The kind and topics, the title, trust/anchor/pinned/web-derived chips, the owner's answers and the mark bar. */
@Composable
private fun EntryHead(detail: WikiEntryDetail, now: Instant, busy: Boolean, confirm: () -> Unit, reject: (String) -> Unit) {
    val entry = detail.entry
    Column(Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        val topics = entry.topics.orEmpty().joinToString(" · ")
        Text(buildAnnotatedString {
            withStyle(SpanStyle(color = if (entry.kind == "pitfall") WikiPalette.amber else WikiPalette.secondary)) { append(wikiKindGlyph(entry.kind) + " ") }
            withStyle(SpanStyle(fontWeight = FontWeight.SemiBold)) { append(WikiCopy.kindLabel(entry.kind)) }
            if (topics.isNotEmpty()) withStyle(SpanStyle(color = WikiPalette.secondary)) { append(" · $topics") }
        }, style = WikiType.label, maxLines = 1, overflow = TextOverflow.Ellipsis)
        SelectionContainer {
            Text(entry.displayTitle, Modifier.semantics { heading() }.testTag("wiki-entry-title"),
                style = MaterialTheme.typography.headlineMedium.copy(fontWeight = FontWeight.Bold),
                textDecoration = if (entry.isEnded) TextDecoration.LineThrough else null)
        }
        FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            if (WikiCopy.trustLabel(entry.trust).isNotEmpty()) WikiBadge(WikiCopy.trustLabel(entry.trust), WikiLogic.trustTone(entry.trust), check = entry.trust == "confirmed")
            WikiLogic.anchorMark(entry.anchorState, entry.anchorCheckedRef)?.let { mark ->
                WikiBadge((if (mark.tone == WikiTone.GREEN) "" else "⚠ ") + mark.word, mark.tone, check = mark.tone == WikiTone.GREEN)
            }
            if (entry.pinned == true) WikiBadge(WikiCopy.pinned, WikiTone.MUTED)
            if (entry.tainted == true) WikiBadge(WikiCopy.webDerived, WikiTone.AMBER)
        }
        // What a review mode applied: the owner's two answers under the head, then what its mark means for agents.
        if (WikiModeLogic.answerable(entry.status, entry.trust)) EntryAnswers(entry, busy, confirm, reject)
        WikiModeLogic.banner(entry.status, entry.trust, entry.tainted == true)?.let { MarkBar(detail, it, now) }
    }
}

/** Confirm (for what agents are not sent yet) and Reject ▾, two large buttons side by side. */
@Composable
private fun EntryAnswers(entry: WikiEntry, busy: Boolean, confirm: () -> Unit, reject: (String) -> Unit) {
    var reasons by remember { mutableStateOf(false) }
    Row(Modifier.fillMaxWidth().padding(top = 4.dp), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        if (WikiModeLogic.canConfirm(entry.status, entry.trust)) Button(onClick = confirm, enabled = !busy,
            modifier = Modifier.weight(1f).heightIn(min = 48.dp).testTag("wiki-entry-confirm")) { Text("✓ " + WikiModeCopy.confirm) }
        Box(Modifier.weight(1f)) {
            OutlinedButton(onClick = { reasons = true }, enabled = !busy, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp).testTag("wiki-entry-reject"),
                colors = ButtonDefaults.outlinedButtonColors(contentColor = MaterialTheme.colorScheme.error)) { Text(WikiCopy.reject + " ▾") }
            DropdownMenu(reasons, { reasons = false }) {
                // The four reasons, headed by where the reason goes.
                Text(WikiModeCopy.rejectOnRecord, Modifier.padding(horizontal = 16.dp, vertical = 8.dp), style = WikiType.label, color = WikiPalette.secondary)
                WikiCopy.rejectReasons.forEach { reason ->
                    DropdownMenuItem(text = { Text(WikiCopy.rejectReasonLabel(reason)) }, modifier = Modifier.testTag("wiki-entry-reject:$reason"),
                        onClick = { reasons = false; reject(reason) })
                }
            }
        }
    }
}

/** The bar under the head: the mark's word and what it means, then who checked it and who applied it. */
@Composable
private fun MarkBar(detail: WikiEntryDetail, banner: WikiModeLogic.Banner, now: Instant) {
    val entry = detail.entry
    val current = detail.history.maxByOrNull { it.revision ?: 0 }
    val verification = detail.verification
    val line = WikiModeLogic.checkedLine(verification?.verdict, verification?.model, entry.tainted == true,
        current?.let { historyWord(it.authorKind) }, current?.createdAt?.let { WikiDate.relative(it, now) })
    val tone = WikiPalette.color(banner.tone)
    Row(Modifier.fillMaxWidth().background(if (banner.tone == WikiTone.AMBER) WikiPalette.amberWash else tone.copy(alpha = if (banner.tone == WikiTone.MUTED) 0.08f else 0.12f),
        RoundedCornerShape(10.dp)).padding(10.dp).testTag("wiki-entry-mark"), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(when (banner.tone) { WikiTone.AMBER -> "🌐"; WikiTone.GREEN -> "✓"; else -> "ⓘ" }, color = tone, style = WikiType.label)
        Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
            Text(buildAnnotatedString {
                withStyle(SpanStyle(fontWeight = FontWeight.Bold, color = tone)) { append(banner.lead) }
                append(" · " + banner.text)
            }, style = WikiType.label)
            if (line.isNotEmpty()) Text(line, style = WikiType.meta, color = WikiPalette.secondary)
        }
    }
}

/** Who wrote a revision, in the History section's own words. */
private fun historyWord(kind: String?) = when (kind) {
    "owner" -> WikiCopy.historyConfirmedBy; "maintenance" -> WikiCopy.historyMaintenance; "system" -> WikiCopy.historySystem
    else -> WikiCopy.historyProposedBy
}

/** A kind's glyph (iOS `WikiGlyph.kind`, the web's kind icons). */
internal fun wikiKindGlyph(kind: String?) = when (kind) {
    "principle" -> "📌"; "convention" -> "📏"; "decision" -> "⑂"; "pitfall" -> "⚠"; "recipe" -> "☰"; "concept" -> "📖"; else -> "▤"
}

/** The task or session a source cites, as the link card the web draws for it — a turn names its session. */
internal fun wikiSourceCard(source: WikiSource): Pair<String, String>? {
    val ref = source.ref?.takeIf { ObjectId.canonical(it) != null } ?: return null
    return when (source.kind) {
        "task" -> "task" to ref
        "turn" -> if (source.locator["turnId"] == null) null else "session" to ref
        else -> null
    }
}

/** Every card an entry's page names: its sources' tasks and sessions, and the sessions it was handed to. */
internal fun wikiEntryCardRefs(detail: WikiEntryDetail): List<Pair<String, String>> =
    detail.sources.mapNotNull(::wikiSourceCard) +
        detail.exposure.mapNotNull { it.sessionId?.takeIf { id -> ObjectId.canonical(id) != null }?.let { id -> "session" to id } }

/** A source kind's glyph (iOS `WikiGlyph.source`). */
private fun sourceGlyph(kind: String?) = when (kind) {
    "turn" -> "💬"; "task" -> "☑"; "commit" -> "⑂"; "merge_receipt" -> "⤚"; "tool_call" -> "🔧"; else -> "▤"
}

/** A source: the record it cites, and the quote it was cited for with whether the server found it there. A task or a session opens. */
@Composable
private fun SourceRow(source: WikiSource, title: String?, openSession: (String) -> Unit, openTask: (String) -> Unit) {
    val opens = source.kind == "task" || (source.kind == "turn" && source.locator["turnId"] != null)
    val ref = source.ref
    Column(Modifier.fillMaxWidth().clickable(enabled = opens && ref != null, role = Role.Button) {
        if (ref != null) { if (source.kind == "task") openTask(ref) else if (source.kind == "turn") openSession(ref) }
    }.padding(horizontal = 16.dp, vertical = 10.dp).testTag("wiki-source:${source.id}"), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            Text(sourceGlyph(source.kind), style = WikiType.meta, color = MaterialTheme.colorScheme.primary)
            // A turn is shown as the session it is in when it names one, as the web's card does.
            Text(if (source.kind == "turn" && opens) "Session" else WikiLogic.sourceWord(source.kind), style = WikiType.label.copy(fontWeight = FontWeight.SemiBold))
            if (title == null) Text(WikiLogic.sourceRef(source), Modifier.weight(1f), style = WikiType.mono.copy(fontSize = WikiType.meta.fontSize), color = WikiPalette.secondary,
                maxLines = 1, overflow = TextOverflow.MiddleEllipsis)
            else Spacer(Modifier.weight(1f))
            if (opens) Icon(painterResource(R.drawable.ic_chevron_forward), null, Modifier.size(12.dp), tint = WikiPalette.secondary)
        }
        if (title != null) Text(title, Modifier.testTag("wiki-source-title:${source.id}"), maxLines = 3, overflow = TextOverflow.Ellipsis,
            style = WikiType.prose.copy(fontWeight = FontWeight.SemiBold),
            color = if (opens) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurface)
        val quote = source.quote
        if (!quote.isNullOrEmpty()) {
            SelectionContainer {
                Text(quote, Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.onSurface.copy(alpha = 0.05f), RoundedCornerShape(8.dp)).padding(8.dp),
                    style = WikiType.mono)
            }
            Text(if (source.quoteVerified == true) WikiCopy.quoteVerified else WikiCopy.quoteUnverified, Modifier.fillMaxWidth(), textAlign = TextAlign.End,
                style = WikiType.meta.copy(fontWeight = FontWeight.SemiBold),
                color = if (source.quoteVerified == true) io.orbitd.android.ui.LocalOrbitColors.current.success else WikiPalette.secondary)
        }
    }
}

@Composable
private fun ExposureRow(row: WikiExposure, now: Instant, sessionTitle: (String) -> String?, openSession: (String) -> Unit) {
    val id = row.sessionId
    val title = id?.let(sessionTitle) ?: id?.let { "Session ${it.take(8)}" } ?: "A session without an id"
    val how = if (row.channel == "push") WikiCopy.pushedAtStart else "wiki_get"
    val time = row.at?.let { WikiDate.relative(it, now) }
    Row(Modifier.fillMaxWidth().clickable(enabled = id != null, role = Role.Button) { id?.let(openSession) }.heightIn(min = 48.dp)
        .padding(horizontal = 16.dp, vertical = 8.dp).testTag("wiki-exposure:${id ?: "none"}"), verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(title, style = WikiType.prose, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(listOfNotNull(how, time).joinToString(" · "), style = WikiType.label, color = WikiPalette.secondary)
        }
        WikiBadge(if (row.channel == "push") WikiCopy.pushedBadge else WikiCopy.fetchedBadge, WikiTone.MUTED)
    }
}

/** One revision: its number, who wrote it, and when — the newest with the way back to the one before it. */
@Composable
private fun HistoryRow(revision: WikiRevision, next: WikiRevision?, now: Instant) {
    var meta = revision.createdAt?.let { WikiDate.relative(it, now) } ?: ""
    next?.revision?.let { meta += " · " + WikiCopy.compareWith(it) }
    Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp), verticalAlignment = Alignment.Top, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(WikiCopy.revision(revision.revision ?: 0), Modifier.background(MaterialTheme.colorScheme.onSurface.copy(alpha = 0.07f), CircleShape)
            .padding(horizontal = 6.dp, vertical = 2.dp), style = WikiType.mono.copy(fontSize = WikiType.meta.fontSize, fontWeight = FontWeight.SemiBold))
        Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(historyWord(revision.authorKind), style = WikiType.prose.copy(fontWeight = FontWeight.SemiBold))
            if (meta.isNotEmpty()) Text(meta, style = WikiType.label, color = WikiPalette.secondary)
        }
    }
}
