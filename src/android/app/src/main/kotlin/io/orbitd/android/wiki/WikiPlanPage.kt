package io.orbitd.android.wiki

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
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
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.*
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import io.orbitd.android.R
import io.orbitd.android.navigation.OrbitRoute
import io.orbitd.android.ui.LocalOrbitColors
import java.time.Instant

// The Wiki's plan (iOS `WikiPlanView.swift`; criterion 11's owner half, mocks 22 and 26 ③): the plan a wiki's documents
// are written from, as the owner reviews, confirms and changes it — the version shown and its history, the job that
// drafts it or writes its documents, the gate's report, the changes a maintenance run proposed, the categories and
// documents. Drawn from what the server said and nothing else; where a press goes is decided by the screen that mounts
// the page (`WikiPlanScreens.kt`). Every word is `WikiPlanCopy` / `WikiPlanLogic`.
//
// THE OWNER'S DOOR ONLY: every write goes through `WikiStore` on the JWT door; nothing here can be asked for by an agent.

/** Where a press on the plan's pages goes (iOS `WikiPlanActions`). */
internal class WikiPlanActions(
    /** Draft plan, on a space with none. */
    val draft: () -> Unit = {},
    /** Redraft…: the sheet with the owner's words. */
    val redraft: () -> Unit = {},
    val confirm: (Int) -> Unit = {},
    /** A version from the menu; null for the one the page shows first. */
    val pickVersion: (Int?) -> Unit = {},
    val openDoc: (String) -> Unit = {},
    /** A section of a document, by its place (0-based). */
    val openSection: (String, Int) -> Unit = { _, _ -> },
    /** Edit a document: the sheet. */
    val editDoc: (String) -> Unit = {},
    /** Edit one section, from its own page. */
    val editSection: (String, Int) -> Unit = { _, _ -> },
    /** Accept a change — with `edit`, only accept, and open the new draft's document to edit. */
    val accept: (WikiPlanProposal, Boolean) -> Unit = { _, _ -> },
    val reject: (WikiPlanProposal) -> Unit = {},
    val openRun: (String) -> Unit = {},
    val openSettings: () -> Unit = {},
    val openRunners: () -> Unit = {},
    val openContents: () -> Unit = {},
    val openEntry: (String) -> Unit = {},
)

// MARK: - the plan page

/** The plan (mock 22 ②): the title with the version shown, where that version came from, Confirm plan and Redraft…, a
 * failed draft's hint, the job's card, the gate's report, the changes proposed, and the categories and documents —
 * `WikiPlanLogic.PageSection`'s order, which is the web phone's. [shown] null is the empty page; [base] is what the shown
 * version is held against; [written] how far the documents of the version in force are written. */
@Composable
internal fun WikiPlanPage(route: OrbitRoute, state: WikiPlanState, shown: WikiPlanLogic.Shown?, base: WikiPlanLogic.Shown?,
    versions: List<WikiPlanLogic.VersionRow>, jobCard: WikiPlanLogic.JobCard?, written: Pair<Int, Int>?, whereItRuns: String?,
    provider: String?, now: Instant, busy: Boolean = false, refused: Map<String, List<WikiPlanGateError>> = emptyMap(),
    actions: WikiPlanActions = WikiPlanActions()) {
    val open = WikiPlanLogic.openJob(state)
    val inForce = shown?.status == WikiPlanLogic.ShownStatus.CONFIRMED && state.confirmed?.version == shown.version
    PageBar.Bind(route, title = "") {
        BarIcon(R.drawable.ic_contents, WikiArticleCopy.contents, "wiki-plan-contents", onClick = actions.openContents)
    }
    // The version in force, which a change was proposed against.
    val changesBase = remember(state.confirmed) { state.confirmed?.let(WikiPlanLogic::fromVersion) }
    val metaLine = if (shown != null) {
        val job = if (shown.status == WikiPlanLogic.ShownStatus.FAILED) WikiPlanLogic.failedJob(state) else (open ?: state.job)
        WikiPlanLogic.meta(shown, job, if (inForce) written else null).joinToString(" · ")
    } else open?.let { WikiPlanLogic.jobHead(it) } ?: WikiPlanCopy.none
    LazyColumn(Modifier.fillMaxSize().testTag("wiki-plan-page"), contentPadding = PaddingValues(bottom = 24.dp)) {
        WikiPlanLogic.PageSection.entries.forEach { section ->
            when (section) {
                // The bar's back button is the crumb on a phone: Wiki › Plan is where it goes.
                WikiPlanLogic.PageSection.CRUMB -> Unit
                WikiPlanLogic.PageSection.TITLE -> item(key = "title") {
                    Row(Modifier.fillMaxWidth().padding(start = 20.dp, end = 12.dp, top = 8.dp), verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        Text(WikiPlanCopy.title, Modifier.weight(1f).semantics { heading() }.testTag("wiki-plan-title"),
                            style = MaterialTheme.typography.headlineLarge.copy(fontWeight = FontWeight.Bold))
                        if (shown != null) PlanVersionMenu(shown, versions, actions.pickVersion)
                    }
                }
                WikiPlanLogic.PageSection.META -> item(key = "meta") {
                    Text(metaLine, Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 4.dp).testTag("wiki-plan-meta"),
                        style = WikiType.label, color = WikiPalette.secondary)
                }
                WikiPlanLogic.PageSection.ACTIONS -> if (shown != null) item(key = "actions") {
                    Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 6.dp), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        if (shown.status == WikiPlanLogic.ShownStatus.DRAFT || shown.status == WikiPlanLogic.ShownStatus.FAILED) {
                            Button(onClick = { actions.confirm(shown.version) }, enabled = !(shown.status == WikiPlanLogic.ShownStatus.FAILED || busy),
                                modifier = Modifier.weight(1f).heightIn(min = 48.dp).testTag("wiki-plan-confirm")) { Text(WikiPlanCopy.confirm) }
                        }
                        if (shown.status != WikiPlanLogic.ShownStatus.SUPERSEDED) {
                            FilledTonalButton(onClick = actions.redraft, enabled = open == null && !busy,
                                modifier = Modifier.weight(1f).heightIn(min = 48.dp).testTag("wiki-plan-redraft")) {
                                Icon(painterResource(R.drawable.ic_refresh), null, Modifier.size(18.dp))
                                Spacer(Modifier.width(6.dp))
                                Text(WikiPlanCopy.redraft)
                            }
                        }
                    }
                } else if (open == null) item(key = "empty") { PlanEmpty(whereItRuns, provider, busy, actions.draft) }
                WikiPlanLogic.PageSection.HINT -> if (shown?.status == WikiPlanLogic.ShownStatus.FAILED) item(key = "hint") {
                    Text(WikiPlanCopy.failedHint(state.confirmed?.version), Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 4.dp)
                        .testTag("wiki-plan-hint"), style = WikiType.label, color = WikiPalette.secondary)
                }
                WikiPlanLogic.PageSection.JOB -> if (jobCard != null) item(key = "job") { WikiPlanJobCardView(jobCard, actions) }
                WikiPlanLogic.PageSection.GATE -> if (shown != null && (shown.status == WikiPlanLogic.ShownStatus.DRAFT ||
                        shown.status == WikiPlanLogic.ShownStatus.FAILED)) item(key = "gate") {
                    WikiPlanGateView(WikiPlanLogic.gate(shown, base,
                        if (shown.status == WikiPlanLogic.ShownStatus.FAILED) WikiPlanLogic.failedJob(state) else state.job))
                }
                WikiPlanLogic.PageSection.CHANGES -> {
                    val proposals = state.proposals.orEmpty()
                    if (shown != null && shown.status != WikiPlanLogic.ShownStatus.SUPERSEDED && proposals.isNotEmpty()) {
                        item(key = "changes-header") { WikiPlanSectionHead(WikiPlanCopy.changes, "${proposals.size}") }
                        item(key = "changes") {
                            WikiCard(Modifier.testTag("wiki-plan-changes")) {
                                proposals.forEachIndexed { i, proposal ->
                                    if (i > 0) HorizontalDivider(Modifier.padding(start = 16.dp))
                                    val change = WikiPlanLogic.change(proposal, changesBase)
                                    WikiPlanChangeCard(proposal, change, WikiPlanLogic.acceptNote(state, change.op), refused[proposal.id], busy, now, actions)
                                }
                            }
                        }
                    }
                }
                WikiPlanLogic.PageSection.DOCUMENTS -> if (shown != null) shown.categories.forEach { category ->
                    item(key = "category:${category.number}") {
                        Row(Modifier.fillMaxWidth().padding(start = 32.dp, end = 32.dp, top = 18.dp, bottom = 4.dp).semantics(mergeDescendants = true) { heading() }
                            .testTag("wiki-plan-category:${category.key}"), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                            Text("${category.number}", style = WikiType.label.copy(fontWeight = FontWeight.SemiBold), color = WikiPalette.secondary)
                            Text(category.title, Modifier.weight(1f), style = WikiType.label.copy(fontWeight = FontWeight.SemiBold))
                            Text(WikiPlanLogic.categoryLine(category), style = WikiType.label, color = WikiPalette.secondary)
                        }
                    }
                    if (category.docs.isNotEmpty()) item(key = "docs:${category.number}") {
                        WikiCard {
                            category.docs.forEachIndexed { i, doc ->
                                if (i > 0) HorizontalDivider(Modifier.padding(start = 16.dp))
                                PlanDocRow(doc, shown, actions.openDoc)
                            }
                        }
                    }
                }
            }
        }
    }
}

/** The version beside the title: a menu of every version, the shown one ticked, each with where it came from. */
@Composable
private fun PlanVersionMenu(shown: WikiPlanLogic.Shown, versions: List<WikiPlanLogic.VersionRow>, pick: (Int?) -> Unit) {
    var expanded by remember { mutableStateOf(false) }
    Box {
        Box(Modifier.minimumInteractiveComponentSize().clip(CircleShape).clickable(role = Role.DropdownList) { expanded = true }
            .testTag("wiki-plan-version-menu"), contentAlignment = Alignment.Center) {
            Row(Modifier.background(MaterialTheme.colorScheme.onSurface.copy(alpha = 0.07f), CircleShape).padding(horizontal = 12.dp, vertical = 6.dp),
                verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(WikiPlanCopy.versionLabel(shown.version), style = WikiType.label.copy(fontWeight = FontWeight.SemiBold))
                Text("· ${shown.status.label}", style = WikiType.label, color = WikiPalette.secondary)
                Icon(painterResource(R.drawable.ic_chevron_updown), null, Modifier.size(12.dp))
            }
        }
        DropdownMenu(expanded, { expanded = false }) {
            versions.forEach { row ->
                val isShown = row.version == shown.version
                DropdownMenuItem(modifier = Modifier.semantics { selected = isShown }.testTag("wiki-plan-version:${row.version}"),
                    leadingIcon = { if (isShown) Icon(painterResource(R.drawable.ic_check), null) else Spacer(Modifier.size(24.dp)) },
                    text = {
                        Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                            Text("${WikiPlanCopy.versionLabel(row.version)} · ${row.status.label}")
                            Text(row.note, style = WikiType.label, color = WikiPalette.secondary)
                        }
                    },
                    onClick = { expanded = false; if (!isShown) pick(row.version) })
            }
        }
    }
}

/** No plan yet (mock 22 ①): what a plan is, Draft plan, and where and how long it runs. */
@Composable
private fun PlanEmpty(whereItRuns: String?, provider: String?, busy: Boolean, draft: () -> Unit) {
    Column(Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 20.dp).testTag("wiki-plan-empty"),
        horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Icon(painterResource(R.drawable.ic_plan), null, Modifier.size(40.dp), tint = WikiPalette.secondary)
        Text(WikiPlanCopy.emptyTitle, Modifier.semantics { heading() }, style = MaterialTheme.typography.titleLarge.copy(fontWeight = FontWeight.Bold))
        Text(WikiPlanCopy.emptyText(provider), style = WikiType.subtext, color = WikiPalette.secondary, textAlign = TextAlign.Center)
        Button(onClick = draft, enabled = !busy, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp).testTag("wiki-plan-draft")) {
            Text(WikiPlanCopy.draft)
        }
        Text(WikiPlanCopy.emptyNote(whereItRuns, provider), style = WikiType.label, color = WikiPalette.secondary, textAlign = TextAlign.Center)
    }
}

/** `1.3  安全模型与密钥信任` over the reader's question and `2 errors · 7 sections · 1,500–2,400 chars`. */
@Composable
private fun PlanDocRow(doc: WikiPlanLogic.ShownDoc, shown: WikiPlanLogic.Shown, open: (String) -> Unit) {
    val errors = WikiPlanLogic.docErrors(shown, doc).size
    val error = MaterialTheme.colorScheme.error
    Row(Modifier.fillMaxWidth().clickable(role = Role.Button) { open(doc.slug) }.heightIn(min = 48.dp)
        .padding(horizontal = 16.dp, vertical = 10.dp).testTag("wiki-plan-doc:${doc.slug}"), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        Text(doc.number, Modifier.alignByBaseline(), style = WikiType.subtext.copy(fontFeatureSettings = "tnum"), color = WikiPalette.secondary)
        Column(Modifier.weight(1f).alignByBaseline(), verticalArrangement = Arrangement.spacedBy(3.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(5.dp)) {
                Text(doc.title, Modifier.weight(1f, fill = false), style = WikiType.prose)
                if (doc.protected) Icon(painterResource(R.drawable.ic_lock), WikiPlanCopy.protected, Modifier.size(12.dp), tint = WikiPalette.secondary)
            }
            if (doc.question.isNotEmpty()) Text(doc.question, style = WikiType.subtext, color = WikiPalette.secondary, maxLines = 2, overflow = TextOverflow.Ellipsis)
            Text(buildAnnotatedString {
                if (errors > 0) {
                    withStyle(SpanStyle(color = error, fontWeight = FontWeight.Bold)) { append(WikiPlanCopy.errorCount(errors)) }
                    append(" · ")
                }
                append(WikiPlanLogic.docLine(doc))
            }, style = WikiType.label, color = WikiPalette.secondary)
        }
        Icon(painterResource(R.drawable.ic_chevron_forward), null, Modifier.size(14.dp).align(Alignment.CenterVertically), tint = WikiPalette.secondary)
    }
}

/** An inset-grouped section's header: its title, and the count beside it. */
@Composable
internal fun WikiPlanSectionHead(title: String, count: String? = null) {
    Row(Modifier.fillMaxWidth().padding(start = 32.dp, end = 32.dp, top = 18.dp, bottom = 4.dp).semantics(mergeDescendants = true) { heading() },
        horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        Text(title, style = WikiType.label.copy(fontWeight = FontWeight.SemiBold), color = WikiPalette.secondary)
        if (count != null) Text(count, style = WikiType.label, color = WikiPalette.secondary)
    }
}

/** An inset-grouped section's footer. */
@Composable
internal fun WikiPlanFootnote(text: String, modifier: Modifier = Modifier) {
    Text(text, modifier.fillMaxWidth().padding(horizontal = 32.dp, vertical = 4.dp), style = WikiType.label, color = WikiPalette.secondary)
}

// MARK: - the job

/** The job's card (mock 22 ⑩): grey queued, blue drafting and writing, amber held, red failed. */
@Composable
internal fun WikiPlanJobCardView(card: WikiPlanLogic.JobCard, actions: WikiPlanActions = WikiPlanActions()) {
    val tone = when (card.look) {
        WikiPlanLogic.JobLook.QUEUED -> WikiPalette.secondary
        WikiPlanLogic.JobLook.DRAFTING, WikiPlanLogic.JobLook.WRITING -> MaterialTheme.colorScheme.primary
        WikiPlanLogic.JobLook.HELD -> WikiPalette.amber
        WikiPlanLogic.JobLook.FAILED -> MaterialTheme.colorScheme.error
    }
    val glyph = when (card.look) {
        WikiPlanLogic.JobLook.QUEUED -> R.drawable.ic_clock
        WikiPlanLogic.JobLook.DRAFTING, WikiPlanLogic.JobLook.WRITING -> R.drawable.ic_sync
        WikiPlanLogic.JobLook.HELD -> R.drawable.ic_warning
        WikiPlanLogic.JobLook.FAILED -> R.drawable.ic_x_circle
    }
    Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 6.dp)
        .background(tone.copy(alpha = if (card.look == WikiPlanLogic.JobLook.QUEUED) 0.06f else 0.10f), RoundedCornerShape(10.dp))
        .padding(horizontal = 16.dp, vertical = 10.dp).testTag("wiki-plan-job"), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Icon(painterResource(glyph), null, Modifier.padding(top = 1.dp).size(18.dp), tint = tone)
            Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
                Text(card.title, style = WikiType.subtext.copy(fontWeight = FontWeight.SemiBold),
                    color = if (card.look == WikiPlanLogic.JobLook.QUEUED) MaterialTheme.colorScheme.onSurface else tone)
                Text(card.text, style = WikiType.label, color = WikiPalette.secondary)
                card.link?.let { link ->
                    TextButton(onClick = {
                        when (link.to) {
                            WikiPlanLogic.JobCard.LinkTo.RUN -> link.sessionId?.let(actions.openRun)
                            WikiPlanLogic.JobCard.LinkTo.SETTINGS -> actions.openSettings()
                            WikiPlanLogic.JobCard.LinkTo.RUNNERS -> actions.openRunners()
                        }
                    }, contentPadding = PaddingValues(horizontal = 0.dp, vertical = 4.dp), modifier = Modifier.testTag("wiki-plan-job-link")) {
                        Text(link.label, style = WikiType.subtext)
                    }
                }
            }
        }
        card.progress?.let { progress ->
            LinearProgressIndicator(progress = { progress.done.toFloat() / maxOf(1, progress.total) },
                Modifier.fillMaxWidth().testTag("wiki-plan-job-progress"), color = MaterialTheme.colorScheme.primary)
            progress.now?.let { now ->
                Text(buildAnnotatedString {
                    append(WikiPlanCopy.writingNow); append(" ")
                    withStyle(SpanStyle(fontWeight = FontWeight.Bold)) { append(now) }
                }, style = WikiType.label)
            }
        }
    }
}

// MARK: - the gate's report

/** The gate's report (mock 22 ②): passed in green, or failed in red with its four rows and the references not found,
 * the first few listed where they were named. */
@Composable
internal fun WikiPlanGateView(gate: WikiPlanLogic.Gate) {
    var allRefs by rememberSaveable { mutableStateOf(false) }
    val green = LocalOrbitColors.current.success
    val red = MaterialTheme.colorScheme.error
    val tone = if (gate.passed) green else red
    Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 6.dp).clip(RoundedCornerShape(10.dp))
        .background(MaterialTheme.colorScheme.surfaceVariant).testTag("wiki-plan-gate")) {
        Column(Modifier.fillMaxWidth().background(tone.copy(alpha = 0.10f)).padding(horizontal = 16.dp, vertical = 10.dp),
            verticalArrangement = Arrangement.spacedBy(3.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Icon(painterResource(if (gate.passed) R.drawable.ic_check_circle else R.drawable.ic_x_circle), null, Modifier.size(18.dp), tint = tone)
                Text(gate.title, style = WikiType.subtext.copy(fontWeight = FontWeight.SemiBold), color = tone)
            }
            Text((listOf(gate.line) + listOfNotNull(gate.aside)).joinToString(" · "), style = WikiType.label, color = WikiPalette.secondary)
        }
        if (!gate.passed) gate.rows.forEach { row ->
            HorizontalDivider(Modifier.padding(start = 16.dp))
            Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 10.dp).testTag("wiki-plan-gate-row:${row.check}"),
                verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Icon(painterResource(if (row.ok) R.drawable.ic_check_circle else R.drawable.ic_x_circle), null,
                        Modifier.padding(top = 1.dp).size(18.dp), tint = if (row.ok) green else red)
                    Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                        Text(row.title, style = WikiType.subtext)
                        Text(row.text, style = WikiType.label, color = WikiPalette.secondary)
                    }
                }
                if (row.check == "references" && gate.refs.isNotEmpty()) {
                    // The references not found, the first few on a phone, each where it was named, what, and why.
                    val shownRefs = if (allRefs) gate.refs else gate.refs.take(WikiPlanCopy.refsShownPhone)
                    Column(Modifier.padding(start = 26.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        shownRefs.forEachIndexed { i, ref ->
                            Text(buildAnnotatedString {
                                withStyle(SpanStyle(color = MaterialTheme.colorScheme.primary, fontWeight = FontWeight.Bold)) { append(ref.where) }
                                append(" ")
                                withStyle(SpanStyle(color = WikiPalette.secondary)) { append(ref.kind) }
                                append(" ")
                                withStyle(SpanStyle(fontFamily = FontFamily.Monospace)) { append(ref.ref) }
                                withStyle(SpanStyle(color = red)) { append(" — ${ref.why}") }
                            }, Modifier.testTag("wiki-plan-gate-ref:$i"), style = WikiType.label)
                        }
                        if (gate.refs.size > shownRefs.size) TextButton(onClick = { allRefs = true },
                            contentPadding = PaddingValues(horizontal = 0.dp, vertical = 4.dp), modifier = Modifier.testTag("wiki-plan-gate-more")) {
                            Text(WikiArticleCopy.showMore(gate.refs.size - shownRefs.size), style = WikiType.subtext)
                        }
                    }
                }
            }
        }
    }
}

// MARK: - a change proposed

/** One change a maintenance run proposed (mock 22 ⑥⑦): Review's card with the plan's parts — why, the change to the
 * document's sections, the new sections' sources, the facts it came from, the gate it passed — and Accept, Edit, Reject,
 * with what Accept will do said under them; `WikiPlanLogic.ChangePart`'s order. [refused]: the gate refused the
 * acceptance — its errors, and nothing confirmed. */
@Composable
internal fun WikiPlanChangeCard(proposal: WikiPlanProposal, change: WikiPlanLogic.Change, acceptNote: String,
    refused: List<WikiPlanGateError>? = null, busy: Boolean = false, now: Instant = Instant.now(), actions: WikiPlanActions = WikiPlanActions()) {
    val green = LocalOrbitColors.current.success
    val red = MaterialTheme.colorScheme.error
    Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 12.dp).testTag("wiki-plan-change:${proposal.id}"),
        verticalArrangement = Arrangement.spacedBy(10.dp)) {
        WikiPlanLogic.ChangePart.entries.forEach { part ->
            when (part) {
                WikiPlanLogic.ChangePart.HEAD -> {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        Text(change.op.label, Modifier.background(green.copy(alpha = 0.12f), RoundedCornerShape(3.dp)).padding(horizontal = 5.dp, vertical = 2.dp),
                            style = WikiType.meta.copy(fontFamily = FontFamily.Monospace, fontWeight = FontWeight.Bold), color = green)
                        Text(change.target, Modifier.weight(1f), style = WikiType.label.copy(fontWeight = FontWeight.SemiBold), maxLines = 1,
                            overflow = TextOverflow.Ellipsis)
                        proposal.createdAt?.let { RelativeTime.ago(it, now) }?.let { Text(it, style = WikiType.label, color = WikiPalette.secondary) }
                    }
                    Text(buildAnnotatedString {
                        withStyle(SpanStyle(color = WikiPalette.secondary)) { append(WikiPlanCopy.proposedBy) }
                        append(" ")
                        withStyle(SpanStyle(color = MaterialTheme.colorScheme.primary)) { append(WikiCopy.historyMaintenance) }
                    }, style = WikiType.label)
                }
                WikiPlanLogic.ChangePart.TITLE -> Text(change.title, style = WikiType.prose.copy(fontWeight = FontWeight.SemiBold))
                WikiPlanLogic.ChangePart.WHY -> PlanChangeField(WikiPlanCopy.why) { Text(proposal.reason ?: "", style = WikiType.subtext) }
                WikiPlanLogic.ChangePart.CHANGE -> if (change.rows.isNotEmpty() || change.renumber != null) PlanChangeField(WikiPlanCopy.change) {
                    Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(8.dp)).border(1.dp, green.copy(alpha = 0.35f), RoundedCornerShape(8.dp))) {
                        change.rows.forEach { row ->
                            val mark = row.mark
                            Row(Modifier.fillMaxWidth().background(when (mark) {
                                WikiPlanLogic.ChangeRow.Mark.ADD -> green.copy(alpha = 0.10f)
                                WikiPlanLogic.ChangeRow.Mark.REMOVE -> red.copy(alpha = 0.08f)
                                WikiPlanLogic.ChangeRow.Mark.SAME -> Color.Transparent
                            }).padding(8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                Text(row.n, Modifier.widthIn(min = 24.dp).alignByBaseline(), style = WikiType.label.copy(fontFeatureSettings = "tnum"),
                                    color = when (mark) { WikiPlanLogic.ChangeRow.Mark.ADD -> green; WikiPlanLogic.ChangeRow.Mark.REMOVE -> red
                                        WikiPlanLogic.ChangeRow.Mark.SAME -> WikiPalette.secondary })
                                Text(row.title, Modifier.alignByBaseline(), style = WikiType.subtext.copy(fontWeight =
                                    if (mark == WikiPlanLogic.ChangeRow.Mark.SAME) FontWeight.Normal else FontWeight.SemiBold),
                                    textDecoration = if (mark == WikiPlanLogic.ChangeRow.Mark.REMOVE) TextDecoration.LineThrough else null,
                                    color = if (mark == WikiPlanLogic.ChangeRow.Mark.SAME) WikiPalette.secondary else MaterialTheme.colorScheme.onSurface)
                            }
                        }
                        change.renumber?.let { Text(it, Modifier.padding(8.dp), style = WikiType.label, color = WikiPalette.secondary) }
                    }
                }
                WikiPlanLogic.ChangePart.SOURCES -> {
                    val lines = change.added.flatMap { WikiPlanLogic.sourceLines(it.sources) }
                    if (lines.isNotEmpty()) PlanChangeField(WikiPlanCopy.sources) {
                        Column(verticalArrangement = Arrangement.spacedBy(3.dp)) { lines.forEach { Text(it, style = WikiType.subtext) } }
                    }
                }
                WikiPlanLogic.ChangePart.FROM -> {
                    val facts = proposal.facts.orEmpty()
                    if (facts.isNotEmpty()) PlanChangeField(WikiPlanCopy.from) {
                        Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                            facts.take(WikiPlanCopy.factsShown).forEach { PlanFactRow(it, actions) }
                            if (facts.size > WikiPlanCopy.factsShown) Text(WikiPlanCopy.andMore(facts.size - WikiPlanCopy.factsShown),
                                style = WikiType.label, color = MaterialTheme.colorScheme.primary)
                        }
                    }
                }
                WikiPlanLogic.ChangePart.CHECK -> PlanChangeField(WikiPlanCopy.check) {
                    if (refused != null) Column(Modifier.testTag("wiki-plan-change-refused:${proposal.id}"), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                        Text(WikiPlanCopy.acceptRefused, style = WikiType.label.copy(fontWeight = FontWeight.SemiBold), color = red)
                        refused.take(8).forEach { Text("${it.path} ${it.message}", style = WikiType.label, color = red) }
                    } else Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        Icon(painterResource(R.drawable.ic_check_circle), null, Modifier.size(16.dp), tint = green)
                        Text(WikiPlanCopy.passed, style = WikiType.subtext.copy(fontWeight = FontWeight.SemiBold), color = green)
                    }
                }
                WikiPlanLogic.ChangePart.ACTIONS -> Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    val padding = PaddingValues(horizontal = 8.dp, vertical = 8.dp)
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Button(onClick = { actions.accept(proposal, false) }, enabled = !busy, contentPadding = padding,
                            modifier = Modifier.weight(1f).heightIn(min = 48.dp).testTag("wiki-plan-accept:${proposal.id}")) { Text(WikiPlanCopy.accept, maxLines = 1) }
                        FilledTonalButton(onClick = { actions.accept(proposal, true) }, enabled = !busy, contentPadding = padding,
                            modifier = Modifier.weight(1f).heightIn(min = 48.dp).testTag("wiki-plan-edit:${proposal.id}")) { Text(WikiPlanCopy.edit, maxLines = 1) }
                        FilledTonalButton(onClick = { actions.reject(proposal) }, enabled = !busy, contentPadding = padding,
                            modifier = Modifier.weight(1f).heightIn(min = 48.dp).testTag("wiki-plan-reject:${proposal.id}")) { Text(WikiPlanCopy.reject, maxLines = 1) }
                    }
                    Text(acceptNote, style = WikiType.label, color = WikiPalette.secondary)
                }
            }
        }
    }
}

@Composable
private fun PlanChangeField(title: String, content: @Composable () -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text(title, style = WikiType.label, color = WikiPalette.secondary)
        content()
    }
}

/** A fact the change came from: an entry of the space opens its page; a session opens; a commit is named. */
@Composable
private fun PlanFactRow(fact: WikiPlanProposal.Fact, actions: WikiPlanActions) {
    if (fact.kind == "entry" || fact.kind == "session") TextButton(
        onClick = { if (fact.kind == "entry") actions.openEntry(fact.id) else actions.openRun(fact.id) },
        contentPadding = PaddingValues(horizontal = 0.dp, vertical = 4.dp), modifier = Modifier.testTag("wiki-plan-fact:${fact.id}")) {
        Text(fact.id, style = WikiType.subtext, maxLines = 1, overflow = TextOverflow.Ellipsis)
    } else Row(Modifier.testTag("wiki-plan-fact:${fact.id}"), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        Icon(painterResource(R.drawable.ic_branch), null, Modifier.size(14.dp), tint = WikiPalette.secondary)
        Text(WikiLogic.shortSha(fact.id), style = WikiType.mono, color = WikiPalette.secondary)
    }
}
