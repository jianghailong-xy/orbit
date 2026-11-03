import Foundation

/* ─────────────────────────────────────────────────────────────────────────────────────────────
   WHAT A VERSION OF EVIDENCE CITES — THE OTHER HALF OF WEB'S `lib/evidenceFiles.ts`
   ─────────────────────────────────────────────────────────────────────────────────────────────

   The file area on the evidence card, the Evidence files page it opens and the viewer a thumbnail
   opens (docs/orbit-files-design.md §2.6): the words, and the reading of the rows those words come
   from. The views in `EvidenceFilesViews.swift` draw this and decide nothing about it, so macOS and
   iOS cannot disagree, and it can be tested on Linux where no SwiftUI exists.
   `EvidenceFilesCopyParityTests` reads the web file and fails when the words drift.

   ONLY A RASTER IMAGE IS EVER DRAWN
   ---------------------------------
   Every byte here was written by whoever submitted the evidence. `isPicture` is the one test for
   what gets decoded into a picture, and everything else, SVG and HTML included, is a tile that saves
   or shares the file. Nothing here opens a file or renders one in a web view.

   WHAT OUTLIVES THE BYTES
   -----------------------
   The list and the summaries are read from rows, so an expired file keeps its name, its size, its
   sha256 and its report. Only its picture goes. The latest version of a task's evidence never expires
   (§2.8) and only the latest is ever a card, so on a card the placeholder real data reaches is the
   one for a file whose row went (`gone`, with no date). The dated one is drawn from the same fields
   for whatever the route says.
   ───────────────────────────────────────────────────────────────────────────────────────────── */

// MARK: - the rows, as the server publishes them

/// What `file_upload --as test-report` kept of a report (apiserver `files/test-report.ts`). It rides on
/// a FILE citation, so a card reads it with no second request, and it outlives the report's bytes.
public struct EvidenceTestReport: Codable, Equatable, Sendable {
    /// `playwright` or `junit`. A string rather than an enum: one row a newer server words differently
    /// must not take the pending queue down with it.
    public let format: String
    public let total: Int
    public let passed: Int
    public let failed: Int
    public let skipped: Int
    public let durationMs: Int?
    /// At most twenty of each, so a count may be more than its list.
    public let failedNames: [String]
    public let skippedNames: [String]

    public init(format: String, total: Int, passed: Int, failed: Int, skipped: Int, durationMs: Int? = nil,
                failedNames: [String] = [], skippedNames: [String] = []) {
        self.format = format
        self.total = total
        self.passed = passed
        self.failed = failed
        self.skipped = skipped
        self.durationMs = durationMs
        self.failedNames = failedNames
        self.skippedNames = skippedNames
    }

    enum CodingKeys: String, CodingKey {
        case format, total, passed, failed, skipped, durationMs, failedNames, skippedNames
    }

    // A summary written before the name lists existed has neither.
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        format = try c.decode(String.self, forKey: .format)
        total = try c.decode(Int.self, forKey: .total)
        passed = try c.decode(Int.self, forKey: .passed)
        failed = try c.decode(Int.self, forKey: .failed)
        skipped = try c.decode(Int.self, forKey: .skipped)
        durationMs = try? c.decodeIfPresent(Int.self, forKey: .durationMs)
        failedNames = (try? c.decodeIfPresent([String].self, forKey: .failedNames)) ?? []
        skippedNames = (try? c.decodeIfPresent([String].self, forKey: .skippedNames)) ?? []
    }
}

/// One file of a version of evidence, as `GET /tasks/:taskId/evidence/:revision/files` lists it. Read
/// from rows, so an expired file reads as it always did. When `gone` is true the row itself no longer
/// exists: only the id, the sha256 and an image's size are left, which the version recorded.
public struct EvidenceFile: Codable, Equatable, Sendable, Identifiable {
    /// The public id, equal to the citation's `ref`. Its bytes are `GET /attachments/:id`.
    public let id: String
    /// Its path in the folder it was uploaded in, or its own name. Nil on a pasted image, and when gone.
    public let name: String?
    /// The folder it was uploaded in; nil on a file cited by itself.
    public let folder: String?
    public let mimeType: String?
    public let sizeBytes: Int?
    public let sha256: String?
    /// Known only for an image cited by itself.
    public let width: Int?
    public let height: Int?
    /// When its bytes expired.
    public let expiredAt: String?
    public let gone: Bool
    /// When it expires, while nothing holds it. Nil while evidence does, and on a file that never expires.
    public let expiresAt: String?
    /// When it was pinned, which keeps it past `expiresAt`.
    public let pinnedAt: String?
    /// Whether it can be pinned: what `file_upload` kept, while its bytes remain. A server older than this
    /// field offers no pin, so nil reads as no.
    public let pinnable: Bool?
    /// What `file_upload --as test-report` kept of it. A receipt has no citations, so its page reads its
    /// reports off these.
    public let testReport: EvidenceTestReport?

    public init(id: String, name: String? = nil, folder: String? = nil, mimeType: String? = nil,
                sizeBytes: Int? = nil, sha256: String? = nil, width: Int? = nil, height: Int? = nil,
                expiredAt: String? = nil, gone: Bool = false, expiresAt: String? = nil, pinnedAt: String? = nil,
                pinnable: Bool? = nil, testReport: EvidenceTestReport? = nil) {
        self.id = id
        self.name = name
        self.folder = folder
        self.mimeType = mimeType
        self.sizeBytes = sizeBytes
        self.sha256 = sha256
        self.width = width
        self.height = height
        self.expiredAt = expiredAt
        self.gone = gone
        self.expiresAt = expiresAt
        self.pinnedAt = pinnedAt
        self.pinnable = pinnable
        self.testReport = testReport
    }

    enum CodingKeys: String, CodingKey {
        case id, name, folder, mimeType, sizeBytes, sha256, width, height, expiredAt, gone
        case expiresAt, pinnedAt, pinnable, testReport
    }

    // Tolerant about the report alone, as a citation's is: a summary this build cannot read is one line
    // less, and must not fail the whole list.
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        name = try c.decodeIfPresent(String.self, forKey: .name)
        folder = try c.decodeIfPresent(String.self, forKey: .folder)
        mimeType = try c.decodeIfPresent(String.self, forKey: .mimeType)
        sizeBytes = try c.decodeIfPresent(Int.self, forKey: .sizeBytes)
        sha256 = try c.decodeIfPresent(String.self, forKey: .sha256)
        width = try c.decodeIfPresent(Int.self, forKey: .width)
        height = try c.decodeIfPresent(Int.self, forKey: .height)
        expiredAt = try c.decodeIfPresent(String.self, forKey: .expiredAt)
        gone = try c.decode(Bool.self, forKey: .gone)
        expiresAt = try c.decodeIfPresent(String.self, forKey: .expiresAt)
        pinnedAt = try c.decodeIfPresent(String.self, forKey: .pinnedAt)
        pinnable = try c.decodeIfPresent(Bool.self, forKey: .pinnable)
        testReport = try? c.decodeIfPresent(EvidenceTestReport.self, forKey: .testReport)
    }

    /// This file after a press of its pin, with what the server answered.
    public func withPin(_ answer: EvidenceFilePinAnswer) -> EvidenceFile {
        EvidenceFile(id: id, name: name, folder: folder, mimeType: mimeType, sizeBytes: sizeBytes, sha256: sha256,
                     width: width, height: height, expiredAt: answer.expiredAt, gone: gone,
                     expiresAt: answer.expiresAt, pinnedAt: answer.pinnedAt, pinnable: pinnable, testReport: testReport)
    }

    /// This file once a press was told its bytes have gone: it can only say so from now on.
    public func notPinnable() -> EvidenceFile {
        EvidenceFile(id: id, name: name, folder: folder, mimeType: mimeType, sizeBytes: sizeBytes, sha256: sha256,
                     width: width, height: height, expiredAt: expiredAt, gone: gone,
                     expiresAt: expiresAt, pinnedAt: pinnedAt, pinnable: false, testReport: testReport)
    }
}

/// What a press of the pin answers, either way (`PUT` and `DELETE /attachments/:id/pin`): the three dates
/// it may have moved. Everything else about a file stays as the list read it.
public struct EvidenceFilePinAnswer: Codable, Equatable, Sendable {
    public let expiresAt: String?
    public let expiredAt: String?
    public let pinnedAt: String?

    public init(expiresAt: String? = nil, expiredAt: String? = nil, pinnedAt: String? = nil) {
        self.expiresAt = expiresAt
        self.expiredAt = expiredAt
        self.pinnedAt = pinnedAt
    }
}

/// A read of a file whose bytes have gone (410), and when they expired. A server older than the date says
/// only that they went, so a client draws `Expired` with no date.
public struct ExpiredAttachment: Equatable, Sendable {
    public let expiredAt: String?

    public init(expiredAt: String? = nil) { self.expiredAt = expiredAt }

    private struct Body: Decodable { let expiredAt: String? }

    /// What this failure says of the file, or nil when it says nothing of the kind: every other failure
    /// is what it always was.
    public init?(_ error: Error) {
        guard case APIError.http(status: 410, body: let body) = error else { return nil }
        let date = body?.data(using: .utf8).flatMap { try? JSONDecoder().decode(Body.self, from: $0) }?.expiredAt
        self.init(expiredAt: date)
    }
}

/// A page of a version's files. The count and the size are the whole list's, whichever page it is.
public struct EvidenceFilePage: Codable, Equatable, Sendable {
    public let revision: String
    public let submittedAt: String
    public let fileCount: Int
    public let totalBytes: Int
    public let files: [EvidenceFile]
    /// The offset of the next page, or nil when this is the last.
    public let nextOffset: Int?

    public init(revision: String, submittedAt: String, fileCount: Int, totalBytes: Int,
                files: [EvidenceFile], nextOffset: Int? = nil) {
        self.revision = revision
        self.submittedAt = submittedAt
        self.fileCount = fileCount
        self.totalBytes = totalBytes
        self.files = files
        self.nextOffset = nextOffset
    }
}

/// The pages read so far of a version's files, as one.
public struct EvidenceFileList: Equatable, Sendable {
    public let submittedAt: String
    public let fileCount: Int
    public let totalBytes: Int
    public let files: [EvidenceFile]
    public let nextOffset: Int?

    public init(_ page: EvidenceFilePage) {
        self.init(submittedAt: page.submittedAt, fileCount: page.fileCount, totalBytes: page.totalBytes,
                  files: page.files, nextOffset: page.nextOffset)
    }

    /// With one file changed, wherever the list holds it.
    public func updating(_ id: String, _ change: (EvidenceFile) -> EvidenceFile) -> EvidenceFileList {
        EvidenceFileList(submittedAt: submittedAt, fileCount: fileCount, totalBytes: totalBytes,
                         files: files.map { $0.id == id ? change($0) : $0 }, nextOffset: nextOffset)
    }

    private init(submittedAt: String, fileCount: Int, totalBytes: Int, files: [EvidenceFile],
                 nextOffset: Int?) {
        self.submittedAt = submittedAt
        self.fileCount = fileCount
        self.totalBytes = totalBytes
        self.files = files
        self.nextOffset = nextOffset
    }

    /// With the next page after it, whose totals are the newer reading of the whole list.
    public func appending(_ page: EvidenceFilePage) -> EvidenceFileList {
        EvidenceFileList(submittedAt: page.submittedAt, fileCount: page.fileCount,
                         totalBytes: page.totalBytes, files: files + page.files,
                         nextOffset: page.nextOffset)
    }
}

/// Where the read of one version's files stands on this device.
public struct EvidenceFileRead: Equatable, Sendable {
    /// Nil until the first page is read.
    public let list: EvidenceFileList?
    /// The last read did not come back.
    public let unread: Bool
    /// A read is on its way.
    public let reading: Bool

    public init(list: EvidenceFileList? = nil, unread: Bool = false, reading: Bool = false) {
        self.list = list
        self.unread = unread
        self.reading = reading
    }
}

// MARK: - the copy and the reading

public enum EvidenceFiles {

    // MARK: the copy
    //
    // Every word is the one its web twin declares in `lib/evidenceFiles.ts`.

    /// The file area's small heading (`EVIDENCE_FILES_HEADING`).
    public static let heading = "FILES"
    /// The page the file area opens (`EVIDENCE_FILES_TITLE`).
    public static let title = "Evidence files"
    /// After the heading, ahead of the date, once every file has expired (`EVIDENCE_FILES_EXPIRED`).
    public static let expired = "EXPIRED"
    /// On the grey tile that takes an expired file's picture, ahead of the date
    /// (`EVIDENCE_FILE_EXPIRED`).
    public static let fileExpired = "Expired"
    /// The group of the files that were not uploaded in a folder (`EVIDENCE_FILES_NO_FOLDER`).
    public static let noFolder = "Files"
    /// The verb on what saves a file (`EVIDENCE_FILE_DOWNLOAD`).
    public static let download = "Download"
    /// Under a list with more files than the page holds (`EVIDENCE_FILES_SHOW_MORE`).
    public static let showMore = "Show more"
    /// What a save that failed says (`EVIDENCE_FILE_DOWNLOAD_FAILED`).
    public static let downloadFailed = "Couldn't download the file"
    /// What the area says while the list is read, and when it could not be (`EVIDENCE_FILES_LOADING`,
    /// `EVIDENCE_FILES_UNREAD`).
    public static let loading = "Reading…"
    public static let unread = "The files could not be read just now."
    /// What presses a file's pin, either way (`EVIDENCE_FILE_PIN`, `EVIDENCE_FILE_UNPIN`).
    public static let pin = "Pin"
    public static let unpin = "Unpin"
    /// What a pinned file says of how long it stays, where one with a date says when it expires
    /// (`EVIDENCE_FILE_PINNED`).
    public static let pinned = "Pinned"
    /// What a press that did not go through says (`EVIDENCE_FILE_PIN_FAILED`, `EVIDENCE_FILE_UNPIN_FAILED`).
    public static let pinFailed = "Couldn't pin the file"
    public static let unpinFailed = "Couldn't unpin the file"
    /// The two lists a test report opens into (`EVIDENCE_REPORT_FAILED`, `EVIDENCE_REPORT_SKIPPED`).
    public static let reportFailed = "Failed"
    public static let reportSkipped = "Skipped"
    /// How many thumbnails the card draws before it counts the rest (`EVIDENCE_FILES_SHOWN`).
    public static let shownOnCard = 4
    /// How many failed cases the card names; the page names the rest (`EVIDENCE_REPORT_NAMES_SHOWN`).
    public static let reportNamesShown = 3

    /// `+5`, on the tile after the last thumbnail.
    public static func more(_ rest: Int) -> String { "+\(rest)" }
    /// `3 of 8`, in the viewer.
    public static func position(_ position: Int, of total: Int) -> String { "\(position) of \(total)" }
    /// `Download report.html`: what a tile that can only be saved is called.
    public static func downloadName(_ name: String) -> String { "\(download) \(name)" }
    /// `2 more`, under the failed names the card shows.
    public static func reportNamesMore(_ rest: Int) -> String { "\(rest) more" }
    /// `Revision 2`, ahead of when it was submitted.
    public static func revisionLine(_ revision: String) -> String { "Revision \(revision)" }
    /// `Showing 1000 of 3000 files`, while the list has more than the page holds.
    public static func showing(_ shown: Int, of total: Int) -> String { "Showing \(shown) of \(total) files" }

    // MARK: which versions, and which files

    /// Whether this version cites a file. With none, the card is what it has always been and no read
    /// is made. A FILE citation is refused unless it resolves, so one that has stopped resolving is a
    /// file that went, and still gets its tile.
    public static func citesFiles(_ citations: [EvidenceDecisionCitation]) -> Bool {
        citations.contains { $0.kind == "FILE" }
    }

    /// The summaries of the reports this version cites, read off the citations: they outlive the files.
    public static func testReports(_ citations: [EvidenceDecisionCitation]) -> [EvidenceTestReport] {
        citations.compactMap(\.testReport)
    }

    /// The reports of what a page shows: the citations', and a receipt's, which has none, off the list it
    /// has read (web's `evidenceReportsOf`).
    public static func reports(_ citations: [EvidenceDecisionCitation], files: [EvidenceFile]) -> [EvidenceTestReport] {
        let cited = testReports(citations)
        return cited.isEmpty ? files.compactMap(\.testReport) : cited
    }

    /// Whether the server offers this file a pin.
    public static func canPin(_ file: EvidenceFile) -> Bool { file.pinnable == true }

    /// Whether this file is pinned.
    public static func isPinned(_ file: EvidenceFile) -> Bool { file.pinnedAt != nil }

    /// What a file is called where one name is needed.
    public static func name(_ file: EvidenceFile) -> String { file.name ?? file.id }

    /// What a saved file is called: the path's last part.
    public static func saveName(_ file: EvidenceFile) -> String {
        name(file).components(separatedBy: "/").last ?? file.id
    }

    /// Whether a file has lost its bytes: it expired, or its row went with them.
    public static func isGone(_ file: EvidenceFile) -> Bool { file.gone || file.expiredAt != nil }

    /// The raster types a client draws: the images on the list a browser shows without running
    /// anything the file carries (web's `OPENS_IN_BROWSER`, the server's `user-file-response.ts`).
    /// Never an SVG, a PDF or a page.
    private static let rasterTypes: Set<String> = [
        "image/avif", "image/bmp", "image/gif", "image/heic", "image/heif", "image/jpeg", "image/png",
        "image/tiff", "image/vnd.microsoft.icon", "image/webp", "image/x-icon",
    ]

    /// A picture a page may draw inline (web's `isRasterImage`), by the media type with its parameters off.
    public static func isRasterImage(_ type: String) -> Bool {
        let bare = type.split(separator: ";", maxSplits: 1, omittingEmptySubsequences: false).first.map(String.init) ?? ""
        return rasterTypes.contains(bare.trimmingCharacters(in: .whitespacesAndNewlines).lowercased())
    }

    /// Whether this file is drawn as a picture. Only a raster image is, and only while it has its bytes.
    public static func isPicture(_ file: EvidenceFile) -> Bool {
        guard !isGone(file), let type = file.mimeType else { return false }
        return isRasterImage(type)
    }

    /// The label on a tile with no picture: `HTML`, `JSON`, `FILE`.
    public static func kind(_ file: EvidenceFile) -> String {
        guard file.name != nil else { return "FILE" }
        let leaf = saveName(file)
        guard let dot = leaf.lastIndex(of: "."), dot != leaf.startIndex else { return "FILE" }
        let suffix = leaf[leaf.index(after: dot)...]
        return suffix.isEmpty ? "FILE" : suffix.uppercased()
    }

    /// The thumbnails the card draws: pictures first, so a report does not take a picture's place. The
    /// rest counts against the whole list, whichever page has been read.
    public static func onCard(_ list: EvidenceFileList) -> (shown: [EvidenceFile], rest: Int) {
        let pictures = list.files.filter(isPicture)
        let others = list.files.filter { !isPicture($0) }
        let shown = Array((pictures + others).prefix(shownOnCard))
        return (shown, list.fileCount - shown.count)
    }

    /// One group of the page: the folder it was uploaded in and its files in the order they are listed.
    public struct Group: Equatable, Sendable, Identifiable {
        public let name: String
        public let files: [EvidenceFile]
        public var id: String { name }
    }

    /// The files, by the folder they were uploaded in and in the order those first appear.
    public static func groups(_ files: [EvidenceFile]) -> [Group] {
        var order: [String] = []
        var grouped: [String: [EvidenceFile]] = [:]
        for file in files {
            let path = name(file)
            let name: String
            if let slash = path.lastIndex(of: "/"), slash != path.startIndex {
                name = String(path[..<slash])
            } else {
                name = file.folder ?? noFolder
            }
            if grouped[name] == nil { order.append(name) }
            grouped[name, default: []].append(file)
        }
        return order.map { Group(name: $0, files: grouped[$0] ?? []) }
    }

    /// The pictures the viewer pages, in the order the page shows them, so 9 files with 8 pictures
    /// reads `3 of 8`.
    public static func pictures(_ files: [EvidenceFile]) -> [EvidenceFile] {
        groups(files).flatMap(\.files).filter(isPicture)
    }

    // MARK: the lines

    /// In English whatever the device reads, as all copy is.
    private static let englishDay: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "MMM d"
        return f
    }()
    private static let englishDayOfYear: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "MMM d, y"
        return f
    }()

    /// `Dec 2`, with the year when it is not this one.
    public static func expiryDate(_ at: String, now: Date = Date()) -> String {
        guard let date = RelativeTime.parse(at) else { return at }
        let sameYear = Calendar.current.isDate(date, equalTo: now, toGranularity: .year)
        return (sameYear ? englishDay : englishDayOfYear).string(from: date)
    }

    /// `Expires Dec 2`.
    public static func expires(_ at: String, now: Date = Date()) -> String { "Expires \(expiryDate(at, now: now))" }

    /// How long a file with its bytes stays: `Pinned`, `Expires Dec 2`, or nothing where evidence holds
    /// it or it never expires.
    public static func keep(_ file: EvidenceFile, now: Date = Date()) -> String? {
        if isGone(file) { return nil }
        if isPinned(file) { return pinned }
        return file.expiresAt.map { expires($0, now: now) }
    }

    /// `Expired Dec 2`, on one line, or `Expired` from a server that does not say when.
    public static func expiredLine(_ at: String?, now: Date = Date()) -> String {
        guard let at else { return fileExpired }
        return "\(fileExpired) \(expiryDate(at, now: now))"
    }

    /// The server's rule for a size (web's `formatFileSize`), not the system's: `ByteCountFormatter`
    /// counts in thousands and speaks the device's language. In whole numbers, so a tie rounds up as
    /// the web's does whichever way the binary fraction falls.
    public static func fileSize(_ bytes: Int) -> String {
        if bytes < 1024 { return "\(bytes) B" }
        if bytes < 1024 * 1024 { return "\((bytes + 512) / 1024) KB" }
        func tenths(of unit: Int) -> String {
            let tenths = (bytes * 10 + unit / 2) / unit
            return "\(tenths / 10).\(tenths % 10)"
        }
        if bytes < 1024 * 1024 * 1024 { return "\(tenths(of: 1024 * 1024)) MB" }
        return "\(tenths(of: 1024 * 1024 * 1024)) GB"
    }

    /// Whether every file has lost its bytes. Only the last page can say so of the whole list.
    public static func allGone(_ list: EvidenceFileList) -> Bool {
        list.nextOffset == nil && !list.files.isEmpty && list.files.allSatisfy(isGone)
    }

    /// The whole list's size, unless nothing that is left can say: a row that went took its size with it.
    private static func listSize(_ list: EvidenceFileList) -> [String] {
        list.totalBytes > 0 ? [fileSize(list.totalBytes)] : []
    }

    /// `FILES · 9 · 1.8 MB`, and ` · EXPIRED DEC 2` once all of them have, by the last date. One expired
    /// file of nine is its own tile's news. A row that went took its date with it, so a list of those
    /// says `EXPIRED` alone.
    public static func headline(_ list: EvidenceFileList, now: Date = Date()) -> String {
        let line = ([heading, "\(list.fileCount)"] + listSize(list)).joined(separator: " · ")
        guard allGone(list) else { return line }
        guard let last = list.files.compactMap(\.expiredAt).max() else { return "\(line) · \(expired)" }
        return "\(line) · \(expired) \(expiryDate(last, now: now).uppercased())"
    }

    /// `9 files · 1.8 MB`, on the version line of the page.
    public static func count(_ list: EvidenceFileList) -> String {
        (["\(list.fileCount) \(list.fileCount == 1 ? "file" : "files")"] + listSize(list))
            .joined(separator: " · ")
    }

    /// `214 KB · 780 × 1688 · sha256 3f9a1c07`, with what is known. A size that cannot be stated is left
    /// out rather than shown as `0 B`. `width` and `height` are the picture's own when the row has none.
    public static func facts(_ file: EvidenceFile, width: Int? = nil, height: Int? = nil) -> String {
        var parts: [String] = []
        if let size = file.sizeBytes { parts.append(fileSize(size)) }
        if let width, let height, width > 0, height > 0 { parts.append("\(width) × \(height)") }
        if let sha = file.sha256 { parts.append("sha256 \(sha.prefix(8))") }
        return parts.joined(separator: " · ")
    }

    // MARK: a report

    /// `Playwright`, the report's own name.
    public static func reportFormat(_ report: EvidenceTestReport) -> String {
        switch report.format {
        case "playwright": return "Playwright"
        case "junit":      return "JUnit"
        default:           return report.format
        }
    }

    /// `Playwright report`, heading the page's block.
    public static func reportTitle(_ report: EvidenceTestReport) -> String {
        "\(reportFormat(report)) report"
    }

    /// `46 passed · 0 failed · 2 skipped`.
    public static func reportCounts(_ report: EvidenceTestReport) -> String {
        "\(report.passed) passed · \(report.failed) failed · \(report.skipped) skipped"
    }

    /// `46 passed · 0 failed · 2 skipped · 38s`, with how long the run took when the report says.
    public static func reportFacts(_ report: EvidenceTestReport) -> String {
        guard let ms = report.durationMs else { return reportCounts(report) }
        return "\(reportCounts(report)) · \(ExceptionCards.checkDuration(ms))"
    }

    /// `Failed · 2`, heading a list whose names may stop short of its count.
    public static func reportList(_ word: String, count: Int) -> String { "\(word) · \(count)" }

    /// One list a report opens into: only those with something in them are drawn.
    public struct ReportList: Equatable, Sendable, Identifiable {
        public let word: String
        public let count: Int
        public let names: [String]
        public var id: String { word }
    }

    /// What a report's block on the page opens into.
    public static func reportLists(_ report: EvidenceTestReport) -> [ReportList] {
        [ReportList(word: reportFailed, count: report.failed, names: report.failedNames),
         ReportList(word: reportSkipped, count: report.skipped, names: report.skippedNames)]
            .filter { $0.count > 0 }
    }

    /// The failed cases the card can name, and how many it counts instead.
    public static func reportNamesOnCard(_ report: EvidenceTestReport) -> (names: [String], rest: Int) {
        let names = Array(report.failedNames.prefix(reportNamesShown))
        return (names, names.isEmpty ? 0 : report.failed - names.count)
    }
}
