import XCTest
@testable import OrbitKit

/// Drive' reading rules (board docs/mocks/drive 03-mac, 01-ios), held to the web's src/web/src/lib/drive.ts,
/// driveSwitch.ts, the upload tray and Trash.
final class DriveLogicTests: XCTestCase {
    private var utc: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        return calendar
    }

    private let now = DriveLogic.date("2026-11-24T15:00:00.000Z")!

    private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
        try JSONDecoder().decode(T.self, from: Data(json.utf8))
    }

    // MARK: the switch

    /// The row is drawn unless the server says `documents.enabled == false`: an older server that omits the field and
    /// a failed read count as on, as on the web. Until the read finishes it stays out.
    func testTheSidebarRowFollowsTheCapabilitiesRead() throws {
        XCTAssertFalse(DriveLogic.shown(nil))
        XCTAssertTrue(DriveLogic.shown(.success(nil)))
        XCTAssertTrue(DriveLogic.shown(.failure(URLError(.notConnectedToInternet))))
        let older = try decode(ServerCapabilities.self, #"{"managedRunners":{"enabled":true}}"#)
        XCTAssertNil(older.documents)
        XCTAssertTrue(DriveLogic.shown(.success(older)))
        let on = try decode(ServerCapabilities.self, #"{"documents":{"enabled":true}}"#)
        XCTAssertTrue(DriveLogic.shown(.success(on)))
        let off = try decode(ServerCapabilities.self, #"{"managedRunners":{"enabled":false},"documents":{"enabled":false}}"#)
        XCTAssertEqual(off.documents?.enabled, false)
        XCTAssertEqual(off.managedRunners?.enabled, false)
        XCTAssertFalse(DriveLogic.shown(.success(off)))
        let malformed = try decode(ServerCapabilities.self, #"{"documents":"yes"}"#)
        XCTAssertTrue(DriveLogic.shown(.success(malformed)))
    }

    /// Documents sits right under the Wiki in the Mac's source list, with no count, and only when shown.
    func testDriveRowSitsUnderTheWikiWithNoCount() {
        let rows = AgentListLogic.sidebarSections(AppSection.workSections, wiki: true, projectsWaiting: 2,
                                                  wikiWaiting: 3, drive: true)
        XCTAssertEqual(rows.map(\.section), [.projects, .tasks, .wiki, .drive])
        XCTAssertEqual(rows.last?.waiting, 0)
        let noWiki = AgentListLogic.sidebarSections(AppSection.workSections, wiki: false, projectsWaiting: 0,
                                                    wikiWaiting: 0, drive: true)
        XCTAssertEqual(noWiki.map(\.section), [.projects, .tasks, .drive])
        let off = AgentListLogic.sidebarSections(AppSection.workSections, wiki: true, projectsWaiting: 0,
                                                 wikiWaiting: 0, drive: false)
        XCTAssertFalse(off.map(\.section).contains(.drive))
        XCTAssertEqual(AppSection.drive.title, "Drive")
        XCTAssertEqual(AppSection.drive.systemImage, "folder")
    }

    /// The Trash and Storage rows under Drive are their own selections, and select back to themselves.
    func testTrashAndStorageAreSidebarSelectionsOfTheirOwn() {
        XCTAssertEqual(SidebarLogic.selection(section: .drive, agentID: nil, machineDraftRunnerID: nil,
                                              projectID: nil, drivePlace: .trash), .drive(.trash))
        XCTAssertEqual(SidebarLogic.selection(section: .drive, agentID: nil, machineDraftRunnerID: nil,
                                              projectID: nil, drivePlace: .storage), .drive(.storage))
        XCTAssertEqual(SidebarLogic.selection(section: .drive, agentID: nil, machineDraftRunnerID: nil,
                                              projectID: nil, drivePlace: .drive), .section(.drive))
        XCTAssertEqual(SidebarLogic.selection(section: .tasks, agentID: nil, machineDraftRunnerID: nil,
                                              projectID: nil, drivePlace: .trash), .section(.tasks))
        XCTAssertEqual(SidebarLogic.target(.drive(.storage)), .drive(.storage))
        XCTAssertEqual(SidebarLogic.target(.section(.drive)), .section(.drive))
    }

    /// `drive.changed` re-reads the page; `drive.sync` the agents' syncs as well. Neither reads the Open list.
    func testDriveEventsRouteToDocuments() throws {
        let changed = ControlEvent(type: .driveChanged, sessionId: "", agentId: nil, ts: "", data: nil)
        let sync = try decode(ControlEvent.self, #"{"type":"drive.sync","sessionId":"","ts":"t","data":{"id":"s1"}}"#)
        XCTAssertEqual(sync.type, .driveSync)
        XCTAssertEqual(ControlEventRoute.of(changed), .drive(syncs: false))
        XCTAssertEqual(ControlEventRoute.of(sync), .drive(syncs: true))
        XCTAssertFalse(ControlEventRoute.of(sync).readsOpenList)
    }

    // MARK: sizes and dates

    func testSizesAreCountedInThousandsLikeTheWeb() {
        XCTAssertEqual(DriveLogic.formatSize(0), "0 B")
        XCTAssertEqual(DriveLogic.formatSize(999), "999 B")
        XCTAssertEqual(DriveLogic.formatSize(1000), "1 KB")
        XCTAssertEqual(DriveLogic.formatSize(3_000), "3 KB")
        XCTAssertEqual(DriveLogic.formatSize(18_400), "18 KB")
        XCTAssertEqual(DriveLogic.formatSize(1_200_000), "1.2 MB")
        XCTAssertEqual(DriveLogic.formatSize(9_960), "10 KB")
        XCTAssertEqual(DriveLogic.formatSize(212_000_000), "212 MB")
        XCTAssertEqual(DriveLogic.formatSize(3_100_000_000), "3.1 GB")
        XCTAssertEqual(DriveLogic.rate(12_000_000), "12 MB/s")
        XCTAssertEqual(DriveLogic.timeLeft(bytesLeft: 100, rate: 10), "under a minute left")
        XCTAssertEqual(DriveLogic.timeLeft(bytesLeft: 1200, rate: 10), "about 2 min left")
        XCTAssertNil(DriveLogic.timeLeft(bytesLeft: 1200, rate: nil))
    }

    func testModifiedReadsLikeFinder() {
        let c = utc
        XCTAssertEqual(DriveLogic.formatWhen("2026-11-24T14:02:11.120Z", now: now, calendar: c), "14:02")
        XCTAssertEqual(DriveLogic.formatWhen("2026-11-23T09:00:00Z", now: now, calendar: c), "Yesterday")
        XCTAssertEqual(DriveLogic.formatWhen("2026-11-16T09:00:00.000Z", now: now, calendar: c), "Nov 16")
        XCTAssertEqual(DriveLogic.formatWhen("2025-11-16T09:00:00.000Z", now: now, calendar: c), "Nov 16, 2025")
        XCTAssertEqual(DriveLogic.formatWhen("not a date", now: now, calendar: c), "")
        XCTAssertEqual(DriveLogic.formatWhenLong("2026-11-24T14:02:00.000Z", now: now, calendar: c), "Today 14:02")
        XCTAssertEqual(DriveLogic.formatWhenLong("2026-11-23T09:12:00.000Z", now: now, calendar: c), "Yesterday 09:12")
        XCTAssertEqual(DriveLogic.formatWhenLong("2026-11-17T09:12:00.000Z", now: now, calendar: c), "Nov 17")
    }

    // MARK: a folder

    func testFoldersComeFirstThenNamesAsFinderOrdersThem() {
        let entries = [
            DriveEntry(id: "1", parentId: "r", kind: "FILE", name: "file10.md"),
            DriveEntry(id: "2", parentId: "r", kind: "FOLDER", name: "screens"),
            DriveEntry(id: "3", parentId: "r", kind: "FILE", name: "file2.md"),
            DriveEntry(id: "4", parentId: "r", kind: "FOLDER", name: "Assets"),
        ]
        XCTAssertEqual(DriveLogic.sorted(entries).map(\.name), ["Assets", "screens", "file2.md", "file10.md"])
    }

    func testFolderNamesAndPaths() {
        XCTAssertEqual(DriveLogic.folderLabel("/"), "Drive")
        XCTAssertEqual(DriveLogic.folderLabel("/Projects/Orbit UI migration"), "Orbit UI migration")
        XCTAssertEqual(DriveLogic.displayPath("/a/b.png"), "/Drive/a/b.png")
        XCTAssertEqual(DriveLogic.searchFolder("/"), "Drive")
        XCTAssertEqual(DriveLogic.searchFolder("/a/b"), "Drive/a/b")
        let root = DriveEntry(id: "r", parentId: nil, kind: "FOLDER", name: "")
        XCTAssertEqual(DriveLogic.folderTitle(root), "Drive")
        XCTAssertEqual(DriveLogic.folderTitle(DriveEntry(id: "f", parentId: "r", kind: "FOLDER", name: "out")), "out")
        let folder = DriveEntry(id: "f", parentId: "r", kind: "FOLDER", name: "screens")
        XCTAssertEqual(DriveLogic.sizeColumn(folder), "—")
        XCTAssertEqual(DriveLogic.sizeColumn(folder, folderCount: 9), "9 items")
        XCTAssertEqual(DriveLogic.sizeColumn(DriveEntry(id: "x", parentId: "r", kind: "FILE", name: "a", sizeBytes: 96_000)), "96 KB")
    }

    func testNamesTheServerWouldRefuseAreCaughtFirst() {
        XCTAssertNil(DriveLogic.nameProblem("brief.md"))
        XCTAssertNotNil(DriveLogic.nameProblem("  "))
        XCTAssertNotNil(DriveLogic.nameProblem("a/b"))
        XCTAssertNotNil(DriveLogic.nameProblem(".."))
    }

    func testAFolderCannotMoveIntoItselfOrUnderItself() {
        let folder = DriveEntry(id: "f", parentId: "r", kind: "FOLDER", name: "screens")
        XCTAssertFalse(DriveLogic.canMove(folder, into: "f", ancestorsOfTarget: ["r"]))
        XCTAssertFalse(DriveLogic.canMove(folder, into: "r", ancestorsOfTarget: []))
        XCTAssertFalse(DriveLogic.canMove(folder, into: "child", ancestorsOfTarget: ["r", "f"]))
        XCTAssertTrue(DriveLogic.canMove(folder, into: "other", ancestorsOfTarget: ["r"]))
    }

    // MARK: who wrote it

    /// Rule 6, both forms: the session's name where it was checked (and it links there), else "An agent on Orbit Cloud".
    func testWhoLastWroteAFile() {
        XCTAssertEqual(DriveLogic.writerText(DriveWriter(kind: "OWNER")), "You")
        let checked = DriveWriter(kind: "AGENT", sessionId: "s1", runnerId: "r1")
        XCTAssertEqual(DriveLogic.writerText(checked, sessionTitle: "Redesign the sign-in page\nmore"),
                       "Agent in Redesign the sign-in page")
        XCTAssertEqual(DriveLogic.writerText(checked), "Agent in a session")
        XCTAssertEqual(DriveLogic.writerSession(checked), "s1")
        let unchecked = DriveWriter(kind: "AGENT", sessionId: nil, runnerId: "r1")
        XCTAssertEqual(DriveLogic.writerText(unchecked), "An agent on Orbit Cloud")
        XCTAssertNil(DriveLogic.writerSession(unchecked))
        XCTAssertNil(DriveLogic.writerSession(DriveWriter(kind: "OWNER", sessionId: "s")))
    }

    // MARK: previews

    func testWhichPreviewAFileGets() {
        XCTAssertEqual(DriveLogic.preview(name: "sign-in-v3.png", size: 1_200_000), .picture)
        XCTAssertEqual(DriveLogic.preview(name: "huge.png", size: 31 * 1024 * 1024), .none)
        XCTAssertEqual(DriveLogic.preview(name: "migration-notes.md", size: 18_000), .markdown)
        XCTAssertEqual(DriveLogic.preview(name: "route-inventory.csv", size: 96_000), .text)
        XCTAssertEqual(DriveLogic.preview(name: "Dockerfile", size: 10), .text)
        XCTAssertEqual(DriveLogic.preview(name: "spec.pdf", size: 10), .pdf)
        XCTAssertEqual(DriveLogic.preview(name: "figma-export.zip", size: 10), .none)
        XCTAssertEqual(DriveLogic.previewBytes(.markdown, size: 5_000_000), DriveLogic.textPreviewBytes)
        XCTAssertNil(DriveLogic.previewBytes(.markdown, size: 5_000))
        XCTAssertNil(DriveLogic.previewBytes(.picture, size: 5_000_000))
        let png = DriveEntry(id: "1", parentId: "r", kind: "FILE", name: "a.png", sizeBytes: 1_200_000)
        XCTAssertEqual(DriveLogic.kindLine(png), "PNG · 1.2 MB")
        XCTAssertEqual(DriveLogic.systemImage(png), "photo")
        XCTAssertEqual(DriveLogic.systemImage(DriveEntry(id: "2", parentId: "r", kind: "FOLDER", name: "x")), "folder.fill")
        XCTAssertEqual(DriveLogic.earlierVersions(0), "None")
        XCTAssertEqual(DriveLogic.earlierVersions(2), "2 versions in Trash")
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
        let listing = try decode(DriveListing.self, json)
        XCTAssertNil(listing.folder.parentId)
        XCTAssertEqual(listing.entries.first?.lastWriter.sessionId, "s1")
        XCTAssertEqual(listing.entries.first?.sizeBytes, 1_200_000)
        XCTAssertTrue(listing.entries.first?.isFile == true)
    }

    func testTrashSyncsAndShareAnswersDecode() throws {
        let trash = try decode(DriveTrashPage.self, #"""
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

        let syncs = try decode(DriveSyncList.self, #"""
        {"syncs":[{"id":"s","status":"UPLOADING","sourceName":"out","destPath":"/Reports/out","destEntryId":"d",
          "session":{"id":"x","title":"Weekly report"},"filesSeen":42,"filesTotal":42,"filesDone":12,"filesSame":0,
          "filesDeleted":0,"bytesTotal":900000000,"bytesSent":90000000,"currentPath":"charts/q3-margin.png",
          "failed":[],"failedCount":0,"error":null,"startedAt":"x","updatedAt":"x","endedAt":null}]}
        """#)
        XCTAssertTrue(syncs.syncs[0].running)

        let share = try decode(DriveShareAnswer.self, #"""
        {"link":{"id":"l","kind":"DRIVE_FILE","token":"tok","include":{},"expiresAt":null,"state":"ACTIVE",
          "root":{"id":"e1","title":"deploy-checklist.md","pinnedIsCurrent":true}},
         "warnings":[{"kind":"AWS access key","line":14}],"checkedBytes":7000,"partial":false}
        """#)
        XCTAssertEqual(share.warnings.first?.line, 14)
        XCTAssertEqual(DriveLogic.publicURL(share.link, base: URL(string: "https://orbit.example")!).absoluteString,
                       "https://orbit.example/s/tok")

        // Settings → Shared links' kinds and a drive file's sit side by side in one list: only drive files are kept.
        let links = try decode(DriveShareLinkList.self, #"""
        {"links":[{"id":"a","kind":"DRIVE_FILE","token":"t","state":"PAUSED","root":{"id":"e","title":"x"}},
                  {"id":"b","kind":"SESSION","token":"u","state":"ACTIVE","root":"not an object"}]}
        """#)
        XCTAssertEqual(links.links.map(\.id), ["a"])
        XCTAssertTrue(links.links[0].root.pinnedIsCurrent)
    }

    // MARK: share

    func testTheSecretWarningNamesTheShapeAndLine() {
        XCTAssertEqual(DriveLogic.shapeLabel("an AWS access key id"), "An AWS access key id")
        XCTAssertEqual(DriveLogic.shareTitle("deploy-checklist.md"), "Share a link to “deploy-checklist.md”?")
        XCTAssertEqual(DriveLogic.shareAnyway, "Share Anyway")
        XCTAssertEqual(DriveLogic.partialNote(25_000_000), "Only the first 25 MB of this file was checked for secrets.")
    }

    // MARK: Trash

    private func group(_ id: String, kind: String = "DELETE", items: [DriveEntry] = [], count: Int = 18,
                       bytes: Int = 46_000_000, version: DriveTrashVersion? = nil,
                       actor: DriveWriter = DriveWriter(kind: "AGENT", runnerId: "r")) -> DriveTrashGroup {
        DriveTrashGroup(id: id, kind: kind, folderPath: "/Orbit UI migration", createdAt: "2026-11-24T14:20:00.000Z",
                            itemCount: count, sizeBytes: bytes, actor: actor, items: items, version: version)
    }

    func testTrashGroupsReadByFolderAndTime() {
        let c = utc
        let deleted = group("g1")
        XCTAssertEqual(DriveLogic.groupTitle(deleted), "Orbit UI migration")
        XCTAssertEqual(DriveLogic.groupSubtitle(deleted, writer: DriveLogic.writerText(deleted.actor), now: now, calendar: c),
                       "Today 14:20 · an agent on Orbit Cloud · 18 items")
        let mine = group("g3", count: 2, actor: DriveWriter(kind: "OWNER"))
        XCTAssertEqual(DriveLogic.groupSubtitle(mine, writer: "You", now: now, calendar: c), "Today 14:20 · you · 2 items")
        let file = DriveEntry(id: "e1", parentId: "f", kind: "FILE", name: "sign-in-v3.png")
        let replaced = group("g2", kind: "VERSION", count: 1, bytes: 1_100_000,
                             version: DriveTrashVersion(id: "v0", entryId: "e1", sizeBytes: 1_100_000, createdAt: "x",
                                                            writer: DriveWriter(kind: "OWNER"), entry: file))
        XCTAssertEqual(DriveLogic.groupSubtitle(replaced, writer: "You", now: now, calendar: c), "Today 14:20 · earlier version")
        XCTAssertEqual(DriveLogic.trashSummary([deleted, replaced]), "19 items · 47 MB")
        XCTAssertEqual(DriveLogic.deleteForGoodMessage(deleted),
                       "18 items from Orbit UI migration are deleted for good. This can't be undone.")
        XCTAssertEqual(DriveLogic.deleteForGoodMessage(replaced),
                       "This earlier version of sign-in-v3.png is deleted for good. This can't be undone.")
        XCTAssertEqual(DriveLogic.emptyTrashMessage([deleted, replaced]),
                       "19 items (47 MB) are deleted for good. This can't be undone.")
    }

    /// Delete for good says when it ends a share link: a paused link on a file in the group (or deep in a folder of it),
    /// or a link pinned to the replaced version.
    func testDeletingAGroupForGoodSaysWhenItEndsALink() {
        let top = DriveEntry(id: "e1", parentId: "f", kind: "FILE", name: "a.md")
        let deleted = group("g1", items: [top])
        let link = DriveShareLink(id: "l", token: "t", state: "PAUSED",
                                      root: .init(id: "e1", title: "a.md", pinnedIsCurrent: true))
        XCTAssertTrue(DriveLogic.groupEndsALink(deleted, links: [link], trashGroupOf: [:]))
        let deep = DriveShareLink(id: "l2", token: "t", state: "PAUSED", root: .init(id: "deep", title: nil, pinnedIsCurrent: true))
        XCTAssertTrue(DriveLogic.groupEndsALink(deleted, links: [deep], trashGroupOf: ["deep": "g1"]))
        XCTAssertFalse(DriveLogic.groupEndsALink(deleted, links: [deep], trashGroupOf: ["deep": "other"]))
        let replaced = group("g2", kind: "VERSION", version: DriveTrashVersion(
            id: "v0", entryId: "e9", sizeBytes: 1, createdAt: "x", writer: DriveWriter(kind: "OWNER"), entry: top))
        let pinnedEarlier = DriveShareLink(id: "l3", token: "t", root: .init(id: "e9", title: nil, pinnedIsCurrent: false))
        let pinnedNow = DriveShareLink(id: "l4", token: "t", root: .init(id: "e9", title: nil, pinnedIsCurrent: true))
        XCTAssertTrue(DriveLogic.groupEndsALink(replaced, links: [pinnedEarlier], trashGroupOf: [:]))
        XCTAssertFalse(DriveLogic.groupEndsALink(replaced, links: [pinnedNow], trashGroupOf: [:]))
    }

    // MARK: Storage

    func testStorageReadsTheAccountTotalAndTheDrivesShare() {
        let gib = 1024 * 1024 * 1024
        let usage = DriveUsage(totalBytes: 18 * gib, driveBytes: 12 * gib, trashBytes: gib, otherBytes: 6 * gib)
        let bar = DriveLogic.storageBar(usage)
        XCTAssertEqual(bar.drive, 11.0 / 18.0, accuracy: 0.0001)
        XCTAssertEqual(bar.trash, 1.0 / 18.0, accuracy: 0.0001)
        XCTAssertEqual(bar.other, 6.0 / 18.0, accuracy: 0.0001)
        XCTAssertEqual(DriveLogic.storageLegend(usage), ["Drive 11.0 GB", "Trash 1.0 GB", "Other 6.0 GB"])
        XCTAssertNil(DriveLogic.storeWarning(usage))
        let near = DriveUsage(totalBytes: 1, driveBytes: 1, trashBytes: 0, otherBytes: 0, storeUsedBytes: 85,
                                  storeQuotaBytes: 100, nearQuota: true)
        XCTAssertEqual(DriveLogic.storeWarning(near),
                       "Drive storage is 85% full. Uploads stop at 100%. Ask the operator to raise the limit.")
        let full = DriveUsage(totalBytes: 1, driveBytes: 1, trashBytes: 0, otherBytes: 0, storeUsedBytes: 100,
                                  storeQuotaBytes: 100, nearQuota: true)
        XCTAssertEqual(DriveLogic.storeWarning(full), "The drive's storage is full. Ask the operator to raise the limit.")
        XCTAssertEqual(DriveLogic.weekLabel("2026-11-16"), "Week of Nov 16")
        XCTAssertEqual(DriveLogic.weekLabel("2026-01-05"), "Week of Jan 5")
        let stored = StorageUsage(totalBytes: 2 * gib, fileCount: 1204, quotaBytes: 2 * gib)
        XCTAssertEqual(DriveLogic.storedValue(stored), "2.0 GB of 2.0 GB · 1,204 files")
        XCTAssertTrue(DriveLogic.storageFull(stored))
    }

    // MARK: the uploads popover

    private func upload(_ state: DriveUploadState, size: Int, sent: Int, rate: Double? = nil,
                        error: String? = nil, relative: String? = nil) -> DriveUploadItem {
        DriveUploadItem(id: UUID().uuidString, name: "holiday.mov", size: size, modifiedAt: 0, filePath: "/tmp/x",
                            parentID: "v", parentName: "Videos", relativePath: relative, sentBytes: sent, state: state,
                            error: error, rate: rate)
    }

    func testThePopoverHeadingCountsUploadsAndSyncsTogether() {
        let going = upload(.uploading, size: 800_000_000, sent: 310_000_000)
        let done = upload(.done, size: 100_000_000, sent: 100_000_000)
        let sync = DriveSync(id: "s", status: "UPLOADING", sourceName: "out", destPath: "/Reports/out",
                                 bytesTotal: 800_000_000, bytesSent: 0)
        XCTAssertEqual(DriveLogic.trayTitle([done, going], [sync]), "Uploading 2 of 3 · 410 MB of 1.7 GB")
        XCTAssertEqual(DriveLogic.trayTotals([done, going], [sync]).fraction, 410.0 / 1700.0, accuracy: 0.0001)
        XCTAssertEqual(DriveLogic.trayTitle([done, done], []), "Uploaded 2 files")
        let synced = DriveSync(id: "s", status: "DONE", sourceName: "out", destPath: "/Reports/out")
        XCTAssertEqual(DriveLogic.trayTitle([], [synced]), "Synced 1 folder")
        XCTAssertEqual(DriveLogic.trayTitle([done], [synced]), "Finished 2 of 2")
    }

    func testAnUploadsLineSaysWhatItIsDoing() {
        XCTAssertEqual(DriveLogic.uploadStatus(upload(.uploading, size: 800_000_000, sent: 310_000_000, rate: 12_000_000)),
                       "310 MB of 800 MB · 12 MB/s · under a minute left")
        XCTAssertEqual(DriveLogic.uploadStatus(upload(.queued, size: 3_000, sent: 0)), "Waiting · 3 KB")
        XCTAssertEqual(DriveLogic.uploadStatus(upload(.paused, size: 1000, sent: 630)), "Paused · 63%")
        XCTAssertEqual(DriveLogic.uploadStatus(upload(.paused, size: 1000, sent: 630, error: "Connection lost.")),
                       "Connection lost. 630 B of 1 KB is kept; it goes on from there.")
        XCTAssertEqual(DriveLogic.uploadStatus(upload(.failed, size: 1, sent: 0, error: "Your storage is full.")),
                       "Your storage is full.")
        XCTAssertEqual(DriveLogic.uploadStatus(upload(.done, size: 3_000, sent: 3_000)), "Uploaded · 3 KB")
        XCTAssertEqual(DriveLogic.uploadDestination(upload(.queued, size: 1, sent: 0)), "Videos")
        XCTAssertEqual(DriveLogic.uploadDestination(upload(.queued, size: 1, sent: 0, relative: "Dir/sub/a.png")), "Dir/sub")
    }

    /// An agent's sync is one row with the web tray's words; Details lists what failed.
    func testASyncRowReadsLikeTheWebTray() {
        var sync = DriveSync(id: "s", status: "CHECKING", sourceName: "out", destPath: "/Reports/out", filesSeen: 1200)
        XCTAssertEqual(DriveLogic.syncStatus(sync), "Checking files… 1,200 so far")
        XCTAssertNil(DriveLogic.syncFraction(sync))
        XCTAssertEqual(DriveLogic.syncTitle(sync).source, "out/")
        XCTAssertEqual(DriveLogic.syncTitle(sync).destination, "Reports/out")
        sync = DriveSync(id: "s", status: "UPLOADING", sourceName: "out", destPath: "/Reports/out", filesTotal: 42,
                             filesDone: 12, bytesTotal: 900_000_000, bytesSent: 90_000_000)
        XCTAssertEqual(DriveLogic.syncStatus(sync, rate: 8_000_000),
                       "12 of 42 files · 90 MB of 900 MB · 8 MB/s · about 2 min left")
        XCTAssertEqual(DriveLogic.syncFraction(sync)!, 0.1, accuracy: 0.0001)
        let failed = DriveSync(id: "s", status: "DONE", sourceName: "data", destPath: "/Datasets", filesDone: 30,
                                   failed: [.init(path: "a.csv", error: "too large")], failedCount: 3,
                                   endedAt: "2026-11-24T14:05:00.000Z")
        XCTAssertEqual(DriveLogic.syncStatus(failed), "Synced 30 files · 3 failed")
        XCTAssertTrue(DriveLogic.syncHasFailures(failed))
        XCTAssertEqual(DriveLogic.syncMoreFailures(failed), "and 2 more")
        XCTAssertEqual(DriveLogic.openFolder(failed), "Open Datasets")
        XCTAssertEqual(DriveLogic.syncDetailsTitle(failed), "data/ → /Datasets")
        XCTAssertEqual(DriveLogic.syncDetailsSummary(failed, calendar: utc),
                       "Synced 30 files at 14:05. 3 files didn't upload. Ask the agent to run the sync again; it only sends what's still missing.")
        let same = DriveSync(id: "s", status: "DONE", sourceName: "out", destPath: "/o", filesSame: 4, filesDeleted: 1)
        XCTAssertEqual(DriveLogic.syncStatus(same), "Already up to date · 4 files · 1 moved to Trash")
        let stopped = DriveSync(id: "s", status: "STOPPED", sourceName: "out", destPath: "/o", filesDone: 3)
        XCTAssertEqual(DriveLogic.syncStatus(stopped), "Stopped · 3 of ? files synced")
        XCTAssertEqual(DriveLogic.syncStatus(DriveSync(id: "s", status: "FAILED", sourceName: "o", destPath: "/o",
                                                               error: "The runner went offline.")),
                       "The runner went offline.")
    }

    func testASyncsRateIsTheBytesBetweenTwoReads() {
        let a = DriveSync(id: "s", status: "UPLOADING", sourceName: "o", destPath: "/o", bytesSent: 0,
                              updatedAt: "2026-11-24T14:00:00.000Z")
        let b = DriveSync(id: "s", status: "UPLOADING", sourceName: "o", destPath: "/o", bytesSent: 10_000,
                              updatedAt: "2026-11-24T14:00:10.000Z")
        XCTAssertEqual(DriveLogic.syncRate(previous: a, previousRate: nil, now: b), 1000)
        XCTAssertEqual(DriveLogic.syncRate(previous: b, previousRate: 1000, now: b), 1000)
        XCTAssertNil(DriveLogic.syncRate(previous: nil, previousRate: nil, now: b))
    }
}
