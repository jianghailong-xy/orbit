import Foundation
import XCTest
@testable import OrbitKit

/// The clients say the same words about what a version of evidence cites, and this reads the web's
/// `lib/evidenceFiles.ts` to keep them saying them: nothing in a build compares a Swift string with a
/// TypeScript one. That file holds every word as a declaration or a template literal for this purpose.
final class EvidenceFilesCopyParityTests: XCTestCase {

    private static let webCopy = "src/web/src/lib/evidenceFiles.ts"

    private func source(_ relative: String) throws -> String {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<12 {
            let candidate = dir.appendingPathComponent(relative)
            if FileManager.default.fileExists(atPath: candidate.path) {
                return try String(contentsOf: candidate, encoding: .utf8)
            }
            dir = dir.deletingLastPathComponent()
        }
        // A failure and not a skip: a check that quietly opts out reports green on exactly the day the
        // thing it watches went missing.
        XCTFail("\(relative) was not found above this test. If it moved, move this check with it.")
        return ""
    }

    private func assertDeclares(_ web: String, _ name: String, _ value: String,
                                file: StaticString = #filePath, line: UInt = #line) {
        let quote = value.contains("'") ? "\"" : "'"
        XCTAssertTrue(web.contains("export const \(name) = \(quote)\(value)\(quote);"),
                      "the web no longer declares \(name) as \(value.debugDescription)", file: file, line: line)
    }

    private func assertContains(_ web: String, _ needle: String, _ what: String,
                                file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertTrue(web.contains(needle), "\(what) drifted: the web no longer has \(needle.debugDescription)",
                      file: file, line: line)
    }

    /// This end's line, with the values it was rendered from put back as the web template's own
    /// interpolations, so the whole sentence is compared.
    private func template(_ rendered: String, _ values: [(String, String)]) -> String {
        values.reduce(rendered) { $0.replacingOccurrences(of: $1.0, with: $1.1) }
    }

    func testTheConstantsMatch() throws {
        let web = try source(Self.webCopy)
        assertDeclares(web, "EVIDENCE_FILES_HEADING", EvidenceFiles.heading)
        assertDeclares(web, "EVIDENCE_FILES_TITLE", EvidenceFiles.title)
        assertDeclares(web, "EVIDENCE_FILES_EXPIRED", EvidenceFiles.expired)
        assertDeclares(web, "EVIDENCE_FILE_EXPIRED", EvidenceFiles.fileExpired)
        assertDeclares(web, "EVIDENCE_FILES_NO_FOLDER", EvidenceFiles.noFolder)
        assertDeclares(web, "EVIDENCE_FILE_DOWNLOAD", EvidenceFiles.download)
        assertDeclares(web, "EVIDENCE_FILES_SHOW_MORE", EvidenceFiles.showMore)
        assertDeclares(web, "EVIDENCE_FILE_DOWNLOAD_FAILED", EvidenceFiles.downloadFailed)
        assertDeclares(web, "EVIDENCE_FILES_LOADING", EvidenceFiles.loading)
        assertDeclares(web, "EVIDENCE_FILES_UNREAD", EvidenceFiles.unread)
        assertDeclares(web, "EVIDENCE_REPORT_FAILED", EvidenceFiles.reportFailed)
        assertDeclares(web, "EVIDENCE_REPORT_SKIPPED", EvidenceFiles.reportSkipped)
    }

    /// Four thumbnails and three names are a contract between the clients, not a judgment about width:
    /// the same evidence has to report the same `+5` on a phone and in a browser.
    func testTheNumbersMatch() throws {
        let web = try source(Self.webCopy)
        assertContains(web, "export const EVIDENCE_FILES_SHOWN = \(EvidenceFiles.shownOnCard);", "the thumbnails on a card")
        assertContains(web, "export const EVIDENCE_REPORT_NAMES_SHOWN = \(EvidenceFiles.reportNamesShown);",
                       "the failed names on a card")
    }

    func testTheTemplatesMatch() throws {
        let web = try source(Self.webCopy)
        assertContains(web, "`\(template(EvidenceFiles.more(7), [("7", "${rest}")]))`", "the +N tile")
        assertContains(web, "`\(template(EvidenceFiles.position(3, of: 8), [("3", "${position}"), ("8", "${total}")]))`",
                       "the viewer's position")
        assertContains(web, "`\(template(EvidenceFiles.downloadName("N"), [(EvidenceFiles.download, "${EVIDENCE_FILE_DOWNLOAD}"), (" N", " ${name}")]))`",
                       "what a tile that can only be saved is called")
        assertContains(web, "`\(template(EvidenceFiles.reportNamesMore(7), [("7", "${rest}")]))`", "the names it counts")
        assertContains(web, "`\(template(EvidenceFiles.revisionLine("7"), [("7", "${revision}")]))`", "the version line")
        assertContains(web, "`\(template(EvidenceFiles.showing(7, of: 9), [("7", "${shown}"), ("9", "${total}")]))`",
                       "how much of a long list is shown")
        assertContains(web, "`\(template(EvidenceFiles.reportList("W", count: 7), [("W", "${word}"), ("7", "${count}")]))`",
                       "a report's list heading")
    }

    /// A report's lines, rendered here and compared whole with what the web's template says.
    func testAReportsLinesMatch() throws {
        let web = try source(Self.webCopy)
        let report = EvidenceTestReport(format: "playwright", total: 48, passed: 46, failed: 3, skipped: 2)
        assertContains(web, "{ playwright: 'Playwright', junit: 'JUnit' }", "the reports' own names")
        XCTAssertEqual(EvidenceFiles.reportFormat(report), "Playwright")
        XCTAssertEqual(EvidenceFiles.reportFormat(EvidenceTestReport(format: "junit", total: 0, passed: 0, failed: 0, skipped: 0)),
                       "JUnit")
        assertContains(web, "`\(template(EvidenceFiles.reportTitle(report), [("Playwright", "${evidenceReportFormat(report)}")]))`",
                       "the block's title")
        assertContains(web, "`\(template(EvidenceFiles.reportCounts(report), [("46", "${report.passed}"), ("3", "${report.failed}"), ("2", "${report.skipped}")]))`",
                       "a report's counts")
    }

    /// The headline's and the version line's shape: the pieces and their separator. The web's are built
    /// by `join(' · ')`, so they are compared by what the web writes for the two endings.
    func testTheLinesAreJoinedTheWayTheWebJoinsThem() throws {
        let web = try source(Self.webCopy)
        assertContains(web, "[EVIDENCE_FILES_HEADING, list.fileCount, ...listSize(list)].join(' · ')", "the headline")
        assertContains(web, "`${line} · ${EVIDENCE_FILES_EXPIRED}${last === null ? '' : ` ${evidenceExpiryDate(last, now).toUpperCase()}`}`",
                       "what a list that has all gone adds")
        assertContains(web, "`${list.fileCount} ${list.fileCount === 1 ? 'file' : 'files'}`", "the count of files")
        assertContains(web, "`sha256 ${file.sha256.slice(0, 8)}`", "the digest's eight")
        assertContains(web, "`${size.width} × ${size.height}`", "a picture's size")
    }

    /// The one list of what may be drawn inline, kept at three ends. The images on the web's list are the
    /// images on this one, which is the whole of what a client may decode as a picture.
    func testTheRasterListIsTheWebs() throws {
        let web = try source("src/web/src/lib/userFile.ts")
        let start = try XCTUnwrap(web.range(of: "const OPENS_IN_BROWSER = new Set(["))
        let end = try XCTUnwrap(web.range(of: "]);", range: start.upperBound..<web.endIndex))
        let entries = try NSRegularExpression(pattern: #"'([^']+)'"#)
        let list = String(web[start.upperBound..<end.lowerBound])
        let types = entries.matches(in: list, range: NSRange(list.startIndex..., in: list)).map {
            String(list[Range($0.range(at: 1), in: list)!])
        }
        let images = types.filter { $0.hasPrefix("image/") }
        XCTAssertFalse(images.isEmpty)
        for type in images {
            XCTAssertTrue(EvidenceFiles.isRasterImage(type), "\(type) is drawn on the web and not here")
        }
        for type in types where !type.hasPrefix("image/") {
            XCTAssertFalse(EvidenceFiles.isRasterImage(type), "\(type) is on the web's list but no picture")
        }
    }

    /// The size rule: the web's own numbers, so 1024 is a kilobyte at both ends and no system formatter
    /// answers for it in the device's language.
    func testSizesFollowTheWebsRule() throws {
        let web = try source("src/web/src/lib/worktreeFile.ts")
        assertContains(web, "if (bytes < 1024) return `${bytes} B`;", "bytes")
        assertContains(web, "if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;", "kilobytes")
        assertContains(web, "return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;", "megabytes")
    }
}
