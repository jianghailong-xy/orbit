#if os(iOS)
import SwiftUI
import OrbitKit

/// The merge whose queue a sheet is open on, held by id the way the review target is: a poll that
/// redraws the card cannot dismiss what the reader is looking at.
struct PromotionQueueTarget: Identifiable {
    let id: String
}

/// The queue a waiting merge is in (§2.2 J1), as a sheet: what the card's "queued 70m 55s" meant.
///
/// Opened by tapping the merge card's landing row while it waits. The queue belongs to the
/// repository and the target ref, so the row ahead of this merge can be another project's — and on
/// 2026-10-07 one was, wedged for three and a half hours while every card on the line read "nothing
/// to do". This draws the whole line in claim order: each entry's name, what it is doing, how long
/// it has been doing it, and — for a head that has gone quiet past the claim's own lease window —
/// that it may be stuck.
///
/// Read-only on purpose: the presses stay where they are (the card below, and the review sheet).
/// This answers a question; it does not offer a door.
struct IntegrationQueueSheet: View {
    let model: ProjectMergeModel
    let promotion: ProjectPromotionView
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            TimelineView(.periodic(from: .now, by: 1)) { context in
                ScrollView {
                    VStack(alignment: .leading, spacing: 0) {
                        if let queue = model.queue, !queue.jobs.isEmpty {
                            Text(PromotionQueueCards.summary(queue))
                                .font(.orbitMeta).foregroundStyle(.secondary)
                                .padding(.bottom, 6)
                            ForEach(queue.jobs) { job in
                                row(job, now: context.date)
                                Divider()
                            }
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal)
                    .padding(.top, 6)
                }
            }
            .navigationTitle(PromotionQueueCards.title(promotion.upstreamRef))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Close", systemImage: "xmark") { dismiss() }
                        .labelStyle(.iconOnly)
                }
            }
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
        // Re-read while the sheet is open: the queue is read to watch it move, and the reader is
        // standing in front of it. One read every ten seconds, until the sheet goes away.
        .task {
            while !Task.isCancelled {
                await model.loadQueue(force: true)
                try? await Task.sleep(for: .seconds(10))
            }
        }
    }

    /// One job: its mark — the ring turns while it is the one being performed — its name and chips,
    /// how long, and what it is doing (or that it has gone quiet).
    @ViewBuilder private func row(_ job: ProjectIntegrationQueueJob, now: Date) -> some View {
        let running = job.state == "RUNNING"
        HStack(alignment: .top, spacing: 11) {
            ZStack {
                Circle().fill(running ? Color.accentColor.opacity(0.14) : Color.secondary.opacity(0.12))
                QueueRing(running: running)
            }
            .frame(width: 30, height: 30)
            VStack(alignment: .leading, spacing: 2) {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text(PromotionQueueCards.jobTitle(job))
                        .font(.orbitLabel.weight(.semibold))
                        .lineLimit(2)
                    if job.jobId == model.myQueueJobID { chip(PromotionQueueCards.queueYou) }
                    if job.automatic { chip(PromotionQueueCards.queueAutomatic) }
                    Spacer(minLength: 6)
                    Text(PromotionQueueCards.jobSpan(job, now: now))
                        .font(.orbitMeta).foregroundStyle(.secondary).monospacedDigit()
                }
                HStack(spacing: 4) {
                    Text(PromotionQueueCards.jobStatus(job))
                    if let stale = PromotionQueueCards.jobStaleClause(job, now: now) {
                        Text("· \(stale)").foregroundStyle(.orange)
                    }
                }
                .font(.orbitMeta).foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 10)
    }

    private func chip(_ word: String) -> some View {
        Text(word)
            .font(.caption2.weight(.semibold))
            .foregroundStyle(.tint)
            .padding(.horizontal, 7).padding(.vertical, 1)
            .background(Color.accentColor.opacity(0.12), in: Capsule())
    }
}

/// The row's ring: the arrows mark the landing line already uses, turning only while this job is
/// the one being performed. Reduce Motion stops the turn and nothing else — `fetching` beside it is
/// what actually says which half of the wait this is.
private struct QueueRing: View {
    let running: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var spun = false

    var body: some View {
        ProjectSpinnerRing(size: 14, color: running ? Color.accentColor : Color.secondary)
            .rotationEffect(.degrees(spun ? 360 : 0))
            .animation(running && !reduceMotion
                       ? .linear(duration: 1.6).repeatForever(autoreverses: false) : nil,
                       value: spun)
            .onAppear { spun = running }
            .onChange(of: running) { spun = $0 }
    }
}
#endif
