import Foundation

/// How the Drive page reads (board docs/mocks/drive, 03-mac with 01-ios for what the Mac board does not draw):
/// the switch, sizes and dates, who wrote a file, which preview a file gets, Trash's groups, Storage's rows, and the
/// uploads popover's lines. Mirrors the web's src/web/src/lib/drive.ts, driveSwitch.ts, the upload tray and
/// Trash (src/web/src/components/drive). Shared by the Mac and the phone; every sentence is here so both say it
/// the same way.
public enum DriveLogic {

    // MARK: the switch

    /// Whether the sidebar has a Drive row. `read` is the capabilities read once it has finished: nil while it has
    /// not. A server from before the switch omits `documents`, and a failed read (`.failure`) says nothing: both read as
    /// on. Only a server that says `documents.enabled == false` hides it. Until the read finishes the row stays out,
    /// rather than flashing in and out.
    public static func shown(_ read: Result<ServerCapabilities?, Error>?) -> Bool {
        guard let read else { return false }
        switch read {
        case .success(let capabilities): return capabilities?.documents?.enabled != false
        case .failure: return true
        }
    }

    // MARK: words

    public static let title = "Drive"
    public static let trash = "Trash"
    public static let storage = "Storage"
    /// Rule 6: an agent wrote it and its session could not be checked — no link, since there is none to follow.
    public static let uncheckedAgent = "An agent on Orbit Cloud"
    public static let you = "You"

    /// "1 item", "18 items".
    public static func items(_ n: Int) -> String { "\(n.formatted()) \(n == 1 ? "item" : "items")" }

    /// "1 file", "30 files".
    public static func files(_ n: Int) -> String { "\(n.formatted()) \(n == 1 ? "file" : "files")" }

    private static func plural(_ n: Int, _ one: String, _ many: String) -> String {
        "\(n.formatted()) \(n == 1 ? one : many)"
    }

    // MARK: sizes and dates

    private static let units = ["B", "KB", "MB", "GB", "TB"]

    /// "1.2 MB", "18 KB", "212 MB", "3 KB": counted in thousands, one decimal under ten, none above (the web's
    /// `formatSize`).
    public static func formatSize(_ bytes: Int) -> String {
        var value = Double(bytes)
        var unit = 0
        while value >= 1000 && unit < units.count - 1 {
            value /= 1000
            unit += 1
        }
        if unit == 0 { return "\(bytes) B" }
        if value < 10 {
            let tenths = (value * 10).rounded() / 10
            if tenths >= 10 { return "10 \(units[unit])" }
            let text = String(format: "%.1f", tenths)
            return "\(text.hasSuffix(".0") ? String(text.dropLast(2)) : text) \(units[unit])"
        }
        return "\(Int(value.rounded())) \(units[unit])"
    }

    /// A transfer's speed: "12 MB/s".
    public static func rate(_ bytesPerSecond: Double) -> String { "\(formatSize(Int(bytesPerSecond)))/s" }

    /// "under a minute left", "about 2 min left".
    public static func timeLeft(bytesLeft: Int, rate: Double?) -> String? {
        guard let rate, rate > 0 else { return nil }
        let seconds = Double(max(0, bytesLeft)) / rate
        if seconds < 60 { return "under a minute left" }
        return "about \(Int((seconds / 60).rounded())) min left"
    }

    /// An ISO-8601 time as the server writes it, with or without fractional seconds.
    public static func date(_ iso: String) -> Date? {
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = fractional.date(from: iso) { return date }
        return ISO8601DateFormatter().date(from: iso)
    }

    private static func formatter(_ format: String, _ calendar: Calendar) -> DateFormatter {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.calendar = calendar
        f.timeZone = calendar.timeZone
        f.dateFormat = format
        return f
    }

    private enum Day { case today, yesterday, thisYear, earlier }

    private static func day(_ at: Date, now: Date, calendar: Calendar) -> Day {
        let days = calendar.dateComponents([.day], from: calendar.startOfDay(for: at),
                                           to: calendar.startOfDay(for: now)).day ?? 0
        if days == 0 { return .today }
        if days == 1 { return .yesterday }
        return calendar.component(.year, from: at) == calendar.component(.year, from: now) ? .thisYear : .earlier
    }

    /// The Modified column: "14:02" today, "Yesterday", "Nov 16" this year, "Nov 16, 2025" before.
    public static func formatWhen(_ iso: String, now: Date = Date(), calendar: Calendar = .current) -> String {
        guard let at = date(iso) else { return "" }
        switch day(at, now: now, calendar: calendar) {
        case .today: return formatter("HH:mm", calendar).string(from: at)
        case .yesterday: return "Yesterday"
        case .thisYear: return formatter("MMM d", calendar).string(from: at)
        case .earlier: return formatter("MMM d, yyyy", calendar).string(from: at)
        }
    }

    /// The inspector's Last written and a Trash group's time: "Today 14:02", "Yesterday 09:12", "Nov 16",
    /// "Nov 16, 2025".
    public static func formatWhenLong(_ iso: String, now: Date = Date(), calendar: Calendar = .current) -> String {
        guard let at = date(iso) else { return "" }
        let clock = formatter("HH:mm", calendar).string(from: at)
        switch day(at, now: now, calendar: calendar) {
        case .today: return "Today \(clock)"
        case .yesterday: return "Yesterday \(clock)"
        case .thisYear: return formatter("MMM d", calendar).string(from: at)
        case .earlier: return formatter("MMM d, yyyy", calendar).string(from: at)
        }
    }

    // MARK: a folder

    /// Folders first, then files, each by name as Finder orders them ("file2" before "file10").
    public static func sorted(_ entries: [DriveEntry]) -> [DriveEntry] {
        entries.sorted { a, b in
            if a.isFolder != b.isFolder { return a.isFolder }
            let order = a.name.localizedStandardCompare(b.name)
            return order == .orderedSame ? a.id < b.id : order == .orderedAscending
        }
    }

    /// A folder's name in the window's title: the drive's root is "Drive".
    public static func folderTitle(_ folder: DriveEntry?) -> String {
        guard let folder, folder.parentId != nil else { return title }
        return folder.name
    }

    /// "Orbit UI migration": the folder a path ends in; the drive's root (`/`) is "Drive".
    public static func folderLabel(_ path: String) -> String {
        path.split(separator: "/").last.map(String.init) ?? title
    }

    /// The inspector's Path: `/Drive/a/b/name`.
    public static func displayPath(_ path: String?) -> String? {
        guard let path else { return nil }
        return "/Drive" + (path.hasPrefix("/") ? path : "/" + path)
    }

    /// A search result's folder: "Drive", "Drive/a/b".
    public static func searchFolder(_ folderPath: String?) -> String {
        guard let folderPath, folderPath != "/", !folderPath.isEmpty else { return title }
        return "Drive" + (folderPath.hasPrefix("/") ? folderPath : "/" + folderPath)
    }

    /// The Size column: a file's size, and a folder's count once it is known (the board's "9 items"), else "—".
    public static func sizeColumn(_ entry: DriveEntry, folderCount: Int? = nil) -> String {
        if entry.isFile { return formatSize(entry.sizeBytes) }
        return folderCount.map(items) ?? "—"
    }

    // MARK: who wrote it (§3.6, rule 6)

    /// Who last wrote a file: "You"; "Agent in <session title>" where the session was checked (the row links to it);
    /// otherwise "An agent on Orbit Cloud". `sessionTitle` is the session's title once read, nil before.
    public static func writerText(_ writer: DriveWriter, sessionTitle: String? = nil) -> String {
        if writer.isOwner { return you }
        guard writer.sessionId != nil else { return uncheckedAgent }
        let title = sessionTitle.flatMap(firstLine)
        return title.map { "Agent in \($0)" } ?? "Agent in a session"
    }

    /// The session a writer's name opens, or nil where there is none to follow.
    public static func writerSession(_ writer: DriveWriter) -> String? {
        writer.isOwner ? nil : writer.sessionId
    }

    /// A session title's first line, trimmed; nil when that leaves nothing.
    public static func firstLine(_ title: String) -> String? {
        let line = title.split(separator: "\n", omittingEmptySubsequences: false).first.map(String.init) ?? ""
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        return trimmed.isEmpty ? nil : trimmed
    }

    // MARK: previews

    public enum Preview: Equatable, Sendable {
        case picture
        case markdown
        case text
        case pdf
        /// Nothing to draw: the inspector shows the file's icon.
        case none
    }

    /// A Markdown, text or code preview reads at most this much of the file.
    public static let textPreviewBytes = 1024 * 1024
    /// A picture or PDF preview is read whole up to this size; a bigger one is downloaded rather than drawn.
    public static let picturePreviewBytes = 30 * 1024 * 1024

    private static func ext(_ name: String) -> String {
        guard let dot = name.lastIndex(of: "."), dot > name.startIndex else { return "" }
        return name[name.index(after: dot)...].lowercased()
    }

    private static let pictures: Set<String> = ["png", "jpg", "jpeg", "gif", "webp", "heic", "heif", "tif", "tiff", "bmp", "ico"]
    private static let texts: Set<String> = Set(
        ("txt text log csv tsv json jsonl ndjson yaml yml toml ini cfg conf env properties xml sql sh bash zsh ps1 " +
         "py rb go rs ts tsx js jsx mjs cjs css scss less swift kt kts java c h cc cpp hpp cs php lua r pl " +
         "diff patch gitignore dockerfile makefile graphql proto tex rst srt vtt html htm").split(separator: " ").map(String.init))

    /// Which preview a file gets, by its name and size (the store answers every file as bytes).
    public static func preview(name: String, size: Int) -> Preview {
        let e = ext(name)
        if pictures.contains(e) { return size <= picturePreviewBytes ? .picture : .none }
        if e == "pdf" { return size <= picturePreviewBytes ? .pdf : .none }
        if e == "md" || e == "markdown" { return .markdown }
        if texts.contains(e) || texts.contains(name.lowercased()) { return .text }
        return .none
    }

    /// How many bytes a preview reads: all of a picture or PDF, the start of a text.
    public static func previewBytes(_ preview: Preview, size: Int) -> Int? {
        switch preview {
        case .markdown, .text: return size > textPreviewBytes ? textPreviewBytes : nil
        default: return nil
        }
    }

    /// The SF Symbol a row draws for an entry.
    public static func systemImage(_ entry: DriveEntry) -> String {
        if entry.isFolder { return "folder.fill" }
        switch preview(name: entry.name, size: 0) {
        case .picture: return "photo"
        case .markdown, .text: return "doc.text"
        case .pdf: return "doc.richtext"
        case .none:
            let e = ext(entry.name)
            if ["zip", "gz", "tgz", "tar", "7z", "rar"].contains(e) { return "doc.zipper" }
            if ["mov", "mp4", "m4v", "webm", "avi"].contains(e) { return "film" }
            if ["mp3", "wav", "m4a", "aac", "flac"].contains(e) { return "waveform" }
            return "doc"
        }
    }

    // MARK: inspector

    /// "PNG · 1.2 MB", "Folder".
    public static func kindLine(_ entry: DriveEntry) -> String {
        if entry.isFolder { return "Folder" }
        let e = ext(entry.name)
        return e.isEmpty ? formatSize(entry.sizeBytes) : "\(e.uppercased()) · \(formatSize(entry.sizeBytes))"
    }

    /// The Earlier row: "None", "1 version in Trash", "2 versions in Trash".
    public static func earlierVersions(_ count: Int) -> String {
        count == 0 ? "None" : "\(plural(count, "version", "versions")) in Trash"
    }

    /// The Shared row: the link pins this version, or an earlier one.
    public static func sharedLine(_ link: DriveShareLink) -> String {
        link.root.pinnedIsCurrent ? "This version" : "An earlier version"
    }

    public static let restoredAsCurrent = "Restored as the current version"
    public static let restoredAsCopy = "Restored as a copy"

    // MARK: rename, new folder, move

    public static let newFolderName = "New folder"

    /// A name the server will take: not empty, no slash, not "." or "..". Nil when it is fine, else why not.
    public static func nameProblem(_ name: String) -> String? {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty { return "A name can't be empty." }
        if trimmed.contains("/") { return "A name can't contain “/”." }
        if trimmed == "." || trimmed == ".." { return "That name is taken by the system." }
        return nil
    }

    /// Whether `entry` may go into `folderID`: not into itself, not where it already is, and not into a folder under
    /// it (`ancestorsOfTarget` are the target's folders from the root down, as ids).
    public static func canMove(_ entry: DriveEntry, into folderID: String, ancestorsOfTarget: [String]) -> Bool {
        if entry.id == folderID || entry.parentId == folderID { return false }
        if entry.isFolder && ancestorsOfTarget.contains(entry.id) { return false }
        return true
    }

    /// The toast after a move.
    public static func moved(_ name: String, to folder: String) -> String { "Moved \(name) to \(folder)" }

    public static let movedToTrash = "Moved to Trash"

    // MARK: share (D18, §9)

    /// "an AWS access key id" → "An AWS access key id".
    public static func shapeLabel(_ kind: String) -> String {
        kind.prefix(1).uppercased() + kind.dropFirst()
    }

    public static func shareTitle(_ name: String) -> String { "Share a link to “\(name)”?" }
    public static func shareThisVersionTitle(_ name: String) -> String { "Share this version of “\(name)”?" }
    public static let shareDescription = "Anyone with the link can view and download this one file without signing in."
    public static let shareVersionNote =
        "The link shows the version you share; a later change is shared only when you share that version."
    public static let secretsHeading = "This file looks like it holds secrets"
    public static let secretsFoot = "Anyone with the link could read them. You can still share it."
    public static let shareAnyway = "Share Anyway"
    public static let checking = "Checking the file for secrets…"
    public static let making = "Making the link…"
    public static let stopSharing = "Stop Sharing"
    public static let copyLink = "Copy"
    public static let linkCopied = "Link copied"

    /// Said whenever the scan stopped before the end of the file (25 MiB or 20 s).
    public static func partialNote(_ checkedBytes: Int) -> String {
        "Only the first \(formatSize(checkedBytes)) of this file was checked for secrets."
    }

    /// `<baseURL>/s/<token>`, the address a visitor opens.
    public static func publicURL(_ link: DriveShareLink, base: URL) -> URL {
        base.appendingPathComponent("s").appendingPathComponent(link.token)
    }

    // MARK: Trash (D6, D11, D17, rule 3)

    /// A group's heading: the folder it was deleted from.
    public static func groupTitle(_ group: DriveTrashGroup) -> String { folderLabel(group.folderPath) }

    /// The line under a group's heading: "Today 14:20 · an agent on Orbit Cloud · 18 items", "Today 09:12 · earlier
    /// version". `writer` is the actor's name as `writerText` says it.
    public static func groupSubtitle(_ group: DriveTrashGroup, writer: String, now: Date = Date(),
                                     calendar: Calendar = .current) -> String {
        let when = formatWhenLong(group.createdAt, now: now, calendar: calendar)
        if group.version != nil { return "\(when) · earlier version" }
        let who = writer == you || writer == uncheckedAgent ? writer.prefix(1).lowercased() + writer.dropFirst() : writer
        return "\(when) · \(who) · \(items(group.itemCount))"
    }

    /// The Trash header: "23 items · 2.6 GB".
    public static func trashSummary(_ groups: [DriveTrashGroup]) -> String {
        let count = groups.reduce(0) { $0 + $1.itemCount }
        let bytes = groups.reduce(0) { $0 + $1.sizeBytes }
        return "\(items(count)) · \(formatSize(bytes))"
    }

    public static let trashEmpty = "Trash is empty."
    public static let trashFoot = "Only you see Trash; agents do not. Everything here counts toward Storage until you empty it. " +
        "A restore whose name is taken gets a suffix."
    public static let endsAShareLink = "This ends a share link."

    /// The question before deleting a group for good.
    public static func deleteForGoodMessage(_ group: DriveTrashGroup) -> String {
        let what = group.version.map { "This earlier version of \($0.entry.name) is deleted for good." }
            ?? "\(items(group.itemCount)) from \(folderLabel(group.folderPath)) are deleted for good."
        return "\(what) This can't be undone."
    }

    /// The question before Empty Trash.
    public static func emptyTrashMessage(_ groups: [DriveTrashGroup]) -> String {
        let count = groups.reduce(0) { $0 + $1.itemCount }
        let bytes = groups.reduce(0) { $0 + $1.sizeBytes }
        return "\(items(count)) (\(formatSize(bytes))) are deleted for good. This can't be undone."
    }

    /// The toast after a restore: "Restored 18 items" / "Restored brief.md", with where to.
    public static func restored(_ what: String, group: DriveTrashGroup) -> String {
        "Restored \(what) to \(folderLabel(group.folderPath))"
    }

    /// Whether deleting a group for good ends a file's link (§9). A shared file in Trash has a paused link;
    /// `trashGroupOf` says which group each such file went in.
    public static func groupEndsALink(_ group: DriveTrashGroup, links: [DriveShareLink],
                                      trashGroupOf: [String: String]) -> Bool {
        if let version = group.version {
            return links.contains { $0.root.id == version.entryId && !$0.root.pinnedIsCurrent }
        }
        return links.contains { link in
            trashGroupOf[link.root.id] == group.id || group.items.contains { $0.id == link.root.id }
        }
    }

    // MARK: Storage (D13, D19)

    /// One bar of the Storage total, by what it holds.
    public struct StorageBar: Equatable, Sendable {
        public let drive: Double
        public let trash: Double
        public let other: Double
    }

    /// The total's bar: the drive's live files, its Trash, and everything else, as fractions of the account's total.
    public static func storageBar(_ usage: DriveUsage) -> StorageBar {
        let total = Double(max(usage.totalBytes, 1))
        let trash = Double(min(usage.trashBytes, usage.driveBytes))
        return StorageBar(drive: Double(usage.driveBytes) / total - trash / total,
                          trash: trash / total, other: Double(usage.otherBytes) / total)
    }

    /// Storage's sizes, as the web's Storage page writes them (`formatFileSize`, in 1024s).
    public static func storageSize(_ bytes: Int) -> String { EvidenceFiles.fileSize(bytes) }

    /// The legend under the bar: "Drive 10.9 GB", "Trash 1.3 GB", "Other 6.2 GB".
    public static func storageLegend(_ usage: DriveUsage) -> [String] {
        ["Drive \(storageSize(max(0, usage.driveBytes - usage.trashBytes)))",
         "Trash \(storageSize(usage.trashBytes))",
         "Other \(storageSize(usage.otherBytes))"]
    }

    /// What the drive's store says when it is nearly full, or nil.
    public static func storeWarning(_ usage: DriveUsage) -> String? {
        guard usage.nearQuota == true, let used = usage.storeUsedBytes, let quota = usage.storeQuotaBytes, quota > 0 else {
            return nil
        }
        if used >= quota { return "The drive's storage is full. Ask the operator to raise the limit." }
        return "Drive storage is \(used * 100 / quota)% full. Uploads stop at 100%. Ask the operator to raise the limit."
    }

    /// Everything kept besides the drive: "1.8 GB · 1,204 files", or with the quota "1.8 GB of 5 GB · 1,204 files".
    public static func storedValue(_ usage: StorageUsage) -> String {
        let size = usage.quotaBytes.map { "\(storageSize(usage.totalBytes)) of \(storageSize($0))" } ?? storageSize(usage.totalBytes)
        return "\(size) · \(files(usage.fileCount))"
    }

    public static func storageFull(_ usage: StorageUsage) -> Bool {
        usage.quotaBytes.map { usage.totalBytes >= $0 } ?? false
    }

    public static let storageFullNote = "Your storage is full, so new uploads are refused. Older uploads free up room as they expire."
    public static let everythingElse = "Everything else"
    public static let everythingElseNote = "Conversation pictures, attachments, evidence files and earlier file uploads"

    /// "Week of Nov 16" from the week's Monday, `YYYY-MM-DD`, read as a day (no zone shift).
    public static func weekLabel(_ weekStart: String) -> String {
        let parts = weekStart.split(separator: "-").compactMap { Int($0) }
        guard parts.count == 3, (1...12).contains(parts[1]) else { return "Week of \(weekStart)" }
        let months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
        return "Week of \(months[parts[1] - 1]) \(parts[2])"
    }

    // MARK: uploads popover (board 03-mac frame 4, 01-ios frames 16-18)

    /// What the toolbar ring and the popover's heading count: the owner's uploads and the agents' syncs together.
    public struct TrayTotals: Equatable, Sendable {
        public let count: Int
        public let finished: Int
        public let sentBytes: Int
        public let totalBytes: Int

        /// The ring's fill, 0…1.
        public var fraction: Double {
            if totalBytes > 0 { return min(1, Double(sentBytes) / Double(totalBytes)) }
            return count == 0 ? 0 : Double(finished) / Double(count)
        }

        public var allFinished: Bool { finished == count }
    }

    public static func trayTotals(_ uploads: [DriveUploadItem], _ syncs: [DriveSync]) -> TrayTotals {
        TrayTotals(
            count: uploads.count + syncs.count,
            finished: uploads.filter { $0.state == .done }.count + syncs.filter { !$0.running }.count,
            sentBytes: uploads.reduce(0) { $0 + ($1.state == .done ? $1.size : $1.sentBytes) } + syncs.reduce(0) { $0 + $1.bytesSent },
            totalBytes: uploads.reduce(0) { $0 + $1.size } + syncs.reduce(0) { $0 + ($1.bytesTotal ?? 0) })
    }

    /// The popover's heading: "Uploading 2 of 3 · 410 MB of 1.7 GB", or once all are in "Uploaded 3 files",
    /// "Synced 1 folder", "Finished 3 of 3".
    public static func trayTitle(_ uploads: [DriveUploadItem], _ syncs: [DriveSync]) -> String {
        let totals = trayTotals(uploads, syncs)
        if totals.allFinished {
            if uploads.isEmpty { return "Synced \(plural(syncs.count, "folder", "folders"))" }
            if syncs.isEmpty { return "Uploaded \(files(totals.finished))" }
            return "Finished \(totals.finished) of \(totals.count)"
        }
        let position = "Uploading \(min(totals.finished + 1, totals.count)) of \(totals.count)"
        guard totals.totalBytes > 0 else { return position }
        return "\(position) · \(formatSize(totals.sentBytes)) of \(formatSize(totals.totalBytes))"
    }

    public static let clearFinished = "Clear Finished"

    /// Where an upload goes, after its arrow: the folder of a dropped folder's file, else the folder it was dropped on.
    public static func uploadDestination(_ upload: DriveUploadItem) -> String {
        if let relative = upload.relativePath, relative.contains("/") {
            return relative.split(separator: "/").dropLast().joined(separator: "/")
        }
        return upload.parentName
    }

    /// The line under an upload's bar: what it is doing.
    public static func uploadStatus(_ upload: DriveUploadItem) -> String {
        let sent = "\(formatSize(upload.sentBytes)) of \(formatSize(upload.size))"
        switch upload.state {
        case .queued:
            return "Waiting · \(formatSize(upload.size))"
        case .uploading:
            return [sent, upload.rate.map(rate), timeLeft(bytesLeft: upload.size - upload.sentBytes, rate: upload.rate)]
                .compactMap { $0 }.joined(separator: " · ")
        case .paused:
            if upload.error != nil { return "Connection lost. \(sent) is kept; it goes on from there." }
            return "Paused · \(upload.percent)%"
        case .failed:
            return upload.error ?? "Couldn't upload"
        case .done:
            return "Uploaded · \(formatSize(upload.size))"
        }
    }

    /// A sync's row: "out/ → Reports/out".
    public static func syncTitle(_ sync: DriveSync) -> (source: String, destination: String) {
        ("\(sync.sourceName)/", String(sync.destPath.drop { $0 == "/" }))
    }

    public static let agentSync = "Agent sync"

    /// A sync's bar, 0…1; nil while it is still counting files.
    public static func syncFraction(_ sync: DriveSync) -> Double? {
        if sync.status == "CHECKING" { return nil }
        guard let total = sync.bytesTotal, total > 0 else { return 0 }
        return min(1, Double(sync.bytesSent) / Double(total))
    }

    /// Whether a sync ended with files it could not send, which its row marks and Details lists.
    public static func syncHasFailures(_ sync: DriveSync) -> Bool {
        sync.status == "FAILED" || (sync.status == "DONE" && sync.failedCount > 0)
    }

    /// The line under a sync's bar, or its whole outcome once it ended. `rate` is the bytes a second between the last
    /// two reads. A sync with failures ends in "Details…", which the row draws as a link after this text.
    public static func syncStatus(_ sync: DriveSync, rate: Double? = nil) -> String {
        switch sync.status {
        case "CHECKING":
            return "Checking files… \(sync.filesSeen.formatted()) so far"
        case "UPLOADING":
            let left = sync.bytesTotal.flatMap { timeLeft(bytesLeft: $0 - sync.bytesSent, rate: rate) }
            return ["\(sync.filesDone.formatted()) of \((sync.filesTotal ?? 0).formatted()) files · " +
                    "\(formatSize(sync.bytesSent)) of \(formatSize(sync.bytesTotal ?? 0))",
                    rate.map(Self.rate), left].compactMap { $0 }.joined(separator: " · ")
        case "DONE":
            let trashed = sync.filesDeleted > 0 ? " · \(sync.filesDeleted.formatted()) moved to Trash" : ""
            if sync.failedCount > 0 {
                return "Synced \(files(sync.filesDone)) · \(sync.failedCount.formatted()) failed\(trashed)"
            }
            if sync.filesDone == 0 { return "Already up to date · \(files(sync.filesSame))\(trashed)" }
            return "Synced \(files(sync.filesDone)) · \(formatSize(sync.bytesSent))\(trashed)"
        case "FAILED":
            return sync.error ?? "Couldn't sync"
        case "STOPPED":
            return "Stopped · \(sync.filesDone.formatted()) of \(sync.filesTotal.map { $0.formatted() } ?? "?") files synced"
        default:
            return sync.status.capitalized
        }
    }

    /// The bytes a second between two reads of the same sync; between two reads that moved nothing the last rate stands.
    public static func syncRate(previous: DriveSync?, previousRate: Double?, now: DriveSync) -> Double? {
        guard now.running, let previous, let was = date(previous.updatedAt), let at = date(now.updatedAt) else { return nil }
        let seconds = at.timeIntervalSince(was)
        if seconds > 0 && now.bytesSent > previous.bytesSent { return Double(now.bytesSent - previous.bytesSent) / seconds }
        return seconds <= 0 ? previousRate : nil
    }

    /// The Details sheet's heading and summary for a sync's failures.
    public static func syncDetailsTitle(_ sync: DriveSync) -> String { "\(sync.sourceName)/ → \(sync.destPath)" }

    public static func syncDetailsSummary(_ sync: DriveSync, now: Date = Date(), calendar: Calendar = .current) -> String {
        let at = formatter("HH:mm", calendar).string(from: date(sync.endedAt ?? sync.updatedAt) ?? now)
        var text = "Synced \(files(sync.filesDone))"
        if let session = sync.session { text += " from \(session.title)" }
        text += " at \(at). "
        if sync.failedCount > 0 { text += "\(files(sync.failedCount)) didn't upload. " }
        return text + "Ask the agent to run the sync again; it only sends what's still missing."
    }

    /// "and 12 more", when the server listed fewer failures than it counted.
    public static func syncMoreFailures(_ sync: DriveSync) -> String? {
        let more = sync.failedCount - sync.failed.count
        return more > 0 ? "and \(more.formatted()) more" : nil
    }

    /// "Open Datasets": the button that opens the folder a sync wrote to.
    public static func openFolder(_ sync: DriveSync) -> String { "Open \(folderLabel(sync.destPath))" }
}
