import AppKit
import SwiftUI
import XCTest
import OrbitKit
@testable import OrbitApp

/// ImageRenderer frames of the real waiting card of a session held by its clone (`CloneWaitCardView`): PENDING and
/// CLONING at 42%, full-height and under a transcript, in light and dark, at a Mac window's and a phone's width.
/// PNGs land in `src/macos/build/evidence/clone-wait/`.
@MainActor
final class CloneWaitShotsTests: XCTestCase {
    private var dir: URL {
        var d = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<10 {
            if FileManager.default.fileExists(atPath: d.appendingPathComponent("src/macos/OrbitApp/Package.swift").path) {
                let out = d.appendingPathComponent("src/macos/build/evidence/clone-wait")
                try? FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)
                return out
            }
            d = d.deletingLastPathComponent()
        }
        return URL(fileURLWithPath: NSTemporaryDirectory())
    }

    func testFrames() throws {
        let cards: [(String, QueuedClone.Card)] = [
            ("pending", .init(state: .pending, progress: nil, repository: "acme/widgets")),
            ("cloning-42", .init(state: .cloning, progress: 42, repository: "acme/widgets")),
        ]
        for (device, width) in [("mac", CGFloat(900))] {
            for scheme in [ColorScheme.light, .dark] {
                for (name, card) in cards {
                    for compact in [false, true] {
                        let view = CloneWaitCardView(card: card, machine: "HPC", compact: compact)
                            .frame(width: width, height: compact ? 90 : 360)
                            .background(Color(nsColor: .windowBackgroundColor))
                        // The real AppKit-hosted view, drawn the way a window draws it, so the spinner is the real one.
                        let host = NSHostingView(rootView: view)
                        host.frame = NSRect(x: 0, y: 0, width: width, height: compact ? 90 : 360)
                        let window = NSWindow(contentRect: host.frame, styleMask: [.borderless], backing: .buffered, defer: false)
                        window.appearance = NSAppearance(named: scheme == .dark ? .darkAqua : .aqua)
                        window.contentView = host
                        host.layoutSubtreeIfNeeded()
                        RunLoop.current.run(until: Date().addingTimeInterval(0.3))
                        let rep = try XCTUnwrap(host.bitmapImageRepForCachingDisplay(in: host.bounds))
                        host.cacheDisplay(in: host.bounds, to: rep)
                        let png = try XCTUnwrap(rep.representation(using: .png, properties: [:]))
                        try png.write(to: dir.appendingPathComponent("\(device)-\(scheme == .dark ? "dark" : "light")-\(name)-\(compact ? "compact" : "full").png"))
                    }
                }
            }
        }
    }
}
