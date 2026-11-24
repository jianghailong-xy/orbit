package io.orbitd.android.core.drive

import kotlinx.serialization.Serializable

// Drive: the account's drive as the owner's routes answer it (docs/drive-technical-design.md §4.1, apiserver
// drive/drive.controller.ts, at its `drive` prefix). The twin of OrbitKit's Models/Drive.swift. Kinds and states are
// Strings where a newer server may add one, so an answer still decodes; the reading rules live in `DriveLogic`.

/** Who last wrote an entry or a version (§3.6). An agent's session is kept only where the door could check it. */
@Serializable
data class DriveWriter(
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
data class DriveEntry(
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
    val lastWriter: DriveWriter = DriveWriter(),
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

/** `GET /drive/entries`: one page of a folder (the root when no `parentId`). */
@Serializable
data class DriveListing(val folder: DriveEntry, val entries: List<DriveEntry> = emptyList(), val nextCursor: String? = null)

/** `GET /drive/search`: the first page of live entries whose name contains the words. */
@Serializable
data class DriveSearchResult(val entries: List<DriveEntry> = emptyList(), val nextCursor: String? = null)

/** One version of a file, current or replaced. */
@Serializable
data class DriveVersion(
    val id: String,
    val entryId: String,
    val sizeBytes: Long = 0,
    val createdAt: String = "",
    val current: Boolean = false,
    val writer: DriveWriter = DriveWriter(),
    val replacedAt: String? = null,
    val trashGroupId: String? = null,
)

/** `GET /drive/entries/:id/versions`. */
@Serializable
data class DriveVersions(val entry: DriveEntry, val versions: List<DriveVersion> = emptyList())

/** A trash group's replaced version, with the file it belongs to. */
@Serializable
data class DriveTrashVersion(
    val id: String,
    val entryId: String,
    val sizeBytes: Long = 0,
    val createdAt: String = "",
    val writer: DriveWriter = DriveWriter(),
    val entry: DriveEntry,
)

/** What one delete (or one replace) put in Trash (rule 3): the folder it came from and when. */
@Serializable
data class DriveTrashGroup(
    val id: String,
    /** `DELETE` or `VERSION`. */
    val kind: String = "DELETE",
    val folderId: String? = null,
    val folderPath: String = "/",
    val createdAt: String = "",
    val itemCount: Int = 0,
    val sizeBytes: Long = 0,
    val actor: DriveWriter = DriveWriter(),
    val items: List<DriveEntry> = emptyList(),
    val version: DriveTrashVersion? = null,
)

/** `GET /drive/trash`: one page of groups, newest first. */
@Serializable
data class DriveTrashPage(val groups: List<DriveTrashGroup> = emptyList(), val nextCursor: String? = null)

/** What a restore brought back. */
@Serializable
data class DriveRestored(val entryIds: List<String> = emptyList())

/** `DELETE /drive/entries/:id`: the group the entry went in, which Undo restores. */
@Serializable
data class DriveTrashed(val trashGroupId: String)

/** What the share check found (§9): the shape and line of a credential, never the credential itself. */
@Serializable
data class DriveShareWarning(val kind: String, val line: Int = 0)

/** `POST /drive/entries/:id/share-check`. */
@Serializable
data class DriveShareCheck(
    val versionId: String? = null,
    val warnings: List<DriveShareWarning> = emptyList(),
    val checkedBytes: Long = 0,
    /** Only the start of the file was read: the scan stops at 25 MiB or 20 s. */
    val partial: Boolean = false,
)

/** A drive file's link, as `GET /share-links?kind=DRIVE_FILE` lists it and `POST /share-links` answers it. `root.pinnedIsCurrent` is
 * false once the file moved on. */
@Serializable
data class DriveShareLink(
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
data class DriveShareAnswer(
    val link: DriveShareLink,
    val warnings: List<DriveShareWarning> = emptyList(),
    val checkedBytes: Long = 0,
    val partial: Boolean = false,
)

/** `GET /drive/usage`: the drive's share of the account and the rest, each content once (§2.5). */
@Serializable
data class DriveUsage(
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

/** An agent's directory sync into Drive (docs/drive-directory-sync-design.md, S4). */
@Serializable
data class DriveSync(
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
data class DriveSyncList(val syncs: List<DriveSync> = emptyList())

/** `POST /drive/uploads`: the staging id, and the size every chunk but the last must have. */
@Serializable
data class DriveUploadOpened(
    val id: String,
    val chunkSize: Int,
    /** The top folder a dropped folder's files share; later files of the same drop pass it back. */
    val dropRootId: String? = null,
)

/** `GET /drive/uploads/:id`: which chunks have arrived, so an upload goes on from where it stopped. */
@Serializable
data class DriveUploadStatus(
    val chunkSize: Int,
    val chunks: List<Chunk> = emptyList(),
    val completed: Boolean = false,
    val entryId: String? = null,
) {
    @Serializable data class Chunk(val idx: Int, val sizeBytes: Long)
}

/** `POST /drive/entries/:id/download-link`: a URL under /api that downloads without a login header. */
@Serializable
data class DriveDownloadLink(val path: String, val expiresAt: String = "")
