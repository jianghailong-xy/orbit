import SwiftUI
import OrbitKit

// TEMPORARY evidence probe (never merged): the Mac app's AppModel, pointed at stub.py with
// `-orbit.instance`, drawing nothing but the real owner exception card at a conversation panel's
// width — and photographing its own window (`-probe.shot <path>`), which needs no Screen Recording
// grant: `CGWindowListCreateImage` of THIS app's window, as the source-refused probe's WindowShot.
@main
struct WhoFixesMacProbeApp: App {
    @NSApplicationDelegateAdaptor(ProbeDelegate.self) private var delegate

    init() {
        ProbeArgs.log("init: \(ProcessInfo.processInfo.arguments.joined(separator: " "))")
        ProbeArgs.wipeIfFresh()
    }

    // No WindowGroup: on the CI Mac the scene's window never came up for a binary launched from a
    // shell (run 43833522057: no request reached the stub, no line reached the log). The delegate
    // makes the one window itself.
    var body: some Scene {
        Settings { EmptyView() }
    }
}

/// Builds the window by hand once the app has launched: borderless (so AppKit lets it be taller
/// than the CI Mac's 677-point screen), the probe page in an NSHostingView, then the shot.
final class ProbeDelegate: NSObject, NSApplicationDelegate {
    private var window: NSWindow?
    private var model: AppModel?

    @MainActor
    func applicationDidFinishLaunching(_ notification: Notification) {
        ProbeArgs.log("launched")
        NSApp.setActivationPolicy(.regular)
        let model = AppModel()
        self.model = model
        let page = ProbeCardPage(width: 640).environment(model).frame(width: 664, height: 1500, alignment: .top)
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 664, height: 1500),
                              styleMask: [.borderless], backing: .buffered, defer: false)
        window.contentView = NSHostingView(rootView: page)
        window.setFrame(NSRect(x: 0, y: 0, width: 664, height: 1500), display: true)
        window.orderFrontRegardless()
        NSApp.activate(ignoringOtherApps: true)
        self.window = window
        ProbeArgs.log("window: \(window.frame) visible=\(window.isVisible) base=\(String(describing: model.baseURL))")
        Task { @MainActor in await WindowShot.takeIfAsked() }
    }
}

/// `-probe.shot <path>`: let the console read the stub and the card read the coordinator status,
/// then write the window's own image — twice, the last one settled — and quit.
enum WindowShot {
    @MainActor
    static func takeIfAsked() async {
        guard let path = ProbeArgs.value("-probe.shot") else { return }
        try? await Task.sleep(for: .seconds(25))
        write(path)
        try? await Task.sleep(for: .seconds(8))
        write(path)
        NSApp.terminate(nil)
    }

    @MainActor
    private static func write(_ path: String) {
        guard let window = NSApp.windows.first(where: { $0.isVisible }),
              let image = CGWindowListCreateImage(.null, .optionIncludingWindow,
                                                  CGWindowID(window.windowNumber),
                                                  [.boundsIgnoreFraming, .bestResolution]) else {
            ProbeArgs.log("shot: no image for \(NSApp.windows.count) windows")
            return
        }
        let rep = NSBitmapImageRep(cgImage: image)
        rep.size = window.frame.size
        let data = rep.representation(using: .png, properties: [:])
        do {
            try data?.write(to: URL(fileURLWithPath: path))
            ProbeArgs.log("shot: \(path) \(data?.count ?? 0) bytes, image \(image.width)x\(image.height), window \(window.frame)")
        } catch {
            ProbeArgs.log("shot: could not write \(path): \(error)")
        }
    }
}

/// MenuBarContent opens the runner window by this id (OrbitApp.swift, which the probe replaces).
enum OrbitApp {
    static let runnerWindowID = "runner-manager"
}
