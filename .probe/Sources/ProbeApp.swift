import SwiftUI

// A three-column NavigationSplitView that draws its own geometry. Every knob we are unsure about
// is a launch argument, so one build answers many configurations:
//
//   -style      automatic | balanced | prominentDetail
//   -sidebarMin / -sidebarIdeal / -sidebarMax     (points)
//   -contentMin / -contentIdeal / -contentMax     (points)
//   -visibility all | doubleColumn | detailOnly
//
// Each column prints the width SwiftUI actually gave it and the horizontalSizeClass IT sees —
// which is the value that decides whether the real app's session column renders its iPad layout
// or falls back to the iPhone one.

@main
struct ProbeApp: App {
    var body: some Scene {
        WindowGroup { ProbeShell() }
    }
}

private func arg(_ name: String) -> String? {
    let a = ProcessInfo.processInfo.arguments
    guard let i = a.firstIndex(of: "-\(name)"), i + 1 < a.count else { return nil }
    return a[i + 1]
}
private func num(_ name: String, _ fallback: CGFloat) -> CGFloat {
    guard let s = arg(name), let v = Double(s) else { return fallback }
    return CGFloat(v)
}

struct ProbeShell: View {
    // Defaults mirror what main ships today, so a run with no arguments reproduces the screenshots.
    private let sidebarMin = num("sidebarMin", 260)
    private let sidebarIdeal = num("sidebarIdeal", 320)
    private let sidebarMax = num("sidebarMax", 360)
    private let contentMin = num("contentMin", 320)
    private let contentIdeal = num("contentIdeal", 420)
    private let contentMax = num("contentMax", 480)
    private let styleName = arg("style") ?? "automatic"
    private let visName = arg("visibility") ?? "all"

    @State private var visibility: NavigationSplitViewVisibility = .all

    var body: some View {
        shell
            .onAppear {
                switch visName {
                case "doubleColumn": visibility = .doubleColumn
                case "detailOnly":   visibility = .detailOnly
                default:             visibility = .all
                }
            }
    }

    @ViewBuilder private var shell: some View {
        let base = NavigationSplitView(columnVisibility: $visibility) {
            Pane("sidebar", .orange)
                .navigationSplitViewColumnWidth(min: sidebarMin, ideal: sidebarIdeal, max: sidebarMax)
        } content: {
            Pane("content", .blue)
                .navigationSplitViewColumnWidth(min: contentMin, ideal: contentIdeal, max: contentMax)
        } detail: {
            Pane("detail", .green)
        }
        // The banner repeats the inputs, so a screenshot is self-describing with no log to match up.
        .safeAreaInset(edge: .top) {
            Text("style=\(styleName)  vis=\(visName)  sidebar(\(int(sidebarMin))/\(int(sidebarIdeal))/\(int(sidebarMax)))  content(\(int(contentMin))/\(int(contentIdeal))/\(int(contentMax)))")
                .font(.system(size: 15, weight: .semibold, design: .monospaced))
                .frame(maxWidth: .infinity)
                .padding(.vertical, 8)
                .background(.black)
                .foregroundStyle(.white)
        }

        switch styleName {
        case "balanced":        base.navigationSplitViewStyle(.balanced)
        case "prominentDetail": base.navigationSplitViewStyle(.prominentDetail)
        default:                base
        }
    }

    private func int(_ v: CGFloat) -> String { String(Int(v)) }
}

/// One column, reporting the two numbers the whole experiment is about.
struct Pane: View {
    let name: String
    let tint: Color
    @Environment(\.horizontalSizeClass) private var hSize

    init(_ name: String, _ tint: Color) { self.name = name; self.tint = tint }

    var body: some View {
        GeometryReader { geo in
            VStack(spacing: 10) {
                Text(name.uppercased())
                    .font(.system(size: 17, weight: .bold, design: .monospaced))
                Text("\(Int(geo.size.width.rounded()))")
                    .font(.system(size: 64, weight: .heavy, design: .rounded))
                Text("pt wide").font(.footnote)
                // This is the verdict: a column that reports .compact renders the iPhone layout,
                // however wide the split shell around it happens to be.
                Text(hSize == .compact ? "COMPACT" : "REGULAR")
                    .font(.system(size: 20, weight: .black, design: .monospaced))
                    .padding(.horizontal, 12).padding(.vertical, 6)
                    .background(hSize == .compact ? Color.red : Color.green)
                    .foregroundStyle(.black)
                    .clipShape(Capsule())
            }
            .padding(.top, 28)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
            .background(tint.opacity(0.18))
        }
    }
}
