import Foundation
import XCTest
@testable import OrbitKit

/// macOS puts a new folder and a clone where the server makes them: `MachineSetup.newFolderRootFor`, `cloneRootFor` and
/// `newFolderPath` held to
/// src/shared/src/new-folder-root.fixture.json, the file @orbit/shared, the server and Android are held to as well.
/// A missing file fails, never skips.
final class NewFolderRootFixtureTests: XCTestCase {
    func testEveryCaseGoesWhereTheFixtureSays() throws {
        var directory = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        var source: URL?
        for _ in 0..<12 {
            let candidate = directory.appendingPathComponent("src/shared/src/new-folder-root.fixture.json")
            if FileManager.default.fileExists(atPath: candidate.path) { source = candidate; break }
            directory.deleteLastPathComponent()
        }
        let data = try Data(contentsOf: XCTUnwrap(source, "the shared fixture is in the repository"))
        let fixture = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        let cases = try XCTUnwrap(fixture["cases"] as? [[String: Any]])
        XCTAssertGreaterThanOrEqual(cases.count, 10)
        for entry in cases {
            let name = entry["name"] as? String ?? "?"
            let runner = try XCTUnwrap(entry["runner"] as? [String: Any], name)
            let root = MachineSetup.newFolderRootFor(managed: runner["managed"] as? Bool ?? false,
                                                     up: runner["up"] as? Bool ?? false,
                                                     reposRoot: runner["reposRoot"] as? String,
                                                     capabilities: runner["capabilities"] as? [String])
            XCTAssertEqual(root, entry["root"] as? String, name)
            XCTAssertEqual(root.map { MachineSetup.newFolderPath(root: $0, name: "app") }, entry["path"] as? String, name)
        }
        let clones = try XCTUnwrap(fixture["clones"] as? [[String: Any]])
        XCTAssertGreaterThanOrEqual(clones.count, 6)
        for entry in clones {
            let name = entry["name"] as? String ?? "?"
            let runner = try XCTUnwrap(entry["runner"] as? [String: Any], name)
            let root = MachineSetup.cloneRootFor(reposRoot: runner["reposRoot"] as? String,
                                                 capabilities: runner["capabilities"] as? [String])
            XCTAssertEqual(root, entry["root"] as? String, name)
            XCTAssertEqual(root.map { MachineSetup.newFolderPath(root: $0, name: "app") }, entry["path"] as? String, name)
        }
    }
}
