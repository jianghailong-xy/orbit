import Foundation

// How the phone's Drive pages read (board docs/mocks/drive/01-ios.png, frames 1-18): the second line of a
// row, the preview's heading, Trash's rows, the share sheet's outcome, the uploads sheet's notes, the composer's
// From Drive picker and a reply's link to a drive file. The rules shared with the Mac stay in `DriveLogic`;
// what only the phone's layout says is here, so the iOS views hold no sentence of their own.
extension DriveLogic {

    // MARK: a row's second line (frames 2-3)

    /// When, as a phone row writes it: "today 14:02" (a folder) or "14:02" (a file, after its writer), "yesterday",
    /// "Nov 16", "Nov 16, 2025".
    public static func rowWhen(_ iso: String, folder: Bool, now: Date = Date(), calendar: Calendar = .current) -> String {
        let when = formatWhen(iso, now: now, calendar: calendar)
        if when == "Yesterday" { return "yesterday" }
        if folder, let at = date(iso), calendar.isDate(at, inSameDayAs: now) { return "today \(when)" }
        return when
    }

    /// A folder's second line: "14 items · today 14:02"; before its count is read, the time alone.
    public static func folderLine(count: Int?, mtime: String, now: Date = Date(), calendar: Calendar = .current) -> String {
        let when = rowWhen(mtime, folder: true, now: now, calendar: calendar)
        guard let count else { return when }
        return when.isEmpty ? items(count) : "\(items(count)) · \(when)"
    }

    /// A file's second line after its writer's name (rule 6): " · 14:02".
    public static func fileLineWhen(_ mtime: String, now: Date = Date(), calendar: Calendar = .current) -> String {
        let when = rowWhen(mtime, folder: false, now: now, calendar: calendar)
        return when.isEmpty ? "" : " · \(when)"
    }

    // MARK: a file's page (frames 4-5)

    /// The kind a file's page names: "Markdown", "PNG", "File".
    public static func kindName(_ name: String) -> String {
        let dot = name.lastIndex(of: ".")
        guard let dot, dot > name.startIndex else { return "File" }
        let ext = name[name.index(after: dot)...].lowercased()
        if ext == "md" || ext == "markdown" { return "Markdown" }
        return ext.isEmpty ? "File" : ext.uppercased()
    }

    /// The line under a file's name: "PNG · 1.2 MB · 1179 × 2556 · Orbit UI migration" (a picture, once drawn, and the
    /// folder it is in), "Markdown · 18 KB".
    public static func fileFacts(_ entry: DriveEntry, pixels: (width: Int, height: Int)? = nil,
                                 folder: String? = nil) -> String {
        var parts = [kindName(entry.name), formatSize(entry.sizeBytes)]
        if let pixels { parts.append("\(pixels.width) × \(pixels.height)") }
        if let folder, !folder.isEmpty { parts.append(folder) }
        return parts.joined(separator: " · ")
    }

    /// The writer card's first line: "Last written today 14:02 by", "Last written Nov 16 by".
    public static func lastWrittenBy(_ iso: String, now: Date = Date(), calendar: Calendar = .current) -> String {
        let when = formatWhenLong(iso, now: now, calendar: calendar)
        guard !when.isEmpty else { return "Last written by" }
        let lowered = when.hasPrefix("Today") || when.hasPrefix("Yesterday") ? when.prefix(1).lowercased() + when.dropFirst() : when
        return "Last written \(lowered) by"
    }

    public static let earlierVersionsTitle = "Earlier versions"

    /// The Earlier versions row's count: "2 in Trash"; nothing when there are none.
    public static func earlierVersionsCount(_ count: Int) -> String? { count == 0 ? nil : "\(count.formatted()) in Trash" }

    /// One earlier version in the list: "Nov 18 · 1.1 MB · You".
    public static func versionLine(_ version: DriveVersion, writer: String, now: Date = Date(),
                                   calendar: Calendar = .current) -> String {
        "\(formatWhenLong(version.createdAt, now: now, calendar: calendar)) · \(formatSize(version.sizeBytes)) · \(writer)"
    }

    /// Frame 12's question over an earlier version: "“sign-in-v3.png” is in Orbit UI migration now."
    public static func versionWhereNow(_ name: String, folder: String) -> String { "“\(name)” is in \(folder) now." }

    public static let restoreAsCurrent = "Restore as the current version"
    public static let restoreAsCopy = "Restore as a copy"
    public static let deleteForGood = "Delete for good"

    // MARK: rename, new folder, move (frames 6-7)

    public static let renameTitle = "Rename"
    public static let newFolderTitle = "New folder"

    /// The Move sheet's title: `Move "migration-notes.md"`, or `Move 3 items`.
    public static func moveTitle(_ names: [String]) -> String {
        names.count == 1 ? "Move “\(names[0])”" : "Move \(items(names.count))"
    }

    /// The Move sheet's button: "Move to Notes", "Move to Drive".
    public static func moveHere(_ folder: String) -> String { "Move to \(folder)" }

    public static let moveFoot = "Only folders are listed. A name already taken in the folder you move to gets a suffix, " +
        "as “migration-notes 2.md”."

    /// The Move sheet's trail: "Drive › Drive service".
    public static func trail(_ names: [String]) -> String { names.joined(separator: " › ") }

    // MARK: the drive's top level (frame 2)

    public static let driveFoot = "Agents on Orbit Cloud see this drive as ~/Drive. What is here is kept until someone deletes it."
    public static let moreHeading = "More"
    public static let searchPrompt = "Search Drive"
    public static let emptyFolder = "Nothing here yet"
    public static let emptyFolderNote = "Upload files, photos or a folder with +."

    // MARK: share link (frames 9-10)

    public static let nothingFound = "Checked for secrets: nothing found"
    public static let shareSecretsLead = "Anyone with the link could read them:"
    public static let shareSecretsFoot = "You can still share it. Remove them from the file first if they should stay private."
    public static let shareDescriptionLong = "Anyone with the link can view and download this one file, without signing in. " +
        "It follows the file: an agent's later overwrite is what they see."
    public static let sharedLinksFoot = "Links you have made are listed in Settings → Shared links, as File."

    /// A warning's place: "line 14".
    public static func warningLine(_ warning: DriveShareWarning) -> String { "line \(warning.line)" }

    // MARK: Trash (frames 11-12)

    /// A group's heading: "Orbit UI migration · Today 14:20" (the phone draws it in capitals).
    public static func trashHeading(_ group: DriveTrashGroup, now: Date = Date(), calendar: Calendar = .current) -> String {
        "\(groupTitle(group)) · \(formatWhenLong(group.createdAt, now: now, calendar: calendar))"
    }

    /// An item's second line in Trash: a folder "Folder · 18 items · 46 MB · by an agent on Orbit Cloud", a file
    /// "Deleted by you", an earlier version "Earlier version · replaced 09:12 by Agent in Redesign".
    public static func trashLine(_ item: DriveEntry, in group: DriveTrashGroup, writer: String,
                                 folderCount: Int? = nil) -> String {
        let who = writer == you || writer == uncheckedAgent ? writer.prefix(1).lowercased() + writer.dropFirst() : writer
        if item.isFolder {
            let count = folderCount.map { " · \(items($0))" } ?? ""
            return "Folder\(count) · \(formatSize(group.sizeBytes)) · by \(who)"
        }
        return "Deleted by \(who)"
    }

    public static func trashVersionLine(_ group: DriveTrashGroup, writer: String, now: Date = Date(),
                                        calendar: Calendar = .current) -> String {
        let when = formatWhen(group.createdAt, now: now, calendar: calendar)
        let who = writer == you || writer == uncheckedAgent ? writer.prefix(1).lowercased() + writer.dropFirst() : writer
        return "Earlier version · replaced \(when) by \(who)"
    }

    public static let restoreAll = "Restore all"
    public static let emptyTrash = "Empty"

    // MARK: Storage (frame 13)

    public static let inThisAccount = "in this account"
    public static let otherStorage = "Other storage"
    public static let storedFiles = "Stored files"
    public static let storageFoot = "Each file counts once, however many sessions use it. These are kept under their own rules " +
        "and are not in the drive."
    public static let largestProjects = "Largest projects"
    public static let largestTasks = "Largest tasks"
    public static let addedEachWeek = "Added each week"

    // MARK: uploads (frames 8, 16-18)

    public static let uploadsTitle = "Uploads"
    public static let showUploads = "Show"
    public static let clearFinishedPhone = "Clear finished"
    public static let uploadsFoot = "Uploads go on when the app is in the background. Leave a large one paused and it picks up " +
        "where it stopped, not from the start."
    public static let syncFoot = "An agent's sync has no Pause: only the agent that started it can stop it."
    public static let didntUpload = "Didn't upload"
    public static let uploadFiles = "Upload files"
    public static let uploadPhotos = "Upload photos"
    public static let uploadFolder = "Upload a folder"

    // MARK: the composer's picker (frame 14, D21, D22)

    /// Where the drive is mounted for an agent (design §4.5): a picked file's path in a message starts here.
    public static let agentMount = "/home/orbit/Drive"

    public static let pickerTitle = "Add from Drive"
    public static let pickerFoot = "The file is not uploaded again: its path goes into your message, and the agent reads it " +
        "from ~/Drive."
    public static let fromDrive = "Drive"

    /// "Add", "Add 1", "Add 3".
    public static func pickerAdd(_ count: Int) -> String { count == 0 ? "Add" : "Add \(count)" }

    /// A picked file's path for an agent: the mount, the folders opened below the root, the name.
    public static func agentPath(folders: [String], name: String) -> String {
        ([agentMount] + folders + [name]).joined(separator: "/")
    }

    /// A search result's path for an agent, from the entry's own path (`/a/b/name`).
    public static func agentPath(entryPath: String?, name: String) -> String {
        guard let entryPath, !entryPath.isEmpty else { return "\(agentMount)/\(name)" }
        return agentMount + (entryPath.hasPrefix("/") ? entryPath : "/" + entryPath)
    }

    /// The project's folder name at the drive's top (D22): no `/`, at most 60 characters (the web's
    /// `projectFolderName`).
    public static func projectFolderName(_ title: String) -> String {
        String(title.replacingOccurrences(of: "/", with: "-").trimmingCharacters(in: .whitespaces).prefix(60))
    }

    /// The session's project folder among the drive's top folders: its name, or its name with the short id suffix a
    /// clash adds; nil when there is none, and the picker opens on the root.
    public static func projectFolder(_ entries: [DriveEntry], projectID: String, title: String) -> DriveEntry? {
        let wanted = projectFolderName(title)
        let folders = entries.filter(\.isFolder)
        if let exact = folders.first(where: { $0.name == wanted }) { return exact }
        return folders.first { folder in
            folder.name.hasPrefix("\(wanted)-") && projectID.hasPrefix(String(folder.name.dropFirst(wanted.count + 1)))
        }
    }

    // MARK: a reply's link to a drive file (frame 15, D21)

    /// The entry id in an `orbit-document:<id>` link, or the `orbit-drive:<id>` stored transcripts still carry; nil for
    /// any other link (the web's `driveIdFromHref`).
    public static func linkedEntryID(_ href: String) -> String? {
        let trimmed = href.trimmingCharacters(in: .whitespaces)
        for prefix in ["orbit-document:", "orbit-drive:"] where trimmed.lowercased().hasPrefix(prefix) {
            let id = trimmed.dropFirst(prefix.count).trimmingCharacters(in: .whitespaces)
                .split(whereSeparator: \.isWhitespace).first.map(String.init) ?? ""
            return id.isEmpty ? nil : id
        }
        return nil
    }

    /// A Markdown link to a drive file in a paragraph: where it is, the entry it names and the words it shows.
    public struct LinkMatch: Equatable, Sendable {
        public let range: Range<String.Index>
        public let entryID: String
        public let label: String
    }

    private static let markdownLink = try! NSRegularExpression(pattern: #"(!?)\[([^\]\n]*)\]\(([^)\s]+)[^)]*\)"#)

    /// Every `[label](orbit-document:<id>)` (or `orbit-drive:`) link in a paragraph, in order: a reply draws each as
    /// the file it names (frame 15). Image syntax and other links are left as they are.
    public static func linkMatches(in text: String) -> [LinkMatch] {
        let range = NSRange(text.startIndex..<text.endIndex, in: text)
        return markdownLink.matches(in: text, range: range).compactMap { match in
            guard let whole = Range(match.range(at: 0), in: text),
                  let bang = Range(match.range(at: 1), in: text), text[bang].isEmpty,
                  let label = Range(match.range(at: 2), in: text),
                  let href = Range(match.range(at: 3), in: text),
                  let id = linkedEntryID(String(text[href])) else { return nil }
            return LinkMatch(range: whole, entryID: id, label: String(text[label]).trimmingCharacters(in: .whitespaces))
        }
    }

    /// The folder a linked file sits in: "Drive › Orbit UI migration".
    public static func cardTrail(_ path: String?) -> String {
        let parts = (path ?? "").split(separator: "/").map(String.init)
        return trail([title] + parts.dropLast())
    }

    /// A linked file's second line: "Drive › Orbit UI migration · 1.2 MB"; a folder's trail alone.
    public static func cardLine(_ entry: DriveEntry) -> String {
        entry.isFolder ? cardTrail(entry.path) : "\(cardTrail(entry.path)) · \(formatSize(entry.sizeBytes))"
    }

    /// What a link to a file that has gone says instead of breaking.
    public static func cardGone(trashed: Bool) -> String {
        trashed ? "In Trash · moved or deleted" : "No longer in Drive · moved or deleted"
    }
}
