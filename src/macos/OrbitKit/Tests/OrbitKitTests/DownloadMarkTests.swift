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

    private struct Refused: Error {}

    /// A panel that failed wrote nothing to mark: the reader is told what it failed with.
    func testASavePanelsFailureIsThrownAsItCame() {
        XCTAssertThrowsError(try DownloadMark.finishSaving(.failure(Refused()))) { XCTAssertTrue($0 is Refused) }
    }

    /// A file that cannot be marked goes no further: left where it was written, a double-click would run
    /// it unchecked. The mark is refused by hand, because a real one takes on anything the owner can
    /// write and on a read-only file too.
    func testAFileThatCannotBeMarkedIsTakenBack() throws {
        let file = try folder().appendingPathComponent("saved.html")
        try Data("<script>".utf8).write(to: file)
        XCTAssertThrowsError(try DownloadMark.markOrTakeBack(file, mark: { _ in throw Refused() })) {
            XCTAssertTrue($0 is Refused, "the reader is told what stopped the mark")
        }
        XCTAssertFalse(FileManager.default.fileExists(atPath: file.path), "the unmarked file was left behind")
    }

    /// And one that takes the mark stays.
    func testAFileThatTakesTheMarkStays() throws {
        let file = try folder().appendingPathComponent("saved.html")
        try Data("<script>".utf8).write(to: file)
        try DownloadMark.markOrTakeBack(file, mark: { _ in })
        XCTAssertTrue(FileManager.default.fileExists(atPath: file.path))
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

    /// A panel that says it wrote a file that is not there gets no mark, and the reader hears of it.
    func testMarkingAFileThatIsNotThereFails() throws {
        let file = try folder().appendingPathComponent("never-written.html")
        XCTAssertThrowsError(try DownloadMark.finishSaving(.success(file)))
    }
    #endif
}
