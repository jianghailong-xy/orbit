package io.orbitd.android.wiki

import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import io.orbitd.android.OrbitApplication
import io.orbitd.android.core.auth.SessionHandle
import io.orbitd.android.directory.DirectoryData
import io.orbitd.android.navigation.*

/** Where a press on a Wiki page goes. Every page rides the stack it was opened on, so what a page opens — a
 * session at a quoted record, a task, a project — is pushed over it and Back returns to the same Wiki page. */
internal class WikiNav(private val push: (OrbitRoute) -> Unit,
    private val navigate: ((OrbitNavigation) -> OrbitNavigation) -> Unit,
    /** The signed-in deployment, for the web links Copy link makes. */
    val server: String, private val external: (String) -> Unit) {
    fun open(route: OrbitRoute) = push(route)
    fun entry(id: String) = push(OrbitRoute(Destination.WIKI_ENTRY, id))
    fun session(id: String) = push(OrbitRoute(Destination.SESSION, id, origin = Origin.LINK))
    /** A session at one of its records — `orbit://session/<id>?at=<record>`, the deep link a footnote rests on;
     * the session alone when that link cannot be made (iOS `WikiDocScreen.open`). */
    fun sessionRecord(session: String, record: String) {
        val link = "orbit://session/${Uri.encode(session)}?at=${Uri.encode(record)}"
        push(OrbitLinks.parse(link, origin = Origin.LINK)?.takeIf { it.recordId != null } ?: OrbitRoute(Destination.SESSION, session, origin = Origin.LINK))
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
fun WikiDestination(app: OrbitApplication, handle: SessionHandle, route: OrbitRoute, data: DirectoryData, revision: Long,
    open: (OrbitRoute) -> Unit, navigate: ((OrbitNavigation) -> OrbitNavigation) -> Unit) {
    val store = remember(handle) { WikiStore.of(app.session, handle, app.processScope) }
    if (!store.live()) return
    // The account stream says something changed, or it reconnected: re-read what the Wiki has loaded. The
    // stream's events reach this client only as a revision, so any of them nudges while a Wiki page is up.
    var seen by remember(store) { mutableLongStateOf(revision) }
    LaunchedEffect(store, revision) { if (revision != seen) { seen = revision; store.nudge() } }
    val context = LocalContext.current
    val nav = remember(store, open, navigate) {
        WikiNav(open, navigate, handle.account.server) { raw ->
            try { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(raw))) }
            catch (_: ActivityNotFoundException) { WikiToast.show("No application can open this link.") }
        }
    }
    Box(Modifier.fillMaxSize().testTag("wiki-destination")) {
        when (route.destination) {
            Destination.WIKI -> WikiHomeScreen(store, route, data, nav)
            Destination.WIKI_ENTRY -> WikiEntryScreen(store, route, data, nav)
            Destination.WIKI_REVIEW -> WikiReviewScreen(store, route, data, nav)
            Destination.WIKI_RUN -> WikiRunScreen(store, route, nav)
            Destination.WIKI_SETTINGS -> WikiSettingsScreen(store, route, data, nav)
            Destination.WIKI_ARTICLE -> WikiArticleScreen(store, route, nav)
            Destination.WIKI_BROWSE -> WikiBrowseScreen(store, route, nav)
            Destination.WIKI_INDEX -> WikiIndexScreen(store, route, nav)
            Destination.WIKI_DOC -> WikiDocScreen(store, route, nav)
            Destination.WIKI_PLAN, Destination.WIKI_PLAN_DOC, Destination.WIKI_PLAN_SECTION -> WikiPlanScreen(store, route, data, nav)
            else -> Unit
        }
        WikiToast.Host()
    }
}
