package io.orbitd.android.drive

import android.content.Context
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.edit
import io.orbitd.android.OrbitApplication
import io.orbitd.android.R
import io.orbitd.android.chat.*
import io.orbitd.android.composer.ChatDoor
import io.orbitd.android.composer.ComposerApi
import io.orbitd.android.composer.DraftTarget
import io.orbitd.android.composer.SessionComposer
import io.orbitd.android.core.auth.SessionHandle
import io.orbitd.android.core.drive.*
import io.orbitd.android.core.realtime.SessionSnapshot
import io.orbitd.android.core.realtime.SessionState
import io.orbitd.android.directory.DirectoryApi
import io.orbitd.android.directory.DirectoryData
import io.orbitd.android.directory.directoryError
import io.orbitd.android.navigation.Destination
import io.orbitd.android.navigation.ObjectId
import io.orbitd.android.navigation.OrbitRoute
import io.orbitd.android.navigation.Origin
import io.orbitd.android.reader.SessionReader
import io.orbitd.android.ui.LocalOrbitColors
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonObject

/** The Drive chat's words for the page chat (web DriveChatHost's `origin.copy`). */
val DRIVE_CHAT_ORIGIN = ChatOrigin(newChat = DriveChatCopy.NEW_CHAT, history = DriveChatCopy.HISTORY, noHistory = DriveChatCopy.NO_HISTORY,
    emptyHint = DriveChatCopy.EMPTY_HINT, emptyNote = DriveChatCopy.EMPTY_NOTE, placeholder = DriveChatCopy.PLACEHOLDER,
    examples = DriveChatCopy.EXAMPLES, runsIn = DriveChatCopy.RUNS_IN, openSession = DriveChatCopy.OPEN_SESSION, close = DriveChatCopy.CLOSE)

/** Where the owner is in Drive, as the composer's chips name it: the folder open (null id: the top level) and the file open, if one is. */
data class DriveChatHere(val folderId: String?, val folderName: String, val fileId: String? = null, val fileName: String? = null)

/**
 * The Drive chat of one signed-in account, kept for the process with its [DriveStore] (board drive-chat 02, frames 9–12): the chats read
 * (`GET /api/drive/chats`), each open chat's change groups and overwrite questions, whether the sheet is up and on which chat, the
 * marks the list carries until a marked row is opened (kept on the device per account), and the round button's green check.
 */
class DriveChats internal constructor(private val app: OrbitApplication, private val handle: SessionHandle, private val scope: CoroutineScope,
    private val changedDrive: () -> Unit) {
    val api = DriveChatApi(app.session, handle)
    var list by mutableStateOf<DriveChatList?>(null)
        private set
    val groups = mutableStateMapOf<String, List<DriveChatChangeGroup>>()
    val questions = mutableStateMapOf<String, List<DriveChatQuestion>>()
    /** The sheet is up; [expanded] at its full height. Not opened on its own: only the round button opens it. */
    var shown by mutableStateOf(false)
    var expanded by mutableStateOf(false)
    /** The chat the sheet shows; null for a new chat. */
    var current by mutableStateOf<String?>(null)
    /** A Drive chat's work finished while the sheet was closed: the button's check, until it is pressed. */
    var updated by mutableStateOf(false)
        private set
    /** Where a new chat runs, when the owner picked other than the server's default. */
    var pickedWorkspace by mutableStateOf<String?>(null)
    var here by mutableStateOf<DriveChatHere?>(null)
    /** The chips crossed out, by what they named: what is not shown is not sent. Opening another folder or file shows its chip again. */
    var crossedFolder by mutableStateOf<String?>(null)
    var crossedFile by mutableStateOf<String?>(null)
    /** Presses whose answer is still out, by group or question id; and the last refusal a card shows. */
    val pressing = mutableStateMapOf<String, Boolean>()
    val failures = mutableStateMapOf<String, String>()
    private var seenRevision by mutableIntStateOf(0)
    private val preferences = app.getSharedPreferences("orbit.driveChat", Context.MODE_PRIVATE)
    private val seenKey = "seen.${handle.account.server}.${handle.account.userId}"

    val working get() = list?.fab?.working == true
    val needsYou get() = (list?.fab?.needsYou ?: 0) + DriveChatLogic.needYou(groups.values.flatten(), questions.values.flatten())
    val fab get() = DriveChatLogic.fab(needsYou, working, updated)

    /** The chats read again, and the changes and questions of the open ones (the first 20) and of the one on the sheet. */
    suspend fun refresh() {
        val read = try { api.list() } catch (cancel: CancellationException) { throw cancel } catch (_: Exception) { return }
        val wasWorking = working
        list = read
        if (wasWorking && !read.fab.working && !shown) updated = true
        val ids = (read.chats.filter { it.open }.take(20).map { it.sessionId } + listOfNotNull(current)).distinct()
        for (id in ids) {
            runCatching { api.groups(id) }.getOrNull()?.let { if (groups[id] != it) groups[id] = it }
            runCatching { api.questions(id) }.getOrNull()?.let { if (questions[id] != it) questions[id] = it }
        }
    }

    /** The round button: the sheet up on the chat that needs the owner, else the newest open one, else a new chat. */
    fun open() {
        updated = false
        current = DriveChatLogic.toOpen(list?.chats.orEmpty())
        shown = true
    }

    fun close() { shown = false; expanded = false }

    fun newChat() { current = null }

    /** The folder and selection the chips show, as a message carries them; null when the folder chip is crossed out. */
    fun context(): DriveChatContext? {
        val at = here ?: return null
        val folderShown = crossedFolder != (at.folderId ?: ROOT)
        val file = at.fileId?.takeIf { crossedFile != it }
        if (!folderShown && file == null) return null
        return DriveChatContext(if (folderShown) at.folderId else null, listOfNotNull(file))
    }

    /** The mark a row carries, until it is opened. */
    fun markOf(entryId: String): DriveMark? {
        seenRevision
        val marks = DriveChatLogic.marks(groups.values.flatten())
        val (mark, key) = marks[entryId] ?: marks.entries.firstOrNull { ObjectId.same(it.key, entryId) }?.value ?: return null
        return mark.takeUnless { key in seen() }
    }

    fun opened(entryId: String) {
        val marks = DriveChatLogic.marks(groups.values.flatten())
        val key = (marks[entryId] ?: marks.entries.firstOrNull { ObjectId.same(it.key, entryId) }?.value)?.second ?: return
        if (key in seen()) return
        preferences.edit { putStringSet(seenKey, (seen() + key).toList().takeLast(500).toSet()) }
        seenRevision++
    }

    private fun seen(): Set<String> = preferences.getStringSet(seenKey, emptySet()).orEmpty()

    /** Undo, Apply, Keep both and Replace: pressed once while out; the chat's changes and the folder read again after. */
    fun press(id: String, act: suspend () -> Unit) {
        if (pressing[id] == true) return
        pressing[id] = true; failures.remove(id)
        scope.launch {
            try { act(); changedDrive() }
            catch (cancel: CancellationException) { throw cancel }
            catch (e: Exception) { failures[id] = directoryError(e) }
            finally { pressing.remove(id); refresh() }
        }
    }

    companion object {
        /** The top level's key among the crossed-out chips. */
        const val ROOT = "root"
    }
}

/**
 * Drive's page chat (board drive-chat 02 frames 9–12, owner Q1 A): the round button over the page's Upload, and the non-modal sheet it
 * opens. [fabBottom] is how far the button stands from the page's foot. Trash and Storage host none.
 */
@Composable
internal fun DriveChatLayer(store: DriveStore, api: DirectoryApi, data: DirectoryData, open: (OrbitRoute) -> Unit, fabBottom: androidx.compose.ui.unit.Dp) {
    val chats = store.chat
    // The chats read while a Drive page is up: every few seconds while one works, else twice a minute. Off the frame clock.
    LaunchedEffect(chats) {
        while (true) {
            chats.refresh()
            withContext(Dispatchers.Default) { delay(if (chats.working || chats.shown) 5_000L else 30_000L) }
        }
    }
    Box(Modifier.fillMaxSize()) {
        if (!chats.shown) {
            val (state, label) = chats.fab
            ChatFab(state, label, chats.needsYou, onClick = chats::open,
                modifier = Modifier.align(Alignment.BottomEnd).padding(end = ChatMetrics.fabEdge, bottom = fabBottom))
        } else ChatSheet(chats.expanded, { chats.expanded = it }, chats::close) {
            DriveChatSheetBody(store, api, data, open)
        }
    }
}

@Composable
private fun ColumnScope.DriveChatSheetBody(store: DriveStore, api: DirectoryApi, data: DirectoryData, open: (OrbitRoute) -> Unit) {
    val chats = store.chat
    val app = store.app
    val handle = store.handle
    val rows = chats.list?.chats.orEmpty()
    val current = chats.current
    val row = current?.let { id -> rows.firstOrNull { ObjectId.same(it.sessionId, id) } }
    ChatSheetHeader(DRIVE_CHAT_ORIGIN, title = if (current == null) DriveChatCopy.NEW_CHAT else row?.title?.ifBlank { null } ?: DriveChatCopy.NEW_CHAT,
        history = rows.map { ChatHistoryRow(it.sessionId, it.title.ifBlank { DriveChatCopy.NEW_CHAT }, chatDetail(it)) }, current = current,
        newChat = chats::newChat, pick = { chats.current = it },
        openSession = current?.let { id -> { chats.close(); open(OrbitRoute(Destination.SESSION, id, origin = Origin.LINK)) } }, close = chats::close)
    val chips: @Composable () -> Unit = { DriveChatChips(chats) }
    val door = remember(chats) {
        ChatDoor(listOf("drive", "chats"), createBody = { text, turnId, config, attachments ->
            DriveChatLogic.createBody(text, turnId, chats.pickedWorkspace ?: chats.list?.workspace?.id, chats.context(), config, attachments)
        }, turnExtra = { DriveChatLogic.turnContext(chats.context()) })
    }
    Box(Modifier.weight(1f).fillMaxWidth()) {
        if (current == null) DriveNewChat(store, data, door, chips)
        else {
            val composer = remember(app, handle, current) { app.composer(handle, current) }
            DisposableEffect(composer) { composer.door = door; onDispose { if (composer.door === door) composer.door = null } }
            val cards = driveChatCards(chats, current)
            key(current) {
                SessionReader(app, handle, OrbitRoute(Destination.SESSION, current, origin = Origin.LINK), api, data, open = { next ->
                    // A link to a Drive file or folder leaves the sheet up at half height over it (board ③ note: the chat stays open).
                    if (next.isDrive) chats.expanded = false
                    open(next)
                }, chat = ReaderChat(DriveChatCopy.PLACEHOLDER, chips, cards))
            }
        }
    }
}

private fun chatDetail(row: DriveChatRow): String? = when {
    row.needsYou > 0 -> DriveChatCopy.fabNeedsYou(row.needsYou)
    row.working -> DriveChatCopy.FAB_WORKING
    row.completed -> "Completed"
    !row.open -> "Ended"
    else -> null
}

/** The composer's chips (board frame 10 ①): the folder open — `Folder · Drive` at the top level — then the file open, each with ✕. */
@Composable
private fun DriveChatChips(chats: DriveChats) {
    val at = chats.here ?: return
    val folderKey = at.folderId ?: DriveChats.ROOT
    val folderShown = chats.crossedFolder != folderKey
    val file = at.fileId?.takeIf { chats.crossedFile != it }
    if (!folderShown && file == null) return
    LazyRow(Modifier.fillMaxWidth().padding(start = 12.dp, end = 12.dp, top = 12.dp).testTag("drive-chat-chips"),
        horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        if (folderShown) item("folder") {
            val label = DriveChatCopy.folder(at.folderName)
            ChatChip(label, R.drawable.ic_folder, DriveChatCopy.remove(label), { chats.crossedFolder = folderKey }, Modifier.testTag("drive-chat-folder-chip"))
        }
        if (file != null) item("file") {
            val name = at.fileName.orEmpty()
            ChatChip(name, R.drawable.ic_doc, DriveChatCopy.remove(name), { chats.crossedFile = file }, Modifier.testTag("drive-chat-file-chip"))
        }
    }
}

/**
 * A new chat (board frame 10): Runs in — the server's default workspace unless another is picked, said only here — the empty state with
 * its examples, and the composer, whose first message opens the chat through `POST /api/drive/chats`.
 */
@Composable
private fun DriveNewChat(store: DriveStore, data: DirectoryData, door: ChatDoor, chips: @Composable () -> Unit) {
    val chats = store.chat
    val app = store.app
    val handle = store.handle
    val default = chats.list?.workspace
    val workspaceId = chats.pickedWorkspace ?: default?.id
    if (workspaceId == null) {
        Column(Modifier.fillMaxSize().padding(24.dp), verticalArrangement = Arrangement.Center, horizontalAlignment = Alignment.CenterHorizontally) {
            Text(if (chats.list == null) "Loading…" else DriveChatCopy.NO_WORKSPACE, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        return
    }
    val target = remember(workspaceId) { DraftTarget(workspaceId, chat = "drive") }
    val model = remember(handle, target) { app.composer(handle, target.key, target) }
    DisposableEffect(model) { model.door = door; onDispose { if (model.door === door) model.door = null } }
    val state by model.state.collectAsState()
    var detail by remember(target) { mutableStateOf<JsonObject?>(null) }
    LaunchedEffect(handle, target) {
        try { detail = ComposerApi(app.session, handle, target.key, target).detail() }
        catch (cancel: CancellationException) { throw cancel } catch (_: Exception) { }
    }
    // The first message made the chat: the sheet goes on in it, as the web's panel does.
    LaunchedEffect(state.draft.createdSessionId, state.acknowledgementPending) {
        state.draft.createdSessionId?.takeUnless { state.acknowledgementPending }?.let { id ->
            chats.current = id
            model.consumeCreated()
            chats.refresh()
        }
    }
    val workspace = data.workspaces.firstOrNull { ObjectId.same(it.id, workspaceId) }
    val name = workspace?.name ?: default?.takeIf { ObjectId.same(it.id, workspaceId) }?.name ?: "Workspace"
    val runner = workspace?.runnerId?.let { id -> data.runners.firstOrNull { ObjectId.same(it.id, id) } }
    val offline = runner?.online == false || (runner == null && default?.takeIf { ObjectId.same(it.id, workspaceId) }?.online == false)
    Column(Modifier.fillMaxSize()) {
        Column(Modifier.weight(1f).fillMaxWidth().verticalScroll(rememberScrollState())) {
            ChatEmptyState(DRIVE_CHAT_ORIGIN, runsIn = {
                RunsIn(name, data, workspaceId) { chats.pickedWorkspace = it }
                if (offline) Text(DriveChatCopy.offline(runner?.displayName ?: runner?.name ?: name), color = LocalOrbitColors.current.needsYou,
                    fontSize = 13.sp, modifier = Modifier.testTag("drive-chat-offline"))
            }, showExamples = state.draft.text.isEmpty(), useExample = { model.edit(it, it.length, it.length) })
        }
        val fresh = detail?.let { it["enabled"]?.toString() != "false" } == true
        val session = detail?.let { SessionState(target.key, snapshot = SessionSnapshot(it, emptyList(), emptyList(), emptyList(), emptyMap()), fresh = fresh) }
        Box(Modifier.heightIn(max = 320.dp)) {
            SessionComposer(app, handle, target.key, session, target, placeholder = DriveChatCopy.PLACEHOLDER, chips = chips)
        }
    }
}

/** `Runs in  Orbit Cloud ▾` (board frame 10): the workspace a new chat runs in, the owner's others in its menu. */
@Composable
private fun RunsIn(name: String, data: DirectoryData, selected: String, pick: (String) -> Unit) {
    var menu by remember { mutableStateOf(false) }
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(DriveChatCopy.RUNS_IN, color = MaterialTheme.colorScheme.onSurfaceVariant, fontSize = 15.sp)
        Box {
            TextButton(onClick = { menu = true }, Modifier.testTag("drive-chat-runs-in"), contentPadding = PaddingValues(horizontal = 4.dp),
                enabled = data.workspaces.isNotEmpty()) {
                Text(name, color = MaterialTheme.colorScheme.onSurface, fontSize = 15.sp)
                Icon(painterResource(R.drawable.ic_chevron_down), null, Modifier.padding(start = 4.dp).size(14.dp),
                    tint = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            DropdownMenu(menu, { menu = false }) {
                data.workspaces.forEach { workspace ->
                    DropdownMenuItem(text = { Text(workspace.name, fontWeight = if (ObjectId.same(workspace.id, selected)) FontWeight.SemiBold else null) },
                        onClick = { menu = false; pick(workspace.id) })
                }
            }
        }
    }
}

/** The chat's cards for the conversation: each change group and overwrite question, oldest first, placed with its turn. */
@Composable
private fun driveChatCards(chats: DriveChats, sessionId: String): List<ReaderChatCard> {
    val groups = chats.groups.entries.firstOrNull { ObjectId.same(it.key, sessionId) }?.value.orEmpty()
    val questions = chats.questions.entries.firstOrNull { ObjectId.same(it.key, sessionId) }?.value.orEmpty()
    return remember(groups, questions) {
        (groups.map { g -> Triple(g.createdAt, g.turnId, ReaderChatCard("drive-group-${g.id}", g.turnId) { DriveChangesCard(chats, g) }) } +
            questions.map { q -> Triple(q.createdAt, q.turnId, ReaderChatCard("drive-question-${q.id}", q.turnId) { DriveReplaceCard(chats, q) }) })
            .sortedBy { it.first }.map { it.third }
    }
}

/** One turn's changes (board frame 11): the result first, four lines, Show all in the card, Undo for the whole card; Apply when held. */
@Composable
internal fun DriveChangesCard(chats: DriveChats, group: DriveChatChangeGroup) {
    var all by remember(group.id) { mutableStateOf(false) }
    val lines = DriveChatLogic.lines(group)
    val shownLines = if (all) lines else lines.take(DriveChatLogic.PREVIEW)
    val pending = group.status == "PENDING"
    val busy = chats.pressing[group.id] == true || group.status == "APPLYING" || group.status == "UNDOING"
    val tone = when (group.status) { "PENDING" -> ChatCardTone.NEEDS_YOU; "DONE" -> ChatCardTone.DONE; else -> ChatCardTone.QUIET }
    ChatCard(DriveChatCopy.CHANGES_TITLE, DriveChatLogic.state(group), tone, Modifier.testTag("drive-changes:${group.status}"), body = {
        if (pending) Text(DriveChatCopy.pending(group.heldItems.size), fontSize = 14.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
        shownLines.forEach { line ->
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                Text(line.kind, Modifier.width(96.dp), fontWeight = FontWeight.Medium, fontSize = 14.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                Text(line.detail, Modifier.weight(1f), fontSize = 14.sp)
            }
        }
        if (!all && lines.size > shownLines.size) Text(DriveChatCopy.more(maxOf(lines.size, group.total) - shownLines.size), fontSize = 14.sp,
            color = MaterialTheme.colorScheme.onSurfaceVariant)
        if (group.skipped > 0) Text(DriveChatCopy.skipped(group.skipped), fontSize = 14.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
        chats.failures[group.id]?.let { Text(it, color = MaterialTheme.colorScheme.error, fontSize = 14.sp) }
    }, actions = if (lines.size <= DriveChatLogic.PREVIEW && !pending && group.status != "DONE") null else ({
        // Side by side, sharing the width (board frame 7 ①); Material's outlined buttons, Apply the filled one.
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            if (lines.size > DriveChatLogic.PREVIEW) OutlinedButton(onClick = { all = !all }, Modifier.weight(1f).testTag("drive-changes-show-all")) {
                Text(if (all) DriveChatCopy.SHOW_LESS else DriveChatCopy.SHOW_ALL)
            }
            if (pending) Button(onClick = { chats.press(group.id) { chats.api.apply(group.sessionId, group.id) } }, Modifier.weight(1f).testTag("drive-changes-apply"),
                enabled = !busy) { Text(DriveChatCopy.APPLY) }
            if (group.status == "DONE" || group.status == "UNDOING") OutlinedButton(onClick = { chats.press(group.id) { chats.api.undo(group.sessionId, group.id) } },
                Modifier.weight(1f).testTag("drive-changes-undo"), enabled = !busy) { Text(if (group.status == "UNDOING") DriveChatCopy.UNDOING else DriveChatCopy.UNDO) }
        }
    }))
}

/** An overwrite the chat would not make on its own (board frame 12): both files, Keep both over Replace, each the card's width. */
@Composable
internal fun DriveReplaceCard(chats: DriveChats, question: DriveChatQuestion) {
    val open = DriveChatLogic.questionNeedsYou(question)
    val busy = chats.pressing[question.id] == true || question.status == "ANSWERING"
    ChatCard(DriveChatCopy.REPLACE_TITLE, if (open) DriveChatCopy.NEEDS_YOU else null, if (open) ChatCardTone.NEEDS_YOU else ChatCardTone.QUIET,
        Modifier.testTag("drive-replace:${question.status}"), body = {
        QuestionFile(DriveChatCopy.ALREADY_THERE, question.existing)
        Spacer(Modifier.height(4.dp))
        QuestionFile(DriveChatCopy.INCOMING, question.moving)
        DriveChatLogic.answered(question)?.let { Text(it, fontSize = 14.sp, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 4.dp)) }
        chats.failures[question.id]?.let { Text(it, color = MaterialTheme.colorScheme.error, fontSize = 14.sp) }
    }, actions = if (!open) null else ({
        Button(onClick = { chats.press(question.id) { chats.api.answer(question.sessionId, question.id, "KEEP_BOTH") } }, Modifier.fillMaxWidth()
            .testTag("drive-replace-keep-both"), enabled = !busy) { Text(DriveChatCopy.KEEP_BOTH) }
        OutlinedButton(onClick = { chats.press(question.id) { chats.api.answer(question.sessionId, question.id, "REPLACE") } }, Modifier.fillMaxWidth()
            .testTag("drive-replace-replace"), enabled = !busy) { Text(DriveChatCopy.REPLACE) }
    }))
}

@Composable
private fun QuestionFile(label: String, file: DriveChatQuestionFile) {
    Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Text(label, fontWeight = FontWeight.SemiBold, fontSize = 14.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Text(file.path, fontSize = 15.sp)
        Text("${DriveLogic.formatSize(file.sizeBytes)} · ${DriveChatLogic.writer(file)} · ${DriveLogic.formatWhen(file.modifiedAt)}", fontSize = 14.sp,
            color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}
