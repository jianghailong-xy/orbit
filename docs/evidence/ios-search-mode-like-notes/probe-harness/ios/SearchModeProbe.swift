import SwiftUI
import OrbitKit

// TEMPORARY evidence probe (see ../README.md): the iPhone app's own CompactShell, pointed at stub.py
// with `-orbit.instance`, opened on the page `-probe.page` names — a conversation (the capsule
// pointing elsewhere), the project's coordinator conversation (the capsule pointing into it), or the
// session list. `-dark` draws it dark, as the account's theme would (`OrbitiOSApp`'s
// `.preferredColorScheme`).
@main
struct SearchModeProbeApp: App {
    @State private var model: AppModel

    init() {
        ProbeArgs.wipeIfFresh()
        _model = State(initialValue: AppModel())
    }

    var body: some Scene {
        WindowGroup {
            CompactShell()
                .environment(model)
                // As RootView has it: the app's tap-to-lower-the-keyboard, one of the ways iOS ends
                // an empty search by itself.
                .dismissesKeyboardOnBackgroundTap()
                .background(TapLogger())
                .preferredColorScheme(ProcessInfo.processInfo.arguments.contains("-dark") ? .dark : .light)
                .task { await ProbeArgs.land(model) }
        }
    }
}

/// Probe only: every tap's view chain, posted to the stub, so the run shows what the X beside the
/// bottom search field is made of (and whether `SearchCloseTap` would call it search chrome).
struct TapLogger: UIViewRepresentable {
    func makeCoordinator() -> Coordinator { Coordinator() }
    func makeUIView(context: Context) -> Hook { Hook(coordinator: context.coordinator) }
    func updateUIView(_ uiView: Hook, context: Context) {}

    final class Hook: UIView {
        let coordinator: Coordinator
        init(coordinator: Coordinator) { self.coordinator = coordinator; super.init(frame: .zero); isUserInteractionEnabled = false }
        required init?(coder: NSCoder) { fatalError() }
        override func didMoveToWindow() {
            super.didMoveToWindow()
            guard let window, !(window.gestureRecognizers ?? []).contains(where: { $0.name == "probe.tapLogger" }) else { return }
            let tap = UITapGestureRecognizer(target: coordinator, action: #selector(Coordinator.tapped(_:)))
            tap.name = "probe.tapLogger"
            tap.cancelsTouchesInView = false
            tap.delegate = coordinator
            window.addGestureRecognizer(tap)
        }
    }

    final class Coordinator: NSObject, UIGestureRecognizerDelegate {
        func gestureRecognizer(_ g: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool { true }
        func gestureRecognizer(_ g: UIGestureRecognizer, shouldReceive touch: UITouch) -> Bool {
            var chain: [String] = []
            var view = touch.view
            while let v = view { chain.append(String(describing: type(of: v))); view = v.superview }
            let at = touch.location(in: nil)
            post("TAP (\(Int(at.x)),\(Int(at.y))) " + chain.joined(separator: " < "))
            return true
        }
        @objc func tapped(_ g: UITapGestureRecognizer) {}
    }
}

func post(_ line: String) {
    var r = URLRequest(url: URL(string: "http://127.0.0.1:8765/__note")!)
    r.httpMethod = "POST"
    r.httpBody = line.data(using: .utf8)
    URLSession.shared.dataTask(with: r).resume()
}
