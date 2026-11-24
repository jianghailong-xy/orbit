package io.orbitd.android.core.drive

import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.temporal.ChronoUnit
import java.util.Locale
import kotlin.math.roundToLong

/**
 * How the Drive pages read (board docs/mocks/drive/04-android, with 01-ios for what it does not draw): the switch, sizes and
 * dates, who wrote a file, which preview a file gets, Trash's groups, Storage's rows, the uploads sheet's lines and the upload
 * notification. The twin of OrbitKit's DriveLogic.swift (the Mac and the phone), so every client says it the same way; the
 * Android board's own wording (rows, the notification, Trash's lines) is added here.
 */
object DriveLogic {

    // ---- the switch

    /** Whether the drawer has a Drive row. [enabled] is `documents.enabled` once the capabilities read has finished; [failed] the
     * read failed. A server from before the switch omits it, and a failed read says nothing: both read as on. Only a server that says
     * `documents.enabled == false` hides it. Until the read finishes the row stays out ([read] false), rather than flashing in and out. */
    fun shown(read: Boolean, enabled: Boolean?, failed: Boolean = false): Boolean = read && (failed || enabled != false)

    // ---- words

    const val TITLE = "Drive"
    const val TRASH = "Trash"
    const val STORAGE = "Storage"
    const val UPLOAD = "Upload"
    const val UPLOADS = "Uploads"
    const val NEW_FOLDER = "New folder"
    const val SEARCH = "Search Drive"
    /** Rule 6: an agent wrote it and its session could not be checked — no link, since there is none to follow. */
    const val UNCHECKED_AGENT = "An agent on Orbit Cloud"
    const val YOU = "You"

    private fun count(n: Long): String = String.format(Locale.US, "%,d", n)

    /** "1 item", "18 items". */
    fun items(n: Int): String = "${count(n.toLong())} ${if (n == 1) "item" else "items"}"

    /** "1 file", "30 files". */
    fun files(n: Int): String = "${count(n.toLong())} ${if (n == 1) "file" else "files"}"

    private fun plural(n: Int, one: String, many: String) = "${count(n.toLong())} ${if (n == 1) one else many}"

    // ---- sizes and dates

    private val units = listOf("B", "KB", "MB", "GB", "TB")

    /** "1.2 MB", "18 KB", "212 MB", "3 KB": counted in thousands, one decimal under ten, none above (the web's `formatSize`). */
    fun formatSize(bytes: Long): String {
        var value = bytes.toDouble()
        var unit = 0
        while (value >= 1000 && unit < units.size - 1) { value /= 1000; unit++ }
        if (unit == 0) return "$bytes B"
        if (value < 10) {
            val tenths = Math.round(value * 10) / 10.0
            if (tenths >= 10) return "10 ${units[unit]}"
            val text = String.format(Locale.US, "%.1f", tenths)
            return "${text.removeSuffix(".0")} ${units[unit]}"
        }
        return "${Math.round(value)} ${units[unit]}"
    }

    /** A transfer's speed: "12 MB/s". */
    fun rate(bytesPerSecond: Double): String = "${formatSize(bytesPerSecond.toLong())}/s"

    /** "under a minute left", "about 2 min left". */
    fun timeLeft(bytesLeft: Long, rate: Double?): String? {
        if (rate == null || rate <= 0) return null
        val seconds = maxOf(0L, bytesLeft) / rate
        if (seconds < 60) return "under a minute left"
        return "about ${(seconds / 60).roundToLong()} min left"
    }

    /** An ISO-8601 time as the server writes it, with or without fractional seconds. */
    fun instant(iso: String?): Instant? = iso?.let { runCatching { Instant.parse(it) }.getOrNull() }

    private enum class Day { TODAY, YESTERDAY, THIS_YEAR, EARLIER }

    private fun day(at: Instant, now: Instant, zone: ZoneId): Day {
        val a = at.atZone(zone).toLocalDate()
        val n = now.atZone(zone).toLocalDate()
        val days = ChronoUnit.DAYS.between(a, n)
        return when {
            days == 0L -> Day.TODAY
            days == 1L -> Day.YESTERDAY
            a.year == n.year -> Day.THIS_YEAR
            else -> Day.EARLIER
        }
    }

    private fun fmt(pattern: String, at: Instant, zone: ZoneId) = DateTimeFormatter.ofPattern(pattern, Locale.US).format(at.atZone(zone))

    /** A file row's time: "14:02" today, "yesterday", "Nov 16" this year, "Nov 16, 2025" before. */
    fun formatWhen(iso: String?, now: Instant = Instant.now(), zone: ZoneId = ZoneId.systemDefault()): String {
        val at = instant(iso) ?: return ""
        return when (day(at, now, zone)) {
            Day.TODAY -> fmt("HH:mm", at, zone)
            Day.YESTERDAY -> "yesterday"
            Day.THIS_YEAR -> fmt("MMM d", at, zone)
            Day.EARLIER -> fmt("MMM d, yyyy", at, zone)
        }
    }

    /** A folder row's and a Trash group's time: "today 14:02", "yesterday 09:12", "Nov 16", "Nov 16, 2025". */
    fun formatWhenLong(iso: String?, now: Instant = Instant.now(), zone: ZoneId = ZoneId.systemDefault()): String {
        val at = instant(iso) ?: return ""
        val clock = fmt("HH:mm", at, zone)
        return when (day(at, now, zone)) {
            Day.TODAY -> "today $clock"
            Day.YESTERDAY -> "yesterday $clock"
            Day.THIS_YEAR -> fmt("MMM d", at, zone)
            Day.EARLIER -> fmt("MMM d, yyyy", at, zone)
        }
    }

    // ---- a folder

    /** Names compared as a file manager orders them: "file2" before "file10", case aside. */
    fun compareNames(a: String, b: String): Int {
        var i = 0
        var j = 0
        while (i < a.length && j < b.length) {
            val ca = a[i]
            val cb = b[j]
            if (ca.isDigit() && cb.isDigit()) {
                var ei = i; while (ei < a.length && a[ei].isDigit()) ei++
                var ej = j; while (ej < b.length && b[ej].isDigit()) ej++
                val na = a.substring(i, ei).trimStart('0')
                val nb = b.substring(j, ej).trimStart('0')
                if (na.length != nb.length) return na.length - nb.length
                val c = na.compareTo(nb)
                if (c != 0) return c
                i = ei; j = ej
            } else {
                val c = ca.lowercaseChar().compareTo(cb.lowercaseChar())
                if (c != 0) return c
                i++; j++
            }
        }
        return (a.length - i) - (b.length - j)
    }

    /** Folders first, then files, each by name as a file manager orders them. */
    fun sorted(entries: List<DriveEntry>): List<DriveEntry> = entries.sortedWith { a, b ->
        if (a.isFolder != b.isFolder) (if (a.isFolder) -1 else 1)
        else compareNames(a.name, b.name).takeIf { it != 0 } ?: a.id.compareTo(b.id)
    }

    /** A folder's name in the bar: the drive's root is "Drive". */
    fun folderTitle(folder: DriveEntry?): String = if (folder == null || folder.parentId == null) TITLE else folder.name

    /** "Orbit UI migration": the folder a path ends in; the drive's root (`/`) is "Drive". */
    fun folderLabel(path: String): String = path.split("/").lastOrNull { it.isNotEmpty() } ?: TITLE

    /** The trail under the bar: "Drive › Orbit UI migration". */
    fun crumb(names: List<String>): String = (listOf(TITLE) + names).joinToString(" › ")

    /** A search result's folder: "Drive", "Drive/a/b". */
    fun searchFolder(folderPath: String?): String =
        if (folderPath.isNullOrEmpty() || folderPath == "/") TITLE else "Drive" + (if (folderPath.startsWith("/")) folderPath else "/$folderPath")

    /** A folder row's line: "14 items · today 14:02", or the time alone until its count is read. */
    fun folderLine(entry: DriveEntry, count: Int?, now: Instant = Instant.now(), zone: ZoneId = ZoneId.systemDefault()): String =
        listOfNotNull(count?.let(::items), formatWhenLong(entry.updatedAt.ifEmpty { entry.mtime }, now, zone).takeIf { it.isNotEmpty() })
            .joinToString(" · ")

    /** A file row's line: "Agent in Redesign the sign-in page · 14:02", "You · Nov 16". */
    fun fileLine(writer: String, entry: DriveEntry, now: Instant = Instant.now(), zone: ZoneId = ZoneId.systemDefault()): String =
        listOf(writer, formatWhen(entry.lastWriter.at ?: entry.updatedAt.ifEmpty { entry.mtime }, now, zone)).filter { it.isNotEmpty() }
            .joinToString(" · ")

    // ---- who wrote it (§3.6, rule 6)

    /** Who last wrote a file: "You"; "Agent in <session title>" where the session was checked (the row links to it); otherwise "An agent
     * on Orbit Cloud". [sessionTitle] is the session's title once read, null before. */
    fun writerText(writer: DriveWriter, sessionTitle: String? = null): String {
        if (writer.isOwner) return YOU
        if (writer.sessionId == null) return UNCHECKED_AGENT
        return sessionTitle?.let(::firstLine)?.let { "Agent in $it" } ?: "Agent in a session"
    }

    /** The session a writer's name opens, or null where there is none to follow. */
    fun writerSession(writer: DriveWriter): String? = if (writer.isOwner) null else writer.sessionId

    /** The part of [writerText] that links: the session's title after "Agent in ". */
    const val AGENT_IN = "Agent in "

    /** A session title's first line, trimmed; null when that leaves nothing. */
    fun firstLine(title: String): String? = title.lineSequence().firstOrNull()?.trim()?.takeIf { it.isNotEmpty() }

    // ---- previews

    enum class Preview { PICTURE, MARKDOWN, TEXT, PDF, NONE }

    /** A Markdown, text or code preview reads at most this much of the file. */
    const val TEXT_PREVIEW_BYTES = 1024 * 1024
    /** A picture is read whole up to this size; a bigger one is downloaded rather than drawn. */
    const val PICTURE_PREVIEW_BYTES = 30L * 1024 * 1024

    fun ext(name: String): String {
        val dot = name.lastIndexOf('.')
        return if (dot <= 0) "" else name.substring(dot + 1).lowercase()
    }

    private val pictures = setOf("png", "jpg", "jpeg", "gif", "webp", "heic", "heif", "bmp", "ico")
    private val texts = ("txt text log csv tsv json jsonl ndjson yaml yml toml ini cfg conf env properties xml sql sh bash zsh ps1 " +
        "py rb go rs ts tsx js jsx mjs cjs css scss less swift kt kts java c h cc cpp hpp cs php lua r pl " +
        "diff patch gitignore dockerfile makefile graphql proto tex rst srt vtt html htm").split(" ").toSet()

    /** Which preview a file gets, by its name and size (the store answers every file as bytes). */
    fun preview(name: String, size: Long): Preview {
        val e = ext(name)
        return when {
            e in pictures -> if (size <= PICTURE_PREVIEW_BYTES) Preview.PICTURE else Preview.NONE
            e == "pdf" -> Preview.PDF
            e == "md" || e == "markdown" -> Preview.MARKDOWN
            e in texts || name.lowercase() in texts -> Preview.TEXT
            else -> Preview.NONE
        }
    }

    /** How many bytes a preview reads: all of a picture, the start of a text. */
    fun previewBytes(preview: Preview, size: Long): Int? = when (preview) {
        Preview.MARKDOWN, Preview.TEXT -> if (size > TEXT_PREVIEW_BYTES) TEXT_PREVIEW_BYTES else null
        else -> null
    }

    /** The icon a row draws for an entry. */
    enum class Icon { FOLDER, PICTURE, MARKDOWN, TEXT, TABLE, PDF, ARCHIVE, VIDEO, AUDIO, FILE }

    fun icon(entry: DriveEntry): Icon = if (entry.isFolder) Icon.FOLDER else icon(entry.name)

    fun icon(name: String): Icon {
        val e = ext(name)
        return when {
            e in pictures -> Icon.PICTURE
            e == "md" || e == "markdown" -> Icon.MARKDOWN
            e == "csv" || e == "tsv" || e == "xlsx" || e == "xls" -> Icon.TABLE
            e == "pdf" -> Icon.PDF
            e in setOf("zip", "gz", "tgz", "tar", "7z", "rar") -> Icon.ARCHIVE
            e in setOf("mov", "mp4", "m4v", "webm", "avi", "mkv") -> Icon.VIDEO
            e in setOf("mp3", "wav", "m4a", "aac", "flac") -> Icon.AUDIO
            e in texts -> Icon.TEXT
            else -> Icon.FILE
        }
    }

    /** A picture preview's line: "PNG · 1.2 MB · 1179 × 2556 · Orbit UI migration". */
    fun infoLine(entry: DriveEntry, folder: String?, width: Int? = null, height: Int? = null): String {
        val e = ext(entry.name)
        return listOfNotNull(e.uppercase().takeIf { it.isNotEmpty() }, formatSize(entry.sizeBytes),
            if (width != null && height != null && width > 0 && height > 0) "$width × $height" else null, folder).joinToString(" · ")
    }

    /** The preview's writer card: "Last written today 14:02". */
    fun lastWritten(entry: DriveEntry, now: Instant = Instant.now(), zone: ZoneId = ZoneId.systemDefault()): String =
        "Last written ${formatWhenLong(entry.lastWriter.at ?: entry.updatedAt, now, zone)}"

    const val EARLIER_VERSIONS = "Earlier versions"

    /** The Earlier versions row's count: "None", "1 in Trash", "2 in Trash". */
    fun earlierVersions(count: Int): String = if (count == 0) "None" else "${count(count.toLong())} in Trash"

    const val RESTORED_AS_CURRENT = "Restored as the current version"
    const val RESTORED_AS_COPY = "Restored as a copy"
    const val NO_PREVIEW = "No preview for this kind of file."
    const val PREVIEW_FAILED = "Couldn't read this file."
    const val OPEN_WITH = "Open with…"
    const val DOWNLOAD = "Download"
    const val SEND_A_COPY = "Send a copy…"
    const val SHARE_LINK = "Share link…"
    const val RENAME = "Rename"
    const val MOVE_TO = "Move to…"
    const val MOVE_TO_TRASH = "Move to Trash"
    /** Only the start of a long text is shown. */
    fun previewCut(bytes: Int) = "Showing the first ${formatSize(bytes.toLong())}. Download the file to read all of it."

    // ---- rename, new folder, move

    /** A name the server will take: not empty, no slash, not "." or "..". Null when it is fine, else why not. */
    fun nameProblem(name: String): String? {
        val trimmed = name.trim()
        return when {
            trimmed.isEmpty() -> "A name can't be empty."
            "/" in trimmed -> "A name can't contain “/”."
            trimmed == "." || trimmed == ".." -> "That name is taken by the system."
            else -> null
        }
    }

    /** Whether [entry] may go into [folderId]: not into itself, not where it already is, and not into a folder under it
     * ([ancestorsOfTarget] are the target's folders from the root down, as ids). */
    fun canMove(entry: DriveEntry, folderId: String, ancestorsOfTarget: List<String>, same: (String?, String?) -> Boolean = { a, b -> a == b }): Boolean {
        if (same(entry.id, folderId) || same(entry.parentId, folderId)) return false
        if (entry.isFolder && ancestorsOfTarget.any { same(it, entry.id) }) return false
        return true
    }

    /** The Move dialog's title: Move "migration-notes.md". */
    fun moveTitle(name: String) = "Move “$name”"
    /** Its button: "Move to Notes", "Move here" at the folder the file already sits in. */
    fun moveButton(folder: String) = "Move to $folder"

    /** The snackbar after a move. */
    fun moved(name: String, folder: String) = "Moved $name to $folder"

    /** The snackbar after Move to Trash, with Undo (D6). */
    fun movedToTrash(name: String) = "Moved $name to Trash"
    const val UNDO = "Undo"
    fun renamed(name: String) = "Renamed to $name"
    fun downloading(name: String) = "Downloading $name"
    fun failedTo(what: String) = "Couldn't $what"

    // ---- share (D18, §9)

    /** "an AWS access key id" → "An AWS access key id". */
    fun shapeLabel(kind: String): String = kind.replaceFirstChar { it.uppercase() }

    fun shareTitle(name: String) = "Share a link to “$name”?"
    const val SHARE_DESCRIPTION = "Anyone with the link can view and download this one file without signing in."
    const val SECRETS_HEADING = "This file looks like it holds secrets"
    const val SECRETS_FOOT = "Anyone with the link could read them. You can still share it."
    const val SHARE_ANYWAY = "Share anyway"
    const val CHECKING = "Checking the file for secrets…"
    const val MAKING = "Making the link…"
    const val STOP_SHARING = "Stop sharing"
    const val COPY_LINK = "Copy"
    const val LINK_COPIED = "Link copied"
    const val SHARED_TITLE = "Anyone with this link can view this file"
    const val SHARED_EARLIER = "The link shows an earlier version. Share again to move it to this one."
    const val LINK_STOPPED = "The link no longer works."

    /** "line 14". */
    fun warningLine(warning: DriveShareWarning) = if (warning.line > 0) "line ${warning.line}" else ""

    /** Said whenever the scan stopped before the end of the file (25 MiB or 20 s). */
    fun partialNote(checkedBytes: Long) = "Only the first ${formatSize(checkedBytes)} of this file was checked for secrets."

    /** `<server>/s/<token>`, the address a visitor opens. */
    fun publicUrl(link: DriveShareLink, base: String): String = base.trimEnd('/') + "/s/" + link.token

    // ---- Trash (D6, D11, D17, rule 3)

    /** A group's heading: "Orbit UI migration · today 14:20". */
    fun groupHeading(group: DriveTrashGroup, now: Instant = Instant.now(), zone: ZoneId = ZoneId.systemDefault()): String =
        "${folderLabel(group.folderPath)} · ${formatWhenLong(group.createdAt, now, zone)}"

    private fun lowerWho(writer: String) = if (writer == YOU) "you" else if (writer == UNCHECKED_AGENT) "an agent on Orbit Cloud" else writer

    /** A Trash row's line: "Folder · 18 items · 46 MB · by an agent on Orbit Cloud", "Deleted by you". [writer] is the actor's name as
     * [writerText] says it. A group's counts take in everything it marked, the folder itself too: a folder deleted alone reads them as
     * its own. */
    fun trashLine(entry: DriveEntry, group: DriveTrashGroup, writer: String): String {
        if (!entry.isFolder) return "Deleted by ${lowerWho(writer)}"
        val alone = group.items.size == 1
        return listOfNotNull("Folder", if (alone) items(maxOf(0, group.itemCount - 1)) else null,
            if (alone && group.sizeBytes > 0) formatSize(group.sizeBytes) else null, "by ${lowerWho(writer)}").joinToString(" · ")
    }

    fun versionLine(group: DriveTrashGroup, writer: String, now: Instant = Instant.now(), zone: ZoneId = ZoneId.systemDefault()): String =
        "Earlier version · replaced ${formatWhen(group.createdAt, now, zone)} by ${lowerWho(writer)}"

    /** The Trash header: "23 items · 2.6 GB · kept until you empty it". */
    fun trashSummary(groups: List<DriveTrashGroup>): String =
        "${items(groups.sumOf { it.itemCount })} · ${formatSize(groups.sumOf { it.sizeBytes })} · kept until you empty it"

    const val EMPTY = "Empty"
    const val EMPTY_TRASH = "Empty Trash"
    const val RESTORE = "Restore"
    const val RESTORE_ALL = "Restore all"
    const val RESTORE_AS_COPY = "Restore as a copy"
    const val DELETE_FOR_GOOD = "Delete for good"
    const val TRASH_EMPTY = "Trash is empty."
    const val TRASH_FOOT = "Only you see Trash; agents do not. Everything here counts toward Storage until you empty it. " +
        "A restore whose name is taken gets a suffix."
    const val ENDS_A_SHARE_LINK = "This ends a share link."

    /** The question before deleting a group for good. */
    fun deleteForGoodMessage(group: DriveTrashGroup): String {
        val what = group.version?.let { "This earlier version of ${it.entry.name} is deleted for good." }
            ?: "${items(group.itemCount)} from ${folderLabel(group.folderPath)} ${if (group.itemCount == 1) "is" else "are"} deleted for good."
        return "$what This can't be undone."
    }

    /** The question before Empty Trash. */
    fun emptyTrashMessage(groups: List<DriveTrashGroup>): String {
        val n = groups.sumOf { it.itemCount }
        return "${items(n)} (${formatSize(groups.sumOf { it.sizeBytes })}) ${if (n == 1) "is" else "are"} deleted for good. This can't be undone."
    }

    /** The snackbar after a restore: "Restored 18 items to Orbit UI migration", "Restored brief.md to Drive". */
    fun restored(what: String, group: DriveTrashGroup) = "Restored $what to ${folderLabel(group.folderPath)}"

    /** Whether deleting a group for good ends a file's link (§9). */
    fun groupEndsALink(group: DriveTrashGroup, links: List<DriveShareLink>, same: (String?, String?) -> Boolean = { a, b -> a == b }): Boolean {
        group.version?.let { version -> return links.any { same(it.root.id, version.entryId) && !it.root.pinnedIsCurrent } }
        return links.any { link -> group.items.any { same(it.id, link.root.id) } }
    }

    // ---- Storage (D13, D19)

    /** One bar of the Storage total, by what it holds, as fractions of the account's total. */
    data class StorageBar(val drive: Double, val trash: Double, val other: Double)

    fun storageBar(usage: DriveUsage): StorageBar {
        val total = maxOf(usage.totalBytes, 1L).toDouble()
        val trash = minOf(usage.trashBytes, usage.driveBytes).toDouble()
        return StorageBar(usage.driveBytes / total - trash / total, trash / total, usage.otherBytes / total)
    }

    /** Storage's sizes, as the web's Storage page writes them (`formatFileSize`, in 1024s). */
    fun storageSize(bytes: Long): String {
        if (bytes < 1024) return "$bytes B"
        if (bytes < 1024 * 1024) return "${(bytes + 512) / 1024} KB"
        fun tenths(unit: Long): String {
            val t = (bytes * 10 + unit / 2) / unit
            return "${t / 10}.${t % 10}"
        }
        if (bytes < 1024L * 1024 * 1024) return "${tenths(1024L * 1024)} MB"
        return "${tenths(1024L * 1024 * 1024)} GB"
    }

    const val IN_THIS_ACCOUNT = "in this account"

    /** The legend under the bar: "Drive 10.9 GB", "Trash 1.3 GB", "Other 6.2 GB". */
    fun storageLegend(usage: DriveUsage): List<String> = listOf(
        "Drive ${storageSize(maxOf(0L, usage.driveBytes - usage.trashBytes))}",
        "Trash ${storageSize(usage.trashBytes)}",
        "Other ${storageSize(usage.otherBytes)}")

    /** What the drive's store says when it is nearly full, or null. */
    fun storeWarning(usage: DriveUsage): String? {
        val used = usage.storeUsedBytes ?: return null
        val quota = usage.storeQuotaBytes ?: return null
        if (usage.nearQuota != true || quota <= 0) return null
        if (used >= quota) return "The drive's storage is full. Ask the operator to raise the limit."
        return "Drive storage is ${used * 100 / quota}% full. Uploads stop at 100%. Ask the operator to raise the limit."
    }

    const val OTHER_STORAGE = "Other storage"
    const val EVERYTHING_ELSE = "Everything else"
    const val EVERYTHING_ELSE_NOTE = "Conversation pictures, attachments, evidence files and earlier file uploads"
    const val LARGEST_PROJECTS = "Largest projects"
    const val LARGEST_TASKS = "Largest tasks"
    const val ADDED_EACH_WEEK = "Added each week"
    const val STORAGE_FULL_NOTE = "Your storage is full, so new uploads are refused. Older uploads free up room as they expire."

    /** Everything kept besides the drive: "1.8 GB · 1,204 files", or with the quota "1.8 GB of 5 GB · 1,204 files". */
    fun storedValue(usage: StorageUsage): String {
        val size = usage.quotaBytes?.let { "${storageSize(usage.totalBytes)} of ${storageSize(it)}" } ?: storageSize(usage.totalBytes)
        return "$size · ${files(usage.fileCount)}"
    }

    fun storageFull(usage: StorageUsage): Boolean = usage.quotaBytes?.let { usage.totalBytes >= it } ?: false

    /** "Week of Nov 16" from the week's Monday, `YYYY-MM-DD`, read as a day (no zone shift). */
    fun weekLabel(weekStart: String): String = runCatching {
        "Week of " + DateTimeFormatter.ofPattern("MMM d", Locale.US).format(LocalDate.parse(weekStart))
    }.getOrDefault("Week of $weekStart")

    // ---- uploads (board 04-android frames 6, 7 and 13; 01-ios frames 16-18)

    /** What the folder's card and the sheet's heading count: the owner's uploads and the agents' syncs together. */
    data class TrayTotals(val count: Int, val finished: Int, val sentBytes: Long, val totalBytes: Long) {
        val fraction: Double get() = when {
            totalBytes > 0 -> minOf(1.0, sentBytes.toDouble() / totalBytes)
            count == 0 -> 0.0
            else -> finished.toDouble() / count
        }
        val allFinished get() = finished == count
    }

    fun trayTotals(uploads: List<DriveUploadItem>, syncs: List<DriveSync>) = TrayTotals(
        count = uploads.size + syncs.size,
        finished = uploads.count { it.state == DriveUploadState.DONE } + syncs.count { !it.running },
        sentBytes = uploads.sumOf { if (it.state == DriveUploadState.DONE) it.size else it.sentBytes } + syncs.sumOf { it.bytesSent },
        totalBytes = uploads.sumOf { it.size } + syncs.sumOf { it.bytesTotal ?: 0 })

    /** The folder card's words: "Uploading 2 of 3" with "410 MB of 1.7 GB" after it, or once all are in "Uploaded 3 files", "Synced 1
     * folder", "Finished 3 of 3" with nothing after. */
    fun trayTitle(uploads: List<DriveUploadItem>, syncs: List<DriveSync>): Pair<String, String?> {
        val totals = trayTotals(uploads, syncs)
        if (totals.allFinished) {
            return when {
                uploads.isEmpty() -> "Synced ${plural(syncs.size, "folder", "folders")}"
                syncs.isEmpty() -> "Uploaded ${files(totals.finished)}"
                else -> "Finished ${totals.finished} of ${totals.count}"
            } to null
        }
        val position = "Uploading ${minOf(totals.finished + 1, totals.count)} of ${totals.count}"
        return position to (if (totals.totalBytes > 0) "${formatSize(totals.sentBytes)} of ${formatSize(totals.totalBytes)}" else null)
    }

    const val CLEAR_FINISHED = "Clear finished"
    const val SHOW = "Show"
    const val PAUSE = "Pause"
    const val RESUME = "Resume"
    const val CANCEL = "Cancel"
    const val TRY_AGAIN = "Try again"

    /** Where an upload goes, after its arrow: the folder of a picked folder's file, else the folder it was put in. */
    fun uploadDestination(upload: DriveUploadItem): String {
        val relative = upload.relativePath
        if (relative != null && "/" in relative) return relative.split("/").dropLast(1).joinToString("/")
        return upload.parentName
    }

    /** "holiday.mov → Videos". */
    fun uploadTitle(upload: DriveUploadItem) = "${upload.name} → ${uploadDestination(upload)}"

    /** The line under an upload's bar: what it is doing. */
    fun uploadStatus(upload: DriveUploadItem): String {
        val sent = "${formatSize(upload.sentBytes)} of ${formatSize(upload.size)}"
        return when (upload.state) {
            DriveUploadState.QUEUED -> "Waiting · ${formatSize(upload.size)}"
            DriveUploadState.UPLOADING -> listOfNotNull(sent, upload.rate?.let(::rate), timeLeft(upload.size - upload.sentBytes, upload.rate))
                .joinToString(" · ")
            DriveUploadState.PAUSED -> if (upload.error != null) "Connection lost. $sent is kept; it goes on from there." else "Paused · ${upload.percent}%"
            DriveUploadState.FAILED -> upload.error ?: "Couldn't upload"
            DriveUploadState.DONE -> "Uploaded · ${formatSize(upload.size)}"
        }
    }

    /** A row still going up in its folder (board frame 13): "Uploading · 63%". */
    fun uploadingInFolder(upload: DriveUploadItem): String = when (upload.state) {
        DriveUploadState.QUEUED -> "Waiting to upload"
        DriveUploadState.PAUSED -> "Paused · ${upload.percent}%"
        DriveUploadState.FAILED -> upload.error ?: "Couldn't upload"
        else -> "Uploading · ${upload.percent}%"
    }

    /** A sync's row: "out/ → Reports/out". */
    fun syncTitle(sync: DriveSync): String = "${sync.sourceName}/ → ${sync.destPath.trimStart('/')}"

    const val AGENT_SYNC = "Agent sync"
    const val DETAILS = "Details"

    /** A sync's bar, 0…1; null while it is still counting files. */
    fun syncFraction(sync: DriveSync): Double? {
        if (sync.status == "CHECKING") return null
        val total = sync.bytesTotal ?: return 0.0
        return if (total > 0) minOf(1.0, sync.bytesSent.toDouble() / total) else 0.0
    }

    /** Whether a sync ended with files it could not send, which its row marks and Details lists. */
    fun syncHasFailures(sync: DriveSync): Boolean = sync.status == "FAILED" || (sync.status == "DONE" && sync.failedCount > 0)

    /** The line under a sync's bar, or its whole outcome once it ended. [rate] is the bytes a second between the last two reads. */
    fun syncStatus(sync: DriveSync, rate: Double? = null): String = when (sync.status) {
        "CHECKING" -> "Checking files… ${count(sync.filesSeen.toLong())} so far"
        "UPLOADING" -> {
            val left = sync.bytesTotal?.let { timeLeft(it - sync.bytesSent, rate) }
            listOfNotNull("${count(sync.filesDone.toLong())} of ${count((sync.filesTotal ?: 0).toLong())} files · " +
                "${formatSize(sync.bytesSent)} of ${formatSize(sync.bytesTotal ?: 0)}", rate?.let(::rate), left).joinToString(" · ")
        }
        "DONE" -> {
            val trashed = if (sync.filesDeleted > 0) " · ${count(sync.filesDeleted.toLong())} moved to Trash" else ""
            when {
                sync.failedCount > 0 -> "Synced ${files(sync.filesDone)} · ${count(sync.failedCount.toLong())} failed$trashed"
                sync.filesDone == 0 -> "Already up to date · ${files(sync.filesSame)}$trashed"
                else -> "Synced ${files(sync.filesDone)} · ${formatSize(sync.bytesSent)}$trashed"
            }
        }
        "FAILED" -> sync.error ?: "Couldn't sync"
        "STOPPED" -> "Stopped · ${count(sync.filesDone.toLong())} of ${sync.filesTotal?.let { count(it.toLong()) } ?: "?"} files synced"
        else -> sync.status.lowercase().replaceFirstChar { it.uppercase() }
    }

    /** The bytes a second between two reads of the same sync; between two reads that moved nothing the last rate stands. */
    fun syncRate(previous: DriveSync?, previousRate: Double?, now: DriveSync): Double? {
        if (!now.running || previous == null) return null
        val was = instant(previous.updatedAt) ?: return null
        val at = instant(now.updatedAt) ?: return null
        val seconds = (at.toEpochMilli() - was.toEpochMilli()) / 1000.0
        if (seconds > 0 && now.bytesSent > previous.bytesSent) return (now.bytesSent - previous.bytesSent) / seconds
        return if (seconds <= 0) previousRate else null
    }

    /** The Details dialog's heading: "data/ → Datasets". */
    fun syncDetailsTitle(sync: DriveSync) = "${sync.sourceName}/ → ${folderLabel(sync.destPath)}"

    /** Its summary; the session's title is the part that links. */
    fun syncDetailsSummary(sync: DriveSync, zone: ZoneId = ZoneId.systemDefault()): String {
        val at = instant(sync.endedAt ?: sync.updatedAt)?.let { fmt("HH:mm", it, zone) }
        val sb = StringBuilder("Synced ${files(sync.filesDone)}")
        sync.session?.let { sb.append(" from ${it.title}") }
        at?.let { sb.append(" at $it") }
        sb.append(". ")
        if (sync.failedCount > 0) sb.append("${if (sync.failedCount == 1) "1 file" else files(sync.failedCount)} didn't upload. ")
        if (sync.failedCount > 0) sb.append("The other files are in ${folderLabel(sync.destPath)}. ")
        return sb.append("Ask the agent to run the sync again; it only sends what's still missing.").toString()
    }

    const val DIDNT_UPLOAD = "Didn't upload"
    const val DONE = "Done"

    /** "and 12 more", when the server listed fewer failures than it counted. */
    fun syncMoreFailures(sync: DriveSync): String? {
        val more = sync.failedCount - sync.failed.size
        return if (more > 0) "and ${count(more.toLong())} more" else null
    }

    /** "Open Datasets": the button that opens the folder a sync wrote to. */
    fun openFolder(sync: DriveSync) = "Open ${folderLabel(sync.destPath)}"

    // ---- the Upload sheet (board frame 5)

    fun uploadTo(folder: String) = "Upload to $folder"
    const val PICK_FILES = "Files"
    const val PICK_PHOTOS = "Photos and videos"
    const val PICK_FOLDER = "A folder"

    // ---- the background-upload notification (board frame 6)

    const val NOTIFICATION_APP = "Orbit · Drive"
    const val CHANNEL_NAME = "Drive uploads"
    const val CHANNEL_DESCRIPTION = "Shows your uploads to Drive while they run in the background."

    /** What the one ongoing notification says, or null when it should go (nothing is going up or waiting). */
    data class Notice(val title: String, val text: String, val progress: Double?, val paused: Boolean)

    fun notice(uploads: List<DriveUploadItem>): Notice? {
        val live = uploads.filter { it.state != DriveUploadState.DONE && it.state != DriveUploadState.FAILED }
        if (live.isEmpty()) return null
        val going = live.any { it.state == DriveUploadState.UPLOADING || it.state == DriveUploadState.QUEUED }
        if (!going) {
            val first = live.first()
            val lost = live.any { it.error == DriveUploadQueue.CONNECTION_LOST }
            val title = if (live.size == 1) "${first.name} is paused" else "${live.size} uploads are paused"
            val kept = "${formatSize(live.sumOf { it.sentBytes })} of ${formatSize(live.sumOf { it.size })} is kept"
            val text = if (lost) "No connection. $kept; it goes on from there when you're back online." else "$kept. Open Drive to resume."
            return Notice(title, text, null, true)
        }
        // This run's batch: everything not yet cleared, so the count reads "2 of 3" while the third waits.
        val batch = uploads.filter { it.state != DriveUploadState.FAILED }
        val done = batch.count { it.state == DriveUploadState.DONE }
        val folders = batch.map { it.parentName }.distinct()
        val where = if (folders.size == 1) " to ${folders.single()}" else ""
        val sent = batch.sumOf { if (it.state == DriveUploadState.DONE) it.size else it.sentBytes }
        val total = batch.sumOf { it.size }
        val rate = batch.firstOrNull { it.state == DriveUploadState.UPLOADING }?.rate
        val text = listOfNotNull("${formatSize(sent)} of ${formatSize(total)}", timeLeft(total - sent, rate)).joinToString(" · ")
        return Notice("Uploading ${minOf(done + 1, batch.size)} of ${batch.size}$where", text,
            if (total > 0) sent.toDouble() / total else null, false)
    }
}
