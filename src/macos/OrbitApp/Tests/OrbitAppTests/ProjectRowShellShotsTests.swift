import AppKit
import SwiftUI
import XCTest
import OrbitKit
@testable import OrbitApp

/// PROBE HARNESS (branch `probe/project-row-shell-macos-shots` only) — photographs the real Mac
/// session list for the project-row-shell change, and draws the drag preview's card where the
/// implementation puts it relative to the pointer.
///
/// It hosts the real `MainView` (three-column Mac shell) against the local stub in
/// `project-row-shell-macos-shots/stub.py`, with an `InMemoryTokenStore` (this Mac's Keychain read
/// blocks a test forever). No mouse drag is made: this Mac has neither Accessibility nor
/// Screen-Recording permission, so `SessionDragState` is driven directly (`begin` + `hover`), which
/// is exactly what the drop delegate's `dropEntered` sets. Everything drawn is the feature's code.
@MainActor
final class ProjectRowShellShotsTests: XCTestCase {

    private var model: AppModel!
    private var window: NSWindow?
    private var captureScale: CGFloat = 1
    private var titleBarHeight: CGFloat = 0
    private var swizzled = false

    private var out: URL {
        let path = ProcessInfo.processInfo.environment["PROJECT_SHOTS_OUT"] ?? "/tmp/project-row-shots"
        try? FileManager.default.createDirectory(at: URL(fileURLWithPath: path),
                                                 withIntermediateDirectories: true)
        return URL(fileURLWithPath: path)
    }

    private var stub: String {
        ProcessInfo.processInfo.environment["PROJECT_STUB_URL"] ?? "http://127.0.0.1:8765"
    }

    // MARK: - window / capture

    private func show<V: View>(_ root: V, size: CGSize) async -> NSWindow {
        let hosting = NSHostingView(rootView: root)
        hosting.frame = NSRect(origin: .zero, size: size)
        let w = NSWindow(contentRect: hosting.frame,
                         styleMask: [.titled, .closable, .resizable],
                         backing: .buffered, defer: false)
        w.title = "Orbit (probe)"
        w.contentView = hosting
        w.setFrame(NSRect(x: 40, y: 60, width: size.width, height: size.height), display: true)
        w.makeKeyAndOrderFront(nil)
        await pump(1.5)
        titleBarHeight = w.frame.height - w.contentLayoutRect.height
        return w
    }

    private func pump(_ seconds: Double) async {
        let deadline = Date().addingTimeInterval(seconds)
        while Date() < deadline {
            RunLoop.main.run(until: Date().addingTimeInterval(0.02))
            try? await Task.sleep(nanoseconds: 15_000_000)
        }
    }

    @discardableResult
    private func shoot(_ name: String) throws -> URL {
        guard let w = window, let frameView = w.contentView?.superview else {
            throw NSError(domain: "probe", code: 1, userInfo: [NSLocalizedDescriptionKey: "no window"])
        }
        w.displayIfNeeded()
        frameView.layoutSubtreeIfNeeded()
        let rep = try XCTUnwrap(frameView.bitmapImageRepForCachingDisplay(in: frameView.bounds),
                                "no bitmap rep for \(name)")
        frameView.cacheDisplay(in: frameView.bounds, to: rep)
        captureScale = CGFloat(rep.pixelsWide) / frameView.bounds.width
        let png = try XCTUnwrap(rep.representation(using: .png, properties: [:]))
        let url = out.appendingPathComponent("\(name).png")
        try png.write(to: url)
        print("SHOT \(name).png \(png.count) bytes scale=\(captureScale) titleBar=\(titleBarHeight)")
        return url
    }

    // MARK: - model

    private func signIn() async throws {
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
        print("PROJECTS \(model.projects?.sidebarProjects.map(\.id) ?? [])")
    }

    private func waitForDrag(_ what: String) async throws -> SessionDragState {
        for _ in 0..<24 {
            if let drag = DragShotsProbe.latest { return drag }
            await pump(0.25)
        }
        throw XCTSkip("the \(what) never published its drag state")
    }

    // MARK: - the states

    func testProjectRowShellStates() async throws {
        try await signIn()
        DragShotsProbe.reset()
        // The drag state's 60 Hz timer ends a drag whose mouse button is up, and no real button is
        // down here. The pointer is held far from the list so it never auto-scrolls. (Simulated —
        // this Mac has no Accessibility permission to press a mouse.)
        setPointer(down: true, at: NSPoint(x: -2000, y: -2000))
        defer { removeSwizzle() }

        model.selectedSection = .agents
        model.selectedAgentID = "w1"
        let w = await show(MainView().environment(model), size: CGSize(width: 1440, height: 900))
        window = w
        await pump(2.0)

        // (b) The list: a pinned project row, a non-pinned project row, a coordinator-less project,
        // plain sessions (one pinned) and the folder rows.
        try shoot("after-01-session-list")

        // (c) The pinned project's row selected natively — its tag is the coordinator's id.
        model.selectedAgentSessionID = "c1"
        await pump(1.2)
        print("SELECTED \(model.selectedAgentSessionID ?? "nil")")
        try shoot("after-02-project-row-selected")
        model.selectedAgentSessionID = nil
        await pump(0.6)

        // (d) A drag in flight: the row dimmed and the folder row lit. The pointer is put over the
        // folder row, and the preview card is drawn where the implementation places it.
        let drag = try await waitForDrag("session list")
        let folderFrame = try XCTUnwrap(DragShotsProbe.folderRowFrame,
                                        "the folder row never reported its frame")
        print("FOLDER-FRAME \(folderFrame)")
        let plain = try XCTUnwrap(model.sessions.first { $0.id == "s5" }, "s5 missing")
        drag.begin(plain)
        drag.hover = SessionDragState.Target(folderID: "f1")
        await pump(1.0)
        let lit = try shoot("after-03-folder-row-lit-while-dragging")
        drag.end()

        // SwiftUI's `.global` frame here is already in the window's own top-left coordinates —
        // the same space the captured window bitmap uses (verified against the folder row in the
        // shot).
        let pointer = CGPoint(x: folderFrame.midX, y: folderFrame.midY)
        let preview = try renderPreview(scale: captureScale)
        try writePreview(preview, name: "after-04-drag-preview-card")
        // The card alone, cut out of the padded preview, so the pill itself is easy to read.
        try writeCroppedPreview(preview, name: "after-04b-drag-preview-card-cropped")
        try compose(list: lit, preview: preview, pointer: pointer,
                    name: "after-05-drag-preview-composite")
    }

    // MARK: - the preview card

    /// `SessionDragPreview` exactly as `onDrag(_:preview:)` gets it — card plus transparent padding.
    private func renderPreview(scale: CGFloat) throws -> NSImage {
        let renderer = ImageRenderer(content: SessionDragPreview(title: "Plain session without a pin"))
        renderer.scale = scale
        return try XCTUnwrap(renderer.nsImage, "the preview view did not render")
    }

    private func writePreview(_ image: NSImage, name: String) throws {
        guard let cg = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
            throw NSError(domain: "probe", code: 2,
                          userInfo: [NSLocalizedDescriptionKey: "no CGImage for preview"])
        }
        let rep = NSBitmapImageRep(cgImage: cg)
        let png = try XCTUnwrap(rep.representation(using: .png, properties: [:]))
        try png.write(to: out.appendingPathComponent("\(name).png"))
        print("SHOT \(name).png \(Int(image.size.width))x\(Int(image.size.height))pt \(png.count) bytes")
    }

    /// The pill alone: the preview's leading/top padding is `SessionDragPreview`'s own, so the card
    /// sits at (width, expectedHeight) inside it.
    private func writeCroppedPreview(_ image: NSImage, name: String) throws {
        guard let cg = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
            throw NSError(domain: "probe", code: 2,
                          userInfo: [NSLocalizedDescriptionKey: "no CGImage for preview"])
        }
        let card = CGRect(x: SessionDragPreview.width, y: 58,
                          width: SessionDragPreview.width, height: CGFloat(cg.height) - 58)
            .insetBy(dx: -4, dy: -4)
        let cropped = try XCTUnwrap(cg.cropping(to: card), "no cropped card")
        let rep = NSBitmapImageRep(cgImage: cropped)
        let png = try XCTUnwrap(rep.representation(using: .png, properties: [:]))
        try png.write(to: out.appendingPathComponent("\(name).png"))
        print("SHOT \(name).png \(cropped.width)x\(cropped.height) \(png.count) bytes")
    }

    /// The list with the folder row lit, a pointer arrow over that row, and the preview image placed
    /// so its centre is at the pointer — which is how macOS draws a SwiftUI drag preview. The card
    /// inside the padded preview therefore lands at the offset the implementation chose.
    private func compose(list: URL, preview: NSImage, pointer: CGPoint, name: String) throws {
        let base = try XCTUnwrap(NSImage(contentsOf: list), "no base image")
        guard let baseCG = base.cgImage(forProposedRect: nil, context: nil, hints: nil),
              let previewCG = preview.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
            throw NSError(domain: "probe", code: 3, userInfo: [NSLocalizedDescriptionKey: "no CGImage"])
        }
        let W = baseCG.width, H = baseCG.height
        let rep = try XCTUnwrap(NSBitmapImageRep(
            bitmapDataPlanes: nil, pixelsWide: W, pixelsHigh: H, bitsPerSample: 8,
            samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB,
            bytesPerRow: 0, bitsPerPixel: 0))
        let ctx = try XCTUnwrap(NSGraphicsContext(bitmapImageRep: rep))
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = ctx
        let cg = ctx.cgContext
        // AppKit's bitmap context is bottom-left; the screenshots are top-left, as are the frames
        // this test reads. Convert each top-left rect below.
        func topLeftRect(_ rect: CGRect) -> CGRect {
            CGRect(x: rect.minX, y: CGFloat(H) - rect.maxY, width: rect.width, height: rect.height)
        }
        cg.draw(baseCG, in: CGRect(x: 0, y: 0, width: CGFloat(W), height: CGFloat(H)))
        // The pointer's tip, at the point chosen over the folder row.
        let cursor = NSCursor.arrow.image.cgImage(forProposedRect: nil, context: nil, hints: nil)
        if let cursor {
            let size = CGSize(width: CGFloat(cursor.width) * 2, height: CGFloat(cursor.height) * 2)
            cg.draw(cursor, in: topLeftRect(CGRect(origin: pointer, size: size)))
        }
        // The preview image centred on the pointer.
        let size = CGSize(width: CGFloat(previewCG.width), height: CGFloat(previewCG.height))
        cg.draw(previewCG, in: topLeftRect(CGRect(x: pointer.x - size.width / 2,
                                                  y: pointer.y - size.height / 2,
                                                  width: size.width, height: size.height)))
        NSGraphicsContext.restoreGraphicsState()
        let png = try XCTUnwrap(rep.representation(using: .png, properties: [:]))
        try png.write(to: out.appendingPathComponent("\(name).png"))
        print("SHOT \(name).png \(W)x\(H) pointer=\(pointer) preview=\(size) \(png.count) bytes")
    }

    // MARK: - NSEvent swizzle (the pointer only)

    private func setPointer(down: Bool, at point: NSPoint) {
        DragShotsProbe.fakeButtonDown = down
        DragShotsProbe.fakeMouseLocation = point
        guard !swizzled else { return }
        let cls: AnyClass = NSEvent.self
        method_exchangeImplementations(
            class_getClassMethod(cls, NSSelectorFromString("pressedMouseButtons"))!,
            class_getClassMethod(cls, NSSelectorFromString("dragProbePressedMouseButtons"))!)
        method_exchangeImplementations(
            class_getClassMethod(cls, NSSelectorFromString("mouseLocation"))!,
            class_getClassMethod(cls, NSSelectorFromString("dragProbeMouseLocation"))!)
        swizzled = true
    }

    private func removeSwizzle() {
        guard swizzled else { return }
        let cls: AnyClass = NSEvent.self
        method_exchangeImplementations(
            class_getClassMethod(cls, NSSelectorFromString("pressedMouseButtons"))!,
            class_getClassMethod(cls, NSSelectorFromString("dragProbePressedMouseButtons"))!)
        method_exchangeImplementations(
            class_getClassMethod(cls, NSSelectorFromString("mouseLocation"))!,
            class_getClassMethod(cls, NSSelectorFromString("dragProbeMouseLocation"))!)
        swizzled = false
    }
}

extension NSEvent {
    @objc class func dragProbePressedMouseButtons() -> Int {
        MainActor.assumeIsolated { DragShotsProbe.fakeButtonDown ? 1 : 0 }
    }

    @objc class func dragProbeMouseLocation() -> NSPoint {
        MainActor.assumeIsolated { DragShotsProbe.fakeMouseLocation }
    }
}
