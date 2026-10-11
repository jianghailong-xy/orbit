import SwiftUI
import OrbitKit

/// The landing on the project's sessions page as a card of its own, under the progress card (owner
/// decision 2026-10-11, mocks in docs/mocks/project-landing-card). `ProjectMergeCardView` sits in
/// the same slot for the other half of the page's work, and this wears its shape and its colours:
/// a grey card in flight, an amber one when the server judged the runner silent, and one press —
/// Retry — and only where the server offers it.
///
/// Head: the ring (spinning while the job runs, still while it waits its turn, a triangle when the
/// runner went silent — Reduce Motion stops the spin and nothing else), the word, the phase, and
/// the chevron. Body: what is landing — the task's title, or one row per job with each one's own
/// state — the branch it lands on, and the three clocks the landing row already counted. A
/// timed-out card says where the runner stopped.
///
/// Read-only apart from that Retry: a press opens the jobs in flight, which is what the row it
/// replaced did — or, from a server that lists none, the project page, exactly as before.
struct ProjectLandingCardView: View {
    let card: ProjectPage.LandingCard
    /// Opens the jobs the card counts; nil from a server that does not list them.
    let onOpenJobs: (() -> Void)?
    /// Where a press goes when there is no list to open: the project page.
    let onOpenProject: () -> Void
    /// One Retry, by job — the Jobs sheet's own door (`app.retryIntegrationJob`).
    let retry: (String) async throws -> Void
    /// A Retry on its way: its button takes no second press.
    @State private var retrying = false
    /// Why the last Retry did not go through, in the server's words.
    @State private var actionError: String?

    /// The card's ink, the landing row's own rule: the accent while the job runs, grey while it
    /// waits its turn, and the amber the merge card's blocked state wears for a runner the server
    /// has stopped hearing from.
    private var ink: Color {
        card.timedOut ? ProjectPalette.warningInk : card.running ? Color.accentColor : Color.secondary
    }

    /// One job row's ink: the same rule one job at a time, so a queued job behind a running one
    /// does not wear the running one's colour.
    private func jobInk(_ job: ProjectPage.LandingCard.Job) -> Color {
        job.timedOut ? ProjectPalette.warningInk : job.running ? Color.accentColor : Color.secondary
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Button {
                if let onOpenJobs { onOpenJobs() } else { onOpenProject() }
            } label: {
                VStack(alignment: .leading, spacing: 8) {
                    head
                    if card.jobs.count > 1 {
                        jobRows
                    } else if let what = card.what {
                        Text(what).font(.orbitLabel).lineLimit(2)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    if let target = card.target {
                        // The branch this lands on, the field the task page's Target row prints,
                        // cut in the middle when the page is narrow.
                        Text("\(ProjectPage.landingOnto) \(target)")
                            .font(.orbitMeta).foregroundStyle(.secondary)
                            .lineLimit(1).truncationMode(.middle)
                    }
                    clocks
                    if card.timedOut, let detail = card.detail {
                        Text(detail).font(.orbitMeta).foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    } else if !card.timedOut {
                        Text(ProjectPage.landingNothingToDo).font(.orbitMeta).foregroundStyle(.secondary)
                    }
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            if let jobID = card.retryJobId {
                HStack(spacing: 8) {
                    Button { press(jobID) } label: { Text(ProjectPage.landingRetry) }
                        .font(.orbitLabel.weight(.semibold))
                        .buttonStyle(.borderedProminent)
                        .buttonBorderShape(.capsule)
                        .controlSize(.small)
                        .disabled(retrying)
                    Spacer(minLength: 8)
                    // Only where there is a list to open: on a server that lists no jobs the card's
                    // press goes to the project page, and "All jobs" would name nothing.
                    if let onOpenJobs {
                        Button(action: onOpenJobs) {
                            HStack(spacing: 2) {
                                Text(ProjectPage.landingAllJobs)
                                Image(systemName: "chevron.right")
                            }
                        }
                        .font(.orbitLabel.weight(.semibold))
                        .buttonStyle(.plain)
                        .foregroundStyle(Color.accentColor)
                    }
                }
            }
            if let actionError {
                Text(actionError)
                    .font(.orbitMeta).foregroundStyle(.red).lineLimit(3)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(card.timedOut ? Color.orange.opacity(0.08) : Color.secondary.opacity(0.1),
                    in: RoundedRectangle(cornerRadius: 14))
        .overlay {
            if card.timedOut {
                RoundedRectangle(cornerRadius: 14).strokeBorder(Color.orange.opacity(0.3), lineWidth: 1)
            }
        }
        .padding(.vertical, 4)
    }

    private var head: some View {
        HStack(spacing: 8) {
            if card.timedOut {
                Image(systemName: "exclamationmark.triangle.fill")
                    .resizable()
                    .scaledToFit()
                    .frame(width: 13, height: 13)
                    .foregroundStyle(ink)
                    .accessibilityHidden(true)
            } else {
                LandingRing(running: card.running)
            }
            Text(card.title).font(.orbitLabel.weight(.semibold)).foregroundStyle(ink)
            Spacer(minLength: 8)
            Text(card.state).font(.orbitMeta).foregroundStyle(card.timedOut ? ink : Color.secondary)
            Image(systemName: "chevron.right")
                .font(.orbitMeta.weight(.semibold))
                .foregroundStyle(.tertiary)
        }
    }

    /// What the several jobs are, one row each — the title the head counts instead of naming, and
    /// the state each one is in, from the same read the Jobs list is drawn from.
    private var jobRows: some View {
        VStack(alignment: .leading, spacing: 4) {
            ForEach(card.jobs) { job in
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    if let title = job.title {
                        Text(title).font(.orbitLabel).lineLimit(1)
                    }
                    Spacer(minLength: 8)
                    Text(job.state).font(.orbitMeta).foregroundStyle(jobInk(job))
                }
            }
        }
    }

    /// The landing row's own clock row, top to bottom: what it has been doing it, what it waited
    /// for a runner before that, and where the reports stand — or the limit a timed-out job ran
    /// over, which is what its `updated` carries.
    private var clocks: some View {
        HStack(spacing: 12) {
            HStack(spacing: 4) {
                Text(card.clockLabel).foregroundStyle(.secondary)
                Text(card.clock).fontWeight(.semibold).monospacedDigit().foregroundStyle(ink)
            }
            if let wait = card.wait {
                HStack(spacing: 4) {
                    Text(ProjectPage.landingWaitLabel).foregroundStyle(.secondary)
                    Text(wait).fontWeight(.semibold).monospacedDigit().foregroundStyle(.secondary)
                }
            }
            Spacer(minLength: 8)
            if let updated = card.updated { Text(updated).foregroundStyle(.secondary) }
        }
        .font(.orbitMeta)
    }

    /// One press of Retry: no second press while it is on its way, and a refusal said under the
    /// card in the server's words — the same door and the same sentence as the Jobs sheet's.
    private func press(_ jobID: String) {
        guard !retrying else { return }
        PlatformHaptics.tap()
        retrying = true
        actionError = nil
        Task {
            do {
                try await retry(jobID)
            } catch {
                var reason = APIClient.failureReason(error)
                while reason.hasSuffix(".") { reason.removeLast() }
                actionError = "\(ProjectPage.landingRetryFailed) — \(reason)."
            }
            retrying = false
        }
    }
}
