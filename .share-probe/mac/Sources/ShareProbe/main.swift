import AppKit
import SwiftUI
import OrbitKit

// TEMPORARY evidence probe (see ../../../README.md). argv: <session> <outDir>, where the session is
// the stub's `new` (not shared) or `live` (shared).

enum Probe {
    static let session = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "live"
    static let outDir = URL(fileURLWithPath: CommandLine.arguments.count > 2 ? CommandLine.arguments[2] : "shots")
    static let appModel = ProbeAppModel()

    static func log(_ line: String) {
        print("probe[\(session)]: \(line)")
        fflush(stdout)
    }
}

/// The two things ConsoleView reads off `AppModel` for its sheet: the server and the token store.
final class ProbeAppModel {
    let baseURL: URL? = URL(string: "http://127.0.0.1:8787")
    let tokenStore: TokenStore = {
        let store = InMemoryTokenStore()
        store.setToken("probe", for: URL(string: "http://127.0.0.1:8787")!)
        return store
    }()
}

/// The transcript under the entry — the only part of the page here that isn't the app's own code.
struct TranscriptStandIn: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Can reviewers read this session without an account?")
                .padding(10)
                .background(Color.accentColor.opacity(0.12), in: RoundedRectangle(cornerRadius: 10))
            Text("Yes — Share session in the toolbar makes a public, read-only link to this transcript.")
                .foregroundStyle(.secondary)
            Spacer()
        }
        .padding(24)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .navigationTitle("Share links · T3")
    }
}

/// The window a SwiftUI `WindowGroup` would open — built by hand, because an unbundled executable's
/// SwiftUI app opened none on the runner. `sceneBridgingOptions` hands the view's `.toolbar` and
/// title to this NSWindow, as the app's own scene does.
final class ProbeDelegate: NSObject, NSApplicationDelegate {
    private var window: NSWindow?

    func applicationDidFinishLaunching(_ notification: Notification) {
        let root = NavigationSplitView {
            List {
                Label("Share links · T3", systemImage: "bubble.left")
                Label("Copy Link in the project menu", systemImage: "bubble.left")
            }
            .navigationSplitViewColumnWidth(220)
        } detail: {
            SessionPageStandIn(sessionID: Probe.session, appModel: Probe.appModel)
        }
        let host = NSHostingController(rootView: root)
        host.sceneBridgingOptions = [.toolbars]
        let window = NSWindow(contentViewController: host)
        window.title = "Share links · T3"
        window.styleMask = [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView]
        window.toolbarStyle = .unified
        window.setContentSize(NSSize(width: 980, height: 640))
        window.center()
        window.makeKeyAndOrderFront(nil)
        self.window = window
        NSApp.activate(ignoringOtherApps: true)

        Task { @MainActor in
            try? await Task.sleep(nanoseconds: 8_000_000_000)
            Capture.all()
        }
        // Never hold a Mac runner: whatever happened, leave.
        DispatchQueue.global().asyncAfter(deadline: .now() + 45) {
            Probe.log("timed out")
            exit(3)
        }
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.regular)
let delegate = ProbeDelegate()
app.delegate = delegate
app.run()

@MainActor
enum Capture {
    static func all() {
        Probe.log("all windows: " + NSApp.windows.map {
            "#\($0.windowNumber) '\($0.title)' \($0.frame) visible=\($0.isVisible) sheet=\($0.isSheet)"
        }.joined(separator: " | "))
        let windows = NSApp.windows.filter(\.isVisible)
        guard let main = windows.first(where: { $0.attachedSheet != nil }) ?? windows.first(where: { !$0.isSheet })
        else {
            Probe.log("no window")
            exit(2)
        }
        save(main, as: "\(Probe.session)-window")
        if let sheet = main.attachedSheet {
            save(sheet, as: "\(Probe.session)-sheet")
        } else {
            Probe.log("no sheet attached")
        }
        onScreen(main, as: "\(Probe.session)-window-with-sheet")
        NSApp.terminate(nil)
    }

    /// One window, two ways: AppKit drawing its frame view (title bar, toolbar, content) into a
    /// bitmap, and the window server's own copy of it.
    static func save(_ window: NSWindow, as name: String) {
        if let view = window.contentView?.superview ?? window.contentView,
           let rep = view.bitmapImageRepForCachingDisplay(in: view.bounds) {
            view.cacheDisplay(in: view.bounds, to: rep)
            write(rep.representation(using: .png, properties: [:]), "\(name).cache.png")
        }
        // kCGWindowListOptionIncludingWindow, kCGWindowImageBoundsIgnoreFraming
        if let image = windowImage(CGRect.null, option: 1 << 3, window: window.windowNumber, imageOption: 1) {
            write(NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:]), "\(name).png")
        }
    }

    /// The window as it stands on screen, its sheet over it.
    static func onScreen(_ window: NSWindow, as name: String) {
        let top = NSScreen.screens.first?.frame.maxY ?? window.frame.maxY
        let f = window.frame
        let rect = CGRect(x: f.minX, y: top - f.maxY, width: f.width, height: f.height)
        // kCGWindowListOptionOnScreenOnly
        if let image = windowImage(rect, option: 1 << 0, window: 0, imageOption: 0) {
            write(NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:]), "\(name).png")
        }
        let capture = Process()
        capture.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
        capture.arguments = ["-x", "-R\(Int(rect.minX)),\(Int(rect.minY)),\(Int(rect.width)),\(Int(rect.height))",
                             Probe.outDir.appendingPathComponent("\(name).screencapture.png").path]
        do {
            try capture.run()
            capture.waitUntilExit()
            Probe.log("screencapture exited \(capture.terminationStatus)")
        } catch {
            Probe.log("screencapture: \(error)")
        }
    }

    private typealias CreateImage = @convention(c) (CGRect, UInt32, UInt32, UInt32) -> Unmanaged<CGImage>?

    /// CGWindowListCreateImage, looked up at run time: the SDK no longer declares it (ScreenCaptureKit
    /// replaced it), but the system still ships it, and the caller's own windows need no grant.
    private static func windowImage(_ rect: CGRect, option: UInt32, window: Int, imageOption: UInt32) -> CGImage? {
        guard let symbol = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "CGWindowListCreateImage") else {
            Probe.log("CGWindowListCreateImage is not there")
            return nil
        }
        let create = unsafeBitCast(symbol, to: CreateImage.self)
        let image = create(rect, option, UInt32(window), imageOption)?.takeRetainedValue()
        if image == nil { Probe.log("CGWindowListCreateImage gave nothing for \(rect) #\(window)") }
        return image
    }

    private static func write(_ png: Data?, _ file: String) {
        guard let png else {
            Probe.log("no PNG for \(file)")
            return
        }
        do {
            try png.write(to: Probe.outDir.appendingPathComponent(file))
            Probe.log("wrote \(file) (\(png.count) bytes)")
        } catch {
            Probe.log("\(file): \(error)")
        }
    }
}
