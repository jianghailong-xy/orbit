import SwiftUI
import WebKit
import OrbitKit

// A section's diagram (contract `docs.diagram`), drawn as the web's `WikiDiagram.tsx` draws it: the Mermaid flowchart
// the server wrote out again, rendered with the web's options by the Mermaid build `src/web/package.json` pins, which
// the app carries (`Resources/mermaid.min.js`) — strict, in the page's light or dark theme, at its own size: a wide one
// scrolls sideways rather than shrinking its words. Its source shows as code when it does not draw.
//
// The web view is a picture and nothing more. It takes no touch or click (the page's scroll views move it); its page
// may load nothing (its Content-Security-Policy); every navigation after its own page is refused; and the page has no
// handler of the app's to call — the drawing is asked for with `callAsyncJavaScript`, which answers with its size.

/// A section's diagram block.
struct WikiDiagram: View {
    let source: String

    @Environment(\.colorScheme) private var colorScheme
    /// The drawn diagram's size; nil while it draws.
    @State private var size: CGSize?
    @State private var failed = false

    var body: some View {
        if failed || WikiDiagramPage.mermaid == nil {
            WikiDocCode(text: source)
        } else {
            ScrollView(.horizontal) {
                WikiDiagramWeb(source: source, dark: colorScheme == .dark) { drawn in
                    if let drawn { size = drawn } else { failed = true }
                }
                // While it draws, the column's width and the web's 120 px; then the diagram's own size.
                .frame(width: size?.width, height: size?.height ?? 120)
                .padding(12)
                // At least the column's width, so a diagram narrower than the column stands in its middle.
                .containerRelativeFrame(.horizontal) { column, _ in max(column, (size?.width ?? 0) + 24) }
            }
            .scrollBounceBehavior(.basedOnSize, axes: .horizontal)
            .background(Color.primary.opacity(0.05), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(WikiDocCopy.diagram)
            .accessibilityAddTraits(.isImage)
        }
    }
}

/// The page a diagram is drawn in, and what draws it.
@MainActor
enum WikiDiagramPage {
    /// The Mermaid build, run in each diagram's page before it is drawn; nil when the app was built without it. In
    /// the iOS app and in the Mac app (`build-dmg.sh` copies it) it is the main bundle's; under `swift run`, in the
    /// package's resource bundle beside the executable.
    static let mermaid: WKUserScript? = {
        let file = Bundle.main.url(forResource: "mermaid.min", withExtension: "js")
            ?? Bundle(url: Bundle.main.bundleURL.appendingPathComponent("OrbitApp_OrbitApp.bundle"))?
                .url(forResource: "mermaid.min", withExtension: "js")
        guard let file, let source = try? String(contentsOf: file, encoding: .utf8) else { return nil }
        // A user script runs as the page's own code: the build's top-level `var` is the global `mermaid` reads.
        return WKUserScript(source: source, injectionTime: .atDocumentEnd, forMainFrameOnly: true)
    }()

    /// The page: a transparent body that may load nothing, with the drawn diagram in its figure.
    static let html = """
        <!doctype html>
        <html><head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1, shrink-to-fit=no">
        <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
        <style>
        html, body { margin: 0; background: transparent; }
        body { font-family: -apple-system, system-ui, sans-serif; -webkit-text-size-adjust: 100%; -webkit-user-select: none; cursor: default; }
        svg { display: block; }
        </style>
        </head><body><div id="figure"></div></body></html>
        """

    /// The web's call, with `source` and `dark` as its arguments: the drawn SVG goes into the figure, and its size comes
    /// back. Mermaid's own working elements go on the body beside the figure, so a drawing still under way is untouched.
    static let draw = """
        mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: dark ? 'dark' : 'neutral',
                             fontFamily: getComputedStyle(document.body).fontFamily, flowchart: { useMaxWidth: false } });
        const { svg } = await mermaid.render('wk-diagram', source);
        const figure = document.getElementById('figure');
        figure.innerHTML = svg;
        const box = figure.firstElementChild.getBoundingClientRect();
        return [Math.ceil(box.width), Math.ceil(box.height)];
        """

    /// A diagram's web view: a page of its own, its data kept nowhere, and the Mermaid build in it.
    static func configuration() -> WKWebViewConfiguration {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        if let mermaid { configuration.userContentController.addUserScript(mermaid) }
        return configuration
    }
}

/// What a diagram's web view does: load its own page and nothing after it, draw the diagram once the page is there,
/// and draw it again when the theme changes or the page's process was taken back.
@MainActor
private final class WikiDiagramDrawer: NSObject, WKNavigationDelegate {
    private struct Drawing: Equatable {
        let source: String
        let dark: Bool
    }

    private var wanted = Drawing(source: "", dark: false)
    private var drawn: (CGSize?) -> Void = { _ in }
    /// Its own page went through: every navigation after it is refused.
    private var pageLetThrough = false
    private var loaded = false
    /// The drawing last asked of the page; an answer counts only while its drawing is still the last one.
    private var asked: Drawing?

    func start(_ view: WKWebView) {
        view.navigationDelegate = self
        load(view)
    }

    func update(_ view: WKWebView, source: String, dark: Bool, drawn: @escaping (CGSize?) -> Void) {
        wanted = Drawing(source: source, dark: dark)
        self.drawn = drawn
        draw(view)
    }

    private func load(_ view: WKWebView) {
        pageLetThrough = false
        loaded = false
        asked = nil
        view.loadHTMLString(WikiDiagramPage.html, baseURL: nil)
    }

    private func draw(_ view: WKWebView) {
        guard loaded, asked != wanted else { return }
        let drawing = wanted
        asked = drawing
        view.callAsyncJavaScript(WikiDiagramPage.draw, arguments: ["source": drawing.source, "dark": drawing.dark],
                                 in: nil, in: .page) { [weak self] result in
            guard let self, self.asked == drawing else { return }
            guard case .success(let value) = result, let size = value as? [NSNumber], size.count == 2 else {
                return self.drawn(nil)
            }
            self.drawn(CGSize(width: size[0].doubleValue, height: size[1].doubleValue))
        }
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        decisionHandler(pageLetThrough ? .cancel : .allow)
        pageLetThrough = true
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        loaded = true
        draw(webView)
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        if !loaded { drawn(nil) }
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        if !loaded { drawn(nil) }
    }

    /// The system took the page's process back (memory, the app in the background): load the page and draw again.
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        load(webView)
    }
}

#if os(iOS)
private struct WikiDiagramWeb: UIViewRepresentable {
    let source: String
    let dark: Bool
    let drawn: (CGSize?) -> Void

    func makeCoordinator() -> WikiDiagramDrawer { WikiDiagramDrawer() }

    func makeUIView(context: Context) -> WKWebView {
        let view = WKWebView(frame: .zero, configuration: WikiDiagramPage.configuration())
        // A picture: the page's scroll views take the touches.
        view.isUserInteractionEnabled = false
        view.isOpaque = false
        view.backgroundColor = .clear
        view.scrollView.backgroundColor = .clear
        view.scrollView.isScrollEnabled = false
        view.scrollView.contentInsetAdjustmentBehavior = .never
        context.coordinator.start(view)
        return view
    }

    func updateUIView(_ view: WKWebView, context: Context) {
        context.coordinator.update(view, source: source, dark: dark, drawn: drawn)
    }
}
#elseif os(macOS)
private struct WikiDiagramWeb: NSViewRepresentable {
    let source: String
    let dark: Bool
    let drawn: (CGSize?) -> Void

    func makeCoordinator() -> WikiDiagramDrawer { WikiDiagramDrawer() }

    func makeNSView(context: Context) -> WKWebView {
        let view = WikiDiagramPicture(frame: .zero, configuration: WikiDiagramPage.configuration())
        // Transparent, over the figure's own fill (WKWebView's `_setDrawsBackground:`, which KVC reaches).
        view.setValue(false, forKey: "drawsBackground")
        context.coordinator.start(view)
        return view
    }

    func updateNSView(_ view: WKWebView, context: Context) {
        context.coordinator.update(view, source: source, dark: dark, drawn: drawn)
    }
}

/// A web view that is a picture: clicks and scrolls go to the page around it.
private final class WikiDiagramPicture: WKWebView {
    override func hitTest(_ point: NSPoint) -> NSView? { nil }
}
#endif
