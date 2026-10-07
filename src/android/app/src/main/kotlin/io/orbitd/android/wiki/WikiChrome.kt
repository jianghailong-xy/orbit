package io.orbitd.android.wiki

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.orbitd.android.R
import io.orbitd.android.navigation.Destination
import io.orbitd.android.navigation.OrbitRoute

/** The top bar's title and actions for the Wiki and Watch pages: iOS puts them in the navigation bar, which on
 * Android is the shell's TopAppBar. A page binds what its bar says while it is the route on screen. */
object PageBar {
    private var owner by mutableStateOf<OrbitRoute?>(null)
    private var title by mutableStateOf<String?>(null)
    private var subtitle by mutableStateOf<String?>(null)
    private var actions by mutableStateOf<(@Composable RowScope.() -> Unit)?>(null)

    /** [subtitle] is the second line iOS draws under a page's title in the bar (a `.principal` title block). */
    @Composable
    internal fun Bind(route: OrbitRoute, title: String?, subtitle: String? = null, actions: (@Composable RowScope.() -> Unit)? = null) {
        DisposableEffect(route) {
            owner = route
            onDispose { if (owner == route) { owner = null; this@PageBar.title = null; this@PageBar.subtitle = null; this@PageBar.actions = null } }
        }
        SideEffect { if (owner == route) { this.title = title; this.subtitle = subtitle; this.actions = actions } }
    }

    /** The bar's title for a Wiki/Watch route, or null to keep the shell's own. */
    fun title(route: OrbitRoute): String? = if (owner == route) title else null

    /** The bar's title as the page bound it — with its second line when it has one — else [fallback]. */
    @Composable
    fun Title(route: OrbitRoute, fallback: @Composable () -> Unit) {
        val text = title(route) ?: return fallback()
        val second = subtitle
        // One line, cut with an ellipsis when the bar's buttons leave too little, as iOS's navigation title is.
        if (second == null) Text(text, maxLines = 1, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.titleMedium)
        else Column(Modifier.semantics(mergeDescendants = true) {}) {
            Text(text, maxLines = 1, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.titleMedium)
            Text(second, maxLines = 1, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.testTag("page-bar-subtitle"))
        }
    }

    @Composable
    fun Actions(route: OrbitRoute, scope: RowScope) { if (owner == route) actions?.invoke(scope) }
}

@Composable
internal fun BarIcon(icon: Int, description: String, tag: String, enabled: Boolean = true, onClick: () -> Unit) {
    IconButton(onClick = onClick, enabled = enabled, modifier = Modifier.testTag(tag)) { Icon(painterResource(icon), description) }
}

/** Which page the Contents sheet was opened over: that row is lit, and an open article or document lists its parts. */
internal sealed interface WikiContentsAt {
    data object Home : WikiContentsAt
    data object Browse : WikiContentsAt
    data object Index : WikiContentsAt
    data object Plan : WikiContentsAt
    data class Article(val topic: String, val part: Int) : WikiContentsAt
    data class Doc(val slug: String) : WikiContentsAt
}

/** Where a row of the Contents sheet goes. */
internal sealed interface WikiContentsPick {
    data object Home : WikiContentsPick
    data object Browse : WikiContentsPick
    data object Index : WikiContentsPick
    data object Plan : WikiContentsPick
    data class Article(val topic: String, val part: Int) : WikiContentsPick
    data class Doc(val slug: String, val section: String?) : WikiContentsPick
}

/** The article and document pages push what they open onto the section's stack; Contents' Home goes back to the root. */
internal fun wikiGo(pick: WikiContentsPick, nav: WikiNav) = when (pick) {
    WikiContentsPick.Home -> nav.home()
    WikiContentsPick.Browse -> nav.open(OrbitRoute(Destination.WIKI_BROWSE))
    WikiContentsPick.Index -> nav.open(OrbitRoute(Destination.WIKI_INDEX))
    WikiContentsPick.Plan -> nav.open(OrbitRoute(Destination.WIKI_PLAN))
    is WikiContentsPick.Article -> nav.open(OrbitRoute(Destination.WIKI_ARTICLE, pick.topic, wikiPart = pick.part))
    is WikiContentsPick.Doc -> nav.open(OrbitRoute(Destination.WIKI_DOC, pick.slug, wikiSection = pick.section))
}

/** The directory as a sheet (iOS `WikiContentsScreen` + `WikiContentsSheet`): Home, Browse by category, the A–Z
 * index and the Plan with what of it waits on the owner, then the confirmed plan's categories and documents, or,
 * before a plan is confirmed, every category's topics. Read when it opens. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun WikiContentsSheet(store: WikiStore, at: WikiContentsAt, runnerOnline: Boolean?, close: () -> Unit, pick: (WikiContentsPick) -> Unit) {
    val state by store.state.collectAsState()
    LaunchedEffect(store) { store.loadDocsDirectory(); store.loadDirectory(); store.loadPlan() }
    val docGroups = if (WikiDocLogic.readsByDocs(state.docsDirectory)) state.docsDirectory?.let(WikiDocLogic::directoryGroups).orEmpty() else emptyList()
    val groups = if (docGroups.isEmpty()) state.directory?.let(WikiArticleLogic::directoryGroups).orEmpty() else emptyList()
    val planPending = state.plan?.let { WikiPlanLogic.pending(it, runnerOnline) } ?: 0
    fun choose(destination: WikiContentsPick) { close(); pick(destination) }
    val openDoc = (at as? WikiContentsAt.Doc)?.slug
    ModalBottomSheet(onDismissRequest = close, modifier = Modifier.testTag("wiki-contents-sheet")) {
        Row(Modifier.fillMaxWidth().padding(horizontal = 8.dp), verticalAlignment = Alignment.CenterVertically) {
            BarIcon(R.drawable.ic_close, "Close", "wiki-contents-close", onClick = close)
            Text(WikiArticleCopy.contents, Modifier.weight(1f), style = MaterialTheme.typography.titleMedium)
        }
        LazyColumn(Modifier.fillMaxWidth()) {
            item { ContentsRow(WikiArticleCopy.home, R.drawable.ic_home, at == WikiContentsAt.Home, "wiki-contents-home") { choose(WikiContentsPick.Home) } }
            item { ContentsRow(WikiArticleCopy.browse, R.drawable.ic_grid, at == WikiContentsAt.Browse, "wiki-contents-browse") { choose(WikiContentsPick.Browse) } }
            item { ContentsRow(WikiArticleCopy.azIndex, R.drawable.ic_index, at == WikiContentsAt.Index, "wiki-contents-index") { choose(WikiContentsPick.Index) } }
            item { ContentsRow(WikiDocCopy.plan, R.drawable.ic_plan, at == WikiContentsAt.Plan, "wiki-contents-plan", badge = planPending.takeIf { it > 0 }) { choose(WikiContentsPick.Plan) } }
            docGroups.forEach { group ->
                item(key = "doc-group:${group.key}") { GroupTitle(group.title) }
                group.docs.forEach { doc ->
                    item(key = "doc:${doc.slug}") {
                        val open = doc.slug == openDoc
                        Row(Modifier.fillMaxWidth().background(if (open) MaterialTheme.colorScheme.primary.copy(alpha = 0.10f) else Color.Transparent)
                            .clickable(role = Role.Button) { choose(WikiContentsPick.Doc(doc.slug, null)) }.heightIn(min = 48.dp)
                            .padding(horizontal = 16.dp, vertical = 8.dp).testTag("wiki-contents-doc:${doc.slug}"),
                            verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                            Text(doc.number, style = WikiType.subtext, color = WikiPalette.secondary)
                            Text(doc.title, Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis,
                                style = WikiType.prose.copy(fontWeight = if (open) FontWeight.SemiBold else FontWeight.Normal),
                                color = when { open -> MaterialTheme.colorScheme.primary; doc.written -> MaterialTheme.colorScheme.onSurface; else -> WikiPalette.secondary })
                            if (doc.needsReview) Box(Modifier.size(7.dp).background(WikiPalette.amber, CircleShape).semantics { contentDescription = WikiDocCopy.needsReview })
                            Icon(painterResource(if (open) R.drawable.ic_chevron_down else R.drawable.ic_chevron_forward), null, Modifier.size(14.dp), tint = WikiPalette.secondary)
                        }
                    }
                    if (doc.slug == openDoc) items(doc.sections, key = { "section:${doc.slug}:${it.key}" }) { section ->
                        Row(Modifier.fillMaxWidth().clickable(role = Role.Button) { choose(WikiContentsPick.Doc(doc.slug, section.key)) }
                            .heightIn(min = 48.dp).padding(start = 44.dp, end = 16.dp, top = 6.dp, bottom = 6.dp),
                            verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            Text("${section.number}", style = WikiType.subtext, color = WikiPalette.secondary)
                            Text(section.title, maxLines = 1, overflow = TextOverflow.Ellipsis, style = WikiType.subtext,
                                color = if (section.written) MaterialTheme.colorScheme.onSurface else WikiPalette.secondary)
                        }
                    }
                }
            }
            val openArticle = at as? WikiContentsAt.Article
            groups.forEach { group ->
                item(key = "group:${group.key}") { GroupTitle(group.title) }
                group.topics.forEach { topic ->
                    val open = openArticle?.takeIf { it.topic == topic.slug }?.part
                    item(key = "topic:${topic.slug}") {
                        Row(Modifier.fillMaxWidth().background(if (open == 0) MaterialTheme.colorScheme.primary.copy(alpha = 0.10f) else Color.Transparent)
                            .clickable(role = Role.Button) { choose(WikiContentsPick.Article(topic.slug, 0)) }.heightIn(min = 48.dp)
                            .padding(horizontal = 16.dp, vertical = 8.dp).testTag("wiki-contents-topic:${topic.slug}"),
                            verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                            Text(topic.title, Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis,
                                style = WikiType.prose.copy(fontWeight = if (open != null) FontWeight.SemiBold else FontWeight.Normal),
                                color = if (open == 0) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurface)
                            topic.count?.let { Text(WikiArticleCopy.count(it), style = WikiType.subtext, color = WikiPalette.secondary) }
                            Icon(painterResource(if (open != null && topic.parts.isNotEmpty()) R.drawable.ic_chevron_down else R.drawable.ic_chevron_forward),
                                null, Modifier.size(14.dp), tint = WikiPalette.secondary)
                        }
                    }
                    if (open != null) items(topic.parts, key = { "part:${topic.slug}:${it.part}" }) { part ->
                        Text(part.title, Modifier.fillMaxWidth().background(if (part.part == open) MaterialTheme.colorScheme.primary.copy(alpha = 0.10f) else Color.Transparent)
                            .clickable(role = Role.Button) { choose(WikiContentsPick.Article(topic.slug, part.part)) }.heightIn(min = 48.dp)
                            .padding(start = 32.dp, end = 16.dp, top = 12.dp, bottom = 12.dp), maxLines = 1, overflow = TextOverflow.Ellipsis,
                            style = WikiType.subtext.copy(fontWeight = if (part.part == open) FontWeight.SemiBold else FontWeight.Normal),
                            color = if (part.part == open) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurface)
                    }
                }
            }
            item { Spacer(Modifier.height(24.dp)) }
        }
    }
}

@Composable
private fun GroupTitle(title: String) {
    Text(title, Modifier.padding(start = 16.dp, end = 16.dp, top = 16.dp, bottom = 4.dp),
        style = WikiType.subtext.copy(fontWeight = FontWeight.SemiBold), color = WikiPalette.secondary)
}

@Composable
private fun ContentsRow(title: String, icon: Int, lit: Boolean, tag: String, badge: Int? = null, onClick: () -> Unit) {
    Row(Modifier.fillMaxWidth().background(if (lit) MaterialTheme.colorScheme.primary.copy(alpha = 0.10f) else Color.Transparent)
        .clickable(role = Role.Button, onClick = onClick).heightIn(min = 48.dp).padding(horizontal = 16.dp, vertical = 8.dp).testTag(tag),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        Icon(painterResource(icon), null, Modifier.size(22.dp), tint = MaterialTheme.colorScheme.primary)
        Text(title, Modifier.weight(1f), style = WikiType.prose.copy(fontWeight = if (lit) FontWeight.SemiBold else FontWeight.Normal),
            color = if (lit) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurface)
        if (badge != null) Text("$badge", style = WikiType.label.copy(fontWeight = FontWeight.SemiBold), color = Color.White,
            modifier = Modifier.background(Color(0xFFFF9500), CircleShape).padding(horizontal = 7.dp, vertical = 2.dp))
    }
}

/** iOS's app toast (`model.showToast`): one short line that leaves by itself. Posted by a page, drawn by the
 * Wiki/Watch host, so it survives the page that posted it being popped. */
object WikiToast {
    private const val SHOWN_MS = 2_500L
    internal var text by mutableStateOf<String?>(null)
    private var subtitle by mutableStateOf<String?>(null)
    private var serial by mutableStateOf(0)
    private var postedAt = 0L
    /** [subtitle]: the second line under it — the entry an answer was about (iOS `showToast(_:subtitle:)`). */
    fun show(message: String, subtitle: String? = null) {
        text = message; this.subtitle = subtitle; postedAt = android.os.SystemClock.elapsedRealtime(); serial++
    }

    @Composable
    internal fun Host(modifier: Modifier = Modifier) {
        val shown = text ?: return
        // Its time runs whether or not a page is up to draw it: a toast never comes back with the next Wiki page.
        val left = SHOWN_MS - (android.os.SystemClock.elapsedRealtime() - postedAt)
        LaunchedEffect(serial) { if (left > 0) kotlinx.coroutines.delay(left); text = null }
        if (left <= 0) return
        Box(modifier.fillMaxSize().padding(bottom = 24.dp), contentAlignment = Alignment.BottomCenter) {
            Surface(shape = RoundedCornerShape(50), color = MaterialTheme.colorScheme.inverseSurface, tonalElevation = 4.dp,
                modifier = Modifier.testTag("wiki-toast").semantics { liveRegion = LiveRegionMode.Polite }) {
                Column(Modifier.padding(horizontal = 18.dp, vertical = 10.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                    Text(shown, color = MaterialTheme.colorScheme.inverseOnSurface, style = WikiType.subtext)
                    subtitle?.let { Text(it, color = MaterialTheme.colorScheme.inverseOnSurface.copy(alpha = 0.75f), style = WikiType.label,
                        maxLines = 1, overflow = TextOverflow.Ellipsis) }
                }
            }
        }
    }
}

/** iOS's `.alert(WikiCopy.refused)`: what the server said when it refused a write, and OK. */
@Composable
internal fun WikiRefusalAlert(notice: String?, dismiss: () -> Unit) {
    if (notice == null) return
    AlertDialog(onDismissRequest = dismiss, title = { Text(WikiCopy.refused) }, text = { Text(notice) },
        confirmButton = { TextButton(onClick = dismiss, modifier = Modifier.testTag("wiki-refusal-ok")) { Text("OK") } })
}
