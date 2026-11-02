import SwiftUI
import WebKit
import OrbitKit

// A section's diagram (contract `docs.diagram`), drawn as the web's `WikiDiagram.tsx` draws it: the Mermaid flowchart
// the server wrote out again, rendered with the web's options by the Mermaid build `src/web/package.json` pins, which
// the app carries (`Resources/mermaid.min.js`) — strict, in the diagram look (docs/mocks/wiki-diagram-look) in the
// page's light or dark theme, at its own size. A left-to-right one wider than the column is drawn top to bottom when
// that is narrower; one still wider scrolls sideways rather than shrinking its words. Its source shows as code when it
// does not draw.
//
// The web view is a picture and nothing more. It takes no touch or click (the page's scroll views move it, and on the
// Mac a wheel turned over it is handed to them); its page may load nothing (its Content-Security-Policy); every
// navigation after its own page is refused; and the page has no handler of the app's to call — the drawing is asked
// for with `callAsyncJavaScript`, which answers with its size.

/// A section's diagram block.
struct WikiDiagram: View {
    let source: String

    @Environment(\.colorScheme) private var colorScheme
    /// The drawn diagram's size; nil while it draws.
    @State private var size: CGSize?
    @State private var failed = false
    /// The width inside the figure, which a left-to-right diagram is turned top to bottom to fit; 0 until it is known.
    @State private var room: CGFloat = 0

    var body: some View {
        if failed || WikiDiagramPage.mermaid == nil {
            WikiDocCode(text: source)
        } else {
            ScrollView(.horizontal) {
                WikiDiagramWeb(source: source, dark: colorScheme == .dark, room: room) { drawn in
                    if let drawn { size = drawn } else { failed = true }
                }
                // While it draws, the column's width and the web's 120 px; then the diagram's own size.
                .frame(width: size?.width, height: size?.height ?? 120)
                .padding(12)
                // At least the column's width, so a diagram narrower than the column stands in its middle.
                .containerRelativeFrame(.horizontal) { column, _ in max(column, (size?.width ?? 0) + 24) }
            }
            .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { room = max(0, ($0 - 24).rounded(.down)) }
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

    /// The web's drawing, with `source`, `dark` and `room` (the width inside the figure, 0 while unknown) as its
    /// arguments: the drawn SVG goes into the figure, finished as the web finishes it, and its size comes back. A theme's
    /// pictures are drawn once and kept, so a new room only picks between them. Mermaid's own working elements go on the
    /// body beside the figure, so a drawing still under way is untouched. The Android app's page runs the same lines
    /// (`WikiDiagramPage.DRAW` in WikiDiagram.kt), between the same two marks.
    static let draw = #"""
        // wiki diagram drawing: from here
        const colors = {
          light: { fill: '#ffffff', border: '#d5d8dd', text: '#1f2329', label: '#646a73', line: '#9aa0a8', group: 'rgba(0, 0, 0, 0.035)', groupBorder: 'rgba(0, 0, 0, 0.06)' },
          dark: { fill: 'rgba(255, 255, 255, 0.07)', border: 'rgba(255, 255, 255, 0.18)', text: '#c9ced5', label: '#a7adb6', line: '#6e737b', group: 'rgba(255, 255, 255, 0.035)', groupBorder: 'rgba(255, 255, 255, 0.06)' },
        };
        const c = dark ? colors.dark : colors.light;
        const fontFamily = getComputedStyle(document.body).fontFamily;
        const options = {
          startOnLoad: false, securityLevel: 'strict', look: 'classic', theme: 'base', fontFamily,
          themeVariables: { darkMode: dark, fontSize: '13px', primaryColor: c.fill, mainBkg: c.fill, primaryBorderColor: c.border, nodeBorder: c.border,
            primaryTextColor: c.text, nodeTextColor: c.text, textColor: c.text, lineColor: c.line, clusterBkg: c.group, clusterBorder: c.groupBorder, titleColor: c.label },
          flowchart: { useMaxWidth: false, curve: 'basis', nodeSpacing: 28, rankSpacing: 34, padding: 10, wrappingWidth: 200, minNodeWidth: 0, diagramPadding: 4 },
          themeCSS: '.node rect { rx: 6px; ry: 6px; } .cluster rect { rx: 8px; ry: 8px; } .cluster-label span { font-size: 12px; font-weight: 600; }'
            + ' .edgeLabel, .edgeLabel p, .labelBkg { background-color: transparent; font-size: 12px; color: ' + c.label + '; } .edgeLabel rect { fill: none; } .flowchart-link { stroke-width: 1.2px; }',
        };
        const translation = (element) => {
          const at = /translate\(\s*([-\d.e]+)[\s,]+([-\d.e]+)\s*\)/u.exec((element && element.getAttribute('transform')) || '');
          return at ? [Number(at[1]), Number(at[2])] : null;
        };
        const childrenOf = (element, name) => Array.from(element.children).filter((child) => child.classList.contains(name));
        const finish = (svg) => {
          for (const cluster of svg.querySelectorAll('g.cluster')) {
            const box = Array.from(cluster.children).find((child) => child.tagName.toLowerCase() === 'rect');
            const title = childrenOf(cluster, 'cluster-label')[0];
            const at = translation(title);
            if (box && title && at) title.setAttribute('transform', 'translate(' + (Number(box.getAttribute('x')) + 10) + ', ' + (at[1] + 4) + ')');
          }
          svg.querySelectorAll('g.root').forEach((root, n) => {
            const holes = [];
            const hole = (x, y, text) => {
              const width = Number(text && text.getAttribute('width'));
              const height = Number(text && text.getAttribute('height'));
              if (width > 0 && height > 0) holes.push([x - 3, y - 1, width + 6, height + 2]);
            };
            for (const labels of childrenOf(root, 'edgeLabels')) {
              for (const label of childrenOf(labels, 'edgeLabel')) {
                const outer = translation(label);
                const inner = translation(label.firstElementChild);
                if (outer && inner) hole(outer[0] + inner[0], outer[1] + inner[1], label.querySelector('foreignObject'));
              }
            }
            for (const clusters of childrenOf(root, 'clusters')) {
              for (const cluster of childrenOf(clusters, 'cluster')) {
                const title = childrenOf(cluster, 'cluster-label')[0];
                const at = translation(title);
                if (title && at) hole(at[0], at[1], title.querySelector('foreignObject'));
              }
            }
            if (holes.length === 0) return;
            const ns = svg.namespaceURI;
            const rect = (x, y, width, height, fill) => {
              const shape = document.createElementNS(ns, 'rect');
              for (const [name, value] of [['x', x], ['y', y], ['width', width], ['height', height], ['fill', fill]]) shape.setAttribute(name, String(value));
              return shape;
            };
            const mask = document.createElementNS(ns, 'mask');
            const id = svg.id + '-links-' + n;
            for (const [name, value] of [['id', id], ['maskUnits', 'userSpaceOnUse'], ['x', '-100000'], ['y', '-100000'], ['width', '200000'], ['height', '200000']]) {
              mask.setAttribute(name, value);
            }
            mask.append(rect(-100000, -100000, 200000, 200000, 'white'), ...holes.map(([x, y, width, height]) => rect(x, y, width, height, 'black')));
            root.prepend(mask);
            for (const links of childrenOf(root, 'edgePaths')) links.setAttribute('mask', 'url(#' + id + ')');
          });
        };
        const turned = /^flowchart LR\n/u.test(source) ? source.replace(/^flowchart LR/u, 'flowchart TB') : null;
        const widthOf = (svg) => Number((/viewBox="[-\d.e]+ [-\d.e]+ ([\d.e]+)/u.exec(svg) || [])[1]) || 0;
        const pictures = window.wikiDiagramPictures || (window.wikiDiagramPictures = {});
        const key = (dark ? 'dark' : 'light') + '\n' + source;
        pictures[key] = pictures[key] || (async () => {
          mermaid.initialize(options);
          const written = (await mermaid.render('wk-diagram', source)).svg;
          const other = turned === null ? null : await mermaid.render('wk-diagram-tb', turned).then((drawn) => drawn.svg, () => null);
          return { written, turned: other };
        })();
        const drawn = await pictures[key];
        const svg = drawn.turned !== null && room > 0 && widthOf(drawn.written) > room && widthOf(drawn.turned) < widthOf(drawn.written) ? drawn.turned : drawn.written;
        const figure = document.getElementById('figure');
        figure.innerHTML = svg;
        finish(figure.firstElementChild);
        const box = figure.firstElementChild.getBoundingClientRect();
        return [Math.ceil(box.width), Math.ceil(box.height)];
        // wiki diagram drawing: to here
        """#

    /// A diagram's web view: a page of its own, its data kept nowhere, and the Mermaid build in it.
    static func configuration() -> WKWebViewConfiguration {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        if let mermaid { configuration.userContentController.addUserScript(mermaid) }
        return configuration
    }
}

/// What a diagram's web view does: load its own page and nothing after it, draw the diagram once the page is there,
/// and draw it again when the theme or the room changes, or the page's process was taken back.
@MainActor
private final class WikiDiagramDrawer: NSObject, WKNavigationDelegate {
    private struct Drawing: Equatable {
        let source: String
        let dark: Bool
        let room: CGFloat
    }

    private var wanted = Drawing(source: "", dark: false, room: 0)
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

    func update(_ view: WKWebView, source: String, dark: Bool, room: CGFloat, drawn: @escaping (CGSize?) -> Void) {
        wanted = Drawing(source: source, dark: dark, room: room)
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
        view.callAsyncJavaScript(WikiDiagramPage.draw, arguments: ["source": drawing.source, "dark": drawing.dark, "room": Double(drawing.room)],
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
    let room: CGFloat
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
        context.coordinator.update(view, source: source, dark: dark, room: room, drawn: drawn)
    }
}
#elseif os(macOS)
private struct WikiDiagramWeb: NSViewRepresentable {
    let source: String
    let dark: Bool
    let room: CGFloat
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
        context.coordinator.update(view, source: source, dark: dark, room: room, drawn: drawn)
    }
}

/// A web view that is a picture. A click, a hover or a menu goes to the page around it. A scroll it takes only to hand
/// on: sideways to the figure's own scroll view, up and down to the nearest scroll view that moves that way — which the
/// figure's sideways one would otherwise keep, leaving the page still under a wheel turned over the diagram.
private final class WikiDiagramPicture: WKWebView {
    /// The scroll under way goes up and down: decided as it begins, so one slanted swipe stays with one scroll view.
    private var upDown = true

    override func hitTest(_ point: NSPoint) -> NSView? {
        NSApp.currentEvent?.type == .scrollWheel && frame.contains(point) ? self : nil
    }

    override func scrollWheel(with event: NSEvent) {
        // A trackpad's gesture as it begins; a mouse wheel's every turn is one of its own.
        if event.phase == .began || (event.phase.isEmpty && event.momentumPhase.isEmpty) {
            upDown = abs(event.scrollingDeltaY) >= abs(event.scrollingDeltaX)
        }
        if upDown, let page = pageScrollView() {
            page.scrollWheel(with: event)
        } else {
            nextResponder?.scrollWheel(with: event)
        }
    }

    /// The nearest scroll view around the figure's own whose content is taller than it: the document page's. The
    /// figure's own is passed over: with scroll bars always shown, its scroller can leave its content a little taller.
    private func pageScrollView() -> NSScrollView? {
        var view = enclosingScrollView?.superview
        while let current = view {
            if let scroll = current as? NSScrollView, let content = scroll.documentView,
               content.frame.height > scroll.contentView.bounds.height {
                return scroll
            }
            view = current.superview
        }
        return nil
    }
}
#endif
