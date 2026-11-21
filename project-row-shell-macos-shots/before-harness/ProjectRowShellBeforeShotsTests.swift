import AppKit
import SwiftUI
import XCTest
import OrbitKit
@testable import OrbitApp

/// BEFORE shot for the project-row-shell change: the same real Mac session list as
/// `ProjectRowShellShotsTests` (on the AFTER branch), at the parent commit `eae1745321`.
/// Hosts the real `MainView` against `project-row-shell-macos-shots/stub.py` with an
/// `InMemoryTokenStore`; no drag is made, so no `NSEvent` swizzle is needed.
@MainActor
final class ProjectRowShellBeforeShotsTests: XCTestCase {

    private var model: AppModel!
    private var window: NSWindow?

    private var out: URL {
        let path = ProcessInfo.processInfo.environment["PROJECT_SHOTS_OUT"] ?? "/tmp/project-row-shots"
        try? FileManager.default.createDirectory(at: URL(fileURLWithPath: path),
                                                 withIntermediateDirectories: true)
        return URL(fileURLWithPath: path)
    }

    private var stub: String {
        ProcessInfo.processInfo.environment["PROJECT_STUB_URL"] ?? "http://127.0.0.1:8765"
    }

    private func pump(_ seconds: Double) async {
        let deadline = Date().addingTimeInterval(seconds)
        while Date() < deadline {
            RunLoop.main.run(until: Date().addingTimeInterval(0.02))
            try? await Task.sleep(nanoseconds: 15_000_000)
        }
    }

    private func shoot(_ name: String) throws {
        guard let w = window, let frameView = w.contentView?.superview else {
            return XCTFail("no window for \(name)")
        }
        w.displayIfNeeded()
        frameView.layoutSubtreeIfNeeded()
        let rep = try XCTUnwrap(frameView.bitmapImageRepForCachingDisplay(in: frameView.bounds))
        frameView.cacheDisplay(in: frameView.bounds, to: rep)
        let png = try XCTUnwrap(rep.representation(using: .png, properties: [:]))
        try png.write(to: out.appendingPathComponent("\(name).png"))
        print("SHOT \(name).png \(png.count) bytes")
    }

    func testProjectRowShellBefore() async throws {
        _ = NSApplication.shared
        NSApplication.shared.setActivationPolicy(.accessory)
        UserDefaults.standard.removeObject(forKey: "orbit.instance")
        UserDefaults.standard.removeObject(forKey: "orbit.email")
        UserDefaults.standard.removeObject(forKey: "orbit.lastAgent")

        model = AppModel(tokenStore: InMemoryTokenStore())
        model.instanceField = stub
        model.email = "probe@example.test"
        model.password = "probe"
        await model.login()
        XCTAssertTrue(model.signedIn, "sign-in against the stub failed: \(model.errorText ?? "no message")")
        await model.loadAgentsThenLand()
        await model.loadSessionFolders()
        _ = await model.loadSessions()
        await pump(1.0)
        print("SESSIONS \(model.sessions.map(\.id))")
        print("FOLDERS \(model.sessionFolders.map(\.name))")

        model.selectedSection = .agents
        model.selectedAgentID = "w1"
        let hosting = NSHostingView(rootView: MainView().environment(model))
        let size = CGSize(width: 1440, height: 900)
        hosting.frame = NSRect(origin: .zero, size: size)
        let w = NSWindow(contentRect: hosting.frame,
                         styleMask: [.titled, .closable, .resizable],
                         backing: .buffered, defer: false)
        w.title = "Orbit (before probe)"
        w.contentView = hosting
        w.setFrame(NSRect(x: 40, y: 60, width: size.width, height: size.height), display: true)
        w.makeKeyAndOrderFront(nil)
        window = w
        await pump(2.0)
        try shoot("before-01-session-list")
    }
}
