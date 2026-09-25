import SwiftUI
import OrbitKit

/// The Work overview card's live landing line — the one row that says what the platform itself is
/// doing while a project's numbers stand still.
///
/// It is its own file, and takes a `ProjectPage.LandingLine` rather than the model, so that what it
/// draws is decided in OrbitKit where it is tested on Linux (`ProjectPage.landingLine`) and this is
/// only the drawing. That is also what lets it be rendered on its own, with a line handed to it —
/// the card around it needs the whole page's model, and this does not.
struct ProjectLandingRow: View {
    let line: ProjectPage.LandingLine

    var body: some View {
        let ink = line.running ? Color.accentColor : Color.secondary
        HStack(spacing: 8) {
            LandingRing(running: line.running)
            Text(ProjectPage.landingWord).font(.orbitLabel.weight(.semibold)).foregroundStyle(ink)
            // Always drawn, even empty: it is the row's flexible middle, and the one that keeps the
            // state and the clock against the trailing edge whether or not the job has a name.
            Text(line.what ?? "")
                .font(.orbitLabel)
                .lineLimit(1)
                .frame(maxWidth: .infinity, alignment: .leading)
            Text(line.state).font(.orbitLabel).foregroundStyle(.secondary)
            Text(line.clock)
                .font(.orbitLabel.weight(.semibold))
                .monospacedDigit()
                .foregroundStyle(ink)
        }
        .padding(.vertical, 4)
    }
}

/// The arrowed ring the project page uses for work in hand, drawn once: it is the Integrating
/// cell's own mark, and the landing row is that same work seen while it happens.
struct ProjectSpinnerRing: View {
    var size: CGFloat
    var color: Color

    var body: some View {
        Image(systemName: "arrow.triangle.2.circlepath")
            .resizable()
            .scaledToFit()
            .frame(width: size, height: size)
            .foregroundStyle(color)
    }
}

/// The row's ring: the Integrating cell's mark, spinning while the combined-tree checks run and
/// standing still while the job waits its turn.
///
/// Reduce Motion stops the rotation and nothing else — `checking` and `queued` are the words beside
/// it, and they are what actually says which half of the wait this is.
private struct LandingRing: View {
    let running: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var spun = false

    var body: some View {
        ProjectSpinnerRing(size: 13, color: running ? Color.accentColor : Color.secondary)
            .rotationEffect(.degrees(spun ? 360 : 0))
            .animation(running && !reduceMotion
                       ? .linear(duration: 1.6).repeatForever(autoreverses: false) : nil,
                       value: spun)
            .onAppear { spun = true }
    }
}
