import SwiftUI
import OrbitKit

// The landing's own mark on this page: the head every landing row wears (the merge check card's, the
// landing card's, the jobs list's) and the two rings it is drawn from. What the line says is decided
// in OrbitKit, where it is tested on Linux (`ProjectPage.landingLine` / `landingHead`); this is only
// the drawing.

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
    /// A settled outcome that went the project's way: the board's green success card (mockup 05 c,
    /// where the round MERGED). The head is otherwise the row's own anatomy.
    var ok = false
    /// An attempt that stopped on a failure (board 02 d): the red ✕ the project page's Landings row
    /// wears, and its word in red.
    var failed = false

    /// The head's ink, the landing row's own rule: the accent while the job runs, grey while it
    /// waits its turn or the app cannot read the server, and the amber a runner the server stopped
    /// hearing from wears. A settled success is the one green, a failure the one red.
    private var ink: Color {
        if ok { return .green }
        if timedOut { return ProjectPalette.warningInk }
        if failed { return .red }
        return running ? Color.accentColor : Color.secondary
    }

    var body: some View {
        HStack(spacing: 11) {
            mark
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 8) {
                    Text(title).fontWeight(.semibold)
                        .foregroundStyle(ok ? ink : timedOut ? ink : Color.primary)
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
        if ok {
            Image(systemName: "checkmark.circle.fill")
                .font(.orbitGlyph)
                .foregroundStyle(ink)
                .frame(width: 30, height: 30)
                .background(Color.green.opacity(0.15), in: Circle())
                .accessibilityHidden(true)
        } else if timedOut {
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.orbitGlyph)
                .foregroundStyle(ink)
                .frame(width: 30, height: 30)
                .background(Color.orange.opacity(0.15), in: Circle())
                .accessibilityHidden(true)
        } else if failed {
            Text("✕")
                .font(.orbitGlyph.weight(.semibold))
                .foregroundStyle(ink)
                .frame(width: 30, height: 30)
                .background(Color.red.opacity(0.15), in: Circle())
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
