import AppKit
import SwiftUI
import OrbitKit

// TEMPORARY evidence probe for P1-03 (see ../../README.md). argv: <variant> <outDir>, the variant one of
// `connected` (a Claude session whose engine started Orbit's server), `failed` (a Codex session whose engine could
// not, in Plan, orchestration and the wiki off) or `workspace` (a workspace's sheet). The view is the app's own
// AgentToolsSheet.swift, copied in from the commit under test by run.sh; only these fixtures are the probe's.

enum Probe {
    static let variant = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "connected"
    static let outDir = URL(fileURLWithPath: CommandLine.arguments.count > 2 ? CommandLine.arguments[2] : "shots")

    static func log(_ line: String) {
        print("probe[\(variant)]: \(line)")
        fflush(stdout)
    }
}

/// Every family with how many of its tools the session has: all of them, or none and why.
func families(served: Bool, reason: (String) -> String?) -> String {
    let totals: [(String, Int)] = [("tasks", 21), ("projects", 19), ("task-lists", 6), ("waits", 6), ("files", 4),
                                   ("background", 5), ("owner", 6), ("wiki", 5), ("providers", 4),
                                   ("merge-receipts", 3), ("guide", 1), ("orchestration", 22)]
    return "[" + totals.map { id, total in
        let why = reason(id).map { ",\"reason\":\"\($0)\"" } ?? ""
        return "{\"id\":\"\(id)\",\"served\":\(served ? total : 0),\"total\":\(total)\(why)}"
    }.joined(separator: ",") + "]"
}

func report(_ json: String) -> AgentToolsReport {
    do {
        return try JSONDecoder().decode(AgentToolsReport.self, from: Data(json.utf8))
    } catch {
        Probe.log("fixture does not decode: \(error)")
        exit(4)
    }
}

let versions = #"{"contract":"1.8.0","catalog":"1.7.0","primer":"1.2.0","guide":"1.1.0","playbooks":"1.0.0"}"#
let connected = report("""
{"v":1,"at":"2026-11-14T13:00:00Z","engine":"claude","engineVersion":"2.1.325","runnerVersion":"0.1.261",
 "versions":\(versions),"mcp":{"status":"connected","tools":102},
 "families":\(families(served: true, reason: { _ in nil })),
 "switches":{"orchestration":true,"watches":true,"wiki":true},"permissionMode":"default",
 "instructions":{"carrier":"append_system_prompt","workspace":true,"workspaceChars":412},
 "skill":{"name":"orbit:playbooks","offered":true,"loaded":true}}
""")
let failed = report("""
{"v":1,"at":"2026-11-14T13:02:00Z","engine":"codex","engineVersion":"0.167.2","runnerVersion":"0.1.261",
 "versions":\(versions),
 "mcp":{"status":"failed","tools":0,"detail":"MCP client for `orbit` failed to start: handshaking with MCP server failed: connection closed: initialize response"},
 "families":\(families(served: false, reason: { $0 == "orchestration" ? "orchestration" : $0 == "wiki" ? "wiki" : "not_connected" })),
 "switches":{"orchestration":false,"watches":true,"wiki":false},"permissionMode":"plan",
 "instructions":{"carrier":"additional_context","workspace":true,"workspaceChars":412},
 "skill":{"name":"orbit-playbooks","offered":true}}
""")
let now = ISO8601DateFormatter().date(from: "2026-11-14T13:03:00Z") ?? Date()

@MainActor
func sheet() -> AgentToolsSheet {
    switch Probe.variant {
    case "failed":
        return AgentToolsSheet(mode: .session(report: failed, engine: "codex", permissionMode: "plan",
                                              orchestrationOn: false, now: now), onDone: {})
    case "workspace":
        return AgentToolsSheet(mode: .workspace(name: "orbit-op", instructions: String(repeating: "x", count: 412),
                                                baseInstructions: false, orchestrationOn: true),
                               onDone: {}, onEditInstructions: {})
    default:
        return AgentToolsSheet(mode: .session(report: connected, engine: "claude", permissionMode: "default",
                                              orchestrationOn: true, now: now), onDone: {})
    }
}

/// The window the app's sheet would be: built by hand, because an unbundled executable's SwiftUI scene opens none
/// on a runner. It is as tall as the screen allows, so the sheet's Form shows as much of itself as it can.
final class ProbeDelegate: NSObject, NSApplicationDelegate {
    private var window: NSWindow?

    func applicationDidFinishLaunching(_ notification: Notification) {
        let host = NSHostingController(rootView: sheet())
        host.sceneBridgingOptions = [.toolbars]
        let window = NSWindow(contentViewController: host)
        window.title = Probe.variant == "workspace" ? "Agent Tools · orbit-op" : "Agent Tools"
        window.styleMask = [.titled, .closable, .resizable, .fullSizeContentView]
        window.toolbarStyle = .unified
        let visible = NSScreen.main?.visibleFrame.height ?? 900
        window.setContentSize(NSSize(width: 600, height: min(1300, visible - 40)))
        window.center()
        window.makeKeyAndOrderFront(nil)
        self.window = window
        NSApp.activate(ignoringOtherApps: true)
        Probe.log("screen visible height \(visible)")

        Task { @MainActor in
            try? await Task.sleep(nanoseconds: 6_000_000_000)
            Capture.all()
        }
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
        guard let main = NSApp.windows.first(where: { $0.isVisible && !$0.isSheet }) else {
            Probe.log("no window")
            exit(2)
        }
        save(main, as: "macos-\(Probe.variant)")
        NSApp.terminate(nil)
    }

    /// The window two ways: AppKit drawing its frame view into a bitmap, and the window server's own copy.
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

    private typealias CreateImage = @convention(c) (CGRect, UInt32, UInt32, UInt32) -> Unmanaged<CGImage>?

    /// CGWindowListCreateImage, looked up at run time: the SDK no longer declares it, but the system still ships
    /// it, and the caller's own windows need no grant.
    private static func windowImage(_ rect: CGRect, option: UInt32, window: Int, imageOption: UInt32) -> CGImage? {
        guard let symbol = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "CGWindowListCreateImage") else {
            Probe.log("CGWindowListCreateImage is not there")
            return nil
        }
        let create = unsafeBitCast(symbol, to: CreateImage.self)
        let image = create(rect, option, UInt32(window), imageOption)?.takeRetainedValue()
        if image == nil { Probe.log("CGWindowListCreateImage gave nothing for #\(window)") }
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
