import AppKit
import SwiftUI
import XCTest
import OrbitKit
@testable import OrbitApp

/// PROBE HARNESS (branch `probe/drag-folder-macos-shots-96c00c6` only) — photographs the real Mac
/// views for drag-a-session-row-onto-a-folder. It hosts the real `MainView` (three-column shell,
/// toast host included) against a local stub server, then reproduces what the drop delegate does:
/// `SessionDragState.begin`, set `hover`, then `AppModel.moveSession`. No real mouse drag is made —
/// this Mac has neither Accessibility nor Screen-Recording permission (AXIsProcessTrusted=false,
/// `screencapture` fails), so synthetic mouse input and screen capture are both unavailable.
///
/// Two things are simulated and nothing else:
///   • the pointer state (`NSEvent.pressedMouseButtons`/`mouseLocation`, swizzled), because the drag
///     state's own 60 Hz timer ends a drag whose button is up — without it the hover is cleared in
///     the first tick;
///   • who is picked up and where it hovers (`begin`/`hover`), because no mouse can be pressed.
/// Everything drawn is the feature's own code, and the drop itself is the delegate's own call.
@MainActor
final class DragFolderShotsTests: XCTestCase {

    private var model: AppModel!
    private var window: NSWindow?
    private var swizzled = false

    private var out: URL {
        let path = ProcessInfo.processInfo.environment["DRAG_SHOTS_OUT"] ?? "/tmp/drag-shots"
        try? FileManager.default.createDirectory(at: URL(fileURLWithPath: path),
                                                 withIntermediateDirectories: true)
        return URL(fileURLWithPath: path)
    }

    private var stub: String {
        ProcessInfo.processInfo.environment["DRAG_STUB_URL"] ?? "http://127.0.0.1:8765"
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
        return w
    }

    /// Runs the main run loop (the feature's Timer lives on it) and yields to the main actor, so the
    /// model's own async work — the move's request and toast — can run too.
    private func pump(_ seconds: Double) async {
        let deadline = Date().addingTimeInterval(seconds)
        while Date() < deadline {
            RunLoop.main.run(until: Date().addingTimeInterval(0.02))
            try? await Task.sleep(nanoseconds: 15_000_000)
        }
    }

    /// The whole window — titlebar/toolbar included, which is where a folder page's head lives.
    private func shoot(_ name: String) throws {
        guard let w = window, let frameView = w.contentView?.superview else {
            return XCTFail("no window for \(name)")
        }
        w.displayIfNeeded()
        frameView.layoutSubtreeIfNeeded()
        let rep = try XCTUnwrap(frameView.bitmapImageRepForCachingDisplay(in: frameView.bounds),
                                "no bitmap rep for \(name)")
        frameView.cacheDisplay(in: frameView.bounds, to: rep)
        let png = try XCTUnwrap(rep.representation(using: .png, properties: [:]))
        try png.write(to: out.appendingPathComponent("\(name).png"))
        print("SHOT \(name).png \(png.count) bytes")
    }

    // MARK: - model

    private func signIn() async throws {
        // The app's model touches `NSApp.dockTile` on its poll; a plain xctest process has no NSApp.
        _ = NSApplication.shared
        NSApplication.shared.setActivationPolicy(.accessory)
        UserDefaults.standard.removeObject(forKey: "orbit.instance")
        UserDefaults.standard.removeObject(forKey: "orbit.email")
        UserDefaults.standard.removeObject(forKey: "orbit.lastAgent")
        print("BUNDLE-ID \(Bundle.main.bundleIdentifier ?? "nil")")

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
        print("AGENTS \(model.agents?.items.map(\.id) ?? [])")
        print("SESSIONS \(model.sessions.map(\.id))")
        print("FOLDERS \(model.sessionFolders.map(\.name))")
        XCTAssertEqual(model.sessionFolders.map(\.name), ["Design docs", "Bug fixes", "Screenshots"])
        XCTAssertTrue(model.sessions.contains { $0.id == "s3" })
    }

    private func session(_ id: String) -> Session? { model.sessions.first { $0.id == id } }

    private func waitForDrag(_ what: String) async throws -> SessionDragState {
        for _ in 0..<24 {
            if let drag = DragShotsProbe.latest { return drag }
            await pump(0.25)
        }
        throw XCTSkip("the \(what) never published its drag state")
    }

    private func waitForNoToast() async {
        for _ in 0..<80 {
            if model.toasts.transient == nil { return }
            await pump(0.1)
        }
    }

    private func waitForToast(_ expected: String) async -> String? {
        for _ in 0..<40 {
            if let toast = model.toasts.transient { return toast.message }
            await pump(0.1)
        }
        return nil
    }

    // MARK: - the states

    func testDragFolderStates() async throws {
        try await signIn()
        DragShotsProbe.reset()

        // The button "down" and the pointer far from the list, so the drag state's timer keeps the
        // drag alive but never auto-scrolls. (Simulated — see the type's comment.)
        setPointer(down: true, at: NSPoint(x: -2000, y: -2000))
        defer { removeSwizzle() }

        model.selectedSection = .agents
        model.selectedAgentID = "w1"
        let w = await show(MainView().environment(model), size: CGSize(width: 1440, height: 900))
        window = w
        await pump(1.5)
        print("WINDOW \(w.frame) toolbar=\(w.toolbar?.items.count ?? -1)")

        let drag = try await waitForDrag("session list")
        print("DRAG-SCROLLVIEW \(drag.scrollView.map { "\($0.frame)" } ?? "nil")")
        dumpScrollViews(w)

        // (1) A session row picked up, hovering the Design docs folder row.
        let row = try XCTUnwrap(session("s3"), "s3 missing")
        drag.begin(row)
        XCTAssertEqual(drag.verdict(on: "f1", workspaceID: "w1", folders: model.sessionFolders), .move)
        drag.hover = SessionDragState.Target(folderID: "f1")
        await pump(1.0)
        print("HOVER \(drag.hover?.folderID ?? "nil")")
        try shoot("01-folder-row-highlight-while-dragging")

        // (2) The drop: exactly what performDrop does — end, then the model's move.
        drag.end()
        model.moveSession("s3", toFolder: "f1")
        let toast = await waitForToast("Moved to")
        print("TOAST \(toast ?? "nil")")
        await pump(0.4)
        print("S3-FOLDER \(session("s3")?.folderId ?? "nil")")
        XCTAssertEqual(session("s3")?.folderId, "f1", "the row did not move into Design docs")
        XCTAssertEqual(model.sessionFolders.count, 3)
        try shoot("02-moved-toast-and-folder-count")

        // (3) A folder page's head as No Folder: hovering title + back, then the move out.
        DragShotsProbe.reset()
        model.openFolder(SessionFolderAddress(folderID: "f1", agentID: "w1", view: .open))
        await pump(2.0)
        let pageDrag = try await waitForDrag("folder page")
        let filed = try XCTUnwrap(model.session(id: "s3"), "s3 missing on the folder page")
        pageDrag.begin(filed)
        XCTAssertEqual(pageDrag.verdict(on: nil, workspaceID: "w1", folders: model.sessionFolders), .move)
        pageDrag.hover = SessionDragState.Target(folderID: nil)
        await pump(1.0)
        print("PAGE-HOVER \(pageDrag.hover == nil ? "no-folder" : "other")")
        try shoot("03a-folder-page-head-highlight-no-folder")
        pageDrag.end()
        model.moveSession("s3", toFolder: nil)
        let outToast = await waitForToast("Moved out")
        print("TOAST-OUT \(outToast ?? "nil")")
        await pump(0.4)
        print("S3-FOLDER-AFTER-OUT \(session("s3")?.folderId ?? "nil")")
        XCTAssertNil(session("s3")?.folderId, "the row was not moved out of the folder")
        try shoot("03b-moved-out-toast")

        // (5) Coordinator rows are not draggable at all (the row's own gate, before any drop).
        model.leaveFolder()
        await pump(1.5)
        await waitForNoToast()
        await pump(0.6)
        let coordinator = try XCTUnwrap(model.session(id: "c1"), "c1 missing")
        let draggable = SessionFolderDrag.draggable(coordinator, view: .open, hasProjectMark: false,
                                                    dropTargets: true)
        print("COORDINATOR-DRAGGABLE \(draggable)")
        XCTAssertFalse(draggable, "a coordinator row must not be a drag source")
        let liveListDrag = try await waitForDrag("list after leaving the folder")
        XCTAssertEqual(liveListDrag.verdict(on: "f2", workspaceID: "w1", folders: model.sessionFolders),
                       .refused, "with nothing picked up the folder must not light")
        try shoot("05-coordinator-row-over-folder-no-highlight")

        // (4) Auto-scroll: the real 60 Hz timer, with the pointer held at the list's top edge.
        try await autoScroll(w)
    }

    /// Runs the real `SessionDragState` timer while the pointer (swizzled) is held at the list's top
    /// edge, far down a long list, and photographs the list reaching the folders.
    private func autoScroll(_ w: NSWindow) async throws {
        let drag = try await waitForDrag("list after leaving the folder")
        let scroll = try XCTUnwrap(drag.scrollView, "no session-list NSScrollView")
        print("AUTOSCROLL-SCROLLVIEW \(scroll.frame) document=\(scroll.documentView?.frame ?? .zero)")

        // To the bottom, so the folders at the top are out of view.
        if let doc = scroll.documentView {
            if let table = doc as? NSTableView, table.numberOfRows > 0 {
                print("AUTOSCROLL-TABLE rows=\(table.numberOfRows)")
                table.scrollRowToVisible(table.numberOfRows - 1)
            } else {
                print("AUTOSCROLL-DOC \(type(of: doc))")
                let bottom = max(0, doc.frame.height - scroll.contentView.bounds.height)
                scroll.contentView.scroll(to: NSPoint(x: 0, y: doc.isFlipped ? bottom : 0))
                scroll.reflectScrolledClipView(scroll.contentView)
            }
        }
        await pump(1.0)
        let before = scroll.contentView.bounds.origin
        print("AUTOSCROLL-BEFORE \(before)")
        try shoot("04a-list-scrolled-down-folders-out-of-view")

        // The pointer, held at the top edge of the list, and the button down — as the timer reads them.
        let topInScroll = NSPoint(x: scroll.bounds.width / 2,
                                  y: scroll.isFlipped ? 4 : scroll.bounds.height - 4)
        setPointer(down: true,
                   at: scroll.window!.convertPoint(toScreen: scroll.convert(topInScroll, to: nil)))

        let row = try XCTUnwrap(model.sessions.last)
        drag.begin(row)
        await pump(3.0)
        let after = scroll.contentView.bounds.origin
        print("AUTOSCROLL-AFTER \(after)")
        XCTAssertLessThan(after.y, before.y, "the real timer did not scroll the list up")

        // Where a delegate's dropEntered would light the folder once it is under the pointer.
        drag.hover = SessionDragState.Target(folderID: "f1")
        await pump(0.8)
        try shoot("04b-autoscrolled-to-folders")
        drag.end()
    }

    private func dumpScrollViews(_ w: NSWindow) {
        var found: [NSScrollView] = []
        func walk(_ v: NSView) {
            if let s = v as? NSScrollView { found.append(s) }
            v.subviews.forEach(walk)
        }
        walk(w.contentView!)
        for s in found {
            let inWindow = s.convert(s.bounds, to: nil)
            print("SV frame=\(s.frame) inWindow=\(inWindow) doc=\(s.documentView.map { "\(type(of: $0)) \($0.frame)" } ?? "nil") flipped=\(s.documentView?.isFlipped ?? false)")
        }
    }

    // MARK: - NSEvent swizzle (the pointer only; the scroll itself is the real code)
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
