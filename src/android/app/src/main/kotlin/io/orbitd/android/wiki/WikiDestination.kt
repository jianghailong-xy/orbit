package io.orbitd.android.wiki

import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import io.orbitd.android.OrbitApplication
import io.orbitd.android.core.auth.SessionHandle
import io.orbitd.android.directory.DirectoryData
import io.orbitd.android.navigation.*
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.drop
import kotlinx.coroutines.flow.filter
import kotlinx.coroutines.flow.map

/** Where a press on a Wiki page goes. Every page rides the stack it was opened on, so what a page opens — a
 * session at a quoted record, a task, a project — is pushed over it and Back returns to the same Wiki page. */
internal class WikiNav(private val push: (OrbitRoute) -> Unit,
    private val navigate: ((OrbitNavigation) -> OrbitNavigation) -> Unit,
    /** The signed-in deployment, for the web links Copy link makes. */
    val server: String, private val external: (String) -> Unit) {
    fun open(route: OrbitRoute) = push(route)
    fun entry(id: String) = push(OrbitRoute(Destination.WIKI_ENTRY, id))
    fun session(id: String) = push(OrbitRoute(Destination.SESSION, id, origin = Origin.LINK))
    /** A session at one of its records — what `orbit://session/<id>?at=<record>`, the deep link a footnote rests on,
     * opens; the session alone when that link cannot be made (iOS `WikiDocScreen.open`). */
    fun sessionRecord(session: String, record: String) {
        val id = ObjectId.canonical(session); val at = ObjectId.canonical(record)
        push(if (id != null && at != null) OrbitRoute(Destination.SESSION, id, recordId = at, origin = Origin.LINK)
            else OrbitRoute(Destination.SESSION, session, origin = Origin.LINK))
    }
    fun task(id: String) = push(OrbitRoute(Destination.TASK, id, origin = Origin.LINK))
    fun project(id: String) = push(OrbitRoute(Destination.PROJECT, id, origin = Origin.LINK))
    fun runner(id: String) = push(OrbitRoute(Destination.RUNNER, id, origin = Origin.LINK))
    /** A web page — a repository host at a commit — in the browser. */
    fun url(raw: String) = external(raw)
    /** Contents' Home: back to the Wiki home under this page (iOS `popToRoot`). */
    fun home() = navigate { it.wikiHome() }
    fun back() = navigate { it.back() }
    /** The page on top swapped for another, as iOS's `replaceTop` does for a plan version picked. */
    fun replace(route: OrbitRoute) = navigate { it.replaceTop(route) }
}

/** Back to the Wiki home this stack holds — or, for a Wiki page a link opened over another section, the home
 * pushed over it. */
internal fun OrbitNavigation.wikiHome(): OrbitNavigation {
    val at = frames.indexOfLast { it.destination == Destination.WIKI }
    return if (at < 0) push(OrbitRoute(Destination.WIKI)) else copy(stacks = stacks + (section to frames.take(at + 1)))
}

internal fun OrbitNavigation.replaceTop(route: OrbitRoute): OrbitNavigation =
    if (current == route) this else copy(stacks = stacks + (section to (frames.dropLast(1) + route)))

/** The Wiki section's pages over the account's one Wiki store (iOS `AppModel.wiki`). */
@Composable
fun WikiDestination(app: OrbitApplication, handle: SessionHandle, route: OrbitRoute, data: DirectoryData,
    open: (OrbitRoute) -> Unit, navigate: ((OrbitNavigation) -> OrbitNavigation) -> Unit) {
    val store = remember(handle) { WikiStore.of(app.session, handle, app.processScope) }
    if (!store.live()) return
    // `wiki.changed` arrived, or the stream reconnected (it replays nothing): re-read what the Wiki has loaded, as
    // iOS's `AppModel` does. Other account events are not about the Wiki and read nothing here.
    LaunchedEffect(store) {
        app.realtime.state.filter { it.handle === handle }.map { (it.accountEvents[WIKI_CHANGED] ?: 0L) to it.controlConnects }
            .distinctUntilChanged().drop(1).collect { store.nudge() }
    }
    val context = LocalContext.current
    val nav = remember(store, open, navigate) {
        WikiNav(open, navigate, handle.account.server) { raw ->
            try { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(raw))) }
            catch (_: ActivityNotFoundException) { WikiToast.show("No application can open this link.") }
        }
    }
    Column(Modifier.fillMaxSize().testTag("wiki-destination")) {
      WikiNoticeBanner(store)
      Box(Modifier.fillMaxWidth().weight(1f)) {
        when (route.destination) {
            Destination.WIKI -> WikiHomeScreen(store, route, data, nav)
            Destination.WIKI_ACTIVITY -> WikiActivityScreen(store, route, data, nav)
            Destination.WIKI_ENTRY -> WikiEntryScreen(store, route, data, nav)
            Destination.WIKI_REVIEW -> WikiReviewScreen(store, route, data, nav)
            Destination.WIKI_RUN -> WikiRunScreen(store, route, nav)
            Destination.WIKI_SETTINGS -> WikiSettingsScreen(store, route, data, nav)
            Destination.WIKI_ARTICLE -> WikiArticleScreen(store, route, data, nav)
            Destination.WIKI_BROWSE -> WikiBrowseScreen(store, route, data, nav)
            Destination.WIKI_INDEX -> WikiIndexScreen(store, route, data, nav)
            Destination.WIKI_DOC -> WikiDocScreen(store, route, data, nav)
            Destination.WIKI_PLAN, Destination.WIKI_PLAN_DOC, Destination.WIKI_PLAN_SECTION -> WikiPlanScreen(store, route, data, nav)
            else -> Unit
        }
        WikiToast.Host()
      }
    }
}

/** The account event that says a wiki space changed (contract `realtime.event`). */
private const val WIKI_CHANGED = "wiki.changed"

/** The drawer's Wiki row, drawn only for an account the server has the wiki on for (iOS `CompactShell`'s
 * `wiki?.shown`): no row at all after a WIKI_DISABLED answer, as the web sidebar draws none — a row that led to a
 * refusal would be worse than none. The spaces it is decided by are read as the drawer is first composed, as iOS reads
 * them with the drawer, and again each time it opens. */
@Composable
fun WikiDrawerRow(app: OrbitApplication, handle: SessionHandle, drawerOpen: Boolean, row: @Composable () -> Unit) {
    val store = remember(handle) { WikiStore.of(app.session, handle, app.processScope) }
    val state by store.state.collectAsState()
    LaunchedEffect(store, drawerOpen) { if ((drawerOpen || !store.state.value.spacesState.hasLoaded) && store.live()) store.loadSpaces() }
    if (state.shown) row()
}

/** The drawer's Wiki row's amber number: what waits on the owner across every space — the proposals in Review and what
 * each plan waits for (design §12.3.3) — the web sidebar's count and the Wiki bar's Activity badge, written and said the
 * way the Projects row writes and says its own ("3 waiting on you"), and nothing at all at zero (iOS
 * `CompactShell.wikiRow`). The drawer reads the spaces it counts each time it opens ([WikiDrawerRow]); opening the Wiki
 * never clears it: only answering what waits does. */
@Composable
fun WikiDrawerCount(app: OrbitApplication, handle: SessionHandle) {
    val store = remember(handle) { WikiStore.of(app.session, handle, app.processScope) }
    val state by store.state.collectAsState()
    val waiting = state.waiting
    if (waiting > 0) androidx.compose.material3.Text("$waiting", color = androidx.compose.ui.graphics.Color(0xFFFF9500),
        style = androidx.compose.material3.MaterialTheme.typography.labelSmall.copy(fontWeight = androidx.compose.ui.text.font.FontWeight.SemiBold),
        modifier = Modifier.testTag("wiki-drawer-count").semantics { contentDescription = WikiCopy.waitingOnYou(waiting) })
}

/** Where the reader is as they come into the Wiki (iOS `WikiSpaceLogic.workspaceInView`, design §12.3.4): the workspace
 * whose session list the section shows, or — on a project's page, or a page opened over it — the project, whose
 * coordinator's workspace the store reads; nowhere on a page that is neither (the Projects or Tasks list), which leaves
 * the choice to the space last looked at. */
internal data class WikiFrom(val workspaceId: String? = null, val projectId: String? = null)

internal fun wikiFrom(navigation: OrbitNavigation): WikiFrom {
    val frames = navigation.frames
    frames.lastOrNull { it.destination == Destination.PROJECT && it.id != null }?.let { return WikiFrom(projectId = it.id) }
    val root = frames.firstOrNull() ?: return WikiFrom()
    return if (root.destination == Destination.WORKSPACE) WikiFrom(workspaceId = root.id ?: root.workspaceId) else WikiFrom()
}

/** The drawer's Wiki row pressed from another section: the Wiki opens the space bound to where the reader was
 * ([WikiStore.open]), as iOS's `selectedSection` does on its way into the Wiki. */
fun wikiEntered(app: OrbitApplication, handle: SessionHandle, navigation: OrbitNavigation) {
    WikiStore.of(app.session, handle, app.processScope).open(wikiFrom(navigation))
}
