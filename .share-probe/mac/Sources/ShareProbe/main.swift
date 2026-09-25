import AppKit
import OrbitKit
import SwiftUI

// TEMPORARY evidence probe (see ../../../README.md). argv: <mode> <outDir>. `session` opens the real
// ShareSheet from ConsoleView's own window-toolbar entry (cut out of the real file by gen.py) for a
// shared session; `project` opens the same ShareSheet as the project menu's Share… does.

enum Probe {
    static let mode = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "project"
    static let outDir = URL(fileURLWithPath: CommandLine.arguments.count > 2 ? CommandLine.arguments[2] : "shots")
    static let appModel = ProbeAppModel()

    static func log(_ line: String) {
        print("probe[\(mode)]: \(line)")
        fflush(stdout)
    }
}

/// The two things the sheets read off `AppModel`: the server (the stub) and the token store.
final class ProbeAppModel {
    let baseURL: URL? = URL(string: "http://127.0.0.1:8787")
    let tokenStore: TokenStore = {
        let store = InMemoryTokenStore()
        store.setToken("probe", for: URL(string: "http://127.0.0.1:8787")!)
        return store
    }()
}

/// The transcript under the session's entry — the only part of that page here that isn't the app's.
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
        .navigationTitle("Share links · T8")
    }
}

/// The project page under its Share panel, opened as the ⋯ menu's Share… opens it
/// (`ShareSheet(kind: .project, …)`). The page is a stand-in; the sheet is the app's.
struct ProjectPageStandIn: View {
    let appModel: ProbeAppModel
    @State private var sharing = false

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Claude 账号池：按订阅配额均衡派发").font(.title2.bold())
            Text("Open · 12 tasks · Last activity 1m ago").foregroundStyle(.secondary)
            Spacer()
        }
        .padding(24)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .navigationTitle("Claude 账号池")
        .task {
            try? await Task.sleep(nanoseconds: 1_500_000_000)
            sharing = true
        }
        .sheet(isPresented: $sharing) {
            if let baseURL = appModel.baseURL {
                ShareSheet(kind: .project, rootID: "34UonbgOiq9ajX8aH3JPz", baseURL: baseURL,
                           tokenStore: appModel.tokenStore)
            }
        }
    }
}

/// The window a SwiftUI `WindowGroup` would open — built by hand, because an unbundled executable's
/// SwiftUI app opened none on the runner. `sceneBridgingOptions` hands the view's `.toolbar` to this
/// NSWindow, as the app's own scene does.
final class ProbeDelegate: NSObject, NSApplicationDelegate {
    private var window: NSWindow?

    func applicationDidFinishLaunching(_ notification: Notification) {
        let root = NavigationSplitView {
            List {
                Label("Share links · T8", systemImage: "bubble.left")
                Label("Claude 账号池", systemImage: "square.grid.2x2")
            }
            .navigationSplitViewColumnWidth(220)
        } detail: {
            if Probe.mode == "session" {
                SessionPageStandIn(sessionID: "live", appModel: Probe.appModel)
            } else {
                ProjectPageStandIn(appModel: Probe.appModel)
            }
        }
        let host = NSHostingController(rootView: root)
        host.sceneBridgingOptions = [.toolbars]
        let window = NSWindow(contentViewController: host)
        window.title = Probe.mode == "session" ? "Share links · T8" : "Claude 账号池"
        window.styleMask = [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView]
        window.toolbarStyle = .unified
        window.setContentSize(NSSize(width: 1000, height: 760))
        window.center()
        window.makeKeyAndOrderFront(nil)
        self.window = window
        NSApp.activate(ignoringOtherApps: true)

        Task { @MainActor in
            try? await Task.sleep(nanoseconds: 9_000_000_000)
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
        save(main, as: "mac-\(Probe.mode)-window")
        if let sheet = main.attachedSheet {
            save(sheet, as: "mac-\(Probe.mode)-sheet")
        } else {
            Probe.log("no sheet attached")
        }
        onScreen(main, as: "mac-\(Probe.mode)-window-with-sheet")
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
