package io.orbitd.android.wiki

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.Saver
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import io.orbitd.android.directory.DirectoryData
import io.orbitd.android.directory.LoadingMessage
import io.orbitd.android.directory.StatusMessage
import io.orbitd.android.navigation.Destination
import io.orbitd.android.navigation.ObjectId
import io.orbitd.android.navigation.OrbitRoute
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject

// The plan's screens (iOS `WikiDocScreens.swift` § the plan): the plan page, a document of it, or a section of that,
// over the store's plan read — and every write the owner makes from them: Draft plan, Redraft…, Confirm plan, Edit, and
// a change's Accept and Reject. Where a press goes is decided here; the pages (`WikiPlanPage.kt`,
// `WikiPlanDocPages.kt`) know neither.

/** The runner a plan job would run on: the maintenance workspace's, as this client holds it (iOS `wikiMaintenanceRunnerID`). */
internal fun wikiMaintenanceRunnerId(space: WikiSpace?, data: DirectoryData): String? =
    space?.settings?.maintenance?.workspaceId?.let { id -> data.workspaces.firstOrNull { ObjectId.same(it.id, id) } }?.runnerId

/** The version asked for, as the web's page reads it: none is the one shown first; a failed draft's number is its draft;
 * the draft and the version in force are the read's own; any other is read whole (iOS `WikiPlanScreen.shown`). */
internal fun wikiPlanShown(state: WikiPlanState, asked: Int?, reads: Map<Int, WikiPlanVersion>): WikiPlanLogic.Shown? {
    asked ?: return WikiPlanLogic.defaultShown(state)
    WikiPlanLogic.failedJob(state)?.takeIf { asked == WikiPlanLogic.nextVersion(state) }?.let { failed ->
        return WikiPlanLogic.fromFailedJob(failed, asked, WikiPlanLogic.newest(state)?.version)
    }
    state.draft?.takeIf { it.version == asked }?.let { return WikiPlanLogic.fromVersion(it) }
    state.confirmed?.takeIf { it.version == asked }?.let { return WikiPlanLogic.fromVersion(it) }
    return reads[asked]?.let(WikiPlanLogic::fromVersion)
}

/** What an Edit sheet is open on: a document, or one of its sections. */
private data class WikiPlanEditTarget(val slug: String, val section: Int?) {
    val id get() = "$slug:${section?.toString() ?: "-"}"
}
private val editTargetSaver = Saver<WikiPlanEditTarget?, String>(
    save = { target -> target?.let { "${it.section ?: -1}:${it.slug}" } },
    restore = { saved -> WikiPlanEditTarget(saved.substringAfter(':'), saved.substringBefore(':').toInt().takeIf { it >= 0 }) })

/** The plan page, a document of it, or a section of that (WIKI_PLAN, WIKI_PLAN_DOC, WIKI_PLAN_SECTION). WIKI_PLAN:
 * route.wikiVersion = version shown (null = default). WIKI_PLAN_DOC: route.id = doc slug, route.wikiVersion.
 * WIKI_PLAN_SECTION: route.id = doc slug, route.wikiPart = 0-based section index, route.wikiVersion. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun WikiPlanScreen(store: WikiStore, route: OrbitRoute, data: DirectoryData, nav: WikiNav) {
    val state by store.state.collectAsState()
    val scope = rememberCoroutineScope()
    val now = rememberMinuteClock()
    var contentsShown by rememberSaveable { mutableStateOf(false) }
    var redrafting by rememberSaveable { mutableStateOf(false) }
    var editing by rememberSaveable(stateSaver = editTargetSaver) { mutableStateOf<WikiPlanEditTarget?>(null) }
    var refused by remember { mutableStateOf<Map<String, List<WikiPlanGateError>>>(emptyMap()) }
    var notice by rememberSaveable { mutableStateOf<String?>(null) }
    var refreshing by remember { mutableStateOf(false) }
    val slug = route.id.takeIf { route.destination != Destination.WIKI_PLAN }
    val index = route.wikiPart.takeIf { route.destination == Destination.WIKI_PLAN_SECTION }
    LaunchedEffect(route) {
        store.loadPlan()
        store.loadDocsDirectory()
        route.wikiVersion?.let { store.loadPlanVersion(it) }
    }
    val space = state.currentSpace
    val runnerOnline = wikiMaintenanceRunnerOnline(space, data)
    // On what: the provider the space's maintenance is pinned to.
    val provider = space?.settings?.maintenance?.provider

    // MARK: the writes

    /** Draft plan, or Redraft… with the owner's words. True once the server took it. */
    suspend fun redraft(words: String?): Boolean {
        val (created, refusal) = store.redraftPlan(words)
        if (refusal != null) { notice = refusal; return false }
        WikiToast.show(if (created) WikiPlanCopy.redraftAsked else WikiPlanCopy.redraftAlready)
        return true
    }
    suspend fun confirm(version: Int) {
        when (val answer = store.confirmPlan(version)) {
            is WikiStore.PlanWrite.Done -> {
                WikiToast.show(WikiPlanCopy.confirmed(answer.version))
                if (route.wikiVersion != null && slug == null) nav.replace(OrbitRoute(Destination.WIKI_PLAN))
            }
            is WikiStore.PlanWrite.Refused -> notice = answer.errors.joinToString("\n") { "${it.path} ${it.message}" }
            is WikiStore.PlanWrite.Failed -> notice = answer.message
        }
    }
    /** Accept: with no other draft waiting, one press accepts and confirms — two requests, the second only once the gate
     * passed the first; with a draft waiting, it adds the change to a new draft. Edit accepts only, and opens the new
     * draft's document to edit. */
    suspend fun accept(proposal: WikiPlanProposal, edit: Boolean) {
        val plan = store.state.value.plan ?: return
        refused = refused - proposal.id
        val (accepted, confirmed) = store.acceptPlanProposal(proposal.id, WikiPlanLogic.acceptConfirms(plan) && !edit)
        when (accepted) {
            is WikiStore.PlanWrite.Done -> {
                WikiToast.show(if (confirmed) WikiPlanCopy.confirmed(accepted.version) else WikiPlanCopy.changeAdded(accepted.version))
                if (route.wikiVersion != null && slug == null) nav.replace(OrbitRoute(Destination.WIKI_PLAN))
                if (edit) proposal.change?.doc?.slug?.let { editing = WikiPlanEditTarget(it, null) }
            }
            is WikiStore.PlanWrite.Refused -> refused = refused + (proposal.id to accepted.errors)
            is WikiStore.PlanWrite.Failed -> notice = accepted.message
        }
    }
    suspend fun reject(proposal: WikiPlanProposal) {
        val message = store.rejectPlanProposal(proposal.id)
        if (message != null) notice = message else WikiToast.show(WikiPlanCopy.changeRejected)
    }
    /** An edit, in the draft's shape. Null once the server took it, else what to show in the sheet. */
    suspend fun save(body: JsonObject): List<String>? = when (val answer = store.editPlan(body)) {
        is WikiStore.PlanWrite.Done -> { WikiToast.show(WikiPlanCopy.draftSaved(answer.version)); null }
        is WikiStore.PlanWrite.Refused -> answer.errors.map { "${it.path} ${it.message}" }
        is WikiStore.PlanWrite.Failed -> listOf(answer.message)
    }

    val actions = WikiPlanActions(
        draft = { scope.launch { redraft(null) } },
        redraft = { redrafting = true },
        confirm = { version -> scope.launch { confirm(version) } },
        pickVersion = { version -> nav.replace(OrbitRoute(Destination.WIKI_PLAN, wikiVersion = version)) },
        openDoc = { doc -> nav.open(OrbitRoute(Destination.WIKI_PLAN_DOC, doc, wikiVersion = route.wikiVersion)) },
        openSection = { doc, at -> nav.open(OrbitRoute(Destination.WIKI_PLAN_SECTION, doc, wikiPart = at, wikiVersion = route.wikiVersion)) },
        editDoc = { doc -> editing = WikiPlanEditTarget(doc, null) },
        editSection = { doc, at -> editing = WikiPlanEditTarget(doc, at) },
        accept = { proposal, edit -> scope.launch { accept(proposal, edit) } },
        reject = { proposal -> scope.launch { reject(proposal) } },
        openRun = nav::session,
        openSettings = { nav.open(OrbitRoute(Destination.WIKI_SETTINGS)) },
        openRunners = { wikiMaintenanceRunnerId(space, data)?.let(nav::runner) },
        openContents = { contentsShown = true },
        openEntry = nav::entry,
    )

    PullToRefreshBox(isRefreshing = refreshing, onRefresh = {
        scope.launch { refreshing = true; try { store.loadPlan() } finally { refreshing = false } }
    }, modifier = Modifier.fillMaxSize().testTag("wiki-plan")) {
        val plan = state.plan
        when {
            plan != null -> {
                val shown = remember(plan, route.wikiVersion, state.planVersionReads) { wikiPlanShown(plan, route.wikiVersion, state.planVersionReads) }
                if (slug != null) {
                    val doc = shown?.docs?.firstOrNull { it.slug == slug }
                    when {
                        shown != null && doc != null -> {
                            val canEdit = (shown.status == WikiPlanLogic.ShownStatus.DRAFT || shown.status == WikiPlanLogic.ShownStatus.CONFIRMED) &&
                                WikiPlanLogic.newest(plan)?.version == shown.version && doc.stored != null
                            if (index != null) {
                                if (index in doc.sections.indices) WikiPlanSectionPage(route, shown, doc, index, canEdit, actions)
                                else PlanPlaceholder(route, "wiki-plan-unavailable") { StatusMessage(WikiPlanCopy.title, "That section is not in this document.") }
                            } else WikiPlanDocPage(route, shown, doc, WikiPlanLogic.base(shown, plan), canEdit, actions)
                        }
                        shown == null -> PlanPlaceholder(route, "wiki-plan-loading") { LoadingMessage("Loading…") }
                        else -> PlanPlaceholder(route, "wiki-plan-unavailable") {
                            StatusMessage(WikiPlanCopy.title, "That document is not in this version of the plan.")
                        }
                    }
                } else {
                    val failed = WikiPlanLogic.failedJob(plan)
                    val inForce = shown?.status == WikiPlanLogic.ShownStatus.CONFIRMED && plan.confirmed?.version == shown.version
                    val card = WikiPlanLogic.jobCard(plan.job, now, runnerOnline,
                        if (shown?.status == WikiPlanLogic.ShownStatus.FAILED) failed else null, inForce, state.docsDirectory)
                    val rows = WikiPlanLogic.versionRows(state.planVersions, failed?.let { WikiPlanLogic.nextVersion(plan) to it.endedAt })
                    WikiPlanPage(route, plan, shown, shown?.let { WikiPlanLogic.base(it, plan) }, rows, card, planWritten(state),
                        wikiMaintenanceWhere(space, data), provider, now, state.busy, refused, actions)
                }
            }
            state.planMissing -> PlanPlaceholder(route, "wiki-plan-missing") { StatusMessage(WikiPlanCopy.title, WikiPlanCopy.none) }
            state.planState.lastLoadFailed -> PlanPlaceholder(route, "wiki-plan-failed") {
                StatusMessage("The plan couldn't be loaded", "Check the connection, then try again.") { scope.launch { store.loadPlan() } }
            }
            else -> PlanPlaceholder(route, "wiki-plan-loading") { LoadingMessage("Loading…") }
        }
    }

    // MARK: the sheets

    if (contentsShown) WikiContentsSheet(store, WikiContentsAt.Plan, runnerOnline, close = { contentsShown = false }) { pick -> wikiGo(pick, nav) }
    if (redrafting) {
        val newest = state.plan?.let(WikiPlanLogic::newest)
        val protectedDocs = newest?.let { version -> WikiPlanLogic.fromVersion(version).docs.filter { it.protected }.map { it.number } }.orEmpty()
        WikiPlanRedraftSheet(WikiPlanCopy.redraftNote(provider, newest?.let { it.version to (it.status == "confirmed") }), protectedDocs, state.busy,
            close = { redrafting = false }) { words -> redraft(words) }
    }
    // Edit a document, or one of its sections, of the newest version — the draft waiting, else the one in force.
    editing?.let { target ->
        val plan = state.plan
        val newest = plan?.let(WikiPlanLogic::newest)
        val doc = newest?.let { version -> WikiPlanLogic.fromVersion(version).docs.firstOrNull { it.slug == target.slug } }
        val stored = doc?.stored
        if (plan != null && newest != null && doc != null && stored != null) key(target.id) {
            val next = WikiPlanLogic.nextVersion(plan)
            val sections = stored.sections.orEmpty()
            val at = target.section
            if (at != null && at in sections.indices) {
                WikiPlanSectionEditSheet(at, sections[at], next, state.busy, close = { editing = null }) { title, kind, covers, length ->
                    save(WikiPlanLogic.sectionEditBody(newest.version, stored.slug, sections[at], title, kind, covers, length))
                }
            } else WikiPlanEditSheet(doc.number, stored, next, state.busy, close = { editing = null }) { input ->
                save(WikiPlanLogic.docEditBody(newest.version, stored.slug, input))
            }
        }
    }
    WikiRefusalAlert(notice) { notice = null }
}

/** How many of the plan's documents are written, for the version in force. */
private fun planWritten(state: WikiState): Pair<Int, Int>? = state.docsDirectory?.takeIf { it.plan != null }?.docs?.let { it.written to it.total }

/** A spinner or what iOS's `ContentUnavailableView` says, with the bar's title cleared as the pages clear it. */
@Composable
private fun PlanPlaceholder(route: OrbitRoute, tag: String, content: @Composable () -> Unit) {
    PageBar.Bind(route, title = "")
    Box(Modifier.fillMaxSize().testTag(tag), contentAlignment = Alignment.Center) { content() }
}
