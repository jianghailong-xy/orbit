package io.orbitd.android.management

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import io.orbitd.android.OrbitApplication
import io.orbitd.android.cards.NeedsYouToast
import io.orbitd.android.cards.OwnerRequestStore
import io.orbitd.android.core.auth.OrbitApi
import io.orbitd.android.core.auth.SessionHandle
import io.orbitd.android.core.cards.OwnerRequests
import io.orbitd.android.core.cards.TerminalRequest
import io.orbitd.android.core.cards.TerminalsApi
import io.orbitd.android.navigation.Destination
import io.orbitd.android.navigation.ObjectId
import io.orbitd.android.navigation.OrbitRoute
import io.orbitd.android.navigation.Origin
import io.orbitd.android.ui.LocalOrbitColors
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject
import java.time.Instant

/*
 * Terminals asking to be approved, where they are drawn (docs/mocks/waiting-on-you-removal/02-terminal-approvals.html, following
 * iOS): Machines & models' Needs you section holds every machine's cards, each machine's own page its own under Terminals to approve.
 * A new request is noticed once, as a toast (the owner, 2026-11-16, under `docs/mocks/needs-you-capsule/12-once`), whose press opens
 * that machine's page; the terminal-login push opens the Needs you section. The card and its two doors are main's, unchanged.
 */

/**
 * The terminal sign-ins waiting for this account's owner (`GET /terminals/requests`), oldest first: one store per signed-in handle,
 * read by the notices, Machines & models, a machine's page and the Settings row alike, so a decision on one is gone from all of them.
 */
class TerminalRequestStore internal constructor(private val api: TerminalsApi, val handle: SessionHandle, private val scope: CoroutineScope) {
    private val mutable = MutableStateFlow<List<TerminalRequest>>(emptyList())
    val requests: StateFlow<List<TerminalRequest>> = mutable.asStateFlow()
    private val answered = MutableStateFlow(false)
    /** Whether a read has answered yet: before it, an empty list is not "nothing waits" (the notices take stock at the first one). */
    val loaded: StateFlow<Boolean> = answered.asStateFlow()

    /** Read again. A server that predates terminals answers none; a failed read keeps what was drawn. */
    fun load() {
        scope.launch {
            try { mutable.value = api.requests(); answered.value = true }
            catch (cancel: CancellationException) { throw cancel } catch (_: Exception) { /* The next read tries again. */ }
        }
    }

    /** Approve or Deny: null when it was recorded — its card leaves at once — else what to say. The list is read again either way. */
    suspend fun decide(request: TerminalRequest, approve: Boolean): String? = try {
        if (approve) api.approve(request.id) else api.deny(request.id)
        mutable.update { requests -> requests.filterNot { it.id == request.id } }
        null
    } catch (cancel: CancellationException) { throw cancel } catch (error: Exception) { OwnerRequestStore.message(error) }
    finally { load() }

    companion object {
        @Volatile private var shared: TerminalRequestStore? = null

        fun of(api: OrbitApi, handle: SessionHandle, scope: CoroutineScope): TerminalRequestStore {
            shared?.takeIf { it.handle === handle }?.let { return it }
            return TerminalRequestStore(TerminalsApi(api, handle), handle, scope).also { shared = it }
        }

        fun of(management: ManagementApi) = of(management.session, management.handle, management.background)

        /** Tests start with no store. */
        internal fun reset() { shared = null }

        /** The requests still answerable at [nowMs], oldest first: the server's rule (`expiresAt > now`), so a card folds at its
         * deadline rather than at the next read (board ② choice 4). The server's refusal stays the fallback. */
        fun live(requests: List<TerminalRequest>, nowMs: Long): List<TerminalRequest> = requests
            .filter { (millis(it.expiresAt) ?: Long.MAX_VALUE) > nowMs }
            .sortedWith(compareBy<TerminalRequest> { millis(it.createdAt) ?: 0L }.thenBy { it.id })

        private fun millis(iso: String) = try { Instant.parse(iso).toEpochMilli() } catch (_: Exception) { null }

        /** The requests on one machine. */
        fun on(requests: List<TerminalRequest>, runnerId: String) = requests.filter { ObjectId.same(it.runnerId, runnerId) }
    }
}

/** The account event that says the owner's terminals changed (contract `realtime.event`): a terminal asked to be approved, a request
 * was decided, or a terminal was revoked. */
internal const val TERMINALS_CHANGED = "terminals.changed"

/** How many [TERMINALS_CHANGED] this account's stream has brought: each one reads the requests again (iOS
 * `ControlEventRoute.terminals`), and nothing else. */
@Composable
fun rememberTerminalsChanged(app: OrbitApplication, handle: SessionHandle): Long {
    val changed by remember(app, handle) {
        app.realtime.state.map { if (it.handle === handle) it.accountEvents[TERMINALS_CHANGED] ?: 0L else 0L }.distinctUntilChanged()
    }.collectAsState(0L)
    return changed
}

/** The store's requests still answerable now, read while this is drawn — at once, and every 20 s as the web does — and drawn again
 * at the next deadline, so a card and its notice fold on time. */
@Composable
fun rememberLiveTerminalRequests(store: TerminalRequestStore): List<TerminalRequest> {
    val requests by store.requests.collectAsState()
    var now by remember { mutableLongStateOf(System.currentTimeMillis()) }
    LaunchedEffect(store) { while (true) { store.load(); delay(20_000) } }
    val live = TerminalRequestStore.live(requests, now)
    val next = live.minOfOrNull { Instant.parse(it.expiresAt).toEpochMilli() }
    LaunchedEffect(next) { if (next != null) { delay(maxOf(0L, next - System.currentTimeMillis()) + 50); now = System.currentTimeMillis() } }
    return live
}

/** The notice for a terminal asking to be approved (board ③, as a toast since the owner's 2026-11-16 ruling), and where it and the
 * terminal-login push land. */
object TerminalNeedsYou {
    const val hint = "Opens the machine's terminals to approve"
    const val APPROVED = "Terminal approved"
    const val DENIED = "Terminal denied"

    /** "Approve a terminal", or "Approve 2 terminals" (board ③ choice 5). */
    fun title(count: Int) = if (count == 1) "Approve a terminal" else "Approve $count terminals"

    /** One request names its machine and code ("dev-laptop · code 7KQ-4MZ"); several on one machine count ("dev-laptop · 2 waiting");
     * several machines are named, oldest first ("dev-laptop, build-box"). */
    fun detail(requests: List<TerminalRequest>): String {
        if (requests.size == 1) return "${requests[0].machineName} · code ${requests[0].userCode}"
        val machines = requests.map { it.machineName }.distinct()
        return if (machines.size == 1) "${machines[0]} · ${requests.size} waiting" else machines.joinToString(", ")
    }

    /** The notice for one request: "Approve a terminal", then its machine and code. One per request id ([NeedsYouToast.id]). */
    fun toast(request: TerminalRequest) = NeedsYouToast(record(request.id), JsonObject(emptyMap()), title(1), detail(listOf(request)),
        terminalRequest = request.id)

    /** The `recordId` Machines & models is opened with to light one card: the bar's oldest, or the push's own. */
    fun record(requestId: String) = "terminal:$requestId"
    fun requestOf(record: String?) = record?.takeIf { it.startsWith("terminal:") }?.removePrefix("terminal:")

    /** Settings › Machines & models, on its Needs you section, [requestId]'s card lit: where the terminal-login push lands. */
    fun route(requestId: String, origin: Origin = Origin.LIST) = OrbitRoute(Destination.RUNNER, recordId = record(requestId), origin = origin)

    /** The machine [request] came from, on its Terminals to approve, the request's card lit: where its notice lands. */
    fun machineRoute(request: TerminalRequest, origin: Origin = Origin.LIST) =
        OrbitRoute(Destination.RUNNER, request.runnerId, recordId = record(request.id), origin = origin)

    /** The machine page's section for its own requests (web `TERMINALS_TO_APPROVE`). */
    const val TO_APPROVE = "Terminals to approve"
}

/**
 * A terminal asking to be approved (docs/terminal-session-design.md, board 2 marker 7), in the owner request card's frame: the machine
 * and the code its terminal shows, what approving allows, and Deny / Approve. No confirm first — comparing the code is the confirming —
 * and the card leaves once the door answers; [said] is told which, for the page's notice (board 02 ②). [lit]: opened from its notice or
 * the push, the card's outline is lit for a moment. iOS `TerminalApproveCard`, web `TerminalApproveCard.tsx`; the words are [Terminals]'.
 */
@Composable
fun TerminalApproveCard(request: TerminalRequest, store: TerminalRequestStore, now: Instant = Instant.now(), lit: Boolean = false,
    said: (String) -> Unit = {}) {
    val scope = rememberCoroutineScope()
    var busy by remember(request.id) { mutableStateOf(false) }
    var failure by remember(request.id) { mutableStateOf<String?>(null) }
    val tag = "terminal-request:${request.id}"
    fun decide(approve: Boolean) {
        busy = true; failure = null
        scope.launch {
            failure = store.decide(request, approve)
            busy = false
            if (failure == null) said(if (approve) TerminalNeedsYou.APPROVED else TerminalNeedsYou.DENIED)
        }
    }
    val tone = LocalOrbitColors.current.needsYou
    val secondary = MaterialTheme.colorScheme.onSurfaceVariant
    Column(Modifier.fillMaxWidth().testTag(tag)
        .background(tone.copy(alpha = 0.07f), RoundedCornerShape(14.dp))
        .border(if (lit) 2.dp else 1.dp, tone.copy(alpha = if (lit) 1f else 0.28f), RoundedCornerShape(14.dp))
        .padding(14.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        if (lit) Box(Modifier.testTag("$tag:lit"))
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            Box(Modifier.size(8.dp).background(tone, RoundedCornerShape(50)))
            Text(OwnerRequests.waitingOnYou, style = MaterialTheme.typography.labelMedium.copy(fontWeight = FontWeight.SemiBold), color = tone)
            Spacer(Modifier.weight(1f))
            Text("Asked ${OwnerRequests.ago(request.createdAt, now)}", Modifier.testTag("$tag:asked"), style = MaterialTheme.typography.labelSmall,
                color = secondary)
        }
        Text(Terminals.APPROVE_TITLE, Modifier.testTag("$tag:title"), style = MaterialTheme.typography.bodyLarge.copy(fontWeight = FontWeight.Bold))
        Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(Terminals.requestLine(request), Modifier.testTag("$tag:line"), style = MaterialTheme.typography.bodyMedium, color = secondary)
            Text(Terminals.APPROVE_DETAIL, Modifier.testTag("$tag:detail"), style = MaterialTheme.typography.bodyMedium, color = secondary)
        }
        failure?.let { Text("${OwnerRequests.notRecorded}: $it", Modifier.testTag("$tag:error"), style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.error) }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedButton(onClick = { decide(approve = false) }, Modifier.weight(1f).testTag("$tag:deny"), enabled = !busy) { Text(Terminals.DENY) }
            Button(onClick = { decide(approve = true) }, Modifier.weight(1f).testTag("$tag:approve"), enabled = !busy) { Text(Terminals.APPROVE) }
        }
        if (busy) LinearProgressIndicator(Modifier.fillMaxWidth())
    }
}

/** The cards for [requests], oldest first, [lit]'s outlined for two seconds after the page opens on it. */
@Composable
internal fun TerminalRequestCards(requests: List<TerminalRequest>, store: TerminalRequestStore, lit: String?, said: (String) -> Unit) {
    var lighting by remember(lit) { mutableStateOf(lit) }
    LaunchedEffect(lit) { if (lit != null) { delay(2_000); lighting = null } }
    val now = Instant.now()
    Column(Modifier.fillMaxWidth().padding(vertical = 4.dp).testTag("terminal-requests"), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        requests.forEach { request -> key(request.id) { TerminalApproveCard(request, store, now, lit = ObjectId.same(lighting, request.id), said = said) } }
    }
}
