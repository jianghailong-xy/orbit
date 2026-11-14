package io.orbitd.android.navigation

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationDrawerItem
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import io.orbitd.android.core.auth.OrbitApi
import io.orbitd.android.core.auth.SessionHandle
import io.orbitd.android.core.guests.GuestCopy
import io.orbitd.android.core.guests.GuestSessionSummary
import io.orbitd.android.core.guests.SharedWithMe
import io.orbitd.android.core.guests.guestSessions
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay

/** Whether [id] is one of the rows, in either id spelling — what highlights the open row (OrbitKit `SharedWithMe.contains`). */
internal fun sharedWithMeContains(sessions: List<GuestSessionSummary>, id: String?): Boolean =
    id != null && sessions.any { ObjectId.same(it.id, id) }

/** Shared with me as `GET /guest-sessions` last answered: read as the drawer is composed, then every minute while the app is on screen
 * (web `SHARED_WITH_ME_POLL_MS`) — a session can be shared with you, or stop being, at any time. A failed read keeps the last rows. */
@Composable
internal fun rememberSharedWithMe(api: OrbitApi, handle: SessionHandle): State<List<GuestSessionSummary>> {
    val rows = remember(handle) { mutableStateOf<List<GuestSessionSummary>>(emptyList()) }
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    LaunchedEffect(lifecycle, handle) {
        lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) {
            while (true) {
                try { rows.value = api.guestSessions(handle) }
                catch (cancel: CancellationException) { throw cancel }
                catch (_: Exception) { }
                delay(SharedWithMe.REFRESH_MS)
            }
        }
    }
    return rows
}

/** Shared with me (web `SharedWithMeGroup`, board docs/mocks/share-links/10-session-guests-3): the drawer's last group, the sessions
 * other people invited you to reply in. Each row is the session's title, who shared it and how it stands, with how long ago it last
 * moved; a press opens its guest view, and the row of the one open now ([openId]) is highlighted. No group while there is none. */
@Composable
internal fun DrawerSharedWithMe(sessions: List<GuestSessionSummary>, openId: String?, select: (String, OrbitRoute) -> Unit) {
    if (!SharedWithMe.showsGroup(sessions)) return
    DrawerGroupLabel(GuestCopy.SHARED_WITH_ME, sessions.size)
    sessions.forEach { session ->
        NavigationDrawerItem(
            label = {
                Column {
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                        Text(SharedWithMe.title(session), Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Text(SharedWithMe.ago(session), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    Text(SharedWithMe.subtitle(session), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                        maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
            },
            selected = ObjectId.same(session.id, openId),
            onClick = { select(guestDestination(session.id), OrbitRoute(Destination.GUEST_SESSION, session.id, origin = Origin.DRAWER)) },
            modifier = Modifier.testTag("shared-with-me:${session.id}"))
    }
}
