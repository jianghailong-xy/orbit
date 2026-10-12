@file:OptIn(ExperimentalMaterial3Api::class)

package io.orbitd.android.wiki

import io.orbitd.android.directory.DirectoryData

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import io.orbitd.android.R
import io.orbitd.android.directory.LoadingMessage
import io.orbitd.android.directory.StatusMessage
import io.orbitd.android.navigation.Destination
import io.orbitd.android.navigation.OrbitRoute
import kotlinx.coroutines.launch

// The article screens (iOS `WikiScreens.swift` § the articles): each reads the Wiki store, mounts one of
// `WikiArticlePage.kt`'s or `WikiDocPage.kt`'s pages over what it read, and decides where a press goes — pushed onto the
// Wiki section's stack, so Back returns here. The pages themselves know neither.

/** One of a topic's articles, or — while the topic has none — its entries alone (iOS `WikiArticleScreen`).
 * route.id = topic slug, route.wikiPart = part (0 = the topic article). */
@Composable
internal fun WikiArticleScreen(store: WikiStore, route: OrbitRoute, data: DirectoryData, nav: WikiNav) {
    val address = WikiArticleAddress(requireNotNull(route.id), route.wikiPart)
    val state by store.state.collectAsState()
    val scope = rememberCoroutineScope()
    var contentsShown by rememberSaveable { mutableStateOf(false) }
    var refreshing by remember { mutableStateOf(false) }
    LaunchedEffect(address) {
        store.loadArticle(address)
        // A topic with no article yet is titled from the directory.
        val read = store.state.value
        if (address in read.missingArticles && read.directory == null) store.loadDirectory()
    }
    val actions = WikiArticleActions(
        openEntry = nav::entry,
        openArticle = { topic, part -> nav.open(OrbitRoute(Destination.WIKI_ARTICLE, topic, wikiPart = part)) },
        openBrowse = { nav.open(OrbitRoute(Destination.WIKI_BROWSE)) },
        openContents = { contentsShown = true },
        readEntry = { id -> scope.launch { store.loadEntry(id) } })
    val article = state.articles[address]
    WikiReadingBar(route, page = article != null || address in state.missingArticles, actions.openContents)
    PullToRefreshBox(isRefreshing = refreshing, onRefresh = {
        scope.launch { refreshing = true; try { store.loadArticle(address) } finally { refreshing = false } }
    }, modifier = Modifier.fillMaxSize().testTag("wiki-article")) {
        when {
            // The entries it was written from, as its read carries them; an older server's read carries none, and the
            // topic's own entries stand in.
            article != null -> WikiArticlePage(article, article.entries ?: state.topicEntries[address.topic], { id -> state.detail(id) }, actions)
            address in state.missingArticles ->
                WikiTopicEntriesPage(topicTitle(state, address.topic), state.topicEntries[address.topic].orEmpty(), actions)
            address in state.failedArticles -> WikiReadingPlaceholder("wiki-article-failed") {
                StatusMessage("The article couldn't be loaded", "Check the connection, then try again.") { scope.launch { store.loadArticle(address) } }
            }
            else -> WikiReadingPlaceholder("wiki-article-loading") { LoadingMessage("Loading…") }
        }
    }
    if (contentsShown) WikiContentsSheet(store, WikiContentsAt.Article(address.topic, address.part), runnerOnline = wikiMaintenanceRunnerOnline(state.currentSpace, data),
        close = { contentsShown = false }) { pick -> wikiGo(pick, nav) }
}

/** The topic's name, as the directory has it; its slug before the directory is read. */
private fun topicTitle(state: WikiState, topic: String): String =
    state.directory?.let(WikiArticleLogic::directoryGroups).orEmpty()
        .firstNotNullOfOrNull { group -> group.topics.firstOrNull { it.slug == topic }?.title } ?: topic

/** Browse by category (iOS `WikiBrowseScreen`): by the confirmed plan's documents when the space reads by them, else
 * by its topic articles. */
@Composable
internal fun WikiBrowseScreen(store: WikiStore, route: OrbitRoute, data: DirectoryData, nav: WikiNav) {
    val state by store.state.collectAsState()
    val scope = rememberCoroutineScope()
    var contentsShown by rememberSaveable { mutableStateOf(false) }
    var refreshing by remember { mutableStateOf(false) }
    LaunchedEffect(store) { store.loadDocsDirectory(); store.loadDirectory() }
    WikiReadingBar(route, page = true) { contentsShown = true }
    PullToRefreshBox(isRefreshing = refreshing, onRefresh = {
        scope.launch { refreshing = true; try { store.loadDocsDirectory(); store.loadDirectory() } finally { refreshing = false } }
    }, modifier = Modifier.fillMaxSize().testTag("wiki-browse")) {
        val directory = state.docsDirectory
        if (directory != null && WikiDocLogic.readsByDocs(directory)) {
            WikiDocsBrowsePage(directory, WikiDocActions(openDoc = { slug -> nav.open(OrbitRoute(Destination.WIKI_DOC, slug)) },
                openContents = { contentsShown = true }),
                openSection = { slug, key -> nav.open(OrbitRoute(Destination.WIKI_DOC, slug, wikiSection = key)) })
        } else {
            val categories = remember(state.directory) { state.directory?.let(WikiArticleLogic::browseCategories).orEmpty() }
            WikiBrowsePage(categories, WikiArticleActions(
                openArticle = { topic, part -> nav.open(OrbitRoute(Destination.WIKI_ARTICLE, topic, wikiPart = part)) },
                openContents = { contentsShown = true }))
        }
    }
    if (contentsShown) WikiContentsSheet(store, WikiContentsAt.Browse, runnerOnline = wikiMaintenanceRunnerOnline(state.currentSpace, data), close = { contentsShown = false }) { pick -> wikiGo(pick, nav) }
}

/** The A–Z index (iOS `WikiIndexScreen`): by document once a plan is confirmed, else by article. */
@Composable
internal fun WikiIndexScreen(store: WikiStore, route: OrbitRoute, data: DirectoryData, nav: WikiNav) {
    val state by store.state.collectAsState()
    val scope = rememberCoroutineScope()
    var contentsShown by rememberSaveable { mutableStateOf(false) }
    var refreshing by remember { mutableStateOf(false) }
    LaunchedEffect(store) { store.loadDocIndex(); store.loadArticleIndex() }
    WikiReadingBar(route, page = true) { contentsShown = true }
    PullToRefreshBox(isRefreshing = refreshing, onRefresh = {
        scope.launch { refreshing = true; try { store.loadDocIndex(); store.loadArticleIndex() } finally { refreshing = false } }
    }, modifier = Modifier.fillMaxSize().testTag("wiki-index")) {
        val index = state.docIndex
        if (index != null && index.plan != null) {
            WikiDocsIndexPage(index.items, WikiDocActions(openDoc = { slug -> nav.open(OrbitRoute(Destination.WIKI_DOC, slug)) },
                openContents = { contentsShown = true }),
                openSection = { slug, key -> nav.open(OrbitRoute(Destination.WIKI_DOC, slug, wikiSection = key)) })
        } else {
            val items = state.articleIndex?.items.orEmpty()
            val groups = remember(items) { WikiArticleLogic.indexGroups(items) }
            WikiIndexPage(groups, items.size, WikiArticleActions(
                openArticle = { topic, part -> nav.open(OrbitRoute(Destination.WIKI_ARTICLE, topic, wikiPart = part)) },
                openContents = { contentsShown = true }))
        }
    }
    if (contentsShown) WikiContentsSheet(store, WikiContentsAt.Index, runnerOnline = wikiMaintenanceRunnerOnline(state.currentSpace, data), close = { contentsShown = false }) { pick -> wikiGo(pick, nav) }
}

/** A reading page's bar: no title, as iOS's (`.navigationTitle("")` on the pages, none on their placeholders), and —
 * while the page, not a placeholder, is up — its one toolbar button, Contents. */
@Composable
internal fun WikiReadingBar(route: OrbitRoute, page: Boolean, openContents: () -> Unit) {
    PageBar.Bind(route, title = "", actions = if (!page) null else ({
        BarIcon(R.drawable.ic_contents, WikiArticleCopy.contents, "wiki-bar-contents", onClick = openContents)
    }))
}

/** What stands where a page would be: a spinner, or why it could not be read. */
@Composable
internal fun WikiReadingPlaceholder(tag: String, content: @Composable () -> Unit) {
    Box(Modifier.fillMaxSize().testTag(tag), contentAlignment = Alignment.Center) { content() }
}
