package io.orbitd.android.core.cards

import io.orbitd.android.core.net.ApiError
import io.orbitd.android.core.net.ApiRequest
import io.orbitd.android.core.net.HttpMethod
import io.orbitd.android.core.protocol.Wire
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/** One file of a version of evidence, as `GET /tasks/:taskId/evidence/:revision/files` lists it: read from rows, so an expired file
 * reads as it always did. When [gone] is true the row itself no longer exists, and only [id], [sha256] and an image's size are left. */
@Serializable
data class EvidenceFile(val id: String, val name: String? = null, val folder: String? = null, val mimeType: String? = null,
    val sizeBytes: Long? = null, val sha256: String? = null, val width: Int? = null, val height: Int? = null,
    val expiredAt: String? = null, val gone: Boolean = false,
    /** When it expires, while nothing holds it. Null while evidence does, and on a file that never expires. */
    val expiresAt: String? = null,
    /** When it was pinned, which keeps it past [expiresAt]. */
    val pinnedAt: String? = null,
    /** Whether it can be pinned: what `file_upload` kept, while its bytes remain. A server older than this field offers no pin. */
    val pinnable: Boolean = false,
    /** What `file_upload --as test-report` kept of it, read on its own: a receipt has no citations, so its page reads its reports off these. */
    val testReport: JsonObject? = null)

/** What a press of the pin answers, either way (`PUT` and `DELETE /attachments/:id/pin`): the three dates it may have moved. */
@Serializable
data class EvidenceFilePinAnswer(val expiresAt: String? = null, val expiredAt: String? = null, val pinnedAt: String? = null)

/** A page of a version's files. The count and the size are the whole list's, whichever page it is. */
@Serializable
data class EvidenceFilePage(val revision: String, val submittedAt: String, val fileCount: Int, val totalBytes: Long,
    val files: List<EvidenceFile>, val nextOffset: Int? = null)

/** The pages read so far of a version's files, as one. */
data class EvidenceFileList(val submittedAt: String, val fileCount: Int, val totalBytes: Long, val files: List<EvidenceFile>, val nextOffset: Int? = null) {
    /** With one file changed, wherever the list holds it. */
    fun updating(id: String, change: (EvidenceFile) -> EvidenceFile) = copy(files = files.map { if (it.id == id) change(it) else it })
    /** A file cited twice is one entry on one page; a later page never draws it again. */
    operator fun plus(page: EvidenceFilePage) = EvidenceFileList(page.submittedAt, page.fileCount, page.totalBytes,
        (files + page.files).distinctBy { it.id }, page.nextOffset)
}

/** What `file_upload --as test-report` kept of a report (apiserver files/test-report.ts). At most twenty names of each kind, so a count
 * may be more than its list. */
@Serializable
data class EvidenceTestReport(val format: String, val total: Int = 0, val passed: Int = 0, val failed: Int = 0, val skipped: Int = 0,
    val durationMs: Double? = null, val failedNames: List<String> = emptyList(), val skippedNames: List<String> = emptyList())

/** The thumbnails the card draws, and how many of the whole list it leaves to count. */
data class EvidenceFilesOnCard(val shown: List<EvidenceFile>, val rest: Int)

/** The files one upload folder holds. */
data class EvidenceFileGroup(val name: String, val files: List<EvidenceFile>)

/**
 * What an evidence card says about the files a version of evidence cites (docs/orbit-files-design.md §2.5, §2.6): the words, and the
 * reading of the rows those words come from. Every word and rule here is the web's `src/web/src/lib/evidenceFiles.ts`, held to it by
 * EvidenceFilesCopyParityTest; the words a phone adds are named below it. The views in `EvidenceFilesViews.kt` draw this and decide nothing.
 *
 * Only a raster image is ever drawn inline: [isPicture] is the one test, and the type list is the web's `userFile.ts` without PDF.
 * Everything else, SVG and HTML included, can only be saved or shared. Nothing here opens a file.
 */
object EvidenceFiles {
    /** The file area's small heading. */
    const val heading = "FILES"
    /** The page the file area opens. */
    const val title = "Evidence files"
    /** After the heading, ahead of the date, once every file has expired. */
    const val expiredHeading = "EXPIRED"
    /** On the grey tile that takes an expired file's picture, ahead of the date. */
    const val expired = "Expired"
    /** The group of the files that were not uploaded in a folder. */
    const val noFolder = "Files"
    /** The viewer's menu, and the verb on a tile that can only be saved. */
    const val download = "Download"
    /** Under a list with more files than the page holds. */
    const val showMore = "Show more"
    /** What a save that failed says. */
    const val downloadFailed = "Couldn't download the file"
    /** What the area says while the list is read, and when it could not be. */
    const val loading = "Reading…"
    const val unread = "The files could not be read just now."
    /** What presses a file's pin, either way. */
    const val pin = "Pin"
    const val unpin = "Unpin"
    /** What a pinned file says of how long it stays, where one with a date says when it expires. */
    const val pinned = "Pinned"
    /** What a press that did not go through says. */
    const val pinFailed = "Couldn't pin the file"
    const val unpinFailed = "Couldn't unpin the file"
    /** The two lists a test report opens into. */
    const val reportFailed = "Failed"
    const val reportSkipped = "Skipped"
    /** How many thumbnails the card draws before it counts the rest. */
    const val shown = 4
    /** How many failed cases the card names; the page names the rest. */
    const val reportNamesShown = 3

    // The words only a phone has: the web saves a file and has no share sheet, and its viewer closes with its own ✕.
    /** What closes the viewer (the board's word). */
    const val done = "Done"
    /** The second thing a tile that can't be drawn can do, beside saving it. */
    const val share = "Share"
    /** What the viewer's button is called, which opens the two. */
    const val saveOrShare = "Download or share"
    /** What a save said when it worked, and what a share that failed says. */
    const val saved = "Saved file"
    const val shareFailed = "Couldn't share the file"
    /** The tile with no picture whose name has no extension to say what it is. */
    private const val anyFile = "FILE"

    /** The types drawn inline: the server's list of what shows without running anything, without its one type that is no picture. */
    val rasterImages = setOf("image/avif", "image/bmp", "image/gif", "image/heic", "image/heif", "image/jpeg", "image/png", "image/tiff",
        "image/vnd.microsoft.icon", "image/webp", "image/x-icon")

    /** The route, a page at a time. */
    fun request(task: String, revision: String, offset: Int = 0) = ApiRequest(listOf("tasks", task, "evidence", revision, "files"),
        query = if (offset > 0) listOf("offset" to "$offset") else emptyList())

    /** Pin a file or take its pin away. A pin brings back a file with a tombstone whose bytes remain, and once they have gone it answers 410. */
    fun pinRequest(id: String, pinned: Boolean) = ApiRequest(listOf("attachments", id, "pin"), if (pinned) HttpMethod.PUT else HttpMethod.DELETE)

    /** `+5`, on the tile after the last thumbnail. */
    fun more(rest: Int) = "+$rest"
    /** `3 of 8`, in the viewer. */
    fun position(position: Int, total: Int) = "$position of $total"
    /** `Download report.html`: what a tile that can only be saved is called. */
    fun downloadName(name: String) = "$download $name"
    /** `2 more`, under the failed names the card shows. */
    fun reportNamesMore(rest: Int) = "$rest more"
    /** `Revision 2`, ahead of when it was submitted. */
    fun revisionLine(revision: String) = "Revision $revision"
    /** `Showing 1000 of 3000 files`, while the list has more than the page holds. */
    fun showing(shown: Int, total: Int) = "Showing $shown of $total files"

    /** Whether this version cites a file. With none, the card is what it has always been. A FILE citation is refused unless it
     * resolves, so one that has stopped resolving is a file that went, and still gets its tile. */
    fun cites(citations: List<JsonObject>) = citations.any { it.text("kind") == "FILE" }

    /** The summaries of the reports this version cites, read off the citations: they outlive the files. */
    fun reports(citations: List<JsonObject>): List<EvidenceTestReport> = citations.mapNotNull { citation ->
        citation.obj("testReport")?.let { runCatching { Wire.json.decodeFromJsonElement(EvidenceTestReport.serializer(), it) }.getOrNull() }
    }

    /** The reports of what a page shows: the citations', and a receipt's, which has none, off the list it has read (the web's `evidenceReportsOf`). */
    fun reports(citations: List<JsonObject>, files: List<EvidenceFile>): List<EvidenceTestReport> =
        reports(citations).ifEmpty { files.mapNotNull { file -> file.testReport?.let { runCatching { Wire.json.decodeFromJsonElement(EvidenceTestReport.serializer(), it) }.getOrNull() } } }

    /** Whether this file is pinned. */
    fun isPinned(file: EvidenceFile) = file.pinnedAt != null
    /** This file after a press of its pin, with what the server answered. */
    fun withPin(file: EvidenceFile, answer: EvidenceFilePinAnswer) = file.copy(expiresAt = answer.expiresAt, expiredAt = answer.expiredAt, pinnedAt = answer.pinnedAt)

    /** What a file is called where one name is needed. */
    fun name(file: EvidenceFile) = file.name ?: file.id
    /** What a saved file is called: the path's last part. */
    fun saveName(file: EvidenceFile) = name(file).substringAfterLast('/')
    /** Whether a file has lost its bytes: it expired, or its row went with them. */
    fun isGone(file: EvidenceFile) = file.gone || file.expiredAt != null
    /** A picture a page may draw inline: a raster image on the list. Never an SVG, a PDF or a page. */
    fun isRasterImage(type: String) = type.substringBefore(';').trim().lowercase(Locale.ROOT) in rasterImages
    /** Whether this file is drawn as a picture. Only a raster image is, and only while it has its bytes. */
    fun isPicture(file: EvidenceFile) = !isGone(file) && file.mimeType?.let(::isRasterImage) == true

    /** The label on a tile with no picture: `HTML`, `JSON`, `FILE`. */
    fun kind(file: EvidenceFile): String {
        val name = if (file.name == null) "" else saveName(file)
        val dot = name.lastIndexOf('.')
        return if (dot > 0) name.substring(dot + 1).uppercase(Locale.ROOT) else anyFile
    }

    /** The thumbnails the card draws: pictures first, so a report does not take a picture's place. */
    fun onCard(list: EvidenceFileList): EvidenceFilesOnCard {
        val (pictures, others) = list.files.partition(::isPicture)
        val shown = (pictures + others).take(shown)
        return EvidenceFilesOnCard(shown, list.fileCount - shown.size)
    }

    /** The files, by the folder they were uploaded in and in the order those first appear. */
    fun groups(files: List<EvidenceFile>): List<EvidenceFileGroup> = files.groupBy { file ->
        val path = name(file)
        val slash = path.lastIndexOf('/')
        if (slash > 0) path.substring(0, slash) else file.folder ?: noFolder
    }.map { (name, grouped) -> EvidenceFileGroup(name, grouped) }

    private fun instant(iso: String?): Instant? = iso?.let { runCatching { Instant.parse(it) }.getOrNull() }

    /** `Dec 2`, with the year when it is not this one. In English whatever the phone reads, as all copy is. */
    fun expiryDate(at: String, now: Instant = Instant.now(), zone: ZoneId = ZoneId.systemDefault()): String? = instant(at)?.atZone(zone)?.let { date ->
        DateTimeFormatter.ofPattern(if (date.year == now.atZone(zone).year) "MMM d" else "MMM d, yyyy", Locale.US).format(date)
    }

    /** `Expires Dec 2`. */
    fun expires(at: String, now: Instant = Instant.now(), zone: ZoneId = ZoneId.systemDefault()) = expiryDate(at, now, zone)?.let { "Expires $it" }

    /** How long a file with its bytes stays: `Pinned`, `Expires Dec 2`, or nothing where evidence holds it or it never expires. */
    fun keep(file: EvidenceFile, now: Instant = Instant.now(), zone: ZoneId = ZoneId.systemDefault()): String? = when {
        isGone(file) -> null
        isPinned(file) -> pinned
        else -> file.expiresAt?.let { expires(it, now, zone) }
    }

    /** `Expired Dec 2`, on one line, or `Expired` from a server that does not say when. */
    fun expiredLine(at: String?, now: Instant = Instant.now(), zone: ZoneId = ZoneId.systemDefault()) =
        listOfNotNull(expired, at?.let { expiryDate(it, now, zone) }).joinToString(" ")

    /** Whether a read of a file was told its bytes have gone (410). Every other failure is what it always was. */
    fun isExpiredRead(failure: Throwable) = (failure as? ApiError)?.status == 410
    /** When they expired, from a server that says. */
    fun expiredAtOf(failure: Throwable) = (((failure as? ApiError)?.body as? JsonObject)?.get("expiredAt") as? JsonPrimitive)?.takeIf { it.isString }?.content

    /** Whether every file has lost its bytes. Only the last page can say so of the whole list. */
    fun allGone(list: EvidenceFileList) = list.nextOffset == null && list.files.isNotEmpty() && list.files.all(::isGone)

    /** The whole list's size, unless nothing that is left can say: a row that went took its size with it. */
    private fun listSize(list: EvidenceFileList) = if (list.totalBytes > 0) listOf(fileSize(list.totalBytes)) else emptyList()

    /** `FILES · 9 · 1.8 MB`, and ` · EXPIRED DEC 2` once all of them have, by the last date. One expired file of nine is its own tile's
     * news. A row that went took its date with it, so a list of those says `EXPIRED` alone. */
    fun headline(list: EvidenceFileList, now: Instant = Instant.now(), zone: ZoneId = ZoneId.systemDefault()): String {
        val line = (listOf(heading, "${list.fileCount}") + listSize(list)).joinToString(" · ")
        if (!allGone(list)) return line
        val last = list.files.mapNotNull { instant(it.expiredAt) }.maxOrNull()?.let { expiryDate(it.toString(), now, zone) }
        return "$line · $expiredHeading" + if (last == null) "" else " ${last.uppercase(Locale.US)}"
    }

    /** `9 files · 1.8 MB`, on the version line of the page. */
    fun count(list: EvidenceFileList) = (listOf("${list.fileCount} ${if (list.fileCount == 1) "file" else "files"}") + listSize(list)).joinToString(" · ")

    /** `214 KB · 780 × 1688 · sha256 3f9a1c07`, with what is known: the picture's own size when the caller has one. */
    fun facts(file: EvidenceFile, width: Int? = null, height: Int? = null) = listOfNotNull(file.sizeBytes?.let(::fileSize),
        if (width != null && width > 0 && height != null && height > 0) "$width × $height" else null,
        file.sha256?.let { "sha256 ${it.take(8)}" }).joinToString(" · ")

    /** The web's `formatFileSize`: `214 KB`, `1.8 MB`. */
    fun fileSize(bytes: Long): String = when {
        bytes < 1024 -> "$bytes B"
        bytes < 1024 * 1024 -> "${Math.round(bytes / 1024.0)} KB"
        else -> String.format(Locale.US, "%.1f MB", bytes / (1024.0 * 1024.0))
    }

    /** `Playwright`, the report's own name. */
    fun reportFormat(report: EvidenceTestReport) = when (report.format) {
        "playwright" -> "Playwright"
        "junit" -> "JUnit"
        else -> report.format
    }
    /** `Playwright report`, heading the page's block. */
    fun reportTitle(report: EvidenceTestReport) = "${reportFormat(report)} report"
    /** `46 passed · 0 failed · 2 skipped`. */
    fun reportCounts(report: EvidenceTestReport) = "${report.passed} passed · ${report.failed} failed · ${report.skipped} skipped"
    /** `46 passed · 0 failed · 2 skipped · 38s`, with how long the run took when the report says. */
    fun reportFacts(report: EvidenceTestReport) = reportCounts(report) + (report.durationMs?.let { " · ${ExceptionCards.checkDuration(it)}" } ?: "")
    /** `Failed · 2`, heading a list whose names may stop short of its count. */
    fun reportList(word: String, count: Int) = "$word · $count"
}
