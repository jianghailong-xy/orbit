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
        // A job the server judged timed out is in the warning ink, its triangle where the ring was:
        // nothing on the row moves for a runner that has stopped reporting.
        let ink = line.timedOut ? ProjectPalette.warningInk : line.running ? Color.accentColor : Color.secondary
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                if line.timedOut {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .resizable()
                        .scaledToFit()
                        .frame(width: 13, height: 13)
                        .foregroundStyle(ink)
                        .accessibilityHidden(true)
                } else {
                    LandingRing(running: line.running)
                }
                Text(line.word).font(.orbitLabel.weight(.semibold)).foregroundStyle(ink)
                Spacer(minLength: 8)
                Text(line.state).font(.orbitMeta).foregroundStyle(line.timedOut ? ink : Color.secondary)
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

/// The head a card wears over a job in flight — the merge check card's, and the landing card's
/// (owner decision 2026-10-11, board docs/mocks/project-merge-check-row). It is the timeline's
/// "Merged into main" row one moment earlier: a 30pt circle carrying the mark, the word in the body
/// size, the live clock at the right of it, and one line under both saying the state, what the job
/// waited for a runner and where the reports stand (`ProjectPage.landingHead`). The check and the
/// merge it becomes are then one shape instead of a card collapsing into a row.
///
/// The chevron the heads used to carry is gone: every row on this page is the press (the merged line
/// opens its receipt the same way), and the words beside the clock say what they have to say.
struct ProjectLandingHead: View {
    let title: String
    let head: ProjectPage.LandingHead
    let running: Bool
    let timedOut: Bool

    /// The head's ink, the landing row's own rule: the accent while the job runs, grey while it
    /// waits its turn or the app cannot read the server, and the amber a runner the server stopped
    /// hearing from wears.
    private var ink: Color {
        timedOut ? ProjectPalette.warningInk : running ? Color.accentColor : Color.secondary
    }

    var body: some View {
        HStack(spacing: 11) {
            mark
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 8) {
                    Text(title).fontWeight(.semibold)
                        .foregroundStyle(timedOut ? ink : Color.primary)
                        .lineLimit(1)
                    Spacer(minLength: 8)
                    // The live number, which is the one thing on the row that moves: tabular digits
                    // so it does not jitter as it counts, the subtitle size the merged line's own
                    // detail wears, and the ink the ring wears.
                    Text(head.right)
                        .font(.orbitListSubtitle.weight(.semibold).monospacedDigit())
                        .foregroundStyle(ink)
                        .lineLimit(1).fixedSize()
                }
                Text(head.detail).font(.orbitListSubtitle).foregroundStyle(.secondary).lineLimit(1)
            }
        }
    }

    /// The 30pt circle: the ring while the job waits or runs — its own spin, drawn by `LandingRing`
    /// — and the warning triangle where the ring was once the server judged the runner silent.
    @ViewBuilder private var mark: some View {
        if timedOut {
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.orbitGlyph)
                .foregroundStyle(ink)
                .frame(width: 30, height: 30)
                .background(Color.orange.opacity(0.15), in: Circle())
                .accessibilityHidden(true)
        } else {
            LandingRing(size: 15, running: running)
                .frame(width: 30, height: 30)
                .background(running ? Color.accentColor.opacity(0.15) : Color.secondary.opacity(0.15),
                            in: Circle())
        }
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
/// it, and they are what actually says which half of the wait this is. Drawn by the card too
/// (`ProjectLandingCardView`), so the page has one ring and one rule about motion.
struct LandingRing: View {
    /// 13 in the landing row; the cards' heads draw it at 15 inside their 30pt circle.
    var size: CGFloat = 13
    let running: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var spun = false

    var body: some View {
        ProjectSpinnerRing(size: size, color: running ? Color.accentColor : Color.secondary)
            .rotationEffect(.degrees(spun ? 360 : 0))
            .animation(running && !reduceMotion
                       ? .linear(duration: 1.6).repeatForever(autoreverses: false) : nil,
                       value: spun)
            .onAppear { spun = running }
            .onChange(of: running) { spun = $0 }
    }
}
