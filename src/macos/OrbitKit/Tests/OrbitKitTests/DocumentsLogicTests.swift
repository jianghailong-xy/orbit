import XCTest
@testable import OrbitKit

/// Documents' reading rules (board docs/mocks/documents 03-mac, 01-ios), held to the web's src/web/src/lib/documents.ts,
/// documentsSwitch.ts, the upload tray and Trash.
final class DocumentsLogicTests: XCTestCase {
    private var utc: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        return calendar
    }

    private let now = DocumentsLogic.date("2026-11-24T15:00:00.000Z")!

    private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
        try JSONDecoder().decode(T.self, from: Data(json.utf8))
    }

    // MARK: the switch

    /// The row is drawn unless the server says `documents.enabled == false`: an older server that omits the field and
    /// a failed read count as on, as on the web. Until the read finishes it stays out.
    func testTheSidebarRowFollowsTheCapabilitiesRead() throws {
        XCTAssertFalse(DocumentsLogic.shown(nil))
        XCTAssertTrue(DocumentsLogic.shown(.success(nil)))
        XCTAssertTrue(DocumentsLogic.shown(.failure(URLError(.notConnectedToInternet))))
        let older = try decode(ServerCapabilities.self, #"{"managedRunners":{"enabled":true}}"#)
        XCTAssertNil(older.documents)
        XCTAssertTrue(DocumentsLogic.shown(.success(older)))
        let on = try decode(ServerCapabilities.self, #"{"documents":{"enabled":true}}"#)
        XCTAssertTrue(DocumentsLogic.shown(.success(on)))
        let off = try decode(ServerCapabilities.self, #"{"managedRunners":{"enabled":false},"documents":{"enabled":false}}"#)
        XCTAssertEqual(off.documents?.enabled, false)
        XCTAssertEqual(off.managedRunners?.enabled, false)
        XCTAssertFalse(DocumentsLogic.shown(.success(off)))
        let malformed = try decode(ServerCapabilities.self, #"{"documents":"yes"}"#)
        XCTAssertTrue(DocumentsLogic.shown(.success(malformed)))
    }

    /// Documents sits right under the Wiki in the Mac's source list, with no count, and only when shown.
    func testDocumentsRowSitsUnderTheWikiWithNoCount() {
        let rows = AgentListLogic.sidebarSections(AppSection.workSections, wiki: true, projectsWaiting: 2,
                                                  wikiWaiting: 3, documents: true)
        XCTAssertEqual(rows.map(\.section), [.projects, .tasks, .wiki, .documents])
        XCTAssertEqual(rows.last?.waiting, 0)
        let noWiki = AgentListLogic.sidebarSections(AppSection.workSections, wiki: false, projectsWaiting: 0,
                                                    wikiWaiting: 0, documents: true)
        XCTAssertEqual(noWiki.map(\.section), [.projects, .tasks, .documents])
        let off = AgentListLogic.sidebarSections(AppSection.workSections, wiki: true, projectsWaiting: 0,
                                                 wikiWaiting: 0, documents: false)
        XCTAssertFalse(off.map(\.section).contains(.documents))
        XCTAssertEqual(AppSection.documents.title, "Drive")
        XCTAssertEqual(AppSection.documents.systemImage, "folder")
    }

    /// The Trash and Storage rows under Documents are their own selections, and select back to themselves.
    func testTrashAndStorageAreSidebarSelectionsOfTheirOwn() {
        XCTAssertEqual(SidebarLogic.selection(section: .documents, agentID: nil, machineDraftRunnerID: nil,
                                              projectID: nil, documentsPlace: .trash), .documents(.trash))
        XCTAssertEqual(SidebarLogic.selection(section: .documents, agentID: nil, machineDraftRunnerID: nil,
                                              projectID: nil, documentsPlace: .storage), .documents(.storage))
        XCTAssertEqual(SidebarLogic.selection(section: .documents, agentID: nil, machineDraftRunnerID: nil,
                                              projectID: nil, documentsPlace: .drive), .section(.documents))
        XCTAssertEqual(SidebarLogic.selection(section: .tasks, agentID: nil, machineDraftRunnerID: nil,
                                              projectID: nil, documentsPlace: .trash), .section(.tasks))
        XCTAssertEqual(SidebarLogic.target(.documents(.storage)), .documents(.storage))
        XCTAssertEqual(SidebarLogic.target(.section(.documents)), .section(.documents))
    }

    /// `drive.changed` re-reads the page; `drive.sync` the agents' syncs as well. Neither reads the Open list.
    func testDriveEventsRouteToDocuments() throws {
        let changed = ControlEvent(type: .driveChanged, sessionId: "", agentId: nil, ts: "", data: nil)
        let sync = try decode(ControlEvent.self, #"{"type":"drive.sync","sessionId":"","ts":"t","data":{"id":"s1"}}"#)
        XCTAssertEqual(sync.type, .driveSync)
        XCTAssertEqual(ControlEventRoute.of(changed), .documents(syncs: false))
        XCTAssertEqual(ControlEventRoute.of(sync), .documents(syncs: true))
        XCTAssertFalse(ControlEventRoute.of(sync).readsOpenList)
    }

    // MARK: sizes and dates

    func testSizesAreCountedInThousandsLikeTheWeb() {
        XCTAssertEqual(DocumentsLogic.formatSize(0), "0 B")
        XCTAssertEqual(DocumentsLogic.formatSize(999), "999 B")
        XCTAssertEqual(DocumentsLogic.formatSize(1000), "1 KB")
        XCTAssertEqual(DocumentsLogic.formatSize(3_000), "3 KB")
        XCTAssertEqual(DocumentsLogic.formatSize(18_400), "18 KB")
        XCTAssertEqual(DocumentsLogic.formatSize(1_200_000), "1.2 MB")
        XCTAssertEqual(DocumentsLogic.formatSize(9_960), "10 KB")
        XCTAssertEqual(DocumentsLogic.formatSize(212_000_000), "212 MB")
        XCTAssertEqual(DocumentsLogic.formatSize(3_100_000_000), "3.1 GB")
        XCTAssertEqual(DocumentsLogic.rate(12_000_000), "12 MB/s")
        XCTAssertEqual(DocumentsLogic.timeLeft(bytesLeft: 100, rate: 10), "under a minute left")
        XCTAssertEqual(DocumentsLogic.timeLeft(bytesLeft: 1200, rate: 10), "about 2 min left")
        XCTAssertNil(DocumentsLogic.timeLeft(bytesLeft: 1200, rate: nil))
    }

    func testModifiedReadsLikeFinder() {
        let c = utc
        XCTAssertEqual(DocumentsLogic.formatWhen("2026-11-24T14:02:11.120Z", now: now, calendar: c), "14:02")
        XCTAssertEqual(DocumentsLogic.formatWhen("2026-11-23T09:00:00Z", now: now, calendar: c), "Yesterday")
        XCTAssertEqual(DocumentsLogic.formatWhen("2026-11-16T09:00:00.000Z", now: now, calendar: c), "Nov 16")
        XCTAssertEqual(DocumentsLogic.formatWhen("2025-11-16T09:00:00.000Z", now: now, calendar: c), "Nov 16, 2025")
        XCTAssertEqual(DocumentsLogic.formatWhen("not a date", now: now, calendar: c), "")
        XCTAssertEqual(DocumentsLogic.formatWhenLong("2026-11-24T14:02:00.000Z", now: now, calendar: c), "Today 14:02")
        XCTAssertEqual(DocumentsLogic.formatWhenLong("2026-11-23T09:12:00.000Z", now: now, calendar: c), "Yesterday 09:12")
        XCTAssertEqual(DocumentsLogic.formatWhenLong("2026-11-17T09:12:00.000Z", now: now, calendar: c), "Nov 17")
    }

    // MARK: a folder

    func testFoldersComeFirstThenNamesAsFinderOrdersThem() {
        let entries = [
            DocumentsEntry(id: "1", parentId: "r", kind: "FILE", name: "file10.md"),
            DocumentsEntry(id: "2", parentId: "r", kind: "FOLDER", name: "screens"),
            DocumentsEntry(id: "3", parentId: "r", kind: "FILE", name: "file2.md"),
            DocumentsEntry(id: "4", parentId: "r", kind: "FOLDER", name: "Assets"),
        ]
        XCTAssertEqual(DocumentsLogic.sorted(entries).map(\.name), ["Assets", "screens", "file2.md", "file10.md"])
    }

    func testFolderNamesAndPaths() {
        XCTAssertEqual(DocumentsLogic.folderLabel("/"), "Drive")
        XCTAssertEqual(DocumentsLogic.folderLabel("/Projects/Orbit UI migration"), "Orbit UI migration")
        XCTAssertEqual(DocumentsLogic.displayPath("/a/b.png"), "/Documents/a/b.png")
        XCTAssertEqual(DocumentsLogic.searchFolder("/"), "Drive")
        XCTAssertEqual(DocumentsLogic.searchFolder("/a/b"), "Drive/a/b")
        let root = DocumentsEntry(id: "r", parentId: nil, kind: "FOLDER", name: "")
        XCTAssertEqual(DocumentsLogic.folderTitle(root), "Drive")
        XCTAssertEqual(DocumentsLogic.folderTitle(DocumentsEntry(id: "f", parentId: "r", kind: "FOLDER", name: "out")), "out")
        let folder = DocumentsEntry(id: "f", parentId: "r", kind: "FOLDER", name: "screens")
        XCTAssertEqual(DocumentsLogic.sizeColumn(folder), "—")
        XCTAssertEqual(DocumentsLogic.sizeColumn(folder, folderCount: 9), "9 items")
        XCTAssertEqual(DocumentsLogic.sizeColumn(DocumentsEntry(id: "x", parentId: "r", kind: "FILE", name: "a", sizeBytes: 96_000)), "96 KB")
    }

    func testNamesTheServerWouldRefuseAreCaughtFirst() {
        XCTAssertNil(DocumentsLogic.nameProblem("brief.md"))
        XCTAssertNotNil(DocumentsLogic.nameProblem("  "))
        XCTAssertNotNil(DocumentsLogic.nameProblem("a/b"))
        XCTAssertNotNil(DocumentsLogic.nameProblem(".."))
    }

    func testAFolderCannotMoveIntoItselfOrUnderItself() {
        let folder = DocumentsEntry(id: "f", parentId: "r", kind: "FOLDER", name: "screens")
        XCTAssertFalse(DocumentsLogic.canMove(folder, into: "f", ancestorsOfTarget: ["r"]))
        XCTAssertFalse(DocumentsLogic.canMove(folder, into: "r", ancestorsOfTarget: []))
        XCTAssertFalse(DocumentsLogic.canMove(folder, into: "child", ancestorsOfTarget: ["r", "f"]))
        XCTAssertTrue(DocumentsLogic.canMove(folder, into: "other", ancestorsOfTarget: ["r"]))
    }

    // MARK: who wrote it

    /// Rule 6, both forms: the session's name where it was checked (and it links there), else "An agent on Orbit Cloud".
    func testWhoLastWroteAFile() {
        XCTAssertEqual(DocumentsLogic.writerText(DocumentsWriter(kind: "OWNER")), "You")
        let checked = DocumentsWriter(kind: "AGENT", sessionId: "s1", runnerId: "r1")
        XCTAssertEqual(DocumentsLogic.writerText(checked, sessionTitle: "Redesign the sign-in page\nmore"),
                       "Agent in Redesign the sign-in page")
        XCTAssertEqual(DocumentsLogic.writerText(checked), "Agent in a session")
        XCTAssertEqual(DocumentsLogic.writerSession(checked), "s1")
        let unchecked = DocumentsWriter(kind: "AGENT", sessionId: nil, runnerId: "r1")
        XCTAssertEqual(DocumentsLogic.writerText(unchecked), "An agent on Orbit Cloud")
        XCTAssertNil(DocumentsLogic.writerSession(unchecked))
        XCTAssertNil(DocumentsLogic.writerSession(DocumentsWriter(kind: "OWNER", sessionId: "s")))
    }

    // MARK: previews

    func testWhichPreviewAFileGets() {
        XCTAssertEqual(DocumentsLogic.preview(name: "sign-in-v3.png", size: 1_200_000), .picture)
        XCTAssertEqual(DocumentsLogic.preview(name: "huge.png", size: 31 * 1024 * 1024), .none)
        XCTAssertEqual(DocumentsLogic.preview(name: "migration-notes.md", size: 18_000), .markdown)
        XCTAssertEqual(DocumentsLogic.preview(name: "route-inventory.csv", size: 96_000), .text)
        XCTAssertEqual(DocumentsLogic.preview(name: "Dockerfile", size: 10), .text)
        XCTAssertEqual(DocumentsLogic.preview(name: "spec.pdf", size: 10), .pdf)
        XCTAssertEqual(DocumentsLogic.preview(name: "figma-export.zip", size: 10), .none)
        XCTAssertEqual(DocumentsLogic.previewBytes(.markdown, size: 5_000_000), DocumentsLogic.textPreviewBytes)
        XCTAssertNil(DocumentsLogic.previewBytes(.markdown, size: 5_000))
        XCTAssertNil(DocumentsLogic.previewBytes(.picture, size: 5_000_000))
        let png = DocumentsEntry(id: "1", parentId: "r", kind: "FILE", name: "a.png", sizeBytes: 1_200_000)
        XCTAssertEqual(DocumentsLogic.kindLine(png), "PNG · 1.2 MB")
        XCTAssertEqual(DocumentsLogic.systemImage(png), "photo")
        XCTAssertEqual(DocumentsLogic.systemImage(DocumentsEntry(id: "2", parentId: "r", kind: "FOLDER", name: "x")), "folder.fill")
        XCTAssertEqual(DocumentsLogic.earlierVersions(0), "None")
        XCTAssertEqual(DocumentsLogic.earlierVersions(2), "2 versions in Trash")
    }

    // MARK: decoding the server's answers

    func testAFolderListingDecodes() throws {
        let json = #"""
        {"folder":{"id":"root","parentId":null,"kind":"FOLDER","name":"","sizeBytes":0,"mtime":"2026-11-24T14:02:00.000Z",
          "currentVersionId":null,"seq":"12","createdAt":"x","updatedAt":"x",
          "lastWriter":{"kind":"OWNER","sessionId":null,"runnerId":null,"at":"2026-11-24T14:02:00.000Z"},
          "trashedAt":null,"trashGroupId":null},
         "entries":[{"id":"e1","parentId":"root","kind":"FILE","name":"sign-in-v3.png","sizeBytes":1200000,
          "mtime":"2026-11-24T14:02:00.000Z","currentVersionId":"v1","seq":4,"createdAt":"x","updatedAt":"x",
          "lastWriter":{"kind":"AGENT","sessionId":"s1","runnerId":"r1","at":"2026-11-24T14:02:00.000Z"},
          "trashedAt":null,"trashGroupId":null,"futureField":1}],
         "nextCursor":null}
        """#
        let listing = try decode(DocumentsListing.self, json)
        XCTAssertNil(listing.folder.parentId)
        XCTAssertEqual(listing.entries.first?.lastWriter.sessionId, "s1")
        XCTAssertEqual(listing.entries.first?.sizeBytes, 1_200_000)
        XCTAssertTrue(listing.entries.first?.isFile == true)
    }

    func testTrashSyncsAndShareAnswersDecode() throws {
        let trash = try decode(DocumentsTrashPage.self, #"""
        {"groups":[{"id":"g1","kind":"DELETE","folderId":"f","folderPath":"/Orbit UI migration","createdAt":"2026-11-24T14:20:00.000Z",
          "itemCount":18,"sizeBytes":46000000,"actor":{"kind":"AGENT","sessionId":null,"runnerId":"r1"},
          "items":[{"id":"e","parentId":"f","kind":"FOLDER","name":"old-screens","sizeBytes":0,"mtime":"x","currentVersionId":null,
          "seq":1,"createdAt":"x","updatedAt":"x","lastWriter":{"kind":"OWNER","sessionId":null,"runnerId":null,"at":"x"},
          "trashedAt":"x","trashGroupId":"g1"}],"version":null},
         {"id":"g2","kind":"VERSION","folderId":"f","folderPath":"/Orbit UI migration","createdAt":"2026-11-24T09:12:00.000Z",
          "itemCount":1,"sizeBytes":1100000,"actor":{"kind":"OWNER","sessionId":null,"runnerId":null},"items":[],
          "version":{"id":"v0","entryId":"e1","sizeBytes":1100000,"chunkCount":1,"createdAt":"x","current":false,
          "writer":{"kind":"OWNER","sessionId":null,"runnerId":null},"replacedAt":"x","trashGroupId":"g2",
          "entry":{"id":"e1","parentId":"f","kind":"FILE","name":"sign-in-v3.png","sizeBytes":1200000,"mtime":"x",
          "currentVersionId":"v1","seq":3,"createdAt":"x","updatedAt":"x",
          "lastWriter":{"kind":"OWNER","sessionId":null,"runnerId":null,"at":"x"},"trashedAt":null,"trashGroupId":null}}}],
         "nextCursor":null}
        """#)
        XCTAssertEqual(trash.groups.count, 2)
        XCTAssertEqual(trash.groups[1].version?.entry.name, "sign-in-v3.png")

        let syncs = try decode(DocumentsSyncList.self, #"""
        {"syncs":[{"id":"s","status":"UPLOADING","sourceName":"out","destPath":"/Reports/out","destEntryId":"d",
          "session":{"id":"x","title":"Weekly report"},"filesSeen":42,"filesTotal":42,"filesDone":12,"filesSame":0,
          "filesDeleted":0,"bytesTotal":900000000,"bytesSent":90000000,"currentPath":"charts/q3-margin.png",
          "failed":[],"failedCount":0,"error":null,"startedAt":"x","updatedAt":"x","endedAt":null}]}
        """#)
        XCTAssertTrue(syncs.syncs[0].running)

        let share = try decode(DocumentsShareAnswer.self, #"""
        {"link":{"id":"l","kind":"DRIVE_FILE","token":"tok","include":{},"expiresAt":null,"state":"ACTIVE",
          "root":{"id":"e1","title":"deploy-checklist.md","pinnedIsCurrent":true}},
         "warnings":[{"kind":"AWS access key","line":14}],"checkedBytes":7000,"partial":false}
        """#)
        XCTAssertEqual(share.warnings.first?.line, 14)
        XCTAssertEqual(DocumentsLogic.publicURL(share.link, base: URL(string: "https://orbit.example")!).absoluteString,
                       "https://orbit.example/s/tok")

        // Settings → Shared links' kinds and a drive file's sit side by side in one list: only drive files are kept.
        let links = try decode(DocumentsShareLinkList.self, #"""
        {"links":[{"id":"a","kind":"DRIVE_FILE","token":"t","state":"PAUSED","root":{"id":"e","title":"x"}},
                  {"id":"b","kind":"SESSION","token":"u","state":"ACTIVE","root":"not an object"}]}
        """#)
        XCTAssertEqual(links.links.map(\.id), ["a"])
        XCTAssertTrue(links.links[0].root.pinnedIsCurrent)
    }

    // MARK: share

    func testTheSecretWarningNamesTheShapeAndLine() {
        XCTAssertEqual(DocumentsLogic.shapeLabel("an AWS access key id"), "An AWS access key id")
        XCTAssertEqual(DocumentsLogic.shareTitle("deploy-checklist.md"), "Share a link to “deploy-checklist.md”?")
        XCTAssertEqual(DocumentsLogic.shareAnyway, "Share Anyway")
        XCTAssertEqual(DocumentsLogic.partialNote(25_000_000), "Only the first 25 MB of this file was checked for secrets.")
    }

    // MARK: Trash

    private func group(_ id: String, kind: String = "DELETE", items: [DocumentsEntry] = [], count: Int = 18,
                       bytes: Int = 46_000_000, version: DocumentsTrashVersion? = nil,
                       actor: DocumentsWriter = DocumentsWriter(kind: "AGENT", runnerId: "r")) -> DocumentsTrashGroup {
        DocumentsTrashGroup(id: id, kind: kind, folderPath: "/Orbit UI migration", createdAt: "2026-11-24T14:20:00.000Z",
                            itemCount: count, sizeBytes: bytes, actor: actor, items: items, version: version)
    }

    func testTrashGroupsReadByFolderAndTime() {
        let c = utc
        let deleted = group("g1")
        XCTAssertEqual(DocumentsLogic.groupTitle(deleted), "Orbit UI migration")
        XCTAssertEqual(DocumentsLogic.groupSubtitle(deleted, writer: DocumentsLogic.writerText(deleted.actor), now: now, calendar: c),
                       "Today 14:20 · an agent on Orbit Cloud · 18 items")
        let mine = group("g3", count: 2, actor: DocumentsWriter(kind: "OWNER"))
        XCTAssertEqual(DocumentsLogic.groupSubtitle(mine, writer: "You", now: now, calendar: c), "Today 14:20 · you · 2 items")
        let file = DocumentsEntry(id: "e1", parentId: "f", kind: "FILE", name: "sign-in-v3.png")
        let replaced = group("g2", kind: "VERSION", count: 1, bytes: 1_100_000,
                             version: DocumentsTrashVersion(id: "v0", entryId: "e1", sizeBytes: 1_100_000, createdAt: "x",
                                                            writer: DocumentsWriter(kind: "OWNER"), entry: file))
        XCTAssertEqual(DocumentsLogic.groupSubtitle(replaced, writer: "You", now: now, calendar: c), "Today 14:20 · earlier version")
        XCTAssertEqual(DocumentsLogic.trashSummary([deleted, replaced]), "19 items · 47 MB")
        XCTAssertEqual(DocumentsLogic.deleteForGoodMessage(deleted),
                       "18 items from Orbit UI migration are deleted for good. This can't be undone.")
        XCTAssertEqual(DocumentsLogic.deleteForGoodMessage(replaced),
                       "This earlier version of sign-in-v3.png is deleted for good. This can't be undone.")
        XCTAssertEqual(DocumentsLogic.emptyTrashMessage([deleted, replaced]),
                       "19 items (47 MB) are deleted for good. This can't be undone.")
    }

    /// Delete for good says when it ends a share link: a paused link on a file in the group (or deep in a folder of it),
    /// or a link pinned to the replaced version.
    func testDeletingAGroupForGoodSaysWhenItEndsALink() {
        let top = DocumentsEntry(id: "e1", parentId: "f", kind: "FILE", name: "a.md")
        let deleted = group("g1", items: [top])
        let link = DocumentsShareLink(id: "l", token: "t", state: "PAUSED",
                                      root: .init(id: "e1", title: "a.md", pinnedIsCurrent: true))
        XCTAssertTrue(DocumentsLogic.groupEndsALink(deleted, links: [link], trashGroupOf: [:]))
        let deep = DocumentsShareLink(id: "l2", token: "t", state: "PAUSED", root: .init(id: "deep", title: nil, pinnedIsCurrent: true))
        XCTAssertTrue(DocumentsLogic.groupEndsALink(deleted, links: [deep], trashGroupOf: ["deep": "g1"]))
        XCTAssertFalse(DocumentsLogic.groupEndsALink(deleted, links: [deep], trashGroupOf: ["deep": "other"]))
        let replaced = group("g2", kind: "VERSION", version: DocumentsTrashVersion(
            id: "v0", entryId: "e9", sizeBytes: 1, createdAt: "x", writer: DocumentsWriter(kind: "OWNER"), entry: top))
        let pinnedEarlier = DocumentsShareLink(id: "l3", token: "t", root: .init(id: "e9", title: nil, pinnedIsCurrent: false))
        let pinnedNow = DocumentsShareLink(id: "l4", token: "t", root: .init(id: "e9", title: nil, pinnedIsCurrent: true))
        XCTAssertTrue(DocumentsLogic.groupEndsALink(replaced, links: [pinnedEarlier], trashGroupOf: [:]))
        XCTAssertFalse(DocumentsLogic.groupEndsALink(replaced, links: [pinnedNow], trashGroupOf: [:]))
    }

    // MARK: Storage

    func testStorageReadsTheAccountTotalAndTheDrivesShare() {
        let gib = 1024 * 1024 * 1024
        let usage = DocumentsUsage(totalBytes: 18 * gib, driveBytes: 12 * gib, trashBytes: gib, otherBytes: 6 * gib)
        let bar = DocumentsLogic.storageBar(usage)
        XCTAssertEqual(bar.documents, 11.0 / 18.0, accuracy: 0.0001)
        XCTAssertEqual(bar.trash, 1.0 / 18.0, accuracy: 0.0001)
        XCTAssertEqual(bar.other, 6.0 / 18.0, accuracy: 0.0001)
        XCTAssertEqual(DocumentsLogic.storageLegend(usage), ["Drive 11.0 GB", "Trash 1.0 GB", "Other 6.0 GB"])
        XCTAssertNil(DocumentsLogic.storeWarning(usage))
        let near = DocumentsUsage(totalBytes: 1, driveBytes: 1, trashBytes: 0, otherBytes: 0, storeUsedBytes: 85,
                                  storeQuotaBytes: 100, nearQuota: true)
        XCTAssertEqual(DocumentsLogic.storeWarning(near),
                       "Drive storage is 85% full. Uploads stop at 100%. Ask the operator to raise the limit.")
        let full = DocumentsUsage(totalBytes: 1, driveBytes: 1, trashBytes: 0, otherBytes: 0, storeUsedBytes: 100,
                                  storeQuotaBytes: 100, nearQuota: true)
        XCTAssertEqual(DocumentsLogic.storeWarning(full), "The drive's storage is full. Ask the operator to raise the limit.")
        XCTAssertEqual(DocumentsLogic.weekLabel("2026-11-16"), "Week of Nov 16")
        XCTAssertEqual(DocumentsLogic.weekLabel("2026-01-05"), "Week of Jan 5")
        let stored = StorageUsage(totalBytes: 2 * gib, fileCount: 1204, quotaBytes: 2 * gib)
        XCTAssertEqual(DocumentsLogic.storedValue(stored), "2.0 GB of 2.0 GB · 1,204 files")
        XCTAssertTrue(DocumentsLogic.storageFull(stored))
    }

    // MARK: the uploads popover

    private func upload(_ state: DocumentsUploadState, size: Int, sent: Int, rate: Double? = nil,
                        error: String? = nil, relative: String? = nil) -> DocumentsUploadItem {
        DocumentsUploadItem(id: UUID().uuidString, name: "holiday.mov", size: size, modifiedAt: 0, filePath: "/tmp/x",
                            parentID: "v", parentName: "Videos", relativePath: relative, sentBytes: sent, state: state,
                            error: error, rate: rate)
    }

    func testThePopoverHeadingCountsUploadsAndSyncsTogether() {
        let going = upload(.uploading, size: 800_000_000, sent: 310_000_000)
        let done = upload(.done, size: 100_000_000, sent: 100_000_000)
        let sync = DocumentsSync(id: "s", status: "UPLOADING", sourceName: "out", destPath: "/Reports/out",
                                 bytesTotal: 800_000_000, bytesSent: 0)
        XCTAssertEqual(DocumentsLogic.trayTitle([done, going], [sync]), "Uploading 2 of 3 · 410 MB of 1.7 GB")
        XCTAssertEqual(DocumentsLogic.trayTotals([done, going], [sync]).fraction, 410.0 / 1700.0, accuracy: 0.0001)
        XCTAssertEqual(DocumentsLogic.trayTitle([done, done], []), "Uploaded 2 files")
        let synced = DocumentsSync(id: "s", status: "DONE", sourceName: "out", destPath: "/Reports/out")
        XCTAssertEqual(DocumentsLogic.trayTitle([], [synced]), "Synced 1 folder")
        XCTAssertEqual(DocumentsLogic.trayTitle([done], [synced]), "Finished 2 of 2")
    }

    func testAnUploadsLineSaysWhatItIsDoing() {
        XCTAssertEqual(DocumentsLogic.uploadStatus(upload(.uploading, size: 800_000_000, sent: 310_000_000, rate: 12_000_000)),
                       "310 MB of 800 MB · 12 MB/s · under a minute left")
        XCTAssertEqual(DocumentsLogic.uploadStatus(upload(.queued, size: 3_000, sent: 0)), "Waiting · 3 KB")
        XCTAssertEqual(DocumentsLogic.uploadStatus(upload(.paused, size: 1000, sent: 630)), "Paused · 63%")
        XCTAssertEqual(DocumentsLogic.uploadStatus(upload(.paused, size: 1000, sent: 630, error: "Connection lost.")),
                       "Connection lost. 630 B of 1 KB is kept; it goes on from there.")
        XCTAssertEqual(DocumentsLogic.uploadStatus(upload(.failed, size: 1, sent: 0, error: "Your storage is full.")),
                       "Your storage is full.")
        XCTAssertEqual(DocumentsLogic.uploadStatus(upload(.done, size: 3_000, sent: 3_000)), "Uploaded · 3 KB")
        XCTAssertEqual(DocumentsLogic.uploadDestination(upload(.queued, size: 1, sent: 0)), "Videos")
        XCTAssertEqual(DocumentsLogic.uploadDestination(upload(.queued, size: 1, sent: 0, relative: "Dir/sub/a.png")), "Dir/sub")
    }

    /// An agent's sync is one row with the web tray's words; Details lists what failed.
    func testASyncRowReadsLikeTheWebTray() {
        var sync = DocumentsSync(id: "s", status: "CHECKING", sourceName: "out", destPath: "/Reports/out", filesSeen: 1200)
        XCTAssertEqual(DocumentsLogic.syncStatus(sync), "Checking files… 1,200 so far")
        XCTAssertNil(DocumentsLogic.syncFraction(sync))
        XCTAssertEqual(DocumentsLogic.syncTitle(sync).source, "out/")
        XCTAssertEqual(DocumentsLogic.syncTitle(sync).destination, "Reports/out")
        sync = DocumentsSync(id: "s", status: "UPLOADING", sourceName: "out", destPath: "/Reports/out", filesTotal: 42,
                             filesDone: 12, bytesTotal: 900_000_000, bytesSent: 90_000_000)
        XCTAssertEqual(DocumentsLogic.syncStatus(sync, rate: 8_000_000),
                       "12 of 42 files · 90 MB of 900 MB · 8 MB/s · about 2 min left")
        XCTAssertEqual(DocumentsLogic.syncFraction(sync)!, 0.1, accuracy: 0.0001)
        let failed = DocumentsSync(id: "s", status: "DONE", sourceName: "data", destPath: "/Datasets", filesDone: 30,
                                   failed: [.init(path: "a.csv", error: "too large")], failedCount: 3,
                                   endedAt: "2026-11-24T14:05:00.000Z")
        XCTAssertEqual(DocumentsLogic.syncStatus(failed), "Synced 30 files · 3 failed")
        XCTAssertTrue(DocumentsLogic.syncHasFailures(failed))
        XCTAssertEqual(DocumentsLogic.syncMoreFailures(failed), "and 2 more")
        XCTAssertEqual(DocumentsLogic.openFolder(failed), "Open Datasets")
        XCTAssertEqual(DocumentsLogic.syncDetailsTitle(failed), "data/ → /Datasets")
        XCTAssertEqual(DocumentsLogic.syncDetailsSummary(failed, calendar: utc),
                       "Synced 30 files at 14:05. 3 files didn't upload. Ask the agent to run the sync again; it only sends what's still missing.")
        let same = DocumentsSync(id: "s", status: "DONE", sourceName: "out", destPath: "/o", filesSame: 4, filesDeleted: 1)
        XCTAssertEqual(DocumentsLogic.syncStatus(same), "Already up to date · 4 files · 1 moved to Trash")
        let stopped = DocumentsSync(id: "s", status: "STOPPED", sourceName: "out", destPath: "/o", filesDone: 3)
        XCTAssertEqual(DocumentsLogic.syncStatus(stopped), "Stopped · 3 of ? files synced")
        XCTAssertEqual(DocumentsLogic.syncStatus(DocumentsSync(id: "s", status: "FAILED", sourceName: "o", destPath: "/o",
                                                               error: "The runner went offline.")),
                       "The runner went offline.")
    }

    func testASyncsRateIsTheBytesBetweenTwoReads() {
        let a = DocumentsSync(id: "s", status: "UPLOADING", sourceName: "o", destPath: "/o", bytesSent: 0,
                              updatedAt: "2026-11-24T14:00:00.000Z")
        let b = DocumentsSync(id: "s", status: "UPLOADING", sourceName: "o", destPath: "/o", bytesSent: 10_000,
                              updatedAt: "2026-11-24T14:00:10.000Z")
        XCTAssertEqual(DocumentsLogic.syncRate(previous: a, previousRate: nil, now: b), 1000)
        XCTAssertEqual(DocumentsLogic.syncRate(previous: b, previousRate: 1000, now: b), 1000)
        XCTAssertNil(DocumentsLogic.syncRate(previous: nil, previousRate: nil, now: b))
    }
}
