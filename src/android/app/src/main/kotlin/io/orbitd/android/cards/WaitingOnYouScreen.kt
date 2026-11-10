package io.orbitd.android.cards

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
import io.orbitd.android.core.cards.OwnerRequest
import io.orbitd.android.core.cards.OwnerRequests
import io.orbitd.android.core.cards.OwnerReview
import io.orbitd.android.directory.DirectoryRunner
import io.orbitd.android.navigation.OrbitRoute
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

/** The inbox as the shell opens it: from the drawer, or from a push's action naming the request in [route]'s id. */
@Composable
fun WaitingOnYouDestination(app: OrbitApplication, handle: SessionHandle, route: OrbitRoute, runners: List<DirectoryRunner>, revision: Long,
    open: (OrbitRoute) -> Unit) {
    val store = remember(handle) { OwnerRequestStore.of(app.session, handle, app.processScope) }
    val links = rememberReaderLinkHandler(LocalReaderResources.current ?: return, open)
    WaitingOnYouScreen(store, runners, route.id, revision, links)
}

/**
 * Everything sessions have asked the owner to do, in one place (web `WaitingOnYouPage`): Open, Done and Declined. An Open row's
 * button opens its whole card under it; [focused] — the request a push's action named (`orbit://owner-request/<id>`) — is open from
 * the start, its input focused.
 */
@Composable
fun WaitingOnYouScreen(store: OwnerRequestStore, runners: List<DirectoryRunner>, focused: String?, revision: Long, open: (String) -> Unit) {
    val state by store.state.collectAsState()
    val snoozes by OwnerRequestSnoozes.of(LocalContext.current).state.collectAsState()
    var tab by rememberSaveable { mutableStateOf(WaitingTab.OPEN) }
    val expanded = remember { mutableStateMapOf<String, Boolean>() }
    LaunchedEffect(focused) { focused?.let { tab = WaitingTab.OPEN; expanded[OwnerRequests.key(it)] = true } }
    LaunchedEffect(tab, revision) { store.load(*setOf(OwnerRequestStore.OPEN, tab.filter).toTypedArray()) }
    val runner = remember(runners) { runnerNames(runners) }
    val now = Instant.now()
    val count = OwnerRequests.waitingCount(state.open, snoozes, now)
    val rows = state.list(tab.filter)
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
            items(rows, key = { it.id }) { request ->
                if (tab == WaitingTab.OPEN) {
                    val key = OwnerRequests.key(request.id)
                    val isOpen = expanded[key] == true
                    InboxRow(request, snoozes[key] ?: 0, now, isOpen) { expanded[key] = !isOpen }
                    if (isOpen) Box(Modifier.padding(top = 8.dp)) {
                        OwnerRequestCard(request, store, runner, open, now, focusInput = focused?.let(OwnerRequests::key) == key)
                    }
                } else OwnerRequestResolved(request, store, runner, now)
            }
        }
    }
}

/** One row of the Open tab: what kind of thing, its title, what it holds up, how old, and the button that opens its card. */
@Composable
private fun InboxRow(request: OwnerRequest, until: Long, now: Instant, open: Boolean, toggle: () -> Unit) {
    val secondary = MaterialTheme.colorScheme.onSurfaceVariant
    val tag = "waiting-on-you:row:${request.id}"
    val icon = when (request.kind) {
        OwnerRequests.SECRET -> R.drawable.ic_key
        OwnerRequests.MANUAL_STEP -> R.drawable.ic_reorder
        OwnerRequests.DECISION -> R.drawable.ic_question_bubble
        else -> R.drawable.ic_check_circle
    }
    Row(Modifier.fillMaxWidth().testTag(tag), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        Box(Modifier.size(36.dp).background(LocalOrbitColors.current.needsYou.copy(alpha = 0.14f), RoundedCornerShape(10.dp)), contentAlignment = Alignment.Center) {
            Icon(painterResource(icon), null, Modifier.size(18.dp), tint = LocalOrbitColors.current.needsYou)
        }
        Column(Modifier.weight(1f)) {
            Text(request.title, Modifier.testTag("$tag:title"), style = MaterialTheme.typography.bodyMedium.copy(fontWeight = FontWeight.SemiBold),
                maxLines = 2, overflow = TextOverflow.Ellipsis)
            val detail = OwnerRequests.rowDetail(request, now)
            if (detail.isNotEmpty()) Text(detail, Modifier.testTag("$tag:detail"), style = MaterialTheme.typography.bodySmall, color = secondary, maxLines = 2)
        }
        Column(horizontalAlignment = Alignment.End) {
            Text(if (until > now.toEpochMilli()) OwnerRequests.reminder(OwnerReview.receiptTime(Instant.ofEpochMilli(until).toString(), now))
                else OwnerRequests.ago(request.createdAt, now), Modifier.testTag("$tag:age"), style = MaterialTheme.typography.labelSmall, color = secondary)
            FilledTonalButton(onClick = toggle, Modifier.testTag("$tag:action"), contentPadding = PaddingValues(horizontal = 12.dp, vertical = 4.dp)) {
                Text(if (open) "Close" else OwnerRequests.inboxAction(request.kind))
            }
        }
    }
}

/** The drawer's count beside Waiting on you: open requests not put off for later. */
@Composable
fun WaitingOnYouDrawerCount(store: OwnerRequestStore, revision: Long) {
    val state by store.state.collectAsState()
    val snoozes by OwnerRequestSnoozes.of(LocalContext.current).state.collectAsState()
    LaunchedEffect(revision) { store.load(OwnerRequestStore.OPEN) }
    val count = OwnerRequests.waitingCount(state.open, snoozes, Instant.now())
    if (count > 0) Text("$count", Modifier.testTag("waiting-on-you-drawer-count").semantics { contentDescription = "$count waiting on you" },
        color = LocalOrbitColors.current.needsYou, style = MaterialTheme.typography.labelSmall.copy(fontWeight = FontWeight.SemiBold))
}
