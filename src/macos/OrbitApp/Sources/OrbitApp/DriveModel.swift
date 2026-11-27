import Foundation
import Observation
import OrbitKit
#if os(macOS)
import AppKit
#elseif os(iOS)
import UIKit
#endif

/// Drive, the account's drive (docs/drive-product-design.md; board docs/mocks/drive, 03-mac): the folder on
/// screen, its inspector's reads, Trash, Storage, the share links, the agents' directory syncs and the owner's uploads.
/// Owned by `AppModel` and rebuilt per instance, like the other section stores; the uploads outlive the page, so leaving
/// Drive does not stop them. What the server answered is what is drawn; every press reads its answer back. The words
/// and the rules are OrbitKit's (`DriveLogic`, `DriveUploadQueue`).
@MainActor
@Observable
final class DriveModel {
    /// The capabilities read once it has finished; nil before (`DriveLogic.shown`).
    private(set) var capabilityRead: Result<ServerCapabilities?, Error>?
    /// Whether the sidebar has a Drive row.
    var shown: Bool { DriveLogic.shown(capabilityRead) }

    /// Which page is up: the drive, Trash or Storage (the sidebar's rows under Drive).
    var place: DrivePlace = .drive

    /// Counts every write this app made or heard of (`drive.changed`, an upload landing). The phone's pages, each
    /// holding its own folder, read again when it moves.
    private(set) var changes = 0
    /// Every entry a phone page has read, by id: a pushed page draws from here before its own read answers.
    private(set) var known: [String: DriveEntry] = [:]

    // MARK: the folder

    /// The folder on screen; nil is the drive's root.
    private(set) var folderID: String?
    private(set) var listing: DriveListing?
    private(set) var loading = false
    private(set) var loadError: String?
    /// The folders entered before (Back) and left by Back (Forward).
    private(set) var backStack: [String?] = []
    private(set) var forwardStack: [String?] = []
    /// The rows selected in the list.
    var selection: Set<String> = []
    /// What the search field holds; non-empty, the list shows the drive's matches instead of the folder.
    var searchText = ""
    private(set) var searchResults: [DriveEntry]?
    /// Each subfolder's count, read after its folder, for the Size column (the board's "9 items").
    private(set) var folderCounts: [String: Int] = [:]
    /// Sessions' titles by id, for "Agent in <session>".
    private(set) var sessionTitles: [String: String] = [:]
    /// The entry the inspector last read on its own (its `path`), by id.
    private(set) var entryDetails: [String: DriveEntry] = [:]
    /// Each file's versions, by file id.
    private(set) var versions: [String: [DriveVersion]] = [:]
    /// Previews read, by `<entry id>:<version id>`.
    private(set) var previews: [String: Preview] = [:]
    /// The drive files' open links.
    private(set) var shareLinks: [DriveShareLink] = []

    enum Preview: Equatable {
        case loading
        case data(Data)
        case failed
    }

    // MARK: Trash and Storage

    private(set) var trash: [DriveTrashGroup]?
    private(set) var trashError: String?
    /// Which group each paused-link file went in (it may be deep in a deleted folder).
    private(set) var trashGroupOf: [String: String] = [:]
    private(set) var usage: DriveUsage?
    private(set) var storage: StorageUsage?
    private(set) var storageError: String?

    // MARK: uploads and syncs

    /// The owner's uploads, as the queue has them.
    private(set) var uploads: [DriveUploadItem] = []
    /// The agents' directory syncs, minus those whose finished rows were cleared on this Mac.
    private(set) var syncs: [DriveSync] = []
    /// Bytes a second between the last two reads of each running sync.
    private(set) var syncRates: [String: Double] = [:]
    /// Every sync read, whether or not this Mac cleared it from the popover, by id: what the conversation's sync
    /// cards read (`DriveSyncCardView`), which stay live after a sync leaves the popover.
    private(set) var syncsByID: [String: DriveSync] = [:]

    /// A toast for the app's one host: the message, a line under it, its tone and an Undo.
    @ObservationIgnored var onToast: ((String, String?, ToastTone, (@MainActor () -> Void)?) -> Void)?
    /// Open a session (a writer's name, a sync's session).
    @ObservationIgnored var openSession: ((String) -> Void)?
    /// Where Download puts a file, and whether Finder then shows it: the Downloads folder and yes, unless a harness
    /// that must not touch the owner's folders says otherwise.
    @ObservationIgnored var downloadsFolder: () throws -> URL = {
        try FileManager.default.url(for: .downloadsDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
    }
    @ObservationIgnored var showsDownloadsInFinder = true

    @ObservationIgnored private let api: APIClient
    @ObservationIgnored let baseURL: URL
    @ObservationIgnored private let queue: DriveUploadQueue
    @ObservationIgnored private var allSyncs: [DriveSync] = []
    @ObservationIgnored private var dismissedSyncs: Set<String>
    @ObservationIgnored private var syncPoll: Task<Void, Never>?
    @ObservationIgnored private var listingTask: Task<Void, Never>?
    @ObservationIgnored private var countsTask: Task<Void, Never>?
    @ObservationIgnored private var searchTask: Task<Void, Never>?
    @ObservationIgnored private var observers: [NSObjectProtocol] = []
    @ObservationIgnored private var retryTimer: Task<Void, Never>?
    private static let dismissedKey = "documents.syncs.dismissed"

    init(baseURL: URL, tokenStore: TokenStore) {
        self.baseURL = baseURL
        api = APIClient(baseURL: baseURL, tokenStore: tokenStore)
        queue = DriveUploadQueue(transport: api, store: DriveUploadDefaultsStore(baseURL: baseURL))
        dismissedSyncs = Set(UserDefaults.standard.stringArray(forKey: Self.dismissedKey) ?? [])
        uploads = queue.items
        queue.onChange = { [weak self] in self?.uploadsMoved() }
        queue.onCompleted = { [weak self] item in self?.uploadCompleted(item) }
        watchForAWayBack()
    }

    // MARK: the switch

    /// `GET /auth/capabilities`, once per sign-in; answers whether Drive is on. Also starts what a relaunch left.
    func loadCapabilities() async {
        do {
            capabilityRead = .success(try await api.serverCapabilities())
        } catch {
            capabilityRead = .failure(error)
        }
        if shown {
            queue.start()
            await loadSyncs()
        }
    }

    // MARK: reading a folder

    /// Read the folder on screen again (a change event, a press's answer, the page opening).
    func reload() async {
        listingTask?.cancel()
        let id = folderID
        loading = listing == nil
        do {
            let read = try await api.driveFolder(id)
            guard id == folderID else { return }
            listing = read
            if read.folder.parentId == nil { rootID = read.folder.id }
            loadError = nil
            selection = selection.filter { sel in read.entries.contains { $0.id == sel } }
            learnSessions(read.entries.map(\.lastWriter))
            readCounts(read.entries.filter(\.isFolder).map(\.id))
        } catch {
            guard id == folderID else { return }
            loadError = APIClient.failureReason(error)
        }
        loading = false
        await loadShareLinks()
    }

    /// One folder (nil: the root), for a page that holds its own: the phone pushes one page per folder.
    func read(folder id: String?) async throws -> DriveListing {
        let read = try await api.driveFolder(id)
        if read.folder.parentId == nil { rootID = read.folder.id }
        learnSessions(read.entries.map(\.lastWriter))
        for entry in [read.folder] + read.entries { known[entry.id] = entry }
        return read
    }

    /// The drive's matches for some words, sorted, for a page or a picker that searches on its own.
    func search(_ words: String) async throws -> [DriveEntry] {
        let found = try await api.driveSearch(words)
        learnSessions(found.entries.map(\.lastWriter))
        for entry in found.entries { known[entry.id] = entry }
        return DriveLogic.sorted(found.entries)
    }

    /// How many entries a folder holds, read once per change (a phone row's "14 items").
    func count(of folder: DriveEntry) async -> Int? {
        if let known = folderCounts[folder.id] { return known }
        guard let read = try? await api.driveFolder(folder.id) else { return nil }
        folderCounts[folder.id] = read.entries.count
        return read.entries.count
    }

    /// One entry read on its own, with its path (a reply's link to a drive file); nil when it is gone.
    func entry(_ id: String) async -> DriveEntry? {
        guard let read = try? await api.driveEntry(id) else { return nil }
        entryDetails[read.id] = read
        known[read.id] = read
        learnSessions([read.lastWriter])
        return read
    }

    /// The rows the list shows: the search's matches while there are any words, else the folder's entries.
    var rows: [DriveEntry] {
        if !searchText.trimmingCharacters(in: .whitespaces).isEmpty { return searchResults ?? [] }
        return DriveLogic.sorted(listing?.entries ?? [])
    }

    var searching: Bool { !searchText.trimmingCharacters(in: .whitespaces).isEmpty }

    /// The words in the search field moved: ask the server once they have stood still.
    func searchChanged() {
        searchTask?.cancel()
        let words = searchText.trimmingCharacters(in: .whitespaces)
        guard !words.isEmpty else {
            searchResults = nil
            return
        }
        searchTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 250_000_000)
            guard !Task.isCancelled, let self else { return }
            let found = try? await self.api.driveSearch(words)
            guard !Task.isCancelled, words == self.searchText.trimmingCharacters(in: .whitespaces) else { return }
            self.searchResults = found.map { DriveLogic.sorted($0.entries) } ?? []
            self.learnSessions(found?.entries.map(\.lastWriter) ?? [])
        }
    }

    /// The folder's own entry, for the title.
    var folderTitle: String { DriveLogic.folderTitle(listing?.folder) }

    /// The one entry the inspector shows.
    var inspected: DriveEntry? {
        guard selection.count == 1, let id = selection.first else { return nil }
        return rows.first { $0.id == id }
    }

    /// Open a folder (nil: the root), keeping the way back.
    func open(folder id: String?) {
        guard id != folderID || place != .drive else { return }
        place = .drive
        searchText = ""
        searchResults = nil
        backStack.append(folderID)
        forwardStack = []
        go(to: id)
    }

    func goBack() {
        guard let previous = backStack.popLast() else { return }
        forwardStack.append(folderID)
        go(to: previous)
    }

    func goForward() {
        guard let next = forwardStack.popLast() else { return }
        backStack.append(folderID)
        go(to: next)
    }

    /// Open a file where it lives, selected, from its id alone (a file an agent's transfer card names). One no longer
    /// there opens the drive's root.
    func reveal(entryID: String) async {
        guard let entry = try? await api.driveEntry(entryID) else {
            open(folder: nil)
            return
        }
        reveal(entry)
    }

    /// Open a file where it lives, selected (a search result, a file a sync wrote).
    func reveal(_ entry: DriveEntry) {
        open(folder: entry.parentId)
        selection = [entry.id]
    }

    private func go(to id: String?) {
        folderID = id
        listing = nil
        selection = []
        folderCounts = [:]
        Task { await reload() }
    }

    private func readCounts(_ folders: [String]) {
        countsTask?.cancel()
        countsTask = Task { [weak self] in
            for id in folders.prefix(60) {
                guard !Task.isCancelled, let self else { return }
                if let read = try? await self.api.driveFolder(id) { self.folderCounts[id] = read.entries.count }
            }
        }
    }

    /// Read the titles of the sessions that wrote, once each.
    private func learnSessions(_ writers: [DriveWriter]) {
        let missing = Set(writers.compactMap(DriveLogic.writerSession)).filter { sessionTitles[$0] == nil }
        guard !missing.isEmpty else { return }
        for id in missing { sessionTitles[id] = "" }
        Task { [weak self] in
            for id in missing {
                guard let self else { return }
                if let session = try? await self.api.session(id) { self.sessionTitles[id] = session.title ?? "" }
            }
        }
    }

    /// "You", "Agent in <session>", "An agent on Orbit Cloud".
    func writerName(_ writer: DriveWriter) -> String {
        DriveLogic.writerText(writer, sessionTitle: writer.sessionId.flatMap { sessionTitles[$0] })
    }

    // MARK: the inspector

    /// What the inspector needs of a file: its path, its versions and its preview.
    func inspect(_ entry: DriveEntry) async {
        if let detail = try? await api.driveEntry(entry.id) { entryDetails[entry.id] = detail }
        guard entry.isFile else { return }
        if let read = try? await api.driveVersions(entry.id) {
            versions[entry.id] = read.versions
            learnSessions(read.versions.map(\.writer))
        }
        await loadPreview(entry)
    }

    private func previewKey(_ entry: DriveEntry) -> String { "\(entry.id):\(entry.currentVersionId ?? "")" }

    func preview(for entry: DriveEntry) -> Preview? { previews[previewKey(entry)] }

    private func loadPreview(_ entry: DriveEntry) async {
        let kind = DriveLogic.preview(name: entry.name, size: entry.sizeBytes)
        let key = previewKey(entry)
        guard kind != .none, previews[key] == nil || previews[key] == .failed else { return }
        previews[key] = .loading
        do {
            let data = try await api.driveContent(entry.id, maxBytes: DriveLogic.previewBytes(kind, size: entry.sizeBytes))
            previews[key] = .data(data)
        } catch {
            previews[key] = .failed
        }
    }

    /// The file's replaced versions, newest first.
    func earlierVersions(of entry: DriveEntry) -> [DriveVersion] {
        (versions[entry.id] ?? []).filter { !$0.current }
    }

    func restoreVersion(_ version: DriveVersion, asCopy: Bool) async {
        do {
            let entry = try await api.driveRestoreVersion(version.id, asCopy: asCopy)
            toast(asCopy ? DriveLogic.restoredAsCopy : DriveLogic.restoredAsCurrent, entry.name)
            await refreshAfterWrite()
        } catch {
            failed("Couldn't restore the version", error)
        }
    }

    /// The open link of a file, if it has one.
    func link(of entry: DriveEntry) -> DriveShareLink? {
        shareLinks.first { PublicID.storageKey($0.root.id) == PublicID.storageKey(entry.id) && $0.state == "ACTIVE" }
    }

    func loadShareLinks() async {
        if let links = try? await api.driveShareLinks() { shareLinks = links }
    }

    // MARK: writes

    /// A new folder in the folder on screen, named "New folder" (a suffix if taken); answers it, to rename at once.
    func newFolder() async -> DriveEntry? {
        do {
            let made = try await api.driveCreateFolder(parentID: folderID, name: DriveLogic.newFolderName)
            await reload()
            selection = [made.id]
            return made
        } catch {
            failed("Couldn't make the folder", error)
            return nil
        }
    }

    /// A folder named `name` in `parent` (nil: the root), as the phone's New folder alert and Move sheet make it.
    func createFolder(named name: String, in parent: DriveEntry?) async -> DriveEntry? {
        let name = name.trimmingCharacters(in: .whitespacesAndNewlines)
        if let problem = DriveLogic.nameProblem(name) {
            onToast?("Couldn't make the folder", problem, .error, nil)
            return nil
        }
        do {
            let made = try await api.driveCreateFolder(parentID: parent.flatMap { $0.parentId == nil ? nil : $0.id },
                                                           name: name)
            changes += 1
            return made
        } catch {
            failed("Couldn't make the folder", error)
            return nil
        }
    }

    func rename(_ entry: DriveEntry, to name: String) async {
        let name = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard name != entry.name else { return }
        if let problem = DriveLogic.nameProblem(name) {
            onToast?("Couldn't rename \(entry.name)", problem, .error, nil)
            return
        }
        do {
            _ = try await api.driveRename(entry.id, to: name)
            changes += 1
            await reload()
        } catch {
            failed("Couldn't rename \(entry.name)", error)
        }
    }

    /// Move entries into a folder (nil: the root).
    func move(_ ids: [String], to folder: DriveEntry?) async {
        await move(entries: ids.compactMap { id in rows.first { $0.id == id } }, to: folder)
    }

    /// Move these entries into a folder (nil: the root) — the phone's pages hold their own rows.
    func move(entries: [DriveEntry], to folder: DriveEntry?) async {
        guard let target = folder?.id ?? rootID else { return }
        var moved = 0
        for entry in entries where DriveLogic.canMove(entry, into: target, ancestorsOfTarget: []) {
            do {
                _ = try await api.driveMove(entry.id, to: target)
                moved += 1
            } catch {
                failed("Couldn't move \(entry.name)", error)
            }
        }
        if moved > 0 {
            let name = folder.map { DriveLogic.folderTitle($0) } ?? DriveLogic.title
            toast(moved == 1 ? DriveLogic.moved(entries[0].name, to: name) : "Moved \(DriveLogic.items(moved)) to \(name)", nil)
        }
        changes += 1
        await reload()
    }

    /// The root folder's id, once any listing has said it.
    @ObservationIgnored private var rootID: String?

    /// The folders a Move sheet offers under `parent` (nil: the root).
    func folders(in parent: String?) async -> (folder: DriveEntry, children: [DriveEntry])? {
        guard let read = try? await api.driveFolder(parent) else { return nil }
        if read.folder.parentId == nil { rootID = read.folder.id }
        return (read.folder, DriveLogic.sorted(read.entries.filter(\.isFolder)))
    }

    /// Move to Trash, with Undo (each entry's group restored).
    func moveToTrash(_ ids: [String]) async {
        await moveToTrash(entries: ids.compactMap { id in rows.first { $0.id == id } })
    }

    func moveToTrash(entries: [DriveEntry]) async {
        var groups: [String] = []
        for entry in entries {
            do {
                groups.append(try await api.driveMoveToTrash(entry.id).trashGroupId)
            } catch {
                failed("Couldn't move \(entry.name) to Trash", error)
            }
        }
        selection = []
        changes += 1
        await reload()
        guard !groups.isEmpty else { return }
        let subtitle = entries.count == 1 ? entries[0].name : DriveLogic.items(entries.count)
        onToast?(DriveLogic.movedToTrash, subtitle, .success, { [weak self] in
            Task { @MainActor [weak self] in
                guard let self else { return }
                for group in groups { _ = try? await self.api.driveRestoreGroup(group) }
                await self.refreshAfterWrite()
            }
        })
    }

    /// Download a file (or one version) into the Downloads folder and show it in Finder. The server mints a link that
    /// needs no login header, and the bytes stream to disk however large the file is (D12).
    func download(_ entry: DriveEntry, version: DriveVersion? = nil) async {
        #if os(macOS)
        do {
            let url = try await api.driveDownloadURL(entry.id, versionID: version?.id)
            let (temporary, response) = try await URLSession.shared.download(from: url)
            if let http = response as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
                throw APIError.http(status: http.statusCode, body: nil)
            }
            let folder = try downloadsFolder()
            let file = Self.freeName(entry.name, in: folder)
            try FileManager.default.moveItem(at: temporary, to: file)
            try DownloadMark.apply(to: file)
            if showsDownloadsInFinder { NSWorkspace.shared.activateFileViewerSelecting([file]) }
            toast("Downloaded \(entry.name)", "To \(folder.lastPathComponent)")
        } catch {
            failed("Couldn't download \(entry.name)", error)
        }
        #endif
    }

    #if os(iOS)
    /// Download a file (or one version) for the share sheet: its bytes stream into a folder of their own under the
    /// app's temporary directory, named as the drive names it, and the sheet saves or sends them on. Nil on failure,
    /// which a toast has said.
    func downloadForSharing(_ entry: DriveEntry, version: DriveVersion? = nil) async -> URL? {
        do {
            let url = try await api.driveDownloadURL(entry.id, versionID: version?.id)
            let (temporary, response) = try await URLSession.shared.download(from: url)
            if let http = response as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
                throw APIError.http(status: http.statusCode, body: nil)
            }
            let folder = FileManager.default.temporaryDirectory
                .appendingPathComponent("Documents-downloads", isDirectory: true)
                .appendingPathComponent(UUID().uuidString, isDirectory: true)
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            let file = Self.freeName(entry.name, in: folder)
            try FileManager.default.moveItem(at: temporary, to: file)
            return file
        } catch {
            failed("Couldn't download \(entry.name)", error)
            return nil
        }
    }
    #endif

    /// "name.png", else "name 2.png", "name 3.png", as Finder names a second copy.
    private static func freeName(_ name: String, in folder: URL) -> URL {
        let safe = name.replacingOccurrences(of: "/", with: "-").replacingOccurrences(of: ":", with: "-")
        var candidate = folder.appendingPathComponent(safe)
        let base = (safe as NSString).deletingPathExtension
        let ext = (safe as NSString).pathExtension
        var n = 2
        while FileManager.default.fileExists(atPath: candidate.path) {
            candidate = folder.appendingPathComponent(ext.isEmpty ? "\(base) \(n)" : "\(base) \(n).\(ext)")
            n += 1
        }
        return candidate
    }

    // MARK: share

    func shareCheck(_ entry: DriveEntry) async throws -> DriveShareCheck { try await api.driveShareCheck(entry.id) }

    func share(_ entry: DriveEntry) async throws -> DriveShareAnswer {
        let answer = try await api.driveShare(entry.id)
        await loadShareLinks()
        return answer
    }

    func stopSharing(_ link: DriveShareLink, name: String) async {
        do {
            try await api.driveStopSharing(link.id)
            await loadShareLinks()
            toast("Stopped sharing", name)
        } catch {
            failed("Couldn't stop sharing", error)
        }
    }

    func publicURL(_ link: DriveShareLink) -> URL { DriveLogic.publicURL(link, base: baseURL) }

    // MARK: Trash

    func loadTrash() async {
        do {
            let groups = try await api.driveTrash()
            trash = groups
            trashError = nil
            learnSessions(groups.map(\.actor))
            await loadShareLinksAndPaused()
        } catch {
            trashError = APIClient.failureReason(error)
        }
    }

    /// A shared file in Trash has a paused link; which group it went in is its own entry's.
    private func loadShareLinksAndPaused() async {
        guard let links = try? await api.driveShareLinks() else { return }
        shareLinks = links
        var groupOf: [String: String] = [:]
        for link in links where link.state == "PAUSED" {
            if let entry = try? await api.driveEntry(link.root.id), let group = entry.trashGroupId {
                groupOf[link.root.id] = group
            }
        }
        trashGroupOf = groupOf
    }

    func endsALink(_ group: DriveTrashGroup) -> Bool {
        DriveLogic.groupEndsALink(group, links: shareLinks, trashGroupOf: trashGroupOf)
    }

    func restore(_ group: DriveTrashGroup) async {
        do {
            let answer = try await api.driveRestoreGroup(group.id)
            toast(DriveLogic.restored(DriveLogic.items(max(answer.entryIds.count, group.itemCount)), group: group), nil)
            await refreshAfterWrite()
        } catch {
            failed("Couldn't restore", error)
        }
    }

    func restore(_ item: DriveEntry, of group: DriveTrashGroup) async {
        do {
            try await api.driveRestoreItem(groupID: group.id, entryID: item.id)
            toast(DriveLogic.restored(item.name, group: group), nil)
            await refreshAfterWrite()
        } catch {
            failed("Couldn't restore \(item.name)", error)
        }
    }

    func restoreVersion(of group: DriveTrashGroup, asCopy: Bool) async {
        guard let version = group.version else { return }
        do {
            let entry = try await api.driveRestoreVersion(version.id, asCopy: asCopy)
            toast(asCopy ? DriveLogic.restoredAsCopy : DriveLogic.restoredAsCurrent, entry.name)
            await refreshAfterWrite()
        } catch {
            failed("Couldn't restore the version", error)
        }
    }

    func deleteForGood(_ group: DriveTrashGroup) async {
        do {
            try await api.driveDeleteGroup(group.id)
            await refreshAfterWrite()
        } catch {
            failed("Couldn't delete", error)
        }
    }

    func emptyTrash() async {
        do {
            try await api.driveEmptyTrash()
            await refreshAfterWrite()
        } catch {
            failed("Couldn't empty Trash", error)
        }
    }

    // MARK: Storage

    func loadStorage() async {
        usage = try? await api.driveUsage()
        do {
            storage = try await api.storageUsage()
            storageError = nil
        } catch {
            storageError = APIClient.failureReason(error)
        }
    }

    // MARK: uploads

    /// Upload what was picked or dropped into `folder` (nil: the folder on screen): files, and folders whole.
    func upload(_ urls: [URL], into folder: DriveEntry? = nil) {
        let target = folder ?? listing?.folder
        let parentID = target.flatMap { $0.parentId == nil ? nil : $0.id }
        let requests = DriveUploadRequest.expand(urls, parentID: parentID, parentName: DriveLogic.folderTitle(target))
        queue.add(requests)
    }

    func pauseUpload(_ id: String) { queue.pause(id) }
    func resumeUpload(_ id: String) { queue.resume(id) }
    func cancelUpload(_ id: String) {
        let path = uploads.first { $0.id == id }?.filePath
        queue.cancel(id)
        if let path { Self.dropStaged(path) }
    }

    /// Where the phone keeps what it was handed to upload. A picked file is only lent to the app while the picker's
    /// answer is in hand, and Photos hands over a copy, so each is copied here first: the upload then goes on from
    /// these bytes after a lost connection or a relaunch, and the copy goes once the file is in.
    nonisolated static var stagingFolder: URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? FileManager.default.temporaryDirectory
        return base.appendingPathComponent("DriveUploads", isDirectory: true)
    }

    /// A new folder of its own under the staging folder, for one picked file or folder (names never clash).
    nonisolated static func stagingSlot() throws -> URL {
        let slot = stagingFolder.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: slot, withIntermediateDirectories: true)
        return slot
    }

    /// Copy what a picker lent (files, or folders whole) into the staging folder, then upload the copies.
    func uploadPicked(_ urls: [URL], into folder: DriveEntry?) {
        var staged: [URL] = []
        for url in urls {
            let scoped = url.startAccessingSecurityScopedResource()
            defer { if scoped { url.stopAccessingSecurityScopedResource() } }
            do {
                let copy = try Self.stagingSlot().appendingPathComponent(url.lastPathComponent)
                try FileManager.default.copyItem(at: url, to: copy)
                staged.append(copy)
            } catch {
                failed("Couldn't read \(url.lastPathComponent)", error)
            }
        }
        guard !staged.isEmpty else { return }
        upload(staged, into: folder)
    }

    /// Remove a staged copy once its upload is in or cancelled; a file picked on the Mac is the owner's and stays.
    private nonisolated static func dropStaged(_ path: String) {
        let root = stagingFolder.standardizedFileURL.path
        let file = URL(fileURLWithPath: path).standardizedFileURL
        guard file.path.hasPrefix(root + "/") else { return }
        try? FileManager.default.removeItem(at: file)
        // The slot folder (and a staged folder's emptied subfolders) go with their last file.
        var parent = file.deletingLastPathComponent()
        while parent.path.hasPrefix(root + "/"),
              (try? FileManager.default.contentsOfDirectory(atPath: parent.path))?.isEmpty == true {
            try? FileManager.default.removeItem(at: parent)
            parent = parent.deletingLastPathComponent()
        }
    }

    /// Clear the finished uploads and hide the ended syncs on this Mac.
    func clearFinished() {
        queue.clearFinished()
        for sync in allSyncs where !sync.running { dismissedSyncs.insert(sync.id) }
        UserDefaults.standard.set(Array(dismissedSyncs), forKey: Self.dismissedKey)
        publishSyncs()
    }

    /// The toolbar's ring and popover have something to show.
    var trayShown: Bool { !uploads.isEmpty || !syncs.isEmpty }

    private func uploadsMoved() {
        uploads = queue.items
        #if os(iOS)
        holdTheAppAwake()
        #endif
    }

    private func uploadCompleted(_ item: DriveUploadItem) {
        Self.dropStaged(item.filePath)
        changes += 1
        // The folder on screen reads again once a file lands in it (or in a folder under it).
        Task { await reload() }
    }

    #if os(iOS)
    @ObservationIgnored private var backgroundTask: UIBackgroundTaskIdentifier = .invalid

    /// While an upload is going or waiting, ask iOS for time to finish it if the app is sent to the background; once
    /// none is, give that time back. If iOS ends the time first, the chunk in flight fails as a lost connection, the
    /// upload pauses with what the server already holds, and it goes on from there when the app is back.
    private func holdTheAppAwake() {
        let busy = uploads.contains { $0.state == .uploading || $0.state == .queued }
        if busy, backgroundTask == .invalid {
            backgroundTask = UIApplication.shared.beginBackgroundTask(withName: "Drive uploads") { [weak self] in
                MainActor.assumeIsolated { self?.letTheAppSleep() }
            }
        } else if !busy {
            letTheAppSleep()
        }
    }

    private func letTheAppSleep() {
        guard backgroundTask != .invalid else { return }
        UIApplication.shared.endBackgroundTask(backgroundTask)
        backgroundTask = .invalid
    }
    #endif

    /// A connection that came back, or a Mac that woke: what a lost connection paused goes on.
    private func watchForAWayBack() {
        #if os(macOS)
        observers.append(NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.didWakeNotification, object: nil, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated { self?.queue.resumeInterrupted() }
            })
        #elseif os(iOS)
        // Back in the foreground: what iOS cut off when the app was suspended goes on from where it stopped.
        observers.append(NotificationCenter.default.addObserver(
            forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated { self?.queue.resumeInterrupted() }
            })
        #endif
        // A paused upload tries again every half minute, as the web's does when the browser says it is online.
        retryTimer = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 30_000_000_000)
                self?.queue.resumeInterrupted()
            }
        }
    }

    // MARK: syncs

    /// `GET /drive/syncs`; while one runs, again every 5 s the app can be seen.
    func loadSyncs() async {
        guard let read = try? await api.driveSyncs() else { return }
        let before = Dictionary(allSyncs.map { ($0.id, $0) }, uniquingKeysWith: { $1 })
        var rates: [String: Double] = [:]
        for sync in read {
            if let rate = DriveLogic.syncRate(previous: before[sync.id], previousRate: syncRates[sync.id], now: sync) {
                rates[sync.id] = rate
            }
        }
        syncRates = rates
        allSyncs = read
        for sync in read { syncsByID[sync.id] = sync }
        publishSyncs()
        if read.contains(where: \.running) && syncPoll == nil {
            syncPoll = Task { [weak self] in
                while !Task.isCancelled {
                    await VisibilityGate.app.pause(5)
                    guard let self, !Task.isCancelled else { return }
                    await self.loadSyncs()
                    if !self.allSyncs.contains(where: \.running) {
                        self.syncPoll = nil
                        return
                    }
                }
            }
        }
    }

    private func publishSyncs() {
        syncs = allSyncs.filter { $0.running || !dismissedSyncs.contains($0.id) }
    }

    /// A conversation's sync card asks for its sync: from the list if it is there, else read once by id (a sync
    /// ended over a day ago is not in the list). `drive.sync` keeps it current after that (`nudge`).
    func watchSync(_ id: String) async {
        guard syncsByID[id] == nil else { return }
        await loadSyncs()
        guard syncsByID[id] == nil, let sync = try? await api.driveSync(id) else { return }
        syncsByID[sync.id] = sync
    }

#if DEBUG
    /// Test-only: what a screenshot gallery seeds for `DriveSyncCardView` to read.
    func seedSyncsForTesting(_ syncs: [DriveSync], rates: [String: Double] = [:]) {
        for sync in syncs { syncsByID[sync.id] = sync }
        syncRates = rates
    }
#endif

    /// Open the folder a sync wrote to.
    func openSyncFolder(_ sync: DriveSync) {
        guard let id = sync.destEntryId else { return }
        open(folder: id)
    }

    // MARK: events

    /// `drive.changed` (and `drive.sync`): what this page has loaded reads again.
    func nudge(syncs: Bool) {
        guard shown else { return }
        Task {
            if syncs { await loadSyncs() }
            await refreshAfterWrite()
        }
    }

    /// After a write: the page that is up, and what the inspector shows.
    private func refreshAfterWrite() async {
        changes += 1
        folderCounts = [:]
        switch place {
        case .drive:
            await reload()
            if let entry = inspected { await inspect(entry) }
        case .trash:
            await loadTrash()
        case .storage:
            await loadStorage()
        }
    }

    private func toast(_ message: String, _ subtitle: String?) { onToast?(message, subtitle, .success, nil) }

    private func failed(_ message: String, _ error: Error) {
        let reason = APIClient.failureReason(error)
        onToast?(message, reason.prefix(1).uppercased() + reason.dropFirst(), .error, nil)
    }
}
