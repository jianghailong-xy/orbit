package io.orbitd.android.core.drive

import io.orbitd.android.core.auth.OrbitApi
import io.orbitd.android.core.auth.SessionHandle
import io.orbitd.android.core.net.ApiRequest
import io.orbitd.android.core.net.ApiResponse
import io.orbitd.android.core.net.HttpMethod
import io.orbitd.android.core.protocol.ProtocolException
import io.orbitd.android.core.protocol.Wire
import kotlinx.serialization.DeserializationStrategy
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/** The calls an upload makes. [DriveApi] is the real one; tests answer with a fake. */
interface DriveUploadTransport {
    suspend fun openUpload(parentId: String?, name: String, size: Long, relativePath: String?, dropRootId: String?): DriveUploadOpened
    suspend fun uploadStatus(uploadId: String): DriveUploadStatus
    suspend fun putChunk(uploadId: String, index: Int, bytes: ByteArray, sha256: String)
    suspend fun completeUpload(uploadId: String): DriveEntry
    suspend fun abandonUpload(uploadId: String)
}

/**
 * The owner's Drive doors (apiserver drive.controller.ts, at its `drive` prefix; OrbitKit APIClient's Drive calls). A
 * refusal is the transport's [io.orbitd.android.core.net.ApiError] (a server with Drive off answers 404 DOCUMENTS_DISABLED); an
 * answer this build cannot read is a [ProtocolException].
 */
class DriveApi(private val api: OrbitApi, private val handle: SessionHandle) : DriveUploadTransport {
    /** `GET /auth/capabilities` → `documents.enabled`: null where the server says nothing (a server from before the switch). */
    suspend fun driveEnabled(): Boolean? {
        val body = parse(get(listOf("auth", "capabilities"))) as? JsonObject ?: return null
        return ((body["documents"] as? JsonObject)?.get("enabled") as? JsonPrimitive)?.booleanOrNull
    }

    /** Every page of a folder (the root when [parentId] is null): a folder is read whole, a thousand names a page. */
    suspend fun folder(parentId: String?): DriveListing {
        var cursor: String? = null
        var listing: DriveListing? = null
        do {
            val query = listOfNotNull("limit" to "1000", parentId?.let { "parentId" to it }, cursor?.let { "cursor" to it })
            val page = decode(get(listOf("drive", "entries"), query), DriveListing.serializer())
            listing = listing?.let { DriveListing(page.folder, it.entries + page.entries, page.nextCursor) } ?: page
            cursor = page.nextCursor
        } while (cursor != null)
        return listing!!
    }

    /** Live entries anywhere in the drive whose name contains [q], each with its folder (the first page, by name). */
    suspend fun search(q: String): DriveSearchResult =
        decode(get(listOf("drive", "search"), listOf("q" to q, "limit" to "100")), DriveSearchResult.serializer())

    /** One entry, with its `path`. */
    suspend fun entry(id: String): DriveEntry = decode(get(listOf("drive", "entries", id)), DriveEntry.serializer())

    suspend fun versions(fileId: String): DriveVersions =
        decode(get(listOf("drive", "entries", fileId, "versions")), DriveVersions.serializer())

    /** A new folder; a name already taken gets a suffix. */
    suspend fun createFolder(parentId: String?, name: String): DriveEntry =
        decode(send(listOf("drive", "folders"), HttpMethod.POST, buildJsonObject { parentId?.let { put("parentId", it) }; put("name", name) }),
            DriveEntry.serializer())

    /** Rename; a taken name is refused, never overwritten. */
    suspend fun rename(id: String, name: String): DriveEntry =
        decode(send(listOf("drive", "entries", id), HttpMethod.PATCH, buildJsonObject { put("name", name) }), DriveEntry.serializer())

    suspend fun move(id: String, parentId: String): DriveEntry =
        decode(send(listOf("drive", "entries", id), HttpMethod.PATCH, buildJsonObject { put("parentId", parentId) }), DriveEntry.serializer())

    /** Move to Trash; answers the group, which Undo restores. */
    suspend fun moveToTrash(id: String): DriveTrashed =
        decode(send(listOf("drive", "entries", id), HttpMethod.DELETE), DriveTrashed.serializer())

    /** Every group in Trash, newest first. */
    suspend fun trash(): List<DriveTrashGroup> {
        var cursor: String? = null
        val groups = mutableListOf<DriveTrashGroup>()
        do {
            val page = decode(get(listOf("drive", "trash"), listOfNotNull("limit" to "200", cursor?.let { "cursor" to it })),
                DriveTrashPage.serializer())
            groups += page.groups
            cursor = page.nextCursor
        } while (cursor != null)
        return groups
    }

    suspend fun restoreGroup(groupId: String): DriveRestored =
        decode(send(listOf("drive", "trash", "groups", groupId, "restore"), HttpMethod.POST), DriveRestored.serializer())

    /** One item of a group back, and what hangs under it, leaving the rest in Trash (rule 3). */
    suspend fun restoreItem(groupId: String, entryId: String): DriveRestored =
        decode(send(listOf("drive", "trash", "groups", groupId, "items", entryId, "restore"), HttpMethod.POST), DriveRestored.serializer())

    /** Delete a group for good. */
    suspend fun deleteGroup(groupId: String) { send(listOf("drive", "trash", "groups", groupId), HttpMethod.DELETE) }

    suspend fun emptyTrash() { send(listOf("drive", "trash"), HttpMethod.DELETE) }

    /** A replaced version back as the file's current one, or as a copy beside it. */
    suspend fun restoreVersion(versionId: String, asCopy: Boolean): DriveEntry =
        decode(send(listOf("drive", "versions", versionId, "restore"), HttpMethod.POST,
            buildJsonObject { put("as", if (asCopy) "COPY" else "CURRENT") }), DriveEntry.serializer())

    /** The secret scan before sharing (§9): warns, never blocks. */
    suspend fun shareCheck(fileId: String): DriveShareCheck =
        decode(send(listOf("drive", "entries", fileId, "share-check"), HttpMethod.POST), DriveShareCheck.serializer())

    /** Share the file's current version, or move its link there. */
    suspend fun share(fileId: String): DriveShareAnswer =
        decode(send(listOf("share-links"), HttpMethod.POST, buildJsonObject { put("kind", "DRIVE_FILE"); put("driveEntryId", fileId) }),
            DriveShareAnswer.serializer())

    /** The drive files' links that have not ended; a row of another kind, or one this build cannot read, is skipped. */
    suspend fun shareLinks(): List<DriveShareLink> {
        val rows = ((parse(get(listOf("share-links"), listOf("kind" to "DRIVE_FILE"))) as? JsonObject)?.get("links") as? JsonArray).orEmpty()
        return rows.mapNotNull { row -> runCatching { Wire.json.decodeFromJsonElement(DriveShareLink.serializer(), row) }.getOrNull() }
            .filter { it.kind == "DRIVE_FILE" && it.state != "ENDED" }
    }

    suspend fun stopSharing(linkId: String) { send(listOf("share-links", linkId), HttpMethod.DELETE) }

    /** The drive's share of the account and the rest (Storage). */
    suspend fun usage(): DriveUsage = decode(get(listOf("drive", "usage")), DriveUsage.serializer())

    /** What the account keeps besides, by project, task and week (Storage's other lists). */
    suspend fun storageUsage(): StorageUsage = decode(get(listOf("attachments", "usage")), StorageUsage.serializer())

    /** Agents' directory syncs: running ones and those ended in the last day. */
    suspend fun syncs(): List<DriveSync> = decode(get(listOf("drive", "syncs")), DriveSyncList.serializer()).syncs

    /** A session's title, for "Agent in <session>"; null when it cannot be read. */
    suspend fun sessionTitle(id: String): String? = runCatching {
        ((parse(get(listOf("sessions", id))) as? JsonObject)?.get("title") as? JsonPrimitive)?.takeIf { it.isString }?.content
    }.getOrNull()

    /** The first [maxBytes] of a file (or one version) for a preview, or all of it when null — up to [limit]. Never a download. */
    suspend fun content(id: String, version: Boolean = false, maxBytes: Int? = null, limit: Long = 64L * 1024 * 1024): ByteArray =
        api.request(handle, ApiRequest(listOf("drive", if (version) "versions" else "entries", id, "content"),
            maxResponseBytes = limit, callTimeoutSeconds = 300,
            headers = listOfNotNull(maxBytes?.let { "Range" to "bytes=0-${it - 1}" }))).requireSuccess().body

    /** A short-lived path under the server (`/api/drive/dl/…`) that downloads the current version (or [versionId]) with no login
     * header, so the system's download manager streams it to disk however large the file is (D12). */
    suspend fun downloadLink(fileId: String, versionId: String? = null): DriveDownloadLink =
        decode(send(listOf("drive", "entries", fileId, "download-link"), HttpMethod.POST,
            buildJsonObject { versionId?.let { put("versionId", it) } }), DriveDownloadLink.serializer())

    // Resumable uploads: open, send chunks of at most `chunkSize`, complete.

    override suspend fun openUpload(parentId: String?, name: String, size: Long, relativePath: String?, dropRootId: String?): DriveUploadOpened =
        decode(send(listOf("drive", "uploads"), HttpMethod.POST, buildJsonObject {
            parentId?.let { put("parentId", it) }
            put("name", name)
            put("size", size)
            relativePath?.let { put("relativePath", it) }
            dropRootId?.let { put("dropRootId", it) }
        }), DriveUploadOpened.serializer())

    override suspend fun uploadStatus(uploadId: String): DriveUploadStatus =
        decode(get(listOf("drive", "uploads", uploadId)), DriveUploadStatus.serializer())

    /** One chunk as the raw body, with its sha256; sent again, it replaces. */
    override suspend fun putChunk(uploadId: String, index: Int, bytes: ByteArray, sha256: String) {
        api.request(handle, ApiRequest(listOf("drive", "uploads", uploadId, "chunks", index.toString()), HttpMethod.PUT, body = bytes,
            contentType = "application/octet-stream", callTimeoutSeconds = 600, readTimeoutSeconds = 120,
            headers = listOf("X-Orbit-Chunk-Sha256" to sha256))).requireSuccess()
    }

    /** Create the file; sent again after it applied, it answers the same file. */
    override suspend fun completeUpload(uploadId: String): DriveEntry =
        decode(send(listOf("drive", "uploads", uploadId, "complete"), HttpMethod.POST), DriveEntry.serializer())

    override suspend fun abandonUpload(uploadId: String) { send(listOf("drive", "uploads", uploadId), HttpMethod.DELETE) }

    private suspend fun get(path: List<String>, query: List<Pair<String, String>> = emptyList()): ApiResponse =
        api.request(handle, ApiRequest(path, query = query)).requireSuccess()

    private suspend fun send(path: List<String>, method: HttpMethod, body: JsonObject? = null): ApiResponse =
        api.request(handle, ApiRequest(path, method, body = body?.toString()?.encodeToByteArray())).requireSuccess()

    private fun parse(response: ApiResponse): JsonElement =
        runCatching { Wire.json.parseToJsonElement(response.body.decodeToString()) }.getOrDefault(JsonNull)

    private fun <T> decode(response: ApiResponse, serializer: DeserializationStrategy<T>): T = Wire.decode(response.body, serializer)
}
