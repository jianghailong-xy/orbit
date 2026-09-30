import AppKit
import SwiftUI

// TEMPORARY evidence probe (see ../../../README.md). An unbundled SwiftUI `App` opens no window on the
// runner, so the window is built by hand: the probe's root in an NSHostingController, one window, and
// the window server's own picture of it (CGWindowListCreateImage, looked up at run time — the SDK no
// longer declares it, the system still has it, and a process may photograph its own window).

@MainActor
final class ProbeDelegate: NSObject, NSApplicationDelegate {
    private var window: NSWindow?

    func applicationDidFinishLaunching(_ notification: Notification) {
        let size = NSSize(width: 640, height: 960)
        let host = NSHostingController(rootView: ProbeRoot().frame(width: size.width, height: size.height))
        let window = NSWindow(contentViewController: host)
        window.title = "Runner 页整页改版（iOS/macOS + web）"
        window.setContentSize(size)
        window.center()
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        self.window = window
        DispatchQueue.main.asyncAfter(deadline: .now() + 3) { [weak self] in self?.capture() }
    }

    private func capture() {
        defer { NSApp.terminate(nil) }
        guard let window, let out = ProcessInfo.processInfo.environment["SHOTS_DIR"] else { return }
        typealias Create = @convention(c) (CGRect, UInt32, UInt32, UInt32) -> Unmanaged<CGImage>?
        guard let symbol = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "CGWindowListCreateImage")
        else { print("no CGWindowListCreateImage"); return }
        let create = unsafeBitCast(symbol, to: Create.self)
        // Just this window (kCGWindowListOptionIncludingWindow), without its shadow.
        guard let image = create(.null, 1 << 3, UInt32(window.windowNumber), 1 << 0)?.takeRetainedValue()
        else { print("no image"); return }
        let name = "mac-\(ProbeLaunch.screen)\(ProbeLaunch.bottom ? "-bottom" : "")\(ProbeLaunch.dark ? "-dark" : "")"
        let png = NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:])
        do {
            try png?.write(to: URL(fileURLWithPath: out).appendingPathComponent("\(name).png"))
            print("wrote \(name).png")
        } catch {
            print("could not write \(name): \(error)")
        }
    }
}

// Top-level code runs on the main thread; saying so is what lets it build the main-actor delegate.
MainActor.assumeIsolated {
    let app = NSApplication.shared
    app.setActivationPolicy(.regular)
    let delegate = ProbeDelegate()
    app.delegate = delegate
    app.run()
}
