import Foundation
import XCTest

/// When the transcript scrolls — the wire behind TestFlight crash D8B79F89 (0.1.2 build 4028,
/// iOS 26.6.1: SIGABRT 4.9s after launch, `NSInternalInconsistencyException` out of
/// `-[UICollectionView _validateScrollingTargetIndexPath:]` under SwiftUI's
/// `UpdateCoalescingCollectionView.updateContent()`, no Orbit frame on the stack).
///
/// `ScrollViewProxy.scrollTo` on the iOS transcript `List` picks the row's index path when it is
/// CALLED and scrolls when the List next updates. Called from inside an update — an `onChange` or
/// `onAppear` action, after the List has taken that update's rows — both halves see the same rows.
/// Called from outside one, a publish that lands in between and removes rows leaves the picked index
/// past the end of the list, and UIKit aborts. A simulator replica of this view measured both: no
/// stale index from an in-update scroll in 1,193 of them, and stale, out-of-bounds ones as soon as the
/// same scrolls were made from a main-queue hop.
///
/// SwiftUI does not exist on Linux and `ConsoleView.swift` is compiled only by the macOS and iOS
/// jobs, so the rule is asserted over the source, each check written so that putting a scroll back
/// outside an update is what turns it red.
final class TranscriptScrollWiringTests: XCTestCase {

    private enum WiringError: Error, CustomStringConvertible {
        case missing(String)
        var description: String {
            switch self {
            case .missing(let what):
                return "\(what) was not found above this test. If it moved, move this check with "
                    + "it rather than deleting it: it is the only gate on Linux that sees whether "
                    + "the transcript still scrolls only from inside an update."
            }
        }
    }

    private static let viewPath = "src/macos/OrbitApp/Sources/OrbitApp/Views/Console/ConsoleView.swift"
    private static let consolePath = "src/macos/OrbitApp/Sources/OrbitApp/ConsoleModel.swift"

    private func source(_ relative: String) throws -> String {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<12 {
            let candidate = dir.appendingPathComponent(relative)
            if FileManager.default.fileExists(atPath: candidate.path) {
                return try String(contentsOf: candidate, encoding: .utf8)
            }
            dir = dir.deletingLastPathComponent()
        }
        throw WiringError.missing(relative)
    }

    /// One stretch of a file, so a match elsewhere cannot answer for the part being asserted about.
    private func section(_ source: String, from: String, to: String) throws -> String {
        guard let start = source.range(of: from),
              let end = source.range(of: to, range: start.upperBound..<source.endIndex) else {
            throw WiringError.missing("\(from) … \(to)")
        }
        return String(source[start.lowerBound..<end.lowerBound])
    }

    /// The code with its comments taken out: several comments NAME `proxy.scrollTo`, and a sentence
    /// is not a call. (`://` is a URL in a string, not a comment.)
    private func code(_ source: String) -> String {
        source.split(separator: "\n", omittingEmptySubsequences: false).map { line -> String in
            var from = line.startIndex
            while let slashes = line.range(of: "//", range: from..<line.endIndex) {
                if slashes.lowerBound > line.startIndex, line[line.index(before: slashes.lowerBound)] == ":" {
                    from = slashes.upperBound
                    continue
                }
                return String(line[..<slashes.lowerBound])
            }
            return String(line)
        }.joined(separator: "\n")
    }

    /// Every block that opens with `opener` (which ends in `{`), braces balanced, opener included.
    private func blocks(opening opener: String, in code: String) -> [String] {
        var found: [String] = []
        var from = code.startIndex
        while let start = code.range(of: opener, range: from..<code.endIndex) {
            var depth = 0
            var end = code.endIndex
            var i = code.index(before: start.upperBound)   // the opener's own `{`
            while i < code.endIndex {
                if code[i] == "{" { depth += 1 }
                if code[i] == "}" {
                    depth -= 1
                    if depth == 0 { end = code.index(after: i); break }
                }
                i = code.index(after: i)
            }
            found.append(String(code[start.lowerBound..<end]))
            from = start.upperBound
        }
        return found
    }

    private func transcriptView() throws -> String {
        code(try section(try source(Self.viewPath),
                         from: "struct TranscriptView: View {",
                         to: "private struct CoastingButton"))
    }

    /// No scroll is made from a closure that runs outside an update. The main-queue hops stay — the
    /// coast fix needs the scroll a runloop after the halt, and a link's row needs the page it is on —
    /// but what they carry is a request, and the update that delivers it makes the scroll.
    func testNoTranscriptScrollIsMadeFromOutsideAnUpdate() throws {
        let view = try transcriptView()
        let hops = blocks(opening: "DispatchQueue.main.async {", in: view)
        XCTAssertGreaterThanOrEqual(hops.count, 4,
                                    "the hops of the needs-you bar, the record link, the sticky question "
                                        + "and the jump-to-latest disc were not all found")
        for closure in hops + blocks(opening: "Task {", in: view) {
            XCTAssertFalse(closure.contains("scrollTo("),
                           "a scroll made from a main-queue hop or a Task runs outside SwiftUI's update: "
                               + "its row becomes an index path against rows a pending publish can "
                               + "shrink — the out-of-bounds abort. Hand it to `holdScroll(to:anchor:)`:\n"
                               + closure)
        }
    }

    /// …and the held request is made inside the update that delivers it, by the one `.onChange`.
    func testTheHeldScrollIsMadeInsideTheNextUpdate() throws {
        let view = try transcriptView()
        let made = blocks(opening: ".onChange(of: heldScroll) {", in: view)
        XCTAssertEqual(made.count, 1, "one `.onChange(of: heldScroll)` makes every held scroll")
        XCTAssertTrue(made.first?.contains("proxy.scrollTo(held.rowID, anchor: held.anchor)") == true,
                      "the held row is scrolled to there, with the anchor it was asked for")
        XCTAssertGreaterThanOrEqual(view.components(separatedBy: "holdScroll(to:").count - 1, 4,
                                    "the four hops each carry their scroll as a held request")
    }

    /// The reading-history trim is published a turn later. `setReadingHistory` is called from inside
    /// the transcript's own update; a publish there lands between the scroll that update asks for next
    /// (`onAppear`, a session switch) and the List update that makes it, and the trim is the publish
    /// that removes the most rows — a thousand-row window's head.
    func testTheReadingHistoryTrimIsNotPublishedFromInsideTheTranscriptsUpdate() throws {
        let body = code(try section(try source(Self.consolePath),
                                    from: "func setReadingHistory(_ reading: Bool) {",
                                    to: "/// Enforce `maxWindowItems`"))
        let later = blocks(opening: "Task {", in: body)
        XCTAssertTrue(later.contains { $0.contains("trimWindow()") && $0.contains("publishStateNow()") },
                      "the trim must still be made and published — from the Task, a turn later")
        var now = body
        for block in later { now = now.replacingOccurrences(of: block, with: "") }
        XCTAssertFalse(now.contains("publishStateNow()"),
                       "publishing from the call is the shape that aims the next scroll at rows being trimmed")
        XCTAssertFalse(now.contains("trimWindow()"),
                       "nor may the trim run from the call while its publish waits: the published rows "
                           + "and the window would disagree for a turn")
    }
}
