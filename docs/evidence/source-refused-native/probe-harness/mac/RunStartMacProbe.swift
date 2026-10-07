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
                FileHandle.standardError.write(Data("probe: no image for \(NSApp.windows.count) windows\n".utf8))
                return
            }
            let rep = NSBitmapImageRep(cgImage: image)
            rep.size = window.frame.size
            do { try rep.representation(using: .png, properties: [:])?.write(to: URL(fileURLWithPath: path)) }
            catch { FileHandle.standardError.write(Data("probe: could not write \(path): \(error)\n".utf8)) }
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
