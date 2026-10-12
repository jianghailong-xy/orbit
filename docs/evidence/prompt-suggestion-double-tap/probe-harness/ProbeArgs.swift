import SwiftUI
import UIKit
import OrbitKit

// TEMPORARY evidence probe (never merged): every launch opens session S1's console.
enum ProbeArgs {
    static var dark: Bool { ProcessInfo.processInfo.arguments.contains("-dark") }

    /// A fresh launch starts from what the stub serves, not from what an earlier launch left on disk
    /// (Application Support/Orbit), and with "Double-tap to use" not yet learned on this device.
    static func wipeIfFresh() {
        guard ProcessInfo.processInfo.arguments.contains("-probe.fresh") else { return }
        UserDefaults.standard.removeObject(forKey: "composer.suggestionDoubleTapLearned")
        guard let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
        else { return }
        try? FileManager.default.removeItem(at: support.appendingPathComponent("Orbit"))
    }

    @MainActor
    static func land(_ model: AppModel) async {
        await model.agents?.load()
        await model.runners?.load()
        model.selectedAgentID = "a1"
        model.route(to: .session("S1"))
        reportGestures()
    }

    /// Every 3 s, what gesture recognizers the editable text views carry (class, taps, enabled), posted
    /// to the stub, which logs the body: which of an editing field's own gestures are tap recognizers.
    @MainActor
    static func reportGestures() {
        Task { @MainActor in
            for _ in 0..<40 {
                try? await Task.sleep(for: .seconds(3))
                var lines: [String] = []
                func describe(_ g: UIGestureRecognizer) -> String {
                    let taps = (g as? UITapGestureRecognizer).map { " taps=\($0.numberOfTapsRequired)" } ?? ""
                    return "\(NSStringFromClass(type(of: g)))\(taps) enabled=\(g.isEnabled) tap=\(g is UITapGestureRecognizer) "
                        + "longPress=\(g is UILongPressGestureRecognizer) pan=\(g is UIPanGestureRecognizer) name=\(g.name ?? "-")"
                }
                func walk(_ v: UIView) {
                    if let tv = v as? UITextView, tv.isEditable {
                        lines.append("textView \(tv.frame) first=\(tv.isFirstResponder) chars=\(tv.text.count)")
                        for g in tv.gestureRecognizers ?? [] { lines.append("  " + describe(g)) }
                        for sub in tv.subviews {
                            for g in sub.gestureRecognizers ?? [] { lines.append("  [\(type(of: sub))] " + describe(g)) }
                        }
                    }
                    v.subviews.forEach(walk)
                }
                for scene in UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene }) {
                    scene.windows.forEach(walk)
                }
                var request = URLRequest(url: URL(string: "http://127.0.0.1:8765/__diag")!)
                request.httpMethod = "POST"
                request.httpBody = lines.joined(separator: "\n").data(using: .utf8)
                _ = try? await URLSession.shared.data(for: request)
            }
        }
    }
}
