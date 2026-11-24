import XCTest
@testable import OrbitKit

/// How the phone's Drive pages read (board docs/mocks/drive/01-ios.png): the drawer row, a row's second line,
/// a file's page, Trash's rows, the composer's picker paths and a reply's link to a drive file.
final class DrivePhoneLogicTests: XCTestCase {
    private var utc: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        return calendar
    }

    private let now = DriveLogic.date("2026-11-24T15:00:00.000Z")!

    // MARK: the drawer (frame 1)

    /// Documents sits right under the Wiki with no count, keeps that place when the Wiki is off, and is absent while
    /// the server has it off.
    func testTheDrawerDrawsDriveUnderTheWiki() {
        XCTAssertEqual(DrawerWorkLogic.rows(AppSection.workSections, wiki: true, scheduled: true, drive: true),
                       [.projects, .section(.tasks), .scheduled, .wiki, .section(.drive), .workspacesHeader,
                        .agents, .openProjects, .sharedWithMe])
        XCTAssertEqual(DrawerWorkLogic.rows(AppSection.workSections, wiki: false, drive: true),
                       [.projects, .section(.tasks), .section(.drive), .workspacesHeader, .agents,
                        .openProjects, .sharedWithMe])
        XCTAssertFalse(DrawerWorkLogic.rows(AppSection.workSections, wiki: true).contains(.section(.drive)))
    }

    // MARK: rows (frames 2-3)

    func testARowsSecondLineSaysWhenAsTheBoardWritesIt() {
        let c = utc
        XCTAssertEqual(DriveLogic.folderLine(count: 14, mtime: "2026-11-24T14:02:00.000Z", now: now, calendar: c),
                       "14 items · today 14:02")
        XCTAssertEqual(DriveLogic.folderLine(count: 2, mtime: "2026-11-17T10:00:00.000Z", now: now, calendar: c),
                       "2 items · Nov 17")
        XCTAssertEqual(DriveLogic.folderLine(count: nil, mtime: "2026-11-23T10:00:00.000Z", now: now, calendar: c),
                       "yesterday")
        XCTAssertEqual(DriveLogic.folderLine(count: 1, mtime: "", now: now, calendar: c), "1 item")
        XCTAssertEqual(DriveLogic.fileLineWhen("2026-11-24T11:40:00.000Z", now: now, calendar: c), " · 11:40")
        XCTAssertEqual(DriveLogic.fileLineWhen("2026-11-23T11:40:00.000Z", now: now, calendar: c), " · yesterday")
        XCTAssertEqual(DriveLogic.fileLineWhen("2026-11-16T11:40:00.000Z", now: now, calendar: c), " · Nov 16")
        XCTAssertEqual(DriveLogic.fileLineWhen("", now: now, calendar: c), "")
    }

    // MARK: a file's page (frames 4-5, 12)

    func testAFilesPageNamesItsKindSizeAndWriter() {
        let png = DriveEntry(id: "e", parentId: "f", kind: "FILE", name: "sign-in-v3.png", sizeBytes: 1_200_000)
        XCTAssertEqual(DriveLogic.fileFacts(png, pixels: (1179, 2556), folder: "Orbit UI migration"),
                       "PNG · 1.2 MB · 1179 × 2556 · Orbit UI migration")
        let md = DriveEntry(id: "m", parentId: "f", kind: "FILE", name: "migration-notes.md", sizeBytes: 18_000)
        XCTAssertEqual(DriveLogic.fileFacts(md), "Markdown · 18 KB")
        XCTAssertEqual(DriveLogic.kindName("Makefile"), "File")
        XCTAssertEqual(DriveLogic.lastWrittenBy("2026-11-24T14:02:00.000Z", now: now, calendar: utc),
                       "Last written today 14:02 by")
        XCTAssertEqual(DriveLogic.lastWrittenBy("2026-11-16T14:02:00.000Z", now: now, calendar: utc),
                       "Last written Nov 16 by")
        XCTAssertNil(DriveLogic.earlierVersionsCount(0))
        XCTAssertEqual(DriveLogic.earlierVersionsCount(2), "2 in Trash")
        let version = DriveVersion(id: "v", entryId: "e", sizeBytes: 1_100_000, createdAt: "2026-11-18T09:00:00.000Z",
                                       current: false, writer: DriveWriter(kind: "OWNER"))
        XCTAssertEqual(DriveLogic.versionLine(version, writer: "You", now: now, calendar: utc), "Nov 18 · 1.1 MB · You")
        XCTAssertEqual(DriveLogic.versionWhereNow("sign-in-v3.png", folder: "Orbit UI migration"),
                       "“sign-in-v3.png” is in Orbit UI migration now.")
    }

    // MARK: move (frame 7)

    func testTheMoveSheetSaysWhatMovesAndWhere() {
        XCTAssertEqual(DriveLogic.moveTitle(["migration-notes.md"]), "Move “migration-notes.md”")
        XCTAssertEqual(DriveLogic.moveTitle(["a", "b", "c"]), "Move 3 items")
        XCTAssertEqual(DriveLogic.moveHere("Notes"), "Move to Notes")
        XCTAssertEqual(DriveLogic.trail(["Drive", "Drive service"]), "Drive › Drive service")
    }

    // MARK: Trash (frame 11)

    func testTrashRowsSayWhatWentAndWho() {
        let group = DriveTrashGroup(id: "g", kind: "DELETE", folderPath: "/Orbit UI migration",
                                        createdAt: "2026-11-24T14:20:00.000Z", itemCount: 18, sizeBytes: 46_000_000,
                                        actor: DriveWriter(kind: "AGENT", runnerId: "r"), items: [], version: nil)
        XCTAssertEqual(DriveLogic.trashHeading(group, now: now, calendar: utc), "Orbit UI migration · Today 14:20")
        let folder = DriveEntry(id: "f", parentId: "p", kind: "FOLDER", name: "old-screens")
        XCTAssertEqual(DriveLogic.trashLine(folder, in: group, writer: DriveLogic.uncheckedAgent, folderCount: 18),
                       "Folder · 18 items · 46 MB · by an agent on Orbit Cloud")
        let file = DriveEntry(id: "x", parentId: "p", kind: "FILE", name: "labels-old.csv")
        XCTAssertEqual(DriveLogic.trashLine(file, in: group, writer: "You"), "Deleted by you")
        XCTAssertEqual(DriveLogic.trashVersionLine(group, writer: "Agent in Redesign the sign-in page", now: now, calendar: utc),
                       "Earlier version · replaced 14:20 by Agent in Redesign the sign-in page")
    }

    // MARK: the composer's picker (frame 14)

    /// What goes into the message is the file's path on the agent's mount; the picker opens on the project's folder.
    func testAPickedFileIsItsPathOnTheAgentsMount() {
        XCTAssertEqual(DriveLogic.agentPath(folders: ["Orbit UI migration"], name: "migration-notes.md"),
                       "/home/orbit/Drive/Orbit UI migration/migration-notes.md")
        XCTAssertEqual(DriveLogic.agentPath(folders: [], name: "brief.md"), "/home/orbit/Drive/brief.md")
        XCTAssertEqual(DriveLogic.agentPath(entryPath: "/Datasets/labels.csv", name: "labels.csv"),
                       "/home/orbit/Drive/Datasets/labels.csv")
        XCTAssertEqual(DriveLogic.agentPath(entryPath: nil, name: "x.md"), "/home/orbit/Drive/x.md")
        XCTAssertEqual(DriveLogic.projectFolderName("Docs/site redesign "), "Docs-site redesign")
        let entries = [DriveEntry(id: "a", parentId: "r", kind: "FOLDER", name: "Orbit UI migration-35a1"),
                       DriveEntry(id: "b", parentId: "r", kind: "FILE", name: "Orbit UI migration")]
        XCTAssertEqual(DriveLogic.projectFolder(entries, projectID: "35a1XYZ", title: "Orbit UI migration")?.id, "a")
        XCTAssertNil(DriveLogic.projectFolder(entries, projectID: "99", title: "Orbit UI migration"))
        XCTAssertEqual(DriveLogic.pickerAdd(0), "Add")
        XCTAssertEqual(DriveLogic.pickerAdd(1), "Add 1")
    }

    // MARK: a reply's link (frame 15)

    func testAReplysDocumentLinkIsReadAndDrawnAsTheFile() {
        XCTAssertEqual(DriveLogic.linkedEntryID("orbit-document:abc123"), "abc123")
        XCTAssertEqual(DriveLogic.linkedEntryID(" orbit-drive:abc123 extra"), "abc123")
        XCTAssertEqual(DriveLogic.linkedEntryID("ORBIT-DOCUMENT:Q1"), "Q1")
        XCTAssertNil(DriveLogic.linkedEntryID("orbit-document:"))
        XCTAssertNil(DriveLogic.linkedEntryID("orbit-task:abc"))
        XCTAssertNil(DriveLogic.linkedEntryID("https://example.com"))
        let file = DriveEntry(id: "e", parentId: "f", kind: "FILE", name: "sign-in-v3.png", sizeBytes: 1_200_000,
                                  path: "/Orbit UI migration/sign-in-v3.png")
        XCTAssertEqual(DriveLogic.cardLine(file), "Drive › Orbit UI migration · 1.2 MB")
        let top = DriveEntry(id: "t", parentId: "r", kind: "FILE", name: "a.md", sizeBytes: 3_000, path: "/a.md")
        XCTAssertEqual(DriveLogic.cardLine(top), "Drive · 3 KB")
        let folder = DriveEntry(id: "d", parentId: "r", kind: "FOLDER", name: "Datasets", path: "/Reports/Datasets")
        XCTAssertEqual(DriveLogic.cardLine(folder), "Drive › Reports")
        XCTAssertEqual(DriveLogic.cardGone(trashed: false), "No longer in Drive · moved or deleted")
    }

    /// A paragraph's drive links are found with their words; an image, a task link and a plain URL are not.
    func testAParagraphsDriveLinksAreFound() {
        let text = "I saved [sign-in-v3.png](orbit-document:e1) and [notes](orbit-drive:e2 \"t\"), " +
            "not ![x](orbit-document:e3), [a task](orbit-task:t1) or [site](https://x.test)."
        let found = DriveLogic.linkMatches(in: text)
        XCTAssertEqual(found.map(\.entryID), ["e1", "e2"])
        XCTAssertEqual(found.map(\.label), ["sign-in-v3.png", "notes"])
        XCTAssertEqual(String(text[found[0].range]), "[sign-in-v3.png](orbit-document:e1)")
        XCTAssertTrue(DriveLogic.linkMatches(in: "no links here").isEmpty)
    }
}
