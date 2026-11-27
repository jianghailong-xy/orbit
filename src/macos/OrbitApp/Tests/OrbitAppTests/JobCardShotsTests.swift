import AppKit
import SwiftUI
import XCTest
import OrbitKit
@testable import OrbitApp

/// Frames of the real Job card on the Mac (`JobCardGallery`): every folded state and the opened card.
/// Hosted in a window and given a moment, so its tail read and timers run as they do in the app. PNGs land
/// in `src/macos/build/evidence/bg-job-card-macos/` for the evidence envelope.
@MainActor
final class JobCardShotsTests: XCTestCase {

    private var evidenceDir: URL {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<10 {
            if FileManager.default.fileExists(atPath: dir.appendingPathComponent("src/macos/OrbitApp/Package.swift").path) {
                let out = dir.appendingPathComponent("src/macos/build/evidence/bg-job-card-macos")
                try? FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)
                return out
            }
            dir = dir.deletingLastPathComponent()
        }
        let out = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("bg-job-card-macos")
        try? FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)
        return out
    }

    private func write<V: View>(_ name: String, _ view: V, size: CGSize, dark: Bool = false) throws {
        let root = view
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
        // Its first tail read and a tick of its clock.
        RunLoop.main.run(until: Date().addingTimeInterval(1.5))
        hosting.layoutSubtreeIfNeeded()
        let rep = try XCTUnwrap(hosting.bitmapImageRepForCachingDisplay(in: hosting.bounds))
        hosting.cacheDisplay(in: hosting.bounds, to: rep)
        let png = try XCTUnwrap(rep.representation(using: .png, properties: [:]))
        try png.write(to: evidenceDir.appendingPathComponent("\(name).png"))
        window.orderOut(nil)
        XCTAssertGreaterThan(png.count, 1_000, "\(name) looks empty")
    }

    func testFoldedStates() throws {
        try write("mac-job-card-folded", JobCardGallery(page: .folded), size: CGSize(width: 820, height: 900))
    }

    func testFoldedStatesDark() throws {
        try write("mac-job-card-folded-dark", JobCardGallery(page: .folded), size: CGSize(width: 820, height: 900), dark: true)
    }

    func testBackgroundRow() throws {
        try write("mac-job-tray-folded", JobCardGallery(page: .tray), size: CGSize(width: 820, height: 200))
    }

    func testOpenedCard() throws {
        try write("mac-job-card-opened", JobCardGallery(page: .opened), size: CGSize(width: 820, height: 1400))
    }
}
