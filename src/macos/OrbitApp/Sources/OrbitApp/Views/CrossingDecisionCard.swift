import SwiftUI
import OrbitKit

/// One batch of cross-project requests into the project this conversation coordinates — moves,
/// filings, dependencies — built like `CriteriaDecisionCard`: a compact preview in the transcript,
/// the review page with Approve/Refuse in the bottom bar, and, once answered, the dimmed card with
/// its receipt line under it (board `docs/mocks/handoff-in-chat/01-board.html`, ③–⑤). Every word
/// is `CrossingBatches`'.
struct CrossingDecisionCard: View {
    let console: ConsoleModel
    let batchID: String
    @Environment(\.inApprovalReview) private var inReview
    @State private var deciding = false
    @State private var showAll = false

    var body: some View {
        if let batch = console.crossingBatch(batchID) {
            card(batch, standing: console.crossingStanding(batch))
                // The session's move batches, re-read when the card comes into view: one answered
                // at another end — the project page, a browser — must become its receipt here.
                .task(id: batchID) { await console.refreshTaskMoves() }
        }
    }

    @ViewBuilder
    private func card(_ batch: CrossingBatch, standing: CrossingBatches.Standing) -> some View {
        let live = standing == .live
        VStack(alignment: .leading, spacing: 6) {
            ApprovalReviewLayout(title: CrossingBatches.title(batch), symbol: "arrow.left.arrow.right",
                                 tone: .orange, summary: CrossingBatches.summary(batch),
                                 dimmed: !live,
                                 badge: inReview && live ? CrossingBatches.waitingLine(batch)
                                                         : CrossingBatches.badge(batch)) {
                review(batch)
            } actions: {
                if live {
                    ApprovalActions {
                        Button { decide(.approve) } label: {
                            Text(CrossingBatches.approveLabel).approvalActionLabel()
                        }
                        .buttonStyle(.borderedProminent)
                        .disabled(deciding)
                        Button { decide(.deny) } label: {
                            Text(CrossingBatches.refuseLabel).approvalActionLabel()
                        }
                        .buttonStyle(.bordered)
                        .disabled(deciding)
                    }
                } else {
                    receipt(standing)
                }
            }
            if let refusal = console.crossingBatchRefusals[batch.id] {
                refused(refusal)
            }
            if !inReview {
                if let note = CrossingBatches.refusalNote(refusedCount(batch)) {
                    Label(note, systemImage: "exclamationmark.circle.fill")
                        .font(.orbitLabel).foregroundStyle(.red)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                if !live { receipt(standing) }
            }
        }
    }

    /// The batch door's refusal — the one answer it gives for a MOVE_TASK batch: its code and its
    /// sentence, which names every move whose crossing key no longer matches.
    private func refused(_ refusal: ProjectCrossings.Refusal) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Label(ProjectCrossings.notRecorded, systemImage: "exclamationmark.circle.fill")
                .font(.orbitLabel.weight(.semibold))
                .foregroundStyle(.red)
            (Text(refusal.code.map { "\($0) " } ?? "").font(.orbitMonoFine) + Text(refusal.message))
                .font(.orbitLabel)
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.red.opacity(0.08), in: RoundedRectangle(cornerRadius: 8))
    }

    /// `Decision recorded · ✓ Approved by you at 5:34 PM`, or `Approved at another end`.
    @ViewBuilder
    private func receipt(_ standing: CrossingBatches.Standing) -> some View {
        if let verdict = CrossingBatches.receiptVerdict(standing) {
            Group {
                if case .elsewhere = standing {
                    Text(verdict).foregroundStyle(.secondary)
                } else {
                    Text("\(CrossingBatches.recordedHead) · ").foregroundStyle(.secondary)
                        + Text(verdict).foregroundStyle(.green).fontWeight(.semibold)
                }
            }
            .font(.orbitLabel)
            .frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityElement(children: .combine)
        }
    }

    /// The review page: who is speaking, the two ends, the rows, the reasons and what approving does.
    @ViewBuilder
    private func review(_ batch: CrossingBatch) -> some View {
        Text(CrossingBatches.provenance)
            .font(.orbitLabel).foregroundStyle(.secondary)
            .frame(maxWidth: .infinity, alignment: .leading)
        VStack(alignment: .leading, spacing: 2) {
            (Text("\(CrossingBatches.fromLabel) ").foregroundStyle(.secondary) + Text(batch.sourceTitle))
            (Text("\(CrossingBatches.toLabel) ").foregroundStyle(.secondary) + Text(CrossingBatches.toText(batch)))
        }
        .font(.orbitProse)
        .frame(maxWidth: .infinity, alignment: .leading)

        Text(CrossingBatches.listHead(batch.kind))
            .font(.orbitLabel.weight(.semibold)).foregroundStyle(.secondary)
            .frame(maxWidth: .infinity, alignment: .leading)
        let shown = showAll ? batch.rows : Array(batch.rows.prefix(CrossingBatches.shownRows))
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(shown.enumerated()), id: \.element.id) { index, row in
                if index > 0 { Divider() }
                rowView(row)
            }
            if batch.rows.count > shown.count {
                Divider()
                Button(CrossingBatches.showMore(batch.rows.count - shown.count)) { showAll = true }
                    .buttonStyle(.plain)
                    .font(.orbitLabel.weight(.semibold)).foregroundStyle(Color.accentColor)
                    .padding(.horizontal, 10).padding(.vertical, 8)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .background(Color.primary.opacity(0.05), in: RoundedRectangle(cornerRadius: ApprovalMetrics.rowRadius))

        ForEach(CrossingBatches.reasons(batch), id: \.self) { reason in
            Text(reason)
                .font(.orbitLabel).foregroundStyle(.secondary)
                .padding(.horizontal, 10).padding(.vertical, 8)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Color.primary.opacity(0.05),
                            in: RoundedRectangle(cornerRadius: ApprovalMetrics.rowRadius))
        }
        Text(CrossingBatches.consequence(batch))
            .font(.orbitLabel).foregroundStyle(.secondary)
            .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func rowView(_ row: ProjectCrossing) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(CrossingBatches.rowTitle(row))
                .font(.orbitProse)
                .lineLimit(2)
            if let line = CrossingBatches.requestedLine(row) {
                Text(line).font(.orbitLabel).foregroundStyle(.secondary)
            }
            if let line = CrossingBatches.withdrawnLine(row) {
                Text(line).font(.orbitLabel).foregroundStyle(.secondary)
            }
            if let state = CrossingBatches.stateLine(row) {
                Text(state).font(.orbitLabel.weight(.semibold)).foregroundStyle(.secondary)
            }
            if ProjectCrossings.isAnswerable(row.state), let refusal = console.crossingRefusals[row.id] {
                (Text(ProjectCrossings.notRecorded).fontWeight(.semibold)
                    + Text(refusal.code.map { " \($0)" } ?? "").font(.orbitMonoFine)
                    + Text(" \(refusal.message)"))
                    .font(.orbitLabel).foregroundStyle(.red)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(.horizontal, 10).padding(.vertical, 8)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// Rows still waiting whose last answer the door refused.
    private func refusedCount(_ batch: CrossingBatch) -> Int {
        batch.pending.filter { console.crossingRefusals[$0.id] != nil }.count
    }

    private func decide(_ decision: ProjectCrossingDecision) {
        guard !deciding else { return }
        PlatformHaptics.tap()
        deciding = true
        Task {
            await console.decideCrossingBatch(batchID, decision)
            deciding = false
        }
    }
}
