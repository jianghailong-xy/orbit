import SwiftUI
import OrbitKit

// TEMPORARY evidence probe (see ../README.md): the Mac app's own window (`MainView`, which
// OrbitApp.swift's RootView shows once signed in — the probe replaces that file), pointed at
// stub.py with `-orbit.instance`, opened on a session the stub says never started.
//
// The picture is taken BY THE APP (see `WindowShot`): this host's UI-test runner cannot take
// automation mode and `screencapture` cannot either, so the app photographs its own window content
// after `-probe.shot <path>` — the same pixels minus the window chrome.
@main
struct RunStartMacProbeApp: App {
    @State private var model: AppModel
    @StateObject private var updater = UpdaterModel()

    init() {
        if let i = ProcessInfo.processInfo.arguments.firstIndex(of: "-probe.log"),
           ProcessInfo.processInfo.arguments.count > i + 1 {
            try? "init: \(ProcessInfo.processInfo.arguments.joined(separator: " "))\n"
                .write(toFile: ProcessInfo.processInfo.arguments[i + 1], atomically: true, encoding: .utf8)
        }
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
                    let args = ProcessInfo.processInfo.arguments
                    Task { await WindowFit.watchIfAsked() }
                    if args.contains("-probe.project") { await ProbeArgs.landOnProject(model) }
                    else { await ProbeArgs.land(model, session: probeSession) }
                    await WindowShot.takeIfAsked()
                    await CardRender.renderIfAsked(model)
                }
        }
        .defaultSize(width: 1010, height: 740)
        .defaultPosition(.topLeading)
    }

    private var probeSession: String {
        let args = ProcessInfo.processInfo.arguments
        if let i = args.firstIndex(of: "-probe.session"), args.count > i + 1 { return args[i + 1] }
        return "S1"
    }
}

/// `-probe.fitWindow`: keep every visible window inside the screen's visible frame, and log what
/// each one was before. The runner's console page lays itself out for a window taller than the
/// display — on the CI Mac a 1564-point split view whose composer band (the "this run never
/// started" card) starts at y≈900 in a window showing 31…708 — and nothing scrolls that band back
/// into view: it is not in a scroll view, and the transcript above it is the part that flexes.
/// Shrink the window and SwiftUI lays the console out again for the size it now has (run
/// 37617057113's three identical 40250-byte pictures are what the unfitted window photographs as).
enum WindowFit {
    @MainActor
    static func watchIfAsked() async {
        guard ProcessInfo.processInfo.arguments.contains("-probe.fitWindow") else { return }
        var seen: Set<String> = []
        // A window can arrive late (the UI-test pass presses ⌘N when none came up), so watch rather
        // than fit once — and log every frame the windows go through, which is what says whether
        // the console overflows a window that was already the screen's size, or a window that was
        // bigger than the screen to begin with.
        for iteration in 0..<240 {
            try? await Task.sleep(for: .seconds(1))
            for window in NSApp.windows where window.isVisible && !window.isMiniaturized {
                guard let screen = window.screen ?? NSScreen.main ?? NSScreen.screens.first else { continue }
                let visible = screen.visibleFrame
                let frame = window.frame
                let before = "\(window.title)|\(frame)"
                if !seen.contains(before), iteration < 40 {
                    seen.insert(before)
                    log("window (screen \(screen.frame), visible \(visible), backing \(window.backingScaleFactor)): \(frame) content \(window.contentView?.frame ?? .zero)")
                }
                // TALLER than the display, not the visible frame: the console page lays itself out
                // ~1564 points tall (measured on the CI Mac: the split view spans y −386…1178
                // while the window shows 31…708, the card at ~900 with nothing to scroll it — the
                // band is the transcript's sibling, not inside it), and the display's whole visible
                // frame is 677. A window the display can hold therefore cannot contain the card at
                // all; a window taller than the screen can, and `-probe.shot` photographs the
                // window's own bitmap rather than the screen, so what is below the screen's edge is
                // still in the picture. Whether AppKit lets a titled window past the screen is what
                // the log beside these lines answers.
                var fit = visible
                fit.origin.x = visible.minX
                fit.origin.y = visible.minY
                fit.size.height = max(visible.height, 1700)
                guard fit != frame else { continue }
                window.setFrame(fit, display: true)
                log("fitWindow: \(frame) -> \(window.frame) content \(window.contentView?.frame ?? .zero)")
            }
        }
    }

    /// `-probe.windowLog <path>`: what the app did to its own windows, where the UI-test runner's
    /// sandbox cannot read it back — `run.sh` copies the file into the shots.
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
/// window's own content as a PNG. Nothing here takes a picture of the screen — the view draws
/// itself into a bitmap, which needs no permission on any host.
enum WindowShot {
    static func takeIfAsked() async {
        let args = ProcessInfo.processInfo.arguments
        guard let i = args.firstIndex(of: "-probe.shot"), args.count > i + 1 else { return }
        let path = args[i + 1]
        try? await Task.sleep(for: .seconds(10))
        await MainActor.run {
            // The window server's own image of THIS app's window. `cacheDisplay` was tried first
            // and came back as bare backgrounds: SwiftUI draws into layers, and a layer-backed view
            // has nothing for the drawing path to replay. Reading the app's own window is allowed
            // without Screen Recording permission — it is the screen that is not.
            guard let window = NSApp.windows.first(where: { $0.isVisible }),
                  let image = CGWindowListCreateImage(.null, .optionIncludingWindow,
                                                      CGWindowID(window.windowNumber),
                                                      [.boundsIgnoreFraming, .bestResolution]) else {
                WindowFit.log("shot: no image for \(NSApp.windows.count) windows")
                FileHandle.standardError.write(Data("probe: no image for \(NSApp.windows.count) windows\n".utf8))
                return
            }
            let rep = NSBitmapImageRep(cgImage: image)
            rep.size = window.frame.size
            do {
                let data = rep.representation(using: .png, properties: [:])
                try data?.write(to: URL(fileURLWithPath: path))
                // The window's own size and the shot's, side by side: a picture narrower than the
                // window is a picture of something else, and this is where that shows.
                WindowFit.log("shot: \(path) \(data?.count ?? 0) bytes, image \(image.width)x\(image.height), window \(window.frame)")
            } catch {
                WindowFit.log("shot: could not write \(path): \(error)")
                FileHandle.standardError.write(Data("probe: could not write \(path): \(error)\n".utf8))
            }
        }
    }
}

/// `-probe.render <path>`: the app's own read, its own model and its own card view, drawn to a PNG
/// by `ImageRenderer` — no window and no display, which is what this host can offer: the console is
/// headless, so `screencapture` answers "could not create image from display" and the UI-test runner
/// cannot take automation mode. Everything in the picture is still the real app's: the session comes
/// from `APIClient.session`, the card from `SessionRunStart.card(for:)`, the pixels from the same
/// `SessionRunStartCardView` the session page draws.
enum CardRender {
    @MainActor
    static func renderIfAsked(_ model: AppModel) async {
        let args = ProcessInfo.processInfo.arguments
        guard let i = args.firstIndex(of: "-probe.render"), args.count > i + 1 else { return }
        let path = args[i + 1]
        let sessionID: String
        if let j = args.firstIndex(of: "-probe.session"), args.count > j + 1 { sessionID = args[j + 1] }
        else { sessionID = "S1" }
        // The page's own console, as the page drew it — its adopted row, its card, its runner name.
        guard let console = model.consoleRegistry?.peek(sessionID),
              let card = console.runStart else {
            FileHandle.standardError.write(Data("probe: no card on \(sessionID)'s console\n".utf8))
            return
        }
        let view = SessionRunStartCardView(console: console, card: card)
            .frame(width: 420)
            .padding(12)
            .background(Color(nsColor: .windowBackgroundColor))
        let renderer = ImageRenderer(content: view)
        renderer.scale = 2
        guard let image = renderer.cgImage,
              let data = NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:]) else {
            FileHandle.standardError.write(Data("probe: could not render \(sessionID)\n".utf8))
            return
        }
        try? data.write(to: URL(fileURLWithPath: path))
    }
}

/// MenuBarContent opens the runner window by this id (OrbitApp.swift, which the probe replaces).
enum OrbitApp {
    static let runnerWindowID = "runner-manager"
}
