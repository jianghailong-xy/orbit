package io.orbitd.android.cards

import kotlinx.serialization.json.JsonObject
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.orbitd.android.OrbitApplication
import io.orbitd.android.R
import io.orbitd.android.core.auth.SessionHandle
import io.orbitd.android.core.cards.OwnerRequests
import io.orbitd.android.core.cards.OwnerReview
import io.orbitd.android.directory.DirectoryData
import io.orbitd.android.directory.DirectoryRunner
import io.orbitd.android.navigation.Destination
import io.orbitd.android.navigation.ObjectId
import io.orbitd.android.navigation.OrbitRoute
import io.orbitd.android.navigation.Origin
import io.orbitd.android.navigation.projectRoot
import io.orbitd.android.text.LocalReaderResources
import io.orbitd.android.text.rememberReaderLinkHandler
import io.orbitd.android.ui.LocalOrbitColors
import java.time.Instant

/** The Waiting on you inbox's tabs: the list each reads, and what it says when that is empty. */
internal enum class WaitingTab(val label: String, val filter: String, val empty: String) {
    OPEN("Open", OwnerRequestStore.OPEN, "Nothing is waiting on you."),
    DONE("Done", OwnerRequestStore.DONE, "Nothing has been done yet."),
    DECLINED("Declined", OwnerRequestStore.DECLINED, "Nothing has been declined."),
}

/** A runner by the name the owner knows it by. */
internal fun runnerNames(runners: List<DirectoryRunner>): (String?) -> String = { id ->
    runners.firstOrNull { io.orbitd.android.navigation.ObjectId.same(it.id, id) }?.let { it.displayName ?: it.name } ?: "this runner"
}

/** The inbox as the shell opens it: from the drawer, or from a push's action naming the request in [route]'s id. A coordinator's
 * question is answered on its card in the coordinator's conversation, where its push opens it too, brought into view there — or, with no
 * coordinator in the session list, on the project's root page. */
@Composable
fun WaitingOnYouDestination(app: OrbitApplication, handle: SessionHandle, route: OrbitRoute, data: DirectoryData, revision: Long,
    open: (OrbitRoute) -> Unit) {
    val store = remember(handle) { OwnerRequestStore.of(app.session, handle, app.processScope) }
    val links = rememberReaderLinkHandler(LocalReaderResources.current ?: return, open)
    WaitingOnYouScreen(store, data.runners, route.id, revision, links) { question ->
        val coordinator = data.sessions["open"].orEmpty().firstOrNull {
            it.projectMembership?.isCoordinator == true && ObjectId.same(it.projectMembership?.projectId, question.projectId)
        }
        if (coordinator != null) {
            CardFocus.request(coordinator.id, "item:${question.itemId}")
            open(OrbitRoute(Destination.SESSION, coordinator.id, origin = Origin.LINK))
        } else open(projectRoot(question.projectId, data, null, Origin.LINK))
    }
}

/**
 * Everything agents have asked the owner to do, in one place (web `WaitingOnYouPage`): Open, Done and Declined. The Open tab holds the
 * owner requests and the questions coordinators asked through `ask_owner`, newest first. A request's button opens its whole card under
 * it; [focused] — the request a push's action named (`orbit://owner-request/<id>`) — is open from the start, its input focused. A
 * question's Answer goes to its card ([answer]).
 */
@Composable
fun WaitingOnYouScreen(store: OwnerRequestStore, runners: List<DirectoryRunner>, focused: String?, revision: Long, open: (String) -> Unit,
    answer: (OwnerRequests.CoordinatorQuestionRow) -> Unit = {}) {
    val state by store.state.collectAsState()
    val snoozes by OwnerRequestSnoozes.of(LocalContext.current).state.collectAsState()
    var tab by rememberSaveable { mutableStateOf(WaitingTab.OPEN) }
    val expanded = remember { mutableStateMapOf<String, Boolean>() }
    LaunchedEffect(focused) { focused?.let { tab = WaitingTab.OPEN; expanded[OwnerRequests.key(it)] = true } }
    LaunchedEffect(tab, revision) { store.load(*setOf(OwnerRequestStore.OPEN, tab.filter).toTypedArray()) }
    LaunchedEffect(revision) { store.loadQuestions(items = true) }
    val runner = remember(runners) { runnerNames(runners) }
    val now = Instant.now()
    val count = OwnerRequests.waitingCount(state.open, state.projects, snoozes, now)
    val ended = state.list(tab.filter)
    val rows = if (tab == WaitingTab.OPEN) OwnerRequests.openRows(state.open, state.questions) else ended.map { OwnerRequests.OpenRow.Request(it) }
    Column(Modifier.fillMaxSize().testTag("waiting-on-you")) {
        Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 12.dp), verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(OwnerRequests.waitingOnYou, style = MaterialTheme.typography.titleLarge)
            if (count > 0) Text("$count", Modifier.background(LocalOrbitColors.current.needsYou, RoundedCornerShape(50))
                .padding(horizontal = 8.dp, vertical = 2.dp).testTag("waiting-on-you:count"), color = MaterialTheme.colorScheme.surface,
                style = MaterialTheme.typography.labelMedium.copy(fontWeight = FontWeight.SemiBold))
        }
        PrimaryTabRow(selectedTabIndex = tab.ordinal) {
            WaitingTab.entries.forEach { entry ->
                Tab(tab == entry, { tab = entry }, Modifier.testTag("waiting-on-you:tab:${entry.name}"), text = { Text(entry.label) })
            }
        }
        if (tab.filter in state.failed && rows.isEmpty()) Text("Couldn't read what is waiting on you. Check your connection and try again.",
            Modifier.padding(16.dp), style = MaterialTheme.typography.bodyMedium)
        else if (tab.filter in state.lists && rows.isEmpty()) Text(tab.empty, Modifier.padding(16.dp).testTag("waiting-on-you:empty"),
            style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        LazyColumn(Modifier.weight(1f).fillMaxWidth(), contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            items(rows, key = { row -> when (row) { is OwnerRequests.OpenRow.Request -> row.request.id; is OwnerRequests.OpenRow.Question -> "question:${row.question.itemId}" } }) { row ->
                when {
                    row is OwnerRequests.OpenRow.Question -> row.question.let { question ->
                        InboxRow("waiting-on-you:row:question:${question.itemId}", R.drawable.ic_question_bubble, question.question, question.detail,
                            OwnerRequests.ago(question.waitingSince, now), OwnerRequests.inboxAction(OwnerRequests.DECISION)) { answer(question) }
                    }
                    tab == WaitingTab.OPEN -> (row as OwnerRequests.OpenRow.Request).request.let { request ->
                        val key = OwnerRequests.key(request.id)
                        val isOpen = expanded[key] == true
                        val until = snoozes[key] ?: 0
                        InboxRow("waiting-on-you:row:${request.id}", icon(request.kind), request.title, OwnerRequests.rowDetail(request, now),
                            if (until > now.toEpochMilli()) OwnerRequests.reminder(OwnerReview.receiptTime(Instant.ofEpochMilli(until).toString(), now))
                            else OwnerRequests.ago(request.createdAt, now),
                            if (isOpen) "Close" else OwnerRequests.inboxAction(request.kind)) { expanded[key] = !isOpen }
                        if (isOpen) Box(Modifier.padding(top = 8.dp)) {
                            OwnerRequestCard(request, store, runner, open, now, focusInput = focused?.let(OwnerRequests::key) == key)
                        }
                    }
                    else -> OwnerRequestResolved((row as OwnerRequests.OpenRow.Request).request, store, runner, now)
                }
            }
        }
    }
}

private fun icon(kind: String) = when (kind) {
    OwnerRequests.SECRET -> R.drawable.ic_key
    OwnerRequests.MANUAL_STEP -> R.drawable.ic_reorder
    OwnerRequests.DECISION -> R.drawable.ic_question_bubble
    else -> R.drawable.ic_check_circle
}

/** One row of the Open tab: what kind of thing, its title, what it is about, how old, and its button. */
@Composable
private fun InboxRow(tag: String, icon: Int, title: String, detail: String, age: String, action: String, press: () -> Unit) {
    val secondary = MaterialTheme.colorScheme.onSurfaceVariant
    Row(Modifier.fillMaxWidth().testTag(tag), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        Box(Modifier.size(36.dp).background(LocalOrbitColors.current.needsYou.copy(alpha = 0.14f), RoundedCornerShape(10.dp)), contentAlignment = Alignment.Center) {
            Icon(painterResource(icon), null, Modifier.size(18.dp), tint = LocalOrbitColors.current.needsYou)
        }
        Column(Modifier.weight(1f)) {
            Text(title, Modifier.testTag("$tag:title"), style = MaterialTheme.typography.bodyMedium.copy(fontWeight = FontWeight.SemiBold),
                maxLines = 2, overflow = TextOverflow.Ellipsis)
            if (detail.isNotEmpty()) Text(detail, Modifier.testTag("$tag:detail"), style = MaterialTheme.typography.bodySmall, color = secondary, maxLines = 2)
        }
        Column(horizontalAlignment = Alignment.End) {
            Text(age, Modifier.testTag("$tag:age"), style = MaterialTheme.typography.labelSmall, color = secondary)
            FilledTonalButton(onClick = press, Modifier.testTag("$tag:action"), contentPadding = PaddingValues(horizontal = 12.dp, vertical = 4.dp)) {
                Text(action)
            }
        }
    }
}

/** The drawer's count beside Waiting on you: open requests not put off for later, and coordinators' open questions — one count. The
 * questions are counted off [projects], the drawer's own open-projects read ([io.orbitd.android.navigation.rememberDrawerProjects]),
 * so the count adds no read of its own to the ones that poll keeps to. */
@Composable
fun WaitingOnYouDrawerCount(store: OwnerRequestStore, projects: List<JsonObject>, revision: Long) {
    val state by store.state.collectAsState()
    val snoozes by OwnerRequestSnoozes.of(LocalContext.current).state.collectAsState()
    LaunchedEffect(revision) { store.load(OwnerRequestStore.OPEN) }
    val count = OwnerRequests.waitingCount(state.open, projects, snoozes, Instant.now())
    if (count > 0) Text("$count", Modifier.testTag("waiting-on-you-drawer-count").semantics { contentDescription = "$count waiting on you" },
        color = LocalOrbitColors.current.needsYou, style = MaterialTheme.typography.labelSmall.copy(fontWeight = FontWeight.SemiBold))
}
