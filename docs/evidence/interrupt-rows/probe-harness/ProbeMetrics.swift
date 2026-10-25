import SwiftUI
#if os(iOS)
import UIKit
#else
import AppKit
#endif

// TEMPORARY evidence probe (see README.md): where every wide scroll view in the app stands — its
// frame in the window, offset, content height and insets — posted to the stub's /__metrics whenever
// it changes, so the pictures can be read against the numbers (the tests post /__mark before each).
@MainActor
enum ProbeMetrics {
    private static var last = ""
    private static var timer: Timer?

    static func start() {
        guard timer == nil else { return }
        timer = Timer.scheduledTimer(withTimeInterval: 0.4, repeats: true) { _ in
            MainActor.assumeIsolated { report() }
        }
    }

    private static func f(_ v: CGFloat) -> String { String(format: "%.1f", Double(v)) }

    private static func report() {
        var rows: [String] = []
        #if os(iOS)
        for scene in UIApplication.shared.connectedScenes {
            guard let windows = (scene as? UIWindowScene)?.windows else { continue }
            for window in windows where !window.isHidden {
                walk(window) { view in
                    guard let s = view as? UIScrollView, !s.isHidden, s.window != nil, s.bounds.width > 200 else { return }
                    let r = s.convert(s.bounds, to: nil)
                    rows.append("\(type(of: s)) y=\(f(r.minY))..\(f(r.maxY)) off=\(f(s.contentOffset.y)) "
                        + "content=\(f(s.contentSize.height)) inset=\(f(s.adjustedContentInset.top))/\(f(s.adjustedContentInset.bottom)) "
                        + "max=\(f(s.contentSize.height + s.adjustedContentInset.bottom - s.bounds.height))")
                }
            }
        }
        #else
        for window in NSApp.windows where window.isVisible {
            guard let root = window.contentView else { continue }
            walk(root) { view in
                guard let s = view as? NSScrollView, !s.isHidden, s.frame.width > 200, let doc = s.documentView else { return }
                let r = s.convert(s.bounds, to: nil)
                let clip = s.contentView.bounds
                rows.append("\(type(of: doc)) x=\(f(r.minX))..\(f(r.maxX)) h=\(f(r.height)) off=\(f(clip.minY)) "
                    + "doc=\(f(doc.frame.height)) visible=\(f(clip.height)) insets=\(f(s.contentInsets.top))/\(f(s.contentInsets.bottom)) "
                    + "flipped=\(doc.isFlipped)")
            }
        }
        #endif
        let line = rows.joined(separator: " | ")
        guard line != last else { return }
        last = line
        post("/__metrics", line)
    }

    #if os(iOS)
    private static func walk(_ view: UIView, _ visit: (UIView) -> Void) {
        visit(view)
        for sub in view.subviews { walk(sub, visit) }
    }
    #else
    private static func walk(_ view: NSView, _ visit: (NSView) -> Void) {
        visit(view)
        for sub in view.subviews { walk(sub, visit) }
    }
    #endif

    static func post(_ path: String, _ text: String) {
        var request = URLRequest(url: URL(string: "http://127.0.0.1:8765" + path)!)
        request.httpMethod = "POST"
        request.httpBody = text.data(using: .utf8)
        URLSession.shared.dataTask(with: request).resume()
    }
}
