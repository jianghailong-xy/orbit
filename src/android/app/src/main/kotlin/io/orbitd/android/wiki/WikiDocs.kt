@file:OptIn(ExperimentalMaterial3Api::class)

package io.orbitd.android.wiki

import io.orbitd.android.directory.DirectoryData

import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import io.orbitd.android.directory.LoadingMessage
import io.orbitd.android.directory.StatusMessage
import io.orbitd.android.navigation.Destination
import io.orbitd.android.navigation.OrbitRoute
import kotlinx.coroutines.launch

// The document screen (iOS `WikiDocScreens.swift` § a document): it reads the Wiki store, mounts `WikiDocPage.kt`'s
// page over what it read, and decides where a press goes — pushed onto the Wiki section's stack, so Back returns here.

/** One document of the confirmed plan, read by its slug; a 404 is a document the plan does not have (iOS
 * `WikiDocScreen`). route.id = document slug, route.wikiSection = section key to scroll to (or null). */
@Composable
internal fun WikiDocScreen(store: WikiStore, route: OrbitRoute, data: DirectoryData, nav: WikiNav) {
    val slug = requireNotNull(route.id)
    val state by store.state.collectAsState()
    val scope = rememberCoroutineScope()
    var contentsShown by rememberSaveable { mutableStateOf(false) }
    var refreshing by remember { mutableStateOf(false) }
    LaunchedEffect(slug) { store.loadDoc(slug); store.loadDocsDirectory(); if (store.state.value.entries.isEmpty()) store.loadEntries() }
    val doc = state.docs[slug]
    val actions = WikiDocActions(
        openEntry = nav::entry,
        openDoc = { other -> nav.open(OrbitRoute(Destination.WIKI_DOC, other)) },
        openBrowse = { nav.open(OrbitRoute(Destination.WIKI_BROWSE)) },
        openContents = { contentsShown = true },
        openSource = { target -> wikiDocOpen(target, nav) })
    WikiReadingBar(route, page = doc != null, actions.openContents)
    PullToRefreshBox(isRefreshing = refreshing, onRefresh = {
        scope.launch { refreshing = true; try { store.loadDoc(slug) } finally { refreshing = false } }
    }, modifier = Modifier.fillMaxSize().testTag("wiki-doc")) {
        when {
            doc != null -> WikiDocPage(doc, WikiDocLogic.githubRepo(state.currentSpace?.repoUrlNorm), wikiDocsWritten(state), wikiEntrySummaries(state),
                route.wikiSection, actions)
            slug in state.missingDocs -> WikiReadingPlaceholder("wiki-doc-missing") {
                StatusMessage(WikiCopy.title, "That document is not in this space’s plan.")
            }
            slug in state.failedDocs -> WikiReadingPlaceholder("wiki-doc-failed") {
                StatusMessage("The document couldn't be loaded", "Check the connection, then try again.") { scope.launch { store.loadDoc(slug) } }
            }
            else -> WikiReadingPlaceholder("wiki-doc-loading") { LoadingMessage("Loading…") }
        }
    }
    if (contentsShown) WikiContentsSheet(store, WikiContentsAt.Doc(slug), runnerOnline = wikiMaintenanceRunnerOnline(state.currentSpace, data), close = { contentsShown = false }) { pick -> wikiGo(pick, nav) }
}

/** How many of the plan's documents are written, for a document not written yet. */
internal fun wikiDocsWritten(state: WikiState): Pair<Int, Int>? =
    state.docsDirectory?.takeIf { it.plan != null }?.docs?.let { it.written to it.total }

/** The space's newest entries, by id: the summaries under the entries the quotes came through. */
internal fun wikiEntrySummaries(state: WikiState): Map<String, String> =
    state.entries.mapNotNull { entry -> entry.summary?.let { wikiKey(entry.id) to it } }.toMap()

/** A footnote's one button (iOS `WikiDocScreen.open`): the session at the quoted record — the deep link criterion 10
 * rests on — the task, the session, the project, or the repository's host at the commit the run read it at. */
internal fun wikiDocOpen(target: WikiDocLogic.OpenTarget, nav: WikiNav) = when (target) {
    is WikiDocLogic.OpenTarget.SessionRecord -> nav.sessionRecord(target.session, target.record)
    is WikiDocLogic.OpenTarget.Task -> nav.task(target.id)
    is WikiDocLogic.OpenTarget.Session -> nav.session(target.id)
    is WikiDocLogic.OpenTarget.Project -> nav.project(target.id)
    is WikiDocLogic.OpenTarget.External -> nav.url(target.url)
}
