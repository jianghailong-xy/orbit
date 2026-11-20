import Foundation
import XCTest

/// A test that reads another client's source (web, Android, or the shared tables) to hold the same
/// words on both sides FAILS when that file is missing, and never skips (evidence-addressee design
/// §6, D5 = A). A skipped parity check is green on exactly the day its counterpart went missing, and
/// on 2026-11-12 one such skip let a task pass. This reads every test file beside it and fails naming
/// any cross-client one that calls `XCTSkip`.
final class CrossClientChecksNeverSkipTests: XCTestCase {

    func testNoCrossClientCheckSkips() throws {
        let dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        let ownName = URL(fileURLWithPath: #filePath).lastPathComponent
        let files = try FileManager.default.contentsOfDirectory(atPath: dir.path)
            .filter { $0.hasSuffix(".swift") && $0 != ownName }
        XCTAssertGreaterThan(files.count, 50, "found too few test files in \(dir.path) to have looked")
        let skip = try NSRegularExpression(pattern: #"XCTSkip(If|Unless)?\s*\("#)
        let other = ["src/web/", "src/android/", "src/shared/"]
        var offenders: [String] = []
        for name in files.sorted() {
            let text = try String(contentsOf: dir.appendingPathComponent(name), encoding: .utf8)
            guard other.contains(where: text.contains) else { continue }
            if skip.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)) != nil {
                offenders.append(name)
            }
        }
        XCTAssertEqual(offenders, [], "these read another client's file and skip when it is missing; make a missing file a failure naming it")
    }
}
