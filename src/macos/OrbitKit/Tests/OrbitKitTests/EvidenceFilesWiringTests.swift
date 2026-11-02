import Foundation
import XCTest
@testable import OrbitKit

/// The wires between `EvidenceFiles` and the SwiftUI that draws it. SwiftUI does not exist on Linux and
/// these files compile only in the macOS and iOS jobs, so what the views do with the reading is asserted
/// over the source, each assertion written so that cutting the wire turns it red.
///
/// What it cannot see is how any of it looks. That is what the simulator's pictures are for.
final class EvidenceFilesWiringTests: XCTestCase {

    private static let viewsPath = "src/macos/OrbitApp/Sources/OrbitApp/Views/EvidenceFilesViews.swift"
    private static let cardPath = "src/macos/OrbitApp/Sources/OrbitApp/Views/ApprovalCards.swift"
    private static let consolePath = "src/macos/OrbitApp/Sources/OrbitApp/ConsoleModel.swift"
    private static let consoleViewPath = "src/macos/OrbitApp/Sources/OrbitApp/Views/Console/ConsoleView.swift"
    private static let reviewPath = "src/macos/OrbitApp/Sources/OrbitApp/Views/ApprovalReview.swift"
    private static let viewerPath = "src/macos/OrbitApp/Sources/OrbitApp/Views/Console/ImageViewer.swift"

    private func source(_ relative: String) throws -> String {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<12 {
            let candidate = dir.appendingPathComponent(relative)
            if FileManager.default.fileExists(atPath: candidate.path) {
                return try String(contentsOf: candidate, encoding: .utf8)
            }
            dir = dir.deletingLastPathComponent()
        }
        XCTFail("\(relative) was not found above this test. If it moved, move this check with it.")
        return ""
    }

    private func section(_ source: String, from: String, to: String) throws -> String {
        let start = try XCTUnwrap(source.range(of: from), "`\(from)` is gone")
        let end = try XCTUnwrap(source.range(of: to, range: start.upperBound..<source.endIndex), "`\(to)` is gone")
        return String(source[start.lowerBound..<end.lowerBound])
    }

    private func offset(of needle: String, in haystack: String) throws -> Int {
        let range = try XCTUnwrap(haystack.range(of: needle), "`\(needle)` is gone")
        return haystack.distance(from: haystack.startIndex, to: range.lowerBound)
    }

    private func facts() throws -> String {
        try section(try source(Self.cardPath), from: "private struct EvidenceDecisionFacts: View",
                    to: "// MARK: body")
    }

    // MARK: the card

    /// With no FILE citation the area is not built, so there is nothing to draw and no read to make.
    func testTheAreaIsBuiltOnlyForAVersionThatCitesAFile() throws {
        let facts = try facts()
        let gate = try offset(of: "if EvidenceFiles.citesFiles(row.citations) {", in: facts)
        let area = try offset(of: "EvidenceFilesArea(console: console", in: facts)
        XCTAssertLessThan(gate, area)
        XCTAssertEqual(facts.components(separatedBy: "EvidenceFilesArea(").count - 1, 1,
                       "a second area has appeared outside the gate")
    }

    /// Under what it is measured against, over what it does not establish (§2.6).
    func testTheAreaSitsUnderTheStandardAndOverTheGaps() throws {
        let facts = try facts()
        XCTAssertLessThan(try offset(of: "standardBlock", in: facts), try offset(of: "EvidenceFilesArea(", in: facts))
        XCTAssertLessThan(try offset(of: "EvidenceFilesArea(", in: facts), try offset(of: "gapsBlock", in: facts))
    }

    /// The read is made from the area, and the area is the one way to it.
    func testOnlyTheAreaAndItsPageReadTheList() throws {
        let views = try source(Self.viewsPath)
        XCTAssertTrue(views.contains("await console.readEvidenceFiles(taskID: taskID, revision: revision)"))
        let sources = try [Self.cardPath, Self.consoleViewPath, Self.reviewPath].map(source)
        for text in sources {
            XCTAssertFalse(text.contains("readEvidenceFiles("), "a read outside the area can run for a card with no file")
        }
        let console = try source(Self.consolePath)
        XCTAssertEqual(console.components(separatedBy: "api.evidenceFiles(").count - 1, 2,
                       "the first page and the next are the console's only two reads of the route")
    }

    /// The page opens from where a recycled row cannot dismiss it: the console, and over the review
    /// sheet when the card is drawn in one.
    func testThePageIsHostedOutsideTheRecyclableRows() throws {
        for path in [Self.consoleViewPath, Self.reviewPath] {
            let text = try source(path)
            XCTAssertTrue(text.contains(".environment(\\.openEvidenceFiles,"), path)
            XCTAssertTrue(text.contains(".sheet(item: $evidenceFiles)"), path)
            XCTAssertTrue(text.contains("EvidenceFilesPage(console: console, target: target)"), path)
        }
        let views = try source(Self.viewsPath)
        let area = try section(views, from: "struct EvidenceFilesArea: View", to: "// MARK: - handing a file on")
        XCTAssertFalse(area.contains(".sheet("), "a sheet on a transcript row goes when the row scrolls out")
        XCTAssertTrue(area.contains("openFiles(EvidenceFilesTarget("))
    }

    func testChangingSessionClosesThePage() throws {
        let console = try source(Self.consoleViewPath)
        let change = try section(console, from: ".onChange(of: sessionID) { _, _ in", to: "readingBack = false")
        XCTAssertTrue(change.contains("evidenceFiles = nil"))
    }

    // MARK: only a raster image is drawn

    /// The one thing that matters most here, and the one thing a screenshot cannot show.
    func testNothingHereCanRenderAFile() throws {
        for path in [Self.viewsPath, "src/macos/OrbitKit/Sources/OrbitKit/App/EvidenceFiles.swift"] {
            let text = try source(path)
            for forbidden in ["WKWebView", "WebView", "import WebKit", "NSWorkspace", "UIApplication.shared.open",
                              "openURL", "Link(destination", "QLPreview", "QuickLook", "SFSafariViewController"] {
                XCTAssertFalse(text.contains(forbidden), "\(path) reaches for \(forbidden)")
            }
        }
    }

    /// A tile asks for a picture past the raster test and nowhere else: anything else is its kind, and
    /// a file that lost its bytes is not asked for at all.
    func testATileAsksForBytesOnlyPastTheRasterTest() throws {
        let views = try source(Self.viewsPath)
        let tile = try section(views, from: "private struct EvidenceFileTile: View", to: "// MARK: - a report")
        let gone = try offset(of: "if EvidenceFiles.isGone(file) {", in: tile)
        let raster = try offset(of: "} else if EvidenceFiles.isPicture(file) {", in: tile)
        let load = try offset(of: "loadsAttachmentImage(file.id, from: store)", in: tile)
        XCTAssertLessThan(gone, raster)
        XCTAssertLessThan(raster, load)
        XCTAssertEqual(views.components(separatedBy: "loadsAttachmentImage(").count - 1, 2,
                       "bytes are asked for as a picture by the tile and by a Mac's viewer, and nothing else")
    }

    /// A type is only what the uploader said, and an `NSImage` draws SVG and PDF from any bytes. What it
    /// decoded to has to be a bitmap before it is drawn.
    func testAMacDrawsOnlyWhatDecodedToABitmap() throws {
        let views = try source(Self.viewsPath)
        XCTAssertTrue(views.contains("image.representations.contains { $0 is NSBitmapImageRep } ? image : nil"))
        XCTAssertEqual(views.components(separatedBy: "store.image(for:").count - 1, 0,
                       "a picture is read past the bitmap test, through `evidencePicture`")
    }

    /// A press on a tile: a picture opens the viewer, any other file with bytes is saved, one with no
    /// bytes does neither.
    func testAPressOnATile() throws {
        let views = try source(Self.viewsPath)
        let tile = try section(views, from: "private struct EvidencePageTile: View", to: "// MARK: - the viewer")
        XCTAssertLessThan(try offset(of: "if EvidenceFiles.isGone(file) {", in: tile), try offset(of: "Button {", in: tile))
        XCTAssertTrue(tile.contains("if picture { onView(file) } else { onSave(file) }"))
    }

    /// The viewer pages the pictures, and nothing else reaches it.
    func testTheViewerPagesOnlyPictures() throws {
        let views = try source(Self.viewsPath)
        let page = try section(views, from: "struct EvidenceFilesPage: View", to: "private struct EvidencePageTile: View")
        XCTAssertTrue(page.contains("EvidenceFiles.pictures(list.files)"))
    }

    // MARK: what leaves the app

    /// Whatever the viewer or a tile hands on is marked on a Mac, by the one way bytes leave here.
    func testAMacsSaveAndShareCarryTheMark() throws {
        let views = try source(Self.viewsPath)
        XCTAssertEqual(views.components(separatedBy: "try DownloadMark.write(data, to: url)").count - 1, 2,
                       "the save panel's file and the shared file")
        XCTAssertFalse(views.contains("data.write("), "bytes written here without the mark")
    }

    /// On a phone the share sheet is where Save to Files is, and `FileHandoff` is what shows it.
    func testAPhoneHandsOnThroughTheShareSheet() throws {
        let handoff = try section(try source(Self.viewsPath), from: "private enum EvidenceFileHandoff",
                                  to: "#if os(macOS)\n/// A Mac's share control")
        XCTAssertTrue(handoff.contains("#if os(iOS)\n        return FileHandoff.deliver(data, named: name)"))
    }

    /// A reader told nothing about a save that did not happen has been told it did.
    func testAFailedSaveSaysSo() throws {
        let views = try source(Self.viewsPath)
        XCTAssertEqual(views.components(separatedBy: ".alert(EvidenceFiles.downloadFailed, isPresented: $saveFailed)").count - 1, 2,
                       "the page and the viewer: a toast would float underneath both")
    }

    // MARK: the pager

    /// The viewer says where it is, so the pager's own counter gives way. Every other viewer keeps it.
    func testThePagerReportsItsPageOnlyWhenAsked() throws {
        let viewer = try source(Self.viewerPath)
        XCTAssertTrue(viewer.contains("if onPage == nil { pageCounter }"))
        XCTAssertTrue(viewer.contains(".statusBarHidden(onPage == nil)"))
        XCTAssertTrue(viewer.contains(".onChange(of: index) { _, new in onPage?(new) }"))
        XCTAssertTrue(viewer.contains("init(images: [PreviewImage], startIndex: Int, onPage: ((Int) -> Void)? = nil)"))
    }

    /// A page whose bytes will never draw says so rather than spinning for as long as it is open.
    func testAPagerPageWithNoPictureStopsWaiting() throws {
        let viewer = try source(Self.viewerPath)
        let page = try section(viewer, from: "private func attachmentPage", to: "private func pageBody")
        XCTAssertLessThan(try offset(of: "store.isNotImage(attachmentID)", in: page), try offset(of: "ProgressView().tint(.white)", in: page))
    }
}
