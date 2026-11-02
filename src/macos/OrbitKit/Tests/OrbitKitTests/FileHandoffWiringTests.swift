import Foundation
import XCTest

/// What a tap on a file may do on a Mac.
///
/// `FileHandoff` hands on bytes and a name that came from somebody else. It lives in the app target,
/// which does not compile on Linux, so what it does is asserted over the source, the way
/// `RunnerArtifactWiringTests` does, and each assertion is written so that cutting the wire turns it
/// red. What a Mac does with a file is not something a test here can see: it was measured on one.
final class FileHandoffWiringTests: XCTestCase {

    private static let handoff = "src/macos/OrbitApp/Sources/OrbitApp/Views/FileHandoff.swift"

    private func root() throws -> URL {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<12 {
            if FileManager.default.fileExists(atPath: dir.appendingPathComponent(Self.handoff).path) {
                return dir
            }
            dir = dir.deletingLastPathComponent()
        }
        throw NSError(domain: "FileHandoffWiringTests", code: 1)
    }

    private func source(_ relative: String) throws -> String {
        try String(contentsOf: root().appendingPathComponent(relative), encoding: .utf8)
    }

    /// One function's own stretch of the file, so a match elsewhere cannot answer for it.
    private func deliver() throws -> String {
        let file = try source(Self.handoff)
        let start = try XCTUnwrap(file.range(of: "static func deliver("))
        let end = try XCTUnwrap(file.range(of: "private static func markAsDownloaded",
                                           range: start.upperBound..<file.endIndex))
        return String(file[start.lowerBound..<end.lowerBound])
    }

    private func offset(of needle: String, in haystack: String) throws -> Int {
        let range = try XCTUnwrap(haystack.range(of: needle), "`\(needle)` is gone")
        return haystack.distance(from: haystack.startIndex, to: range.lowerBound)
    }

    /// The list is the whole decision, so it is written out here too: a new entry has to be a
    /// deliberate edit of two files, after opening that type on a real Mac and seeing that only a
    /// viewer starts.
    func testATapOpensPicturesPDFsAndPlainTextAndNothingElse() throws {
        let file = try source(Self.handoff)
        let start = try XCTUnwrap(file.range(of: "opensFromATap: Set<String> = ["))
        let end = try XCTUnwrap(file.range(of: "]", range: start.upperBound..<file.endIndex))
        let entries = try NSRegularExpression(pattern: #""([^"]+)""#)
        let list = String(file[start.upperBound..<end.lowerBound])
        let found = entries.matches(in: list, range: NSRange(list.startIndex..., in: list)).map {
            String(list[Range($0.range(at: 1), in: list)!])
        }
        XCTAssertEqual(Set(found), [
            "png", "jpg", "jpeg", "gif", "webp", "heic", "heif", "avif", "bmp", "tif", "tiff", "ico",
            "pdf",
            "txt", "text", "md", "markdown", "log",
        ])
        XCTAssertEqual(found.count, Set(found).count, "the list names an extension twice")
    }

    /// The name that decides is the one the file ended up with, not the one that arrived, and it
    /// decides in any case.
    func testTheDecisionReadsTheWrittenFile() throws {
        XCTAssertTrue(try deliver().contains("opensFromATap.contains(file.pathExtension.lowercased())"))
    }

    /// Everything off the list is shown and left alone, and the open is reachable only past the list.
    func testAFileOffTheListIsShownAndNotOpened() throws {
        let body = try deliver()
        let guardLine = try offset(of: "guard opensFromATap.contains(", in: body)
        let shown = try offset(of: "NSWorkspace.shared.activateFileViewerSelecting([file])", in: body)
        let open = try offset(of: "return NSWorkspace.shared.open(file)", in: body)
        XCTAssertLessThan(guardLine, shown)
        XCTAssertLessThan(shown, open)
        let between = String(body.dropFirst(guardLine).prefix(open - guardLine))
        XCTAssertFalse(between.contains("NSWorkspace.shared.open("), "a file off the list reaches an open")
        XCTAssertEqual(body.components(separatedBy: "NSWorkspace.shared.open(").count - 1, 1,
                       "a second open has appeared beside the one the list guards")
    }

    /// A file on a Mac carries the mark before anything else happens to it, and a file that cannot be
    /// marked goes no further. iOS has no such mark, and its share sheet is the system's own.
    func testEveryFileIsMarkedBeforeItIsHandedOn() throws {
        let body = try deliver()
        let write = try offset(of: "try data.write(to: file, options: .atomic)", in: body)
        let mark = try offset(of: "try markAsDownloaded(file)", in: body)
        let caught = try offset(of: "} catch {", in: body)
        let decide = try offset(of: "guard opensFromATap.contains(", in: body)
        XCTAssertLessThan(write, mark)
        XCTAssertLessThan(mark, caught, "a failure to mark no longer ends the handoff")
        XCTAssertLessThan(caught, decide)

        let file = try source(Self.handoff)
        let helper = try XCTUnwrap(file.range(of: "private static func markAsDownloaded"))
        let rest = String(file[helper.lowerBound...])
        XCTAssertTrue(rest.contains("values.quarantineProperties = ["))
        XCTAssertTrue(rest.contains("try file.setResourceValues(values)"))
        XCTAssertTrue(body.contains("UIActivityViewController(activityItems: [file]"),
                      "the iPhone's share sheet is no longer what a tap shows there")
    }

    /// Finder shows this folder to the reader, and the name in it is not one Orbit chose.
    func testFilesLandInAFolderOfTheirOwn() throws {
        let body = try deliver()
        XCTAssertTrue(body.contains(#".appendingPathComponent("Orbit Files", isDirectory: true)"#))
        XCTAssertTrue(body.contains("folder.appendingPathComponent(safeName(name))"))
        XCTAssertFalse(body.contains("temporaryDirectory.appendingPathComponent(safeName"))
    }

    /// A reader who tapped a file and got a Finder window is told why, on every surface that can tap.
    func testEverySurfaceSaysSoWhenAFileIsOnlyShown() throws {
        let surfaces = [
            "src/macos/OrbitApp/Sources/OrbitApp/Views/Console/AttachmentViews.swift": 2,
            "src/macos/OrbitApp/Sources/OrbitApp/Views/MarkdownView.swift": 2,
            "src/macos/OrbitApp/Sources/OrbitApp/Views/WorktreeFilePreview.swift": 1,
        ]
        for (path, count) in surfaces {
            let text = try source(path)
            XCTAssertEqual(text.components(separatedBy: "FileHandoff.deliver(").count - 1, count, path)
            let told = try NSRegularExpression(pattern: #"FileHandoff\.deliver\([^\n]*, app: app\)"#)
            XCTAssertEqual(told.numberOfMatches(in: text, range: NSRange(text.startIndex..., in: text)), count, path)
        }
        XCTAssertTrue(try deliver().contains("app?.showToast(\"Shown in Finder\""))
    }

    /// Nothing else in the Mac app hands a file to the system. A new door has to come through
    /// `FileHandoff`, or be read here first: the second entry is the app's one opener for a URL.
    func testTheMacAppHasNoOtherDoor() throws {
        let sources = try root().appendingPathComponent("src/macos/OrbitApp/Sources")
        let walker = try XCTUnwrap(FileManager.default.enumerator(at: sources, includingPropertiesForKeys: nil))
        var doors: [String: Int] = [:]
        for case let url as URL in walker where url.pathExtension == "swift" {
            let count = try String(contentsOf: url, encoding: .utf8)
                .components(separatedBy: "NSWorkspace.shared.open").count - 1
            if count > 0 { doors[url.lastPathComponent] = count }
        }
        XCTAssertEqual(doors, ["FileHandoff.swift": 1, "OrbitLinkCards.swift": 1])
    }
}
