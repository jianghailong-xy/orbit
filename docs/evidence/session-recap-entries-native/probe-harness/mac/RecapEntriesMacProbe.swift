import SwiftUI
import OrbitKit

// TEMPORARY evidence probe (see ../README.md): the Mac app's own window (`MainView`, which
// OrbitApp.swift's RootView shows once signed in — the probe replaces that file), pointed at
// stub.py with `-orbit.instance`, opened on the page `-probe.page` names — S1's conversation, whose
// status bar carries the recap, or P1's page in the Projects section, whose coordinator card does.
//
// The picture is taken twice over, on purpose (the session-recap probe's arrangement): the UI test
// photographs the window, and the app photographs its own content as well (`-probe.shot`,
// `WindowShot` below), because a UI-test runner's sandbox cannot always read back what it wrote.
@main
struct RecapEntriesMacProbeApp: App {
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
        .defaultSize(width: 1010, height: 740)
        .defaultPosition(.topLeading)
    }
}

/// `-probe.windowLog <path>`: what the app did to its own windows — the picture it wrote, the size
/// the window had — where the UI-test runner's sandbox cannot read it back; `run.sh` copies the
/// file into the shots. Nothing here resizes a window: the console's status bar is at its top, and
/// the project page scrolls inside its own column.
enum WindowLog {
    static func log(_ line: String) {
        let args = ProcessInfo.processInfo.arguments
        guard let i = args.firstIndex(of: "-probe.windowLog"), args.count > i + 1,
              let data = "\(line)\n".data(using: .utf8) else { return }
        let path = args[i + 1]
        if let handle = FileHandle(forWritingAtPath: path) {
            handle.seekToEndOfFile()
            handle.write(data)
            try? handle.close()
        } else {
            try? data.write(to: URL(fileURLWithPath: path))
        }
    }
}

/// `-probe.shot <path>`: wait for the window to finish drawing what the stub drove, then write the
/// window's own content as a PNG. Nothing here takes a picture of the screen — the window server
/// hands back this app's own window, which needs no permission on any host.
enum WindowShot {
    static func takeIfAsked() async {
        let args = ProcessInfo.processInfo.arguments
        guard let i = args.firstIndex(of: "-probe.shot"), args.count > i + 1 else { return }
        let path = args[i + 1]
        // Repeated, not once: a launch's first seconds hold a window that has not drawn its page yet
        // — that first write is kept because a pass that ends early still leaves a picture — and a
        // window newly resized hands back a stale image for a moment besides. The file is read after
        // the pass (the app is terminated with the launch), so the LAST write is the settled state.
        await write(path)
        for _ in 0..<90 {
            try? await Task.sleep(for: .seconds(5))
            await write(path)
        }
    }

    /// The window server's own image of THIS app's window. `cacheDisplay` was tried first by the
    /// source-refused probe and came back as bare backgrounds: SwiftUI draws into layers, and a
    /// layer-backed view has nothing for the drawing path to replay. Reading the app's own window is
    /// allowed without Screen Recording permission — it is the screen that is not.
    @MainActor
    private static func write(_ path: String) {
        guard let window = NSApp.windows.first(where: { $0.isVisible }),
              let image = CGWindowListCreateImage(.null, .optionIncludingWindow,
                                                  CGWindowID(window.windowNumber),
                                                  [.boundsIgnoreFraming, .bestResolution]) else {
            WindowLog.log("shot: no image for \(NSApp.windows.count) windows")
            FileHandle.standardError.write(Data("probe: no image for \(NSApp.windows.count) windows\n".utf8))
            return
        }
        let rep = NSBitmapImageRep(cgImage: image)
        rep.size = window.frame.size
        do {
            let data = rep.representation(using: .png, properties: [:])
            try data?.write(to: URL(fileURLWithPath: path))
            // The window's own size and the shot's, side by side: a picture smaller than the window
            // is a picture of something else (a resize the window server has not caught up with),
            // and this is where that shows.
            WindowLog.log("shot: \(path) \(data?.count ?? 0) bytes, image \(image.width)x\(image.height), window \(window.frame)")
        } catch {
            WindowLog.log("shot: could not write \(path): \(error)")
            FileHandle.standardError.write(Data("probe: could not write \(path): \(error)\n".utf8))
        }
    }
}

/// MenuBarContent opens the runner window by this id (OrbitApp.swift, which the probe replaces).
enum OrbitApp {
    static let runnerWindowID = "runner-manager"
}
