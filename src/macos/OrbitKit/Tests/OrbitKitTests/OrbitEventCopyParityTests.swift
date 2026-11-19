import Foundation
import XCTest
@testable import OrbitKit

/// The generic "From Orbit" line says the same words on both ends. `OrbitEvent` is a hand-copy of the
/// web's `OrbitEventLine.tsx` and of `Transcript.tsx`'s `orbitOnlyTurn`; neither end compiles the other,
/// so a word changed at one end would never reach the other. A missing counterpart is a FAILURE.
final class OrbitEventCopyParityTests: XCTestCase {

    private static let webLine = "src/web/src/components/OrbitEventLine.tsx"
    private static let webTranscript = "src/web/src/components/Transcript.tsx"

    private func source(_ relative: String) throws -> String {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<12 {
            let url = dir.appendingPathComponent(relative)
            if FileManager.default.fileExists(atPath: url.path) { return try String(contentsOf: url, encoding: .utf8) }
            dir = dir.deletingLastPathComponent()
        }
        throw NSError(domain: "OrbitEventCopyParityTests", code: 1,
                      userInfo: [NSLocalizedDescriptionKey: "\(relative) was not found above this test file"])
    }

    func testTheLineSaysTheWebsWords() throws {
        let web = try source(Self.webLine)
        XCTAssertTrue(web.contains("export const ORBIT_EVENT_TITLE = '\(OrbitEvent.title)';"))
        XCTAssertTrue(web.contains("export const ORBIT_EVENT_MARK = '\(OrbitEvent.mark)';"))
        XCTAssertTrue(web.contains("return describeNote(note) || '\(OrbitEvent.unnamed)';"))
        XCTAssertTrue(web.contains("<summary>\(OrbitEvent.whatTheAgentRead)</summary>"))
        XCTAssertNotNil(web.range(of: ">\\s*\(OrbitEvent.details)\\s*<", options: .regularExpression),
                        "the web line no longer opens on \(OrbitEvent.details)")
    }

    /// Which turns draw it: nothing typed, a note, nothing attached — the web's rule.
    func testTheWebDrawsItForTheSameTurns() throws {
        let web = try source(Self.webTranscript)
        for clause in ["node.text.trim() === ''", "!!node.note?.trim()", "!node.images?.length",
                       "!node.attachmentRefs?.length"] {
            XCTAssertTrue(web.contains("const orbitOnlyTurn = (node: TextNode): boolean =>")
                          && web.contains(clause), "the web's orbitOnlyTurn no longer asks \(clause)")
        }
    }
}
