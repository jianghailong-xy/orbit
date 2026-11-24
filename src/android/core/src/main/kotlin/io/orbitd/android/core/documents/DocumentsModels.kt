package io.orbitd.android.core.documents

import kotlinx.serialization.Serializable

// Documents: the account's drive as the owner's routes answer it (docs/documents-drive-technical-design.md §4.1, apiserver
// documents/documents.controller.ts, prefix `documents`). The twin of OrbitKit's Models/Documents.swift. Kinds and states are
// Strings where a newer server may add one, so an answer still decodes; the reading rules live in `DocumentsLogic`.

/** Who last wrote an entry or a version (§3.6). An agent's session is kept only where the door could check it. */
@Serializable
data class DocumentsWriter(
    /** `OWNER` or `AGENT`. */
    val kind: String = "OWNER",
    val sessionId: String? = null,
    val runnerId: String? = null,
    /** When, on an entry's `lastWriter`; absent on a version's or a group's writer. */
    val at: String? = null,
) {
    val isOwner get() = kind == "OWNER"
}

/** A file or a folder in the drive. */
@Serializable
data class DocumentsEntry(
    val id: String,
    val parentId: String? = null,
    /** `FILE` or `FOLDER`. */
    val kind: String,
    val name: String,
    val sizeBytes: Long = 0,
    val mtime: String = "",
    val currentVersionId: String? = null,
    val seq: Long = 0,
    val createdAt: String = "",
    val updatedAt: String = "",
    val lastWriter: DocumentsWriter = DocumentsWriter(),
    val trashedAt: String? = null,
    val trashGroupId: String? = null,
    /** On a read of one entry: `/a/b/name` under the drive's root. */
    val path: String? = null,
    /** On a search result: the folder it sits in, `/a/b` (`/` for the top level). */
    val folderPath: String? = null,
) {
    val isFolder get() = kind == "FOLDER"
    val isFile get() = kind == "FILE"
}

/** `GET /documents/entries`: one page of a folder (the root when no `parentId`). */
@Serializable
data class DocumentsListing(val folder: DocumentsEntry, val entries: List<DocumentsEntry> = emptyList(), val nextCursor: String? = null)

/** `GET /documents/search`: the first page of live entries whose name contains the words. */
@Serializable
data class DocumentsSearchResult(val entries: List<DocumentsEntry> = emptyList(), val nextCursor: String? = null)

/** One version of a file, current or replaced. */
@Serializable
data class DocumentsVersion(
    val id: String,
    val entryId: String,
    val sizeBytes: Long = 0,
    val createdAt: String = "",
    val current: Boolean = false,
    val writer: DocumentsWriter = DocumentsWriter(),
    val replacedAt: String? = null,
    val trashGroupId: String? = null,
)

/** `GET /documents/entries/:id/versions`. */
@Serializable
data class DocumentsVersions(val entry: DocumentsEntry, val versions: List<DocumentsVersion> = emptyList())

/** A trash group's replaced version, with the file it belongs to. */
@Serializable
data class DocumentsTrashVersion(
    val id: String,
    val entryId: String,
    val sizeBytes: Long = 0,
    val createdAt: String = "",
    val writer: DocumentsWriter = DocumentsWriter(),
    val entry: DocumentsEntry,
)

/** What one delete (or one replace) put in Trash (rule 3): the folder it came from and when. */
@Serializable
data class DocumentsTrashGroup(
    val id: String,
    /** `DELETE` or `VERSION`. */
    val kind: String = "DELETE",
    val folderId: String? = null,
    val folderPath: String = "/",
    val createdAt: String = "",
    val itemCount: Int = 0,
    val sizeBytes: Long = 0,
    val actor: DocumentsWriter = DocumentsWriter(),
    val items: List<DocumentsEntry> = emptyList(),
    val version: DocumentsTrashVersion? = null,
)

/** `GET /documents/trash`: one page of groups, newest first. */
@Serializable
data class DocumentsTrashPage(val groups: List<DocumentsTrashGroup> = emptyList(), val nextCursor: String? = null)

/** What a restore brought back. */
@Serializable
data class DocumentsRestored(val entryIds: List<String> = emptyList())

/** `DELETE /documents/entries/:id`: the group the entry went in, which Undo restores. */
@Serializable
data class DocumentsTrashed(val trashGroupId: String)

/** What the share check found (§9): the shape and line of a credential, never the credential itself. */
@Serializable
data class DocumentsShareWarning(val kind: String, val line: Int = 0)

/** `POST /documents/entries/:id/share-check`. */
@Serializable
data class DocumentsShareCheck(
    val versionId: String? = null,
    val warnings: List<DocumentsShareWarning> = emptyList(),
    val checkedBytes: Long = 0,
    /** Only the start of the file was read: the scan stops at 25 MiB or 20 s. */
    val partial: Boolean = false,
)

/** A drive file's link, as `GET /share-links?kind=DRIVE_FILE` lists it and `POST /share-links` answers it. `root.pinnedIsCurrent` is
 * false once the file moved on. */
@Serializable
data class DocumentsShareLink(
    val id: String,
    val kind: String = "DRIVE_FILE",
    val token: String,
    /** `ACTIVE`, `PAUSED` (the file is in Trash) or `ENDED`. */
    val state: String = "ACTIVE",
    val root: Root,
) {
    @Serializable
    data class Root(val id: String, val title: String? = null, val pinnedIsCurrent: Boolean = true)
}

/** `POST /share-links` with a drive file: the link, and what the scan found on the version it pins. */
@Serializable
data class DocumentsShareAnswer(
    val link: DocumentsShareLink,
    val warnings: List<DocumentsShareWarning> = emptyList(),
    val checkedBytes: Long = 0,
    val partial: Boolean = false,
)

/** `GET /documents/usage`: the drive's share of the account and the rest, each content once (§2.5). */
@Serializable
data class DocumentsUsage(
    val totalBytes: Long = 0,
    val driveBytes: Long = 0,
    val trashBytes: Long = 0,
    val otherBytes: Long = 0,
    val storeUsedBytes: Long? = null,
    val storeQuotaBytes: Long? = null,
    val nearQuota: Boolean? = null,
)

/** `GET /attachments/usage`: what the account keeps besides the drive, with its largest projects and tasks and what each week added
 * (oldest first). */
@Serializable
data class StorageUsage(
    val totalBytes: Long = 0,
    val fileCount: Int = 0,
    val quotaBytes: Long? = null,
    val projects: List<Project> = emptyList(),
    val tasks: List<Task> = emptyList(),
    val weeks: List<Week> = emptyList(),
) {
    @Serializable data class Project(val projectId: String, val title: String = "", val bytes: Long = 0)
    @Serializable data class Task(val taskId: String, val title: String = "", val bytes: Long = 0)
    /** [weekStart] is that week's Monday, `YYYY-MM-DD`. */
    @Serializable data class Week(val weekStart: String, val bytes: Long = 0)
}

/** An agent's directory sync into Documents (docs/documents-directory-sync-design.md, S4). */
@Serializable
data class DocumentsSync(
    val id: String,
    /** `CHECKING`, `UPLOADING`, `DONE`, `FAILED` or `STOPPED`. */
    val status: String,
    val sourceName: String = "",
    val destPath: String = "/",
    val destEntryId: String? = null,
    val session: Session? = null,
    val filesSeen: Int = 0,
    val filesTotal: Int? = null,
    val filesDone: Int = 0,
    val filesSame: Int = 0,
    val filesDeleted: Int = 0,
    val bytesTotal: Long? = null,
    val bytesSent: Long = 0,
    val currentPath: String? = null,
    val failed: List<Failure> = emptyList(),
    val failedCount: Int = 0,
    val error: String? = null,
    val startedAt: String = "",
    val updatedAt: String = "",
    val endedAt: String? = null,
) {
    @Serializable data class Session(val id: String, val title: String = "")
    @Serializable data class Failure(val path: String, val error: String = "")

    val running get() = status == "CHECKING" || status == "UPLOADING"
}

@Serializable
data class DocumentsSyncList(val syncs: List<DocumentsSync> = emptyList())

/** `POST /documents/uploads`: the staging id, and the size every chunk but the last must have. */
@Serializable
data class DocumentsUploadOpened(
    val id: String,
    val chunkSize: Int,
    /** The top folder a dropped folder's files share; later files of the same drop pass it back. */
    val dropRootId: String? = null,
)

/** `GET /documents/uploads/:id`: which chunks have arrived, so an upload goes on from where it stopped. */
@Serializable
data class DocumentsUploadStatus(
    val chunkSize: Int,
    val chunks: List<Chunk> = emptyList(),
    val completed: Boolean = false,
    val entryId: String? = null,
) {
    @Serializable data class Chunk(val idx: Int, val sizeBytes: Long)
}

/** `POST /documents/entries/:id/download-link`: a URL under /api that downloads without a login header. */
@Serializable
data class DocumentsDownloadLink(val path: String, val expiresAt: String = "")
