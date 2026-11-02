import Foundation
import XCTest
@testable import OrbitKit

/// What the app writes out of somebody else's bytes, on a real file.
///
/// The mark itself exists only on a Mac, so most of this runs in the macOS job of client.yml and is
/// compiled out on Linux. Whether a marked file then gets the system's prompt on a double-click is
/// something no test here can see: the attribute read back below is what the prompt reads, and T13
/// measured the rest on a Mac.
final class DownloadMarkTests: XCTestCase {

    private func folder() throws -> URL {
        let folder = FileManager.default.temporaryDirectory
            .appendingPathComponent("download-mark-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: folder) }
        return folder
    }

    /// Bytes are written whatever the platform. The mark is the part a Mac adds.
    func testWriteLeavesTheBytesAtTheName() throws {
        let file = try folder().appendingPathComponent("report.html")
        try DownloadMark.write(Data("<script>".utf8), to: file)
        XCTAssertEqual(try Data(contentsOf: file), Data("<script>".utf8))
    }

    /// A panel that failed wrote nothing to mark: the reader is told what it failed with.
    func testASavePanelsFailureIsThrownAsItCame() {
        struct Refused: Error {}
        XCTAssertThrowsError(try DownloadMark.finishSaving(.failure(Refused()))) { XCTAssertTrue($0 is Refused) }
    }

    #if os(macOS)
    /// The attribute macOS checks before anything in a file runs.
    private func quarantine(_ file: URL) -> String? {
        let size = getxattr(file.path, "com.apple.quarantine", nil, 0, 0, 0)
        guard size > 0 else { return nil }
        var bytes = [UInt8](repeating: 0, count: size)
        guard getxattr(file.path, "com.apple.quarantine", &bytes, size, 0, 0) == size else { return nil }
        return String(decoding: bytes, as: UTF8.self)
    }

    func testAWrittenFileCarriesTheMark() throws {
        let file = try folder().appendingPathComponent("report.html")
        try DownloadMark.write(Data("<script>".utf8), to: file)
        let mark = try XCTUnwrap(quarantine(file), "a file written for somebody to open has no quarantine attribute")
        XCTAssertTrue(mark.contains("Orbit"), "the attribute names who wrote it: \(mark)")
    }

    /// Read back the way the system reads it, beside the raw attribute above.
    func testTheMarkSaysItIsADownload() throws {
        let file = try folder().appendingPathComponent("run.command")
        try DownloadMark.write(Data("#!/bin/sh\n".utf8), to: file)
        let values = try file.resourceValues(forKeys: [.quarantinePropertiesKey])
        let properties = try XCTUnwrap(values.quarantineProperties)
        XCTAssertEqual(properties[kLSQuarantineTypeKey as String] as? String, kLSQuarantineTypeOtherDownload as String)
        XCTAssertEqual(properties[kLSQuarantineAgentNameKey as String] as? String, "Orbit")
    }

    /// The Save panel writes the file itself, so the mark comes after: this is what its completion runs.
    func testAFileASavePanelWroteGetsTheMark() throws {
        let file = try folder().appendingPathComponent("saved.svg")
        try Data("<svg/>".utf8).write(to: file)
        XCTAssertNil(quarantine(file), "a plain write should not have been marked already")
        try DownloadMark.finishSaving(.success(file))
        XCTAssertNotNil(quarantine(file), "the saved file has no quarantine attribute")
    }

    /// A file that cannot be marked goes no further: left where the panel wrote it, a double-click would
    /// run it unchecked. A read-only file takes no attribute.
    func testAFileThatCannotBeMarkedIsTakenBack() throws {
        let file = try folder().appendingPathComponent("saved.html")
        try Data("<script>".utf8).write(to: file)
        try FileManager.default.setAttributes([.posixPermissions: 0o444], ofItemAtPath: file.path)
        try XCTSkipIf(geteuid() == 0, "root can mark a read-only file")
        XCTAssertThrowsError(try DownloadMark.finishSaving(.success(file)))
        XCTAssertFalse(FileManager.default.fileExists(atPath: file.path), "the unmarked file was left behind")
    }
    #endif
}
