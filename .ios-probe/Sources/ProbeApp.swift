import SwiftUI
import UIKit

/// EVIDENCE ONLY — where the pull-to-refresh spinner lands relative to the session list's search
/// field, on an iOS 26 simulator. Never shipped, never a gate; the delivered branch does not carry
/// this directory (see `.ios-probe/run.sh`).
///
/// The complaint: on the phone, pulling the session list down draws the refresh spinner *on top of*
/// the "Search sessions" field. The field is the system's `.navigationBarDrawer` drawer, declared on
/// the column root (`AgentContentColumn`), and the list beneath it carries `.refreshable` — an
/// arrangement that has existed since August, with one change on 2026-09-21: the display mode went
/// `.always` → `.automatic` (commit 2e031c06d), so the field now hides as you scroll.
///
/// This probe renders that arrangement — a `List` + `.refreshable` + a drawer search field + the
/// same top safe-area inset the real list carries — in each of the spellings that could decide
/// where the spinner goes, and dumps the measured frames so the answer is a number, not an
/// impression. It is a reproduction of the *arrangement*, not a render of the real column: what it
/// answers does not depend on the app's data, and a bare target has no OrbitKit to compile.
///
/// The variant comes from the environment. `run.sh` builds once and relaunches the same binary per
/// variant, screenshots while the refresh is held, and collects the geometry dump.
@main
struct ProbeApp: App {
    var body: some Scene { WindowGroup { ProbeRoot() } }
}

/// The spellings under test.
enum Variant: String, CaseIterable {
    /// Today's real spelling: `.searchable` on the column root, `displayMode: .automatic`.
    case autoParent
    /// The same with the field pinned visible — the arrangement from 2026-08-04 to 2026-09-21.
    case alwaysParent
    /// `.searchable` on the `List` itself rather than on the view above it.
    case autoOnList
    /// `.automatic` plus `.searchPresentationToolbarBehavior(.avoidHidingContent)`.
    case autoAvoid
    /// `.refreshable` moved up to the column root, `.searchable` left on the `List`.
    case autoRefreshOnRoot
    /// `.automatic` with the list's top safe-area inset removed.
    case autoNoInset
    /// Control: the same list with no search field at all — where the spinner lands by itself.
    case plain
    /// The proposal: `.automatic` back (the field hides as you read and is revealed by the pull),
    /// with the system's mis-placed spinner made invisible and this probe drawing its own in the
    /// list's top band — below the field, where the reveal does not reach.
    ///
    /// Two ways to reach the control: sweeping the window, and from a zero-height row *inside* the
    /// list. The first proves whether clearing the tint hides the glyph at all; the second is the
    /// one an app could ship, because it can only ever reach its own list's control.
    case autoSelfSpinnerWin
    case autoSelfSpinnerRow
    /// The decomposition controls for the band between the navigation bar and the first row — the
    /// "lots of whitespace under the search field" report. One modifier at a time, so the band can
    /// be attributed: the list itself, the refresh control, and each drawer display mode. A band
    /// that survives all of them is iOS 26's own; one that only appears with `.refreshable` is the
    /// refresh control's; one that only appears with a drawer is the drawer's reservation.
    case bare
    case bareRefresh
    case bareSearchAuto
    case bareSearchAlways
    /// The hand-drawn alternative: the same bare list with our own 40pt field as its first row and
    /// no drawer at all — what ③ in the mock would be built from.
    case ownField
    /// The leading section with no title, four ways — the hairline report (β98). `leadSection` is
    /// the shape the app ships now; the others are candidate fixes, judged by whether the line above
    /// the first row is gone *and* the 28pt the title cost stays gone (the report prints both).
    case leadBare
    case leadBareRowSeparatorHidden
    case leadBareSectionSeparatorHidden
    case leadEmptyHeader
}

/// How the pull is driven. `.afterScroll` first scrolls the list down (which hides the drawer
/// field under `.automatic`) and then pulls — the sequence a reader actually performs, and the one
/// that leaves the field's height to be re-added mid-gesture.
enum PullStyle: String, CaseIterable {
    case fromTop
    case afterScroll
    /// Leave the list alone: for questions about what a list looks like at rest (the hairline the
    /// reporter sees above the first row once the leading header stops being drawn).
    case none
}

struct ProbeRoot: View {
    @State private var query = ""
    /// Whether the refresh action is running — what the hand-drawn indicator keys off.
    @State private var refreshing = false

    private let variant = Variant(rawValue: ProcessInfo.processInfo.environment["PROBE_VARIANT"] ?? "")
        ?? .autoParent
    private let pullStyle = PullStyle(rawValue: ProcessInfo.processInfo.environment["PROBE_PULL"] ?? "")
        ?? .fromTop

    var body: some View {
        screen
            .task { await drive() }
    }

    // MARK: the list

    /// The session list, reduced to what its layout depends on: a plain `List` of two-line rows in
    /// one recency section, with the field's drawer declared around it (see `screen`).
    private var list: some View {
        List {
            Section {
                ForEach(0..<30, id: \.self) { i in
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Session \(i)")
                        Text("Waiting for you · \(i)m")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                    .padding(.vertical, 6)
                }
            } header: {
                Text("Today")
            }
        }
        .listStyle(.plain)
        .navigationTitle("orbit")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await holdRefresh() }
    }

    /// The list with nothing around it — no searchable, no refresh control, no extra inset: the
    /// baseline the band is measured against.
    private var bareList: some View {
        List {
            Section {
                ForEach(0..<30, id: \.self) { i in row(i) }
            } header: {
                Text("Today")
            }
        }
        .listStyle(.plain)
        .navigationTitle("orbit")
        .navigationBarTitleDisplayMode(.inline)
    }

    /// The same list, with our own field as its first row: no drawer, so no drawer band — and the
    /// field goes where the rows go.
    private var ownFieldList: some View {
        List {
            Text("Search all sessions")
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 12)
                .frame(height: 40)
                .background(.quaternary, in: RoundedRectangle(cornerRadius: 12))
                .listRowInsets(EdgeInsets(top: 8, leading: 16, bottom: 6, trailing: 16))
                .listRowSeparator(.hidden)
            Section {
                ForEach(0..<30, id: \.self) { i in row(i) }
            } header: {
                Text("Today")
            }
        }
        .listStyle(.plain)
        .navigationTitle("orbit")
        .navigationBarTitleDisplayMode(.inline)
    }

    /// A list whose leading section is Today's (three rows), followed by a real Yesterday section —
    /// the shape the hairline is reported in.
    private func leadList(leading: () -> some View) -> some View {
        List {
            leading()
            Section {
                ForEach(30..<33, id: \.self) { i in row(i) }
            } header: {
                Text("Yesterday").textCase(nil)
            }
        }
        .listStyle(.plain)
        .navigationTitle("orbit")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await holdRefresh() }
    }

    @ViewBuilder private var leadBareList: some View {
        leadList {
            ForEach(0..<3, id: \.self) { i in row(i) }
        }
    }

    @ViewBuilder private var leadBareRowSeparatorHiddenList: some View {
        leadList {
            ForEach(0..<3, id: \.self) { i in
                row(i).listRowSeparator(i == 0 ? .hidden : .automatic, edges: i == 0 ? .top : .all)
            }
        }
    }

    @ViewBuilder private var leadBareSectionSeparatorHiddenList: some View {
        leadList {
            ForEach(0..<3, id: \.self) { i in row(i) }
                .listSectionSeparator(.hidden, edges: .top)
        }
    }

    @ViewBuilder private var leadEmptyHeaderList: some View {
        leadList {
            Section {
                ForEach(0..<3, id: \.self) { i in row(i) }
            } header: {
                EmptyView()
            }
        }
    }

    /// The same list, with the reach-in riding a zero-height first row: from there the walk up the
    /// superview chain is guaranteed to arrive at *this* list's collection view.
    private var listWithReachInRow: some View {
        List {
            ClearRefreshSpinner(scope: .inList)
                .frame(height: 0)
                .listRowInsets(EdgeInsets())
                .listRowSeparator(.hidden)
                .listRowBackground(Color.clear)
            Section {
                ForEach(0..<30, id: \.self) { i in row(i) }
            } header: {
                Text("Today")
            }
        }
        .listStyle(.plain)
        .navigationTitle("orbit")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await holdRefresh() }
    }

    private func row(_ i: Int) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text("Session \(i)")
            Text("Waiting for you · \(i)m")
                .font(.footnote)
                .foregroundStyle(.secondary)
        }
        .padding(.vertical, 6)
    }

    /// The app's own indicator, in the list's top band — below the field the pull reveals.
    private func ownIndicator(_ content: some View) -> some View {
        content.safeAreaInset(edge: .top, spacing: 0) {
            VStack(spacing: 0) {
                if refreshing {
                    ProgressView()
                        .controlSize(.small)
                        .padding(.top, 10)
                        .padding(.bottom, 4)
                }
                EmptyView()
            }
        }
    }

    private var listWithoutRefresh: some View {
        List {
            Section {
                ForEach(0..<30, id: \.self) { i in
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Session \(i)")
                        Text("Waiting for you · \(i)m")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                    .padding(.vertical, 6)
                }
            } header: {
                Text("Today")
            }
        }
        .listStyle(.plain)
        .navigationTitle("orbit")
        .navigationBarTitleDisplayMode(.inline)
    }

    /// The real list's `.safeAreaInset(edge: .top)`: on the phone it carries the "needs you" banner,
    /// which renders nothing when nothing is waiting — a zero-height inset, which is its state here.
    private func inset(_ content: some View) -> some View {
        content.safeAreaInset(edge: .top, spacing: 0) { VStack(spacing: 0) { EmptyView() } }
    }

    // MARK: the variants

    @ViewBuilder
    private var screen: some View {
        switch variant {
        case .autoParent:
            NavigationStack {
                inset(list).modifier(DrawerSearch(text: $query, mode: .automatic))
            }
        case .alwaysParent:
            NavigationStack {
                inset(list).modifier(DrawerSearch(text: $query, mode: .always))
            }
        case .autoOnList:
            NavigationStack {
                inset(list.modifier(DrawerSearch(text: $query, mode: .automatic)))
            }
        case .autoAvoid:
            NavigationStack {
                inset(list)
                    .modifier(DrawerSearch(text: $query, mode: .automatic))
                    .searchPresentationToolbarBehavior(.avoidHidingContent)
            }
        case .autoRefreshOnRoot:
            NavigationStack {
                inset(listWithoutRefresh)
                    .modifier(DrawerSearch(text: $query, mode: .automatic))
                    .refreshable { await holdRefresh() }
            }
        case .autoNoInset:
            NavigationStack {
                list.modifier(DrawerSearch(text: $query, mode: .automatic))
            }
        case .plain:
            NavigationStack {
                inset(list)
            }
        case .bare:
            NavigationStack { bareList }
        case .bareRefresh:
            NavigationStack { bareList.refreshable { await holdRefresh() } }
        case .bareSearchAuto:
            NavigationStack { bareList.modifier(DrawerSearch(text: $query, mode: .automatic)) }
        case .bareSearchAlways:
            NavigationStack { bareList.modifier(DrawerSearch(text: $query, mode: .always)) }
        case .ownField:
            NavigationStack { ownFieldList.refreshable { await holdRefresh() } }
        case .leadBare:
            NavigationStack { leadBareList }
        case .leadBareRowSeparatorHidden:
            NavigationStack { leadBareRowSeparatorHiddenList }
        case .leadBareSectionSeparatorHidden:
            NavigationStack { leadBareSectionSeparatorHiddenList }
        case .leadEmptyHeader:
            NavigationStack { leadEmptyHeaderList }
        case .autoSelfSpinnerWin:
            NavigationStack {
                ownIndicator(list).background(ClearRefreshSpinner(scope: .window))
                    .modifier(DrawerSearch(text: $query, mode: .automatic))
            }
        case .autoSelfSpinnerRow:
            NavigationStack {
                ownIndicator(listWithReachInRow)
                    .modifier(DrawerSearch(text: $query, mode: .automatic))
            }
        }
    }

    // MARK: driving the pull

    /// Holds the refresh open long enough to be screenshotted: the spinner is only on screen while
    /// the refresh action is running.
    private func holdRefresh() async {
        await MainActor.run { refreshing = true }
        try? await Task.sleep(for: .seconds(90))
    }

    @MainActor
    private func drive() async {
        // The drawer field, the List and the refresh control all appear on the first layout passes.
        try? await Task.sleep(for: .seconds(3))

        guard let window = keyWindow() else {
            report("no key window")
            return
        }
        guard let scroll = firstScrollView(in: window) else {
            report("no scroll view in the window")
            return
        }

        if pullStyle == .none {
            try? await Task.sleep(for: .seconds(1.5))
            report("", window: window, scroll: scroll)
            return
        }
        if pullStyle == .afterScroll {
            scroll.setContentOffset(CGPoint(x: 0, y: 240), animated: false)
            try? await Task.sleep(for: .seconds(1.2))
        }

        // Past the threshold: the drawer field is (re-)revealed while the content is already
        // displaced — the moment the complaint's screenshot catches.
        let pull = scroll.adjustedContentInset.top + 140
        scroll.setContentOffset(CGPoint(x: 0, y: -pull), animated: false)
        try? await Task.sleep(for: .milliseconds(150))
        if let control = refreshControl(in: window) {
            control.beginRefreshing()
            control.sendActions(for: .valueChanged)
        }
        try? await Task.sleep(for: .seconds(2))

        report("", window: window, scroll: scroll)
    }

    // MARK: evidence

    @MainActor
    private func keyWindow() -> UIWindow? {
        UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .flatMap(\.windows)
            .first { $0.isKeyWindow }
    }

    private func firstScrollView(in window: UIView) -> UIScrollView? {
        descendants(of: window).compactMap { $0 as? UIScrollView }.first
    }

    private func refreshControl(in window: UIView) -> UIRefreshControl? {
        (descendants(of: window).first { $0 is UIRefreshControl } as? UIRefreshControl)
            ?? descendants(of: window).compactMap { $0 as? UIScrollView }.first?.refreshControl
    }

    private func descendants(of view: UIView) -> [UIView] {
        view.subviews + view.subviews.flatMap { descendants(of: $0) }
    }

    private func name(_ view: UIView) -> String { String(describing: type(of: view)) }

    /// The measured answer: every frame that decides this, in window coordinates, plus the one line
    /// that says whether the spinner and the field actually collide.
    @MainActor
    private func report(_ note: String, window: UIWindow? = nil, scroll: UIScrollView? = nil) {
        var out = "variant=\(variant.rawValue) pull=\(pullStyle.rawValue) ios=\(UIDevice.current.systemVersion) refreshHandler=\(refreshing ? "ran" : "NEVER RAN")\n"
        if !note.isEmpty { out += "note=\(note)\n" }

        guard let window else {
            out += "OVERLAP=unknown (no window)\n"
            write(out)
            return
        }

        let all = descendants(of: window)
        let searchish = all.filter { name($0).lowercased().contains("search") }
        let controls = all.filter { $0 is UIRefreshControl }
        // The system spinner lives inside its control; ours is a bare activity indicator.
        let indicators = all.filter { name($0).contains("ActivityIndicator") }
        let controlsFirst = all.first { $0 is UIRefreshControl }
        let own = indicators.filter { view in
            guard let control = controlsFirst else { return true }
            return !view.isDescendant(of: control)
        }
        let navBars = all.filter { $0 is UINavigationBar }
        let cells = all.filter { name($0).contains("ListCell") || name($0).contains("CellContentView") }

        func rect(_ view: UIView) -> CGRect { view.convert(view.bounds, to: window) }

        for bar in navBars { out += "navbar \(name(bar)) \(rect(bar))\n" }
        for view in searchish { out += "search \(name(view)) \(rect(view))\n" }
        for control in controls { out += "refreshControl \(name(control)) \(rect(control))\n" }
        for view in indicators { out += "indicator \(name(view)) \(rect(view)) \(view.isDescendant(of: controls.first ?? window) ? "system" : "OWN")\n" }
        if let scroll {
            out += "scroll \(name(scroll)) \(rect(scroll)) inset=\(scroll.adjustedContentInset) offset=\(scroll.contentOffset)\n"
            out += "refreshControlProperty=\(scroll.refreshControl.map(name) ?? "nil")\n"
        }
        for cell in cells.prefix(2) { out += "cell \(name(cell)) \(rect(cell))\n" }

        // The verdict: does the spinner's frame intersect the field's (or, failing a field, the
        // navigation bar's)?
        let spinnerBand = (controls + indicators).map(rect) + [CGRect(x: 0, y: 0, width: window.bounds.width, height: 0)]
        let fieldBand = (searchish.isEmpty ? navBars : searchish).map(rect)
        var overlap: CGRect = .null
        for band in fieldBand {
            for spinner in spinnerBand where !spinner.isNull && spinner.height > 0 {
                let hit = band.intersection(spinner)
                if !hit.isNull && hit.width > 0 && hit.height > 0 { overlap = hit }
            }
        }
        let tint = controls.first.map { $0.tintColor == .clear ? "YES" : "NO" } ?? "no control"
        let glyphHidden = controls.first.map { control in
            all.filter { $0 is UIActivityIndicatorView && $0.isDescendant(of: control) }
                .map { "\($0.alpha)\($0.isHidden ? "/hidden" : "")" }.joined(separator: ",")
        } ?? "-"
        out += "SYSTEM=tintClear=\(tint) glyph=\(glyphHidden.isEmpty ? "none" : glyphHidden) ownIndicator=\(own.count)\n"
        out += "OVERLAP=\(overlap.isNull ? "NO" : "YES") \(overlap.isNull ? "" : "\(overlap)")\n"
        out += "--- tree ---\n" + tree(of: window, depth: 0)

        write(out)
    }

    private func tree(of view: UIView, depth: Int) -> String {
        guard depth <= 6 else { return "" }
        var out = String(repeating: "  ", count: depth) + "\(name(view)) \(view.frame)\n"
        for sub in view.subviews {
            if name(sub).contains("ScrollIndicator") { continue }
            out += tree(of: sub, depth: depth + 1)
        }
        return out
    }

    private func write(_ text: String) {
        print(text)
        guard let dir = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first
        else { return }
        try? text.write(to: dir.appendingPathComponent("report.txt"), atomically: true, encoding: .utf8)
        // Written last, and empty: `run.sh` polls for it as the "the pull is engaged" signal.
        try? "".write(to: dir.appendingPathComponent("done"), atomically: true, encoding: .utf8)
    }
}

/// `.searchable` with the drawer placement, as a modifier so the spelling can be applied either to
/// the column root (what the app does) or to the `List` itself — one of the things under test.
private struct DrawerSearch: ViewModifier {
    @Binding var text: String
    let mode: SearchFieldPlacement.NavigationBarDrawerDisplayMode

    func body(content: Content) -> some View {
        content.searchable(text: $text,
                           placement: .navigationBarDrawer(displayMode: mode),
                           prompt: "Search sessions")
    }
}


/// Makes the system's refresh spinner invisible: on iOS 26 it is drawn in the navigation bar's
/// drawer band — on the search field, for the reporter — and the pull it belongs to is the one that
/// reveals that field. The control keeps working (it is what runs the refresh action); only its
/// glyph goes, and the app draws its own indicator where the reveal cannot reach.
private struct ClearRefreshSpinner: UIViewRepresentable {
    enum Scope { case window, inList }
    let scope: Scope

    func makeUIView(context: Context) -> UIView {
        let view = UIView(frame: .zero)
        view.isUserInteractionEnabled = false
        return view
    }

    func updateUIView(_ view: UIView, context: Context) {
        // Off the layout pass: the control is UIKit's, and it may not exist yet on the first update.
        DispatchQueue.main.async {
            switch scope {
            case .window:
                guard let window = view.window else { return }
                for scroll in descendants(of: window).compactMap({ $0 as? UIScrollView }) {
                    scroll.refreshControl?.tintColor = .clear
                }
            case .inList:
                var node: UIView? = view
                while let current = node, !(current is UIScrollView) { node = current.superview }
                (node as? UIScrollView)?.refreshControl?.tintColor = .clear
            }
        }
    }

    private func descendants(of view: UIView) -> [UIView] {
        view.subviews + view.subviews.flatMap { descendants(of: $0) }
    }
}
