package io.orbitd.android.core.drive

import io.orbitd.android.core.auth.OrbitApi
import io.orbitd.android.core.auth.SessionHandle
import io.orbitd.android.core.net.ApiRequest
import io.orbitd.android.core.net.ApiResponse
import io.orbitd.android.core.net.HttpMethod
import io.orbitd.android.core.protocol.Wire
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.add
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import kotlinx.serialization.json.putJsonObject

// The Drive chat (project "Drive chat: manage files by talking to an agent", board docs/mocks/drive-chat/02-native.html frames 9–12):
// a chat docked on Drive, an ordinary session opened by `POST /api/drive/chats` (apiserver drive/drive-chat.ts), with the change
// groups and overwrite questions it leaves (drive/drive-chat-changes.ts). The twin of @orbit/shared driveChat.ts and the web's
// lib/driveChat.ts and lib/driveChanges.ts: the same words, the same reading rules.

/** The workspace a Drive chat runs in, as the list names it. */
@Serializable
data class DriveChatWorkspace(val id: String, val name: String, val runner: String? = null, val online: Boolean = false)

/** One Drive chat, as `GET /api/drive/chats` lists it. */
@Serializable
data class DriveChatRow(
    val sessionId: String,
    val title: String = "",
    val status: String = "",
    /** Not ended and not in Trash: it takes messages. */
    val open: Boolean = true,
    /** In the session list's Completed. */
    val completed: Boolean = false,
    /** A turn of it is queued or running. */
    val working: Boolean = false,
    /** Its approvals and questions waiting on the owner. */
    val needsYou: Int = 0,
    val workspaceId: String? = null,
    val createdAt: String = "",
    val updatedAt: String = "",
    val lastActiveAt: String = "",
)

@Serializable
data class DriveChatFabCounts(val needsYou: Int = 0, val working: Boolean = false)

/** `GET /api/drive/chats`. */
@Serializable
data class DriveChatList(
    /** Where a new chat runs when it names none ("Runs in"), or null when there is none. */
    val workspace: DriveChatWorkspace? = null,
    /** `LAST_CHAT` or `ORBIT_CLOUD`. */
    val workspaceFrom: String? = null,
    val fab: DriveChatFabCounts = DriveChatFabCounts(),
    val chats: List<DriveChatRow> = emptyList(),
    val more: Boolean = false,
)

/** What creating a Drive chat answers. */
@Serializable
data class DriveChatCreated(val sessionId: String, val chat: DriveChatRow, val workspace: DriveChatWorkspace)

/** Where an entry was or went: its folder (id and path when known) and its name. */
@Serializable
data class DriveChatPlace(val parentId: String? = null, val parentPath: String? = null, val name: String? = null)

/** One change of a group; [state] `SKIPPED` carries why Undo left it as it is. */
@Serializable
data class DriveChatChangeItem(
    val id: String,
    /** NEW_FOLDER, NEW_FILE, MOVE, RENAME, TRASH or EDIT. */
    val kind: String,
    val entryId: String,
    val entryKind: String = "",
    val before: DriveChatPlace = DriveChatPlace(),
    val after: DriveChatPlace = DriveChatPlace(),
    val state: String = "DONE",
    val reason: String? = null,
)

/** One write held for Apply, as the agent asked for it. */
@Serializable
data class DriveChatHeldItem(
    val id: String,
    val kind: String,
    val entryId: String? = null,
    val name: String = "",
    val fromPath: String? = null,
    val toPath: String? = null,
    val state: String = "PENDING",
    val reason: String? = null,
)

/** What one turn changed in Drive: one card with Undo (owner decision Q2 A). */
@Serializable
data class DriveChatChangeGroup(
    val id: String,
    val sessionId: String,
    val turnId: String,
    /** DONE, PENDING, APPLYING, UNDOING or UNDONE. */
    val status: String,
    val held: Boolean = false,
    val createdAt: String = "",
    val appliedAt: String? = null,
    val undoneAt: String? = null,
    val counts: Map<String, Int> = emptyMap(),
    val total: Int = 0,
    val skipped: Int = 0,
    val items: List<DriveChatChangeItem> = emptyList(),
    val heldItems: List<DriveChatHeldItem> = emptyList(),
)

@Serializable
data class DriveChatWriter(val kind: String = "OWNER", val sessionId: String? = null, val sessionTitle: String? = null)

/** One side of an overwrite question: a file as it was when the chat asked. */
@Serializable
data class DriveChatQuestionFile(
    val entryId: String,
    val path: String,
    val sizeBytes: Long = 0,
    val modifiedAt: String = "",
    val lastWriter: DriveChatWriter = DriveChatWriter(),
)

@Serializable
data class DriveChatDestination(val parentId: String, val name: String)

@Serializable
data class DriveChatOutcome(val entryId: String, val path: String, val name: String)

/** A move or rename onto a live file the chat would not make on its own, asked of the owner on a card (owner Q4 A). */
@Serializable
data class DriveChatQuestion(
    val id: String,
    val sessionId: String,
    val turnId: String,
    /** OPEN, ANSWERING, ANSWERED or STALE. */
    val status: String,
    /** KEEP_BOTH or REPLACE. */
    val choice: String? = null,
    val moving: DriveChatQuestionFile,
    val existing: DriveChatQuestionFile,
    val destination: DriveChatDestination? = null,
    val outcome: DriveChatOutcome? = null,
    val reason: String? = null,
    val createdAt: String = "",
    val answeredAt: String? = null,
)

@Serializable
internal data class DriveChatGroups(val groups: List<DriveChatChangeGroup> = emptyList())

@Serializable
internal data class DriveChatQuestions(val questions: List<DriveChatQuestion> = emptyList())

/** The folder and selection a Drive-chat message carries ([DriveChatLogic.context]): ids, never text. */
data class DriveChatContext(val folderId: String?, val entryIds: List<String> = emptyList())

/** The words of the Drive chat, as the web says them (lib/driveChat.ts, lib/driveChanges.ts). */
object DriveChatCopy {
    const val EMPTY_HINT = "Ask about your files, or say how to sort them."
    const val EMPTY_NOTE = "Every change it makes shows here, and can be undone."
    const val PLACEHOLDER = "Ask about your files, or say how to sort them"
    /** Under a new chat's empty state while its box is empty; a press fills the box and sends nothing. */
    val EXAMPLES = listOf(
        "Sort these receipts into Receipts 2026 by month",
        "What’s taking up the most space?",
        "Find the lease and tell me when the notice period ends",
    )
    const val HISTORY = "Drive chats"
    const val NO_HISTORY = "No Drive chats yet"
    const val NO_WORKSPACE = "Add a machine or Orbit Cloud to chat about your files"
    const val CHOOSE_WORKSPACE = "Choose where Drive chats run"
    const val RUNS_IN = "Runs in"
    const val NEW_CHAT = "New chat"
    const val OPEN_SESSION = "Open as a session"
    const val CLOSE = "Close chat"
    const val SEND_FAILED = "The message couldn’t be sent. Check the connection, then try again."
    fun offline(machine: String): String = "$machine is offline. The chat waits for it to come back."
    const val ORBIT_ATTACHED = "Orbit attached"

    // The round button: its look is its icon, these are its accessibility label.
    const val FAB_IDLE = "Chat"
    const val FAB_WORKING = "Working…"
    const val FAB_UPDATED = "Drive updated"
    fun fabNeedsYou(n: Int): String = if (n == 1) "1 needs you" else "$n need you"

    fun folder(name: String): String = "Folder · $name"
    fun remove(what: String): String = "Remove $what"

    // The cards.
    const val CHANGES_TITLE = "Drive changes"
    const val NEEDS_YOU = "Needs you"
    const val UNDONE = "Undone"
    const val APPLYING = "Applying…"
    const val UNDOING = "Undoing…"
    const val SHOW_ALL = "Show all"
    const val SHOW_LESS = "Show less"
    const val UNDO = "Undo"
    const val APPLY = "Apply"
    const val REPLACE_TITLE = "Replace a file?"
    const val KEEP_BOTH = "Keep both"
    const val REPLACE = "Replace"
    const val ALREADY_THERE = "Already there"
    const val INCOMING = "Incoming"
    const val REPLACED = "Replaced. The old file is in its versions."
    const val NO_LONGER_OPEN = "This question is no longer open."
    fun keptBoth(savedAs: String?): String = "Kept both${savedAs?.let { " · saved as $it" } ?: ""}."

    private fun plural(n: Int, one: String, many: String) = "$n ${if (n == 1) one else many}"
    fun done(n: Int): String = "Done · ${plural(n, "change", "changes")}"
    fun pending(n: Int): String = "${plural(n, "change", "changes")} waiting for Apply"
    fun more(n: Int): String = "and $n more"
    fun skipped(n: Int): String = "$n left as ${if (n == 1) "it is" else "they are"}"
}

/** The round button's four looks (board frame 4): idle, a turn running, something waiting on the owner, work finished while closed. */
enum class ChatFabState { IDLE, WORKING, NEEDS_YOU, UPDATED }

/** A list row's mark, left by a Drive chat's change until the row is opened. */
enum class DriveMark(val label: String) { NEW("New"), MOVED("Moved"), RENAMED("Renamed") }

/** One line of a change card: `Moved` and what it was done to. */
data class DriveChangeLine(val id: String, val kind: String, val detail: String)

/** The Drive chat's reading rules: the same as the web's, so the clients agree on every card. */
object DriveChatLogic {
    /** How many items a card lists before "and N more". */
    const val PREVIEW = 4
    /** The most items one message may name as selected. */
    const val SELECTION_MAX = 200

    /** The round button's look and its label: needs-you first, then working, then updated. */
    fun fab(needsYou: Int, working: Boolean, updated: Boolean): Pair<ChatFabState, String> = when {
        needsYou > 0 -> ChatFabState.NEEDS_YOU to DriveChatCopy.fabNeedsYou(needsYou)
        working -> ChatFabState.WORKING to DriveChatCopy.FAB_WORKING
        updated -> ChatFabState.UPDATED to DriveChatCopy.FAB_UPDATED
        else -> ChatFabState.IDLE to DriveChatCopy.FAB_IDLE
    }

    /** Which chat the sheet opens on: the one that needs the owner, else the most recent open one, else null (a new chat). */
    fun toOpen(chats: List<DriveChatRow>): String? {
        val rows = chats.filter { it.open && !it.completed }
        return (rows.firstOrNull { it.needsYou > 0 } ?: rows.firstOrNull())?.sessionId
    }

    private val kindLabel = mapOf("NEW_FOLDER" to "New folder", "NEW_FILE" to "New file", "MOVE" to "Moved", "RENAME" to "Renamed",
        "TRASH" to "To Trash", "EDIT" to "Edited")

    private fun itemLine(item: DriveChatChangeItem): DriveChangeLine {
        val kind = kindLabel[item.kind] ?: item.kind
        val detail = when (item.kind) {
            "RENAME" -> "${item.before.name.orEmpty()} → ${item.after.name.orEmpty()}"
            "MOVE" -> "${item.after.name.orEmpty()} → ${item.after.parentPath ?: "Drive"}"
            "TRASH" -> item.before.name.orEmpty()
            else -> item.after.name.orEmpty()
        }
        return DriveChangeLine(item.id, kind, detail)
    }

    private fun heldLine(item: DriveChatHeldItem): DriveChangeLine {
        val kind = kindLabel[item.kind] ?: item.kind
        val detail = if (item.kind == "MOVE" || item.kind == "RENAME") "${item.fromPath ?: item.name} → ${item.toPath.orEmpty()}" else item.name
        return DriveChangeLine(item.id, kind, detail)
    }

    /** What a group's card lists: what was made, or for a group held for Apply what is held. */
    fun lines(group: DriveChatChangeGroup): List<DriveChangeLine> =
        if (group.status == "PENDING") group.heldItems.map(::heldLine) else group.items.map(::itemLine)

    /** The card's state word on its head: Done · N changes, Needs you, Applying…, Undoing…, Undone. */
    fun state(group: DriveChatChangeGroup): String = when (group.status) {
        "UNDONE" -> DriveChatCopy.UNDONE
        "PENDING" -> DriveChatCopy.NEEDS_YOU
        "APPLYING" -> DriveChatCopy.APPLYING
        "UNDOING" -> DriveChatCopy.UNDOING
        else -> DriveChatCopy.done(group.total)
    }

    fun groupNeedsYou(group: DriveChatChangeGroup): Boolean = group.status == "PENDING"
    fun questionNeedsYou(question: DriveChatQuestion): Boolean = question.status == "OPEN" || question.status == "ANSWERING"

    /** What waits on the owner beyond the approvals the chats list counts: held groups and open questions. */
    fun needYou(groups: List<DriveChatChangeGroup>, questions: List<DriveChatQuestion>): Int =
        groups.count(::groupNeedsYou) + questions.count(::questionNeedsYou)

    /** What an answered or stale question says in place of its buttons; null while it is open. */
    fun answered(question: DriveChatQuestion): String? = when (question.status) {
        "ANSWERED" -> if (question.choice == "REPLACE") DriveChatCopy.REPLACED else DriveChatCopy.keptBoth(question.outcome?.name)
        "STALE" -> question.reason ?: DriveChatCopy.NO_LONGER_OPEN
        else -> null
    }

    /** One side of an overwrite card: who last wrote it, as the list says it. */
    fun writer(file: DriveChatQuestionFile): String {
        val w = file.lastWriter
        return when {
            w.kind == "OWNER" -> "You"
            w.sessionTitle != null -> "Agent in ${w.sessionTitle}"
            w.kind == "AGENT" -> "An agent"
            else -> "Another machine"
        }
    }

    private val markOf = mapOf("NEW_FOLDER" to DriveMark.NEW, "NEW_FILE" to DriveMark.NEW, "MOVE" to DriveMark.MOVED, "RENAME" to DriveMark.RENAMED)

    /**
     * The rows the chats' groups left marked, entry id → (mark, the item that left it): created, moved in or renamed by a group that is
     * made (not held, not undone), by an item that stood. An entry changed twice shows the latest.
     */
    fun marks(groups: List<DriveChatChangeGroup>): Map<String, Pair<DriveMark, String>> {
        val marks = LinkedHashMap<String, Pair<DriveMark, String>>()
        for (group in groups.sortedBy { it.createdAt }) {
            if (group.status != "DONE") continue
            for (item in group.items) {
                val mark = markOf[item.kind] ?: continue
                if (item.state == "DONE") marks[item.entryId] = mark to item.id
            }
        }
        return marks
    }

    /**
     * Where each card goes in the conversation, as the web places them: after the last row of its turn. [rowFirstSeqs] is each row's
     * first event seq, in order; [lastSeqOfTurn] the last seq each turn's events reach. Answers card key → row index; a card whose turn
     * is not among the events read is left out, and drawn under the conversation.
     */
    fun place(rowFirstSeqs: List<Long>, lastSeqOfTurn: (String) -> Long?, cards: List<Pair<String, String>>): Map<String, Int> {
        val placed = LinkedHashMap<String, Int>()
        for ((key, turnId) in cards) {
            val anchor = lastSeqOfTurn(turnId) ?: continue
            val index = rowFirstSeqs.indexOfLast { it <= anchor }
            if (index >= 0) placed[key] = index
        }
        return placed
    }

    /**
     * The body of `POST /api/drive/chats`. The folder chip shown goes as `folderId` (null at the top level); none shown — crossed out —
     * goes as `noFolder`, so the agent is told of no folder rather than of the top level.
     */
    fun createBody(text: String, clientTurnId: String, workspaceId: String?, context: DriveChatContext?, composer: JsonObject = JsonObject(emptyMap()),
        attachmentIds: List<String> = emptyList()): JsonObject = buildJsonObject {
        put("text", text)
        put("clientTurnId", clientTurnId)
        workspaceId?.takeIf { it.isNotEmpty() }?.let { put("workspaceId", it) }
        if (context == null) put("noFolder", true)
        else {
            put("folderId", context.folderId)
            if (context.entryIds.isNotEmpty()) putJsonArray("entryIds") { context.entryIds.take(SELECTION_MAX).forEach { add(it) } }
        }
        if (attachmentIds.isNotEmpty()) putJsonArray("attachmentIds") { attachmentIds.forEach { add(it) } }
        for (key in listOf("engine", "model", "permissionMode", "effort", "fastMode")) composer[key]?.let { put(key, it) }
    }

    /**
     * What the "Orbit attached:" line under the owner's message names of the `<orbit_drive_chat>` note delivery appended to it
     * (drive/drive-chat-notes.ts): the folder the owner had open and how many items they selected, off the block's opening tag —
     * `Folder · Scans · 12 files`, `Folder · Drive` at the top level. Null when the note names neither (the chat's standing guidance
     * alone is not something the owner attached).
     */
    fun noteLabel(note: String?): String? {
        if (note == null) return null
        val head = Regex("<${NOTE_TAG}((?:\\s+[\\w-]+=\"[^\"]*\")*)\\s*>").find(note) ?: return null
        val attributes = Regex("([\\w-]+)=\"([^\"]*)\"").findAll(head.groupValues[1]).associate { m ->
            m.groupValues[1] to m.groupValues[2].replace("&quot;", "\"").replace("&lt;", "<").replace("&gt;", ">").replace("&amp;", "&")
        }
        val folder = attributes["folder"]?.let { path -> path.trimEnd('/').substringAfterLast('/').ifEmpty { DriveLogic.TITLE } }
        val selected = attributes["selected"]?.toIntOrNull()?.takeIf { it > 0 }
        val parts = listOfNotNull(folder?.let(DriveChatCopy::folder), selected?.let { if (it == 1) "1 file" else "$it files" })
        return parts.takeIf { it.isNotEmpty() }?.joinToString(" · ")
    }

    /** The tag of the note every delivered Drive-chat turn may carry. */
    const val NOTE_TAG = "orbit_drive_chat"

    /** What a later message carries of the page beside its words: `{ driveContext }`, or nothing when the chip was crossed out. */
    fun turnContext(context: DriveChatContext?): JsonObject? = context?.let {
        buildJsonObject {
            putJsonObject("driveContext") {
                put("folderId", it.folderId)
                if (it.entryIds.isNotEmpty()) putJsonArray("entryIds") { it.entryIds.take(SELECTION_MAX).forEach { id -> add(id) } }
            }
        }
    }
}

/** The Drive chat's doors (apiserver drive/drive-chat.ts and drive-chat-changes.ts, at the `drive/chats` prefix). */
class DriveChatApi(private val api: OrbitApi, private val handle: SessionHandle) {
    suspend fun list(q: String? = null, offset: Int = 0): DriveChatList =
        decode(api.request(handle, ApiRequest(listOf("drive", "chats"), query = listOfNotNull(q?.trim()?.takeIf { it.isNotEmpty() }?.let { "q" to it },
            offset.takeIf { it > 0 }?.let { "offset" to it.toString() }))).requireSuccess(), DriveChatList.serializer())

    suspend fun create(body: JsonObject): DriveChatCreated =
        decode(send(listOf("drive", "chats"), body), DriveChatCreated.serializer())

    suspend fun groups(sessionId: String): List<DriveChatChangeGroup> =
        decode(api.request(handle, ApiRequest(listOf("drive", "chats", sessionId, "groups"))).requireSuccess(), DriveChatGroups.serializer()).groups

    suspend fun questions(sessionId: String): List<DriveChatQuestion> =
        decode(api.request(handle, ApiRequest(listOf("drive", "chats", sessionId, "questions"))).requireSuccess(), DriveChatQuestions.serializer()).questions

    suspend fun undo(sessionId: String, groupId: String): DriveChatChangeGroup =
        decode(send(listOf("drive", "chats", sessionId, "groups", groupId, "undo")), DriveChatChangeGroup.serializer())

    suspend fun apply(sessionId: String, groupId: String): DriveChatChangeGroup =
        decode(send(listOf("drive", "chats", sessionId, "groups", groupId, "apply")), DriveChatChangeGroup.serializer())

    /** The owner's answer to an overwrite question: `KEEP_BOTH` or `REPLACE`. */
    suspend fun answer(sessionId: String, questionId: String, choice: String): DriveChatQuestion =
        decode(send(listOf("drive", "chats", sessionId, "questions", questionId), buildJsonObject { put("choice", choice) }), DriveChatQuestion.serializer())

    private suspend fun send(path: List<String>, body: JsonObject? = null): ApiResponse =
        api.request(handle, ApiRequest(path, HttpMethod.POST, body = body?.toString()?.encodeToByteArray())).requireSuccess()

    private fun <T> decode(response: ApiResponse, serializer: kotlinx.serialization.DeserializationStrategy<T>): T = Wire.decode(response.body, serializer)
}
