import SwiftUI
import OrbitKit

/// "2 jobs in flight" — what pressing the landing row opens (docs/mocks/landing-jobs-sheet): every
/// job the row counts, one row each, drawn as the landing row itself with its task's title. A task's
/// row opens that task; a job the server says can be retried offers Retry, and a Retry that did not
/// go through says why under its row.
///
/// The rows are what the opening page's own read says, asked for again at every tick of the sheet's
/// one-second clock (`lines`): the page's poll keeps that read current, so the list follows it while
/// it is up. The page hosts the sheet, so neither that poll nor its row's clock can take it down.
struct ProjectLandingJobsSheet: View {
    /// The rows at an instant — `ProjectPage.landingJobLines` over the page's integration read.
    let lines: (Date) -> [ProjectPage.LandingJobLine]
    /// One Retry. Throws what the server answered; the page reads its line again once it went through.
    let retry: (String) async throws -> Void
    /// A row's task, opened over the page — which takes this sheet down first.
    let openTask: (String) -> Void
    @Environment(\.dismiss) private var dismiss
    /// The jobs a Retry is on its way for: their buttons take no second press.
    @State private var retrying: Set<String> = []
    /// Why a job's Retry did not go through, said under its row.
    @State private var failures: [String: String] = [:]

    var body: some View {
        TimelineView(.periodic(from: .now, by: 1)) { context in
            let rows = lines(context.date)
            VStack(spacing: 0) {
                header(rows.count)
                ScrollView {
                    VStack(spacing: 0) {
                        ForEach(Array(rows.enumerated()), id: \.element.id) { index, row in
                            if index > 0 { Divider().padding(.leading, 33) }
                            jobRow(row)
                        }
                    }
                    .background(Color.secondary.opacity(0.1), in: RoundedRectangle(cornerRadius: 12))
                    .padding(.horizontal, 16)
                    .padding(.vertical, 8)
                }
            }
        }
        #if os(iOS)
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
        #else
        .frame(minWidth: 420, idealWidth: 520, minHeight: 420, idealHeight: 560)
        #endif
    }

    private func header(_ count: Int) -> some View {
        ZStack {
            Text(ProjectPage.landingJobsTitle(count))
                .font(.headline)
                .accessibilityAddTraits(.isHeader)
            HStack {
                Spacer()
                Button { dismiss() } label: {
                    Image(systemName: "xmark.circle.fill")
                        .font(.title2)
                        .foregroundStyle(.secondary)
                        .frame(width: 44, height: 44)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Close")
                .keyboardShortcut(.cancelAction)
            }
        }
        .padding(.horizontal, 8)
        .padding(.top, 8)
    }

    /// One job: the landing row and its detail — a press opens its task, where it has one — then
    /// Retry where the server offers it, and why the last Retry did not go through.
    private func jobRow(_ row: ProjectPage.LandingJobLine) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            if let taskID = row.taskId {
                Button { openTask(taskID) } label: {
                    rowBody(row, opens: true).contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            } else {
                rowBody(row, opens: false)
            }
            if row.retryable {
                Button { press(row.jobId) } label: { Text(ProjectPage.landingRetry) }
                    .font(.orbitLabel.weight(.semibold))
                    .buttonStyle(.bordered)
                    .buttonBorderShape(.capsule)
                    .controlSize(.small)
                    .disabled(retrying.contains(row.jobId))
            }
            if let failure = failures[row.jobId] {
                Text(failure)
                    .font(.orbitMeta)
                    .foregroundStyle(.red)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
    }

    /// The row and its detail, beside the chevron that says a press opens the task. A job with no
    /// task keeps the chevron's room, so every row's right-hand words line up.
    private func rowBody(_ row: ProjectPage.LandingJobLine, opens: Bool) -> some View {
        HStack(spacing: 8) {
            VStack(alignment: .leading, spacing: 4) {
                ProjectLandingRow(line: row.line)
                if let detail = row.detail {
                    Text(detail)
                        .font(.orbitMeta)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
            Image(systemName: "chevron.right")
                .font(.orbitMeta.weight(.semibold))
                .foregroundStyle(.tertiary)
                .opacity(opens ? 1 : 0)
                .accessibilityHidden(true)
        }
    }

    /// One press of Retry: no second press while it is on its way, and a refusal said under its row
    /// in the server's words.
    private func press(_ jobID: String) {
        guard !retrying.contains(jobID) else { return }
        PlatformHaptics.tap()
        retrying.insert(jobID)
        failures[jobID] = nil
        Task {
            do {
                try await retry(jobID)
            } catch {
                // The server's sentence ends with its own full stop; this line supplies one.
                var reason = APIClient.failureReason(error)
                while reason.hasSuffix(".") { reason.removeLast() }
                failures[jobID] = "\(ProjectPage.landingRetryFailed) — \(reason)."
            }
            retrying.remove(jobID)
        }
    }
}
