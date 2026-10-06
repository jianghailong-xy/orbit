package io.orbitd.android.wiki

import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.unit.dp
import io.orbitd.android.OrbitApplication
import io.orbitd.android.cards.BusinessCard
import io.orbitd.android.core.auth.*
import io.orbitd.android.core.cards.*
import io.orbitd.android.core.net.ApiError
import io.orbitd.android.core.realtime.ConnectionState
import io.orbitd.android.navigation.*
import io.orbitd.android.text.*
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.serialization.json.*
import java.util.UUID

internal class WikiUi(val page: WikiPage, val route: OrbitRoute, val api: WikiApi, val busy: Boolean, val fresh: Boolean,
    val open: (OrbitRoute) -> Unit, val link: (String) -> Unit, val write: (suspend () -> Unit) -> Unit) {
    val spaceId get() = page.space?.text("id") ?: route.wikiSpaceId
    fun go(destination: Destination, id: String? = null, part: Int = 0, section: String? = null, version: Int? = null) =
        open(OrbitRoute(destination, id, wikiSpaceId = spaceId, wikiPart = part, wikiSection = section, wikiVersion = version))
}

/** All Wiki screens stay on A05's existing navigation stack, so a source returns to the same page. */
@Composable
fun WikiDestination(app: OrbitApplication, handle: SessionHandle, route: OrbitRoute, revision: Long, open: (OrbitRoute) -> Unit) {
    val api = remember(handle) { WikiApi(app.session, handle) {
        (app.session.state.value as? AuthState.SignedIn)?.handle === handle &&
            app.realtime.state.value.handle === handle && app.realtime.state.value.controlConnection == ConnectionState.CONNECTED
    } }
    val scope = rememberCoroutineScope()
    val accountKey = handle.account.toString()
    var selected by rememberSaveable(accountKey, route) {
        mutableStateOf(route.wikiSpaceId ?: route.id.takeIf { route.destination == Destination.WIKI })
    }
    var refresh by remember { mutableIntStateOf(0) }
    var page by remember(handle, route) { mutableStateOf<WikiPage?>(null) }
    var loading by remember(handle, route) { mutableStateOf(true) }
    var fresh by remember(handle, route) { mutableStateOf(false) }
    var failure by remember(handle, route) { mutableStateOf<String?>(null) }
    var notice by remember(handle, route) { mutableStateOf<String?>(null) }
    var busy by remember(handle, route) { mutableStateOf(false) }
    var uncertain by rememberSaveable(accountKey, route.toString()) { mutableStateOf(false) }
    val auth by app.session.state.collectAsState()
    val realtime by app.realtime.state.collectAsState()
    val authorized = (auth as? AuthState.SignedIn)?.handle === handle
    val connected = authorized && realtime.handle === handle && realtime.controlConnection == ConnectionState.CONNECTED
    LaunchedEffect(api, route, selected, refresh, revision, connected) {
        fresh = false; loading = true; failure = null
        if (!connected) { loading = false; return@LaunchedEffect }
        try {
            page = api.page(route, selected)
            fresh = true
        } catch (cancel: CancellationException) { throw cancel }
        catch (error: Exception) { if (error is ApiError && error.status in setOf(403, 404)) page = null; failure = wikiError(error) }
        finally { loading = false }
    }
    if (!authorized) return
    val readable by rememberUpdatedState(authorized && page != null)
    val resources = remember(handle, route) { ReaderResources(app.session, handle, available = { readable }) }
    val link = rememberReaderLinkHandler(resources, open)
    CompositionLocalProvider(LocalReaderResources provides resources) {
        Column(Modifier.fillMaxSize().testTag("wiki-destination")) {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
                TextButton(onClick = { refresh++; uncertain = false }, enabled = !loading && !busy) { Text("Refresh") }
            }
            if (loading) LinearProgressIndicator(Modifier.fillMaxWidth())
            if (!connected) Text("Reconnecting · refresh is required before making changes.", Modifier.padding(16.dp))
            failure?.let { Text(it, Modifier.padding(16.dp), color = MaterialTheme.colorScheme.error) }
            notice?.let { Text(it, Modifier.padding(16.dp), color = MaterialTheme.colorScheme.error) }
            if (uncertain) Text("The request may have reached Orbit. Refresh and check its state before acting again.", Modifier.padding(16.dp))
            val loaded = page
            if (loaded == null) {
                if (!loading) TextButton(onClick = { refresh++ }) { Text("Retry") }
            } else {
                val ui = WikiUi(loaded, route, api, busy, fresh && connected && !uncertain, open, link) { work ->
                    if (!busy && fresh && connected && !uncertain) {
                        busy = true; notice = null
                        scope.launch {
                            try { work(); refresh++ }
                            catch (cancel: CancellationException) { throw cancel }
                            catch (error: Exception) {
                                notice = wikiError(error)
                                uncertain = error !is ApiError && error !is IllegalArgumentException && error !is IllegalStateException || error is ApiError && error.status >= 500
                                fresh = false
                                if (error is ApiError && error.status in setOf(401, 403, 404)) page = null
                                refresh++
                            } finally { busy = false }
                        }
                    }
                }
                key(route) {
                    when (route.destination) {
                        Destination.WIKI -> WikiHome(ui) { id -> selected = id }
                        Destination.WIKI_BROWSE, Destination.WIKI_INDEX -> WikiDirectory(ui)
                        Destination.WIKI_ARTICLE -> WikiArticle(ui)
                        Destination.WIKI_DOC -> WikiDocument(ui)
                        Destination.WIKI_ENTRY -> WikiEntry(ui)
                        Destination.WIKI_REVIEW -> WikiReview(ui)
                        Destination.WIKI_RUN -> WikiRun(ui)
                        Destination.WIKI_SETTINGS -> WikiSettings(ui)
                        Destination.WIKI_PLAN, Destination.WIKI_PLAN_DOC, Destination.WIKI_PLAN_SECTION -> WikiPlan(ui)
                        else -> Unit
                    }
                }
            }
        }
    }
}

@Composable
internal fun WikiPageColumn(content: @Composable ColumnScope.() -> Unit) {
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        content(); Spacer(Modifier.height(24.dp))
    }
}
@Composable internal fun WikiHeading(title: String) { Text(title, style = MaterialTheme.typography.titleLarge) }
@Composable internal fun WikiWords(value: String?, ui: WikiUi) { if (!value.isNullOrBlank()) MarkdownText(value, open = ui.link) }
@Composable internal fun WikiRow(title: String, detail: String? = null, tag: String = title, enabled: Boolean = true, ended: Boolean = false, click: () -> Unit) {
    Column(Modifier.fillMaxWidth().heightIn(min = 48.dp).testTag(tag).clickable(enabled = enabled, onClick = click).padding(vertical = 8.dp)) {
        Text(title, style = MaterialTheme.typography.titleMedium, textDecoration = if (ended) TextDecoration.LineThrough else null)
        if (!detail.isNullOrBlank()) Text(detail, style = MaterialTheme.typography.bodySmall)
    }
}
@Composable internal fun WikiEntryRow(entry: JsonObject, ui: WikiUi) {
    WikiRow(entry.label(), listOfNotNull(entry.text("kind"), entry.text("trust"), entry.text("summary")).joinToString(" · "),
        tag = "wiki-entry:${entry.text("id")}", ended = entry.ended()) { ui.go(Destination.WIKI_ENTRY, entry.text("id")) }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable internal fun WikiContents(ui: WikiUi) {
    var shown by rememberSaveable { mutableStateOf(false) }
    TextButton(onClick = { shown = true }, Modifier.testTag("wiki-contents")) { Text("Contents") }
    if (shown) ModalBottomSheet(onDismissRequest = { shown = false }) {
        Column(Modifier.padding(16.dp).verticalScroll(rememberScrollState())) {
            WikiHeading("Contents")
            listOf("Wiki home" to Destination.WIKI, "Browse by category" to Destination.WIKI_BROWSE, "A–Z index" to Destination.WIKI_INDEX, "Wiki plan" to Destination.WIKI_PLAN).forEach { (title, destination) ->
                WikiRow(title) { shown = false; ui.go(destination, if (destination == Destination.WIKI) ui.spaceId else null) }
            }
            var directory by remember { mutableStateOf<WikiPage?>(null) }
            var error by remember { mutableStateOf<String?>(null) }
            LaunchedEffect(ui.spaceId) { try { directory = ui.api.page(OrbitRoute(Destination.WIKI_BROWSE, wikiSpaceId = ui.spaceId), ui.spaceId) }
                catch (cancel: CancellationException) { throw cancel } catch (e: Exception) { error = wikiError(e) } }
            error?.let { Text(it) }
            directory?.let { value -> WikiDirectoryRows(value.content, ui) { destination, id, part, section -> shown = false; ui.go(destination, id, part, section) } }
        }
    }
}

@Composable private fun WikiHome(ui: WikiUi, select: (String) -> Unit) {
    val page = ui.page
    var query by rememberSaveable { mutableStateOf("") }
    var hits by remember { mutableStateOf<List<JsonObject>>(emptyList()) }
    var searching by remember { mutableStateOf(false) }
    var searchError by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(query, ui.spaceId) {
        hits = emptyList(); searchError = null; searching = query.isNotBlank()
        if (query.isNotBlank() && ui.spaceId != null) {
            delay(250)
            try { hits = ui.api.search(ui.spaceId!!, query) }
            catch (cancel: CancellationException) { throw cancel } catch (error: Exception) { searchError = wikiError(error) }
        }
        searching = false
    }
    WikiPageColumn {
        WikiHeading("Wiki")
        if (page.spaces.isEmpty()) Text("No wiki spaces yet.")
        else {
            var menu by remember { mutableStateOf(false) }
            Box {
                TextButton(onClick = { menu = true }) { Text(page.space?.text("slug") ?: "Choose a space") }
                DropdownMenu(menu, { menu = false }) { page.spaces.forEach { space -> DropdownMenuItem(text = { Text(space.text("slug") ?: space.label()) }, onClick = { menu = false; select(space.text("id")!!) }) } }
            }
            Row { WikiContents(ui); TextButton(onClick = { ui.go(Destination.WIKI_SETTINGS) }, Modifier.testTag("wiki-settings")) { Text("Wiki settings") } }
            val health = page.extras["health"]
            Text("${health?.number("entries") ?: page.rows.count { !it.ended() }} entries")
            health?.obj("maintenance")?.let { maintenance ->
                Text("Maintenance · ${maintenance.text("look") ?: "unknown"} · ${maintenance.number("backlog") ?: 0} waiting")
                maintenance.obj("held")?.text("reason")?.let { Text(it.replace('_', ' ')) }
                maintenance.obj("lastFailure")?.text("reason")?.let { Text(it, color = MaterialTheme.colorScheme.error) }
                val session = maintenance.obj("lastRun")?.text("sessionId")
                if (session != null) TextButton(onClick = { ui.open(OrbitRoute(Destination.SESSION, session)) }) { Text("View run") }
            }
            OutlinedTextField(query, { query = it }, Modifier.fillMaxWidth().testTag("wiki-search"), label = { Text("Search this wiki") }, singleLine = true)
            if (query.isNotBlank()) {
                if (searching) CircularProgressIndicator()
                searchError?.let { Text(it, color = MaterialTheme.colorScheme.error) }
                if (!searching && searchError == null && hits.isEmpty()) Text("No results for “$query”.")
                hits.forEach { hit ->
                    WikiEntryRow(hit, ui)
                    val why = hit.strings("match")
                    if (why.isNotEmpty()) Text(why.joinToString(" · "), style = MaterialTheme.typography.bodySmall)
                }
            } else {
                val pending = page.spaces.sumOf { it.number("pendingOps") ?: 0 }
                if (pending > 0) WikiRow("$pending proposals to review", tag = "wiki-review") { ui.go(Destination.WIKI_REVIEW) }
                page.extras["plan"]?.let { state ->
                    val count = state.objects("proposals").count { it.text("status") == "pending" }
                    val draft = state.obj("draft"); val job = state.obj("job")
                    if (draft != null || count > 0 || job != null) WikiRow("Wiki plan", listOfNotNull(draft?.let { "Draft v${it.number("version")}" }, if (count > 0) "$count proposed changes" else null, job?.text("state")).joinToString(" · "), "wiki-plan") {
                        ui.go(if (job?.text("state") == "held") Destination.WIKI_SETTINGS else Destination.WIKI_PLAN)
                    }
                }
                WikiHeading("Principles")
                val principles = page.rows.filter { it.text("kind") == "principle" }.sortedBy { it.text("recordedAt") }
                if (principles.isEmpty()) Text("No entries yet.") else principles.forEach { WikiEntryRow(it, ui) }
                WikiHeading("Recent decisions")
                val decisions = page.rows.filter { it.text("kind") == "decision" }.sortedByDescending { it.text("validFrom") }.take(4)
                if (decisions.isEmpty()) Text("No decisions yet.") else decisions.forEach { WikiEntryRow(it, ui) }
                WikiHeading("Recently changed")
                val timeline = page.extras["timeline"]?.objects("items").orEmpty()
                if (timeline.isEmpty()) Text("No changes yet.")
                timeline.distinctBy { if (it.text("origin") in setOf("maintenance", "watch", "import") && it.text("changesetId") != null) it.text("changesetId") else it.text("id") ?: it.toString() }.take(5).forEach { change ->
                    val run = change.text("changesetId")?.takeIf { change.text("origin") in setOf("maintenance", "watch", "import") }
                    WikiRow(change.text("title") ?: change.text("origin") ?: "Wiki change", listOfNotNull(change.text("op"), change.text("at")).joinToString(" · ")) {
                        if (run != null) ui.go(Destination.WIKI_RUN, run) else change.text("entryId")?.let { ui.go(Destination.WIKI_ENTRY, it) }
                    }
                }
                WikiHeading("Agents used the wiki")
                val usage = page.space?.obj("usage")
                Text("${usage?.number("sessionsPushed") ?: 0} sessions received · ${usage?.number("searches") ?: 0} searches")
                usage?.objects("entries")?.take(3)?.forEach { used -> WikiRow(used.label(), "${used.number("total") ?: 0} uses") { ui.go(Destination.WIKI_ENTRY, used.text("entryId")) } }
                page.warnings.forEach { Text(it, color = MaterialTheme.colorScheme.error) }
            }
        }
    }
}

@Composable private fun WikiEntry(ui: WikiUi) {
    val entry = ui.page.content
    var form by rememberSaveable { mutableStateOf<String?>(null) }
    val clipboard = LocalClipboardManager.current
    val server = LocalReaderResources.current?.handle?.account?.server?.trimEnd('/')
    val slug = ui.page.space?.text("slug")
    WikiPageColumn {
        WikiHeading(entry.label())
        Text(listOfNotNull(entry.text("kind"), entry.text("status"), entry.text("trust")).joinToString(" · "))
        WikiWords(entry.text("summary"), ui)
        if (entry.flag("tainted")) Text("Web-derived · Review the original sources before confirming.")
        if (entry.flag("challenged")) Text("Challenged · An anchor changed or is missing.", color = MaterialTheme.colorScheme.error)
        if (entry.flag("unsupported")) Text("Unsupported by the current sources.", color = MaterialTheme.colorScheme.error)
        if (!entry.ended()) {
            Row {
                TextButton(onClick = { form = "amend" }, enabled = ui.fresh && !ui.busy, modifier = Modifier.testTag("wiki-edit")) { Text("Edit") }
                TextButton(onClick = { form = "supersede" }, enabled = ui.fresh && !ui.busy) { Text("Supersede") }
                TextButton(onClick = { form = "retire" }, enabled = ui.fresh && !ui.busy) { Text("Retire") }
            }
        }
        TextButton(enabled = server != null && slug != null, onClick = {
            clipboard.setText(AnnotatedString("$server/wiki/$slug/e/${entry.text("id")}"))
        }) { Text("Copy link") }
        wikiEntryCards(entry).filter { it.actions.isNotEmpty() }.forEach { WikiInteraction(it, ui) }
        entry.text("changesetId")?.let { id -> WikiRow("View run") { ui.go(Destination.WIKI_RUN, id) } }
        entry.text("supersededById")?.let { id -> WikiRow("Replaced by") { ui.go(Destination.WIKI_ENTRY, id) } }
        entry.text("supersedesId")?.let { id -> WikiRow("Replaces") { ui.go(Destination.WIKI_ENTRY, id) } }
        WikiHeading("Details")
        WikiFields(entry.obj("fields"), ui)
        WikiHeading("Sources")
        if (entry.objects("sources").isEmpty()) Text("No sources.")
        entry.objects("sources").forEach { WikiSource(it, ui) }
        WikiHeading("Anchors")
        if (entry.objects("anchors").isEmpty()) Text("No anchors.")
        entry.objects("anchors").forEach { anchor ->
            Text(listOfNotNull(anchor.text("type"), anchor.text("path"), anchor.text("symbol"), anchor.text("sha"), anchor.text("ref"), anchor.text("command"), anchor.text("criterionId")).joinToString(" · "))
            Text(listOfNotNull(anchor.obj("check")?.text("state") ?: "unchecked", anchor.obj("check")?.text("ref")).joinToString(" · "), style = MaterialTheme.typography.bodySmall)
        }
        WikiHeading("Where used")
        if (entry.objects("exposure").isEmpty()) Text("No sessions yet.")
        entry.objects("exposure").forEach { exposure -> exposure.text("sessionId")?.let { id -> WikiRow("Open session", listOfNotNull(exposure.text("channel"), exposure.text("at")).joinToString(" · ")) { ui.open(OrbitRoute(Destination.SESSION, id)) } } }
        WikiHeading("History")
        entry.objects("history").forEach { row ->
            Text("Revision ${row.number("revision") ?: "—"} · ${row.text("authorKind") ?: "—"} · ${row.text("createdAt") ?: ""}")
            WikiWords(row.text("title"), ui); WikiWords(row.text("summary"), ui)
            row.text("authorSessionId")?.let { id -> TextButton(onClick = { ui.open(OrbitRoute(Destination.SESSION, id)) }) { Text("Open author session") } }
        }
    }
    form?.let { operation -> WikiEntryForm(entry, operation, ui) { form = null } }
}

@Composable internal fun WikiFields(fields: JsonObject?, ui: WikiUi) {
    fields?.forEach { (key, value) ->
        Text(key.replace('_', ' ').replaceFirstChar(Char::uppercase), style = MaterialTheme.typography.titleSmall)
        when (value) {
            is JsonPrimitive -> WikiWords(value.contentOrNull, ui)
            is JsonArray -> value.forEach { item -> if (item is JsonPrimitive) WikiWords("• ${item.content}", ui) else if (item is JsonObject) WikiFields(item, ui) }
            is JsonObject -> WikiFields(value, ui)
        }
    }
}

@Composable internal fun WikiSource(source: JsonObject, ui: WikiUi, footnote: Boolean = false) {
    val target = wikiSourceRoute(source, footnote)
    val repo = wikiRepositoryLink(source, ui.page.space?.text("repoUrlNorm"))
    val unavailable = source.text("state") in setOf("deleted", "trashed")
    Surface(shape = MaterialTheme.shapes.medium, color = MaterialTheme.colorScheme.surfaceVariant) {
        Column(Modifier.fillMaxWidth().padding(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Text(listOfNotNull(source.number("n")?.let { "[$it]" }, source.text("kind"), source.text("label") ?: source.text("sessionTitle") ?: source.text("taskTitle")).joinToString(" · "))
            if (!unavailable) WikiWords(source.text("quote"), ui)
            Text(if (unavailable) "Source ${source.text("state")}." else source.text("verdict")?.replace('_', ' ') ?: if (source.flag("quoteVerified")) "Quote verified" else "Quote unverified", style = MaterialTheme.typography.bodySmall)
            source.text("location")?.let { Text(it, style = MaterialTheme.typography.bodySmall) }
            source.text("excerpt")?.let { WikiWords("```\n$it\n```", ui) }
            if (target != null || repo != null) TextButton(onClick = { if (target != null) ui.open(target) else ui.link(repo!!) }, Modifier.testTag("wiki-source:${source.text("id") ?: source.number("n")}")) { Text("Open original source") }
            source.text("viaEntryId")?.let { id -> TextButton(onClick = { ui.go(Destination.WIKI_ENTRY, id) }) { Text("Via Wiki entry") } }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable private fun WikiEntryForm(entry: JsonObject, operation: String, ui: WikiUi, close: () -> Unit) {
    var title by rememberSaveable(operation) { mutableStateOf(entry.text("title").orEmpty()) }
    var summary by rememberSaveable(operation) { mutableStateOf(entry.text("summary").orEmpty()) }
    var reason by rememberSaveable(operation) { mutableStateOf("") }
    val key = rememberSaveable(operation) { UUID.randomUUID().toString() }
    ModalBottomSheet(onDismissRequest = { if (!ui.busy) close() }) {
        Column(Modifier.padding(16.dp).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            WikiHeading(if (operation == "amend") "Edit entry" else operation.replaceFirstChar(Char::uppercase))
            if (operation == "retire") {
                Text("Agents stop getting this entry. It stays in History.")
                OutlinedTextField(reason, { reason = it }, Modifier.fillMaxWidth(), label = { Text("Why retire this entry?") })
            } else {
                OutlinedTextField(title, { title = it }, Modifier.fillMaxWidth().testTag("wiki-edit-title"), label = { Text("Title") })
                OutlinedTextField(summary, { summary = it }, Modifier.fillMaxWidth().testTag("wiki-edit-summary"), label = { Text("One-line summary") })
            }
            Button(onClick = { ui.write { ui.api.ownerWrite(entry, operation, title, summary, reason, key); close() } },
                enabled = ui.fresh && !ui.busy && if (operation == "retire") reason.isNotBlank() else title.isNotBlank() && summary.isNotBlank(), modifier = Modifier.testTag("wiki-edit-save")) { Text(if (operation == "amend") "Save" else operation.replaceFirstChar(Char::uppercase)) }
            TextButton(onClick = close, enabled = !ui.busy) { Text("Cancel") }
        }
    }
}

@Composable internal fun WikiInteraction(card: InteractionCard, ui: WikiUi) {
    var result by remember(card.key, card.binding) { mutableStateOf(CardActionState()) }
    BusinessCard(card, ui.fresh && !ui.busy, result, ui.link) { verb, input ->
        ui.write {
            result = CardActionState(busy = true)
            try { val response = ui.api.cardAction(card, verb, input); result = CardActionState(settled = true, message = "Recorded by Orbit.", response = response) }
            catch (error: Exception) { result = CardActionState(message = wikiError(error)); throw error }
        }
    }
}

@Composable private fun WikiReview(ui: WikiUi) {
    var filter by rememberSaveable { mutableStateOf("All") }
    val cards = ui.page.rows.flatMap(::wikiChangesetCards).filter {
        it.source.text("decision") == "pending" && !it.key.startsWith("wiki-revert:") && when (filter) {
            "Add" -> it.source.text("op") == "add"
            "Amend" -> it.source.text("op") in setOf("amend", "supersede")
            "Retire" -> it.source.text("op") == "retire"
            else -> true
        }
    }
    var position by rememberSaveable { mutableIntStateOf(0) }
    WikiPageColumn {
        WikiHeading("Review")
        Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            listOf("All", "Add", "Amend", "Retire").forEach { name ->
                FilterChip(filter == name, { filter = name; position = 0 }, label = { Text(name) })
            }
        }
        if (cards.isEmpty()) Text("All caught up. No proposals waiting for review.")
        else {
            val index = position.coerceIn(0, cards.lastIndex)
            Text("${index + 1} of ${cards.size}")
            val card = cards[index]
            val changeset = ui.page.rows.firstOrNull { it.text("id") == card.source.text("changesetId") }
            changeset?.text("sessionId")?.let { id -> WikiRow("Proposed by ${changeset.text("origin") ?: "agent"}") { ui.open(OrbitRoute(Destination.SESSION, id)) } }
            WikiWords(changeset?.text("rationale"), ui)
            WikiInteraction(card, ui)
            Row {
                TextButton(onClick = { position = index - 1 }, enabled = index > 0 && !ui.busy) { Text("Previous") }
                TextButton(onClick = { position = index + 1 }, enabled = index < cards.lastIndex && !ui.busy) { Text("Next") }
            }
        }
    }
}

@Composable private fun WikiRun(ui: WikiUi) {
    val run = ui.page.content
    WikiPageColumn {
        WikiHeading("${run.text("origin") ?: "Wiki"} run")
        WikiWords(run.text("rationale"), ui)
        Text(listOfNotNull(run.text("appliedByMode"), run.text("createdAt")).joinToString(" · "))
        run.text("sessionId")?.let { id -> WikiRow("Open session") { ui.open(OrbitRoute(Destination.SESSION, id)) } }
        WikiFields(run.obj("counts"), ui)
        wikiChangesetCards(run).filter { it.key.startsWith("wiki-revert:") }.forEach { WikiInteraction(it, ui) }
        run.objects("ops").forEach { op ->
            val entryId = op.text("resultEntryId") ?: op.text("entryId")
            val entry = run.objects("entries").firstOrNull { ObjectId.same(it.text("id"), entryId) }
            WikiRow(entry?.label() ?: op.obj("payload")?.obj("entry")?.label() ?: op.text("op") ?: "Change", listOfNotNull(op.text("decision"), op.text("decisionReason"), op.obj("verification")?.text("reason")).joinToString(" · "), enabled = entryId != null) { ui.go(Destination.WIKI_ENTRY, entryId) }
            entry?.let { wikiEntryCards(it).filter { card -> card.actions.isNotEmpty() }.forEach { card -> WikiInteraction(card, ui) } }
        }
    }
}
