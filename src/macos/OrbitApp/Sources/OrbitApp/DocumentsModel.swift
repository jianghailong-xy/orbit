import Foundation
import Observation
import OrbitKit
#if os(macOS)
import AppKit
#endif

/// Documents, the account's drive (docs/documents-drive-design.md; board docs/mocks/documents, 03-mac): the folder on
/// screen, its inspector's reads, Trash, Storage, the share links, the agents' directory syncs and the owner's uploads.
/// Owned by `AppModel` and rebuilt per instance, like the other section stores; the uploads outlive the page, so leaving
/// Documents does not stop them. What the server answered is what is drawn; every press reads its answer back. The words
/// and the rules are OrbitKit's (`DocumentsLogic`, `DocumentsUploadQueue`).
@MainActor
@Observable
final class DocumentsModel {
    /// The capabilities read once it has finished; nil before (`DocumentsLogic.shown`).
    private(set) var capabilityRead: Result<ServerCapabilities?, Error>?
    /// Whether the sidebar has a Documents row.
    var shown: Bool { DocumentsLogic.shown(capabilityRead) }

    /// Which page is up: the drive, Trash or Storage (the sidebar's rows under Documents).
    var place: DocumentsPlace = .drive

    // MARK: the folder

    /// The folder on screen; nil is the drive's root.
    private(set) var folderID: String?
    private(set) var listing: DocumentsListing?
    private(set) var loading = false
    private(set) var loadError: String?
    /// The folders entered before (Back) and left by Back (Forward).
    private(set) var backStack: [String?] = []
    private(set) var forwardStack: [String?] = []
    /// The rows selected in the list.
    var selection: Set<String> = []
    /// What the search field holds; non-empty, the list shows the drive's matches instead of the folder.
    var searchText = ""
    private(set) var searchResults: [DocumentsEntry]?
    /// Each subfolder's count, read after its folder, for the Size column (the board's "9 items").
    private(set) var folderCounts: [String: Int] = [:]
    /// Sessions' titles by id, for "Agent in <session>".
    private(set) var sessionTitles: [String: String] = [:]
    /// The entry the inspector last read on its own (its `path`), by id.
    private(set) var entryDetails: [String: DocumentsEntry] = [:]
    /// Each file's versions, by file id.
    private(set) var versions: [String: [DocumentsVersion]] = [:]
    /// Previews read, by `<entry id>:<version id>`.
    private(set) var previews: [String: Preview] = [:]
    /// The drive files' open links.
    private(set) var shareLinks: [DocumentsShareLink] = []

    enum Preview: Equatable {
        case loading
        case data(Data)
        case failed
    }

    // MARK: Trash and Storage

    private(set) var trash: [DocumentsTrashGroup]?
    private(set) var trashError: String?
    /// Which group each paused-link file went in (it may be deep in a deleted folder).
    private(set) var trashGroupOf: [String: String] = [:]
    private(set) var usage: DocumentsUsage?
    private(set) var storage: StorageUsage?
    private(set) var storageError: String?

    // MARK: uploads and syncs

    /// The owner's uploads, as the queue has them.
    private(set) var uploads: [DocumentsUploadItem] = []
    /// The agents' directory syncs, minus those whose finished rows were cleared on this Mac.
    private(set) var syncs: [DocumentsSync] = []
    /// Bytes a second between the last two reads of each running sync.
    private(set) var syncRates: [String: Double] = [:]

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
    @ObservationIgnored private let queue: DocumentsUploadQueue
    @ObservationIgnored private var allSyncs: [DocumentsSync] = []
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
        queue = DocumentsUploadQueue(transport: api, store: DocumentsUploadDefaultsStore(baseURL: baseURL))
        dismissedSyncs = Set(UserDefaults.standard.stringArray(forKey: Self.dismissedKey) ?? [])
        uploads = queue.items
        queue.onChange = { [weak self] in self?.uploadsMoved() }
        queue.onCompleted = { [weak self] item in self?.uploadCompleted(item) }
        watchForAWayBack()
    }

    // MARK: the switch

    /// `GET /auth/capabilities`, once per sign-in; answers whether Documents is on. Also starts what a relaunch left.
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
            let read = try await api.documentsFolder(id)
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

    /// The rows the list shows: the search's matches while there are any words, else the folder's entries.
    var rows: [DocumentsEntry] {
        if !searchText.trimmingCharacters(in: .whitespaces).isEmpty { return searchResults ?? [] }
        return DocumentsLogic.sorted(listing?.entries ?? [])
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
            let found = try? await self.api.documentsSearch(words)
            guard !Task.isCancelled, words == self.searchText.trimmingCharacters(in: .whitespaces) else { return }
            self.searchResults = found.map { DocumentsLogic.sorted($0.entries) } ?? []
            self.learnSessions(found?.entries.map(\.lastWriter) ?? [])
        }
    }

    /// The folder's own entry, for the title.
    var folderTitle: String { DocumentsLogic.folderTitle(listing?.folder) }

    /// The one entry the inspector shows.
    var inspected: DocumentsEntry? {
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

    /// Open a file where it lives, selected (a search result, a file a sync wrote).
    func reveal(_ entry: DocumentsEntry) {
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
                if let read = try? await self.api.documentsFolder(id) { self.folderCounts[id] = read.entries.count }
            }
        }
    }

    /// Read the titles of the sessions that wrote, once each.
    private func learnSessions(_ writers: [DocumentsWriter]) {
        let missing = Set(writers.compactMap(DocumentsLogic.writerSession)).filter { sessionTitles[$0] == nil }
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
    func writerName(_ writer: DocumentsWriter) -> String {
        DocumentsLogic.writerText(writer, sessionTitle: writer.sessionId.flatMap { sessionTitles[$0] })
    }

    // MARK: the inspector

    /// What the inspector needs of a file: its path, its versions and its preview.
    func inspect(_ entry: DocumentsEntry) async {
        if let detail = try? await api.documentsEntry(entry.id) { entryDetails[entry.id] = detail }
        guard entry.isFile else { return }
        if let read = try? await api.documentsVersions(entry.id) {
            versions[entry.id] = read.versions
            learnSessions(read.versions.map(\.writer))
        }
        await loadPreview(entry)
    }

    private func previewKey(_ entry: DocumentsEntry) -> String { "\(entry.id):\(entry.currentVersionId ?? "")" }

    func preview(for entry: DocumentsEntry) -> Preview? { previews[previewKey(entry)] }

    private func loadPreview(_ entry: DocumentsEntry) async {
        let kind = DocumentsLogic.preview(name: entry.name, size: entry.sizeBytes)
        let key = previewKey(entry)
        guard kind != .none, previews[key] == nil || previews[key] == .failed else { return }
        previews[key] = .loading
        do {
            let data = try await api.documentsContent(entry.id, maxBytes: DocumentsLogic.previewBytes(kind, size: entry.sizeBytes))
            previews[key] = .data(data)
        } catch {
            previews[key] = .failed
        }
    }

    /// The file's replaced versions, newest first.
    func earlierVersions(of entry: DocumentsEntry) -> [DocumentsVersion] {
        (versions[entry.id] ?? []).filter { !$0.current }
    }

    func restoreVersion(_ version: DocumentsVersion, asCopy: Bool) async {
        do {
            let entry = try await api.documentsRestoreVersion(version.id, asCopy: asCopy)
            toast(asCopy ? DocumentsLogic.restoredAsCopy : DocumentsLogic.restoredAsCurrent, entry.name)
            await refreshAfterWrite()
        } catch {
            failed("Couldn't restore the version", error)
        }
    }

    /// The open link of a file, if it has one.
    func link(of entry: DocumentsEntry) -> DocumentsShareLink? {
        shareLinks.first { PublicID.storageKey($0.root.id) == PublicID.storageKey(entry.id) && $0.state == "ACTIVE" }
    }

    func loadShareLinks() async {
        if let links = try? await api.documentsShareLinks() { shareLinks = links }
    }

    // MARK: writes

    /// A new folder in the folder on screen, named "New folder" (a suffix if taken); answers it, to rename at once.
    func newFolder() async -> DocumentsEntry? {
        do {
            let made = try await api.documentsCreateFolder(parentID: folderID, name: DocumentsLogic.newFolderName)
            await reload()
            selection = [made.id]
            return made
        } catch {
            failed("Couldn't make the folder", error)
            return nil
        }
    }

    func rename(_ entry: DocumentsEntry, to name: String) async {
        let name = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard name != entry.name else { return }
        if let problem = DocumentsLogic.nameProblem(name) {
            onToast?("Couldn't rename \(entry.name)", problem, .error, nil)
            return
        }
        do {
            _ = try await api.documentsRename(entry.id, to: name)
            await reload()
        } catch {
            failed("Couldn't rename \(entry.name)", error)
        }
    }

    /// Move entries into a folder (nil: the root).
    func move(_ ids: [String], to folder: DocumentsEntry?) async {
        guard let target = folder?.id ?? rootID else { return }
        let entries = ids.compactMap { id in rows.first { $0.id == id } }
        var moved = 0
        for entry in entries where DocumentsLogic.canMove(entry, into: target, ancestorsOfTarget: []) {
            do {
                _ = try await api.documentsMove(entry.id, to: target)
                moved += 1
            } catch {
                failed("Couldn't move \(entry.name)", error)
            }
        }
        if moved > 0 {
            let name = folder.map { DocumentsLogic.folderTitle($0) } ?? DocumentsLogic.title
            toast(moved == 1 ? DocumentsLogic.moved(entries[0].name, to: name) : "Moved \(DocumentsLogic.items(moved)) to \(name)", nil)
        }
        await reload()
    }

    /// The root folder's id, once any listing has said it.
    @ObservationIgnored private var rootID: String?

    /// The folders a Move sheet offers under `parent` (nil: the root).
    func folders(in parent: String?) async -> (folder: DocumentsEntry, children: [DocumentsEntry])? {
        guard let read = try? await api.documentsFolder(parent) else { return nil }
        if read.folder.parentId == nil { rootID = read.folder.id }
        return (read.folder, DocumentsLogic.sorted(read.entries.filter(\.isFolder)))
    }

    /// Move to Trash, with Undo (each entry's group restored).
    func moveToTrash(_ ids: [String]) async {
        let entries = ids.compactMap { id in rows.first { $0.id == id } }
        var groups: [String] = []
        for entry in entries {
            do {
                groups.append(try await api.documentsMoveToTrash(entry.id).trashGroupId)
            } catch {
                failed("Couldn't move \(entry.name) to Trash", error)
            }
        }
        selection = []
        await reload()
        guard !groups.isEmpty else { return }
        let subtitle = entries.count == 1 ? entries[0].name : DocumentsLogic.items(entries.count)
        onToast?(DocumentsLogic.movedToTrash, subtitle, .success, { [weak self] in
            Task { @MainActor [weak self] in
                guard let self else { return }
                for group in groups { _ = try? await self.api.documentsRestoreGroup(group) }
                await self.refreshAfterWrite()
            }
        })
    }

    /// Download a file (or one version) into the Downloads folder and show it in Finder. The server mints a link that
    /// needs no login header, and the bytes stream to disk however large the file is (D12).
    func download(_ entry: DocumentsEntry, version: DocumentsVersion? = nil) async {
        #if os(macOS)
        do {
            let url = try await api.documentsDownloadURL(entry.id, versionID: version?.id)
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

    func shareCheck(_ entry: DocumentsEntry) async throws -> DocumentsShareCheck { try await api.documentsShareCheck(entry.id) }

    func share(_ entry: DocumentsEntry) async throws -> DocumentsShareAnswer {
        let answer = try await api.documentsShare(entry.id)
        await loadShareLinks()
        return answer
    }

    func stopSharing(_ link: DocumentsShareLink, name: String) async {
        do {
            try await api.documentsStopSharing(link.id)
            await loadShareLinks()
            toast("Stopped sharing", name)
        } catch {
            failed("Couldn't stop sharing", error)
        }
    }

    func publicURL(_ link: DocumentsShareLink) -> URL { DocumentsLogic.publicURL(link, base: baseURL) }

    // MARK: Trash

    func loadTrash() async {
        do {
            let groups = try await api.documentsTrash()
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
        guard let links = try? await api.documentsShareLinks() else { return }
        shareLinks = links
        var groupOf: [String: String] = [:]
        for link in links where link.state == "PAUSED" {
            if let entry = try? await api.documentsEntry(link.root.id), let group = entry.trashGroupId {
                groupOf[link.root.id] = group
            }
        }
        trashGroupOf = groupOf
    }

    func endsALink(_ group: DocumentsTrashGroup) -> Bool {
        DocumentsLogic.groupEndsALink(group, links: shareLinks, trashGroupOf: trashGroupOf)
    }

    func restore(_ group: DocumentsTrashGroup) async {
        do {
            let answer = try await api.documentsRestoreGroup(group.id)
            toast(DocumentsLogic.restored(DocumentsLogic.items(max(answer.entryIds.count, group.itemCount)), group: group), nil)
            await refreshAfterWrite()
        } catch {
            failed("Couldn't restore", error)
        }
    }

    func restore(_ item: DocumentsEntry, of group: DocumentsTrashGroup) async {
        do {
            try await api.documentsRestoreItem(groupID: group.id, entryID: item.id)
            toast(DocumentsLogic.restored(item.name, group: group), nil)
            await refreshAfterWrite()
        } catch {
            failed("Couldn't restore \(item.name)", error)
        }
    }

    func restoreVersion(of group: DocumentsTrashGroup, asCopy: Bool) async {
        guard let version = group.version else { return }
        do {
            let entry = try await api.documentsRestoreVersion(version.id, asCopy: asCopy)
            toast(asCopy ? DocumentsLogic.restoredAsCopy : DocumentsLogic.restoredAsCurrent, entry.name)
            await refreshAfterWrite()
        } catch {
            failed("Couldn't restore the version", error)
        }
    }

    func deleteForGood(_ group: DocumentsTrashGroup) async {
        do {
            try await api.documentsDeleteGroup(group.id)
            await refreshAfterWrite()
        } catch {
            failed("Couldn't delete", error)
        }
    }

    func emptyTrash() async {
        do {
            try await api.documentsEmptyTrash()
            await refreshAfterWrite()
        } catch {
            failed("Couldn't empty Trash", error)
        }
    }

    // MARK: Storage

    func loadStorage() async {
        usage = try? await api.documentsUsage()
        do {
            storage = try await api.storageUsage()
            storageError = nil
        } catch {
            storageError = APIClient.failureReason(error)
        }
    }

    // MARK: uploads

    /// Upload what was picked or dropped into `folder` (nil: the folder on screen): files, and folders whole.
    func upload(_ urls: [URL], into folder: DocumentsEntry? = nil) {
        let target = folder ?? listing?.folder
        let parentID = target.flatMap { $0.parentId == nil ? nil : $0.id }
        let requests = DocumentsUploadRequest.expand(urls, parentID: parentID, parentName: DocumentsLogic.folderTitle(target))
        queue.add(requests)
    }

    func pauseUpload(_ id: String) { queue.pause(id) }
    func resumeUpload(_ id: String) { queue.resume(id) }
    func cancelUpload(_ id: String) { queue.cancel(id) }

    /// Clear the finished uploads and hide the ended syncs on this Mac.
    func clearFinished() {
        queue.clearFinished()
        for sync in allSyncs where !sync.running { dismissedSyncs.insert(sync.id) }
        UserDefaults.standard.set(Array(dismissedSyncs), forKey: Self.dismissedKey)
        publishSyncs()
    }

    /// The toolbar's ring and popover have something to show.
    var trayShown: Bool { !uploads.isEmpty || !syncs.isEmpty }

    private func uploadsMoved() { uploads = queue.items }

    private func uploadCompleted(_ item: DocumentsUploadItem) {
        // The folder on screen reads again once a file lands in it (or in a folder under it).
        Task { await reload() }
    }

    /// A connection that came back, or a Mac that woke: what a lost connection paused goes on.
    private func watchForAWayBack() {
        #if os(macOS)
        observers.append(NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.didWakeNotification, object: nil, queue: .main) { [weak self] _ in
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

    /// `GET /documents/syncs`; while one runs, again every 5 s the app can be seen.
    func loadSyncs() async {
        guard let read = try? await api.documentsSyncs() else { return }
        let before = Dictionary(allSyncs.map { ($0.id, $0) }, uniquingKeysWith: { $1 })
        var rates: [String: Double] = [:]
        for sync in read {
            if let rate = DocumentsLogic.syncRate(previous: before[sync.id], previousRate: syncRates[sync.id], now: sync) {
                rates[sync.id] = rate
            }
        }
        syncRates = rates
        allSyncs = read
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

    /// Open the folder a sync wrote to.
    func openSyncFolder(_ sync: DocumentsSync) {
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
