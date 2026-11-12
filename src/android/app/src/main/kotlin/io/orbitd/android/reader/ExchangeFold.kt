package io.orbitd.android.reader

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.orbitd.android.OrbitApplication
import io.orbitd.android.core.auth.SessionHandle
import io.orbitd.android.core.cards.OrbitExchangeFold
import io.orbitd.android.core.cards.obj
import io.orbitd.android.core.cards.text
import io.orbitd.android.navigation.ObjectId
import io.orbitd.android.projects.ProjectApi
import io.orbitd.android.watch.watchText
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/** One turn Orbit opened, folded with everything the agent did and said under it ([ExchangeFold.fold]). */
@Immutable
internal data class FoldedExchange(val summary: OrbitExchangeFold.Summary, val rows: List<TranscriptRow>)

/**
 * The turns Orbit opened, folded (web `foldOrbitExchanges`, design docs/mocks/coordinator-exchange-fold/): the rows cut into turns —
 * each opens at a message that is not a steer — with the turns Orbit opened folded, runs of them together into one row. A turn stays
 * drawn when it is the last (what the reader opened the conversation to see, maybe still running), when the agent has not answered it
 * (it is already the one line its card draws), and when it asks the reader something or went wrong.
 */
internal object ExchangeFold {
    private val asksTheOwner = Regex("(^|__|\\.)(ask_owner|request_owner_action)$")

    fun fold(rows: List<TranscriptRow>, wakeName: (String, JsonObject) -> String? = { _, _ -> null }): List<TranscriptRow> {
        val turns = mutableListOf<MutableList<TranscriptRow>>()
        rows.forEach { row ->
            val opens = row.event.type == "user" && row.event.fields["steer"] != JsonPrimitive(true)
            if (opens || turns.isEmpty()) turns += mutableListOf(row) else turns.last() += row
        }
        val out = ArrayList<TranscriptRow>(rows.size)
        var run = mutableListOf<FoldedExchange>()
        fun flush() {
            if (run.isNotEmpty()) out += TranscriptRow(run.first().rows.first().event.copy(type = TYPE), exchanges = run)
            run = mutableListOf()
        }
        turns.forEachIndexed { index, turn ->
            val head = if (index < turns.lastIndex) OrbitExchangeFold.turnOf(turn.first().event, wakeName) else null
            val replies = turn.filter { it.event.type == "assistant" && it.event.body().isNotBlank() }
            if (head != null && replies.isNotEmpty() && !needsReader(turn)) {
                run += FoldedExchange(OrbitExchangeFold.Summary(turn.first().event.seq, turn.maxOf { it.newestSeq }, turn.first().event.ts,
                    head.what, head.whatInTask, OrbitExchangeFold.replyGist(replies.last().event.body()), head.category, head.target), turn)
                return@forEachIndexed
            }
            flush()
            out += turn
        }
        flush()
        return out
    }

    /** A turn that asks the reader something, or went wrong, stays in view whatever opened it. */
    private fun needsReader(turn: List<TranscriptRow>) = turn.flatMap { listOf(it) + it.steps }.any { row ->
        row.event.type in setOf("error", "auth_error", MainCheckout.ROW_CARD) ||
            row.event.type == "tool_use" && asksTheOwner.containsMatchIn(row.event.fields.string("name") ?: row.event.fields.string("toolName").orEmpty())
    }

    /** The type of a row that folds exchanges: no `user` row, so the sticky bar never names it as a question. */
    const val TYPE = "orbit_exchanges"
}

/**
 * What places a folded turn under its task, and how to ask for the rest: the project's dependency graph is read only once a group is
 * opened ([want]), so a conversation nobody opens a group in costs no request (web `ExchangeTreeCtx`).
 */
internal class ExchangeTree(val lookup: OrbitExchangeFold.Lookup, val want: () -> Unit)

internal val LocalExchangeTree = compositionLocalOf { ExchangeTree(OrbitExchangeFold.NoLookup) {} }

/**
 * The tree's lookup for one conversation: which task a session runs, from the directory rows this app already holds, and which tasks
 * a task waits on, from its project's dependency graph — read the first time a group is opened, in a conversation that belongs to a
 * project ([detail]'s `projectId`). A conversation outside any project reads nothing, and its groups list exchanges by task.
 */
@Composable
internal fun rememberExchangeTree(app: OrbitApplication, handle: SessionHandle, detail: JsonObject?): ExchangeTree {
    val project = detail?.text("projectId") ?: detail?.obj("project")?.text("id")
    var wanted by remember(handle) { mutableStateOf(false) }
    var graph by remember(handle, project) { mutableStateOf<JsonObject?>(null) }
    LaunchedEffect(wanted, project) {
        if (!wanted || project == null || graph != null) return@LaunchedEffect
        graph = try { ProjectApi(app.session, handle).graph(project) } catch (cancel: CancellationException) { throw cancel } catch (_: Exception) { null }
    }
    val directory by remember(app, handle) {
        app.realtime.state.map { if (it.handle === handle) it.directory else null }.distinctUntilChanged()
    }.collectAsState(null)
    return remember(graph, directory) {
        val canonical = { id: String -> ObjectId.canonical(id) ?: id }
        val (upstream, titles) = OrbitExchangeFold.upstreamFromGraph(graph, canonical)
        val taskOf = directory?.sessions?.values?.flatten()?.mapNotNull { row ->
            val id = row["id"].watchText() ?: return@mapNotNull null
            val task = row["taskId"].watchText()?.takeIf { it.isNotEmpty() } ?: return@mapNotNull null
            canonical(id) to task
        }?.toMap().orEmpty()
        ExchangeTree(object : OrbitExchangeFold.Lookup {
            override fun taskOfSession(sessionId: String): Pair<String, String?>? = taskOf[canonical(sessionId)]?.let { it to titles(it) }
            override fun upstreamOf(taskId: String) = upstream(taskId)
            override fun taskTitle(taskId: String) = titles(taskId)
            override fun key(id: String) = canonical(id)
        }) { wanted = true }
    }
}

private fun clock(ts: String?): String = ts?.let { runCatching {
    DateTimeFormatter.ofLocalizedTime(FormatStyle.SHORT).format(Instant.parse(it).atZone(ZoneId.systemDefault()))
}.getOrNull() }.orEmpty()

private fun FoldedExchange.contains(seq: Long?) = seq != null && seq >= summary.seq && seq <= summary.lastSeq

/** A row that folds one exchange, or a run of them ([TranscriptRow.exchanges]). [target]: a record a link landed on, which opens the way down to it. */
/** [leaf]: how one of the folded rows is drawn once its exchange is opened — exactly as the reader draws it unfolded. */
@Composable
internal fun ExchangeFoldView(row: TranscriptRow, target: Long?, leaf: @Composable (TranscriptRow) -> Unit) {
    val exchanges = row.exchanges
    BoxWithConstraints(Modifier.fillMaxWidth().padding(horizontal = 10.dp, vertical = 2.dp).testTag("exchanges:${row.event.seq}")) {
        val compact = maxWidth < 600.dp
        if (exchanges.size == 1) ExchangeRowView(exchanges.single(), leaf, target, compact, inTask = false)
        else ExchangeGroupView(exchanges, leaf, target, compact)
    }
}

@Composable
private fun ExchangeGroupView(exchanges: List<FoldedExchange>, leaf: @Composable (TranscriptRow) -> Unit,
    target: Long?, compact: Boolean) {
    val tree = LocalExchangeTree.current
    var expanded by rememberSaveable(exchanges.first().summary.seq) { mutableStateOf(false) }
    LaunchedEffect(target) { if (exchanges.any { it.contains(target) }) expanded = true }
    LaunchedEffect(expanded) { if (expanded) tree.want() }
    val branches = remember(expanded, exchanges, tree.lookup) {
        if (expanded) OrbitExchangeFold.tree(exchanges, { it.summary.target }, tree.lookup) else null
    }
    val kinds = OrbitExchangeFold.kinds(exchanges.map { it.summary.category })
    val range = "${clock(exchanges.first().summary.ts)} – ${clock(exchanges.last().summary.ts)}"
    Column(Modifier.fillMaxWidth()) {
        FoldLine(expanded, { expanded = !expanded }, "exchanges-line", mark = "⋯") {
            Text(OrbitExchangeFold.handled(exchanges.size), color = MaterialTheme.colorScheme.onSurfaceVariant,
                style = MaterialTheme.typography.labelLarge, maxLines = 1)
            if (!compact && kinds.isNotEmpty()) Text("· $kinds", Modifier.weight(1f, fill = false), color = MaterialTheme.colorScheme.outline,
                style = MaterialTheme.typography.labelLarge, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Spacer(Modifier.weight(1f))
            Text(range, color = MaterialTheme.colorScheme.outline, style = MaterialTheme.typography.labelLarge, maxLines = 1)
        }
        if (expanded) Guide(2) {
            if (branches != null) branches.forEach { key(it.key) { BranchView(it, leaf, target, compact) } }
            else exchanges.forEach { key(it.summary.seq) { ExchangeRowView(it, leaf, target, compact, inTask = false) } }
        }
    }
}

@Composable
private fun BranchView(branch: OrbitExchangeFold.Branch<FoldedExchange>, leaf: @Composable (TranscriptRow) -> Unit,
    target: Long?, compact: Boolean) {
    val every = remember(branch) { OrbitExchangeFold.all(branch) { it.summary.seq } }
    var expanded by rememberSaveable(branch.key) { mutableStateOf(false) }
    LaunchedEffect(target) { if (every.any { it.contains(target) }) expanded = true }
    val below = OrbitExchangeFold.downstreamCount(branch)
    val own = branch.exchanges.size
    val latest = if (expanded) branch.exchanges.last() else every.last()
    val meta = if (expanded) OrbitExchangeFold.updates(own)
        else listOfNotNull(OrbitExchangeFold.updates(every.size), below.takeIf { it > 0 }?.let(OrbitExchangeFold::downstream),
            latest.summary.reply.takeIf { it.isNotEmpty() }?.let(OrbitExchangeFold::last)).joinToString(" · ")
    Column(Modifier.fillMaxWidth().testTag("branch:${branch.key}")) {
        FoldLine(expanded, { expanded = !expanded }, "branch-line", mark = null, caretFirst = true,
            under = if (compact && !expanded) meta else null) {
            Text(branch.title, Modifier.weight(1f, fill = compact), color = MaterialTheme.colorScheme.onSurface, fontWeight = FontWeight.Medium,
                style = MaterialTheme.typography.labelLarge, maxLines = 1, overflow = TextOverflow.Ellipsis)
            if (!compact) Text("· $meta", Modifier.weight(1f), color = MaterialTheme.colorScheme.outline,
                style = MaterialTheme.typography.labelLarge, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(clock(latest.summary.ts), color = MaterialTheme.colorScheme.outline, style = MaterialTheme.typography.labelLarge, maxLines = 1)
        }
        if (expanded) Guide(1) {
            branch.exchanges.forEach { key(it.summary.seq) { ExchangeRowView(it, leaf, target, compact, inTask = branch.key != "other") } }
            branch.children.forEach { key(it.key) { BranchView(it, leaf, target, compact) } }
        }
    }
}

@Composable
private fun ExchangeRowView(ex: FoldedExchange, leaf: @Composable (TranscriptRow) -> Unit, target: Long?, compact: Boolean, inTask: Boolean) {
    var expanded by rememberSaveable(ex.summary.seq) { mutableStateOf(false) }
    LaunchedEffect(target) { if (ex.contains(target)) expanded = true }
    val what = if (inTask) ex.summary.whatInTask ?: ex.summary.what else ex.summary.what
    val reply = ex.summary.reply
    Column(Modifier.fillMaxWidth().testTag("exchange:${ex.summary.seq}")) {
        FoldLine(expanded, { expanded = !expanded }, "exchange-line", mark = "→", under = if (compact && reply.isNotEmpty()) reply else null) {
            Text(what, Modifier.weight(1f, fill = compact), color = MaterialTheme.colorScheme.onSurfaceVariant,
                style = MaterialTheme.typography.labelLarge, maxLines = 1, overflow = TextOverflow.Ellipsis)
            if (!compact && reply.isNotEmpty()) Text("— $reply", Modifier.weight(1f), color = MaterialTheme.colorScheme.outline,
                style = MaterialTheme.typography.labelLarge, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(clock(ex.summary.ts), color = MaterialTheme.colorScheme.outline, style = MaterialTheme.typography.labelLarge, maxLines = 1)
        }
        if (expanded) Guide(2, Modifier.testTag("exchange-detail")) {
            ex.rows.forEach { row -> key(row.key) { leaf(row) } }
        }
    }
}

/** One fold's line: its mark, what it says, and a caret; on a phone, what it says under it ([under]) on a line of its own. */
@Composable
private fun FoldLine(expanded: Boolean, toggle: () -> Unit, tag: String, mark: String?, caretFirst: Boolean = false, under: String? = null,
    content: @Composable RowScope.() -> Unit) {
    val muted = MaterialTheme.colorScheme.outline
    Column(Modifier.fillMaxWidth().heightIn(min = 32.dp)
        .clickable(onClickLabel = if (expanded) "Hide" else "Show", role = Role.Button, onClick = toggle)
        .semantics { stateDescription = if (expanded) "Expanded" else "Collapsed" }.testTag(tag),
        verticalArrangement = Arrangement.Center) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(7.dp), verticalAlignment = Alignment.CenterVertically) {
            val caret: @Composable () -> Unit = {
                Text("▸", Modifier.rotate(if (expanded) 90f else 0f).clearAndSetSemantics { }, color = muted,
                    style = MaterialTheme.typography.labelLarge)
            }
            if (caretFirst) caret()
            mark?.let { Text(it, Modifier.clearAndSetSemantics { }, color = muted, style = MaterialTheme.typography.labelLarge) }
            content()
            if (!caretFirst) caret()
        }
        under?.let {
            Text(it, Modifier.padding(start = 20.dp), color = muted, style = MaterialTheme.typography.labelLarge, maxLines = 1,
                overflow = TextOverflow.Ellipsis)
        }
    }
}

/** What a fold opens to, behind a guide line down its left edge. */
@Composable
private fun Guide(width: Int, modifier: Modifier = Modifier, content: @Composable ColumnScope.() -> Unit) {
    val rule = MaterialTheme.colorScheme.outlineVariant
    Column(modifier.fillMaxWidth().padding(start = 4.dp).drawBehind { drawRect(rule, size = size.copy(width = width.dp.toPx())) }
        .padding(start = 10.dp), content = content)
}
