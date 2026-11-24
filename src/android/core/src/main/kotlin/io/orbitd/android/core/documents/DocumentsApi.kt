package io.orbitd.android.core.documents

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

/** The calls an upload makes. [DocumentsApi] is the real one; tests answer with a fake. */
interface DocumentsUploadTransport {
    suspend fun openUpload(parentId: String?, name: String, size: Long, relativePath: String?, dropRootId: String?): DocumentsUploadOpened
    suspend fun uploadStatus(uploadId: String): DocumentsUploadStatus
    suspend fun putChunk(uploadId: String, index: Int, bytes: ByteArray, sha256: String)
    suspend fun completeUpload(uploadId: String): DocumentsEntry
    suspend fun abandonUpload(uploadId: String)
}

/**
 * The owner's Documents doors (apiserver documents.controller.ts, prefix `documents`; OrbitKit APIClient's Documents calls). A
 * refusal is the transport's [io.orbitd.android.core.net.ApiError] (a server with Documents off answers 404 DOCUMENTS_DISABLED); an
 * answer this build cannot read is a [ProtocolException].
 */
class DocumentsApi(private val api: OrbitApi, private val handle: SessionHandle) : DocumentsUploadTransport {
    /** `GET /auth/capabilities` → `documents.enabled`: null where the server says nothing (a server from before the switch). */
    suspend fun documentsEnabled(): Boolean? {
        val body = parse(get(listOf("auth", "capabilities"))) as? JsonObject ?: return null
        return ((body["documents"] as? JsonObject)?.get("enabled") as? JsonPrimitive)?.booleanOrNull
    }

    /** Every page of a folder (the root when [parentId] is null): a folder is read whole, a thousand names a page. */
    suspend fun folder(parentId: String?): DocumentsListing {
        var cursor: String? = null
        var listing: DocumentsListing? = null
        do {
            val query = listOfNotNull("limit" to "1000", parentId?.let { "parentId" to it }, cursor?.let { "cursor" to it })
            val page = decode(get(listOf("documents", "entries"), query), DocumentsListing.serializer())
            listing = listing?.let { DocumentsListing(page.folder, it.entries + page.entries, page.nextCursor) } ?: page
            cursor = page.nextCursor
        } while (cursor != null)
        return listing!!
    }

    /** Live entries anywhere in the drive whose name contains [q], each with its folder (the first page, by name). */
    suspend fun search(q: String): DocumentsSearchResult =
        decode(get(listOf("documents", "search"), listOf("q" to q, "limit" to "100")), DocumentsSearchResult.serializer())

    /** One entry, with its `path`. */
    suspend fun entry(id: String): DocumentsEntry = decode(get(listOf("documents", "entries", id)), DocumentsEntry.serializer())

    suspend fun versions(fileId: String): DocumentsVersions =
        decode(get(listOf("documents", "entries", fileId, "versions")), DocumentsVersions.serializer())

    /** A new folder; a name already taken gets a suffix. */
    suspend fun createFolder(parentId: String?, name: String): DocumentsEntry =
        decode(send(listOf("documents", "folders"), HttpMethod.POST, buildJsonObject { parentId?.let { put("parentId", it) }; put("name", name) }),
            DocumentsEntry.serializer())

    /** Rename; a taken name is refused, never overwritten. */
    suspend fun rename(id: String, name: String): DocumentsEntry =
        decode(send(listOf("documents", "entries", id), HttpMethod.PATCH, buildJsonObject { put("name", name) }), DocumentsEntry.serializer())

    suspend fun move(id: String, parentId: String): DocumentsEntry =
        decode(send(listOf("documents", "entries", id), HttpMethod.PATCH, buildJsonObject { put("parentId", parentId) }), DocumentsEntry.serializer())

    /** Move to Trash; answers the group, which Undo restores. */
    suspend fun moveToTrash(id: String): DocumentsTrashed =
        decode(send(listOf("documents", "entries", id), HttpMethod.DELETE), DocumentsTrashed.serializer())

    /** Every group in Trash, newest first. */
    suspend fun trash(): List<DocumentsTrashGroup> {
        var cursor: String? = null
        val groups = mutableListOf<DocumentsTrashGroup>()
        do {
            val page = decode(get(listOf("documents", "trash"), listOfNotNull("limit" to "200", cursor?.let { "cursor" to it })),
                DocumentsTrashPage.serializer())
            groups += page.groups
            cursor = page.nextCursor
        } while (cursor != null)
        return groups
    }

    suspend fun restoreGroup(groupId: String): DocumentsRestored =
        decode(send(listOf("documents", "trash", "groups", groupId, "restore"), HttpMethod.POST), DocumentsRestored.serializer())

    /** One item of a group back, and what hangs under it, leaving the rest in Trash (rule 3). */
    suspend fun restoreItem(groupId: String, entryId: String): DocumentsRestored =
        decode(send(listOf("documents", "trash", "groups", groupId, "items", entryId, "restore"), HttpMethod.POST), DocumentsRestored.serializer())

    /** Delete a group for good. */
    suspend fun deleteGroup(groupId: String) { send(listOf("documents", "trash", "groups", groupId), HttpMethod.DELETE) }

    suspend fun emptyTrash() { send(listOf("documents", "trash"), HttpMethod.DELETE) }

    /** A replaced version back as the file's current one, or as a copy beside it. */
    suspend fun restoreVersion(versionId: String, asCopy: Boolean): DocumentsEntry =
        decode(send(listOf("documents", "versions", versionId, "restore"), HttpMethod.POST,
            buildJsonObject { put("as", if (asCopy) "COPY" else "CURRENT") }), DocumentsEntry.serializer())

    /** The secret scan before sharing (§9): warns, never blocks. */
    suspend fun shareCheck(fileId: String): DocumentsShareCheck =
        decode(send(listOf("documents", "entries", fileId, "share-check"), HttpMethod.POST), DocumentsShareCheck.serializer())

    /** Share the file's current version, or move its link there. */
    suspend fun share(fileId: String): DocumentsShareAnswer =
        decode(send(listOf("share-links"), HttpMethod.POST, buildJsonObject { put("kind", "DRIVE_FILE"); put("driveEntryId", fileId) }),
            DocumentsShareAnswer.serializer())

    /** The drive files' links that have not ended; a row of another kind, or one this build cannot read, is skipped. */
    suspend fun shareLinks(): List<DocumentsShareLink> {
        val rows = ((parse(get(listOf("share-links"), listOf("kind" to "DRIVE_FILE"))) as? JsonObject)?.get("links") as? JsonArray).orEmpty()
        return rows.mapNotNull { row -> runCatching { Wire.json.decodeFromJsonElement(DocumentsShareLink.serializer(), row) }.getOrNull() }
            .filter { it.kind == "DRIVE_FILE" && it.state != "ENDED" }
    }

    suspend fun stopSharing(linkId: String) { send(listOf("share-links", linkId), HttpMethod.DELETE) }

    /** The drive's share of the account and the rest (Storage). */
    suspend fun usage(): DocumentsUsage = decode(get(listOf("documents", "usage")), DocumentsUsage.serializer())

    /** What the account keeps besides, by project, task and week (Storage's other lists). */
    suspend fun storageUsage(): StorageUsage = decode(get(listOf("attachments", "usage")), StorageUsage.serializer())

    /** Agents' directory syncs: running ones and those ended in the last day. */
    suspend fun syncs(): List<DocumentsSync> = decode(get(listOf("documents", "syncs")), DocumentsSyncList.serializer()).syncs

    /** A session's title, for "Agent in <session>"; null when it cannot be read. */
    suspend fun sessionTitle(id: String): String? = runCatching {
        ((parse(get(listOf("sessions", id))) as? JsonObject)?.get("title") as? JsonPrimitive)?.takeIf { it.isString }?.content
    }.getOrNull()

    /** The first [maxBytes] of a file (or one version) for a preview, or all of it when null — up to [limit]. Never a download. */
    suspend fun content(id: String, version: Boolean = false, maxBytes: Int? = null, limit: Long = 64L * 1024 * 1024): ByteArray =
        api.request(handle, ApiRequest(listOf("documents", if (version) "versions" else "entries", id, "content"),
            maxResponseBytes = limit, callTimeoutSeconds = 300,
            headers = listOfNotNull(maxBytes?.let { "Range" to "bytes=0-${it - 1}" }))).requireSuccess().body

    /** A short-lived path under the server (`/api/documents/dl/…`) that downloads the current version (or [versionId]) with no login
     * header, so the system's download manager streams it to disk however large the file is (D12). */
    suspend fun downloadLink(fileId: String, versionId: String? = null): DocumentsDownloadLink =
        decode(send(listOf("documents", "entries", fileId, "download-link"), HttpMethod.POST,
            buildJsonObject { versionId?.let { put("versionId", it) } }), DocumentsDownloadLink.serializer())

    // Resumable uploads: open, send chunks of at most `chunkSize`, complete.

    override suspend fun openUpload(parentId: String?, name: String, size: Long, relativePath: String?, dropRootId: String?): DocumentsUploadOpened =
        decode(send(listOf("documents", "uploads"), HttpMethod.POST, buildJsonObject {
            parentId?.let { put("parentId", it) }
            put("name", name)
            put("size", size)
            relativePath?.let { put("relativePath", it) }
            dropRootId?.let { put("dropRootId", it) }
        }), DocumentsUploadOpened.serializer())

    override suspend fun uploadStatus(uploadId: String): DocumentsUploadStatus =
        decode(get(listOf("documents", "uploads", uploadId)), DocumentsUploadStatus.serializer())

    /** One chunk as the raw body, with its sha256; sent again, it replaces. */
    override suspend fun putChunk(uploadId: String, index: Int, bytes: ByteArray, sha256: String) {
        api.request(handle, ApiRequest(listOf("documents", "uploads", uploadId, "chunks", index.toString()), HttpMethod.PUT, body = bytes,
            contentType = "application/octet-stream", callTimeoutSeconds = 600, readTimeoutSeconds = 120,
            headers = listOf("X-Orbit-Chunk-Sha256" to sha256))).requireSuccess()
    }

    /** Create the file; sent again after it applied, it answers the same file. */
    override suspend fun completeUpload(uploadId: String): DocumentsEntry =
        decode(send(listOf("documents", "uploads", uploadId, "complete"), HttpMethod.POST), DocumentsEntry.serializer())

    override suspend fun abandonUpload(uploadId: String) { send(listOf("documents", "uploads", uploadId), HttpMethod.DELETE) }

    private suspend fun get(path: List<String>, query: List<Pair<String, String>> = emptyList()): ApiResponse =
        api.request(handle, ApiRequest(path, query = query)).requireSuccess()

    private suspend fun send(path: List<String>, method: HttpMethod, body: JsonObject? = null): ApiResponse =
        api.request(handle, ApiRequest(path, method, body = body?.toString()?.encodeToByteArray())).requireSuccess()

    private fun parse(response: ApiResponse): JsonElement =
        runCatching { Wire.json.parseToJsonElement(response.body.decodeToString()) }.getOrDefault(JsonNull)

    private fun <T> decode(response: ApiResponse, serializer: DeserializationStrategy<T>): T = Wire.decode(response.body, serializer)
}
