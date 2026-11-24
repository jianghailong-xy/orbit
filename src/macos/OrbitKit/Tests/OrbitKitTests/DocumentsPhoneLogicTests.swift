import XCTest
@testable import OrbitKit

/// How the phone's Documents pages read (board docs/mocks/documents/01-ios.png): the drawer row, a row's second line,
/// a file's page, Trash's rows, the composer's picker paths and a reply's link to a drive file.
final class DocumentsPhoneLogicTests: XCTestCase {
    private var utc: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        return calendar
    }

    private let now = DocumentsLogic.date("2026-11-24T15:00:00.000Z")!

    // MARK: the drawer (frame 1)

    /// Documents sits right under the Wiki with no count, keeps that place when the Wiki is off, and is absent while
    /// the server has it off.
    func testTheDrawerDrawsDocumentsUnderTheWiki() {
        XCTAssertEqual(DrawerWorkLogic.rows(AppSection.workSections, wiki: true, scheduled: true, documents: true),
                       [.projects, .section(.tasks), .scheduled, .wiki, .section(.documents), .workspacesHeader,
                        .agents, .openProjects, .sharedWithMe])
        XCTAssertEqual(DrawerWorkLogic.rows(AppSection.workSections, wiki: false, documents: true),
                       [.projects, .section(.tasks), .section(.documents), .workspacesHeader, .agents,
                        .openProjects, .sharedWithMe])
        XCTAssertFalse(DrawerWorkLogic.rows(AppSection.workSections, wiki: true).contains(.section(.documents)))
    }

    // MARK: rows (frames 2-3)

    func testARowsSecondLineSaysWhenAsTheBoardWritesIt() {
        let c = utc
        XCTAssertEqual(DocumentsLogic.folderLine(count: 14, mtime: "2026-11-24T14:02:00.000Z", now: now, calendar: c),
                       "14 items · today 14:02")
        XCTAssertEqual(DocumentsLogic.folderLine(count: 2, mtime: "2026-11-17T10:00:00.000Z", now: now, calendar: c),
                       "2 items · Nov 17")
        XCTAssertEqual(DocumentsLogic.folderLine(count: nil, mtime: "2026-11-23T10:00:00.000Z", now: now, calendar: c),
                       "yesterday")
        XCTAssertEqual(DocumentsLogic.folderLine(count: 1, mtime: "", now: now, calendar: c), "1 item")
        XCTAssertEqual(DocumentsLogic.fileLineWhen("2026-11-24T11:40:00.000Z", now: now, calendar: c), " · 11:40")
        XCTAssertEqual(DocumentsLogic.fileLineWhen("2026-11-23T11:40:00.000Z", now: now, calendar: c), " · yesterday")
        XCTAssertEqual(DocumentsLogic.fileLineWhen("2026-11-16T11:40:00.000Z", now: now, calendar: c), " · Nov 16")
        XCTAssertEqual(DocumentsLogic.fileLineWhen("", now: now, calendar: c), "")
    }

    // MARK: a file's page (frames 4-5, 12)

    func testAFilesPageNamesItsKindSizeAndWriter() {
        let png = DocumentsEntry(id: "e", parentId: "f", kind: "FILE", name: "sign-in-v3.png", sizeBytes: 1_200_000)
        XCTAssertEqual(DocumentsLogic.fileFacts(png, pixels: (1179, 2556), folder: "Orbit UI migration"),
                       "PNG · 1.2 MB · 1179 × 2556 · Orbit UI migration")
        let md = DocumentsEntry(id: "m", parentId: "f", kind: "FILE", name: "migration-notes.md", sizeBytes: 18_000)
        XCTAssertEqual(DocumentsLogic.fileFacts(md), "Markdown · 18 KB")
        XCTAssertEqual(DocumentsLogic.kindName("Makefile"), "File")
        XCTAssertEqual(DocumentsLogic.lastWrittenBy("2026-11-24T14:02:00.000Z", now: now, calendar: utc),
                       "Last written today 14:02 by")
        XCTAssertEqual(DocumentsLogic.lastWrittenBy("2026-11-16T14:02:00.000Z", now: now, calendar: utc),
                       "Last written Nov 16 by")
        XCTAssertNil(DocumentsLogic.earlierVersionsCount(0))
        XCTAssertEqual(DocumentsLogic.earlierVersionsCount(2), "2 in Trash")
        let version = DocumentsVersion(id: "v", entryId: "e", sizeBytes: 1_100_000, createdAt: "2026-11-18T09:00:00.000Z",
                                       current: false, writer: DocumentsWriter(kind: "OWNER"))
        XCTAssertEqual(DocumentsLogic.versionLine(version, writer: "You", now: now, calendar: utc), "Nov 18 · 1.1 MB · You")
        XCTAssertEqual(DocumentsLogic.versionWhereNow("sign-in-v3.png", folder: "Orbit UI migration"),
                       "“sign-in-v3.png” is in Orbit UI migration now.")
    }

    // MARK: move (frame 7)

    func testTheMoveSheetSaysWhatMovesAndWhere() {
        XCTAssertEqual(DocumentsLogic.moveTitle(["migration-notes.md"]), "Move “migration-notes.md”")
        XCTAssertEqual(DocumentsLogic.moveTitle(["a", "b", "c"]), "Move 3 items")
        XCTAssertEqual(DocumentsLogic.moveHere("Notes"), "Move to Notes")
        XCTAssertEqual(DocumentsLogic.trail(["Documents", "Drive service"]), "Documents › Drive service")
    }

    // MARK: Trash (frame 11)

    func testTrashRowsSayWhatWentAndWho() {
        let group = DocumentsTrashGroup(id: "g", kind: "DELETE", folderPath: "/Orbit UI migration",
                                        createdAt: "2026-11-24T14:20:00.000Z", itemCount: 18, sizeBytes: 46_000_000,
                                        actor: DocumentsWriter(kind: "AGENT", runnerId: "r"), items: [], version: nil)
        XCTAssertEqual(DocumentsLogic.trashHeading(group, now: now, calendar: utc), "Orbit UI migration · Today 14:20")
        let folder = DocumentsEntry(id: "f", parentId: "p", kind: "FOLDER", name: "old-screens")
        XCTAssertEqual(DocumentsLogic.trashLine(folder, in: group, writer: DocumentsLogic.uncheckedAgent, folderCount: 18),
                       "Folder · 18 items · 46 MB · by an agent on Orbit Cloud")
        let file = DocumentsEntry(id: "x", parentId: "p", kind: "FILE", name: "labels-old.csv")
        XCTAssertEqual(DocumentsLogic.trashLine(file, in: group, writer: "You"), "Deleted by you")
        XCTAssertEqual(DocumentsLogic.trashVersionLine(group, writer: "Agent in Redesign the sign-in page", now: now, calendar: utc),
                       "Earlier version · replaced 14:20 by Agent in Redesign the sign-in page")
    }

    // MARK: the composer's picker (frame 14)

    /// What goes into the message is the file's path on the agent's mount; the picker opens on the project's folder.
    func testAPickedFileIsItsPathOnTheAgentsMount() {
        XCTAssertEqual(DocumentsLogic.agentPath(folders: ["Orbit UI migration"], name: "migration-notes.md"),
                       "/home/orbit/Documents/Orbit UI migration/migration-notes.md")
        XCTAssertEqual(DocumentsLogic.agentPath(folders: [], name: "brief.md"), "/home/orbit/Documents/brief.md")
        XCTAssertEqual(DocumentsLogic.agentPath(entryPath: "/Datasets/labels.csv", name: "labels.csv"),
                       "/home/orbit/Documents/Datasets/labels.csv")
        XCTAssertEqual(DocumentsLogic.agentPath(entryPath: nil, name: "x.md"), "/home/orbit/Documents/x.md")
        XCTAssertEqual(DocumentsLogic.projectFolderName("Docs/site redesign "), "Docs-site redesign")
        let entries = [DocumentsEntry(id: "a", parentId: "r", kind: "FOLDER", name: "Orbit UI migration-35a1"),
                       DocumentsEntry(id: "b", parentId: "r", kind: "FILE", name: "Orbit UI migration")]
        XCTAssertEqual(DocumentsLogic.projectFolder(entries, projectID: "35a1XYZ", title: "Orbit UI migration")?.id, "a")
        XCTAssertNil(DocumentsLogic.projectFolder(entries, projectID: "99", title: "Orbit UI migration"))
        XCTAssertEqual(DocumentsLogic.pickerAdd(0), "Add")
        XCTAssertEqual(DocumentsLogic.pickerAdd(1), "Add 1")
    }

    // MARK: a reply's link (frame 15)

    func testAReplysDocumentLinkIsReadAndDrawnAsTheFile() {
        XCTAssertEqual(DocumentsLogic.linkedEntryID("orbit-document:abc123"), "abc123")
        XCTAssertEqual(DocumentsLogic.linkedEntryID(" orbit-drive:abc123 extra"), "abc123")
        XCTAssertEqual(DocumentsLogic.linkedEntryID("ORBIT-DOCUMENT:Q1"), "Q1")
        XCTAssertNil(DocumentsLogic.linkedEntryID("orbit-document:"))
        XCTAssertNil(DocumentsLogic.linkedEntryID("orbit-task:abc"))
        XCTAssertNil(DocumentsLogic.linkedEntryID("https://example.com"))
        let file = DocumentsEntry(id: "e", parentId: "f", kind: "FILE", name: "sign-in-v3.png", sizeBytes: 1_200_000,
                                  path: "/Orbit UI migration/sign-in-v3.png")
        XCTAssertEqual(DocumentsLogic.cardLine(file), "Documents › Orbit UI migration · 1.2 MB")
        let top = DocumentsEntry(id: "t", parentId: "r", kind: "FILE", name: "a.md", sizeBytes: 3_000, path: "/a.md")
        XCTAssertEqual(DocumentsLogic.cardLine(top), "Documents · 3 KB")
        let folder = DocumentsEntry(id: "d", parentId: "r", kind: "FOLDER", name: "Datasets", path: "/Reports/Datasets")
        XCTAssertEqual(DocumentsLogic.cardLine(folder), "Documents › Reports")
        XCTAssertEqual(DocumentsLogic.cardGone(trashed: false), "No longer in Documents · moved or deleted")
    }
}
