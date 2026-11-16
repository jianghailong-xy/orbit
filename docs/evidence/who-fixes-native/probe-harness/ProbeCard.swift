import SwiftUI
import OrbitKit

// TEMPORARY evidence probe (never merged): the real owner exception card, drawn alone.
//
// The app is pointed at stub.py with `-orbit.instance` (AppModel configures itself from it), takes
// the real ConsoleModel for the stub's coordinator session S1 from the app's own registry, starts it
// (which reads the session, adopts project P1 and reads its document and open items), and draws the
// card the console delivers for item I1 — `DeliveredDecisionCardView`, whose `.escalatedItem` arm is
// the real `OwnerItemCardView` — in a ScrollView at the width it is given.
enum ProbeArgs {
    static let sessionID = "S1"
    static let itemID = "I1"

    static var args: [String] { ProcessInfo.processInfo.arguments }

    static func value(_ name: String) -> String? {
        guard let i = args.firstIndex(of: name), args.count > i + 1 else { return nil }
        return args[i + 1]
    }

    /// Each launch starts from what the stub serves, not from lists cached by an earlier launch.
    static func wipeIfFresh() {
        guard args.contains("-probe.fresh"),
              let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
        else { return }
        try? FileManager.default.removeItem(at: support.appendingPathComponent("Orbit"))
    }

    /// `-probe.log <path>`: one line per step, so a blank picture says where it stopped.
    static func log(_ line: String) {
        guard let path = value("-probe.log"), let data = "\(line)\n".data(using: .utf8) else { return }
        if let handle = FileHandle(forWritingAtPath: path) {
            handle.seekToEndOfFile()
            handle.write(data)
            try? handle.close()
        } else {
            try? data.write(to: URL(fileURLWithPath: path))
        }
    }
}

struct ProbeCardPage: View {
    @Environment(AppModel.self) private var model
    /// Nil: the screen's own width (the iPhone). A number: a fixed panel width (the Mac).
    let width: CGFloat?
    @State private var console: ConsoleModel?
    @State private var status = "loading…"

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    if let console {
                        DeliveredDecisionCardView(
                            console: console,
                            card: DeliveredDecisionCard(kind: .escalatedItem(itemID: ProbeArgs.itemID)))
                    } else {
                        Text(status).font(.footnote).foregroundStyle(.secondary)
                    }
                    Color.clear.frame(height: 1).id("end")
                }
                .padding(12)
                .frame(width: width)
                .frame(maxWidth: width == nil ? .infinity : nil, alignment: .leading)
            }
            .task {
                await load()
                // `-probe.bottom`: the lower half of a card taller than the phone's screen.
                if ProbeArgs.args.contains("-probe.bottom") {
                    try? await Task.sleep(for: .seconds(6))
                    withAnimation(nil) { proxy.scrollTo("end", anchor: .bottom) }
                }
            }
        }
    }

    @MainActor
    private func load() async {
        ProbeArgs.log("load: base=\(String(describing: model.baseURL))")
        for _ in 0..<40 where model.consoleRegistry == nil {
            try? await Task.sleep(for: .milliseconds(250))
        }
        guard let registry = model.consoleRegistry else {
            status = "no console registry (is -orbit.instance set?)"
            ProbeArgs.log(status)
            return
        }
        // Focus starts the console's run loop: the session read, the project's document and its
        // open items (`loadContext` -> `refreshRulerQuestions`).
        registry.focus(ProbeArgs.sessionID, agentID: "W1")
        guard let console = registry.peek(ProbeArgs.sessionID) else {
            status = "no console for S1"
            ProbeArgs.log(status)
            return
        }
        for i in 0..<60 {
            if console.openItems != nil { ProbeArgs.log("open items after \(i)s"); break }
            try? await Task.sleep(for: .seconds(1))
        }
        ProbeArgs.log("project=\(String(describing: console.projectID)) title=\(console.projectTitle) "
                      + "escalation=\(console.projectEscalationSeconds) "
                      + "items=\(console.openItems?.needsYou.count ?? -1)")
        self.console = console
    }
}
