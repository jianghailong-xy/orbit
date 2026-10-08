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
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                LandingRing(running: line.running)
                Text(line.word).font(.orbitLabel.weight(.semibold)).foregroundStyle(ink)
                Spacer(minLength: 8)
                Text(line.state).font(.orbitMeta).foregroundStyle(.secondary)
            }
            if let what = line.what {
                Text(what).font(.orbitLabel).lineLimit(2)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            HStack {
                HStack(spacing: 4) {
                    Text(line.clockLabel).foregroundStyle(.secondary)
                    Text(line.clock).fontWeight(.semibold).monospacedDigit().foregroundStyle(ink)
                }
                // The other half of "how long is this taking": what it waited for a runner before
                // any of the elapsed time began.
                if let wait = line.wait {
                    HStack(spacing: 4) {
                        Text(ProjectPage.landingWaitLabel).foregroundStyle(.secondary)
                        Text(wait).fontWeight(.semibold).monospacedDigit().foregroundStyle(.secondary)
                    }
                }
                Spacer(minLength: 8)
                if let updated = line.updated { Text(updated).foregroundStyle(.secondary) }
            }
            .font(.orbitMeta)
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
            .onAppear { spun = running }
            .onChange(of: running) { spun = $0 }
    }
}
