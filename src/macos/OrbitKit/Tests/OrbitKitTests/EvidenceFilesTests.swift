import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import XCTest
@testable import OrbitKit

/// Stands in for the network: records the URL asked for and answers with the page.
private final class EvidenceFilesURLProtocol: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var asked: [URL] = []
    nonisolated(unsafe) static var answer: (status: Int, data: Data) = (200, Data())

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        Self.asked.append(request.url!)
        let response = HTTPURLResponse(url: request.url!, statusCode: Self.answer.status,
                                       httpVersion: nil, headerFields: nil)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Self.answer.data)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

/// The reading of `GET /tasks/:taskId/evidence/:revision/files`, the same reading web's
/// `lib/evidenceFiles.test.ts` holds its end to: which files a card draws, how they group, and what is
/// left to say about one that has lost its bytes.
final class EvidenceFilesTests: XCTestCase {

    private func picture(_ id: String, name: String? = nil, folder: String? = "shots", size: Int = 1024,
                         expiredAt: String? = nil) -> EvidenceFile {
        EvidenceFile(id: id, name: name ?? "\(id).png", folder: folder, mimeType: "image/png", sizeBytes: size,
                     sha256: "3f9a1c07aabbccdd", expiredAt: expiredAt)
    }

    private func gone(_ id: String = "gone1", sha: String? = "deadbeefcafe0000") -> EvidenceFile {
        EvidenceFile(id: id, sha256: sha, gone: true)
    }

    private func list(_ files: [EvidenceFile], fileCount: Int? = nil, totalBytes: Int = 1_887_437,
                      nextOffset: Int? = nil) -> EvidenceFileList {
        EvidenceFileList(EvidenceFilePage(revision: "2", submittedAt: "2026-11-02T14:41:00.000Z",
                                          fileCount: fileCount ?? files.count, totalBytes: totalBytes,
                                          files: files, nextOffset: nextOffset))
    }

    private func citation(_ kind: String = "FILE", report: EvidenceTestReport? = nil) -> EvidenceDecisionCitation {
        EvidenceDecisionCitation(kind: kind, ref: "r", resolved: true, testReport: report)
    }

    // MARK: which versions draw an area, and what is read

    /// With no FILE citation the card is what it has always been.
    func testOnlyAFileCitationDrawsTheArea() {
        XCTAssertFalse(EvidenceFiles.citesFiles([]))
        XCTAssertFalse(EvidenceFiles.citesFiles([citation("TOOL_CALL"), citation("COMMIT"), citation("ARTIFACT")]))
        XCTAssertTrue(EvidenceFiles.citesFiles([citation("TOOL_CALL"), citation("FILE")]))
    }

    /// A FILE citation is refused unless it resolves, so one that has stopped is a file that went.
    func testAnUnresolvedFileCitationStillDrawsTheArea() {
        XCTAssertTrue(EvidenceFiles.citesFiles([EvidenceDecisionCitation(kind: "FILE", ref: "r", resolved: false)]))
    }

    func testReportsAreReadOffTheCitations() {
        let report = EvidenceTestReport(format: "junit", total: 1, passed: 1, failed: 0, skipped: 0)
        XCTAssertEqual(EvidenceFiles.testReports([citation("TOOL_CALL"), citation(), citation(report: report)]), [report])
    }

    // MARK: what a picture is

    /// Everything that can run something, and everything else, is not a picture.
    func testOnlyARasterTypeIsAPicture() {
        for type in ["image/png", "image/jpeg", "image/webp", "image/gif", "image/heic", "image/avif",
                     "IMAGE/PNG", "image/png; charset=binary"] {
            XCTAssertTrue(EvidenceFiles.isRasterImage(type), type)
        }
        for type in ["image/svg+xml", "IMAGE/SVG+XML", "image/svg+xml; charset=utf-8", "text/html",
                     "application/xhtml+xml", "application/pdf", "text/plain", "application/json",
                     "application/octet-stream", "", "image/", "image/x-unknown"] {
            XCTAssertFalse(EvidenceFiles.isRasterImage(type), type)
        }
    }

    /// A picture that has lost its bytes is not asked for, and one with no type is not one.
    func testAFileWithNoBytesOrNoTypeIsNoPicture() {
        XCTAssertTrue(EvidenceFiles.isPicture(picture("a")))
        XCTAssertFalse(EvidenceFiles.isPicture(picture("a", expiredAt: "2026-12-02T00:00:00.000Z")))
        XCTAssertFalse(EvidenceFiles.isPicture(gone()))
        XCTAssertFalse(EvidenceFiles.isPicture(EvidenceFile(id: "a", name: "a.png")))
        XCTAssertFalse(EvidenceFiles.isPicture(EvidenceFile(id: "a", name: "page.html", mimeType: "text/html")))
    }

    func testATilesKindIsItsExtensionOrFile() {
        XCTAssertEqual(EvidenceFiles.kind(EvidenceFile(id: "a", name: "dir/report.html")), "HTML")
        XCTAssertEqual(EvidenceFiles.kind(EvidenceFile(id: "a", name: "a.b.json")), "JSON")
        XCTAssertEqual(EvidenceFiles.kind(EvidenceFile(id: "a", name: "Makefile")), "FILE")
        XCTAssertEqual(EvidenceFiles.kind(EvidenceFile(id: "a", name: ".env")), "FILE")
        XCTAssertEqual(EvidenceFiles.kind(EvidenceFile(id: "a", name: "ends.")), "FILE")
        XCTAssertEqual(EvidenceFiles.kind(gone()), "FILE")
    }

    func testNamesFallBackToTheIdAndASaveTakesTheLeaf() {
        XCTAssertEqual(EvidenceFiles.name(picture("a", name: "dark/menu.png")), "dark/menu.png")
        XCTAssertEqual(EvidenceFiles.saveName(picture("a", name: "dark/menu.png")), "menu.png")
        XCTAssertEqual(EvidenceFiles.name(gone("id9")), "id9")
        XCTAssertEqual(EvidenceFiles.saveName(gone("id9")), "id9")
    }

    // MARK: the card

    /// Pictures first, so a report does not take a picture's place, and the rest counts the whole list.
    func testTheCardDrawsFourPicturesFirstAndCountsTheRest() {
        let files = [EvidenceFile(id: "r", name: "report.json", mimeType: "application/json")]
            + (1...8).map { picture("p\($0)") }
        let onCard = EvidenceFiles.onCard(list(files))
        XCTAssertEqual(onCard.shown.map(\.id), ["p1", "p2", "p3", "p4"])
        XCTAssertEqual(onCard.rest, 5)
    }

    func testAFewFilesCountNothing() {
        let onCard = EvidenceFiles.onCard(list([picture("a"), EvidenceFile(id: "r", name: "r.html", mimeType: "text/html")]))
        XCTAssertEqual(onCard.shown.map(\.id), ["a", "r"])
        XCTAssertEqual(onCard.rest, 0)
    }

    /// `fileCount` is the whole list's, whichever page has been read.
    func testTheRestCountsFilesNotYetRead() {
        let onCard = EvidenceFiles.onCard(list((1...5).map { picture("p\($0)") }, fileCount: 3000, nextOffset: 5))
        XCTAssertEqual(onCard.rest, 2996)
    }

    // MARK: the lines

    func testSizesAreTheWebs() {
        XCTAssertEqual(EvidenceFiles.fileSize(0), "0 B")
        XCTAssertEqual(EvidenceFiles.fileSize(1023), "1023 B")
        XCTAssertEqual(EvidenceFiles.fileSize(1024), "1 KB")
        XCTAssertEqual(EvidenceFiles.fileSize(219_136), "214 KB")
        XCTAssertEqual(EvidenceFiles.fileSize(1_887_437), "1.8 MB")
        XCTAssertEqual(EvidenceFiles.fileSize(25 << 20), "25.0 MB")
        // A tie: `toFixed(1)` rounds this one up, where a binary formatter may not.
        XCTAssertEqual(EvidenceFiles.fileSize(2_359_296), "2.3 MB")
    }

    func testTheHeadline() {
        XCTAssertEqual(EvidenceFiles.headline(list((1...9).map { picture("p\($0)") })), "FILES · 9 · 1.8 MB")
        // A size nothing can state is left out rather than shown as 0 B.
        XCTAssertEqual(EvidenceFiles.headline(list([picture("a")], totalBytes: 0)), "FILES · 1")
    }

    private func day(_ iso: String) -> Date { RelativeTime.parse(iso)! }

    /// By the last date, and only once every file has gone: one of nine is its own tile's news.
    func testTheHeadlineSaysExpiredOnlyWhenEveryFileHas() {
        let now = day("2026-12-20T12:00:00.000Z")
        let expired = [picture("a", expiredAt: "2026-12-01T12:00:00.000Z"),
                       picture("b", expiredAt: "2026-12-02T12:00:00.000Z")]
        XCTAssertEqual(EvidenceFiles.headline(list(expired), now: now), "FILES · 2 · 1.8 MB · EXPIRED DEC 2")
        XCTAssertEqual(EvidenceFiles.headline(list(expired + [picture("c")]), now: now), "FILES · 3 · 1.8 MB")
    }

    /// A list not read to the end cannot say so of the whole of it.
    func testAFirstPageCannotSayTheWholeListHasGone() {
        let page = list([picture("a", expiredAt: "2026-12-02T12:00:00.000Z")], fileCount: 2, nextOffset: 1)
        XCTAssertFalse(EvidenceFiles.allGone(page))
        XCTAssertEqual(EvidenceFiles.headline(page), "FILES · 2 · 1.8 MB")
    }

    /// A row that went took its date and its size with it.
    func testAListOfFilesThatWentSaysExpiredWithNoDate() {
        let went = list([gone()], totalBytes: 0)
        XCTAssertEqual(EvidenceFiles.headline(went), "FILES · 1 · EXPIRED")
        XCTAssertEqual(EvidenceFiles.count(went), "1 file")
    }

    func testAnEmptyListHasNotGone() {
        XCTAssertFalse(EvidenceFiles.allGone(list([])))
    }

    /// `Dec 2`, in English whatever the device reads, with the year only when it is not this one.
    func testTheExpiryDate() {
        let now = day("2026-06-15T12:00:00.000Z")
        XCTAssertEqual(EvidenceFiles.expiryDate("2026-12-02T12:00:00.000Z", now: now), "Dec 2")
        XCTAssertEqual(EvidenceFiles.expiryDate("2025-12-02T12:00:00.000Z", now: now), "Dec 2, 2025")
        XCTAssertEqual(EvidenceFiles.expiryDate("not a date", now: now), "not a date")
    }

    func testTheCountOfTheVersionLine() {
        XCTAssertEqual(EvidenceFiles.count(list([picture("a")])), "1 file · 1.8 MB")
        XCTAssertEqual(EvidenceFiles.count(list((1...9).map { picture("p\($0)") })), "9 files · 1.8 MB")
    }

    func testAFilesFactsSayWhatIsKnown() {
        let file = picture("a", size: 219_136)
        XCTAssertEqual(EvidenceFiles.facts(file, width: 780, height: 1688), "214 KB · 780 × 1688 · sha256 3f9a1c07")
        XCTAssertEqual(EvidenceFiles.facts(file), "214 KB · sha256 3f9a1c07")
        XCTAssertEqual(EvidenceFiles.facts(file, width: 0, height: 0), "214 KB · sha256 3f9a1c07")
        XCTAssertEqual(EvidenceFiles.facts(gone()), "sha256 deadbeef")
        XCTAssertEqual(EvidenceFiles.facts(gone(sha: nil)), "")
    }

    // MARK: the page

    /// By the directory in the path, in the order they first appear, with each group's own count.
    func testGroupsFollowThePathsInOrder() {
        let files = [picture("a", name: "light/phone/a.png"), picture("b", name: "dark/b.png"),
                     picture("c", name: "light/phone/c.png")]
        let groups = EvidenceFiles.groups(files)
        XCTAssertEqual(groups.map(\.name), ["light/phone", "dark"])
        XCTAssertEqual(groups.map { $0.files.map(\.id) }, [["a", "c"], ["b"]])
    }

    /// A path with no directory goes by the folder, and a file cited by itself by the word for that.
    func testAFileWithNoDirectoryGoesByItsFolderOrTheWordForNone() {
        let groups = EvidenceFiles.groups([picture("a", name: "a.png", folder: "shots"),
                                           picture("b", name: "b.png", folder: nil), gone()])
        XCTAssertEqual(groups.map(\.name), ["shots", EvidenceFiles.noFolder])
        XCTAssertEqual(groups[1].files.map(\.id), ["b", "gone1"])
    }

    /// The viewer pages pictures only, in the order the page shows them: 9 files with 8 pictures reads
    /// `3 of 8`.
    func testTheViewerPagesPicturesInThePagesOrder() {
        let files = [picture("a", name: "x/a.png"), picture("b", name: "y/b.png"),
                     EvidenceFile(id: "r", name: "y/report.html", mimeType: "text/html"),
                     picture("c", name: "x/c.png"), gone(),
                     picture("d", name: "x/d.png", expiredAt: "2026-12-02T12:00:00.000Z")]
        XCTAssertEqual(EvidenceFiles.pictures(files).map(\.id), ["a", "c", "b"])
    }

    func testAReportsLinesAndLists() {
        let report = EvidenceTestReport(format: "playwright", total: 53, passed: 46, failed: 5, skipped: 2,
                                        durationMs: 38_214, failedNames: ["a", "b", "c", "d"], skippedNames: ["s"])
        XCTAssertEqual(EvidenceFiles.reportCounts(report), "46 passed · 5 failed · 2 skipped")
        XCTAssertEqual(EvidenceFiles.reportFacts(report), "46 passed · 5 failed · 2 skipped · 38s")
        XCTAssertEqual(EvidenceFiles.reportTitle(report), "Playwright report")
        let onCard = EvidenceFiles.reportNamesOnCard(report)
        XCTAssertEqual(onCard.names, ["a", "b", "c"])
        XCTAssertEqual(onCard.rest, 2, "the count is the whole of it, past the names shown")
        XCTAssertEqual(EvidenceFiles.reportLists(report).map(\.word), ["Failed", "Skipped"])
        XCTAssertEqual(EvidenceFiles.reportLists(report).map(\.count), [5, 2])
    }

    /// A run with nothing failed or skipped has nothing to open, and a report with no duration says none.
    func testACleanReportHasNoListsAndNoDuration() {
        let report = EvidenceTestReport(format: "junit", total: 3, passed: 3, failed: 0, skipped: 0)
        XCTAssertEqual(EvidenceFiles.reportLists(report), [])
        XCTAssertEqual(EvidenceFiles.reportFacts(report), "3 passed · 0 failed · 0 skipped")
        XCTAssertEqual(EvidenceFiles.reportNamesOnCard(report).names, [])
        XCTAssertEqual(EvidenceFiles.reportNamesOnCard(report).rest, 0)
    }

    /// A failure counted with no name to show has no list of names to count past.
    func testAFailureWithNoNameCountsNothingOnTheCard() {
        let report = EvidenceTestReport(format: "junit", total: 2, passed: 0, failed: 2, skipped: 0)
        XCTAssertEqual(EvidenceFiles.reportNamesOnCard(report).rest, 0)
    }

    // MARK: pages

    /// The totals are the newest reading of the whole list, and nothing already read goes.
    func testAPageAppends() {
        let first = list([picture("a")], fileCount: 2, totalBytes: 10, nextOffset: 1)
        let next = EvidenceFilePage(revision: "2", submittedAt: "2026-11-02T14:41:00.000Z", fileCount: 3,
                                    totalBytes: 30, files: [picture("b")], nextOffset: 2)
        let both = first.appending(next)
        XCTAssertEqual(both.files.map(\.id), ["a", "b"])
        XCTAssertEqual(both.fileCount, 3)
        XCTAssertEqual(both.totalBytes, 30)
        XCTAssertEqual(both.nextOffset, 2)
    }

    // MARK: the wire

    /// The route's answer, with every field it writes and T6's spelling of each.
    private static let routeJSON = #"""
    {
      "revision": "2",
      "submittedAt": "2026-11-02T14:41:00.000Z",
      "fileCount": 3,
      "totalBytes": 219136,
      "files": [
        {"id": "AAA", "kind": "file", "name": "chromium-dark-phone/menu-open.png", "label": null, "mimeType": "image/png",
         "sizeBytes": 219136, "sha256": "3f9a1c0755555555555555555555555555555555555555555555555555555555",
         "sessionId": "s", "taskId": "t", "fileBundleId": "b", "testReport": null, "createdAt": "2026-11-02T14:40:00.000Z",
         "folder": "shots", "width": null, "height": null, "expiredAt": null, "gone": false,
         "sessionPublicId": "s", "taskPublicId": "t", "fileBundlePublicId": "b"},
        {"id": "BBB", "kind": "file", "name": "old.png", "label": "old", "mimeType": "image/png", "sizeBytes": 10,
         "sha256": "bb", "sessionId": "s", "taskId": "t", "fileBundleId": null, "testReport": null,
         "createdAt": "2026-11-02T14:40:00.000Z", "folder": null, "width": 780, "height": 1688,
         "expiredAt": "2026-12-02T00:00:00.000Z", "gone": false},
        {"id": "CCC", "kind": "file", "name": null, "label": null, "mimeType": null, "sizeBytes": null, "sha256": "cc",
         "sessionId": null, "taskId": null, "fileBundleId": null, "testReport": null, "createdAt": null,
         "folder": null, "width": null, "height": null, "expiredAt": null, "gone": true}
      ],
      "nextOffset": null
    }
    """#

    func testTheRoutesAnswerDecodes() throws {
        let page = try JSONDecoder().decode(EvidenceFilePage.self, from: Data(Self.routeJSON.utf8))
        XCTAssertEqual(page.fileCount, 3)
        XCTAssertNil(page.nextOffset)
        XCTAssertEqual(page.files.map(\.id), ["AAA", "BBB", "CCC"])
        XCTAssertEqual(page.files[0].folder, "shots")
        XCTAssertEqual(page.files[1].width, 780)
        XCTAssertEqual(page.files[1].expiredAt, "2026-12-02T00:00:00.000Z")
        XCTAssertTrue(page.files[2].gone)
        XCTAssertNil(page.files[2].name)
        XCTAssertTrue(EvidenceFiles.isGone(page.files[1]))
        XCTAssertTrue(EvidenceFiles.isGone(page.files[2]))
    }

    private func decodeCitation(_ json: String) throws -> EvidenceDecisionCitation {
        try JSONDecoder().decode(EvidenceDecisionCitation.self, from: Data(json.utf8))
    }

    func testACitationCarriesItsReport() throws {
        let citation = try decodeCitation(#"""
        {"kind": "FILE", "ref": "AAA", "resolved": true, "label": "report.json · 1 KB",
         "testReport": {"format": "playwright", "total": 48, "passed": 46, "failed": 0, "skipped": 2, "durationMs": 38214,
                        "failedNames": [], "skippedNames": ["a", "b"]}}
        """#)
        XCTAssertEqual(citation.testReport?.durationMs, 38_214)
        XCTAssertEqual(citation.testReport?.skippedNames, ["a", "b"])
    }

    /// An older row has no key, and a citation of another kind never does.
    func testACitationWithNoReportStillDecodes() throws {
        XCTAssertNil(try decodeCitation(#"{"kind": "TOOL_CALL", "ref": "t", "resolved": true}"#).testReport)
    }

    /// A summary written before the name lists existed still says its counts.
    func testAReportWithNoNameListsDecodes() throws {
        let citation = try decodeCitation(#"""
        {"kind": "FILE", "ref": "AAA", "resolved": true,
         "testReport": {"format": "junit", "total": 2, "passed": 2, "failed": 0, "skipped": 0, "durationMs": null}}
        """#)
        XCTAssertEqual(citation.testReport?.total, 2)
        XCTAssertEqual(citation.testReport?.failedNames, [])
    }

    /// A line on a card must not take every pending card down: the citation stands without it, and
    /// everything else on the row is as strict as it ever was.
    func testAReportThisBuildCannotReadDoesNotFailTheCitation() throws {
        XCTAssertNil(try decodeCitation(#"{"kind": "FILE", "ref": "A", "resolved": true, "testReport": {"format": 7}}"#).testReport)
        XCTAssertThrowsError(try decodeCitation(#"{"kind": "FILE", "ref": "A"}"#))
    }

    /// A format a newer server adds reads as its own word rather than failing the read.
    func testAFormatThisBuildDoesNotKnowReadsAsItself() {
        XCTAssertEqual(EvidenceFiles.reportFormat(EvidenceTestReport(format: "tap", total: 0, passed: 0, failed: 0, skipped: 0)),
                       "tap")
    }

    private func client(_ data: Data, status: Int = 200) -> APIClient {
        EvidenceFilesURLProtocol.asked = []
        EvidenceFilesURLProtocol.answer = (status, data)
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [EvidenceFilesURLProtocol.self]
        return APIClient(baseURL: URL(string: "https://orbit.test")!, tokenStore: InMemoryTokenStore(),
                         session: URLSession(configuration: configuration))
    }

    /// T6's route, with no offset on the first page and the page's offset after it.
    func testTheReadAsksTheRoutesAddress() async throws {
        let api = client(Data(Self.routeJSON.utf8))
        _ = try await api.evidenceFiles(taskID: "T1", revision: "2")
        _ = try await api.evidenceFiles(taskID: "T1", revision: "2", offset: 1000)
        let asked = EvidenceFilesURLProtocol.asked
        XCTAssertEqual(asked.count, 2)
        XCTAssertTrue(asked[0].path.hasSuffix("/tasks/T1/evidence/2/files"), asked[0].path)
        XCTAssertNil(asked[0].query)
        XCTAssertTrue(asked[1].path.hasSuffix("/tasks/T1/evidence/2/files"), asked[1].path)
        XCTAssertEqual(asked[1].query, "offset=1000")
    }

    /// Another account's task and a task that does not exist are one 404, which the area reads as a list
    /// that could not be read.
    func testA404IsAFailedRead() async {
        let api = client(Data(#"{"message":"task not found"}"#.utf8), status: 404)
        do {
            _ = try await api.evidenceFiles(taskID: "T1", revision: "2")
            XCTFail("a 404 read as a page")
        } catch {}
    }
}
