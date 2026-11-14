import SwiftUI
import AppKit
import OrbitKit

// Evidence probe (see ../README.md): the Mac app's own `MainView` (which OrbitApp.swift's RootView
// shows once signed in — the probe replaces that file), pointed at stub.py with `-orbit.instance`.
// The window is made here rather than by a WindowGroup: launched from a script on a CI Mac, a
// WindowGroup may open no window at all, and then nothing runs. The picture is taken BY THE APP
// (`WindowShot`): the window server's image of its own window, which needs no screen-recording
// permission.
@main
struct GuestMacProbeApp: App {
    @NSApplicationDelegateAdaptor(ProbeDelegate.self) private var delegate
    var body: some Scene {
        Settings { EmptyView() }
    }
}

@MainActor
final class ProbeDelegate: NSObject, NSApplicationDelegate {
    private var window: NSWindow?
    private let model: AppModel
    private let updater = UpdaterModel()

    override init() {
        ProbeArgs.wipeIfFresh()
        model = AppModel()
        super.init()
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
        let root = MainView()
            .environment(model)
            .environmentObject(updater)
            .frame(minWidth: 900, minHeight: 600)
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1020, height: 660),
                              styleMask: [.titled, .closable, .resizable, .miniaturizable],
                              backing: .buffered, defer: false)
        window.contentView = NSHostingView(rootView: root)
        window.setFrameTopLeftPoint(NSPoint(x: 0, y: (NSScreen.main?.visibleFrame.maxY ?? 760)))
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        self.window = window
        FileHandle.standardError.write(Data("probe: window \(window.frame) base=\(String(describing: model.baseURL))\n".utf8))
        Task { @MainActor in
            await ProbeArgs.land(model)
            await WindowShot.takeIfAsked()
        }
    }
}

/// `-probe.shot <path>`: once the stub's state has been drawn, write the window's own image as a PNG,
/// again every few seconds so the last write is the settled state.
enum WindowShot {
    static func takeIfAsked() async {
        guard let path = ProbeArgs.arg("-probe.shot") else { return }
        for _ in 0..<30 {
            try? await Task.sleep(for: .seconds(3))
            await write(path)
        }
    }

    @MainActor
    private static func write(_ path: String) {
        guard let window = NSApp.windows.first(where: { $0.isVisible }),
              let image = CGWindowListCreateImage(.null, .optionIncludingWindow,
                                                  CGWindowID(window.windowNumber),
                                                  [.boundsIgnoreFraming, .bestResolution]) else {
            FileHandle.standardError.write(Data("probe: no window image (\(NSApp.windows.count) windows)\n".utf8))
            return
        }
        let rep = NSBitmapImageRep(cgImage: image)
        rep.size = window.frame.size
        do {
            try rep.representation(using: .png, properties: [:])?.write(to: URL(fileURLWithPath: path))
        } catch {
            FileHandle.standardError.write(Data("probe: could not write \(path): \(error)\n".utf8))
        }
    }
}

/// MenuBarContent opens the runner window by this id (OrbitApp.swift, which the probe replaces).
enum OrbitApp {
    static let runnerWindowID = "runner-manager"
}
