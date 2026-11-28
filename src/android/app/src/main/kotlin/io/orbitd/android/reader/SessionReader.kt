package io.orbitd.android.reader

import io.orbitd.android.directory.QueuedCapacity
import io.orbitd.android.directory.RunningOverLimit
import io.orbitd.android.management.int
import io.orbitd.android.management.personalFailure
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.SizeTransform
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutVertically
import androidx.compose.animation.togetherWith
import android.content.Context
import androidx.compose.foundation.*
import androidx.compose.ui.platform.LocalContext
import androidx.core.content.edit
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.scrollBy
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.saveable.rememberSaveableStateHolder
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.BlendMode
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.CompositingStrategy
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.input.nestedscroll.*
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.platform.LocalWindowInfo
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.orbitd.android.OrbitApplication
import io.orbitd.android.perf.OrbitPerf
import io.orbitd.android.realtime.PagePoll
import io.orbitd.android.realtime.restoredFields
import io.orbitd.android.R
import io.orbitd.android.composer.CoordinatorHandoff
import io.orbitd.android.composer.echoed
import io.orbitd.android.composer.isCreate
import io.orbitd.android.composer.shownBy
import io.orbitd.android.composer.words
import io.orbitd.android.composer.CoordinatorHandoffApi
import io.orbitd.android.composer.CreatedWorkspaceLine
import io.orbitd.android.composer.HandedOverBanner
import io.orbitd.android.composer.HandoffNoteCard
import io.orbitd.android.composer.HandoffStatus
import io.orbitd.android.composer.CreatedWorkspaceLineView
import io.orbitd.android.composer.CloneHeard
import io.orbitd.android.composer.CloneState
import io.orbitd.android.composer.ManagementGithub
import io.orbitd.android.composer.WorkspaceClone
import io.orbitd.android.composer.DraftTarget
import io.orbitd.android.composer.MachineSetupCopy
import io.orbitd.android.composer.ProviderChoices
import io.orbitd.android.composer.ProviderEngines
import io.orbitd.android.composer.SessionComposer
import io.orbitd.android.composer.ManagedRunnerAsleepLine
import io.orbitd.android.composer.SessionPendingTray
import io.orbitd.android.cards.AnsweredQuestions
import io.orbitd.android.cards.conversationCard
import io.orbitd.android.cards.CardFocus
import io.orbitd.android.cards.LocalCardViewport
import io.orbitd.android.cards.CardReceiptSheet
import io.orbitd.android.cards.CardReviewSheet
import io.orbitd.android.cards.EvidenceFilesSheet
import io.orbitd.android.cards.LocalAnsweredQuestions
import io.orbitd.android.cards.LocalRevealItemCard
import io.orbitd.android.cards.LocalQueuedHeld
import io.orbitd.android.cards.LocalSteerDeliveries
import io.orbitd.android.cards.NeedsYouLogic
import io.orbitd.android.cards.SessionCardsReads
import io.orbitd.android.cards.rememberSessionCards
import io.orbitd.android.core.cards.BackgroundRow
import io.orbitd.android.core.cards.CardFamily
import io.orbitd.android.core.cards.CardPreviews
import io.orbitd.android.cards.ReaderSide
import io.orbitd.android.cards.SessionCards
import io.orbitd.android.cards.SessionRunStartCard
import io.orbitd.android.schedule.ScheduleConversationInsert
import io.orbitd.android.schedule.ScheduleInsert
import io.orbitd.android.schedule.ScheduleRunStatusCard
import io.orbitd.android.schedule.ScheduleRunStrip
import io.orbitd.android.schedule.ScheduledStore
import io.orbitd.android.cards.SessionTasksCard
import io.orbitd.android.cards.LocalWatchTargetNames
import io.orbitd.android.cards.watchTargetName
import io.orbitd.android.cards.OwnerRequestInConversation
import io.orbitd.android.cards.OwnerRequestStore
import io.orbitd.android.cards.CrossingCardStore
import io.orbitd.android.cards.CrossingCardView
import io.orbitd.android.cards.CrossingReviewSheet
import io.orbitd.android.projects.CrossingCards
import io.orbitd.android.taskprojects.canWrite
import io.orbitd.android.cards.runnerNames
import io.orbitd.android.core.cards.OwnerRequests
import io.orbitd.android.watch.SessionWatches
import io.orbitd.android.watch.rememberSessionTitles
import io.orbitd.android.wiki.PageBar
import io.orbitd.android.chat.ReaderChat
import io.orbitd.android.core.drive.DriveChatLogic
import io.orbitd.android.core.auth.SessionHandle
import io.orbitd.android.core.cards.obj
import io.orbitd.android.core.cards.text
import io.orbitd.android.core.cards.AntigravityRepair
import io.orbitd.android.core.cards.ClaudeRegion
import io.orbitd.android.core.cards.DshRuntime
import io.orbitd.android.core.cards.SessionRunStart
import io.orbitd.android.core.net.HttpMethod
import io.orbitd.android.core.protocol.Wire
import io.orbitd.android.core.realtime.*
import io.orbitd.android.directory.*
import io.orbitd.android.management.LocalSessionRecaps
import io.orbitd.android.management.LocalTranslation
import io.orbitd.android.translation.LocalShownOriginals
import io.orbitd.android.translation.ReplyTranslationFoot
import io.orbitd.android.translation.ShownOriginals
import io.orbitd.android.management.RunnerUpdateLater
import io.orbitd.android.management.RunnerUpdateLaterButton
import io.orbitd.android.management.RunnerPage
import io.orbitd.android.management.RunnerUpdateNow
import io.orbitd.android.management.RunnerUpdateNowButton
import io.orbitd.android.tasks.resolvedRunState
import io.orbitd.android.toast.OrbitToasts
import io.orbitd.android.toast.ToastTone
import io.orbitd.android.navigation.*
import io.orbitd.android.text.*
import io.orbitd.android.ui.LocalOrbitColors
import io.orbitd.android.ui.typingFold
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.*
import kotlinx.serialization.json.*

@Composable
fun SessionReader(app: OrbitApplication, handle: SessionHandle, route: OrbitRoute, api: DirectoryApi,
    data: DirectoryData, open: (OrbitRoute) -> Unit, leave: () -> Unit = {}, swap: (OrbitRoute) -> Unit = open,
    /** Drawn inside a page's chat sheet (PageChat): no page bar of its own, the chat's cards with their turns, its composer's chips. */
    chat: ReaderChat? = null) {
    // This page shows a conversation, and the store streams the one it shows: selecting it is the reader's own act, so a
    // landing session — which SessionDestination never sends here — is never subscribed to (§2.9 LS6). A reader leaving
    // clears the selection; a reader replacing another (a link to a second session) sets its own after the old one's.
    LaunchedEffect(handle, route.id) { app.realtime.selectSession(route.id) }
    DisposableEffect(handle, route.id) { onDispose { app.realtime.selectSession(null) } }
    var recordOpened by rememberSaveable { mutableStateOf(false) }
    val model = remember(handle, route.id, route.recordId) { SessionReaderModel(app.session, handle,
        app.realtime, route.id!!, app.processScope, route.recordId, recordOpened) }
    DisposableEffect(model) { onDispose { model.close() } }
    // D09 P02: the entry a tap or a link started, marked when its last page and composer are first drawn (LastPageMark).
    val lastPage = remember(handle, route.id, route.recordId) { LastPageMarks.claim(route) }
    val state by model.state.collectAsState()
    val composer = remember(app, handle, route.id) { app.composer(handle, route.id!!) }
    val composerState by composer.state.collectAsState()
    var composeFocus by remember(handle, route.id) { mutableIntStateOf(0) }
    var composerFocused by remember(handle, route.id) { mutableStateOf(false) }
    LaunchedEffect(state.window.seeded, state.loading, state.targetSeq) {
        if (route.recordId != null && state.window.seeded && !state.loading && state.targetSeq != null) recordOpened = true
    }
    // The reader's steers nothing has read yet wait in the tray above the composer, and each is drawn where its delivery settled — a
    // receipt in the queue's listing settles one no runner will speak for. Only a window at the live tail can see how they came out.
    val listedTurns = state.session?.snapshot?.queuedTurns.orEmpty()
    val atTail = state.window.newerAfter == null
    // The platform's turn asking a coordinator for its handoff note is Orbit's, not the owner's: the conversation shows only its progress
    // row and the note (board 02 ②).
    val rows = remember(state.window.events, listedTurns, atTail) { Steps.group(transcriptRows(state.window.events.filterNot {
        it.type == "user" && CoordinatorHandoff.isNotePrompt(it.fields.string("text")) }, listedTurns, holdsSteers = atTail)) }
    // What the list draws: the same rows with the turns Orbit opened folded into a line each, runs of them together (ExchangeFold).
    // Every other reading of the conversation keeps [rows], which hold each event. A watch's line names its target as the wake's own
    // line does, once the names below are known.
    var wakeNames by remember(handle, route.id) { mutableStateOf<(String, JsonObject) -> String?>({ _, _ -> null }) }
    val shownRows = remember(rows, wakeNames) { ExchangeFold.fold(rows, wakeNames) }
    // Each turn's head row, under the message that opened it (web `TurnHead`); only the newest may count up.
    val turnHeads = remember(state.window.events) { TurnHeads.of(state.window.events) }
    val newestHead = turnHeads.keys.maxOrNull()
    // What the tray holds, off the same events the rows leave them out of — or the live transcript's, while the reader is in history.
    val steerEvents = if (atTail) state.window.events else state.session?.transcript?.events.orEmpty()
    val unreadSteers = remember(steerEvents, listedTurns) { SteerDelivery.place(steerEvents, listedTurns).unread }
    val readable by rememberUpdatedState(!state.denied)
    val attachmentMetadata by rememberUpdatedState(state.window.events.flatMap { event ->
        (event.fields["attachments"] as? JsonArray).orEmpty().filterIsInstance<JsonObject>()
    }.associateBy { ObjectId.canonical(it.string("id").orEmpty()) })
    // The session's pictures in transcript order: image attachments, and uploads linked by name in prose.
    val galleryImages by rememberUpdatedState(remember(state.window.events) { sessionImages(state.window.events) })
    val resources = remember(handle, route.id) { ReaderResources(app.session, handle, route.id,
        available = { readable }, metadata = { source ->
            attachmentMetadata[ObjectId.canonical(source.removePrefix("orbit-attachment:"))]?.let {
                (it.string("name") ?: it.string("fileName") ?: "Attachment") to
                    (it.string("mime") ?: it.string("mimeType") ?: "application/octet-stream")
            }
        }, images = { galleryImages } ) }
    val openLink = rememberReaderLinkHandler(resources) { next ->
        if (next.destination == Destination.SESSION && ObjectId.same(next.id, route.id) &&
            next.recordId != null && next.recordId == route.recordId) model.openRecord(next.recordId)
        else open(next)
    }
    // The worktree bar's model: its own reads while an outcome is pending or the session is live, and the store's as they land.
    val worktree = remember(handle, route.id) { WorktreeModel(api, route.id!!, app.processScope) }
    // What the conversation's repair cards act through: the session's freshest detail, its runner, the composer (A07-4).
    val latestOpen by rememberUpdatedState(open)
    val console = remember(handle, route.id) { SessionConsole(app, handle, route.id!!, composer, app.processScope, reloadDetail = { worktree.loadDetail() },
        openRunner = { runner, engine -> latestOpen(OrbitRoute(Destination.RUNNER, runner, recordId = "engine:$engine")) },
        openSession = { latestOpen(OrbitRoute(Destination.SESSION, it)) },
        openDraft = { latestOpen(OrbitRoute(Destination.DRAFT, workspaceId = it)) }) }
    // The main checkout of the session's workspace (docs/main-checkout-git-contract.md): its card, bar, review sheet and lines.
    val mainCheckout = remember(handle, route.id) { MainCheckoutModel(api.mainCheckoutTransport(), route.id!!, app.processScope).also { mc ->
        mc.prefill = { composer.putBack(it) }
        mc.openDraft = { workspace, prompt ->
            val target = DraftTarget(workspace)
            app.composer(handle, target.key, target).putBackWhenLoaded(prompt)
            latestOpen(OrbitRoute(Destination.DRAFT, workspaceId = workspace))
        }
    } }
    val list = rememberLazyListState()
    // Opened from a project row onto the card a member waits on you with (owner 2026-11-14): placed at the cards, not the tail.
    val ontoWaitingCard = remember(route.id) { CardFocus.pending(route.id!!) == CardFocus.WAITING }
    DisposableEffect(route.id) { onDispose { if (CardFocus.pending(route.id!!) == CardFocus.WAITING) CardFocus.spend(route.id!!); CardFocus.release(route.id!!) } }
    // The record a jump landed on, held there like the opened card: the line's seq and the offset it was placed at.
    var recordHeld by remember(model) { mutableStateOf<Pair<Long, Int>?>(null) }
    val recordAt = remember(model) { LongArray(1) }
    // Rows start after the items the list draws ahead of them ("loading", "older", "handoff-note", "created-workspace"); the list's
    // builder writes it, so a jump counts what is there.
    val rowsStart = remember(model) { IntArray(1) { 1 } }
    val releaseHolds = {
        CardFocus.release(route.id!!); recordHeld = null
        if (CardFocus.pending(route.id!!) == CardFocus.WAITING) CardFocus.spend(route.id!!)
    }
    val latestRelease by rememberUpdatedState(releaseHolds)
    var follow by rememberSaveable { mutableStateOf(route.recordId == null && !ontoWaitingCard) }
    var placed by remember(model) { mutableStateOf(false) }
    var dragging by remember { mutableStateOf(false) }
    var positioning by remember { mutableStateOf(false) }
    var settings by rememberSaveable { mutableStateOf(false) }
    var action by remember { mutableStateOf<DirectoryDialog?>(null) }
    // A05-3: the session's ⋯ in the bar, where its Share button was (iOS d2858a5e8).
    val listed = remember(state.session?.snapshot?.detail) {
        state.session?.snapshot?.detail?.let { runCatching { Wire.json.decodeFromJsonElement(DirectorySession.serializer(), it) }.getOrNull() }
    }
    // Held by its runner's self-update (board 2 and 5 of docs/mocks/runner-update-drain): only the list row carries the server's queued
    // reason, so the page reads this session's row as the list has it.
    val listRow = remember(data.sessions, route.id) { data.sessions.values.asSequence().flatten().firstOrNull { ObjectId.same(it.id, route.id) } }
    // A full runner, run or batch is said in the same places by the same rules (docs/mocks/queued-card-runner-full), its foot drawing
    // QueuedCapacity's words; only the queued page and Later… are the update's alone.
    val runnerUpdatingGate = listRow?.takeIf {
        it.effectiveLifecycleState != "TRASH" && it.effectiveRunState == RunState.QUEUED && !it.regionHeld &&
            (RunnerUpdating.isRunnerUpdating(it.queuedGate) || QueuedCapacity.isCapacityHeld(it.queuedGate) ||
                QueuedDiskLow.isDiskHeld(it.queuedGate))
    }?.queuedGate
    val runnerUpdatingMachine = listRow?.let { data.machineName(it.workspace) }
    // Later… for the runner the update holds this session on (its workspace's runner), and Update Now… when that runner takes it: the
    // runner's row as GET /runners lists it says so, with the owner's turns in flight (`updateTurns`) the confirmation names. A runner
    // that is stopping, not updating, has nothing to postpone or install: neither (board runner-stopping ①).
    val runnerUpdatingRunner = listRow?.let { row -> data.workspaces.firstOrNull { ObjectId.same(it.id, row.workspace) }?.runnerId }
    val runnerUpdatingRow = runnerUpdatingRunner?.let { runnerId -> data.runnerRows.firstOrNull { ObjectId.same(it.text("id"), runnerId) } }
    val updateNowScope = rememberCoroutineScope()
    val runnerUpdatingLater: (@Composable () -> Unit)? = runnerUpdatingRunner?.takeIf { !RunnerUpdating.isRunnerStopping(runnerUpdatingGate) }?.let { runnerId -> {
        RunnerUpdateLaterButton(runnerUpdatingGate?.queuedRunnerUpdate?.targetVersion, runnerUpdatingMachine, { until ->
            runCatching { api.mutate(RunnerUpdateLater.path(runnerId), body = RunnerUpdateLater.body(until)) }
                .fold({ app.realtime.refreshDirectory(); null }, { it.message ?: RunnerUpdateLater.POSTPONE_FAILED })
        })
        runnerUpdatingRow?.takeIf(RunnerUpdateNow::offered)?.let { runner ->
            val version = RunnerUpdateNow.version(runner)
            RunnerUpdateNowButton(RunnerPage.displayName(runner), version, { RunnerPage.updateTurns(runner, System.currentTimeMillis()) }, {
                runCatching { api.mutate(RunnerUpdateNow.path(runnerId), body = RunnerUpdateNow.request()) }
                    .fold({
                        app.realtime.refreshDirectory(); OrbitToasts.show(RunnerUpdateNow.toast(version), tone = ToastTone.INFO)
                        // The runner answers on its next heartbeat, after that read: read again until it reports the restart.
                        updateNowScope.launch {
                            RunnerUpdateNow.awaitAnswer({
                                app.realtime.state.value.directory?.runners?.firstOrNull { ObjectId.same(it.text("id"), runnerId) }
                            }) { app.realtime.rereadDirectory() }
                        }
                        null
                    },
                        { it.message ?: RunnerUpdateNow.FAILED })
            })
        }
    } }
    // Run now in a full runner's, run's or batch's popover (docs/mocks/queued-run-now): this one queued turn over the limit. A
    // refusal the server gives only at the press is said in a toast; either way the row is read again.
    var runNowPending by remember(route.id) { mutableStateOf(false) }
    val runNow: (@Composable () -> Unit)? = runnerUpdatingGate?.takeIf(QueuedCapacity::isCapacityHeld)?.let { gate -> {
        RunNowAction(gate, runnerUpdatingMachine, runnerUpdatingRow?.int("activeSessions"), runnerUpdatingRow?.int("maxConcurrent"), runNowPending) {
            runNowPending = true
            updateNowScope.launch {
                try { api.mutate(listOf("sessions", route.id!!, "run-now")) }
                catch (cancel: CancellationException) { throw cancel }
                catch (e: Exception) { OrbitToasts.show(QueuedCapacity.RUN_NOW_FAILED, detail = personalFailure(e), tone = ToastTone.ERROR) }
                app.realtime.refreshDirectory(); app.realtime.refreshSession()
                runNowPending = false
            }
        }
    } }
    val actions = remember(api) { SessionActions(api, app) { app.realtime.refreshDirectory(); app.realtime.refreshSession() } }
    // The project this conversation is the coordinator or a member of (owner 2026-11-11, docs/mocks/project-sessions-column board 5):
    // its bar carries the button that opens the project's sessions in a sheet. Read off the detail, or the list's row before that.
    val projectId = listed?.projectMembership?.projectId ?: remember(data.sessions, route.id) {
        data.sessions.values.firstNotNullOfOrNull { rows -> rows.firstOrNull { ObjectId.same(it.id, route.id) }?.projectMembership?.projectId }
    }
    // The button's number is the sheet's head's: the project's Open and Completed sessions as the page reads them, read as the
    // conversation opens and kept current while it shows, or what the sheet itself last counted while its reads pause. No number until
    // the first read answers. It spins while anything the sheet shows is active (owner 2026-11-17, option C).
    var projectSheet by remember(handle, route.id) { mutableStateOf(false) }
    val projectButton by rememberProjectSessionsButton(app, handle, api, projectId, paused = projectSheet)
    var sheetCount by remember(projectId) { mutableStateOf<Int?>(null) }
    val link = remember(handle, route.id) { "${handle.account.server.trimEnd('/')}/sessions/${ObjectId.toPublic(route.id!!)}" }
    val currentRows by rememberUpdatedState(shownRows)
    val nested = remember { object : NestedScrollConnection {
        override fun onPreScroll(available: Offset, source: NestedScrollSource): Offset {
            if (source == NestedScrollSource.UserInput) { follow = false; dragging = true }
            return Offset.Zero
        }
    } }
    LaunchedEffect(model, state.denied) { if (state.denied) { action = null; settings = false; placed = false } }
    LaunchedEffect(state.ready, state.window.seeded, state.targetTick) {
        if (!state.ready || !state.window.seeded || state.denied) return@LaunchedEffect
        positioning = true
        if (!placed) follow = model.following && !ontoWaitingCard
        withFrameNanos { }
        val target = state.targetSeq?.let { anchorRow(currentRows, it) }
        if (target != null) {
            follow = false
            list.scrollToItem(rowsStart[0] + currentRows.indexOf(target), state.targetOffset)
            recordHeld = target.event.seq to state.targetOffset; recordAt[0] = CardFocus.now()
        } else if (follow) list.scrollToItem((list.layoutInfo.totalItemsCount - 1).coerceAtLeast(0))
        placed = true; positioning = false
    }
    // The observer writes a record+pixel offset, not an index that would change on a prepend.
    LaunchedEffect(model, list) {
        snapshotFlow { Triple(list.isScrollInProgress, list.layoutInfo.visibleItemsInfo, list.canScrollForward) }
            .collect { (scrolling, visible, canForward) ->
                if (placed && !positioning) {
                    if (!scrolling && dragging) { follow = !canForward && model.state.value.window.newerAfter == null; dragging = false }
                    val item = visible.firstOrNull { it.key.toString().startsWith("event:") }
                    val seq = item?.key?.toString()?.substringAfter(':')?.toLongOrNull()
                    if (seq != null) model.position(seq, -item.offset, follow)
                    // A reader resting on the cards, with no transcript row in view, still decides whether a resync may reseed under them.
                    else model.reading(follow)
                }
            }
    }
    // D09 P06 after a reclaim (OrbitPerf, off by default): once per relaunch, the first frame of this page — brought back from saved
    // state with the process — showing what it restored, as `p06_restored`: the draft in the composer, the list where it stood.
    val drawnBefore = rememberSaveable { booleanArrayOf(false) }
    val broughtBack = remember { drawnBefore[0].also { drawnBefore[0] = true } && app.realtimeLifecycle?.relaunched == true }
    if (broughtBack) {
        val view = LocalView.current
        LaunchedEffect(model) {
            val lifecycle = app.realtimeLifecycle
            if (lifecycle == null || lifecycle.restoredReported || !OrbitPerf.enabled) return@LaunchedEffect
            snapshotFlow { placed && !positioning && state.ready && !state.loading &&
                (composerState.loaded || !composerState.busy && composerState.error != null) }.first { it }
            // The composer copies a draft it read back into its box a frame later: two frames on, the next frame shows both.
            withFrameNanos { }; withFrameNanos { }
            if (lifecycle.restoredReported) return@LaunchedEffect
            lifecycle.restoredReported = true
            val shown = list.layoutInfo.visibleItemsInfo.firstOrNull { it.key.toString().startsWith("event:") }
            OrbitPerf.emitOnFrame(view, "p06_restored", restoredFields(route.id!!, composerState.loaded, composerState.draft.text,
                model.restored, shown?.key?.toString()?.substringAfter(':')?.toLongOrNull(), -(shown?.offset ?: 0), !list.canScrollForward))
        }
    }
    val transcript = state.session?.transcript
    val snapshotDetail = state.session?.snapshot?.detail
    // The conversation's cards, and the review a preview opens (A08-2), held outside the transcript's recyclable rows.
    val cards = rememberSessionCards(app, handle, route.id!!)
    // What this conversation asked the owner to do (web `useSessionOwnerRequestInserts`): each request in the transcript where it was
    // filed, read again behind each of the session's snapshot reads. Pending ones come from their own read as well.
    val ownerStore = remember(handle) { OwnerRequestStore.of(app.session, handle, app.processScope) }
    val ownerState by ownerStore.state.collectAsState()
    LaunchedEffect(ownerStore, route.id, state.session?.snapshotReads) { ownerStore.load(OwnerRequestStore.OPEN, OwnerRequestStore.ALL) }
    val ownerRequests = remember(ownerState.lists, route.id) {
        OwnerRequests.forSession(route.id!!, ownerState.list(OwnerRequestStore.ALL), ownerState.open)
    }
    val ownerRunner = remember(data.runners) { runnerNames(data.runners) }
    // The cross-project requests its project was asked, as cards in the conversation that coordinates it (`CrossingCards`): read
    // behind each of the session's snapshot reads, as the owner requests are. Only a coordinator's session names a project. The move
    // batches come from the session's own read as well, so the session that ASKED for them draws the same card (iOS
    // `ConsoleModel.refreshTaskMoves`); that read follows the row's waiting signal and its last turn too, because an answer given
    // at the other end drops the count to the "0" of a row that never waited, and only another read says it moved.
    val coordinated = snapshotDetail?.text("projectId")
    val crossingStore = remember(handle) { CrossingCardStore.of(app.session, handle, app.processScope) { app.canWrite(handle) } }
    val crossingState by crossingStore.state.collectAsState()
    LaunchedEffect(crossingStore, coordinated, state.session?.snapshotReads) { coordinated?.let(crossingStore::load) }
    LaunchedEffect(crossingStore, route.id, state.session?.snapshotReads, listed?.pendingApprovals, listed?.waitingKind, listed?.taskMoves,
        listed?.lastTurnAt) { crossingStore.loadMoves(route.id!!) }
    // A review open here is this conversation's: leaving it closes it.
    DisposableEffect(crossingStore) { onDispose { crossingStore.close() } }
    val crossingBatches = remember(crossingState.rows, crossingState.sessionMoves, coordinated, route.id) { crossingState.batches(coordinated, route.id) }
    // The scheduled tasks' cards this conversation asked and the changes it made, each where it happened; a run's own session gets
    // its strip at its planned time and its report after its end (docs/scheduled-tasks-design.md §8.1, §4, §7.4). Read behind each of the
    // session's snapshot reads, as the owner requests are.
    val scheduled = remember(handle) { ScheduledStore.of(app.session, handle, app.processScope) }
    val scheduledState by scheduled.state.collectAsState()
    val scheduleRunId = snapshotDetail?.text("scheduleRunId")
    val scheduleRead = scheduledState.session(route.id!!)
    val scheduledRun = scheduleRead?.run
    val scheduleRunStatus = scheduleRead?.runStatus
    val scheduleStatusKind = scheduleRead?.statusKind?.takeUnless {
        snapshotDetail?.text("lifecycleState") == "TRASH" || listRow?.effectiveLifecycleState == "TRASH"
    }
    LaunchedEffect(scheduled, route.id, scheduleRunId, state.session?.snapshotReads) {
        scheduled.loadSessionNow(route.id!!, scheduleRunId)
    }
    val scheduleInserts = remember(scheduledState.sessions, scheduledState.runs, route.id) { ScheduleInsert.of(scheduledState, route.id!!) }
    val drawSchedule: @Composable (ScheduleInsert) -> Unit = { insert ->
        key(insert.key) { Box(Modifier.conversationCard()) {
            ScheduleConversationInsert(insert, scheduled, route.id!!) { id ->
                open(OrbitRoute(Destination.SCHEDULED, ObjectId.canonical(id) ?: id, origin = Origin.LINK))
            } }
        }
    }
    // What the needs-you bar counts in this conversation (iOS `ConsoleModel.openBelowRows`), and which way it lies from
    // the reader: the cards are drawn in the rail before the tail, so they are above only once the reader is past it. A question
    // answered here stops counting with the press, not with the read after it (A08-13).
    // The owner requests it filed that still wait are drawn inline in the conversation, above the rail: they count first, in
    // conversation order (iOS `.ownerRequest`).
    val ownerPlacedAll = remember(shownRows, ownerRequests) { OwnerRequests.place(shownRows.map { it.event.ts }, ownerRequests) }
    val ownerRows = remember(ownerPlacedAll, state.window.hasOlder) { NeedsYouLogic.ownerRequestRows(ownerPlacedAll, state.window.hasOlder) }
    val railRows = remember(state.session?.snapshot, cards.answered) {
        state.session?.snapshot?.let { NeedsYouLogic.belowRows(state.session!!.id, it, cards.answered) }.orEmpty()
    }
    val belowRows = remember(ownerRows, railRows) { ownerRows + railRows }
    // …and its own approvals still asking, at the tail: the header's capsule counts them too (07-console-one-capsule).
    val approvalRows = remember(state.session?.snapshot, cards.answered) {
        state.session?.snapshot?.let { NeedsYouLogic.approvalRows(state.session!!.id, it, cards.answered) }.orEmpty()
    }
    // A08-4: the queue's turns drawn at the transcript's end, the ones the window has not seen delivered yet — but the reader's own
    // messages still on their way, which the tray above the composer holds; what Orbit queued keeps its card here. After them, the
    // reader's steers only the server's receipt says were not delivered, until Put back takes one away.
    val queuedTurns = remember(state.session?.snapshot?.queuedTurns, state.window.events, composerState.withdrawing, composerState.withdrawn) {
        val listed = state.session?.snapshot?.queuedTurns.orEmpty()
        queuedTail(listed, state.window.events).filterNot { it.inTray } + undeliveredTail(listed, state.window.events).filterNot {
            (ObjectId.canonical(it.turnId!!) ?: it.turnId) in composerState.withdrawing + composerState.withdrawn
        }
    }
    // A SubAgent's end turn still on the queue waits on its run's card, with Don't send ([subagentQueuedWakes]), not in the tail.
    val queued = remember(queuedTurns) { queuedTurns.filter { it.inTail() } }
    // Whether the tray holds a message of the reader's still waiting for its own turn: then its row says what holds it.
    val trayHeld = remember(state.session?.snapshot?.queuedTurns, state.window.events) {
        queuedTail(state.session?.snapshot?.queuedTurns.orEmpty(), state.window.events).any { it.inTray && it.heldByUpdate }
    }
    // A07-14: the turn the runner has taken, until its echo or its end — drawn where the echo will land, as the echo will be.
    // One the reader took back with Cancel under the held tag is gone at once, before the queue's re-read says so.
    val accepted = remember(state.session?.snapshot?.queuedTurns, state.window.events, composerState.withdrawn) {
        acceptedHeads(state.session?.snapshot?.queuedTurns.orEmpty(), state.window.events)
            .filterNot { head -> (ObjectId.canonical(head.turnId!!) ?: head.turnId) in composerState.withdrawn }
    }
    // That head, while a full runner, run or batch (or an update) holds it, is still the reader's to take back (web `cancellableHeldTurn`).
    val heldCancel = remember(state.session?.snapshot?.queuedTurns, state.window.events) {
        cancellableHeldTurn(state.session?.snapshot?.queuedTurns.orEmpty(), state.window.events)
    }
    val liveTail = transcript != null && state.window.newerAfter == null
    // The outbox's message and the one the server took last, while nothing of the server's draws them yet: an echo replaces either,
    // never stands beside it (docs/mocks/composer-sending-bubble).
    val pendingShown = composerState.draft.pending?.takeIf { pending ->
        !isCreate(pending.endpoint) && !echoed(pending.words, pending.afterSeq, state.window.events)
    }
    val sentShown = composerState.sent?.takeIf { !it.shownBy(state.session?.snapshot?.queuedTurns.orEmpty(), state.window.events) }
    val queuedShown = if (liveTail) queued.size else 0
    // Opened onto a waiting card: once placed, at the rail — the item before the queue and the tail — whose card then brings its
    // own top into view. Once per open; a jump the open itself asked for (a record) wins.
    var placedAtCards by remember(model) { mutableStateOf(false) }
    var listHeight by remember { mutableIntStateOf(0) }
    var cardsSize by remember { mutableIntStateOf(0) }
    // Held in place (web `landingRef`): the opened card, or a jumped-to record, is put back whenever the conversation changes around
    // it, until the reader takes the scroller, goes to the tail, or nothing has changed for HOLD_QUIET_MS.
    val heldCard = CardFocus.held(route.id!!)
    LaunchedEffect(heldCard?.key, state.window.events, cardsSize, state.session?.let(cards::shown)?.size) {
        val held = heldCard ?: return@LaunchedEffect
        if (!CardFocus.reapply(route.id!!)) return@LaunchedEffect
        // Once the change has been laid out: how far the card stands from where it was brought to, and back by that much.
        withFrameNanos { }; withFrameNanos { }
        val delta = (CardFocus.position(route.id!!, held.key) ?: return@LaunchedEffect) - held.top
        if (kotlin.math.abs(delta) >= 1f && CardFocus.held(route.id!!) == held) {
            positioning = true
            list.scrollBy(delta)
            positioning = false
            CardFocus.moved(route.id!!)
        }
    }
    LaunchedEffect(recordHeld, state.window.events, rowsStart[0], cardsSize) {
        val (seq, offset) = recordHeld ?: return@LaunchedEffect
        // Nothing has moved it for HOLD_QUIET_MS: let it go; otherwise put it back, and the quiet starts again.
        if (CardFocus.now() - recordAt[0] >= CardFocus.HOLD_QUIET_MS) { recordHeld = null; return@LaunchedEffect }
        val target = anchorRow(currentRows, seq)
        if (target != null && !positioning) {
            positioning = true
            val before = list.firstVisibleItemIndex to list.firstVisibleItemScrollOffset
            list.scrollToItem(rowsStart[0] + currentRows.indexOf(target), offset)
            positioning = false
            // Only a put-back that moved the view restarts the quiet (web `keepLanding`).
            if (before != (list.firstVisibleItemIndex to list.firstVisibleItemScrollOffset)) recordAt[0] = CardFocus.now()
        }
    }
    LaunchedEffect(follow) { if (follow) { CardFocus.release(route.id!!); recordHeld = null } }
    LaunchedEffect(placed) {
        if (!placed || !ontoWaitingCard || placedAtCards || route.recordId != null) return@LaunchedEffect
        positioning = true
        list.scrollToItem((list.layoutInfo.totalItemsCount - 2 - queuedShown).coerceAtLeast(0))
        placedAtCards = true
        positioning = false
    }
    // The questions whose answers the turns on screen hand to the coordinator — the window's, and at the live tail the accepted head and
    // the queue — are drawn by those turns, from the rail's records, and not again in the rail (`AnsweredQuestions`).
    val answeredQuestions = remember(state.session?.snapshot, state.session?.fresh, cards.answered, cards.previous, rows, accepted, queued, liveTail) {
        val tail = if (liveTail) accepted + queued.map { it.event } else emptyList()
        AnsweredQuestions(state.session?.let(cards::shown).orEmpty(), rows.map { it.event } + tail)
    }
    // The list item an inline owner request is drawn in: its host row's, or the "older" item ahead of every row (-1).
    val ownerHostIndex: (String) -> Int? = { row ->
        val id = row.removePrefix(NeedsYouLogic.ownerRequestPrefix)
        ownerPlacedAll.entries.firstOrNull { e -> e.value.any { it.id == id } }?.let { rowsStart[0] + it.key }
    }
    // A state the side reads, so a request that arrives after the first composition steers it too.
    val firstOwnerHost by rememberUpdatedState(belowRows.firstOrNull()?.rowId
        ?.takeIf { it.startsWith(NeedsYouLogic.ownerRequestPrefix) }?.let(ownerHostIndex))
    val readerSide by remember(list) { derivedStateOf {
        val host = firstOwnerHost
        val topItem = list.layoutInfo.visibleItemsInfo.lastOrNull { it.offset <= list.layoutInfo.viewportStartOffset }
        if (host != null && topItem != null) return@derivedStateOf if (host <= topItem.index) ReaderSide.ABOVE else ReaderSide.BELOW
        when (val top = topLineItem(list.layoutInfo.visibleItemsInfo, list.layoutInfo.viewportStartOffset)) {
            null -> null
            "tail" -> ReaderSide.ABOVE
            else -> if (top.startsWith("queued:")) ReaderSide.ABOVE else ReaderSide.BELOW
        }
    } }
    val scope = rememberCoroutineScope()
    // A press on what waits in this conversation: unpin the reader and show the waiting card, which the card rail brings into
    // view; a card answered in a review opens it, over the card it scrolled to (A08-3, iOS 419fa780b).
    val showWaiting: (String) -> Unit = { row ->
        follow = false
        scope.launch {
            val host = if (row.startsWith(NeedsYouLogic.ownerRequestPrefix)) ownerHostIndex(row) else null
            if (host != null) { list.scrollToItem(host); return@launch }
            // The rail is the item before the queue and the tail; a card in it is brought into view once it is drawn.
            list.scrollToItem((list.layoutInfo.totalItemsCount - 2 - queuedShown).coerceAtLeast(0))
            CardFocus.request(route.id!!, row)
            state.session?.let { live -> cards.shown(live).firstOrNull { it.key == row } }
                ?.takeIf { CardPreviews.preview(it) != null }?.let { cards.open(it.key) }
        }
    }
    // An exception delivery's Go to the item card ↑ (board card-ui-polish ②; iOS `revealOpenItemCard`): the item's own card, brought into
    // view the way a waiting card is, wherever this conversation's rail draws it — false when it draws none, which the delivery card says.
    val revealItemCard: (String) -> Boolean = { itemId ->
        state.session?.let(cards::shown).orEmpty().firstOrNull { it.family == CardFamily.EXCEPTION && ObjectId.same(it.objectId, itemId) }
            ?.let { showWaiting(it.key); true } ?: false
    }
    // The conversation's last row while it is at rest (RecapCard). It steps aside for the rest of this visit once the conversation
    // starts a new turn — the reader is in it now, and a card arriving under each answer would push the answer up — and is back the
    // next time the session is opened (the owner, 2026-10-22).
    val recapRests = listed?.let { RecapCard.rests(it) } ?: true
    var recapAside by remember(handle, route.id) { mutableStateOf(false) }
    LaunchedEffect(recapRests) { if (!recapRests) recapAside = true }
    // A recap this device hid with the card's × stays hidden in this conversation until the server writes a newer one (the owner,
    // 2026-11-01, docs/mocks/session-recap-display/06-hide); the list row keeps it.
    val context = LocalContext.current
    val recapPreferences = remember { context.getSharedPreferences("orbit.recaps", Context.MODE_PRIVATE) }
    var hiddenRecap by remember(route.id) {
        mutableStateOf(route.id?.let { recapPreferences.getString(RecapCard.hiddenPreferenceKey(it), null) })
    }
    val recapCard = if (recapAside) null else listed?.let { RecapCard.make(it, LocalSessionRecaps.current, hidden = hiddenRecap) }
    val hideRecap: () -> Unit = {
        val id = route.id
        val text = listed?.recapText?.trim()?.takeIf { it.isNotEmpty() }
        if (id != null && text != null) {
            val key = RecapCard.hideKey(listed?.recapAt, text)
            recapPreferences.edit { putString(RecapCard.hiddenPreferenceKey(id), key) }
            hiddenRecap = key
        }
    }
    LaunchedEffect(snapshotDetail) { snapshotDetail?.let(worktree::offer) }
    val worktreeState by worktree.state.collectAsState()
    LaunchedEffect(worktreeState.detail, snapshotDetail) { console.detail = worktreeState.detail ?: snapshotDetail }
    val sessionDetail = worktreeState.detail ?: snapshotDetail
    // Held by its GitHub workspace's clone: the waiting card says what is cloning and how far (web `useCloneWait`). A failed clone keeps
    // the plain sentence; the detail's workspace says which repository, the stream how far.
    val cloneHeld = listRow?.takeIf {
        it.effectiveLifecycleState != "TRASH" && it.effectiveRunState == RunState.QUEUED && !it.regionHeld && QueuedClone.isHeld(it.queuedGate)
    }?.queuedGate
    val heardClonesNow by app.clones.all.collectAsState()
    val cloneReadAt = remember(sessionDetail) { System.currentTimeMillis() }
    val cloneWait = if (cloneHeld == null || !QueuedClone.isCloning(cloneHeld)) null else {
        val workspace = sessionDetail?.get("workspace") as? JsonObject
        QueuedClone.wait(workspace, workspace?.string("id")?.let { heardClonesNow[WorkspaceClone.keyOf(it)] }, cloneReadAt)
    }
    val workspaceOfSession = (sessionDetail?.get("workspace") as? JsonObject)?.string("id") ?: sessionDetail?.string("workspaceId")
    LaunchedEffect(workspaceOfSession) { mainCheckout.bind(workspaceOfSession) }
    // What a Retry re-sends when it is the reader's: the newest message of a person the window holds.
    LaunchedEffect(rows) { console.lastUser = rows.lastOrNull { it.event.type == "user" && it.event.personWords().isNotBlank() }?.event }
    // An Antigravity failure said here is read against the runner and the providers, once, when it first appears.
    val antigravityFailure = remember(rows, snapshotDetail) {
        rows.any { it.event.type in setOf("error", "assistant") && AntigravityRepair.of(it.event.body().trim()) != null } ||
            AntigravityRepair.of(snapshotDetail?.string("error")) != null
    }
    LaunchedEffect(antigravityFailure, console.runnerId) { if (antigravityFailure) console.reload() }
    // So is a DeepSeek Harness one (A07-5) — and, from a server that doesn't say a session's engine, a session on a key or a pool,
    // whose engine the account's providers say: its cards and its failures follow it.
    val dshFailure = remember(rows, snapshotDetail) {
        rows.any { it.event.type == "error" && DshRuntime.repair(it.event.body().trim()) != null } || DshRuntime.repair(snapshotDetail?.string("error")) != null
    }
    val engineFromKeys = snapshotDetail?.let(ProviderChoices::engineFromKeys) == true
    LaunchedEffect(dshFailure || engineFromKeys, console.runnerId) { if (dshFailure || engineFromKeys) console.reload() }
    // A turn the runner refused for its Claude region: the card reads where the runner's connection came out and what else can run here
    // off the runner and the providers, and the composer's catalogue names a provider picked from it (docs/claude-region-check-contract.md).
    val regionError = ClaudeRegion.isRegionError(snapshotDetail?.string("error"))
    LaunchedEffect(regionError, console.runnerId) {
        if (!regionError) return@LaunchedEffect
        console.reload()
        if (composer.state.value.let { it.catalog == null && !it.catalogLoading }) composer.loadCatalog()
    }
    // A07-18: what this page reads off the runner — the composer's catalogue, the cards' runner — again on every reconnect, and
    // once a minute while the session streams, so a read that failed as the page opened, or a quota read before the phone slept,
    // does not stay that way.
    LaunchedEffect(console, model) {
        refreshWhileStreaming(model.state.map { it.session?.connection == ConnectionState.CONNECTED }, console::refreshRunner)
    }
    // The bar's detail follows the account stream like every page's poll: a read on a connect, the store's snapshot reads in between
    // ([WorktreeModel.offer]), a minute's safety read, and its own bounded cadence only while a merge or commit is in flight. It stops with
    // the Activity.
    PagePoll(app, handle, emptySet(), worktree, state.denied, inFlightMs = { worktree.inFlightMs() }) {
        if (!state.denied) {
            worktree.loadDetail()
            // The run can move on in a different session, without an update on this try's stream.
            if (scheduledRun?.state in setOf("QUEUED", "RUNNING") && scheduleRunStatus != null) {
                scheduled.loadSessionNow(route.id!!, scheduleRunId)
            }
        }
    }
    // A06-5: the viewport changing size under a pinned reader (keyboard, a taller composer, the reconnect
    // line) asks for the tail again; nothing else re-anchors the bottom of a list that shrank.
    val viewport = remember(model) { TranscriptViewport() }
    var repin by remember(model) { mutableIntStateOf(0) }
    LaunchedEffect(state.window.events, transcript?.textDrafts, transcript?.thinkingDrafts, transcript?.toolOutputs, follow, placed, repin,
        state.session?.snapshot?.queuedTurns) {
        if (placed && follow && !dragging && state.window.newerAfter == null && !state.loading) {
            withFrameNanos { }
            // A reader who stopped following during that frame stays where they went: a card brought into view, a touch.
            if (!follow || dragging) return@LaunchedEffect
            positioning = true
            list.scrollToItem((list.layoutInfo.totalItemsCount - 1).coerceAtLeast(0))
            positioning = false
        }
    }
    // A06-13 (iOS `TailPinning.followsGeometry`, 900e1810d and 66c42e852): rows that grow under a still, pinned list — a running
    // agent's line arriving, a picture or a row measured again — push the tail out of view, and nothing else would bring it back.
    // Only within the rule's slack and never after a scroll; the card rail, which arrives whole at any height, follows by its own size.
    FollowsTailGeometry(list, model, pinned = { placed && follow && !dragging && state.window.newerAfter == null && !state.loading },
        moving = { positioning }) { positioning = it }
    val rail = remember(model) { RailHeight() }
    // Background agents' and workflows' progress, as their cards and the background list read it.
    val background = state.session?.snapshot?.background
    val taskActivity = remember(transcript?.taskProgress, state.window.events, background) {
        TaskActivity.of(transcript?.taskProgress, state.window.events, background.orEmpty())
    }
    // The SubAgent runs by `delegate` call (GET /sessions/:id/subagents), which each SubAgent block draws its tier, model, duration,
    // cost and Why from: read again when a delegate call starts or ends (iOS `refreshSubagentRunsIfNeeded`). A session that never
    // delegated reads nothing, and a failed read is left alone until the transcript moves again.
    // So are the session's Orbit workflows (GET /sessions/:id/workflows), read with the runs whenever a workflow, or one of its calls, moves
    // (`WorkflowRuns.signature`); a workflow's calls' runs are among the SubAgent runs, under `<workflow call>#<callIndex>`.
    val delegateSignature = remember(state.window.events, background) { SubagentRuns.signature(state.window.events, background.orEmpty()) }
    val workflowSignature = remember(state.window.events, background) { WorkflowRuns.signature(state.window.events, background.orEmpty()) }
    var subagentRuns by remember(handle, route.id) { mutableStateOf<Map<String, SubagentRun>>(emptyMap()) }
    var workflowRuns by remember(handle, route.id) { mutableStateOf<Map<String, WorkflowRun>>(emptyMap()) }
    LaunchedEffect(handle, route.id, delegateSignature, workflowSignature) {
        if (delegateSignature.isEmpty() && workflowSignature.isEmpty()) { subagentRuns = emptyMap(); workflowRuns = emptyMap(); return@LaunchedEffect }
        suspend fun rows(path: String) = (Wire.decode(app.session.request(handle, io.orbitd.android.core.net.ApiRequest(listOf("sessions", route.id!!, path))).body,
            JsonElement.serializer()) as? JsonArray).orEmpty().filterIsInstance<JsonObject>()
        try {
            subagentRuns = SubagentRun.byCall(rows("subagents"))
            if (workflowSignature.isNotEmpty()) workflowRuns = WorkflowRun.byCall(rows("workflows"))
        } catch (cancel: CancellationException) { throw cancel } catch (_: Exception) { }
    }
    LaunchedEffect(cards, console.engine) { cards.engine = console.engine }
    val reviewStates = rememberSaveableStateHolder()
    val discussCard: ((String) -> Unit)? = if (!composerState.loaded) null else { context ->
        val prior = composer.state.value.draft.text
        val text = prior + (if (prior.isBlank()) "" else "\n\n") + context
        composer.edit(text, text.length, text.length)
        composerFocused = true
        composeFocus++
    }
    // A08-3: while a review is open the transcript does not follow its tail, so closing it returns to the card's place.
    LaunchedEffect(cards.review) { if (cards.review != null) follow = false }
    // How far each steer got, by its turn: the latest `user_delivery` the window holds (A08-11's wake receipt reads it).
    val steerDeliveries = remember(state.window.events) {
        state.window.events.filter { it.type == "user_delivery" }
            .mapNotNull { event -> event.fields.string("turnId")?.let { turn -> event.fields.string("delivery")?.let { turn to it } } }.toMap()
    }
    // A08-14: what a watch's wake line calls the targets that moved — the watches this conversation observes, the session list,
    // and its own Tasks card.
    val sessionTitles = rememberSessionTitles(app, handle)
    val targetNames = remember(cards.watches, cards.created, sessionTitles) {
        { watchId: String, target: JsonObject -> watchTargetName(watchId, target, cards.watches.map { it.source }, { sessionTitles(it) }, cards.created) }
    }
    LaunchedEffect(targetNames) { wakeNames = targetNames }
    val exchangeTree = rememberExchangeTree(app, handle, state.session?.snapshot?.detail)
    // Settings › Translation: which messages this visit flipped to their original — never persisted (board frame 5).
    val shownOriginals = remember(handle, route.id) { ShownOriginals() }
    // The main checkout's result lines, which a card above them reads to know it was handled.
    val mainCheckoutResults = remember(state.window.events) {
        state.window.events.filter { it.type == "system" }.mapNotNull { e -> MainCheckout.resultNotice(e.fields)?.let { e.seq to it } }
    }
    // Each SubAgent end turn loaded, by run id: its card draws the end, so the turn itself draws nothing (SubagentCardEnd).
    val subagentWakes = remember(state.window.events, steerDeliveries) { subagentWakesOf(state.window.events, steerDeliveries) }
    val queuedCancelEnabled = state.session?.fresh == true && !composerState.busy
    val subagentQueued = remember(queuedTurns, queuedCancelEnabled, liveTail) {
        if (!liveTail) emptyMap() else subagentQueuedWakes(queuedTurns, queuedCancelEnabled) { turnId -> composer.control("turns/$turnId", HttpMethod.DELETE) }
    }
    // Each bg_run job's card reads its job by id: its row of the Background list, its wake turns, a wake still on the queue, and the
    // tail and stop routes (JobCardView; board 350t1lTONlrPMjilBdXx7, rulings R1-R4).
    val jobApi = remember(handle, route.id) { BackgroundJobApi(app.session, handle, route.id!!) }
    val jobWakes = remember(state.window.events, steerDeliveries) { JobCards.wakes(state.window.events, steerDeliveries) }
    val jobQueued = remember(queuedTurns, queuedCancelEnabled, liveTail) {
        if (!liveTail) emptyMap() else jobQueuedWakes(queuedTurns, queuedCancelEnabled) { turnId -> composer.control("turns/$turnId", HttpMethod.DELETE) }
    }
    val jobSessionLive = BackgroundTrayLogic.sessionLive(sessionDetail)
    val jobWhere = (sessionDetail?.get("workspace") as? JsonObject)?.string("name") ?: worktreeState.workspace?.string("name")
    val jobCards = remember(background, jobWakes, jobQueued, jobSessionLive, jobWhere, jobApi) {
        JobCards(JobCards.shells(background.orEmpty()), jobWakes, jobQueued, jobSessionLive, jobWhere, jobApi::tail, jobApi::stop)
    }
    // A job's row in the opened Background list goes to its card, when that card is drawn (R1).
    val jobCalls = remember(state.window.events) { jobCallsById(state.window.events) }
    val jobJump: (String) -> (() -> Unit)? = { jobId ->
        jobCalls[jobId]?.takeIf { seq -> currentRows.any { it.contains(seq) } }?.let { seq -> { model.show(seq) } }
    }
    // A workflow's finished strip points back at its block, when that block is drawn.
    val workflowCalls = remember(state.window.events) {
        state.window.events.filter { it.type == "tool_use" && it.parent() == null && it.fields.string("name") == WorkflowBlock.TOOL_NAME }
            .mapNotNull { e -> e.toolId()?.let { it to e.seq } }.toMap()
    }
    val workflowJump: (String) -> (() -> Unit)? = { toolUseId ->
        workflowCalls[toolUseId]?.takeIf { seq -> currentRows.any { it.contains(seq) } }?.let { seq -> { model.show(seq) } }
    }
    CompositionLocalProvider(LocalMainCheckoutResults provides mainCheckoutResults, LocalReaderResources provides resources, LocalShownOriginals provides shownOriginals, LocalTaskActivity provides taskActivity, LocalSteerDeliveries provides steerDeliveries,
        LocalSessionConsole provides console, LocalMainCheckout provides mainCheckout, LocalWatchTargetNames provides targetNames, LocalAnsweredQuestions provides answeredQuestions,
        LocalRevealItemCard provides revealItemCard, LocalExchangeTree provides exchangeTree, LocalSubagentRuns provides subagentRuns,
        LocalSubagentWakes provides subagentWakes, LocalSubagentQueuedWakes provides subagentQueued,
        LocalWorkflowRuns provides workflowRuns, LocalWorkflowCardJump provides workflowJump, LocalJobCards provides jobCards) {
        SessionCardsReads(cards)
        BoxWithConstraints(Modifier.fillMaxSize()) {
        val view = LocalView.current
        val composerHeight = ComposerFold.height(maxHeight, WindowInsets.ime.getBottom(LocalDensity.current), ComposerFold.windowIme(view), composerFocused)
        // Clipped only while folded to nothing for a card's form: open, the composer card's light shadow spreads over the page above it (iOS).
        val compact = maxWidth < 600.dp
        // What D09 P02 waits for, as this frame composes it: the newest durable row of a window at the live tail (the list's
        // measure says whether it is on screen), and a composer that takes typing, with room, in a window no dialog covers.
        if (lastPage != null) {
            val focused = LocalWindowInfo.current.isWindowFocused
            val tail = shownRows.lastOrNull()?.takeIf { !state.denied && state.window.seeded && state.window.newerAfter == null }?.let { it.key to it.newestSeq }
            val composerUsable = composerState.loaded && composerHeight > 0.dp && focused && !state.denied
            SideEffect { lastPage.composed(view, tail, state.firstSeed, composerUsable) }
        }
        // iOS `ConsoleView.foldsChrome`: on a phone, while the composer holds the keyboard the conversation gets the
        // screen. The shell's bar, the needs-you bar, the reconnect line and the cards above the composer fold away together, and come
        // back when the keyboard goes; a wide page keeps all of it.
        val foldsChrome = composerFocused && compact
        // A06-18 (iOS d87e5fa67, e9c1552f5): the bar names no session. Between back and the ⋯ it carries the question above the
        // fold, as a capsule, only while the reader is off the live tail — scrolled up, or reading a window opened at a record —
        // which is when the jump row shows too; at the tail the reader is following the answer to what they just asked, and the
        // bar's middle stays empty. Only the capsule reads the named question, so a scroll past one redraws it alone; and the bar
        // keeps the content it is first handed, so both are states the content reads as it draws.
        val question = rememberStuckQuestion(shownRows, list)
        val offTail by rememberUpdatedState(!state.denied && (!follow || state.window.newerAfter != null))
        // A05-3: the session's ⋯ in the bar, where its Share button was (iOS d2858a5e8), bound while this page shows.
        // One capsule there (the owner, 2026-11-15, `docs/mocks/needs-you-capsule/07-console-one-capsule`, B): what waits on the
        // reader in THIS conversation takes it while its card is out of sight — above them, or anywhere once they are off the tail
        // (at the tail the card is the tail); otherwise the question. What waits elsewhere is not said here; the lists say it.
        val here = NeedsYouLogic.here(belowRows, approvalRows, readerSide)
        // A coordinator handing itself over takes the capsule over both, at the tail and off it, while the note is written and the
        // replacement runs (the owner, 2026-11-15, coordinator-context-actions board 04, A; iOS `handingOverCapsule`).
        // A state the capsule reads, like `offTail`: the bar keeps the content it is first handed.
        val handingOver by rememberUpdatedState(CoordinatorHandoff.outgoing(snapshotDetail)?.locksComposer == true)
        if (chat == null) PageBar.Bind(route, title = null, folds = foldsChrome, center = {
            // One capsule changing between them (08-motion ⑤): the old words leave upward, the new come in from below.
            val saysWaiting = !handingOver && here != null && (here.side == ReaderSide.ABOVE || offTail)
            AnimatedContent(handingOver to saysWaiting, transitionSpec = {
                (slideInVertically { it / 2 } + fadeIn()) togetherWith (slideOutVertically { -it / 2 } + fadeOut()) using SizeTransform(clip = false)
            }, label = "header-capsule") { (handing, waitingNow) ->
                if (handing) HandingOverCapsule()
                else if (waitingNow && here != null) WaitingCapsule(here) { showWaiting(here.rowId) }
                else if (offTail) question.value?.let { QuestionCapsule(it) { row -> model.show(row.event.seq) } }
            }
        }, actions = {
            if (projectId != null) ProjectSessionsButton(projectButton.count ?: sheetCount, projectButton.active) { projectSheet = true }
            SessionMenu(listed.takeUnless { state.denied }, state.session?.snapshot?.detail, link, state.session?.fresh == true && data.fresh,
                actions, open, { action = it }, { settings = true }, leave)
        })
        if (projectSheet && projectId != null) ProjectSessionsSheet(app, handle, projectId, route.workspaceId, data, api, open,
            close = { projectSheet = false }, onCount = { sheetCount = it }) { next ->
            projectSheet = false
            if (!ObjectId.same(next.id, route.id)) swap(next)
        }
        Column(Modifier.fillMaxSize()) {
            val session = state.session
            val detail = session?.snapshot?.detail
            var renamedWorkspaceName by remember(handle, route.id) { mutableStateOf<String?>(null) }
            // When the detail the created line draws from was read: a clone frame heard before it is older news than its cloneState.
            val madeReadAt = remember(worktreeState.detail ?: detail) { System.currentTimeMillis() }
            val github = remember(handle) { ManagementGithub(io.orbitd.android.management.ManagementApi(app.session, handle, app.processScope)) }
            val createdWorkspaceLine = remember(detail, worktreeState.detail, data.effectiveRunnerRows, data.effectiveWorkspaceRows, renamedWorkspaceName) {
                val source = worktreeState.detail ?: detail ?: return@remember null
                CreatedWorkspaceLine.fromSession(source, data.effectiveRunnerRows, data.effectiveWorkspaceRows)?.let { line ->
                    if (renamedWorkspaceName != null) line.copy(name = renamedWorkspaceName!!) else line
                }
            }
            if (state.denied) {
                StatusMessage("Session unavailable", if (session?.error?.httpStatus == 403) "You don't have permission to access this item." else "This item is no longer available.", model::retry)
            } else if (scheduleStatusKind != null && scheduledRun != null && scheduleRunStatus != null) {
                val schedule = scheduledState.run(route.id!!)?.schedule
                val runner = data.effectiveRunnerRows.firstOrNull {
                    ObjectId.same(it.text("id"), detail?.text("assignedRunnerId"))
                }?.let { io.orbitd.android.management.RunnerPage.displayName(it) }
                    ?: data.machineName(workspaceOfSession ?: schedule?.workspaceId) ?: "The runner"
                val engine = detail?.text("engine") ?: schedule?.engine ?: detail?.text("provider")
                Column(
                    Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(horizontal = 16.dp, vertical = 12.dp),
                    verticalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    if (schedule != null) {
                        val conditionId = schedule.condition?.id
                        LaunchedEffect(conditionId, scheduledRun.trigger) {
                            if (scheduledRun.trigger == "CONDITION") conditionId?.let(scheduled::loadCondition)
                        }
                        Box(Modifier.conversationCard()) {
                            ScheduleRunStrip(schedule, scheduledRun, scheduledState.condition(conditionId), notStarted = true)
                        }
                    }
                    Box(Modifier.conversationCard()) {
                        ScheduleRunStatusCard(scheduledRun, scheduleRunStatus, scheduleStatusKind, scheduled, route.id!!, runner,
                            engine?.let(ProviderEngines::cliName) ?: "The engine",
                            openSchedule = { open(OrbitRoute(Destination.SCHEDULED, it, origin = Origin.LINK)) },
                            openRun = { open(OrbitRoute(Destination.SESSION, it, folderId = ScheduledRunsFolder.ID)) })
                    }
                }
            } else {
                Column(Modifier.weight(1f).fillMaxWidth()) {
                state.error?.let { StatusMessage("Couldn't load messages", it, model::retry) }
                // Capture all lazy intervals in this composition, preserving A05's measurement fix.
                val displayedRows = shownRows
                val displayedWindow = state.window
                // Inside the row it follows, so no list index moves: the reader's jumps count rows.
                val ownerPlaced = remember(displayedRows, ownerRequests) { OwnerRequests.place(displayedRows.map { it.event.ts }, ownerRequests) }
                val crossingPlaced = remember(displayedRows, crossingBatches) { CrossingCards.place(displayedRows.map { it.event.ts }, crossingBatches) }
                // An owner request's link opened this conversation onto its card (OwnerRequestLinks): once the reader has placed itself, the
                // row the card follows is scrolled to, and the card brings itself into view when drawn (OwnerRequestInConversation).
                val ownerFocus = CardFocus.pending(route.id!!)?.takeIf { it.startsWith(CardFocus.OWNER_REQUEST) }
                LaunchedEffect(ownerFocus, ownerPlaced, placed) {
                    if (ownerFocus == null || !placed) return@LaunchedEffect
                    val index = ownerPlaced.entries.firstOrNull { (_, asked) -> asked.any { CardFocus.ownerRequest(it.id) == ownerFocus } }?.key
                        ?: return@LaunchedEffect
                    follow = false
                    // Ahead of the rows: the loading line until the window is seeded, the older-messages item, and the created-workspace line.
                    val lead = (if (displayedWindow.seeded) 0 else 1) + 1 + (if (createdWorkspaceLine != null && !displayedWindow.hasOlder) 1 else 0)
                    list.scrollToItem(if (index < 0) 0 else index + lead)
                }
                val schedulePlaced = remember(displayedRows, scheduleInserts) { ScheduleInsert.place(displayedRows.map { it.event.ts }, scheduleInserts) }
                // A page chat's cards, each after the last row of its turn (web `useDriveChatCards`); the rest go under the conversation.
                val chatCards = chat?.cards.orEmpty()
                val chatPlaced = remember(displayedRows, displayedWindow.events, chatCards) {
                    if (chatCards.isEmpty()) emptyMap() else {
                        val lastOfTurn = HashMap<String, Long>()
                        displayedWindow.events.forEach { e -> e.turnId?.let { t -> val k = ObjectId.canonical(t) ?: t; lastOfTurn[k] = maxOf(lastOfTurn[k] ?: e.seq, e.seq) } }
                        val at = DriveChatLogic.place(displayedRows.map { it.event.seq }, { lastOfTurn[ObjectId.canonical(it) ?: it] },
                            chatCards.map { it.key to it.turnId })
                        chatCards.filter { it.key in at }.groupBy { at.getValue(it.key) }
                    }
                }
                val chatRest = remember(chatPlaced, chatCards) { chatCards.filter { card -> chatPlaced.values.none { card in it } } }
                val live = transcript.takeIf { displayedWindow.newerAfter == null }
                // A turn running now, read at the live tail: only there is the window's newest head the turn in hand. Not a run that is
                // merely live: a turn stopped without a `turn_end` would count up for as long as the session waits (iOS reads `.running` too).
                val sessionLive = live != null && (worktreeState.detail ?: snapshotDetail)?.let(::resolvedRunState) == "RUNNING"
                val displayedLoading = state.loading
                // The message a runner update holds: the last one the reader sent, whose foot row says why (board 2 ⑤). None while the
                // session is not held by an update, and none off the live tail.
                // A turn on the queued tail the update holds says so on its own line instead (docs/mocks/queued-card-runner-updating ②).
                // So does the reader's own waiting message in the tray, whose row says it (docs/mocks/queued-card-runner-full ②).
                val tailHeld = runnerUpdatingGate != null && live != null && (queued.any { it.heldByUpdate } || trayHeld)
                // The accepted head, when there is one, is the reader's last message: the foot row goes under it (iOS c2cc655ac8).
                val heldHead = if (runnerUpdatingGate == null || live == null || tailHeld) null else accepted.lastOrNull()
                val heldSeq = if (runnerUpdatingGate == null || live == null || tailHeld || heldHead != null) null
                    else displayedRows.lastOrNull { it.event.type == "user" && it.steps.isEmpty() && it.exchanges.isEmpty() }?.event?.seq
                // A turn started over its runner's limit says so under the message that opened it, while it runs (docs/mocks/queued-run-now ②):
                // the accepted head until its echo lands, else the open turn's own message.
                val overflow = listRow?.takeIf { live != null && it.effectiveLifecycleState != "TRASH" && it.effectiveRunState == RunState.RUNNING }
                    ?.let { RunningOverLimit.of(it.runningOverLimit) }
                val overflowSeq = if (overflow == null || accepted.isNotEmpty()) null else openTurnUserSeq(state.window.events)
                val targetSeq = state.targetSeq
                Box(Modifier.weight(1f).fillMaxWidth()) {
                LazyColumn(Modifier.fillMaxSize().fadesIntoComposerBand().onSizeChanged {
                    listHeight = it.height
                    if (viewport.resized(it.height, placed && follow && state.window.newerAfter == null)) repin++
                }.nestedScroll(nested).pointerInput(model) {
                    // Do not consume the gesture: native selection/links still receive it.
                    // A touch pauses following so a live update cannot move text under a selection.
                    awaitEachGesture { awaitFirstDown(requireUnconsumed = false); follow = false; latestRelease() }
                }.testTag("transcript-list").lastPageProbe(lastPage, list, view), state = list,
                    // No room under the rows but the tail row's own: every follow and jump lands on it (iOS 9d3751ec2).
                    // iOS `rowInsets`: 16 at the sides, 6 above and below every row, so 12 between two.
                    contentPadding = PaddingValues(start = 16.dp, end = 16.dp, top = 12.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    if (!displayedWindow.seeded) item(key = "loading") { LoadingMessage("Loading messages…") }
                    item(key = "older") {
                        if (displayedWindow.hasOlder) TextButton(enabled = !displayedLoading, onClick = { follow = false; model.older() }) { Text(if (displayedLoading) "Loading messages…" else "Load earlier messages") }
                        else if (ownerPlaced[-1] != null || crossingPlaced[-1] != null || schedulePlaced[-1] != null) Column(verticalArrangement = Arrangement.spacedBy(16.dp)) {
                            schedulePlaced[-1]?.forEach { drawSchedule(it) }
                            ownerPlaced[-1]?.forEach { key(it.id) { Box(Modifier.conversationCard()) { OwnerRequestInConversation(it, ownerStore, ownerRunner, openLink, route.id, discussCard) } } }
                            crossingPlaced[-1]?.forEach { key(it.id) { Box(Modifier.conversationCard()) { CrossingCardView(it, crossingState) { crossingStore.open(it.id) } } } }
                        }
                    }
                    // Board 02 ③: a successor opens with the note its predecessor wrote, and the waits that moved here.
                    val receivedHandoff = CoordinatorHandoff.received(detail)
                    rowsStart[0] = (if (!displayedWindow.seeded) 1 else 0) + 1 + (if (receivedHandoff != null && displayedWindow.seeded && !displayedWindow.hasOlder) 1 else 0) +
                        (if (createdWorkspaceLine != null && !displayedWindow.hasOlder) 1 else 0)
                    if (receivedHandoff != null && displayedWindow.seeded && !displayedWindow.hasOlder) item(key = "handoff-note") { Box(Modifier.conversationCard()) {
                        HandoffNoteCard(receivedHandoff, io.orbitd.android.core.cards.CoordinatorCleanStart.history(
                            detail?.text("createdAt"), session?.snapshot?.standing.orEmpty(), cards.merged)) { open(OrbitRoute(Destination.SESSION, it)) }
                    } }
                    if (createdWorkspaceLine != null && !displayedWindow.hasOlder) {
                        item(key = "created-workspace") { Box(Modifier.conversationCard()) {
                            // A workspace cloned from GitHub: where its clone stands, from the detail (read at `madeReadAt`) and the stream.
                            val heardClones by app.clones.all.collectAsState()
                            val clone = createdWorkspaceLine.cloneState?.let { stored ->
                                WorkspaceClone.now(stored, heardClones[WorkspaceClone.keyOf(createdWorkspaceLine.workspaceId)], madeReadAt)
                            }
                            CreatedWorkspaceLineView(
                                clone = clone,
                                github = github,
                                onRetry = {
                                    github.retryClone(createdWorkspaceLine.workspaceId)
                                    app.clones.hear(createdWorkspaceLine.workspaceId, CloneHeard(CloneState.PENDING))
                                    app.realtime.refreshSession()
                                    worktree.loadDetail()
                                },
                                line = createdWorkspaceLine,
                                settingsEnabled = data.workspaces.any { ObjectId.same(it.id, createdWorkspaceLine.workspaceId) } ||
                                    data.effectiveWorkspaceRows.any { ObjectId.same(it.string("id"), createdWorkspaceLine.workspaceId) },
                                onRename = { newName ->
                                    scope.launch {
                                        try {
                                            api.renameWorkspace(createdWorkspaceLine.workspaceId, newName)
                                            renamedWorkspaceName = newName
                                            app.realtime.refreshDirectory()
                                            app.realtime.refreshSession()
                                        } catch (cancel: CancellationException) {
                                            throw cancel
                                        } catch (e: Exception) {
                                            OrbitToasts.show(
                                                MachineSetupCopy.CREATED_RENAME_FAILED,
                                                detail = io.orbitd.android.directory.directoryError(e),
                                                tone = ToastTone.ERROR,
                                            )
                                        }
                                    }
                                },
                                onOpenSettings = {
                                    open(OrbitRoute(Destination.SETTINGS, id = "workspace", workspaceId = createdWorkspaceLine.workspaceId))
                                },
                            )
                        } }
                    }
                    itemsIndexed(displayedRows, key = { _, it -> it.key }, contentType = { _, it -> if (it.steps.isNotEmpty()) "steps" else it.event.type }) { index, row ->
                        val asked = ownerPlaced[index]
                        val crossings = crossingPlaced[index]
                        val scheduleThings = schedulePlaced[index]
                        val chatThings = chatPlaced[index]
                        // The turn's head row sits in its message's item, like the owner's requests, so no list index moves.
                        val head = turnHeads[row.event.seq]?.takeIf { row.event.type == "user" && row.steps.isEmpty() }
                        val held = runnerUpdatingGate?.takeIf { heldSeq != null && row.event.seq == heldSeq }
                        val drawRow: @Composable () -> Unit = {
                            if (head == null && held == null && !(overflow != null && row.event.seq == overflowSeq)) TranscriptRowView(row, model, live, openLink, row.contains(targetSeq ?: -1), target = targetSeq)
                            else Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                                TranscriptRowView(row, model, live, openLink, row.contains(targetSeq ?: -1), target = targetSeq)
                                // Under the reader's own message, so it stands at the bubble's right edge, as on iOS and web.
                                held?.let { RunnerUpdatingFoot(it, runnerUpdatingMachine, Modifier.align(Alignment.End), later = runnerUpdatingLater, runNow = runNow) }
                                overflow?.takeIf { row.event.seq == overflowSeq && row.steps.isEmpty() }?.let { RunningOverLimitFoot(it, Modifier.align(Alignment.End)) }
                                head?.let { TurnHeadLine(it, ticking = sessionLive && row.event.seq == newestHead) }
                            }
                        }
                        if (asked == null && crossings == null && scheduleThings == null && chatThings == null) drawRow()
                        else Column(verticalArrangement = Arrangement.spacedBy(16.dp)) {
                            drawRow()
                            chatThings?.forEach { key(it.key) { it.content() } }
                            scheduleThings?.forEach { drawSchedule(it) }
                            asked?.forEach { key(it.id) { Box(Modifier.conversationCard()) { OwnerRequestInConversation(it, ownerStore, ownerRunner, openLink, route.id, discussCard) } } }
                            crossings?.forEach { key(it.id) { Box(Modifier.conversationCard()) { CrossingCardView(it, crossingState) { crossingStore.open(it.id) } } } }
                        }
                    }
                    // Held by its runner's update with no message of the reader's to put the foot row under: the queued page's
                    // explanation, centred on an empty conversation (web `RunnerUpdatingQueued`).
                    val runnerUpdatingPage = runnerUpdatingGate?.takeIf { RunnerUpdating.isRunnerUpdating(it) && displayedWindow.seeded && live != null && heldSeq == null && !tailHeld && accepted.isEmpty() }
                    val cloneCard = cloneHeld != null && displayedWindow.seeded && live != null && heldSeq == null && !tailHeld && accepted.isEmpty()
                    if (cloneCard) item(key = "clone-wait") {
                        if (displayedRows.isEmpty()) Box(Modifier.fillParentMaxHeight(0.8f).fillMaxWidth(), contentAlignment = Alignment.Center) {
                            CloneWaitNotice(cloneWait, QueuedClone.isFailed(cloneHeld), runnerUpdatingMachine, compact = false)
                        } else CloneWaitNotice(cloneWait, QueuedClone.isFailed(cloneHeld), runnerUpdatingMachine, compact = true)
                    }
                    else if (runnerUpdatingPage != null) item(key = "runner-updating") {
                        val openTurn: (String) -> Unit = { open(OrbitRoute(Destination.SESSION, it)) }
                        if (displayedRows.isEmpty()) Box(Modifier.fillParentMaxHeight(0.8f).fillMaxWidth(), contentAlignment = Alignment.Center) {
                            RunnerUpdatingQueued(runnerUpdatingPage, runnerUpdatingMachine, openTurn, later = runnerUpdatingLater)
                        } else RunnerUpdatingQueued(runnerUpdatingPage, runnerUpdatingMachine, openTurn, later = runnerUpdatingLater)
                    }
                    else if (displayedWindow.seeded && displayedRows.isEmpty() && (live == null || accepted.isEmpty())) item(key = "empty") { Text("No messages yet") }
                    if (live != null) {
                        items(live.thinkingDrafts.entries.toList(), key = { "thinking:${it.key}" }) { entry ->
                            LiveMessage("Thinking", entry.key, entry.value, openLink)
                        }
                        items(live.textDrafts.entries.toList(), key = { "assistant:${it.key}" }) { entry ->
                            LiveMessage("Assistant", entry.key, entry.value, openLink)
                        }
                        // A07-14: the accepted head at the history's end, ahead of the decisions and the queue, as the transcript draws
                        // a person's turn — no dashes, no "Queued", no Cancel: the runner has it.
                        items(accepted, key = { "accepted:${it.turnId}" }) { head ->
                            val gate = runnerUpdatingGate?.takeIf { heldHead != null && head.turnId == heldHead.turnId }
                            val over = overflow?.takeIf { head.turnId == accepted.last().turnId }
                            if (gate == null && over == null) Box(Modifier.testTag("accepted:${head.turnId}")) { TranscriptRowView(TranscriptRow(head), model, live, openLink) }
                            else Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                                Box(Modifier.testTag("accepted:${head.turnId}")) { TranscriptRowView(TranscriptRow(head), model, live, openLink) }
                                // ` · Cancel` beside the tag: the turn withdrawn as the tray's is, its words back in the composer.
                                val withdraw = heldCancel?.takeIf { it.turnId == head.turnId }?.let { held ->
                                    { composer.withdraw(held.turnId, held.words, steer = false, engine = console.engine) }
                                }
                                gate?.let { RunnerUpdatingFoot(it, runnerUpdatingMachine, Modifier.align(Alignment.End), later = runnerUpdatingLater, cancel = withdraw, runNow = runNow) }
                                over?.let { RunningOverLimitFoot(it, Modifier.align(Alignment.End)) }
                            }
                        }
                        // The reader's own message the server has not drawn yet (docs/mocks/composer-sending-bubble): taken, as the
                        // ordinary bubble until the queue or its echo does; on its way, or not sent, as the outbox's bubble.
                        sentShown?.let { sent -> item(key = "sent:${sent.turnId}") { SentBubble(sent.words, sent.attachments, openLink) } }
                        pendingShown?.let { pending -> item(key = "pending-send:${pending.clientTurnId}") {
                            val ready = composerState.loaded && !composerState.sending && !composerState.busy
                            PendingSendBubble(pending.words, pending.attachments, composerState.sending, composerState.notSentReason,
                                retry = if (ready && !state.denied) composer::retrySend else null,
                                putBack = if (ready) composer::putBackUnsent else null, open = openLink)
                        } }
                    }
                    // At the live tail, under everything the conversation said and above the cards that ask the owner something.
                    if (live != null && displayedRows.isNotEmpty()) recapCard?.let { card ->
                        item(key = "recap") { RecapCardView(card, hideRecap) }
                    }
                    if (chatRest.isNotEmpty()) item(key = "chat-cards") {
                        Column(verticalArrangement = Arrangement.spacedBy(16.dp)) { chatRest.forEach { key(it.key) { it.content() } } }
                    }
                    item(key = "newer") { if (displayedWindow.newerAfter != null) TextButton(enabled = !displayedLoading, onClick = model::newer) { Text("Load newer messages") } }
                    item(key = "interaction-cards") {
                        Box(Modifier.onSizeChanged { cardsSize = it.height; if (rail.grew(it.height) && placed && follow && state.window.newerAfter == null) repin++ }) {
                            // Only opens without a record jump run the rail's initial scroll.
                            val viewport = if (ontoWaitingCard && !placedAtCards && route.recordId == null) 0 else listHeight
                            CompositionLocalProvider(LocalCardViewport provides viewport) { SessionCards(cards, openLink, discuss = discussCard) }
                        }
                    }
                    // A08-4: what is still waiting in the queue, as the turns it will be — after the decisions, before the tail.
                    if (live != null) items(queued, key = { it.key }) { turn ->
                        val held: (@Composable () -> Unit)? = runnerUpdatingGate?.takeIf { turn.heldByUpdate }?.let { gate ->
                            { RunnerUpdatingFoot(gate, runnerUpdatingMachine, later = runnerUpdatingLater, runNow = runNow) }
                        }
                        CompositionLocalProvider(LocalQueuedHeld provides held) {
                            QueuedTurnRow(turn, openLink, cancelEnabled = state.session?.fresh == true && !composerState.busy,
                                putBack = if (turn.delivery != null && composerState.loaded) ({
                                    composer.putBack(turn.event.fields.string("text").orEmpty(), discard = turn.turnId)
                                }) else null) { turnId ->
                                composer.control("turns/$turnId", HttpMethod.DELETE)
                            }
                        }
                    }
                    // A06-12: the room the fade lies over, so a list at its tail has nothing in it — and the 1 dp anchor it always was.
                    item(key = "tail") { Spacer(Modifier.height(COMPOSER_BAND_FADE + 1.dp).testTag("transcript-tail")) }
                }
                // iOS's floating disc (`scrollToBottomButton`): over the list's bottom centre, 6 dp above the fade, while the tail is
                // out of view. "Your question" is the capsule over the list, as on iOS, so there is no "Last question" here.
                if (!follow || state.window.newerAfter != null)
                    JumpToLatestDisc(Modifier.align(Alignment.BottomCenter).padding(bottom = COMPOSER_BAND_FADE + 6.dp)) { follow = true; model.latest() }
                }
                // Android's own, as iOS's console shows no connection: only while the stream is being made again (A06-18), under
                // the list so its coming and going never moves the line being read, and folded with the chrome while a phone types.
                val reconnecting = session?.fresh != true && state.window.seeded
                if (reconnecting && !foldsChrome) Row(Modifier.fillMaxWidth().heightIn(min = 48.dp).padding(horizontal = 16.dp).testTag("reconnecting"),
                    verticalAlignment = Alignment.CenterVertically) {
                    Text("Saved messages · Reconnecting…", Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis,
                        style = MaterialTheme.typography.bodySmall)
                    TextButton(onClick = model::retry) { Text("Retry") }
                }
                }
                // The reader's messages nothing has read yet: the conversation's next lines, so the band's first card, right under the
                // conversation and above the parking strip (docs/mocks/pending-tray-above-parking, decided 2026-10-28). Not folded while
                // a phone types, as it is about the messages being typed into; out of the way with the composer while a card's form
                // holds the keyboard.
                Box(Modifier.heightIn(max = composerHeight).then(if (composerHeight == 0.dp) Modifier.clipToBounds() else Modifier)) {
                    SessionPendingTray(composer, state.session, unreadSteers,
                        held = runnerUpdatingGate?.let { gate -> { RunnerUpdatingFoot(gate, runnerUpdatingMachine, later = runnerUpdatingLater, runNow = runNow) } })
                }
                // A08-5: a run that never started says why, first of the band's cards under the tray — and stays while a phone types.
                Box(Modifier.conversationCard()) { SessionRunStartCard(app, handle, state.session?.snapshot?.detail, state.session?.fresh == true, console,
                    chat = {
                        // The composer is handed a reply about this run, in place of whatever was in it (iOS `chatAboutRefusedRun`).
                        composer.edit(SessionRunStart.chatPrefix, SessionRunStart.chatPrefix.length, SessionRunStart.chatPrefix.length)
                        composerFocused = true; composeFocus++
                    },
                    sendAgain = { composer.retryFailed() },
                    openRunner = { runner -> open(OrbitRoute(Destination.RUNNER, runner)) },
                    // The region card's Move to another machine: the session's own Move…, as its menu opens it.
                    move = listed?.takeIf { it.workspace != null }?.let { session -> { action = DirectoryDialog.Move(session) } }) }
                // A07-4: a session queued behind the runner's Antigravity gate says what to fix, above the composer (iOS
                // `queuedAntigravityRepair`).
                val queuedDetail = console.detail
                val queued = (queuedDetail?.string("runStatus") ?: queuedDetail?.string("status")) == "PENDING"
                // A07-5: and behind its DeepSeek Harness gate, first (iOS `queuedDshRepair`).
                val queuedDsh = DshRuntime.repair(queuedDetail?.string("error"))?.takeIf { console.executesDsh && queued }
                if (queuedDsh != null) Box(Modifier.padding(horizontal = 16.dp, vertical = 4.dp).conversationCard()) { DshRepairCard(queuedDsh, console) }
                else AntigravityRepair.of(queuedDetail?.string("error"))?.takeIf {
                    console.executesAntigravity && queued
                }?.let { Box(Modifier.padding(horizontal = 16.dp, vertical = 4.dp).conversationCard()) { AntigravityRepairCard(it, console) } }
                // What this session waits on, the tasks it created and its code output: folded to no height while a
                // phone's composer holds the keyboard (iOS `TypingFold`), so an open list or a sheet comes back as it was.
                Box(Modifier.fillMaxWidth().typingFold(foldsChrome)) { SessionWatches(app, handle, route.id!!, open = open) }
                // The session's background processes, by the shared row rule (board v2; iOS `BackgroundTrayView`): between what it
                // waits on and the tasks it created. Its names stop rotating while the band is folded away.
                val backgroundClearedAt = remember(state.window.events) {
                    BackgroundRow.clearedAt(BackgroundTrayLogic.lastUserMessageAt(state.window.events), BackgroundTrayLogic.lastAgentTurnStartedAt(state.window.events))
                }
                Box(Modifier.fillMaxWidth().typingFold(foldsChrome)) {
                    // A running job's row takes Stop through the same routes as its card (R3).
                    CompositionLocalProvider(LocalJobCards provides jobCards) {
                        BackgroundTray(background.orEmpty(), backgroundClearedAt, BackgroundTrayLogic.sessionLive(detail), folded = foldsChrome,
                            jumpToJob = jobJump)
                    }
                }
                Box(Modifier.conversationCard().typingFold(foldsChrome)) { SessionTasksCard(app, handle, route.id!!, cards, openLink) }
                // The composer's send in flight holds Merge as a queued turn does (A06-14, iOS `console.sending`).
                Box(Modifier.fillMaxWidth().typingFold(foldsChrome)) { Column(Modifier.padding(horizontal = 16.dp)) {
                    // The main checkout's standing state, in Worktree and Shared sessions alike (board 01⑤, 02④).
                    if (workspaceOfSession != null) MainCheckoutBar(mainCheckout, workspaceOfSession, isolated = sessionDetail?.string("isolationStatus") == "worktree")
                    WorktreeBar(worktree, sending = composerState.waiting || composerState.busy, open = openLink) } }
                MainCheckoutSheets(mainCheckout, isolated = sessionDetail?.string("isolationStatus") == "worktree", sessionBranch = sessionDetail?.string("branch"),
                    sessionTitle = sessionDetail?.string("title"))
                // The landing this conversation's work fed, at the session's own bottom (owner 2026-10-19, board v4 06 e).
                Box(Modifier.fillMaxWidth().typingFold(foldsChrome)) { SourceLandingChip(queuedDetail ?: detail) {
                    open(OrbitRoute(Destination.SESSION, it)) } }
                // Board 02 ② and ⑤: the coordinator's handoff while it is written, and when it failed, right above the composer.
                val handoff = CoordinatorHandoff.outgoing(detail)
                // Its next state comes after the note turn has ended, when nothing else reads a session that is not live: read it
                // again while the handoff is in hand, so FAILED, the banner and the way to the successor arrive without a press.
                val latestDetail by rememberUpdatedState(detail)
                val following = CoordinatorHandoff.keepsReading(detail)
                LaunchedEffect(route.id, following) {
                    if (following) CoordinatorHandoff.follow({ latestDetail }) { app.realtime.refreshSession() }
                }
                val handoffProject = detail?.let(CoordinatorHandoff::projectId)
                val handoffApi = remember(handle) { CoordinatorHandoffApi(app.session, handle) }
                var handoffBusy by remember(handle, route.id) { mutableStateOf(false) }
                if (detail != null) HandoffStatus(handoff, composer, composerState, detail, busy = handoffBusy, act = { action, successor ->
                    if (handoffProject != null) scope.launch {
                        handoffBusy = true
                        try { handoffApi.post(handoffProject, action, successor) }
                        catch (cancel: CancellationException) { throw cancel }
                        catch (e: Exception) { OrbitToasts.show(CoordinatorHandoff.refusal(e), tone = ToastTone.ERROR) }
                        finally { handoffBusy = false; app.realtime.refreshSession() }
                    }
                })
                // Board 02 ④: a coordinator that handed over says so where its composer was, with the way to its successor.
                if (handoff?.state == "COMPLETED") HandedOverBanner(handoff.handedOverTo) { open(OrbitRoute(Destination.SESSION, it)) }
                // Keep the composer and its activity-result launchers alive while card forms use the IME.
                // The chip's Open task › pushes the task over this run, so Back returns to it.
                else {
                    // The session's runner is the account's managed runner, asleep: the shared composer line, and sending stays open — a
                    // message wakes it (coordinator comment 34xSUx9zU5vQtCEYNoqwu). Not while a handoff locks the composer: sending
                    // does not work then, and the line would say it does.
                    ManagedRunnerAsleepLine(data.workspaces.firstOrNull { ObjectId.same(it.id, workspaceOfSession) }?.runnerId,
                        composerLocked = handoff?.locksComposer == true)
                    Box(Modifier.heightIn(max = composerHeight).then(if (composerHeight == 0.dp) Modifier.clipToBounds() else Modifier)) { SessionComposer(app, handle, route.id!!, state.session,
                    focusRequest = composeFocus, inputFocusChanged = { composerFocused = it },
                    openTask = { open(OrbitRoute(Destination.TASK, it)) },
                    openRunner = { runner, engine -> open(OrbitRoute(Destination.RUNNER, runner, recordId = "engine:$engine")) },
                    openTranslationSettings = { open(OrbitRoute(Destination.SETTINGS, "sessions")) },
                    placeholder = chat?.placeholder, chips = chat?.chips) }
                }
            }
        }
        }
        if (!state.denied) CardReviewSheet(cards, reviewStates, openLink, discussCard)
        if (!state.denied) CrossingReviewSheet(crossingStore, coordinated, route.id)
        if (!state.denied) CardReceiptSheet(cards, openLanding = { open(OrbitRoute(Destination.SESSION, it)) })
        if (!state.denied) EvidenceFilesSheet(cards)
        if (settings && !state.denied) SessionSettingsPage(state.session, api, handle.account.server, data.tags,
            state.session?.fresh == true && data.fresh, openLink, { app.realtime.refreshDirectory(); app.realtime.refreshSession() }) { settings = false }
        action?.let { dialog -> DirectoryActionDialog(dialog, api, data.copy(fresh = data.fresh && state.session?.fresh == true), { action = it }) {
            app.realtime.refreshDirectory(); app.realtime.refreshSession()
            // Deleted for good from its own page: the page goes with it, as iOS's console does.
            if (dialog is DirectoryDialog.Purge) leave()
        } }
    }
}

@Composable
internal fun LiveMessage(label: String, parent: String, text: String, open: (String) -> Unit) {
    // A06-11: reasoning still being written is open and held to a few self-scrolling lines (iOS 471b2afbb).
    if (label == "Thinking") return LiveThinking(parent, text, open)
    // Settings › Translation (2A): the agent's own reply, streaming with translation on, is the English greyed with its chip until
    // its block completes and the translation arrives; a sub-agent's report is never translated.
    val translating = parent.isEmpty() && LocalTranslation.current.on
    Column { Text(if (parent.isEmpty()) "$label · Live" else "Subagent · $label · Live", style = MaterialTheme.typography.labelMedium)
        if (translating) {
            CompositionLocalProvider(LocalContentColor provides MaterialTheme.colorScheme.onSurfaceVariant) { StreamingText(text, open) }
            ReplyTranslationFoot(null, pending = true, flipped = false, onFlip = {}, retry = null)
        } else StreamingText(text, open)
    }
}

/** iOS `scrollToBottomButton`: a 40 dp opaque disc with a down arrow in a 48 dp target, lifted off the transcript by its shadow alone. */
@Composable
private fun JumpToLatestDisc(modifier: Modifier, onClick: () -> Unit) {
    Box(modifier.size(48.dp).clip(CircleShape).clickable(onClickLabel = null, role = Role.Button, onClick = onClick)
        .semantics { contentDescription = "Jump to latest" }.testTag("transcript-jump"), contentAlignment = Alignment.Center) {
        Surface(Modifier.size(40.dp), shape = CircleShape, // iOS `floatingDiscSurface`: white in light, a raised grey in dark (the transcript's own surface would hide it).
            color = MaterialTheme.colorScheme.run { if (surface.luminance() < 0.5f) surfaceVariant else Color.White }, shadowElevation = 3.dp) {
            Box(contentAlignment = Alignment.Center) {
                Icon(painterResource(R.drawable.ic_arrow_up), null, Modifier.size(18.dp).rotate(180f), tint = MaterialTheme.colorScheme.onSurface)
            }
        }
    }
}

/** How far the transcript fades out above the band under it, and the room its tail row keeps clear (iOS `composerBandFade`). */
internal val COMPOSER_BAND_FADE = 20.dp

/**
 * A06-12 (iOS 9d3751ec2 `fadesIntoComposerBand`): the transcript's bottom edge dissolves into the band under it — the cards
 * above the composer and the composer's own band — instead of slicing a row through, and its tail row keeps [COMPOSER_BAND_FADE]
 * of room, so only rows on their way out of view are in the fade. Drawn offscreen so the gradient (DstIn) masks the list's own
 * pixels, not the page under it. On the list alone: the jump row under it stays solid.
 */
internal fun Modifier.fadesIntoComposerBand(): Modifier = graphicsLayer { compositingStrategy = CompositingStrategy.Offscreen }
    .drawWithContent {
        drawContent()
        val fade = COMPOSER_BAND_FADE.toPx()
        drawRect(Brush.verticalGradient(listOf(Color.Black, Color.Transparent), startY = size.height - fade, endY = size.height),
            topLeft = Offset(0f, size.height - fade), size = Size(size.width, fade), blendMode = BlendMode.DstIn)
    }

/**
 * The landing this conversation's work fed, at the session's own bottom (owner 2026-10-19, board v4 06 e): a derived label, not a
 * turn — the source session did the work, the platform lands it, and the label opens the landing session where every attempt is read.
 * `Landing · checking ›`, `On project/x ✓ ›`, `Landing · checks failed ›`. Absent from a session that produced no landing work, and
 * from a server that predates the field.
 */
@Composable
internal fun SourceLandingChip(detail: JsonObject?, open: (String) -> Unit) {
    val source = detail?.obj("sourceLanding") ?: return
    val summary = SessionProjectLandings.LandingSummary(source.text("landingSessionId").orEmpty(), subject = source.text("subject"),
        state = source.text("state"), phase = source.text("phase"), settledAs = source.text("settledAs"), targetRef = source.text("targetRef"))
    if (summary.landingSessionId.isEmpty()) return
    val label = SessionProjectLandings.sourceLabel(summary) ?: return
    val ink = when (label.tone) {
        "run" -> MaterialTheme.colorScheme.primary
        "landed" -> LocalOrbitColors.current.success
        "failed" -> LocalOrbitColors.current.needsYou
        else -> MaterialTheme.colorScheme.onSurfaceVariant
    }
    Row(Modifier.fillMaxWidth().padding(start = 16.dp, end = 16.dp, bottom = 4.dp)) {
        Row(Modifier.background(ink.copy(alpha = 0.12f), RoundedCornerShape(50))
            .clickable(role = Role.Button) { open(summary.landingSessionId) }.padding(horizontal = 10.dp, vertical = 5.dp)
            .testTag("source-landing"), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
            // The moving state wears the ring (board 06 e; web's spinner Glyph, iOS's arrow.triangle.2.circlepath): static, and silent to TalkBack.
            if (label.tone == "run") Icon(painterResource(R.drawable.ic_sync), null, Modifier.size(14.dp).testTag("source-landing:ring"), tint = ink)
            Text("${label.text} ›", style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.SemiBold, color = ink, maxLines = 1)
        }
    }
}

/** Every picture a reader can page through: image attachments, and `[label](orbit-attachment:id "name.png")` links. */
internal fun sessionImages(events: List<RunEvent>): List<String> {
    val linked = Regex("""\[[^\]\n]+\]\((orbit-attachment:[^)\s]+)(?:\s+"((?:\\.|[^"\\])*)")?\)""")
    return events.flatMap { event ->
        val attached = (event.fields["attachments"] as? JsonArray).orEmpty().filterIsInstance<JsonObject>()
            .filter { (it.string("mime") ?: it.string("mimeType"))?.startsWith("image/") == true }
            .mapNotNull { it.string("id")?.let { id -> "orbit-attachment:$id" } }
        val body = event.body()
        attached + if ("orbit-attachment:" !in body) emptyList() else linked.findAll(body)
            .filter { MarkdownFileRef(it.groupValues[1], "", it.groupValues[2].ifEmpty { null }).isImage }.map { it.groupValues[1] }.toList()
    }.distinct()
}
