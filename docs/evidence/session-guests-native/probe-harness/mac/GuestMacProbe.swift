import SwiftUI
import OrbitKit

// Evidence probe (see ../README.md): the Mac app's own window (`MainView`, which OrbitApp.swift's
// RootView shows once signed in — the probe replaces that file), pointed at stub.py with
// `-orbit.instance`. The picture is taken BY THE APP (`WindowShot`): the window server's image of its
// own window, which needs no screen-recording permission on a CI Mac.
@main
struct GuestMacProbeApp: App {
    @State private var model: AppModel
    @StateObject private var updater = UpdaterModel()

    init() {
        ProbeArgs.wipeIfFresh()
        _model = State(initialValue: AppModel())
    }

    var body: some Scene {
        WindowGroup {
            MainView()
                .environment(model)
                .environmentObject(updater)
                .frame(minWidth: 900, minHeight: 600)
                .task {
                    await ProbeArgs.land(model)
                    await WindowShot.takeIfAsked()
                }
        }
        .defaultSize(width: 1020, height: 660)
        .defaultPosition(.topLeading)
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
            FileHandle.standardError.write(Data("probe: no window image\n".utf8))
            return
        }
        let rep = NSBitmapImageRep(cgImage: image)
        rep.size = window.frame.size
        try? rep.representation(using: .png, properties: [:])?.write(to: URL(fileURLWithPath: path))
    }
}

/// MenuBarContent opens the runner window by this id (OrbitApp.swift, which the probe replaces).
enum OrbitApp {
    static let runnerWindowID = "runner-manager"
}
