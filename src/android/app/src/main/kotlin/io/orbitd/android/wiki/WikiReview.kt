package io.orbitd.android.wiki

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import io.orbitd.android.R
import io.orbitd.android.directory.DirectoryData
import io.orbitd.android.directory.LoadingMessage
import io.orbitd.android.directory.StatusMessage
import io.orbitd.android.navigation.OrbitRoute
import io.orbitd.android.ui.LocalOrbitColors
import io.orbitd.android.toast.OrbitToasts
import kotlinx.coroutines.launch
import kotlinx.serialization.json.*
import java.time.Instant

/** Where a press on Review goes (iOS `WikiReviewActions`). */
internal class WikiReviewActions(
    val decide: (WikiLogic.ReviewCard, String, String?) -> Unit = { _, _, _ -> },
    val edit: (WikiLogic.ReviewCard) -> Unit = {},
    val openSession: (String) -> Unit = {},
    /** A challenge's Amend: the owner's version of the entry it names. */
    val amend: (WikiLogic.ReviewCard) -> Unit = {},
)

/** Review: every space's proposals waiting for the owner, one card at a time (iOS `WikiReviewView`). */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun WikiReviewScreen(store: WikiStore, route: OrbitRoute, data: DirectoryData, nav: WikiNav) {
    val state by store.state.collectAsState()
    val scope = rememberCoroutineScope()
    val now = rememberMinuteClock()
    // The card a form is open on, by id; looked up among every waiting op, so an answer in flight keeps its form.
    var editing by rememberSaveable { mutableStateOf<String?>(null) }
    var amending by rememberSaveable { mutableStateOf<String?>(null) }
    var notice by rememberSaveable { mutableStateOf<String?>(null) }
    var refreshing by remember { mutableStateOf(false) }
    LaunchedEffect(store) { store.loadReview() }
    // The entries the waiting ops name — an amend's "before", a retire's title — read as the queue changes.
    val queue = state.review.map { it.id }
    LaunchedEffect(queue) { store.loadEntriesNamed(store.state.value.reviewCards) }
    val cards = state.reviewCards
    PageBar.Bind(route, title = WikiCopy.reviewTitle, subtitle = reviewSubtitle(cards, now))

    /** A refusal opens the alert with the server's reason; an answer that landed floats its outcome with the entry under it. */
    fun finish(answer: String?, card: WikiLogic.ReviewCard, action: String, renamed: String? = null) {
        if (answer != null) notice = answer
        else {
            val entry = card.op.entryId?.let { store.state.value.detail(it)?.entry }
            OrbitToasts.show(WikiLogic.decidedToast(card.op.op, action), renamed ?: WikiLogic.knownTitle(card, entry))
        }
    }
    val actions = WikiReviewActions(
        decide = { card, action, reason -> scope.launch { finish(store.decide(card, action, reason), card, action) } },
        edit = { editing = it.id },
        openSession = nav::session,
        amend = { amending = it.id })
    PullToRefreshBox(isRefreshing = refreshing, onRefresh = {
        scope.launch { refreshing = true; try { store.loadReview() } finally { refreshing = false } }
    }, modifier = Modifier.fillMaxSize().testTag("wiki-review")) {
        when {
            state.reviewState.hasLoaded || state.review.isNotEmpty() ->
                WikiReviewPage(cards, entry = { id -> state.detail(id)?.entry }, now = now, busy = state.busy, actions = actions)
            state.reviewState.lastLoadFailed -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                StatusMessage("Review couldn't be loaded", "") { scope.launch { store.loadReview() } }
            }
            else -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { LoadingMessage("Loading…") }
        }
    }
    val waiting = WikiLogic.reviewCards(state.review)
    waiting.firstOrNull { it.id == editing }?.let { card ->
        WikiProposalForm(card, card.op.entryId?.let { state.detail(it)?.entry }, close = { editing = null }) { edited ->
            val answer = store.decide(card, "edit", edited = edited)
            finish(answer, card, "edit", renamed = edited["title"].text())
            answer == null
        }
    }
    waiting.firstOrNull { it.id == amending }?.let { card ->
        card.op.entryId?.let { state.detail(it)?.entry }?.let { entry ->
            WikiChallengeAmendForm(entry, close = { amending = null }) { edited ->
                val answer = store.decide(card, "amend", edited = edited)
                finish(answer, card, "amend", renamed = edited["title"].text())
                answer == null
            }
        }
    }
    WikiRefusalAlert(WikiCopy.decideFailed, notice) { notice = null }
}

/** "Review" over how many proposals from how many sessions, and how old the oldest is. */
internal fun reviewSubtitle(cards: List<WikiLogic.ReviewCard>, now: Instant): String {
    if (cards.isEmpty()) return WikiCopy.noReview
    var line = WikiCopy.proposalsFrom(cards.size, WikiLogic.proposingSessions(cards))
    WikiLogic.oldestProposal(cards)?.let { WikiDate.relative(it, now) }?.let { line += " · " + WikiCopy.oldest(it) }
    return line
}

/** The owner's title and one line, each trimmed (iOS `WikiEntryChanges`; a key left out is not sent). */
private fun entryChanges(title: String?, summary: String?, extra: JsonObjectBuilder.() -> Unit = {}) = buildJsonObject {
    title?.let { put("title", it) }; summary?.let { put("summary", it) }; extra()
}

/** A challenge's Amend: the owner's version of the entry it names, written as the owner's revision. Only what
 * changed is sent, and with nothing changed the answer waits: an Amend that changes nothing is a Re-confirm. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun WikiChallengeAmendForm(entry: WikiEntry, close: () -> Unit, submit: suspend (JsonObject) -> Boolean) {
    var title by rememberSaveable(entry.id) { mutableStateOf(entry.title ?: "") }
    var summary by rememberSaveable(entry.id) { mutableStateOf(entry.summary ?: "") }
    var saving by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    val newTitle = title.trim(); val newSummary = summary.trim()
    val changedTitle = newTitle.takeIf { it != (entry.title ?: "").trim() }
    val changedSummary = newSummary.takeIf { it != (entry.summary ?: "").trim() }
    WikiSheet(saving, close, Modifier.testTag("wiki-amend-form")) {
        SheetBar(WikiModeCopy.amend, WikiModeCopy.cancel, WikiModeCopy.amend,
            confirmEnabled = !saving && (changedTitle != null || changedSummary != null) && newTitle.isNotEmpty(),
            confirmTag = "wiki-amend-form-save", cancel = close, cancelEnabled = !saving) {
            saving = true
            val edited = entryChanges(changedTitle, changedSummary)
            scope.launch { val landed = submit(edited); saving = false; if (landed) close() }
        }
        Column(Modifier.padding(16.dp).imePadding(), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            OutlinedTextField(title, { title = it }, Modifier.fillMaxWidth().testTag("wiki-amend-form-title"),
                placeholder = { Text(WikiCopy.titlePlaceholder) }, singleLine = true)
            OutlinedTextField(summary, { summary = it }, Modifier.fillMaxWidth().testTag("wiki-amend-form-summary"),
                placeholder = { Text(WikiCopy.summaryPlaceholder) }, minLines = 2, maxLines = 5)
            Text(WikiModeCopy.amendNote, style = WikiType.label, color = WikiPalette.secondary)
            Spacer(Modifier.height(16.dp))
        }
    }
}

/** Edit on a Review card: the owner's version of the proposal's title and one line, accepted as theirs. For an
 * amendment the other changes it proposed ride along untouched. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun WikiProposalForm(card: WikiLogic.ReviewCard, entry: WikiEntry?, close: () -> Unit, submit: suspend (JsonObject) -> Boolean) {
    val draft = card.op.payload["entry"] ?: card.op.payload["changes"]
    var title by rememberSaveable(card.id) { mutableStateOf(draft["title"].text() ?: entry?.title ?: "") }
    var summary by rememberSaveable(card.id) { mutableStateOf(draft["summary"].text() ?: entry?.summary ?: "") }
    var saving by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    /** An add or a supersede merges it over the draft on the server; an amend's version replaces the proposed changes,
     * so the ones this form does not show are carried over. */
    fun edited() = entryChanges(title.trim(), summary.trim()) {
        val proposed = card.op.payload["changes"]
        if (card.op.op == "amend" && proposed is JsonObject) {
            proposed["fields"]?.let { put("fields", it) }
            (proposed["topics"] as? JsonArray)?.let { topics -> put("topics", JsonArray(topics.mapNotNull { it.text()?.let(::JsonPrimitive) })) }
            (proposed["aliases"] as? JsonArray)?.let { aliases -> put("aliases", JsonArray(aliases.mapNotNull { it.text()?.let(::JsonPrimitive) })) }
            // As written, not as echoed: the server's copy carries keys an anchor is refused with.
            (proposed["anchors"] as? JsonArray)?.let { anchors -> put("anchors", JsonArray(anchors.map(WikiLogic::anchorInput))) }
        }
    }
    WikiSheet(saving, close, Modifier.testTag("wiki-proposal-form")) {
        SheetBar(WikiCopy.reviewEdit, "Cancel", WikiCopy.accept, confirmEnabled = !saving && title.isNotBlank(),
            confirmTag = "wiki-proposal-form-save", cancel = close, cancelEnabled = !saving) {
            saving = true
            val version = edited()
            scope.launch { val landed = submit(version); saving = false; if (landed) close() }
        }
        Column(Modifier.padding(16.dp).imePadding(), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            OutlinedTextField(title, { title = it }, Modifier.fillMaxWidth().testTag("wiki-proposal-form-title"),
                placeholder = { Text(WikiCopy.titlePlaceholder) }, singleLine = true)
            OutlinedTextField(summary, { summary = it }, Modifier.fillMaxWidth().testTag("wiki-proposal-form-summary"),
                placeholder = { Text(WikiCopy.summaryPlaceholder) }, minLines = 2, maxLines = 5)
            Text(WikiCopy.acceptNote, style = WikiType.label, color = WikiPalette.secondary)
            Spacer(Modifier.height(16.dp))
        }
    }
}

/** Review: the proposals waiting for the owner, one card at a time with its position ("1 of 3"), filtered by the
 * tabs, and what applies without asking under them (iOS `WikiReviewPage`). */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun WikiReviewPage(cards: List<WikiLogic.ReviewCard>, entry: (String) -> WikiEntry?, now: Instant, busy: Boolean,
    actions: WikiReviewActions) {
    var tab by rememberSaveable { mutableStateOf(WikiLogic.ReviewTab.ALL) }
    // Kept across a decision and a tab change, and clamped to the queue that is there, rather than sent back to the first card.
    var index by rememberSaveable { mutableIntStateOf(0) }
    val visible = WikiLogic.cards(cards, tab)
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp).testTag("wiki-review-page"),
        verticalArrangement = Arrangement.spacedBy(14.dp)) {
        SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth()) {
            WikiLogic.ReviewTab.entries.forEachIndexed { i, each ->
                SegmentedButton(selected = tab == each, onClick = { tab = each },
                    shape = SegmentedButtonDefaults.itemShape(i, WikiLogic.ReviewTab.entries.size),
                    modifier = Modifier.testTag("wiki-review-tab:${each.name.lowercase()}"), icon = {}) {
                    Text(WikiLogic.tabLabel(each, cards), maxLines = 1, overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis)
                }
            }
        }
        val at = WikiLogic.clampedIndex(index, visible.size)
        if (at != null) {
            if (visible.size > 1) ReviewPager(at, visible.size) { index = it }
            key(visible[at].id) { WikiReviewCard(visible[at], visible[at].op.entryId?.let(entry), now, busy, actions) }
        } else Text(WikiCopy.noReview, Modifier.fillMaxWidth().padding(vertical = 28.dp).testTag("wiki-review-empty"),
            style = WikiType.subtext, color = WikiPalette.secondary, textAlign = androidx.compose.ui.text.style.TextAlign.Center)
        AutoAccept()
    }
}

/** One card at a time: where this one is in the queue, and the way to the ones either side. */
@Composable
private fun ReviewPager(at: Int, count: Int, go: (Int) -> Unit) {
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        TextButton(onClick = { go(maxOf(0, at - 1)) }, enabled = at > 0, modifier = Modifier.testTag("wiki-review-previous")) {
            Icon(painterResource(R.drawable.ic_back), null, Modifier.size(16.dp)); Spacer(Modifier.width(4.dp)); Text(WikiCopy.previous, style = WikiType.label)
        }
        Text(WikiCopy.ofCount(at + 1, count), Modifier.weight(1f).testTag("wiki-review-position"),
            textAlign = androidx.compose.ui.text.style.TextAlign.Center,
            style = WikiType.label.copy(fontWeight = FontWeight.SemiBold, fontFeatureSettings = "tnum"), color = WikiPalette.secondary)
        TextButton(onClick = { go(minOf(count - 1, at + 1)) }, enabled = at < count - 1, modifier = Modifier.testTag("wiki-review-next")) {
            Text(WikiCopy.next, style = WikiType.label); Spacer(Modifier.width(4.dp))
            Icon(painterResource(R.drawable.ic_chevron_forward), null, Modifier.size(16.dp))
        }
    }
}

/** What applies without asking, and what always asks. */
@Composable
private fun AutoAccept() {
    Column(Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.onSurface.copy(alpha = 0.035f), RoundedCornerShape(14.dp)).padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Text(WikiCopy.autoAccept, Modifier.semantics { heading() }, style = WikiType.subtext.copy(fontWeight = FontWeight.Bold))
        Text(WikiCopy.autoAcceptHint, style = WikiType.label, color = WikiPalette.secondary)
        AutoRow(WikiCopy.reinforce, WikiCopy.reinforceNote)
        AutoRow(WikiCopy.challenge, WikiCopy.challengeNote)
        Text(buildAnnotatedString {
            withStyle(SpanStyle(fontWeight = FontWeight.Bold)) { append(WikiCopy.alwaysAsks) }
            append(" · " + WikiCopy.alwaysAsksNote)
        }, Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.onSurface.copy(alpha = 0.05f), RoundedCornerShape(10.dp)).padding(10.dp),
            style = WikiType.label)
    }
}

@Composable
private fun AutoRow(title: String, note: String) {
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Text("✓", Modifier.clearAndSetSemantics {}, style = WikiType.label.copy(fontWeight = FontWeight.SemiBold), color = LocalOrbitColors.current.success)
        Column(verticalArrangement = Arrangement.spacedBy(1.dp)) {
            Text(title, style = WikiType.subtext.copy(fontWeight = FontWeight.SemiBold))
            Text(note, style = WikiType.label, color = WikiPalette.secondary)
        }
    }
}

/** One pending proposal: what it is and who proposed it, the warning a web-derived one carries, its title and
 * content, what it cites and stands on, what it resembles, and the answers (iOS `WikiReviewCard`). */
@Composable
internal fun WikiReviewCard(card: WikiLogic.ReviewCard, entry: WikiEntry?, now: Instant, busy: Boolean, actions: WikiReviewActions) {
    val op = card.op
    val isRetire = op.op == "retire"
    // A challenge is answered about the entry it names: Re-confirm, Amend or Retire.
    val isChallenge = op.op == "challenge"
    val tainted = op.tainted == true
    Column(Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.onSurface.copy(alpha = 0.035f), RoundedCornerShape(14.dp))
        .border(BorderStroke(1.dp, MaterialTheme.colorScheme.onSurface.copy(alpha = 0.08f)), RoundedCornerShape(14.dp))
        .padding(14.dp).testTag("wiki-review-card:${op.id}"), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        CardHead(card, entry, now, actions)
        if (isChallenge) ChallengeLine(op, entry)
        if (tainted) Text(buildAnnotatedString {
            withStyle(SpanStyle(fontWeight = FontWeight.Bold)) { append(WikiCopy.webDerived) }
            append(" · " + WikiCopy.webDerivedWarning)
        }, Modifier.fillMaxWidth().background(WikiPalette.amberWash, RoundedCornerShape(10.dp)).padding(10.dp).testTag("wiki-review-web-derived"),
            style = WikiType.label)
        val title = WikiLogic.cardTitle(card, entry)
        Text(if (isRetire) "Retire “$title”" else title, Modifier.semantics { heading() }.testTag("wiki-review-card-title"),
            style = MaterialTheme.typography.titleLarge.copy(fontWeight = FontWeight.Bold))
        if (isRetire) RetireFields(op) else CardContent(card, entry)
        // The approval cards' stack: full width, the prominent answer on top.
        Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            when {
                isRetire -> {
                    AnswerButton(WikiCopy.reviewRetire, "retire-accept", prominent = true, enabled = !busy) { actions.decide(card, "accept", null) }
                    AnswerButton(WikiCopy.keep, "retire-keep", enabled = !busy) { actions.decide(card, "reject", "not_true") }
                }
                isChallenge -> {
                    AnswerButton(WikiModeCopy.reconfirm, "reconfirm", prominent = true, enabled = !busy) { actions.decide(card, "reconfirm", null) }
                    AnswerButton(WikiModeCopy.amend, "amend", enabled = !busy && entry != null) { actions.amend(card) }
                    AnswerButton(WikiModeCopy.retire, "challenge-retire", enabled = !busy) { actions.decide(card, "retire", null) }
                }
                else -> {
                    AnswerButton(WikiCopy.accept, "accept", prominent = true, enabled = !busy) { actions.decide(card, "accept", null) }
                    AnswerButton(WikiCopy.reviewEdit, "edit", enabled = !busy) { actions.edit(card) }
                    RejectMenu(enabled = !busy) { reason -> actions.decide(card, "reject", reason) }
                }
            }
        }
        if (isChallenge) Text(WikiModeCopy.challengeWaits, style = WikiType.label, color = WikiPalette.secondary)
        else if (!isRetire) Text(if (tainted) WikiCopy.webDerivedNote else WikiCopy.acceptNote, style = WikiType.label, color = WikiPalette.secondary)
    }
}

@Composable
private fun AnswerButton(label: String, tag: String, prominent: Boolean = false, enabled: Boolean, onClick: () -> Unit) {
    val modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp).testTag("wiki-review-$tag")
    if (prominent) Button(onClick = onClick, enabled = enabled, modifier = modifier) { Text(label) }
    else OutlinedButton(onClick = onClick, enabled = enabled, modifier = modifier) { Text(label) }
}

/** Reject ▾: the four reasons, headed by where the reason goes. */
@Composable
private fun RejectMenu(enabled: Boolean, reject: (String) -> Unit) {
    var open by remember { mutableStateOf(false) }
    Box(Modifier.fillMaxWidth()) {
        OutlinedButton(onClick = { open = true }, enabled = enabled, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp).testTag("wiki-review-reject")) {
            Text(WikiCopy.reject); Spacer(Modifier.width(4.dp)); Icon(painterResource(R.drawable.ic_chevron_down), null, Modifier.size(12.dp))
        }
        DropdownMenu(open, { open = false }) {
            Text(WikiCopy.rejectReasonFoot, Modifier.padding(horizontal = 16.dp, vertical = 8.dp), style = WikiType.label, color = WikiPalette.secondary)
            WikiCopy.rejectReasons.forEach { reason ->
                DropdownMenuItem(text = { Text(WikiCopy.rejectReasonLabel(reason)) }, modifier = Modifier.testTag("wiki-review-reject:$reason"),
                    onClick = { open = false; reject(reason) })
            }
        }
    }
}

/** The op's chip and the kind, then who proposed it and when. */
@Composable
private fun CardHead(card: WikiLogic.ReviewCard, entry: WikiEntry?, now: Instant, actions: WikiReviewActions) {
    val kind = WikiLogic.cardKind(card, entry)?.let(WikiCopy::kindLabel) ?: ""
    val `when` = card.changeset.createdAt?.let { WikiDate.relative(it, now) }
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            Text(WikiLogic.cardChip(card.op.op), Modifier.background(MaterialTheme.colorScheme.primary.copy(alpha = 0.12f), RoundedCornerShape(4.dp))
                .padding(horizontal = 6.dp, vertical = 2.dp), style = WikiType.meta.copy(fontFamily = FontFamily.Monospace, fontWeight = FontWeight.Bold),
                color = MaterialTheme.colorScheme.primary)
            Text(kind.ifEmpty { WikiCopy.entryWord }, style = WikiType.label.copy(fontWeight = FontWeight.SemiBold))
        }
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(WikiCopy.proposedBy, style = WikiType.label, color = WikiPalette.secondary)
            val session = card.changeset.sessionId
            // The name takes what the label and the time leave, and is the one cut short (iOS's `.lineLimit(1)`).
            if (session != null) TextButton(onClick = { actions.openSession(session) }, contentPadding = PaddingValues(horizontal = 4.dp),
                modifier = Modifier.weight(1f, fill = false).heightIn(min = 48.dp).testTag("wiki-review-proposer")) {
                Text(WikiLogic.proposedBy(card.changeset), style = WikiType.label, maxLines = 1,
                    overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis)
            } else Text(WikiLogic.proposedBy(card.changeset), Modifier.weight(1f, fill = false), style = WikiType.label, color = WikiPalette.secondary)
            `when`?.let { Text("· $it", style = WikiType.label, color = WikiPalette.secondary) }
        }
    }
}

/** What a challenge is about, in the amber a Web-derived card wears: each anchor that broke and the commit of main it
 * was checked on; a challenge about something else says its own reason. */
@Composable
private fun ChallengeLine(op: WikiChangesetOp, entry: WikiEntry?) {
    val broken = WikiModeLogic.brokenAnchors(entry?.anchors)
    val ref = WikiModeLogic.challengeRef(entry?.anchors)
    val secondary = WikiPalette.secondary
    val text = buildAnnotatedString {
        if (broken.isEmpty()) {
            withStyle(SpanStyle(fontWeight = FontWeight.Bold)) { append(WikiModeCopy.challenged) }
            append(" · " + (op.payload["reason"].text() ?: WikiModeCopy.challengeWaits))
        } else {
            broken.forEachIndexed { i, anchor ->
                if (i > 0) append("; ")
                withStyle(SpanStyle(fontWeight = FontWeight.Bold)) { append(if (anchor.state == "changed") "Changed" else "Missing") }
                append(" · " + anchor.label)
            }
            if (ref != null) withStyle(SpanStyle(color = secondary)) { append(" · " + WikiModeCopy.checkedOnMain(ref)) }
        }
    }
    Row(Modifier.fillMaxWidth().background(WikiPalette.amberWash, RoundedCornerShape(10.dp)).padding(10.dp).testTag("wiki-review-challenge")
        .semantics(mergeDescendants = true) {}, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Text("◎", Modifier.clearAndSetSemantics {}, style = WikiType.label, color = Color(0xFFFF9500))
        Text(text, style = WikiType.label)
    }
}

/** A retire: why, what backs it, and what happens after. */
@Composable
private fun RetireFields(op: WikiChangesetOp) {
    val sources = sourceLines(op)
    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Labelled(WikiCopy.reasonLabel, listOf(op.payload["reason"].text() ?: "—"))
        Labelled(WikiCopy.evidenceLabel, sources.ifEmpty { listOf("—") })
        Labelled(WikiCopy.afterLabel, listOf(WikiCopy.afterRetire))
    }
}

/** Anything else: an amendment's diff, or the proposal's fields; then its sources, anchors and the entries it resembles. */
@Composable
private fun CardContent(card: WikiLogic.ReviewCard, entry: WikiEntry?) {
    val op = card.op
    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        val hunks = WikiLogic.changesDiff(entryContent(entry), op.payload["changes"])
        if (hunks.isNotEmpty()) hunks.forEach { Diff(it) }
        else {
            val fields = op.payload["entry"]["fields"] ?: entry?.fields
            WikiLogic.fieldRows(WikiLogic.cardKind(card, entry), fields).forEach { row -> Labelled(row.label, row.lines) }
        }
        Labelled(WikiCopy.sources, sourceLines(op).ifEmpty { listOf("—") })
        Labelled(WikiCopy.anchors, WikiLogic.reviewAnchorLines(op.payload["entry"], entry?.anchors).ifEmpty { listOf("—") }, mono = true)
        Similar(op.similar.orEmpty())
    }
}

/** The named entry's current content, as a diff reads its "before". */
private fun entryContent(entry: WikiEntry?): JsonElement? = entry?.let {
    buildJsonObject {
        it.title?.let { v -> put("title", v) }
        it.summary?.let { v -> put("summary", v) }
        it.fields?.let { v -> put("fields", v) }
        it.topics?.let { v -> put("topics", JsonArray(v.map(::JsonPrimitive))) }
        it.aliases?.let { v -> put("aliases", JsonArray(v.map(::JsonPrimitive))) }
        it.anchors?.let { v -> put("anchors", io.orbitd.android.core.protocol.Wire.json.encodeToJsonElement(
            kotlinx.serialization.builtins.ListSerializer(WikiAnchor.serializer()), v)) }
    }
}

/** The quotes the proposal cites, each the way the web lists it — the quote, then that it has not been checked yet. */
private fun sourceLines(op: WikiChangesetOp): List<String> = (op.payload["sources"] as? JsonArray).orEmpty().mapNotNull { source ->
    val word = WikiLogic.sourceWord(source["kind"].text())
    val quote = source["quote"].text()
    if (quote.isNullOrEmpty()) word.ifEmpty { null } else "“$quote” — $word · ${WikiCopy.quoteUnverified}"
}

/** What the proposal resembles, and the note that says none. */
@Composable
private fun Similar(matches: List<WikiSimilar>) {
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            Text(WikiCopy.similarEntries, style = WikiType.label.copy(fontWeight = FontWeight.SemiBold))
            if (matches.isEmpty()) Text(WikiCopy.similarNone, style = WikiType.label, color = WikiPalette.secondary)
        }
        matches.forEach { match ->
            Text(listOf(match.title ?: match.id, match.kind?.let(WikiCopy::kindLabel) ?: "").filter { it.isNotEmpty() }.joinToString(" · "),
                style = WikiType.label, color = WikiPalette.secondary)
        }
    }
}

@Composable
private fun Labelled(label: String, lines: List<String>, mono: Boolean = false) {
    Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
        Text(label, style = WikiType.label, color = WikiPalette.secondary)
        // The dash that says "none" is a word, not code, whatever the row holds.
        lines.forEach { line -> Text(line, if (line == "—") Modifier.semantics { contentDescription = WikiCopy.similarNone } else Modifier,
            style = if (mono && line != "—") WikiType.mono else WikiType.prose) }
    }
}

/** One field's red and green lines. */
@Composable
private fun Diff(hunk: WikiDiffHunk) {
    Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
        Text(hunk.label, style = WikiType.label, color = WikiPalette.secondary)
        Column(Modifier.fillMaxWidth().background(Color.Transparent, RoundedCornerShape(8.dp))) {
            hunk.lines.forEach { line ->
                Text("${if (line.added) "+" else "-"} ${line.text}", Modifier.fillMaxWidth()
                    .background((if (line.added) Color(0xFF34C759) else Color(0xFFFF3B30)).copy(alpha = 0.12f))
                    .padding(horizontal = 8.dp, vertical = 3.dp), style = WikiType.mono)
            }
        }
    }
}
