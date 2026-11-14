import Foundation
import XCTest
@testable import OrbitKit

/// Restart the task says the same words on the Mac, the phone, the browser and Android. The table
/// all three clients are proved against is `src/shared/src/evidence-restart-copy.fixture.json`; the
/// web reads it in `EvidenceRestartAction.test.tsx`, Android in its own parity test, and this reads
/// it here. A missing fixture is a failure, never a skip (evidence-always-has-an-addressee D5 = A).
final class EvidenceRestartCopyParityTests: XCTestCase {

    private static let fixture = "src/shared/src/evidence-restart-copy.fixture.json"

    private struct Fixture: Decodable {
        struct Copy: Decodable {
            let action: String
            let explanation: String
            let started: String
            let refused: String
            let stale: String
        }
        let ownerAction: String
        let refusalCode: String
        let copy: Copy
    }

    private func fixture() throws -> Fixture {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<12 {
            let candidate = dir.appendingPathComponent(Self.fixture)
            if FileManager.default.fileExists(atPath: candidate.path) {
                return try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: candidate))
            }
            dir = dir.deletingLastPathComponent()
        }
        XCTFail("\(Self.fixture) was not found above this test file; the copy it pins is shared "
                + "with web and Android, so move this check with it rather than deleting it.")
        throw CocoaError(.fileNoSuchFile)
    }

    func testTheWordsMatchTheSharedTable() throws {
        let table = try fixture()
        XCTAssertEqual(EvidenceRestart.action, table.copy.action)
        XCTAssertEqual(EvidenceRestart.explanation, table.copy.explanation)
        XCTAssertEqual(EvidenceRestart.started, table.copy.started)
        XCTAssertEqual(EvidenceRestart.refused, table.copy.refused)
        XCTAssertEqual(EvidenceRestart.stale, table.copy.stale)
    }

    func testTheWireSpellingsMatchTheSharedTable() throws {
        let table = try fixture()
        XCTAssertEqual(EvidenceRestart.ownerAction, table.ownerAction)
        XCTAssertEqual(EvidenceRestart.notOfferedCode, table.refusalCode)
    }
}
