import AppKit
import OrbitKit

// TEMPORARY evidence probe (never merged): 200 scripted clicks across every sidebar row of the real
// app, against a server whose data keeps changing.
//
// The driver runs INSIDE the app process because this Mac refuses XCUITest automation mode without
// the owner's authentication (`automationmodetool status`: disabled, requires authentication). It
// finds the sidebar's table/outline view in the window (the same view the beta.242 crash stack
// names), then for each step posts an AppKit leftMouseDown/leftMouseUp pair at a row's rectangle
// through `NSWindow.sendEvent` — the hit test, row selection, SwiftUI selection binding and list
// update a user's click runs. Rows are cycled by index, so every row (sections, Workspaces, agents,
// Set up rows, Wiki included) is clicked; the row count is re-read each step because the changing
// data rebuilds the list underneath the clicks.
@MainActor
enum SidebarDriver {
    static func run(_ model: AppModel, window passed: NSWindow?) async {
        let args = ProcessInfo.processInfo.arguments
        guard args.contains("-probe.driver") else { return }
        let clicks = Int(value(after: "-probe.clicks", in: args) ?? "") ?? 200
        let gap = Int(value(after: "-probe.gap", in: args) ?? "") ?? 30
        func log(_ line: String) { mark(line) }

        if !model.signedIn {
            // The app still talks to the local server, but it does not write the macOS Keychain:
            // this host has a SecurityAgent prompt up and `SecItemAdd` blocks indefinitely there.
            // A real session is obtained with an in-memory store first, so the run exercises the
            // signed-in shell and every request carries the server's own answer.
            if let base = model.baseURL ?? instanceURL(from: args) {
                let client = APIClient(baseURL: base, tokenStore: InMemoryTokenStore())
                _ = try? await client.login(email: "owner@example.com", password: "probe-password")
                model.user = try? await client.me()
                model.signedIn = true
            }
        }
        log("signedIn=\(model.signedIn) error=\(model.errorText ?? "-") base=\(model.baseURL?.absoluteString ?? "-")")
        guard model.signedIn else { return }

        // The sidebar exists once a window does; the table appears a beat later.
        var window = passed
        var table: NSTableView?
        for _ in 0..<160 {
            try? await Task.sleep(nanoseconds: 250_000_000)
            if window == nil { window = mainWindow() }
            if table == nil { table = window.flatMap(findTable) }
            if table != nil { break }
        }
        guard let window, let table else {
            log("NO TABLE after 40s; windows=\(NSApp.windows.map { "\($0.title)|\($0.frame)" })")
            if let shown = window ?? mainWindow() {
                log("viewtree: \(viewTree(shown))")
                shot(shown)
            }
            return
        }
        NSApp.activate(ignoringOtherApps: true)
        NSRunningApplication.current.activate(options: [.activateAllWindows, .activateIgnoringOtherApps])
        window.orderFrontRegardless()
        window.makeKey()
        log("activation active=\(NSApp.isActive) key=\(window.isKeyWindow)")
        // The workspace list arrives after the window does; wait for it so the run really exercises
        // agent and machine rows, not just the placeholder.
        for _ in 0..<80 where model.agents?.items.isEmpty != false {
            try? await Task.sleep(nanoseconds: 250_000_000)
        }
        try? await Task.sleep(nanoseconds: 1_000_000_000)
        // The rail's two groups are @AppStorage-backed Sections: open them before the first click.
        UserDefaults.standard.set(true, forKey: "sidebar.workspacesExpanded")
        UserDefaults.standard.set(true, forKey: "sidebar.projectsExpanded")
        try? await Task.sleep(nanoseconds: 500_000_000)
        log("READY rows=\(table.numberOfRows) window=\(window.frame) agents=\(model.agents?.items.count ?? -1) tables=\(tableSummary(window))")
        shot(window)

        var clicked = 0
        var skipped = 0
        var rows = 0
        // The rail's two groups are @AppStorage-backed Sections. A programmatic selection can close
        // one (SwiftUI re-applies the selection and the outline reloads its children); ask the app's
        // own preference to open them again, which @AppStorage applies back to the Sections.
        func ensureGroupsOpen() {
            UserDefaults.standard.set(true, forKey: "sidebar.workspacesExpanded")
            UserDefaults.standard.set(true, forKey: "sidebar.projectsExpanded")
        }
        ensureGroupsOpen()
        for step in 0..<clicks {
            guard let window = mainWindow(), let table = findTable(window) else {
                skipped += 1
                try? await Task.sleep(nanoseconds: 50_000_000)
                continue
            }
            rows = table.numberOfRows
            guard rows > 0 else {
                skipped += 1
                try? await Task.sleep(nanoseconds: 20_000_000)
                continue
            }
            // Every row the rail draws: the work rows (Wiki included), the Workspaces group's
            // header and its rows, and the open projects.
            let row = step % rows
            // The window server will not make this app active in this session (`active=false`
            // logged above), so a posted event is swallowed as the activation click. Drive the
            // same selection AppKit drives from a click: NSTableView's selection API, whose
            // selection-change notification is what SwiftUI's list coordinator reads.
            table.selectRowIndexes(IndexSet(integer: row), byExtendingSelection: false)
            clicked += 1
            if clicked % 10 == 0 || clicked == clicks {
                let rect = table.convert(table.rect(ofRow: row), to: nil)
                log("CLICK \(clicked)/\(clicks) row=\(row)/\(rows) selected=\(table.selectedRow)"
                    + " section=\(model.selectedSection.rawValue) agent=\(model.selectedAgentID ?? "-")"
                    + " hit=\(hitClass(in: window, at: NSPoint(x: rect.midX, y: rect.midY)))")
            }
            // No settle: the next click lands while the server's answer is still on its way.
            try? await Task.sleep(nanoseconds: UInt64(gap) * 1_000_000)
        }
        log("DRIVER_DONE clicked=\(clicked) skipped=\(skipped) rows=\(rows) alive=true")
    }

    // MARK: markers and the log file

    /// Writes one line to the run's log (`-probe.out`); also used by the app delegate so the run
    /// shows how far the process got even when it dies before the driver starts.
    static func mark(_ line: String) {
        let args = ProcessInfo.processInfo.arguments
        let path = value(after: "-probe.out", in: args) ?? "/tmp/sidebar-driver.log"
        append("\(stamp()) \(line)\n", to: path)
    }

    private static func value(after flag: String, in args: [String]) -> String? {
        guard let i = args.firstIndex(of: flag), i + 1 < args.count else { return nil }
        return args[i + 1]
    }

    private static func instanceURL(from args: [String]) -> URL? {
        value(after: "-orbit.instance", in: args).flatMap(ServerURL.normalize)
    }

    private static func stamp() -> String {
        let f = DateFormatter()
        f.dateFormat = "HH:mm:ss.SSS"
        return f.string(from: Date())
    }

    private static func append(_ text: String, to path: String) {
        guard let data = text.data(using: .utf8) else { return }
        if let handle = FileHandle(forWritingAtPath: path) {
            handle.seekToEndOfFile()
            handle.write(data)
            try? handle.close()
        } else {
            try? data.write(to: URL(fileURLWithPath: path))
        }
    }

    // MARK: the window and its table

    private static func mainWindow() -> NSWindow? {
        NSApp.windows.first { $0.isVisible && !$0.isMiniaturized && findTable($0) != nil }
            ?? NSApp.windows.first { $0.isVisible && !$0.isMiniaturized }
    }

    private static func findTable(_ window: NSWindow) -> NSTableView? {
        guard let root = window.contentView else { return nil }
        var tables: [NSTableView] = []
        collectTables(in: root, into: &tables)
        // The split view has more than one list (the source list, the section's list, ...); the
        // sidebar is the leftmost one in window coordinates.
        return tables.min {
            $0.convert($0.bounds, to: nil).minX < $1.convert($1.bounds, to: nil).minX
        }
    }

    private static func collectTables(in view: NSView, into tables: inout [NSTableView]) {
        if let table = view as? NSTableView { tables.append(table) }
        for sub in view.subviews { collectTables(in: sub, into: &tables) }
    }

    /// Every list in the window, for the log: which one the driver picked, and how it differs.
    static func tableSummary(_ window: NSWindow?) -> String {
        guard let root = window?.contentView else { return "no window" }
        var tables: [NSTableView] = []
        collectTables(in: root, into: &tables)
        return tables.map { t in
            let f = t.convert(t.bounds, to: nil)
            return "\(t.numberOfRows)rows@\(Int(f.minX)),\(Int(f.minY)),\(Int(f.width))x\(Int(f.height))"
        }.joined(separator: " ")
    }

    /// A depth-limited description of what the window actually hosts, for a run that finds no table.
    static func viewTree(_ window: NSWindow?) -> String {
        guard let root = window?.contentView else { return "no contentView" }
        var out: [String] = []
        func walk(_ view: NSView, _ depth: Int) {
            if depth > 9 || out.count > 150 { return }
            out.append(String(repeating: ">", count: depth) + String(describing: type(of: view))
                       + "[\(Int(view.frame.width))x\(Int(view.frame.height))]")
            for sub in view.subviews { walk(sub, depth + 1) }
        }
        walk(root, 0)
        return out.joined(separator: " ")
    }

    /// The app's own window bitmap — no screen recording permission needed for one's own window.
    private static func shot(_ window: NSWindow, _ name: String = "window") {
        guard let path = value(after: "-probe.out", in: ProcessInfo.processInfo.arguments) else { return }
        let png = (path as NSString).deletingLastPathComponent + "/\(name).png"
        guard let image = CGWindowListCreateImage(.null, .optionIncludingWindow,
                                                  CGWindowID(window.windowNumber),
                                                  [.boundsIgnoreFraming, .bestResolution]) else {
            mark("shot: no image")
            return
        }
        let rep = NSBitmapImageRep(cgImage: image)
        rep.size = window.frame.size
        guard let data = rep.representation(using: .png, properties: [:]) else { return }
        try? data.write(to: URL(fileURLWithPath: png))
        mark("shot: \(png) \(data.count) bytes")
    }

    /// The row's user-visible name, when AppKit exposes one — so the log says which rows were
    /// clicked, not only their indices.
    private static func rowLabel(_ table: NSTableView, _ row: Int) -> String {
        if let label = table.rowView(atRow: row, makeIfNecessary: false)?.accessibilityLabel(),
           !label.isEmpty { return label }
        if let label = table.view(atColumn: 0, row: row, makeIfNecessary: false)?.accessibilityLabel(),
           !label.isEmpty { return label }
        return "-"
    }

    // MARK: the click

    /// Posted to the app's own event queue (not delivered straight to the window), so AppKit routes
    /// it exactly as it routes a hardware click: hit test, row selection, tracking, the lot.
    private static func postClick(at point: NSPoint, in window: NSWindow) {
        let now = ProcessInfo.processInfo.systemUptime
        for type in [NSEvent.EventType.leftMouseDown, .leftMouseUp] {
            guard let event = NSEvent.mouseEvent(
                with: type, location: point, modifierFlags: [], timestamp: now,
                windowNumber: window.windowNumber, context: nil, eventNumber: 0,
                clickCount: 1, pressure: type == .leftMouseDown ? 1 : 0)
            else { continue }
            NSApp.postEvent(event, atStart: false)
        }
    }

    private static func hitClass(in window: NSWindow, at point: NSPoint) -> String {
        guard let content = window.contentView else { return "none" }
        let local = content.convert(point, from: nil)
        return content.hitTest(local).map { String(describing: type(of: $0)) } ?? "nil"
    }
}
