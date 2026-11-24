import AppKit
import SwiftUI
import XCTest
import OrbitKit
@testable import OrbitApp

/// The real `DriveSyncCardView` in each state, fed made-up syncs through `AppModel.documents`.
/// PNGs land in `docs/evidence/documents-sync-card-mac/`.
@MainActor
final class DriveSyncCardShotsTests: XCTestCase {

    private var evidenceDir: URL {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<10 {
            if FileManager.default.fileExists(atPath: dir.appendingPathComponent("src/macos/OrbitApp/Package.swift").path) {
                let out = dir.appendingPathComponent("docs/evidence/documents-sync-card-mac")
                try? FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)
                return out
            }
            dir = dir.deletingLastPathComponent()
        }
        return URL(fileURLWithPath: NSTemporaryDirectory())
    }

    private func fixtures() -> [(label: String, sync: DriveSync)] {
        let iso = ISO8601DateFormatter()
        let start = Date().addingTimeInterval(-3600)
        func at(_ s: TimeInterval) -> String { iso.string(from: start.addingTimeInterval(s)) }
        return [
            ("checking", DriveSync(id: "s_checking", status: "CHECKING", sourceName: "out", destPath: "/Reports/Q3",
                                       destEntryId: "e1", filesSeen: 1284, startedAt: at(0), updatedAt: at(5))),
            ("uploading", DriveSync(id: "s_uploading", status: "UPLOADING", sourceName: "out", destPath: "/Reports/Q3",
                                        destEntryId: "e1", filesSeen: 412, filesTotal: 412, filesDone: 187, filesSame: 4,
                                        bytesTotal: 640_000_000, bytesSent: 212_000_000,
                                        currentPath: "charts/q3/revenue-by-region.png", startedAt: at(0), updatedAt: at(40))),
            ("done", DriveSync(id: "s_done", status: "DONE", sourceName: "out", destPath: "/Reports/Q3", destEntryId: "e1",
                                   filesSeen: 412, filesTotal: 412, filesDone: 412, filesSame: 3, bytesTotal: 52_000_000,
                                   bytesSent: 52_000_000, startedAt: at(0), updatedAt: at(194), endedAt: at(194))),
            ("done-failures", DriveSync(id: "s_fail", status: "DONE", sourceName: "out", destPath: "/Reports/Q3",
                                            destEntryId: "e1", filesSeen: 412, filesTotal: 412, filesDone: 410,
                                            bytesTotal: 52_000_000, bytesSent: 51_000_000,
                                            failed: [.init(path: "raw/big.mov", error: "File too large"),
                                                     .init(path: "raw/locked.db", error: "Permission denied")],
                                            failedCount: 2, startedAt: at(0), updatedAt: at(194), endedAt: at(194))),
            ("stopped", DriveSync(id: "s_stopped", status: "STOPPED", sourceName: "out", destPath: "/Reports/Q3",
                                      destEntryId: "e1", filesSeen: 412, filesTotal: 412, filesDone: 187,
                                      bytesTotal: 640_000_000, bytesSent: 212_000_000,
                                      startedAt: at(0), updatedAt: at(60), endedAt: at(60))),
            ("failed", DriveSync(id: "s_failed", status: "FAILED", sourceName: "out", destPath: "/Reports/Q3",
                                     destEntryId: "e1", error: "The runner lost its connection to Documents before the sync finished.",
                                     startedAt: at(0), updatedAt: at(12), endedAt: at(12))),
        ]
    }

    private func write(dark: Bool) throws {
        let app = AppModel()
        let model = DriveModel(baseURL: URL(string: "http://127.0.0.1:9")!, tokenStore: InMemoryTokenStore())
        let all = fixtures()
        model.seedSyncsForTesting(all.map(\.sync), rates: ["s_uploading": 8_400_000])
        app.seedDriveForTesting(model)

        let size = CGSize(width: 820, height: 820)
        let root = VStack(alignment: .leading, spacing: 14) {
            ForEach(all, id: \.label) { item in
                VStack(alignment: .leading, spacing: 4) {
                    Text(item.label.uppercased()).font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                    DriveSyncCardView(syncID: item.sync.id)
                }
            }
        }
        .environment(app)
        .padding(24)
        .frame(width: size.width, height: size.height, alignment: .top)
        .background(Color(nsColor: .windowBackgroundColor))
        .environment(\.colorScheme, dark ? .dark : .light)
        let hosting = NSHostingView(rootView: root)
        hosting.frame = CGRect(origin: .zero, size: size)
        let window = NSWindow(contentRect: hosting.frame, styleMask: [.borderless], backing: .buffered, defer: false)
        window.appearance = NSAppearance(named: dark ? .darkAqua : .aqua)
        window.contentView = hosting
        window.orderFrontRegardless()
        RunLoop.main.run(until: Date().addingTimeInterval(1.5))
        hosting.layoutSubtreeIfNeeded()
        let rep = try XCTUnwrap(hosting.bitmapImageRepForCachingDisplay(in: hosting.bounds))
        hosting.cacheDisplay(in: hosting.bounds, to: rep)
        let png = try XCTUnwrap(rep.representation(using: .png, properties: [:]))
        let name = dark ? "mac-documents-sync-card-dark" : "mac-documents-sync-card-light"
        try png.write(to: evidenceDir.appendingPathComponent("\(name).png"))
        window.orderOut(nil)
        XCTAssertGreaterThan(png.count, 1_000, "\(name) looks empty")
    }

    func testLight() throws { try write(dark: false) }
    func testDark() throws { try write(dark: true) }
}
