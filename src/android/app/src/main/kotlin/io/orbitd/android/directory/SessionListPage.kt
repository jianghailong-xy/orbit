package io.orbitd.android.directory

import android.content.Context
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutVertically
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.*
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.core.content.edit
import io.orbitd.android.R
import io.orbitd.android.management.LocalSessionRecaps
import io.orbitd.android.navigation.DrawerCopy
import io.orbitd.android.navigation.NeedsYouCount
import io.orbitd.android.navigation.ObjectId
import io.orbitd.android.tasks.TaskTime
import io.orbitd.android.ui.LocalOrbitColors
import io.orbitd.android.watch.WatchSessionSummary
import io.orbitd.android.watch.watchKey
import io.orbitd.android.wiki.WikiDate
import java.time.Instant
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.builtins.ListSerializer

/* A workspace's session list as iOS draws it on a phone (AgentsView `compactRow`, `sessionOptionsMenu`, the bottom search), and what
 * stands in for it before it has rows: the owner's pick of 2026-11-04, docs/mocks/android-cold-start-landing. */

/** The list's words, held to the Swift sources word for word by SessionListCopyParityTest. */
internal object SessionListCopy {
    const val FILTER_BY_TAG = "Filter by Tag"
    const val GROUP_BY_TAG = "Group by Tag"
    const val ALL_TAGS = "All"
    const val NEW_FOLDER = "New Folder…"
    const val SETTINGS = "Settings"
    const val SEARCH = "Search sessions"
    const val LOADING = "Loading…"
    const val UNTAGGED = "Untagged"
    const val COORDINATOR = "Coordinator"
    const val COORDINATOR_LABEL = "Project coordinator"
    const val PINNED_SHOWS = "Shows the pinned sessions"
    const val PINNED_HIDES = "Hides the pinned sessions"
    const val FOLDER_ACTIONS = "Folder actions"
    const val FOLDER_EMPTY = "Nothing in this folder"
    const val FOLDER_RUNNING = "Session running"
    const val FOLDER_JOBS = "Background job running"
    const val WORKSPACES_FAILED = "Workspaces couldn't be loaded"
    const val REQUEST_FAILED = "Request failed — check your connection."
    const val SESSION_EXPIRED = "Session expired — sign in again."
    const val RETRY = "Retry"
    const val UNREACHABLE = "Can't reach Orbit"
    const val UNREACHABLE_DETAIL = "Couldn't load workspaces"
    fun scope(view: SessionView) = "Session scope, ${view.label}"
    fun startSession(workspace: String) = "Start a new session with $workspace"
    fun startSessionIn(folder: String) = "Start a new session in $folder"
    fun noSessions(view: SessionView) = "No ${view.label.lowercase()} sessions"
    fun folderSessions(count: Int) = "$count sessions"
}

/** The time on a row's first line (OrbitKit `SessionListTime`): how long the turn has run while its spinner shows, nothing if the
 * server sent no start, and otherwise when it last moved. */
internal object SessionListTime {
    fun format(session: DirectorySession, now: Instant = Instant.now()): String? =
        if (session.isRunning()) session.currentTurnStartedAt?.let { TaskTime.elapsed(it, now) }
        else (session.lastTurnAt ?: session.createdAt)?.let { WikiDate.relative(it, now) }
}

/**
 * A session's row (iOS `AgentSessionRow.compactRow`): the title with its live mark and time, then one line in the tone of what it
 * says. A tap opens it and a long press is its menu. [machine] is the runner it runs on, by name: a session held for the Claude
 * region says Anthropic is unavailable there, where it is known. [deleted] is Trash, where nothing is live. A screen reader hears
 * the state the mark leaves out as the row's value (`SessionHeader.statusWord`).
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
internal fun SessionRow(session: DirectorySession, machine: String?, onOpen: () -> Unit,
    deleted: Boolean = false, watching: WatchSessionSummary? = null, onOptions: () -> Unit) {
    val muted = MaterialTheme.colorScheme.onSurfaceVariant
    val recaps = LocalSessionRecaps.current
    val line = remember(session, deleted, watching, recaps, machine) {
        SessionLine.make(session, live = !deleted, watching = watching, recaps = recaps, machine = machine)
    }
    val word = remember(session, watching) { SessionHeader.statusWord(session, watching) }
    Column(Modifier.fillMaxWidth()
        .combinedClickable(role = Role.Button, onLongClickLabel = "Options for ${session.name}", onLongClick = onOptions, onClick = onOpen)
        .semantics { stateDescription = word }
        .padding(horizontal = 16.dp, vertical = 11.dp), verticalArrangement = Arrangement.spacedBy(3.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(session.name, Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.bodyLarge)
            SessionLiveMark(session, watching)
            SessionListTime.format(session)?.let { Text(it, style = MaterialTheme.typography.labelMedium, color = muted, maxLines = 1, softWrap = false) }
        }
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(7.dp)) {
            if (session.projectMembership?.isCoordinator == true) Text(SessionListCopy.COORDINATOR,
                Modifier.background(muted.copy(alpha = 0.14f), CircleShape).padding(horizontal = 6.dp, vertical = 1.dp)
                    .clearAndSetSemantics { contentDescription = SessionListCopy.COORDINATOR_LABEL },
                style = MaterialTheme.typography.labelSmall, fontWeight = FontWeight.SemiBold, maxLines = 1, softWrap = false)
            Text(line.text, Modifier.testTag("session-state:${session.id}"), maxLines = 1, overflow = TextOverflow.Ellipsis,
                style = MaterialTheme.typography.bodyMedium, color = lineColor(line.tone))
        }
    }
}

/** iOS `SessionLiveIndicator`: what must never go silent on a row. A working session's spinner, the eye of one a watch will resume, the
 * clock of a report under review, the breathing terminal of a job in flight, an amber dot when it waits on you and a red one when it
 * failed. The calm states draw nothing: the line and the row's value say them. */
@Composable
internal fun SessionLiveMark(session: DirectorySession, watching: WatchSessionSummary?) {
    val muted = MaterialTheme.colorScheme.onSurfaceVariant
    val parked = session.effectiveRunState == RunState.AWAITING_INPUT
    when {
        session.pendingApprovals > 0 -> Box(Modifier.size(7.dp).background(LocalOrbitColors.current.needsYou, CircleShape).testTag("session-mark-needs-you"))
        session.confirmationUnderReview != null -> Icon(painterResource(R.drawable.ic_clock), null, Modifier.size(14.dp).testTag("session-mark-review"), tint = muted)
        session.isRunning() -> RowSpinner(Modifier.testTag("session-mark-running"))
        parked && watching != null -> Icon(painterResource(R.drawable.ic_eye), null, Modifier.size(14.dp).testTag("session-mark-watching"), tint = muted)
        session.isRunningJob(watching) -> BreathingTerminal(Modifier.testTag("session-mark-jobs"))
        session.effectiveRunState == RunState.FAILED && !session.retryPending(Instant.now()) && !session.error.orEmpty().lowercase().contains("offline") ->
            Box(Modifier.size(7.dp).background(MaterialTheme.colorScheme.error, CircleShape).testTag("session-mark-failed"))
    }
}

/** The spinner in a row's trailing slot, in the quiet tone: its row's value says what it means, and it says nothing itself. */
@Composable
internal fun RowSpinner(modifier: Modifier = Modifier) {
    CircularProgressIndicator(modifier.size(14.dp).clearAndSetSemantics {}, color = MaterialTheme.colorScheme.onSurfaceVariant, strokeWidth = 1.5.dp)
}

/** A folder's row (iOS `SessionFolderRowView`): its name, what the sessions it holds would have said — how many wait on you, else a
 * spinner, else the breathing mark, by the drawer's rule — their count and a chevron. A tap opens it and a long press is its menu. */
@OptIn(ExperimentalFoundationApi::class)
@Composable
internal fun FolderRow(folder: Folder, sessions: List<DirectorySession>, runnerOffline: Boolean, watching: Map<String, WatchSessionSummary>,
    onOpen: () -> Unit, onOptions: () -> Unit) {
    val muted = MaterialTheme.colorScheme.onSurfaceVariant
    val waiting = sessions.count { it.pendingApprovals > 0 && it.waitingKind != "START_REQUEST" }
    val running = !runnerOffline && sessions.any { it.isRunning() }
    val jobs = !runnerOffline && sessions.any { it.isRunningJob(watching[watchKey(it.id)]) }
    val words = when {
        waiting > 0 -> DrawerCopy.waitingForYou(waiting)
        running -> SessionListCopy.FOLDER_RUNNING
        jobs -> SessionListCopy.FOLDER_JOBS
        else -> SessionListCopy.folderSessions(sessions.size)
    }
    Row(Modifier.fillMaxWidth()
        .combinedClickable(role = Role.Button, onLongClickLabel = "Options for ${folder.name}", onLongClick = onOptions, onClick = onOpen)
        .semantics { stateDescription = words }.testTag("folder-row:${folder.id}")
        .padding(horizontal = 16.dp, vertical = 13.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        Icon(painterResource(R.drawable.ic_folder), null, Modifier.size(22.dp), tint = MaterialTheme.colorScheme.primary)
        Text(folder.name, Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.bodyLarge)
        when {
            waiting > 0 -> NeedsYouCount(waiting)
            running -> RowSpinner()
            jobs -> BreathingTerminal()
        }
        Text("${sessions.size}", style = MaterialTheme.typography.labelMedium, color = muted, modifier = Modifier.clearAndSetSemantics {})
        Icon(painterResource(R.drawable.ic_chevron_forward), null, Modifier.size(14.dp), tint = muted.copy(alpha = 0.6f))
    }
}

/** A section title of the list (iOS's plain list header), over the list's own surface: a pinned one hides the row sliding under it
 * rather than reading through it (`sectionHeaderBand`). */
@Composable
internal fun ListHeading(title: String) {
    Box(Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.surface)) { HeadingText(title, Modifier.padding(HEADING_PADDING)) }
}

@Composable
private fun HeadingText(title: String, modifier: Modifier = Modifier) {
    Text(title, modifier.semantics { heading() }, style = MaterialTheme.typography.titleSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
}

private val HEADING_PADDING = PaddingValues(start = 16.dp, end = 16.dp, top = 18.dp, bottom = 6.dp)

/** The Pinned section's title, the whole band being the button: a chevron down while its rows show and right once folded away. */
@Composable
internal fun PinnedHeading(title: String, collapsed: Boolean, toggle: () -> Unit) {
    val turn by animateFloatAsState(if (collapsed) 0f else 90f, label = "pinned")
    Row(Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.surface)
        .clickable(role = Role.Button, onClickLabel = if (collapsed) SessionListCopy.PINNED_SHOWS else SessionListCopy.PINNED_HIDES, onClick = toggle)
        .testTag("pinned-heading").padding(HEADING_PADDING), verticalAlignment = Alignment.CenterVertically) {
        HeadingText(title, Modifier.weight(1f))
        Icon(painterResource(R.drawable.ic_chevron_forward), null, Modifier.size(14.dp).rotate(turn), tint = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

/** A tag's section title (iOS `tagSectionHeader`): its colour and its name; "Untagged" when it has none. */
@Composable
internal fun TagHeading(tag: Tag?) {
    if (tag == null) return ListHeading(SessionListCopy.UNTAGGED)
    Row(Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.surface).padding(HEADING_PADDING),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        Box(Modifier.size(8.dp).background(tagColor(tag.color), CircleShape))
        HeadingText(tag.name)
    }
}

/** A tag's stored colour (OrbitKit `TagChipColor`): six hex digits, or grey. */
internal fun tagColor(hex: String?): Color =
    hex?.removePrefix("#")?.takeIf { it.length == 6 }?.toLongOrNull(16)?.let { Color(0xFF000000 or it) } ?: Color.Gray

/** Whether the Pinned section is folded to its heading: this phone's, across workspaces and launches (iOS `sessionList.pinnedCollapsed`). */
@Composable
internal fun rememberPinnedCollapsed(): MutableState<Boolean> {
    val context = LocalContext.current
    val preferences = remember { context.getSharedPreferences("orbit.sessionList", Context.MODE_PRIVATE) }
    val state = remember { mutableStateOf(preferences.getBoolean("pinnedCollapsed", false)) }
    LaunchedEffect(state.value) { preferences.edit { putBoolean("pinnedCollapsed", state.value) } }
    return state
}

/** The field at the foot of the list, in a thumb's reach (iOS's bottom toolbar). It searches the server, so its hits take the list's place. */
@Composable
internal fun BottomSearchField(query: String, onQuery: (String) -> Unit, modifier: Modifier = Modifier) {
    val muted = MaterialTheme.colorScheme.onSurfaceVariant
    Surface(modifier.fillMaxWidth().padding(start = 20.dp, end = 20.dp, top = 26.dp, bottom = 10.dp).height(50.dp), shape = CircleShape,
        color = MaterialTheme.colorScheme.surfaceContainerHigh, border = BorderStroke(0.5.dp, muted.copy(alpha = 0.25f)), shadowElevation = 6.dp) {
        Row(Modifier.fillMaxSize().padding(horizontal = 16.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            Icon(painterResource(R.drawable.ic_search), null, Modifier.size(20.dp), tint = MaterialTheme.colorScheme.onSurface)
            Box(Modifier.weight(1f), contentAlignment = Alignment.CenterStart) {
                if (query.isEmpty()) Text(SessionListCopy.SEARCH, style = MaterialTheme.typography.bodyLarge, color = muted, maxLines = 1, modifier = Modifier.clearAndSetSemantics {})
                BasicTextField(query, onQuery, Modifier.fillMaxWidth().testTag("session-search").semantics { contentDescription = SessionListCopy.SEARCH },
                    singleLine = true, textStyle = MaterialTheme.typography.bodyLarge.copy(color = MaterialTheme.colorScheme.onSurface),
                    cursorBrush = SolidColor(MaterialTheme.colorScheme.primary))
            }
            if (query.isNotEmpty()) IconButton({ onQuery("") }, Modifier.size(28.dp)) { Icon(painterResource(R.drawable.ic_clear), "Clear") }
        }
    }
}

/** iOS `BottomSearchReveal`: out of the way while the list is read downward, back on the way up, at the top and at the end. Its own
 * composable, so that a scroll recomposes the field and not the list. */
@Composable
internal fun BottomSearch(list: LazyListState, query: String, onQuery: (String) -> Unit) {
    val reveal by remember(list) { derivedStateOf { !list.canScrollBackward || !list.canScrollForward || list.lastScrolledBackward } }
    AnimatedVisibility(reveal || query.isNotEmpty(), enter = slideInVertically { it } + fadeIn(), exit = slideOutVertically { it } + fadeOut()) {
        val surface = MaterialTheme.colorScheme.surface
        Box(Modifier.fillMaxWidth().background(Brush.verticalGradient(0f to surface.copy(alpha = 0f), 0.45f to surface.copy(alpha = 0.92f), 1f to surface))) {
            BottomSearchField(query, onQuery)
        }
    }
}

/** iOS `sessionOptionsMenu`, the bar's ≡ on a phone: the scope, the tag filter and grouping when the account has tags, a new folder (not
 * in Trash, where no folder row is drawn) and the workspace's settings. The filled glyph keeps an active tag filter in sight. */
@Composable
internal fun SessionOptionsMenu(view: SessionView, tags: List<Tag>, tag: String?, byTag: Boolean,
    onView: (SessionView) -> Unit, onTag: (String?) -> Unit, onByTag: (Boolean) -> Unit, onNewFolder: () -> Unit, onSettings: () -> Unit) {
    var open by remember { mutableStateOf(false) }
    var choosingTag by remember { mutableStateOf(false) }
    Box {
        IconButton(onClick = { open = true; choosingTag = false }) {
            Icon(painterResource(if (tag == null) R.drawable.ic_filter else R.drawable.ic_filter_on), SessionListCopy.scope(view))
        }
        DropdownMenu(open, onDismissRequest = { open = false }) {
            @Composable fun Choice(label: String, on: Boolean, press: () -> Unit) = DropdownMenuItem(text = { Text(label) }, modifier = Modifier.semantics { selected = on },
                leadingIcon = { if (on) Icon(painterResource(R.drawable.ic_check), null, Modifier.size(20.dp)) else Spacer(Modifier.size(20.dp)) },
                onClick = { press(); open = false })
            if (choosingTag) {
                Choice(SessionListCopy.ALL_TAGS, tag == null) { onTag(null) }
                // Choosing the active tag again clears it, as All does.
                tags.forEach { t -> Choice(t.name, ObjectId.same(tag, t.id)) { onTag(t.id.takeUnless { ObjectId.same(tag, it) }) } }
            } else {
                SessionView.entries.forEach { option -> Choice(option.label, view == option) { onView(option) } }
                HorizontalDivider()
                if (tags.isNotEmpty()) {
                    val active = tags.firstOrNull { ObjectId.same(tag, it.id) }
                    DropdownMenuItem(text = { Column {
                        Text(SessionListCopy.FILTER_BY_TAG)
                        active?.let { Text(it.name, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
                    } }, leadingIcon = { Icon(painterResource(R.drawable.ic_tag), null, Modifier.size(20.dp)) },
                        trailingIcon = { Icon(painterResource(R.drawable.ic_chevron_forward), null, Modifier.size(14.dp)) }, onClick = { choosingTag = true })
                    Choice(SessionListCopy.GROUP_BY_TAG, byTag) { onByTag(!byTag) }
                    HorizontalDivider()
                }
                if (view != SessionView.TRASH) DropdownMenuItem(text = { Text(SessionListCopy.NEW_FOLDER) },
                    leadingIcon = { Icon(painterResource(R.drawable.ic_folder_plus), null, Modifier.size(20.dp)) }, onClick = { onNewFolder(); open = false })
                DropdownMenuItem(text = { Text(SessionListCopy.SETTINGS) }, leadingIcon = { Icon(painterResource(R.drawable.ic_settings), null, Modifier.size(20.dp)) },
                    onClick = { onSettings(); open = false })
            }
        }
    }
}

/**
 * The Completed or Trash list a page is showing. Not the directory's: Open is the app's list, and an owner's Completed is 18 MB. It is
 * the account's list, as iOS reads it (`AgentsModel.loadSessions`), because a project's row is worded by a coordinator that may be
 * filed in another workspace. iOS reads it again every 4 s; here it is read when the scope is chosen, on a pull and behind a change
 * this phone asked for ([show]'s `asks`), and held meanwhile, so a session opened over the list comes back to its rows.
 */
@Stable
internal class SessionScopeList(private val api: DirectoryApi) {
    private class Read(val view: SessionView, val asks: Long, val rows: List<DirectorySession>)
    private var held by mutableStateOf<Read?>(null)
    private var failed by mutableStateOf<Pair<SessionView, String>?>(null)

    fun rows(view: SessionView): List<DirectorySession>? = held?.takeIf { it.view == view }?.rows
    fun error(view: SessionView): String? = failed?.takeIf { it.first == view }?.second
    /** Whether a row of the list being held has this id, as the row spells it. */
    fun holds(id: String): Boolean = held?.rows?.any { it.id == id } == true
    fun clear() { held = null; failed = null }

    /** Reads the list unless [view]'s is held from a read that saw [asks]. */
    suspend fun show(view: SessionView, asks: Long) {
        val current = held
        if (current == null || current.view != view || current.asks != asks) read(view, asks)
    }

    suspend fun read(view: SessionView, asks: Long) {
        failed = null
        try {
            val rows = withContext(Dispatchers.Default) {
                api.read(listOf("sessions"), ListSerializer(DirectorySession.serializer()), listOf("view" to view.query))
            }
            held = Read(view, asks, rows)
        } catch (cancel: CancellationException) { throw cancel }
        catch (failure: Exception) { failed = view to directoryError(failure) }
    }
}

/** iOS `unreachableRow`: heads the drawer's workspaces while the list can't be read, so an empty rail reads as that and not as
 * having none; rows kept from an earlier read stay below it. The list itself says nothing. */
@Composable
internal fun DrawerUnreachableRow(data: DirectoryData, retry: () -> Unit) {
    if (data.error == null && !data.offline) return
    Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp).testTag("drawer-unreachable"), verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        Icon(painterResource(R.drawable.ic_wifi_exclamation), null, Modifier.size(24.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
        Column(Modifier.weight(1f)) {
            Text(SessionListCopy.UNREACHABLE, style = MaterialTheme.typography.bodyLarge)
            Text(SessionListCopy.UNREACHABLE_DETAIL, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        if (data.refreshing) RowSpinner() else TextButton(onClick = retry) { Text(SessionListCopy.RETRY) }
    }
}
